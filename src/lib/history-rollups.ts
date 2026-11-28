import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

/**
 * Overview history (PERF-01). The short ranges read the raw samples with their
 * current buckets; 7d reads the 15-minute rollup. Every time comparison keeps
 * `timestamp` without zone, like `samples.at`, so no range shifts with the
 * session time zone.
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

/** Fixed identifiers only: nothing user-controlled reaches `sql.raw`. */
const quoted = (name: string) => sql.raw(`"${name}"`);
const columnList = (names: readonly string[]) =>
  sql.join(names.map(quoted), sql`, `);

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

/** `col = EXCLUDED.col` for every listed column, for the upsert. */
const upsertAll = (names: readonly string[]) =>
  sql.join(
    names.map((name) => sql`${quoted(name)} = EXCLUDED.${quoted(name)}`),
    sql`, `,
  );

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

/** Aggregates `[from, to)` into the rollup tables, in the caller's transaction. */
export async function rollupRange(
  executor: Pick<HistoryExecutor, "execute">,
  from: SQL,
  to: SQL,
) {
  await executor.execute(sampleRollupStatement(from, to));
}

/**
 * The periodic pass: recomputes the last `ROLLUP_WINDOW_HOURS` hours, so the
 * bucket in progress and a late sample inside the window are both corrected.
 * Repeating it leaves the same rows.
 */
export async function rollupRecent(executor: HistoryExecutor, now?: Date) {
  const current = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  const from = sql`date_bin(${interval(ROLLUP_BUCKET_SECONDS)}, ${current} - make_interval(hours => ${ROLLUP_WINDOW_HOURS}), ${ORIGIN})`;
  await executor.transaction(async (tx) => {
    await rollupRange(tx, from, current);
  });
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

async function rollupHistory(
  executor: HistoryExecutor,
  hostId: string,
  seconds: number,
  bucket: number,
) {
  const result = await executor.execute(sql`
    WITH series AS (${series(seconds, bucket)}),
    grouped AS (SELECT bucket AS at, ${columnList(OVERVIEW_COLUMNS)}
      FROM sample_rollups
      WHERE "hostId" = ${hostId}
        AND bucket >= date_bin(${interval(bucket)}, now() - ${interval(seconds)}, ${ORIGIN}))
    ${overviewSelect}`);
  return result.rows as HistoryRow[];
}

/** Overview series for one host: raw for the short ranges, rollup for 7d. */
export async function readHistory(
  executor: HistoryExecutor,
  hostId: string,
  range: HistoryRange,
): Promise<HistoryRow[]> {
  const [seconds, bucket] = HISTORY_RANGES[range];
  if (range === "7d") return rollupHistory(executor, hostId, seconds, bucket);
  return rawHistory(executor, hostId, seconds, bucket);
}
