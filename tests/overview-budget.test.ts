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

/**
 * Performance budget of the 30-day overview (PERF-02, D-21). It seeds 500 000
 * samples, so it runs only on request: `pnpm test:perf` sets `HUB_PERF=1`. The
 * environment check comes first so a normal run never reaches the database.
 */
const perf = process.env.HUB_PERF === "1";
const baseUrl = perf ? testDatabaseUrl() : null;
if (perf && !baseUrl)
  throw new Error("HUB_PERF=1 requiere DATABASE_URL apuntando a PostgreSQL local");

const SAMPLES = 500_000;
const HOST = "nas-home";
const WARMUP = 5;
const RUNS = 50;
const BUDGET_MS = 150;
/** A ceiling, not an expectation: the real timings are logged below. */
const SETUP_TIMEOUT_MS = 900_000;

type Row = Record<string, unknown>;
type PlanNode = { "Relation Name"?: string; Plans?: PlanNode[] };

/** Nearest-rank percentile: the value at position ceil(p * N) - 1 of the sorted list. */
function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function relations(node: PlanNode, found = new Set<string>()) {
  if (node["Relation Name"]) found.add(node["Relation Name"]);
  for (const child of node.Plans ?? []) relations(child, found);
  return found;
}

describe.skipIf(!perf)("presupuesto del overview con 500 000 muestras", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let rollups: typeof import("@/lib/history-rollups");
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(path: string) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    return routes.GET(new NextRequest(url, { method: "GET" }), {
      params: Promise.resolve({ path: route }),
    });
  }

  /** Warms up, then times `RUNS` calls including the body read. */
  async function measure(range: string) {
    for (let index = 0; index < WARMUP; index += 1)
      await (await api(`/api/overview?host=${HOST}&range=${range}`)).text();
    const durations: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const started = performance.now();
      const response = await api(`/api/overview?host=${HOST}&range=${range}`);
      await response.text();
      durations.push(performance.now() - started);
      expect(response.status).toBe(200);
    }
    return {
      n: durations.length,
      p95: percentile(durations, 0.95),
      max: Math.max(...durations),
    };
  }

  beforeAll(async () => {
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: HOST,
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

    let started = performance.now();
    // One sample about every 5 s over 30 days, each with ten containers (~2 KB).
    await db.execute(sql`
      INSERT INTO samples ("hostId", at, data)
      SELECT ${HOST}, (now() - make_interval(secs => g * (2592000.0 / ${SAMPLES}) + 1))::timestamp,
        jsonb_build_object(
          'cpu', 20 + 60 * abs(sin(g / 900.0)) + (g % 13),
          'memory', jsonb_build_object('used', 400 + (g % 97) * 3, 'total', 1000,
            'swap', jsonb_build_object('used', (g % 11) * 5, 'total', 200)),
          'network', jsonb_build_object('rx', 1000 + (g % 53) * 17, 'tx', 500 + (g % 29) * 9),
          'io', jsonb_build_object('read', (g % 41) * 4, 'write', (g % 37) * 6,
            'latency', jsonb_build_object(
              'readMs', (g % 7) * 0.5, 'writeMs', (g % 5) * 0.75, 'utilization', (g % 17) * 5)),
          'load', jsonb_build_array((g % 19) / 4.0, (g % 23) / 5.0, (g % 31) / 6.0),
          'containers', (
            SELECT jsonb_agg(jsonb_build_object(
              'name', 'servicio-' || k, 'cpu', ((g + k) % 21) * 1.5,
              'memory', 100 + ((g + k) % 33) * 4,
              'network', jsonb_build_object('rx', (g + k) % 61, 'tx', (g + k) % 43)))
            FROM generate_series(1, 10) k))
      FROM generate_series(0, ${SAMPLES - 1}) g`);
    const seedMs = performance.now() - started;

    started = performance.now();
    await rollups.backfillRollups(db);
    const backfillMs = performance.now() - started;

    started = performance.now();
    await db.execute(sql`ANALYZE samples`);
    await db.execute(sql`ANALYZE sample_rollups`);
    await db.execute(sql`ANALYZE container_rollups`);
    const analyzeMs = performance.now() - started;

    console.info(
      `Presupuesto: siembra ${Math.round(seedMs)} ms, backfill ${Math.round(backfillMs)} ms, ANALYZE ${Math.round(analyzeMs)} ms (techo ${SETUP_TIMEOUT_MS} ms)`,
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
    if (context) await dropTestDatabase(context);
    delete process.env.NAS_HOSTS;
  }, 120_000);

  it("el overview de 30d tiene p95 menor de 150 ms", async () => {
    const result = await measure("30d");
    console.info(
      `Overview 30d: p95 ${result.p95.toFixed(1)} ms, máximo ${result.max.toFixed(1)} ms, N ${result.n}`,
    );
    expect(result.n).toBeGreaterThanOrEqual(50);
    expect(result.p95).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it("el plan de 30d no lee samples y sí sample_rollups", async () => {
    const explained = await db.execute(
      sql`EXPLAIN (FORMAT JSON) ${rollups.historyStatement(HOST, "30d")}`,
    );
    const plan = (explained.rows[0] as Row)["QUERY PLAN"] as { Plan: PlanNode }[];
    const found = relations(plan[0].Plan);
    expect(found.has("samples")).toBe(false);
    expect(found.has("sample_rollups")).toBe(true);
  });

  it("el overview de 24h se mide solo como información", async () => {
    const result = await measure("24h");
    console.info(
      `Overview 24h (informativo): p95 ${result.p95.toFixed(1)} ms, máximo ${result.max.toFixed(1)} ms, N ${result.n}`,
    );
    expect(result.n).toBeGreaterThanOrEqual(50);
  }, 300_000);

  it("la poda a 48 horas no cambia la serie de 24h", async () => {
    const count = async () =>
      Number(
        (await db.execute(sql`SELECT count(*)::int AS n FROM samples`)).rows[0]
          .n,
      );
    const latest = async () =>
      (
        await db.execute(sql`
          SELECT id FROM samples WHERE "hostId" = ${HOST} ORDER BY at DESC, id DESC LIMIT 1`)
      ).rows[0] as { id: number };
    const before = await rollups.readHistory(db, HOST, "24h");
    const rowsBefore = await count();
    const newest = await latest();

    const started = performance.now();
    const pruned = await rollups.pruneHistory(db, { budgetMs: 600_000 });
    console.info(
      `Poda: ${pruned.deleted} muestras en ${Math.round(performance.now() - started)} ms, agotada ${pruned.exhausted}`,
    );

    const after = await rollups.readHistory(db, HOST, "24h");
    expect(await count()).toBeLessThan(rowsBefore);
    expect(await latest()).toEqual(newest);

    // The window slides between the two reads, so the first bucket of each is
    // partial; every bucket both series hold whole must be identical.
    const at = (row: Row) => new Date(row.at as string | Date).getTime();
    const afterByTime = new Map(after.map((row) => [at(row), row]));
    const edge = Math.max(at(before[0]), at(after[0]));
    const shared = before.filter((row) => at(row) > edge);
    expect(shared.length).toBeGreaterThan(600);
    for (const row of shared) {
      const other = afterByTime.get(at(row));
      expect(other).toBeDefined();
      // Floating-point sums may differ in the last digit between two reads.
      for (const column of ["cpu", "memory"]) {
        const want = row[column];
        if (want === null || want === undefined)
          expect(other?.[column] ?? null).toBeNull();
        else expect(Number(other?.[column])).toBeCloseTo(Number(want), 6);
      }
    }
    expect(
      shared.filter((row) => row.cpu !== null).map(at),
    ).toEqual(shared.filter((row) => afterByTime.get(at(row))?.cpu !== null).map(at));
  }, 900_000);
});
