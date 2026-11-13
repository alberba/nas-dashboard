import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { deploymentsSnapshot, maintenanceSnapshot } from "./host-fixtures";

type FakeAgent = {
  token: string;
  url: string;
  maintenance: unknown;
  deployments: unknown;
  failMaintenance: boolean;
  failDeployments: boolean;
  close(): Promise<void>;
};

async function fakeAgent(): Promise<FakeAgent> {
  const agent: FakeAgent = {
    token: "a".repeat(32),
    url: "",
    maintenance: maintenanceSnapshot(),
    deployments: deploymentsSnapshot(),
    failMaintenance: false,
    failDeployments: false,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const server: Server = createServer(async (request, response) => {
    request.resume();
    const path = new URL(request.url ?? "/", "http://agent").pathname;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${agent.token}`)
      return send(401, { error: "No autorizado" });
    if (path === "/maintenance")
      return agent.failMaintenance
        ? send(503, { error: "Sin instantánea" })
        : send(200, agent.maintenance);
    if (path === "/deployments")
      return agent.failDeployments
        ? send(503, { error: "Sin instantánea" })
        : send(200, agent.deployments);
    return send(404, { error: "No encontrado" });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)("today's host events", () => {
  let context: TestDatabase;
  let agent: FakeAgent;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let eventsForHost: typeof import("@/lib/events").eventsForHost;
  const host = {
    id: "nas-home",
    name: "NAS-HOME",
    role: "instance" as const,
    url: "",
    token: "a".repeat(32),
  };

  async function operation(
    id: string,
    action: string,
    at: string,
    status = "success",
  ) {
    await db.insert(tables.operations).values({
      id,
      hostId: "nas-home",
      userId: "test-user",
      action,
      target: "NAS-HOME",
      status,
      at: new Date(at),
    });
  }

  beforeAll(async () => {
    agent = await fakeAgent();
    host.url = agent.url;
    context = await createTestDatabase(baseUrl!);
    process.env.DATABASE_URL = context.url;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const database = await import("@/lib/db");
    db = database.db;
    pool = database.pool;
    await migrate(db, { migrationsFolder: "./drizzle" });
    ({ eventsForHost } = await import("@/lib/events"));
    tables = await import("@/lib/schema");
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await agent.close();
  });

  beforeEach(async () => {
    await db.delete(tables.operations);
    await db.delete(tables.alerts);
    agent.maintenance = maintenanceSnapshot();
    agent.deployments = deploymentsSnapshot();
    agent.failMaintenance = false;
    agent.failDeployments = false;
  });

  it("merges deployments, health, retentions, backups and security runs for the Madrid day", async () => {
    const now = new Date("2026-11-13T20:00:00Z");
    await operation("op-deploy", "deploy-now", "2026-11-13T10:00:00Z");
    await operation("op-health", "check-health", "2026-11-13T11:00:00Z", "failed");
    await operation("op-backup", "backup-now", "2026-11-13T12:00:00Z", "pending");
    await operation(
      "op-security-yesterday",
      "run-security",
      "2026-11-12T22:30:00Z",
    );
    await operation("op-container", "restart", "2026-11-13T09:00:00Z");

    agent.deployments = deploymentsSnapshot({
      history: [
        {
          release: "v2.5.0",
          outcome: "success",
          at: "2026-11-13T08:00:00Z",
          previousRelease: "v2.4.1",
          services: ["radarr"],
        },
        {
          release: "v2.4.9",
          outcome: "rolled-back",
          at: "2026-11-12T23:30:00Z",
          previousRelease: "v2.4.8",
          services: ["sonarr"],
        },
        {
          release: "v2.4.8",
          outcome: "success",
          at: "2026-11-12T22:00:00Z",
          previousRelease: "v2.4.7",
          services: [],
        },
      ],
      retained: [
        {
          release: "v2.5.1",
          reason: "missing-configuration",
          blockedBy: null,
          breaking: false,
          manualSteps: [],
          missingSettings: ["NEW_SETTING"],
          services: ["radarr"],
          sourceCommit: null,
          at: "2026-11-13T07:00:00Z",
        },
      ],
    });
    agent.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
      units: [
        {
          name: "media-stack-security-updates",
          kind: "security",
          service: "media-stack-security-updates.service",
          timer: "media-stack-security-updates.timer",
          activeState: "active",
          subState: "waiting",
          unitFileState: "enabled",
          result: "success",
          state: "active",
          paused: false,
          lastRun: "2026-11-13T06:00:00Z",
          nextRun: "2026-11-14T06:00:00Z",
        },
      ],
    });

    const result = await eventsForHost(host, now.getTime());
    expect(result.day).toBe("2026-11-13");
    expect(result.timeZone).toBe("Europe/Madrid");
    expect(result.degraded).toEqual([]);
    expect(result.events.map((event) => event.kind)).toEqual([
      "backup",
      "health",
      "deploy",
      "deploy",
      "retention",
      "security",
      "backup",
      "deploy",
    ]);
    expect(result.events.map((event) => event.status)).toEqual([
      "pending",
      "failed",
      "ok",
      "ok",
      "info",
      "ok",
      "failed",
      "failed",
    ]);
    expect(result.events[0]).toMatchObject({ action: "backup-now" });
    expect(result.events[1]).toMatchObject({ action: "check-health" });
    expect(result.events[2]).toMatchObject({ action: "deploy-now" });
    expect(result.events[3]).toMatchObject({ release: "v2.5.0" });
    expect(result.events[4]).toMatchObject({
      release: "v2.5.1",
      reason: "missing-configuration",
    });
    expect(result.events[5]).toMatchObject({
      unit: "media-stack-security-updates",
    });
    expect(result.events[6]).toMatchObject({ release: null });
    expect(result.events[7]).toMatchObject({ release: "v2.4.9" });
    expect(
      new Set(result.events.map((event) => event.id)).size,
    ).toBe(result.events.length);
  });

  it("starts the day at midnight in Madrid, not in UTC", async () => {
    const now = new Date("2026-11-13T23:30:00Z");
    agent.deployments = deploymentsSnapshot({
      history: [
        {
          release: "v2.6.0",
          outcome: "success",
          at: "2026-11-13T23:10:00Z",
          previousRelease: "v2.5.0",
          services: [],
        },
        {
          release: "v2.5.9",
          outcome: "success",
          at: "2026-11-13T22:00:00Z",
          previousRelease: "v2.5.0",
          services: [],
        },
      ],
    });
    agent.maintenance = maintenanceSnapshot({
      backup: { status: "ok", at: "2026-11-13T23:20:00Z" },
    });
    await operation("op-late-health", "check-health", "2026-11-13T23:05:00Z");

    const result = await eventsForHost(host, now.getTime());
    expect(result.day).toBe("2026-11-14");
    expect(result.events.map((event) => event.kind)).toEqual([
      "backup",
      "deploy",
      "health",
    ]);
    expect(result.events[1]).toMatchObject({ release: "v2.6.0" });
  });

  it("still returns today's hub actions when an agent snapshot is unavailable", async () => {
    const now = new Date("2026-11-13T20:00:00Z");
    await operation("op-health", "check-health", "2026-11-13T11:00:00Z");
    agent.maintenance = maintenanceSnapshot({
      backup: { status: "unknown", at: null },
      degraded: ["backup"],
    });
    agent.failDeployments = true;

    const result = await eventsForHost(host, now.getTime());
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "health",
      status: "ok",
      action: "check-health",
    });
    expect(result.degraded).toContain("deployments");
    expect(result.degraded).toContain("maintenance:backup");
  });
});
