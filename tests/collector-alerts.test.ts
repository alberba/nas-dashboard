import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { deploymentsSnapshot, maintenanceSnapshot, metricsSnapshot } from "./host-fixtures";

const push = vi.hoisted(() => ({
  notify: vi.fn<
    (title: string, body: string, tag: string) => Promise<void>
  >(async () => {}),
}));
vi.mock("@/lib/push", () => ({ notify: push.notify }));

type AgentState = {
  maintenance: unknown;
  deployments: unknown;
  failMaintenance: boolean;
  failDeployments: boolean;
  requests: string[];
};

type FakeAgent = AgentState & {
  name: string;
  token: string;
  url: string;
  reset(): void;
  close(): Promise<void>;
};

async function fakeAgent(name: string): Promise<FakeAgent> {
  const agent: FakeAgent = {
    name,
    token: (name === "nas" ? "a" : "b").repeat(32),
    url: "",
    maintenance: maintenanceSnapshot(),
    deployments: deploymentsSnapshot(),
    failMaintenance: false,
    failDeployments: false,
    requests: [],
    reset() {
      agent.maintenance = maintenanceSnapshot();
      agent.deployments = deploymentsSnapshot();
      agent.failMaintenance = false;
      agent.failDeployments = false;
      agent.requests = [];
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const server: Server = createServer(async (request, response) => {
    request.resume();
    const path = new URL(request.url ?? "/", "http://agent").pathname;
    agent.requests.push(path);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${agent.token}`)
      return send(401, { error: "No autorizado" });
    if (path === "/metrics") return send(200, metricsSnapshot());
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

describe.skipIf(!baseUrl)("collector maintenance alerts", () => {
  let context: TestDatabase;
  let nas: FakeAgent;
  let apps: FakeAgent;
  let collectAll: typeof import("@/lib/collector").collectAll;
  let getHosts: typeof import("@/lib/hosts").getHosts;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");

  async function collect(now: number) {
    await collectAll(getHosts(), now);
  }

  beforeAll(async () => {
    nas = await fakeAgent("nas");
    apps = await fakeAgent("apps");
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: nas.url,
        token: nas.token,
      },
      {
        id: "apps",
        name: "Apps",
        role: "apps-server",
        url: apps.url,
        token: apps.token,
      },
    ]);
    context = await createTestDatabase(baseUrl!);
    process.env.DATABASE_URL = context.url;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const database = await import("@/lib/db");
    db = database.db;
    pool = database.pool;
    await migrate(db, { migrationsFolder: "./drizzle" });
    ({ collectAll } = await import("@/lib/collector"));
    ({ getHosts } = await import("@/lib/hosts"));
    tables = await import("@/lib/schema");
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await nas.close();
    await apps.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(async () => {
    await db.delete(tables.alerts);
    await db.delete(tables.operations);
    await db.delete(tables.samples);
    await db.delete(tables.configuration);
    nas.reset();
    apps.reset();
    push.notify.mockClear();
  });

  function failingMaintenance() {
    return maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
      disks: {
        available: true,
        devices: [
          {
            ...maintenanceSnapshot().disks.devices[0],
            status: "watch",
            issues: ["wear"],
          },
        ],
      },
      reboot: { available: true, required: true },
      failedUnits: {
        stack: [{ name: "media-stack-upgrade.service", description: null }],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });
  }

  function failingDeployments() {
    return deploymentsSnapshot({
      follower: {
        ...deploymentsSnapshot().follower,
        state: "failed",
        failed: { release: "v2.5.0", since: "2026-11-13T02:00:00Z" },
      },
      history: [
        {
          release: "v2.5.0",
          outcome: "rolled-back",
          at: "2026-11-13T02:00:00Z",
          previousRelease: "v2.4.1",
          services: ["radarr"],
        },
      ],
      retained: [
        {
          release: "v2.5.0",
          reason: "missing-configuration",
          blockedBy: null,
          breaking: false,
          manualSteps: [],
          missingSettings: ["NEW_SETTING"],
          secretSettings: [],
          services: ["radarr"],
          sourceCommit: null,
          at: "2026-11-13T02:00:00Z",
        },
      ],
    });
  }

  function recoveredDeployments() {
    return deploymentsSnapshot({
      follower: {
        ...deploymentsSnapshot().follower,
        state: "failed",
        failed: { release: "v2.5.0", since: "2026-11-13T02:00:00Z" },
      },
      history: [
        {
          release: "v2.5.1",
          outcome: "success",
          at: "2026-11-13T04:00:00Z",
          previousRelease: "v2.4.1",
          services: ["radarr"],
        },
      ],
    });
  }

  const alertKeys = [
    "backup-failed",
    "disk-health",
    "reboot-pending",
    "stack-unit-failed",
    "release-retained",
    "deploy-failed",
  ];

  it("opens each alert type once and resolves it once when the host recovers", async () => {
    const start = Date.UTC(2026, 10, 13, 10);
    nas.maintenance = failingMaintenance();
    nas.deployments = failingDeployments();

    await collect(start);
    let rows = await db.select().from(tables.alerts);
    expect(rows.map((row) => row.key).sort()).toEqual([...alertKeys].sort());
    expect(rows.every((row) => row.resolvedAt === null)).toBe(true);
    expect(push.notify).toHaveBeenCalledTimes(6);
    expect(rows.every((row) => row.hostId === "nas-home")).toBe(true);
    const tags = push.notify.mock.calls.map((call) => call[2]);
    expect(new Set(tags)).toEqual(
      new Set(alertKeys.map((key) => `nas-home:${key}`)),
    );

    await collect(start + 61_000);
    rows = await db.select().from(tables.alerts);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.resolvedAt === null)).toBe(true);
    expect(push.notify).toHaveBeenCalledTimes(6);

    nas.maintenance = maintenanceSnapshot();
    nas.deployments = recoveredDeployments();
    await collect(start + 122_000);
    rows = await db.select().from(tables.alerts);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.resolvedAt !== null)).toBe(true);
    expect(push.notify).toHaveBeenCalledTimes(12);
    const recoveryTags = push.notify.mock.calls
      .slice(6)
      .map((call) => call[2]);
    expect(new Set(recoveryTags)).toEqual(
      new Set(alertKeys.map((key) => `nas-home:${key}-resolved`)),
    );

    await collect(start + 183_000);
    expect(push.notify).toHaveBeenCalledTimes(12);
    expect(await db.select().from(tables.alerts)).toHaveLength(6);
  });

  it("never resolves an alert while the snapshot is absent or degraded", async () => {
    const start = Date.UTC(2026, 10, 14, 10);
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });

    await collect(start);
    expect(
      (await db.select().from(tables.alerts)).filter(
        (row) => row.resolvedAt === null,
      ),
    ).toHaveLength(1);

    nas.failMaintenance = true;
    nas.failDeployments = true;
    await collect(start + 61_000);
    expect(
      (await db.select().from(tables.alerts)).filter(
        (row) => row.resolvedAt === null,
      ),
    ).toHaveLength(1);
    expect(push.notify).toHaveBeenCalledTimes(1);

    nas.failMaintenance = false;
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "ok", at: "2026-11-13T03:00:00Z" },
      degraded: ["backup"],
    });
    await collect(start + 122_000);
    expect(
      (await db.select().from(tables.alerts)).filter(
        (row) => row.resolvedAt === null,
      ),
    ).toHaveLength(1);
    expect(push.notify).toHaveBeenCalledTimes(1);

    nas.maintenance = maintenanceSnapshot();
    await collect(start + 183_000);
    expect(
      (await db.select().from(tables.alerts)).filter(
        (row) => row.resolvedAt === null,
      ),
    ).toHaveLength(0);
    expect(push.notify).toHaveBeenCalledTimes(2);

    await collect(start + 244_000);
    expect(push.notify).toHaveBeenCalledTimes(2);
  });

  it("keeps two hosts independent across recovery and repetition", async () => {
    const start = Date.UTC(2026, 10, 15, 10);
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });

    await collect(start);
    let rows = await db.select().from(tables.alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostId: "nas-home", key: "backup-failed" });

    apps.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });
    await collect(start + 61_000);
    rows = await db.select().from(tables.alerts);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.hostId).sort()).toEqual(["apps", "nas-home"]);
    expect(rows.every((row) => row.resolvedAt === null)).toBe(true);

    nas.maintenance = maintenanceSnapshot();
    await collect(start + 122_000);
    rows = await db.select().from(tables.alerts);
    const nasRow = rows.find((row) => row.hostId === "nas-home")!;
    const appsRow = rows.find((row) => row.hostId === "apps")!;
    expect(nasRow.resolvedAt).not.toBeNull();
    expect(appsRow.resolvedAt).toBeNull();
    expect(push.notify).toHaveBeenCalledTimes(3);
    const tags = push.notify.mock.calls.map((call) => call[2]);
    expect(tags).toContain("nas-home:backup-failed");
    expect(tags).toContain("apps:backup-failed");
    expect(tags).toContain("nas-home:backup-failed-resolved");

    await collect(start + 183_000);
    rows = await db.select().from(tables.alerts);
    expect(rows.find((row) => row.hostId === "apps")!.resolvedAt).toBeNull();
    expect(push.notify).toHaveBeenCalledTimes(3);
  });

  it("never turns a foreign failed unit into a stack alert", async () => {
    const start = Date.UTC(2026, 10, 16, 10);
    nas.maintenance = maintenanceSnapshot({
      failedUnits: {
        stack: [],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });

    await collect(start);
    expect(await db.select().from(tables.alerts)).toHaveLength(0);
    expect(push.notify).not.toHaveBeenCalled();

    nas.maintenance = maintenanceSnapshot({
      failedUnits: {
        stack: [{ name: "media-stack-evidence.service", description: null }],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });
    await collect(start + 61_000);
    const rows = await db.select().from(tables.alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("stack-unit-failed");
    expect(rows[0].detail).toContain("media-stack-evidence.service");
    expect(rows[0].detail).not.toContain("logrotate.service");

    nas.maintenance = maintenanceSnapshot({
      failedUnits: {
        stack: [],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });
    await collect(start + 122_000);
    expect(
      (await db.select().from(tables.alerts)).filter(
        (row) => row.resolvedAt === null,
      ),
    ).toHaveLength(0);
    expect(push.notify).toHaveBeenCalledTimes(2);
  });
});
