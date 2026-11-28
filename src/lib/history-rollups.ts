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
/** Raw samples are kept this long; older ones go only once their bucket is rolled up (D-20). */
export const RAW_RETENTION_HOURS = 48;
/** Rollups and ingest events are kept this long. */
export const ROLLUP_RETENTION_DAYS = 30;
/** Rows per pruning statement, and the time after which no new batch starts. */
export const PRUNE_BATCH_SIZE = 2000;
export const PRUNE_BUDGET_MS = 15_000;
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

function rawHistoryStatement(hostId: string, seconds: number, bucket: number) {
  return sql`
    WITH series AS (${series(seconds, bucket)}),
    grouped AS (SELECT date_bin(${interval(bucket)}, at, ${ORIGIN}) AS at, ${sampleAverages}
      FROM samples WHERE "hostId" = ${hostId} AND at > now() - ${interval(seconds)} GROUP BY 1)
    ${overviewSelect}`;
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
function rollupStatement(options: {
    table: "sample_rollups" | "container_rollups";
    scope: SQL;
    columns: readonly string[];
    seconds: number;
    bucket: number;
    select: SQL;
  }) {
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
  return sql`
    WITH series AS (${series(seconds, bucket)}),
    grouped AS (SELECT date_bin(${interval(bucket)}, bucket, ${ORIGIN}) AS at, ${measures}
      FROM ${sql.raw(table)}
      WHERE ${scope}
        AND bucket >= date_bin(${interval(bucket)}, now() - ${interval(seconds)}, ${ORIGIN})
      ${stored ? sql`` : sql`GROUP BY 1`})
    ${options.select}`;
}

/**
 * The overview statement of one range: raw for the short ranges, rollup for 7d
 * and 30d. `readHistory` runs exactly this, so a test can ask the planner about
 * the real statement.
 */
export function historyStatement(hostId: string, range: HistoryRange): SQL {
  const [seconds, bucket] = HISTORY_RANGES[range];
  if (range !== "7d" && range !== "30d")
    return rawHistoryStatement(hostId, seconds, bucket);
  return rollupStatement({
    table: "sample_rollups",
    scope: sql`"hostId" = ${hostId}`,
    columns: OVERVIEW_COLUMNS,
    seconds,
    bucket,
    select: overviewSelect,
  });
}

/** Overview series: raw for the short ranges, rollup for 7d and 30d. */
export async function readHistory(
  executor: HistoryExecutor,
  hostId: string,
  range: HistoryRange,
): Promise<HistoryRow[]> {
  const result = await executor.execute(historyStatement(hostId, range));
  return result.rows as HistoryRow[];
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
  const result = await executor.execute(
    rollupStatement({
      table: "container_rollups",
      scope: sql`"hostId" = ${hostId} AND container = ${container}`,
      columns: CONTAINER_COLUMNS,
      seconds,
      bucket,
      select: containerSelect,
    }),
  );
  return result.rows as HistoryRow[];
}

export type PruneOptions = { batchSize?: number; budgetMs?: number };

/**
 * Deletes raw samples older than `RAW_RETENTION_HOURS` in batches, each one a
 * statement of its own (short locks, WAL spread out). A sample goes only when
 * its 15-minute bucket is already in `sample_rollups` (the same `date_bin` as
 * the aggregation) and a newer sample of the same host exists, so unaggregated
 * history and the latest sample of every host always survive. No new batch
 * starts once `budgetMs` has elapsed, but every pass runs at least one, so
 * `budgetMs: 0` runs exactly one. `exhausted` is true when the last batch
 * deleted fewer rows than `batchSize`. Time comes from the database (`now()`).
 */
export async function pruneSamples(
  executor: Pick<HistoryExecutor, "execute">,
  options: PruneOptions = {},
): Promise<{ deleted: number; exhausted: boolean }> {
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
  const budgetMs = options.budgetMs ?? PRUNE_BUDGET_MS;
  const startedAt = performance.now();
  let deleted = 0;
  let last: number;
  do {
    const result = await executor.execute(sql`
      DELETE FROM samples WHERE id IN (
        SELECT s.id FROM samples s
        WHERE s.at < now() - make_interval(hours => ${RAW_RETENTION_HOURS})
          AND EXISTS (
            SELECT 1 FROM sample_rollups r
            WHERE r."hostId" = s."hostId"
              AND r.bucket = date_bin(${interval(ROLLUP_BUCKET_SECONDS)}, s.at, ${ORIGIN}))
          AND EXISTS (
            SELECT 1 FROM samples newer
            WHERE newer."hostId" = s."hostId" AND (newer.at, newer.id) > (s.at, s.id))
        LIMIT ${batchSize})`);
    last = result.rowCount ?? 0;
    deleted += last;
  } while (last >= batchSize && performance.now() - startedAt < budgetMs);
  return { deleted, exhausted: last < batchSize };
}

/**
 * The whole history cleanup of the worker: guarded sample pruning, then the
 * rollups and the ingest events older than `ROLLUP_RETENTION_DAYS`. The
 * signature window of an ingest event is 300 s, so 30 days is ample for its
 * idempotency while the table stays bounded.
 */
export async function pruneHistory(
  executor: Pick<HistoryExecutor, "execute">,
  options: PruneOptions = {},
) {
  const samplesResult = await pruneSamples(executor, options);
  const cutoff = sql`now() - make_interval(days => ${ROLLUP_RETENTION_DAYS})`;
  const sampleRollups = await executor.execute(
    sql`DELETE FROM sample_rollups WHERE bucket < ${cutoff}`,
  );
  const containerRollups = await executor.execute(
    sql`DELETE FROM container_rollups WHERE bucket < ${cutoff}`,
  );
  const ingestEvents = await executor.execute(
    sql`DELETE FROM ingest_events WHERE "receivedAt" < ${cutoff}`,
  );
  return {
    ...samplesResult,
    sampleRollups: sampleRollups.rowCount ?? 0,
    containerRollups: containerRollups.rowCount ?? 0,
    ingestEvents: ingestEvents.rowCount ?? 0,
  };
}
