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

describe.skipIf(!baseUrl)("collector incident store", () => {
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

  async function state() {
    return {
      incidents: await db
        .select()
        .from(tables.incidents)
        .orderBy(tables.incidents.id),
      events: await db.select().from(tables.incidentEvents),
      outbox: await db.select().from(tables.notificationOutbox),
    };
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
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
    await db.delete(tables.operations);
    await db.delete(tables.samples);
    await db.delete(tables.configuration);
    nas.reset();
    apps.reset();
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
  const immediateKeys = new Set([
    "backup-failed",
    "stack-unit-failed",
    "deploy-failed",
  ]);

  it("persists one episode, one timeline and one logical notice per condition", async () => {
    const start = Date.UTC(2026, 10, 13, 10);
    nas.maintenance = failingMaintenance();
    nas.deployments = failingDeployments();

    await collect(start);
    let current = await state();
    expect(current.incidents.map((row) => row.key).sort()).toEqual(
      [...alertKeys].sort(),
    );
    expect(current.incidents.every((row) => row.resolvedAt === null)).toBe(true);
    expect(current.incidents.every((row) => row.hostId === "nas-home")).toBe(
      true,
    );
    expect(current.incidents.every((row) => row.seq === 1)).toBe(true);
    expect(current.incidents.every((row) => row.origin === "live")).toBe(true);
    expect(current.events).toHaveLength(6);
    expect(current.events.every((event) => event.kind === "opened")).toBe(true);
    expect(current.outbox).toHaveLength(6);
    for (const incident of current.incidents) {
      const notice = current.outbox.find(
        (row) => row.incidentId === incident.id,
      )!;
      expect(notice.key).toBe(`incident:${incident.id}:open`);
      expect(notice.kind).toBe("incident-open");
      expect(notice.revision).toBe(1);
      if (immediateKeys.has(incident.key)) {
        expect(notice).toMatchObject({ channel: "telegram", status: "pending" });
      } else {
        expect(notice).toMatchObject({ channel: "digest", status: "suppressed" });
        expect(notice.result).toMatchObject({ reason: "digest_pending" });
      }
    }

    await collect(start + 61_000);
    current = await state();
    expect(current.incidents).toHaveLength(6);
    expect(current.incidents.every((row) => row.resolvedAt === null)).toBe(true);
    expect(current.events).toHaveLength(6);
    expect(current.outbox).toHaveLength(6);

    nas.maintenance = maintenanceSnapshot();
    nas.deployments = recoveredDeployments();
    await collect(start + 122_000);
    current = await state();
    expect(current.incidents).toHaveLength(6);
    expect(current.incidents.every((row) => row.resolvedAt !== null)).toBe(true);
    expect(current.incidents.every((row) => row.seq === 2)).toBe(true);
    expect(current.incidents.every((row) => row.closedBy === "collector")).toBe(
      true,
    );
    expect(current.events).toHaveLength(12);
    expect(current.events.filter((event) => event.kind === "closed")).toHaveLength(
      6,
    );
    expect(current.outbox).toHaveLength(6);
    for (const notice of current.outbox) {
      expect(notice.kind).toBe("incident-open");
      expect(notice.status).toBe("suppressed");
      if (notice.channel === "telegram") {
        expect(notice.result).toMatchObject({ reason: "resolved_before_send" });
      }
    }

    await collect(start + 183_000);
    expect(await db.select().from(tables.incidentEvents)).toHaveLength(12);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(6);
  });

  it("never resolves an episode while the snapshot is absent or degraded", async () => {
    const start = Date.UTC(2026, 10, 14, 10);
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });

    await collect(start);
    let current = await state();
    expect(
      current.incidents.filter((row) => row.resolvedAt === null),
    ).toHaveLength(1);
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({ channel: "telegram", status: "pending" });

    nas.failMaintenance = true;
    nas.failDeployments = true;
    await collect(start + 61_000);
    current = await state();
    expect(
      current.incidents.filter((row) => row.resolvedAt === null),
    ).toHaveLength(1);
    expect(current.events).toHaveLength(1);
    expect(current.outbox).toHaveLength(1);

    nas.failMaintenance = false;
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "ok", at: "2026-11-13T03:00:00Z" },
      degraded: ["backup"],
    });
    await collect(start + 122_000);
    current = await state();
    expect(
      current.incidents.filter((row) => row.resolvedAt === null),
    ).toHaveLength(1);
    expect(current.outbox[0].status).toBe("pending");

    nas.maintenance = maintenanceSnapshot();
    await collect(start + 183_000);
    current = await state();
    expect(
      current.incidents.filter((row) => row.resolvedAt === null),
    ).toHaveLength(0);
    expect(current.incidents[0].seq).toBe(2);
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      status: "suppressed",
      result: expect.objectContaining({ reason: "resolved_before_send" }),
    });

    await collect(start + 244_000);
    expect(await db.select().from(tables.incidentEvents)).toHaveLength(2);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(1);
  });

  it("keeps two hosts independent across recovery and repetition", async () => {
    const start = Date.UTC(2026, 10, 15, 10);
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });

    await collect(start);
    let current = await state();
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0]).toMatchObject({
      hostId: "nas-home",
      key: "backup-failed",
    });

    apps.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents).toHaveLength(2);
    expect(current.incidents.map((row) => row.hostId).sort()).toEqual([
      "apps",
      "nas-home",
    ]);
    expect(current.incidents.every((row) => row.resolvedAt === null)).toBe(true);
    expect(current.outbox).toHaveLength(2);

    nas.maintenance = maintenanceSnapshot();
    await collect(start + 122_000);
    current = await state();
    const nasRow = current.incidents.find((row) => row.hostId === "nas-home")!;
    const appsRow = current.incidents.find((row) => row.hostId === "apps")!;
    expect(nasRow.resolvedAt).not.toBeNull();
    expect(nasRow.seq).toBe(2);
    expect(appsRow.resolvedAt).toBeNull();
    expect(appsRow.seq).toBe(1);
    expect(current.outbox).toHaveLength(2);
    expect(
      current.outbox.find((row) => row.incidentId === nasRow.id),
    ).toMatchObject({
      status: "suppressed",
      result: expect.objectContaining({ reason: "resolved_before_send" }),
    });
    expect(
      current.outbox.find((row) => row.incidentId === appsRow.id),
    ).toMatchObject({ status: "pending" });

    await collect(start + 183_000);
    current = await state();
    expect(current.incidents.find((row) => row.hostId === "apps")!.resolvedAt).toBeNull();
    expect(current.events).toHaveLength(3);
    expect(current.outbox).toHaveLength(2);
  });

  it("never turns a foreign failed unit into a stack incident", async () => {
    const start = Date.UTC(2026, 10, 16, 10);
    nas.maintenance = maintenanceSnapshot({
      failedUnits: {
        stack: [],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });

    await collect(start);
    expect(await db.select().from(tables.incidents)).toHaveLength(0);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(0);

    nas.maintenance = maintenanceSnapshot({
      failedUnits: {
        stack: [{ name: "media-stack-evidence.service", description: null }],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });
    await collect(start + 61_000);
    let current = await state();
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0].key).toBe("stack-unit-failed");
    expect(current.incidents[0].detail).toContain("media-stack-evidence.service");
    expect(current.incidents[0].detail).not.toContain("logrotate.service");
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({ channel: "telegram", status: "pending" });

    nas.maintenance = maintenanceSnapshot({
      failedUnits: {
        stack: [],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });
    await collect(start + 122_000);
    current = await state();
    expect(
      current.incidents.filter((row) => row.resolvedAt === null),
    ).toHaveLength(0);
    expect(current.events).toHaveLength(2);
    expect(current.outbox).toHaveLength(1);
  });

  it("reuses the open episode when the collector module is recreated", async () => {
    const start = Date.UTC(2026, 10, 17, 10);
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });

    await collect(start);
    const before = await state();
    expect(before.incidents).toHaveLength(1);
    const incidentId = before.incidents[0].id;

    vi.resetModules();
    const recreated = await import("@/lib/collector");
    await recreated.collectAll(getHosts(), start + 1_000);

    const after = await state();
    expect(after.incidents).toHaveLength(1);
    expect(after.incidents[0].id).toBe(incidentId);
    expect(after.incidents[0].seq).toBe(1);
    expect(after.events).toHaveLength(1);
    expect(after.outbox).toHaveLength(1);
    expect(after.outbox[0].key).toBe(`incident:${incidentId}:open`);
    expect(after.outbox[0].status).toBe("pending");
  });
});
