import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
        session: { id: "test-session" },
      })),
    },
  },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));

const baseUrl = testDatabaseUrl();

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

type Row = Record<string, unknown>;
type Database = typeof import("@/lib/db").db;
type Executor = Pick<Database, "execute" | "transaction">;

/**
 * Seeds `days` days of samples every ~5 minutes for one host. Sizes per
 * 15-minute bucket are uneven (some samples are dropped and the spacing
 * jitters) and swap and latency go missing for whole buckets, which is how the
 * agent behaves in practice. `at` is built from `now()::timestamp`, so the
 * seed lives in whatever zone the session uses.
 */
async function seedSamples(executor: Executor, hostId: string, days: number) {
  await executor.execute(sql`
    INSERT INTO samples ("hostId", at, data)
    SELECT ${hostId}, at, jsonb_strip_nulls(jsonb_build_object(
      'cpu', 20 + 60 * abs(sin(g / 9.0)) + (g % 13),
      'memory', jsonb_build_object('used', 400 + (g % 97) * 3, 'total', 1000,
        'swap', CASE WHEN gap THEN NULL ELSE jsonb_build_object('used', (g % 11) * 5, 'total', 200) END),
      'network', jsonb_build_object('rx', 1000 + (g % 53) * 17, 'tx', 500 + (g % 29) * 9),
      'io', jsonb_build_object('read', (g % 41) * 4, 'write', (g % 37) * 6,
        'latency', CASE WHEN gap THEN NULL ELSE jsonb_build_object(
          'readMs', (g % 7) * 0.5, 'writeMs', (g % 5) * 0.75, 'utilization', (g % 17) * 5) END),
      'load', jsonb_build_array((g % 19) / 4.0, (g % 23) / 5.0, (g % 31) / 6.0),
      'containers', jsonb_build_array(
        jsonb_build_object('name', 'alpha', 'cpu', (g % 21) * 1.5, 'memory', 100 + (g % 33) * 4,
          'network', jsonb_build_object('rx', g % 61, 'tx', g % 43)),
        CASE WHEN (epoch_bin / 900) % 3 = 0 THEN NULL ELSE
          jsonb_build_object('name', 'beta', 'cpu', (g % 9) * 2.5, 'memory', 50 + (g % 15) * 8,
            'network', jsonb_build_object('rx', g % 31, 'tx', g % 47)) END
      )
    ))
    FROM (
      SELECT g,
        (now() - make_interval(secs => g * 300 + (g * 37) % 120 + 90))::timestamp AS at,
        (extract(epoch FROM date_bin(interval '15 minutes',
          (now() - make_interval(secs => g * 300 + (g * 37) % 120 + 90))::timestamp,
          timestamp '2000-01-01'))::bigint) AS epoch_bin
      FROM generate_series(0, ${days * 288}) g WHERE g % 7 <> 3
    ) s,
    LATERAL (SELECT (epoch_bin / 900) % 7 = 0 AS gap) k`);
}

/** The aggregation the route ran before the rollups, copied as the oracle. */
async function rawOverview(
  executor: Executor,
  hostId: string,
  seconds: number,
  bucket: number,
): Promise<Row[]> {
  const result = await executor.execute(sql`
        WITH series AS (SELECT generate_series(
          date_bin(make_interval(secs => ${bucket}), now() - make_interval(secs => ${seconds}), timestamp '2000-01-01'),
          date_bin(make_interval(secs => ${bucket}), now(), timestamp '2000-01-01'), make_interval(secs => ${bucket})) AS at),
        grouped AS (SELECT date_bin(make_interval(secs => ${bucket}), at, timestamp '2000-01-01') AS at,
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
          avg((data->'io'->'latency'->>'utilization')::float) AS "utilization"
          FROM samples WHERE "hostId" = ${hostId} AND at > now() - make_interval(secs => ${seconds}) GROUP BY 1)
        SELECT series.at, grouped.cpu, grouped.memory, grouped.swap, grouped.rx, grouped.tx,
          grouped."ioRead", grouped."ioWrite", grouped."load1", grouped."load5", grouped."load15",
          grouped."readAwait", grouped."writeAwait", grouped."utilization"
        FROM series LEFT JOIN grouped USING(at) ORDER BY series.at`);
  return result.rows as Row[];
}

const CONTAINER_COLUMNS = ["cpu", "memory", "rx", "tx"] as const;

/** The per-container aggregation the route ran before the rollups. */
async function rawContainer(
  executor: Executor,
  hostId: string,
  container: string,
  seconds: number,
  bucket: number,
): Promise<Row[]> {
  const result = await executor.execute(sql`
        WITH series AS (SELECT generate_series(
          date_bin(make_interval(secs => ${bucket}), now() - make_interval(secs => ${seconds}), timestamp '2000-01-01'),
          date_bin(make_interval(secs => ${bucket}), now(), timestamp '2000-01-01'), make_interval(secs => ${bucket})) AS at),
        grouped AS (SELECT date_bin(make_interval(secs => ${bucket}), s.at, timestamp '2000-01-01') AS at,
          avg((c->>'cpu')::float) AS cpu,
          avg((c->>'memory')::float) AS memory,
          avg((c->'network'->>'rx')::float) AS rx,
          avg((c->'network'->>'tx')::float) AS tx
          FROM samples s
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(s.data->'containers') = 'array'
              THEN s.data->'containers' ELSE '[]'::jsonb END
          ) c
          WHERE s."hostId" = ${hostId}
            AND s.at > now() - make_interval(secs => ${seconds})
            AND c->>'name' = ${container}
          GROUP BY 1)
        SELECT series.at, grouped.cpu, grouped.memory, grouped.rx, grouped.tx
        FROM series LEFT JOIN grouped USING(at) ORDER BY series.at`);
  return result.rows as Row[];
}

const instant = (value: unknown) => new Date(value as string | Date).getTime();

/**
 * Same buckets, same gaps and every column within floating-point tolerance.
 * The first bucket is partial in the raw query and whole in the rollup, so it
 * is the one accepted difference at the edge of the range.
 */
function expectEquivalent(
  actual: Row[],
  expected: Row[],
  columns: readonly string[],
) {
  expect(actual).toHaveLength(expected.length);
  expect(actual.map((row) => instant(row.at))).toEqual(
    expected.map((row) => instant(row.at)),
  );
  actual.forEach((row, index) => {
    if (index === 0) return;
    for (const column of columns) {
      const want = expected[index][column];
      if (want === null || want === undefined)
        expect(row[column] ?? null, `${column} @${index}`).toBeNull();
      else
        expect(
          Number(row[column]),
          `${column} @${index}`,
        ).toBeCloseTo(Number(want), 6);
    }
  });
}

describe.skipIf(!baseUrl)("history rollups", () => {
  let context: TestDatabase;
  let db: Database;
  let pool: typeof import("@/lib/db").pool;
  let rollups: typeof import("@/lib/history-rollups");
  let routes: typeof import("../src/app/api/[...path]/route");
  const HISTORY_RANGES = {
    "7d": [604800, 900],
    "30d": [2592000, 3600],
  } as const;

  async function api(path: string) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    return routes.GET(new NextRequest(url, { method: "GET" }), {
      params: Promise.resolve({ path: route }),
    });
  }

  beforeAll(async () => {
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: "http://127.0.0.1:9",
        token: "a".repeat(32),
      },
    ]);
    context = await createTestDatabase(baseUrl!);
    process.env.DATABASE_URL = context.url;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const database = await import("@/lib/db");
    db = database.db;
    pool = database.pool;
    await migrate(db, { migrationsFolder: "./drizzle" });
    rollups = await import("@/lib/history-rollups");
    routes = await import("../src/app/api/[...path]/route");
    await seedSamples(db, "nas-home", 30);
    // The whole seeded history, then the periodic pass over the recent hours.
    await rollups.rollupRange(db, sql`timestamp '2000-01-01'`, sql`now()`);
    await rollups.rollupRecent(db);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    delete process.env.NAS_HOSTS;
  });

  it("equivale: el overview de 7d por la ruta coincide con la agregación cruda", async () => {
    const response = await api("/api/overview?host=nas-home&range=7d");
    expect(response.status).toBe(200);
    const body = await response.json();
    const oracle = await rawOverview(db, "nas-home", 604800, 900);
    expectEquivalent(body.history, oracle, OVERVIEW_COLUMNS);

    // A continuous series: one element per bucket, and the same column order.
    const steps = body.history.map((row: Row) => instant(row.at));
    for (let index = 1; index < steps.length; index += 1)
      expect(steps[index] - steps[index - 1]).toBe(900_000);
    expect(Object.keys(body.history[0])).toEqual(["at", ...OVERVIEW_COLUMNS]);
    // The seed has whole buckets without swap: they stay null, never zero.
    expect(
      body.history.some((row: Row) => row.swap === null && row.cpu !== null),
    ).toBe(true);
  });

  it.each([
    ["1h", 3600, 30],
    ["6h", 21600, 60],
    ["24h", 86400, 120],
  ] as const)(
    "equivale: %s sigue saliendo de las muestras crudas",
    async (range, seconds, bucket) => {
      const response = await api(`/api/overview?host=nas-home&range=${range}`);
      const body = await response.json();
      const oracle = await rawOverview(db, "nas-home", seconds, bucket);
      // Raw against raw: identical, first bucket included.
      expect(body.history).toHaveLength(oracle.length);
      body.history.forEach((row: Row, index: number) => {
        expect(instant(row.at)).toBe(instant(oracle[index].at));
        for (const column of OVERVIEW_COLUMNS)
          expect(row[column] ?? null).toEqual(oracle[index][column] ?? null);
      });
      const first = instant(body.history[0].at);
      const second = instant(body.history[1].at);
      expect(second - first).toBe(bucket * 1000);
    },
  );

  it("el rollup guarda el cubo sin zona horaria como samples.at", async () => {
    const result = await db.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'sample_rollups' AND column_name = 'bucket'`);
    expect(result.rows).toEqual([{ data_type: "timestamp without time zone" }]);

    // The same equivalence holds in a session whose zone is not UTC and is not
    // a whole number of hours away from it.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
      await seedSamples(tx, "zone-host", 8);
      await rollups.rollupRange(tx, sql`timestamp '2000-01-01'`, sql`now()`);
      expectEquivalent(
        await rollups.readHistory(tx, "zone-host", "7d"),
        await rawOverview(tx, "zone-host", 604800, 900),
        OVERVIEW_COLUMNS,
      );
    });
  });

  it("equivale: el overview de 30d reagrega a una hora con media ponderada", async () => {
    const response = await api("/api/overview?host=nas-home&range=30d");
    expect(response.status).toBe(200);
    const body = await response.json();
    const oracle = await rawOverview(db, "nas-home", 2592000, 3600);
    expectEquivalent(body.history, oracle, OVERVIEW_COLUMNS);
    const steps = body.history.map((row: Row) => instant(row.at));
    for (let index = 1; index < steps.length; index += 1)
      expect(steps[index] - steps[index - 1]).toBe(3_600_000);

    // The weighting is exercised: the 15-minute buckets differ in size and some
    // lack swap altogether, so an unweighted mean could not match the oracle.
    const shape = await db.execute(sql`
      SELECT count(DISTINCT n)::int AS sizes,
        count(*) FILTER (WHERE swap IS NULL)::int AS without_swap
      FROM sample_rollups WHERE "hostId" = 'nas-home'`);
    expect(shape.rows[0].sizes).toBeGreaterThan(1);
    expect(shape.rows[0].without_swap).toBeGreaterThan(0);
  });

  it.each(["7d", "30d"] as const)(
    "equivale: el historial de contenedor de %s coincide con la agregación cruda",
    async (range) => {
      const [seconds, bucket] = HISTORY_RANGES[range];
      for (const name of ["alpha", "beta"]) {
        const response = await api(
          `/api/container-history?host=nas-home&name=${name}&range=${range}`,
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.name).toBe(name);
        const oracle = await rawContainer(db, "nas-home", name, seconds, bucket);
        expectEquivalent(body.history, oracle, CONTAINER_COLUMNS);
        expect(Object.keys(body.history[0])).toEqual(["at", ...CONTAINER_COLUMNS]);
      }
    },
  );

  it("equivale: un contenedor ausente en algunos cubos da huecos nulos, no ceros", async () => {
    // `beta` is missing from one bucket in three, `alpha` from none.
    const beta = await rollups.readContainerHistory(db, "nas-home", "beta", "7d");
    const alpha = await rollups.readContainerHistory(db, "nas-home", "alpha", "7d");
    expect(beta.some((row) => row.cpu === null)).toBe(true);
    expect(beta.some((row) => row.cpu !== null)).toBe(true);
    expect(beta.filter((row) => row.cpu === 0)).toEqual([]);
    const gaps = alpha.slice(1, -1).filter((row) => row.cpu === null);
    expect(gaps).toEqual([]);

    const unknown = await rollups.readContainerHistory(db, "nas-home", "ghost", "30d");
    expect(unknown.length).toBeGreaterThan(1);
    expect(unknown.every((row) => row.cpu === null)).toBe(true);
  });

  it("equivale: la validación del nombre de contenedor sigue respondiendo 400", async () => {
    for (const name of ["", "x".repeat(201)]) {
      const response = await api(
        `/api/container-history?host=nas-home&name=${name}&range=7d`,
      );
      expect(response.status).toBe(400);
    }
    const missing = await api("/api/container-history?host=nas-home&range=7d");
    expect(missing.status).toBe(400);
    const edge = await api(
      `/api/container-history?host=nas-home&name=${"x".repeat(200)}&range=7d`,
    );
    expect(edge.status).toBe(200);
  });

  it("las rutas no consultan samples para el historial", () => {
    const route = readFileSync("src/app/api/[...path]/route.ts", "utf8");
    // The raw SQL of the short ranges lives in the history module.
    expect(route).not.toContain("FROM samples");
    expect(route).toContain("readHistory");
    expect(route).toContain("readContainerHistory");
  });

  it("no borra ninguna muestra cruda", async () => {
    const before = await db.execute(sql`SELECT count(*)::int AS n FROM samples`);
    await rollups.rollupRecent(db);
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM samples`);
    expect(after.rows).toEqual(before.rows);
  });
});
