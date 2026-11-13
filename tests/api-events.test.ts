import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
      })),
    },
  },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)("events API and open alert count", () => {
  let context: TestDatabase;
  let server: Server;
  let agentUrl: string;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(method: "GET", path: string) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    const request = new NextRequest(url, { method });
    return routes[method](request, {
      params: Promise.resolve({ path: route }),
    });
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Sin instantánea" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: agentUrl,
        token: "a".repeat(32),
      },
      {
        id: "apps",
        name: "Apps",
        role: "apps-server",
        url: agentUrl,
        token: "b".repeat(32),
      },
    ]);
    context = await createTestDatabase(baseUrl!);
    process.env.DATABASE_URL = context.url;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const database = await import("@/lib/db");
    db = database.db;
    pool = database.pool;
    await migrate(db, { migrationsFolder: "./drizzle" });
    tables = await import("@/lib/schema");
    routes = await import("../src/app/api/[...path]/route");
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    delete process.env.NAS_HOSTS;
  });

  beforeEach(async () => {
    await db.delete(tables.alerts);
    await db.delete(tables.operations);
    await db.delete(tables.samples);
    await db.delete(tables.configuration);
  });

  async function alert(
    hostId: string,
    key: string,
    resolvedAt: Date | null = null,
  ) {
    await db.insert(tables.alerts).values({
      hostId,
      key,
      title: key,
      detail: "",
      severity: "warning",
      resolvedAt,
    });
  }

  it("reports the open alert count that the sidebar shows for the selected host", async () => {
    await alert("apps", "backup-failed");
    await alert("apps", "disk-health");
    await alert("apps", "reboot-pending", new Date());
    await alert("nas-home", "stack-unit-failed");

    const apps = await (await api("GET", "/api/overview?host=apps")).json();
    expect(apps.openAlerts).toBe(2);
    expect(apps.openAlerts).toBe(
      apps.alerts.filter(
        (entry: { resolvedAt: string | null }) => !entry.resolvedAt,
      ).length,
    );

    const nas = await (await api("GET", "/api/overview?host=nas-home")).json();
    expect(nas.openAlerts).toBe(1);
    expect(nas.alerts.every((entry: { hostId: string }) => entry.hostId === "nas-home")).toBe(
      true,
    );
  });

  it("serves today's feed for the selected host and tolerates lost agents", async () => {
    const now = new Date();
    await db.insert(tables.operations).values([
      {
        id: "00000000-0000-4000-8000-000000000001",
        hostId: "apps",
        userId: "test-user",
        action: "check-health",
        target: "Apps",
        status: "success",
        at: now,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        hostId: "nas-home",
        userId: "test-user",
        action: "deploy-now",
        target: "NAS-HOME",
        status: "success",
        at: now,
      },
    ]);

    const response = await api("GET", "/api/events?host=apps");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.host.id).toBe("apps");
    expect(body.timeZone).toBe("Europe/Madrid");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      kind: "health",
      action: "check-health",
      status: "ok",
    });
    expect(body.degraded).toEqual(
      expect.arrayContaining(["maintenance", "deployments"]),
    );
    expect(JSON.stringify(body)).not.toContain("test-user");
  });

  it("rejects an unknown host without calling an agent", async () => {
    const response = await api("GET", "/api/events?host=ghost");
    expect(response.status).toBe(404);
  });
});
