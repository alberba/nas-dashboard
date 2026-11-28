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
    // Those rows are naive local times of another zone, hours ahead of the
    // session clock; leaving them would make the later whole-day backfill
    // disagree with the passes capped at now().
    for (const table of ["samples", "sample_rollups", "container_rollups"])
      await db.execute(
        sql`DELETE FROM ${sql.raw(table)} WHERE "hostId" = 'zone-host'`,
      );
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
    // A bucket without the container is a null row in every column, never zeros.
    for (const row of beta.filter((entry) => entry.cpu === null))
      expect([row.memory, row.rx, row.tx]).toEqual([null, null, null]);
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

  async function rollupContents() {
    const samplesTable = await db.execute(
      sql`SELECT * FROM sample_rollups ORDER BY "hostId", bucket`,
    );
    const containers = await db.execute(
      sql`SELECT * FROM container_rollups ORDER BY "hostId", container, bucket`,
    );
    return { samples: samplesTable.rows as Row[], containers: containers.rows as Row[] };
  }

  /** Same keys and counts, every float within tolerance. */
  function expectSameContents(
    actual: Awaited<ReturnType<typeof rollupContents>>,
    expected: Awaited<ReturnType<typeof rollupContents>>,
  ) {
    for (const table of ["samples", "containers"] as const) {
      expect(actual[table]).toHaveLength(expected[table].length);
      actual[table].forEach((row, index) => {
        for (const [key, want] of Object.entries(expected[table][index])) {
          if (typeof want === "number")
            expect(Number(row[key]), `${table}.${key} #${index}`).toBeCloseTo(want, 6);
          else expect(row[key], `${table}.${key} #${index}`).toEqual(want);
        }
      });
    }
  }

  it("idempotencia: repetir rollupRecent deja el mismo contenido en ambas tablas", async () => {
    await rollups.rollupRecent(db);
    const first = await rollupContents();
    expect(first.samples.length).toBeGreaterThan(0);
    expect(first.containers.length).toBeGreaterThan(0);
    await rollups.rollupRecent(db);
    expectSameContents(await rollupContents(), first);
    // Also with an injected clock instead of the database one.
    await rollups.rollupRecent(db, new Date());
    expectSameContents(await rollupContents(), first);
  });

  it("backfill: puebla ambas tablas desde el histórico y es idempotente", async () => {
    const expected = await rollupContents();
    await db.execute(sql`DELETE FROM sample_rollups`);
    await db.execute(sql`DELETE FROM container_rollups`);
    expect((await rollupContents()).samples).toEqual([]);

    const days: string[] = [];
    const started = performance.now();
    const processed = await rollups.backfillRollups(db, {
      onDay: (day) => {
        days.push(day);
      },
    });
    const elapsed = performance.now() - started;
    // 30 days of history plus today, walked one day at a time.
    expect(processed).toBe(days.length);
    expect(processed).toBeGreaterThanOrEqual(31);
    expect(elapsed).toBeLessThan(60_000);
    expectSameContents(await rollupContents(), expected);

    await rollups.backfillRollups(db);
    expectSameContents(await rollupContents(), expected);

    // A shutdown between days stops the walk without leaving a half day.
    const stopped = await rollups.backfillRollups(db, { stopping: () => true });
    expect(stopped).toBe(0);
  });

  it("backfill: una muestra tardía en las 2 últimas horas se corrige con rollupRecent", async () => {
    const bucket = sql`date_bin(interval '15 minutes', (now() - interval '40 minutes')::timestamp, timestamp '2000-01-01')`;
    const read = async () =>
      (
        await db.execute(sql`
          SELECT n, cpu FROM sample_rollups
          WHERE "hostId" = 'nas-home' AND bucket = ${bucket}`)
      ).rows[0] as { n: number; cpu: number };
    const before = await read();
    await db.execute(sql`
      INSERT INTO samples ("hostId", at, data)
      VALUES ('nas-home', (now() - interval '40 minutes')::timestamp, '{"cpu": 1000}'::jsonb)`);
    // Not yet folded in: the late sample is invisible to the rollup.
    expect((await read()).n).toBe(before.n);

    await rollups.rollupRecent(db);

    const after = await read();
    expect(after.n).toBe(before.n + 1);
    const truth = (
      await db.execute(sql`
        SELECT count(*)::int AS n, avg((data->>'cpu')::float) AS cpu FROM samples
        WHERE "hostId" = 'nas-home' AND date_bin(interval '15 minutes', at, timestamp '2000-01-01') = ${bucket}`)
    ).rows[0] as { n: number; cpu: number };
    expect(after.n).toBe(truth.n);
    expect(after.cpu).toBeCloseTo(truth.cpu, 6);
  });

  it("no borra ninguna muestra cruda", async () => {
    const before = await db.execute(sql`SELECT count(*)::int AS n FROM samples`);
    await rollups.rollupRecent(db);
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM samples`);
    expect(after.rows).toEqual(before.rows);
  });

  describe("retención", () => {
    const ROLLED_BACK = Symbol("rolled back");
    type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

    /**
     * Runs `body` on an empty database inside a transaction that is always
     * rolled back, so pruning never touches the seed the other tests share.
     */
    async function isolated(body: (tx: Transaction) => Promise<void>) {
      await db
        .transaction(async (tx) => {
          await tx.execute(sql`DELETE FROM samples`);
          await tx.execute(sql`DELETE FROM sample_rollups`);
          await tx.execute(sql`DELETE FROM container_rollups`);
          await tx.execute(sql`DELETE FROM ingest_events`);
          await body(tx);
          throw ROLLED_BACK;
        })
        .catch((error: unknown) => {
          if (error !== ROLLED_BACK) throw error;
        });
    }

    /** One sample every `stepMinutes` between two ages in hours, relative to the database clock. */
    async function seed(
      tx: Transaction,
      hostId: string,
      fromHoursAgo: number,
      toHoursAgo: number,
      stepMinutes = 30,
    ) {
      await tx.execute(sql`
        INSERT INTO samples ("hostId", at, data)
        SELECT ${hostId}, (now() - make_interval(mins => m))::timestamp, '{"cpu": 10}'::jsonb
        FROM generate_series(${toHoursAgo * 60}::int, ${fromHoursAgo * 60}::int, ${stepMinutes}::int) m`);
    }

    const aggregate = (tx: Transaction) =>
      rollups.rollupRange(tx, sql`timestamp '2000-01-01'`, sql`now()`);

    const count = async (tx: Transaction, where: ReturnType<typeof sql>) => {
      const result = await tx.execute(
        sql`SELECT count(*)::int AS n FROM samples WHERE ${where}`,
      );
      return (result.rows[0] as { n: number }).n;
    };

    const cutoff = sql`at < now() - make_interval(hours => 48)`;

    it("borra lo anterior a 48 horas con cubo agregado y conserva lo reciente", async () => {
      await isolated(async (tx) => {
        await seed(tx, "ret-a", 72, 0);
        await aggregate(tx);
        const before = await count(tx, sql`true`);
        const recent = await count(tx, sql`NOT (${cutoff})`);
        const old = before - recent;
        expect(old).toBeGreaterThan(0);

        const result = await rollups.pruneSamples(tx, { budgetMs: 60_000 });

        expect(result.deleted).toBe(old);
        expect(result.exhausted).toBe(true);
        expect(await count(tx, sql`true`)).toBe(before - result.deleted);
        expect(await count(tx, sql`NOT (${cutoff})`)).toBe(recent);
      });
    });

    it("conserva una muestra anterior a 48 horas cuyo cubo no está agregado", async () => {
      await isolated(async (tx) => {
        await seed(tx, "ret-a", 72, 0);
        await aggregate(tx);
        // The bucket of the sample from 60 hours ago is dropped from the rollup.
        const missing = sql`date_bin(interval '15 minutes', (now() - make_interval(hours => 60))::timestamp, timestamp '2000-01-01')`;
        const inBucket = sql`date_bin(interval '15 minutes', at, timestamp '2000-01-01') = ${missing}`;
        const kept = await count(tx, inBucket);
        expect(kept).toBeGreaterThan(0);
        await tx.execute(sql`DELETE FROM sample_rollups WHERE bucket = ${missing}`);

        await rollups.pruneSamples(tx, { budgetMs: 60_000 });

        expect(await count(tx, inBucket)).toBe(kept);
        expect(await count(tx, sql`${cutoff} AND NOT (${inBucket})`)).toBe(0);
      });
    });

    it("conserva la última muestra de cada host aunque sea antigua y esté agregada", async () => {
      await isolated(async (tx) => {
        await seed(tx, "ret-a", 100, 60);
        await seed(tx, "ret-b", 120, 70);
        await aggregate(tx);

        await rollups.pruneSamples(tx, { budgetMs: 60_000 });

        const left = await tx.execute(sql`
          SELECT "hostId", at, id FROM samples ORDER BY "hostId"`);
        expect(left.rows.map((row) => row.hostId)).toEqual(["ret-a", "ret-b"]);
        const latest = await tx.execute(sql`
          SELECT s."hostId" FROM samples s WHERE NOT EXISTS (
            SELECT 1 FROM samples n WHERE n."hostId" = s."hostId" AND n.at > s.at)`);
        expect(latest.rows).toHaveLength(2);
      });
    });

    it("conserva la última muestra aunque otra tenga la misma marca de tiempo", async () => {
      await isolated(async (tx) => {
        await tx.execute(sql`
          INSERT INTO samples ("hostId", at, data)
          SELECT 'ret-a', (now() - make_interval(hours => 80))::timestamp, '{"cpu": 1}'::jsonb
          FROM generate_series(1, 3)`);
        await aggregate(tx);

        const result = await rollups.pruneSamples(tx, { budgetMs: 60_000 });

        expect(result.deleted).toBe(2);
        expect(await count(tx, sql`true`)).toBe(1);
      });
    });

    it("borra por lotes y con budgetMs 0 ejecuta un solo lote por pasada", async () => {
      await isolated(async (tx) => {
        await seed(tx, "ret-a", 100, 49, 30);
        await seed(tx, "ret-a", 1, 0, 30);
        await aggregate(tx);
        const eligible = await count(tx, cutoff);
        expect(eligible).toBeGreaterThan(25);

        const first = await rollups.pruneSamples(tx, { batchSize: 10, budgetMs: 0 });
        expect(first).toEqual({ deleted: 10, exhausted: false });

        let statements = 0;
        const counting: Pick<Transaction, "execute"> = {
          execute: ((query: Parameters<Transaction["execute"]>[0]) => {
            statements += 1;
            return tx.execute(query);
          }) as Transaction["execute"],
        };
        const rest = await rollups.pruneSamples(counting, {
          batchSize: 10,
          budgetMs: 60_000,
        });
        expect(rest.exhausted).toBe(true);
        expect(rest.deleted).toBe(eligible - 10);
        expect(statements).toBeGreaterThan(1);
        expect(await count(tx, cutoff)).toBe(0);

        const again = await rollups.pruneSamples(tx, { budgetMs: 60_000 });
        expect(again).toEqual({ deleted: 0, exhausted: true });
      });
    });

    it("pruneHistory poda rollups e ingest a 30 días y repetirla no borra nada", async () => {
      await isolated(async (tx) => {
        await seed(tx, "ret-a", 100, 0);
        await aggregate(tx);
        await tx.execute(sql`
          INSERT INTO sample_rollups ("hostId", bucket, n) VALUES
            ('ret-old', (now() - interval '40 days')::timestamp, 1),
            ('ret-new', (now() - interval '20 days')::timestamp, 1)`);
        await tx.execute(sql`
          INSERT INTO container_rollups ("hostId", container, bucket, n) VALUES
            ('ret-old', 'c', (now() - interval '40 days')::timestamp, 1),
            ('ret-new', 'c', (now() - interval '20 days')::timestamp, 1)`);
        await tx.execute(sql`
          INSERT INTO ingest_events (source, "eventId", "bodyHash", "receivedAt") VALUES
            ('s', 'old', 'h', (now() - interval '40 days')::timestamp),
            ('s', 'new', 'h', (now() - interval '1 day')::timestamp)`);

        const first = await rollups.pruneHistory(tx, { budgetMs: 60_000 });

        expect(first.sampleRollups).toBe(1);
        expect(first.containerRollups).toBe(1);
        expect(first.ingestEvents).toBe(1);
        const left = async (table: string) =>
          (
            await tx.execute(
              sql`SELECT "hostId" FROM ${sql.raw(table)} WHERE "hostId" IN ('ret-old', 'ret-new') ORDER BY 1`,
            )
          ).rows.map((row) => row.hostId);
        expect(await left("sample_rollups")).toEqual(["ret-new"]);
        expect(await left("container_rollups")).toEqual(["ret-new"]);
        const events = await tx.execute(sql`SELECT "eventId" FROM ingest_events`);
        expect(events.rows).toEqual([{ eventId: "new" }]);

        const second = await rollups.pruneHistory(tx, { budgetMs: 60_000 });
        expect(second).toEqual({
          deleted: 0,
          exhausted: true,
          sampleRollups: 0,
          containerRollups: 0,
          ingestEvents: 0,
        });
      });
    });
  });
});

describe("history rollups: carril del worker", () => {
  type Turn = import("@/lib/worker-loop").WorkerTurnDeps;

  async function harness(overrides: Partial<Turn> = {}) {
    const loop = await import("@/lib/worker-loop");
    const rollupModule = await import("@/lib/history-rollups");
    const order: string[] = [];
    let now = 10_000_000;
    // The same shape the earlier harnesses use: no `lastRollup` in the state.
    const state: Turn["state"] = { lastCollection: 0, lastCleanup: 0 };
    const deps: Turn = {
      health: {
        renew: async () => {
          order.push("renew");
          return true;
        },
      } as unknown as Turn["health"],
      holdsLock: async () => true,
      stopping: () => false,
      now: () => now,
      presenceActive: async () => false,
      sampleInterval: () => 30_000,
      collect: async () => {
        order.push("collect");
      },
      drain: async () => {
        order.push("drain");
      },
      cleanup: async () => {
        order.push("cleanup");
      },
      rollups: async () => {
        order.push("rollups");
      },
      state,
      ...overrides,
    };
    return {
      deps,
      state,
      order,
      loop,
      period: rollupModule.WORKER_ROLLUP_MS,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("ejecuta rollups en el primer turno, no antes de WORKER_ROLLUP_MS y renueva la marca", async () => {
    const { deps, state, order, loop, period, advance } = await harness();
    await loop.workerTurn(deps);
    const first = order.indexOf("rollups");
    expect(first).toBeGreaterThan(-1);
    // A completed rollup renews the health mark right after it ran.
    expect(order[first + 1]).toBe("renew");
    expect(state.lastRollup).toBe(10_000_000);

    advance(period - 1);
    await loop.workerTurn(deps);
    expect(order.filter((step) => step === "rollups")).toHaveLength(1);

    advance(1);
    await loop.workerTurn(deps);
    expect(order.filter((step) => step === "rollups")).toHaveLength(2);
    expect(state.lastRollup).toBe(10_000_000 + period);
  });

  it("sin la dependencia rollups se comporta como antes", async () => {
    const { deps, state, order, loop } = await harness({ rollups: undefined });
    await loop.workerTurn(deps);
    expect(order).not.toContain("rollups");
    expect(state.lastRollup).toBeUndefined();
    expect(order).toEqual([
      "renew",
      "collect",
      "renew",
      "drain",
      "renew",
      "cleanup",
      "renew",
    ]);
  });

  it("un fallo de rollups propaga el error antes de renovar la marca", async () => {
    const failures: string[] = [];
    const { deps, order, loop } = await harness({
      rollups: async () => {
        failures.push("rollups");
        throw new Error("db down");
      },
    });
    await expect(loop.workerTurn(deps)).rejects.toThrow("db down");
    expect(failures).toEqual(["rollups"]);
    // Nothing renewed after the failed lane: the last step is the cleanup mark.
    expect(order.at(-1)).toBe("renew");
    expect(order.slice(-2)).toEqual(["cleanup", "renew"]);
  });
});
