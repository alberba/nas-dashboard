import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

/**
 * Overview and per-container history (PERF-01). The short ranges read the raw
 * samples with their current buckets; 7d reads the 15-minute rollup and 30d
 * reaggregates it to 1 hour, weighting each bucket by its sample count. Every
 * time comparison keeps `timestamp` without zone, like `samples.at`, so no
 * range shifts with the session time zone.
 */

export type HistoryRange = "1h" | "6h" | "24h" | "7d" | "30d";

/** Seconds covered by each range and the width of its buckets. */
export const HISTORY_RANGES = {
  "1h": [3600, 30],
  "6h": [21600, 60],
  "24h": [86400, 120],
  "7d": [604800, 900],
  "30d": [2592000, 3600],
} as const satisfies Record<HistoryRange, readonly [number, number]>;

export const WORKER_ROLLUP_MS = 60_000;
export const ROLLUP_WINDOW_HOURS = 2;
/** Width of a stored rollup bucket; it divides the 1-hour bucket of 30d. */
export const ROLLUP_BUCKET_SECONDS = 900;

export type HistoryExecutor = Pick<
  NodePgDatabase<typeof schema>,
  "execute" | "transaction"
>;
export type HistoryRow = Record<string, unknown>;

const ORIGIN = sql`timestamp '2000-01-01'`;
const interval = (seconds: number) => sql`make_interval(secs => ${seconds})`;

/** The 13 overview columns, in the order of the response. */
const OVERVIEW_COLUMNS = [
  "cpu",
  "memory",
  "swap",
  "rx",
  "tx",
  "ioRead",
  "ioWrite",
  "load1",
  "load5",
  "load15",
  "readAwait",
  "writeAwait",
  "utilization",
] as const;
const CONTAINER_COLUMNS = ["cpu", "memory", "rx", "tx"] as const;

/** Fixed identifiers only: nothing user-controlled reaches `sql.raw`. */
const quoted = (name: string) => sql.raw(`"${name}"`);
const columnList = (names: readonly string[]) =>
  sql.join(names.map(quoted), sql`, `);
/** `col = EXCLUDED.col` for every listed column, for the upsert. */
const upsertAll = (names: readonly string[]) =>
  sql.join(
    names.map((name) => sql`${quoted(name)} = EXCLUDED.${quoted(name)}`),
    sql`, `,
  );

/** The averages over `samples.data`, one per overview column. */
const sampleAverages = sql`
  avg((data->>'cpu')::float) AS cpu,
  avg((data->'memory'->>'used')::float / nullif((data->'memory'->>'total')::float, 0) * 100) AS memory,
  avg((data->'memory'->'swap'->>'used')::float / nullif((data->'memory'->'swap'->>'total')::float, 0) * 100) AS swap,
  avg((data->'network'->>'rx')::float) AS rx, avg((data->'network'->>'tx')::float) AS tx,
  avg((data->'io'->>'read')::float) AS "ioRead", avg((data->'io'->>'write')::float) AS "ioWrite",
  avg((data->'load'->>0)::float) AS "load1",
  avg((data->'load'->>1)::float) AS "load5",
  avg((data->'load'->>2)::float) AS "load15",
  avg((data->'io'->'latency'->>'readMs')::float) AS "readAwait",
  avg((data->'io'->'latency'->>'writeMs')::float) AS "writeAwait",
  avg((data->'io'->'latency'->>'utilization')::float) AS "utilization"`;

const series = (seconds: number, bucket: number) => sql`
  SELECT generate_series(
    date_bin(${interval(bucket)}, now() - ${interval(seconds)}, ${ORIGIN}),
    date_bin(${interval(bucket)}, now(), ${ORIGIN}), ${interval(bucket)}) AS at`;

const overviewSelect = sql`
  SELECT series.at, grouped.cpu, grouped.memory, grouped.swap, grouped.rx, grouped.tx,
    grouped."ioRead", grouped."ioWrite", grouped."load1", grouped."load5", grouped."load15",
    grouped."readAwait", grouped."writeAwait", grouped."utilization"
  FROM series LEFT JOIN grouped USING(at) ORDER BY series.at`;

const containerSelect = sql`
  SELECT series.at, grouped.cpu, grouped.memory, grouped.rx, grouped.tx
  FROM series LEFT JOIN grouped USING(at) ORDER BY series.at`;

/** The container entries of one sample, tolerant of a missing or odd field. */
const containerElements = sql`
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.data->'containers') = 'array'
      THEN s.data->'containers' ELSE '[]'::jsonb END
  ) c`;

/**
 * One definition of the sample aggregation, shared by the periodic pass and the
 * backfill. `from` and `to` are SQL expressions comparable to `samples.at`; the
 * caller aligns `from` to a bucket so a bucket is always recomputed whole.
 */
function sampleRollupStatement(from: SQL, to: SQL) {
  const names = ["n", ...OVERVIEW_COLUMNS];
  return sql`
    INSERT INTO sample_rollups ("hostId", bucket, ${columnList(names)})
    SELECT "hostId",
      date_bin(${interval(ROLLUP_BUCKET_SECONDS)}, at, ${ORIGIN}) AS bucket,
      count(*)::int AS n, ${sampleAverages}
    FROM samples WHERE at >= ${from} AND at < ${to}
    GROUP BY 1, 2
    ON CONFLICT ("hostId", bucket) DO UPDATE SET ${upsertAll(names)}`;
}

/** The same aggregation per container, from `data->'containers'`. */
function containerRollupStatement(from: SQL, to: SQL) {
  const names = ["n", ...CONTAINER_COLUMNS];
  return sql`
    INSERT INTO container_rollups ("hostId", container, bucket, ${columnList(names)})
    SELECT s."hostId", c->>'name' AS container,
      date_bin(${interval(ROLLUP_BUCKET_SECONDS)}, s.at, ${ORIGIN}) AS bucket,
      count(*)::int AS n,
      avg((c->>'cpu')::float) AS cpu,
      avg((c->>'memory')::float) AS memory,
      avg((c->'network'->>'rx')::float) AS rx,
      avg((c->'network'->>'tx')::float) AS tx
    FROM samples s ${containerElements}
    WHERE s.at >= ${from} AND s.at < ${to} AND c->>'name' IS NOT NULL
    GROUP BY 1, 2, 3
    ON CONFLICT ("hostId", container, bucket) DO UPDATE SET ${upsertAll(names)}`;
}

/** Aggregates `[from, to)` into both rollup tables, in the caller's transaction. */
export async function rollupRange(
  executor: Pick<HistoryExecutor, "execute">,
  from: SQL,
  to: SQL,
) {
  await executor.execute(sampleRollupStatement(from, to));
  await executor.execute(containerRollupStatement(from, to));
}

/**
 * The periodic pass: recomputes the last `ROLLUP_WINDOW_HOURS` hours of both
 * tables in one transaction, so the bucket in progress and a late sample inside
 * the window are both corrected. Repeating it leaves the same rows.
 */
export async function rollupRecent(executor: HistoryExecutor, now?: Date) {
  const current = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  const from = sql`date_bin(${interval(ROLLUP_BUCKET_SECONDS)}, ${current} - make_interval(hours => ${ROLLUP_WINDOW_HOURS}), ${ORIGIN})`;
  await executor.transaction(async (tx) => {
    await rollupRange(tx, from, current);
  });
}

/**
 * Populates both tables from the existing history, one day and one transaction
 * at a time so memory and lock time stay bounded (D-20: the rollups are filled
 * before the raw retention is shortened). It runs the same statements as the
 * periodic pass over each whole day, so it is idempotent and a late sample is
 * folded in by the next run. Days are walked as `timestamp` without zone,
 * like `samples.at`. Returns the number of days processed. Nothing is deleted.
 */
export async function backfillRollups(
  executor: HistoryExecutor,
  options: {
    onDay?: (day: string) => void | Promise<void>;
    /** Checked between days so a shutdown never waits for the whole history. */
    stopping?: () => boolean;
  } = {},
): Promise<number> {
  const days = await executor.execute(sql`
    SELECT d::date::text AS day FROM generate_series(
      date_trunc('day', (SELECT min(at) FROM samples)),
      date_trunc('day', now()::timestamp), interval '1 day') d`);
  let done = 0;
  for (const { day } of days.rows as { day: string }[]) {
    if (options.stopping?.()) break;
    await executor.transaction(async (tx) => {
      await rollupRange(
        tx,
        sql`${day}::timestamp`,
        sql`${day}::timestamp + interval '1 day'`,
      );
    });
    done += 1;
    await options.onDay?.(day);
  }
  return done;
}

async function rawHistory(
  executor: HistoryExecutor,
  hostId: string,
  seconds: number,
  bucket: number,
) {
  const result = await executor.execute(sql`
    WITH series AS (${series(seconds, bucket)}),
    grouped AS (SELECT date_bin(${interval(bucket)}, at, ${ORIGIN}) AS at, ${sampleAverages}
      FROM samples WHERE "hostId" = ${hostId} AND at > now() - ${interval(seconds)} GROUP BY 1)
    ${overviewSelect}`);
  return result.rows as HistoryRow[];
}

async function rawContainerHistory(
  executor: HistoryExecutor,
  hostId: string,
  container: string,
  seconds: number,
  bucket: number,
) {
  const result = await executor.execute(sql`
    WITH series AS (${series(seconds, bucket)}),
    grouped AS (SELECT date_bin(${interval(bucket)}, s.at, ${ORIGIN}) AS at,
      avg((c->>'cpu')::float) AS cpu,
      avg((c->>'memory')::float) AS memory,
      avg((c->'network'->>'rx')::float) AS rx,
      avg((c->'network'->>'tx')::float) AS tx
      FROM samples s ${containerElements}
      WHERE s."hostId" = ${hostId}
        AND s.at > now() - ${interval(seconds)}
        AND c->>'name' = ${container}
      GROUP BY 1)
    ${containerSelect}`);
  return result.rows as HistoryRow[];
}

/**
 * Serves a range from a rollup table. At the rollup width the stored buckets
 * are read as they are; wider buckets reaggregate them with a mean weighted by
 * the sample count of each bucket, ignoring buckets where the column is null so
 * a missing column never dilutes the mean. Where a column is null for only part
 * of the samples of one bucket the weighting is an approximation; the agent
 * drops these columns for whole buckets in practice.
 */
async function rollupSeries(
  executor: HistoryExecutor,
  options: {
    table: "sample_rollups" | "container_rollups";
    scope: SQL;
    columns: readonly string[];
    seconds: number;
    bucket: number;
    select: SQL;
  },
) {
  const { table, scope, columns, seconds, bucket } = options;
  const stored = bucket === ROLLUP_BUCKET_SECONDS;
  const measures = stored
    ? columnList(columns)
    : sql.join(
        columns.map(
          (name) =>
            sql`sum(${quoted(name)} * n) / nullif(sum(n) FILTER (WHERE ${quoted(name)} IS NOT NULL), 0) AS ${quoted(name)}`,
        ),
        sql`, `,
      );
  const result = await executor.execute(sql`
    WITH series AS (${series(seconds, bucket)}),
    grouped AS (SELECT date_bin(${interval(bucket)}, bucket, ${ORIGIN}) AS at, ${measures}
      FROM ${sql.raw(table)}
      WHERE ${scope}
        AND bucket >= date_bin(${interval(bucket)}, now() - ${interval(seconds)}, ${ORIGIN})
      ${stored ? sql`` : sql`GROUP BY 1`})
    ${options.select}`);
  return result.rows as HistoryRow[];
}

/** Overview series: raw for the short ranges, rollup for 7d and 30d. */
export async function readHistory(
  executor: HistoryExecutor,
  hostId: string,
  range: HistoryRange,
): Promise<HistoryRow[]> {
  const [seconds, bucket] = HISTORY_RANGES[range];
  if (range !== "7d" && range !== "30d")
    return rawHistory(executor, hostId, seconds, bucket);
  return rollupSeries(executor, {
    table: "sample_rollups",
    scope: sql`"hostId" = ${hostId}`,
    columns: OVERVIEW_COLUMNS,
    seconds,
    bucket,
    select: overviewSelect,
  });
}

/** Series of one container on one host, with the same range policy. */
export async function readContainerHistory(
  executor: HistoryExecutor,
  hostId: string,
  container: string,
  range: HistoryRange,
): Promise<HistoryRow[]> {
  const [seconds, bucket] = HISTORY_RANGES[range];
  if (range !== "7d" && range !== "30d")
    return rawContainerHistory(executor, hostId, container, seconds, bucket);
  return rollupSeries(executor, {
    table: "container_rollups",
    scope: sql`"hostId" = ${hostId} AND container = ${container}`,
    columns: CONTAINER_COLUMNS,
    seconds,
    bucket,
    select: containerSelect,
  });
}
