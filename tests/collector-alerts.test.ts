import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { deploymentsSnapshot, maintenanceSnapshot, metricsSnapshot } from "./host-fixtures";
import { AGENT_RESPONSE_LIMITS } from "@/lib/nas";
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { TelegramTransport } from "@/lib/telegram";

type AgentState = {
  maintenance: unknown;
  deployments: unknown;
  metrics: unknown;
  rawMetrics: string | null;
  failMetrics: boolean;
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
    metrics: metricsSnapshot(),
    rawMetrics: null,
    failMetrics: false,
    failMaintenance: false,
    failDeployments: false,
    requests: [],
    reset() {
      agent.maintenance = maintenanceSnapshot();
      agent.deployments = deploymentsSnapshot();
      agent.metrics = metricsSnapshot();
      agent.rawMetrics = null;
      agent.failMetrics = false;
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
    if (path === "/metrics") {
      if (agent.failMetrics) return send(503, { error: "El host no responde" });
      if (agent.rawMetrics !== null) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(agent.rawMetrics);
        return;
      }
      return send(200, agent.metrics);
    }
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
  let collectHost: typeof import("@/lib/collector").collectHost;
  let getHosts: typeof import("@/lib/hosts").getHosts;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");

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

  function containerOf(name: string, state: string) {
    return {
      ...metricsSnapshot().containers[0],
      name,
      state,
      status: state === "running" ? "Up 1 hour" : "Exited (0)",
    };
  }

  async function openContainer(hostId: string, name: string, now: number) {
    const opened = await store.recordIncidentObservation({
      hostId,
      key: `container:${name}`,
      failing: true,
      severity: "warning",
      title: `Servicio detenido en ${hostId}: ${name}`,
      detail: "El servicio estaba previsto en ejecución y no está disponible.",
      now,
      delivery: { channel: "silent", reason: "policy_silent" },
    });
    return opened.incidentId!;
  }

  async function setSettings(
    hostId: string,
    overrides: Partial<import("@/lib/types").Settings>,
  ) {
    const { defaults } = await import("@/lib/settings");
    await db.insert(tables.configuration).values({
      hostId,
      id: "settings",
      value: { ...defaults, initialized: true, ...overrides },
    });
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
    ({ collectAll, collectHost } = await import("@/lib/collector"));
    ({ getHosts } = await import("@/lib/hosts"));
    tables = await import("@/lib/schema");
    store = await import("@/lib/incident-store");
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

  function diskMaintenance(status: "ok" | "watch" | "fail") {
    const base = maintenanceSnapshot();
    return maintenanceSnapshot({
      disks: {
        available: true,
        devices: [
          {
            ...base.disks.devices[0],
            status,
            issues: status === "ok" ? [] : ["smart"],
          },
        ],
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

  it("persists a valid sample and ignores a malformed 200 without touching incidents", async () => {
    const start = Date.UTC(2026, 10, 18, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", { temperature: 50 });
    nas.metrics = metricsSnapshot({
      temperatures: [{ name: "CPU", value: 90 }],
    });

    await collectHost(host, start);
    await collectHost(host, start + 31_000);
    const current = await state();
    expect(await db.select().from(tables.samples)).toHaveLength(2);
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0]).toMatchObject({
      key: "temperature",
      severity: "critical",
      seq: 1,
      resolvedAt: null,
    });
    const incidentId = current.incidents[0].id;
    expect(current.events).toHaveLength(1);
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      incidentId,
      channel: "telegram",
      status: "pending",
    });

    const before = await state();
    nas.rawMetrics = '{"timestamp":';
    await collectHost(host, start + 62_000);
    expect(await db.select().from(tables.samples)).toHaveLength(2);
    const after = await state();
    expect(after).toEqual(before);
    expect(after.incidents).toHaveLength(1);
    expect(after.incidents[0]).toMatchObject({
      id: incidentId,
      resolvedAt: null,
      seq: 1,
    });
    expect(after.incidents.some((row) => row.key === "connection")).toBe(false);
  });

  it("keeps CPU and temperature episodes open when the sample has no measurement", async () => {
    const start = Date.UTC(2026, 10, 19, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", {
      cpu: 10,
      temperature: 50,
      sustainedSeconds: 0,
    });
    nas.metrics = metricsSnapshot({
      cpu: 50,
      temperatures: [{ name: "CPU", value: 90 }],
    });

    await collectHost(host, start);
    await collectHost(host, start + 31_000);
    let current = await state();
    expect(current.incidents.map((row) => row.key).sort()).toEqual([
      "cpu",
      "temperature",
    ]);
    expect(current.incidents.every((row) => row.resolvedAt === null)).toBe(
      true,
    );
    const eventsBefore = current.events.length;
    const outboxBefore = current.outbox.length;

    nas.metrics = metricsSnapshot({ cpu: null, temperatures: [] });
    await collectHost(host, start + 62_000);
    current = await state();
    expect(current.incidents).toHaveLength(2);
    expect(current.incidents.every((row) => row.resolvedAt === null)).toBe(
      true,
    );
    expect(current.incidents.every((row) => row.seq === 1)).toBe(true);
    expect(current.events).toHaveLength(eventsBefore);
    expect(current.outbox).toHaveLength(outboxBefore);
    expect(await db.select().from(tables.samples)).toHaveLength(3);
  });

  it("treats a wrong shape in a 200 as a contract failure, not a disconnect", async () => {
    const start = Date.UTC(2026, 10, 20, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    nas.metrics = metricsSnapshot({ memory: { total: 0, used: 0 } });

    await collectHost(host, start);

    expect(await db.select().from(tables.samples)).toHaveLength(0);
    expect(await db.select().from(tables.incidents)).toHaveLength(0);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(0);
  });

  it("treats a metrics answer over its cap as a contract failure, not a disconnect", async () => {
    const start = Date.UTC(2026, 10, 20, 11);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const open = await openContainer("nas-home", "sonarr", start - 60_000);
    const before = await state();
    nas.rawMetrics = "x".repeat(AGENT_RESPONSE_LIMITS.metrics + 1);

    await collectHost(host, start);
    await collectHost(host, start + 61_000);
    await collectHost(host, start + 122_000);

    const after = await state();
    expect(await db.select().from(tables.samples)).toHaveLength(0);
    expect(after.incidents.map((row) => row.key)).toEqual(["container:sonarr"]);
    expect(after.incidents[0]).toMatchObject({ id: open, resolvedAt: null });
    expect(after.events).toHaveLength(before.events.length);
    expect(after.outbox).toHaveLength(before.outbox.length);
  });

  it("keeps the disconnect policy and the planned-reboot grace on real failures", async () => {
    const start = Date.UTC(2026, 10, 21, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await db.insert(tables.operations).values({
      id: "reboot-grace",
      hostId: "nas-home",
      userId: "test-user",
      action: "reboot",
      target: "NAS-HOME",
      status: "pending",
      at: new Date(start - 60_000),
    });
    nas.failMetrics = true;

    await collectHost(host, start);
    await collectHost(host, start + 61_000);
    let current = await state();
    expect(current.incidents).toEqual([]);
    expect(current.outbox).toEqual([]);

    await db.delete(tables.operations);
    await collectHost(host, start + 122_000);
    await collectHost(host, start + 183_000);
    current = await state();
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0]).toMatchObject({
      key: "connection",
      severity: "critical",
    });
    expect(current.outbox).toHaveLength(1);
  });

  it("escalates disk-health from watch to fail in the same episode", async () => {
    const start = Date.UTC(2026, 10, 22, 10);
    nas.maintenance = diskMaintenance("watch");

    await collect(start);
    let current = await state();
    expect(current.incidents).toHaveLength(1);
    const incident = current.incidents[0];
    expect(incident).toMatchObject({
      key: "disk-health",
      severity: "warning",
      seq: 1,
      resolvedAt: null,
    });
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      incidentId: incident.id,
      channel: "digest",
      status: "suppressed",
      revision: 1,
    });
    expect(current.outbox[0].result).toMatchObject({ reason: "digest_pending" });

    nas.maintenance = diskMaintenance("fail");
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0]).toMatchObject({
      id: incident.id,
      severity: "critical",
      seq: 2,
      resolvedAt: null,
    });
    expect(current.events.find((event) => event.seq === 2)).toMatchObject({
      kind: "severity",
      severity: "critical",
    });
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      incidentId: incident.id,
      channel: "telegram",
      status: "pending",
      revision: 2,
      result: null,
    });
    expect(current.outbox[0].claimToken).toBeNull();
    expect(current.outbox[0].leaseUntil).toBeNull();
  });

  it("cancels a pending immediate opening when disk-health drops to watch before the send", async () => {
    const start = Date.UTC(2026, 10, 23, 10);
    nas.maintenance = diskMaintenance("fail");

    await collect(start);
    let current = await state();
    const incident = current.incidents[0];
    expect(incident).toMatchObject({
      key: "disk-health",
      severity: "critical",
      seq: 1,
    });
    expect(current.outbox[0]).toMatchObject({
      channel: "telegram",
      status: "pending",
    });

    nas.maintenance = diskMaintenance("watch");
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0]).toMatchObject({
      id: incident.id,
      severity: "warning",
      seq: 2,
    });
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      incidentId: incident.id,
      channel: "digest",
      status: "suppressed",
      revision: 2,
    });
    expect(current.outbox[0].result).toMatchObject({ reason: "digest_pending" });
  });

  it("uses push for eligible warnings and keeps a committed push channel", async () => {
    const start = Date.UTC(2026, 10, 24, 10);
    const previous = process.env.PUSH_WARNINGS;
    process.env.PUSH_WARNINGS = "true";
    try {
      nas.maintenance = diskMaintenance("watch");
      await collect(start);
      let current = await state();
      const incident = current.incidents.find(
        (row) => row.key === "disk-health",
      )!;
      expect(incident).toMatchObject({ severity: "warning", seq: 1 });
      expect(current.outbox).toHaveLength(1);
      const noticeId = current.outbox[0].id;
      expect(current.outbox[0]).toMatchObject({
        incidentId: incident.id,
        channel: "push",
        status: "pending",
      });

      await db
        .update(tables.notificationOutbox)
        .set({
          status: "sent",
          attempts: 1,
          result: {
            state: "sent",
            reason: null,
            at: new Date(start + 1_000).toISOString(),
          },
        })
        .where(eq(tables.notificationOutbox.id, noticeId));

      nas.maintenance = diskMaintenance("fail");
      await collect(start + 61_000);
      current = await state();
      expect(current.incidents[0]).toMatchObject({
        id: incident.id,
        severity: "critical",
        seq: 2,
      });
      expect(current.outbox).toHaveLength(1);
      expect(current.outbox[0]).toMatchObject({
        id: noticeId,
        channel: "push",
        status: "sent",
      });
      expect(current.outbox.some((row) => row.channel === "telegram")).toBe(
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.PUSH_WARNINGS;
      else process.env.PUSH_WARNINGS = previous;
    }
  });

  it("keeps a container condition visible without delivery", async () => {
    const start = Date.UTC(2026, 10, 25, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", { expectedContainers: ["nas-service"] });
    // Absence never opens an episode (D-06); a present but stopped container
    // keeps the existing 30-second failure threshold (D-05).
    nas.metrics = metricsSnapshot({
      containers: [containerOf("nas-service", "exited")],
    });

    await collectHost(host, start);
    await collectHost(host, start + 31_000);
    const current = await state();
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0]).toMatchObject({
      key: "container:nas-service",
      severity: "warning",
      seq: 1,
    });
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      channel: "silent",
      status: "suppressed",
    });
    expect(current.outbox[0].result).toMatchObject({ reason: "policy_silent" });
  });

  it("accredits an absent name only across consecutive fresh complete lists", async () => {
    const start = Date.UTC(2026, 9, 25, 11);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", {
      cpu: 200,
      memory: 200,
      disk: 100,
      temperature: 200,
      sustainedSeconds: 0,
      expectedContainers: ["gone"],
    });
    const { currentWatchWorkerId } = await import("@/lib/container-watch");
    const at = (seconds: number) =>
      metricsSnapshot({
        timestamp: start / 1000 + seconds,
        containersObservedAt: start / 1000 + seconds,
        containers: [containerOf("other", "running")],
      });
    const watchState = async () => {
      const [row] = await db
        .select()
        .from(tables.configuration)
        .where(eq(tables.configuration.hostId, "nas-home"));
      return row.value.watch!;
    };

    nas.metrics = at(0);
    await collectHost(host, start);
    const current = await state();
    expect(current.incidents).toHaveLength(0);
    let watch = await watchState();
    expect(watch.entries.gone).toMatchObject({
      absentSince: start / 1000,
      observedAt: start / 1000,
      accreditedMs: 0,
    });

    // Repeating the same Docker list is not a new observation.
    nas.metrics = at(0);
    await collectHost(host, start + 10_000);
    expect((await watchState()).entries.gone.accreditedMs).toBe(0);

    nas.metrics = at(30);
    await collectHost(host, start + 30_000);
    expect((await watchState()).entries.gone.accreditedMs).toBe(30_000);

    // A genuinely empty list is complete evidence and keeps accrediting.
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000 + 60,
      containersObservedAt: start / 1000 + 60,
      containers: [],
    });
    await collectHost(host, start + 60_000);
    expect((await watchState()).entries.gone.accreditedMs).toBe(60_000);

    // An older agent has no list date: it never adds absence time.
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000 + 90,
      containers: [],
    });
    await collectHost(host, start + 90_000);
    expect((await watchState()).entries.gone.accreditedMs).toBe(60_000);

    nas.metrics = at(95);
    await collectHost(host, start + 95_000);
    expect((await watchState()).entries.gone.accreditedMs).toBe(60_000);

    // A contract failure breaks the chain without losing accredited time.
    nas.rawMetrics = '{"timestamp":';
    await collectHost(host, start + 100_000);
    nas.rawMetrics = null;
    nas.metrics = at(150);
    await collectHost(host, start + 150_000);
    expect((await watchState()).entries.gone.accreditedMs).toBe(60_000);

    // A transport failure breaks the chain too: the next list is not a
    // continuation of the interval it missed.
    nas.failMetrics = true;
    await collectHost(host, start + 160_000);
    nas.failMetrics = false;
    nas.metrics = at(190);
    await collectHost(host, start + 190_000);
    expect((await watchState()).entries.gone.accreditedMs).toBe(60_000);

    // A worker restart also starts a new chain from its first fresh list: the
    // durable worker marker no longer matches the interval that preceded it.
    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    await db
      .update(tables.configuration)
      .set({
        value: {
          ...row.value,
          watch: { ...row.value.watch!, workerId: "restarted-worker" },
        },
      })
      .where(eq(tables.configuration.hostId, "nas-home"));
    nas.metrics = at(220);
    await collectHost(host, start + 220_000);
    watch = await watchState();
    expect(watch.entries.gone.accreditedMs).toBe(60_000);
    expect(watch.workerId).toBe(currentWatchWorkerId());
    expect(current.incidents).toHaveLength(0);
  });

  it("retires an absent name after thirty accredited minutes and closes its episode", async () => {
    const start = Date.UTC(2026, 9, 25, 12);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const { WATCH_THRESHOLD_MS, currentWatchWorkerId } = await import(
      "@/lib/container-watch"
    );
    const incidentId = await openContainer("nas-home", "gone", start - 60_000);
    const lastMark = start / 1000 - 30;
    await setSettings("nas-home", {
      cpu: 200,
      memory: 200,
      disk: 100,
      temperature: 200,
      sustainedSeconds: 0,
      expectedContainers: ["gone"],
      watch: {
        revision: 1,
        workerId: currentWatchWorkerId(),
        lastInventoryAt: lastMark,
        chainAt: lastMark,
        entries: {
          gone: {
            identity: {
              containerId: "d".repeat(64),
              composeProject: null,
              composeService: null,
            },
            absentSince: (start - 30 * 60_000) / 1000,
            observedAt: lastMark,
            accreditedMs: WATCH_THRESHOLD_MS - 30_000,
          },
        },
        identities: {},
      },
    });
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [containerOf("other", "running")],
    });

    await collectHost(host, start);

    const rows = await db.select().from(tables.incidents);
    const closed = rows.find((row) => row.id === incidentId)!;
    expect(closed).toMatchObject({
      id: incidentId,
      key: "container:gone",
      resolvedAt: expect.any(Date),
      closedBy: "reconciliation",
    });
    expect(
      (await db.select().from(tables.incidentEvents)).filter(
        (event) => event.incidentId === incidentId,
      ),
    ).toMatchObject([
      { kind: "opened" },
      { kind: "closed", seq: 2 },
    ]);
    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual([]);
    expect(row.value.watch!.entries.gone).toBeUndefined();
    // The original delivery is preserved: no recovery message is created.
    expect(
      (await db.select().from(tables.notificationOutbox)).filter(
        (notice) => notice.incidentId === incidentId,
      ),
    ).toHaveLength(1);
  });

  it("keeps the watch when the name reappears before the window expires", async () => {
    const start = Date.UTC(2026, 9, 25, 13);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const { currentWatchWorkerId } = await import("@/lib/container-watch");
    const lastMark = start / 1000 - 30;
    await setSettings("nas-home", {
      cpu: 200,
      memory: 200,
      disk: 100,
      temperature: 200,
      sustainedSeconds: 0,
      expectedContainers: ["gone"],
      watch: {
        revision: 1,
        workerId: currentWatchWorkerId(),
        lastInventoryAt: lastMark,
        chainAt: lastMark,
        entries: {
          gone: {
            identity: {
              containerId: "e".repeat(64),
              composeProject: "media-stack",
              composeService: "gone",
            },
            absentSince: lastMark,
            observedAt: lastMark,
            accreditedMs: 10 * 60_000,
          },
        },
        identities: {},
      },
    });
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [containerOf("gone", "running")],
    });

    await collectHost(host, start);

    expect(await db.select().from(tables.incidents)).toHaveLength(0);
    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual(["gone"]);
    expect(row.value.watch!.entries.gone).toBeUndefined();
    expect(row.value.watch!.identities.gone).toMatchObject({
      containerId: "c".repeat(64),
    });
  });

  it("ignores a repeated or older Docker list for the watch window", async () => {
    const start = Date.UTC(2026, 9, 25, 14);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const { WATCH_THRESHOLD_MS, currentWatchWorkerId } = await import(
      "@/lib/container-watch"
    );
    const lastMark = start / 1000;
    await setSettings("nas-home", {
      cpu: 200,
      memory: 200,
      disk: 100,
      temperature: 200,
      sustainedSeconds: 0,
      expectedContainers: ["gone"],
      watch: {
        revision: 1,
        workerId: currentWatchWorkerId(),
        lastInventoryAt: lastMark,
        chainAt: lastMark,
        entries: {
          gone: {
            identity: {
              containerId: "f".repeat(64),
              composeProject: null,
              composeService: null,
            },
            absentSince: lastMark,
            observedAt: lastMark,
            accreditedMs: WATCH_THRESHOLD_MS - 30_000,
          },
        },
        identities: {},
      },
    });
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: lastMark - 10,
      containers: [],
    });

    await collectHost(host, start + 30_000);

    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual(["gone"]);
    expect(row.value.watch!.entries.gone.accreditedMs).toBe(
      WATCH_THRESHOLD_MS - 30_000,
    );
    expect(await db.select().from(tables.incidents)).toHaveLength(0);
  });

  it("restarts the failure window when a stopped name reappears after absence", async () => {
    const start = Date.UTC(2026, 9, 25, 14, 30);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", {
      cpu: 200,
      memory: 200,
      disk: 100,
      temperature: 200,
      sustainedSeconds: 0,
      expectedContainers: ["svc"],
    });
    const at = (seconds: number, containers: unknown[]) =>
      metricsSnapshot({
        timestamp: start / 1000 + seconds,
        containersObservedAt: start / 1000 + seconds,
        containers,
      });
    const stopped = containerOf("svc", "exited");

    nas.metrics = at(0, [stopped]);
    await collectHost(host, start);
    nas.metrics = at(20, [stopped]);
    await collectHost(host, start + 20_000);
    expect(await db.select().from(tables.incidents)).toHaveLength(0);

    // The name disappears before the window completes and starts a watch.
    nas.metrics = at(30, []);
    await collectHost(host, start + 30_000);
    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.watch!.entries.svc).toMatchObject({ accreditedMs: 0 });

    // Reappearing stopped starts a fresh 30-second window from this reading.
    nas.metrics = at(40, [stopped]);
    await collectHost(host, start + 40_000);
    nas.metrics = at(60, [stopped]);
    await collectHost(host, start + 60_000);
    expect(await db.select().from(tables.incidents)).toHaveLength(0);

    nas.metrics = at(70, [stopped]);
    await collectHost(host, start + 70_000);
    const incidents = await db.select().from(tables.incidents);
    expect(incidents).toMatchObject([
      {
        key: "container:svc",
        resolvedAt: null,
        seq: 1,
      },
    ]);
  });

  async function setWatchSettings(
    hostId: string,
    expected: string[],
    identities: Record<string, import("@/lib/types").ContainerIdentity>,
    entries: Record<string, import("@/lib/types").ContainerWatchEntry> = {},
    mark = Date.now() / 1000,
  ) {
    const { currentWatchWorkerId } = await import("@/lib/container-watch");
    await setSettings(hostId, {
      expectedContainers: expected,
      watch: {
        revision: 1,
        workerId: currentWatchWorkerId(),
        lastInventoryAt: mark,
        chainAt: mark,
        entries,
        identities,
      },
    });
  }

  it("records the first absence of a watched container named constructor", async () => {
    const start = Date.UTC(2026, 9, 25, 14);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setWatchSettings(host.id, ["constructor"], {}, {}, start / 1000 - 10);
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [],
    });
    await collectHost(host, start);

    const { getSettings } = await import("@/lib/settings");
    const { pendingWatch } = await import("@/lib/container-watch");
    const settings = await getSettings(host.id);
    expect(pendingWatch(settings)).toMatchObject([
      { name: "constructor", absentSince: start / 1000, accreditedMs: 0 },
    ]);
    settings.watch!.entries["constructor"].absentSince = 1e20;
    expect(pendingWatch(settings)).toEqual([]);
  });

  it("transfers the watch when the replacement appears at the absence threshold", async () => {
    const start = Date.UTC(2026, 9, 25, 14, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const { WATCH_THRESHOLD_MS } = await import("@/lib/container-watch");
    const identity = {
      containerId: "1".repeat(64),
      composeProject: null,
      composeService: null,
    };
    const incidentId = await openContainer(host.id, "old", start - WATCH_THRESHOLD_MS);
    const mark = (start - 10_000) / 1000;
    await setWatchSettings(host.id, ["old"], { old: identity }, {
      old: {
        identity,
        absentSince: (start - WATCH_THRESHOLD_MS) / 1000,
        observedAt: mark,
        accreditedMs: WATCH_THRESHOLD_MS - 10_000,
      },
    }, mark);
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [{ ...containerOf("new", "exited"), id: identity.containerId }],
    });

    await collectHost(host, start);

    const { getSettings } = await import("@/lib/settings");
    expect((await getSettings(host.id)).expectedContainers).toEqual(["new"]);
    expect((await state()).incidents).toMatchObject([
      { id: incidentId, key: "container:new", resolvedAt: null },
    ]);
  });

  it("moves the watch and the episode to a new name with the same Docker ID", async () => {
    const start = Date.UTC(2026, 9, 25, 15);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const oldId = "1".repeat(64);
    const incidentId = await openContainer("nas-home", "old", start - 60_000);
    const appsIncident = await openContainer("apps", "old", start - 60_000);
    await setWatchSettings(
      "nas-home",
      ["old"],
      {
        old: {
          containerId: oldId,
          composeProject: null,
          composeService: null,
        },
      },
      {},
      (start - 30_000) / 1000,
    );
    await setWatchSettings("apps", ["old"], {
      old: { containerId: oldId, composeProject: null, composeService: null },
    });
    // The previous name is now occupied by another container; the ID wins.
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [
        { ...containerOf("old", "running"), id: "2".repeat(64) },
        { ...containerOf("new", "running"), id: oldId },
      ],
    });

    await collectHost(host, start);

    const rows = await db.select().from(tables.incidents);
    const moved = rows.find((row) => row.id === incidentId)!;
    expect(moved).toMatchObject({
      id: incidentId,
      key: "container:new",
      title: expect.stringContaining("new"),
      resolvedAt: expect.any(Date),
      closedBy: "collector",
      fingerprint: store.incidentFingerprint("nas-home", "container:new"),
    });
    const events = (await db.select().from(tables.incidentEvents)).filter(
      (event) => event.incidentId === incidentId,
    );
    expect(events.map((event) => event.kind)).toEqual([
      "opened",
      "reassigned",
      "closed",
    ]);
    expect(events.find((event) => event.kind === "reassigned")!.detail).toContain(
      "container:old",
    );
    expect(events.find((event) => event.kind === "reassigned")!.detail).toContain(
      "container:new",
    );
    expect(
      (await db.select().from(tables.notificationOutbox)).filter(
        (notice) => notice.incidentId === incidentId,
      ),
    ).toHaveLength(1);
    const [settingsRow] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(settingsRow.value.expectedContainers).toEqual(["new"]);
    expect(settingsRow.value.watch!.identities.new.containerId).toBe(oldId);
    expect(settingsRow.value.watch!.identities.old).toBeUndefined();
    // Another host with the same name keeps its own episode.
    const appsRow = rows.find((row) => row.id === appsIncident)!;
    expect(appsRow).toMatchObject({
      key: "container:old",
      resolvedAt: null,
    });
  });

  it("resumes a stopped replacement after an absence without reopening it", async () => {
    const start = Date.UTC(2026, 9, 25, 16);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const containerId = "3".repeat(64);
    const incidentId = await openContainer("nas-home", "svc", start - 120_000);
    await setWatchSettings(
      "nas-home",
      ["svc"],
      {
        svc: {
          containerId,
          composeProject: "media",
          composeService: "svc",
        },
      },
      {},
      (start - 60_000) / 1000,
    );

    nas.metrics = metricsSnapshot({
      timestamp: (start - 30_000) / 1000,
      containersObservedAt: (start - 30_000) / 1000,
      containers: [containerOf("other", "running")],
    });
    await collectHost(host, start - 30_000);
    let [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(row).toMatchObject({
      key: "container:svc",
      resolvedAt: null,
      inhibitedReason: "container-absent",
      observationPending: true,
      seq: 2,
    });

    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [{ ...containerOf("svc", "exited"), id: containerId }],
    });
    await collectHost(host, start);

    [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(row).toMatchObject({
      id: incidentId,
      key: "container:svc",
      resolvedAt: null,
      inhibitedBy: null,
      inhibitedReason: null,
      observationPending: false,
      seq: 3,
    });
    const events = (await db.select().from(tables.incidentEvents)).filter(
      (event) => event.incidentId === incidentId,
    );
    expect(events.map((event) => event.kind)).toEqual([
      "opened",
      "pending",
      "resumed",
    ]);
    expect(
      (await db.select().from(tables.notificationOutbox)).filter(
        (notice) => notice.incidentId === incidentId,
      ),
    ).toHaveLength(1);
  });

  it("moves the watch to a unique Compose replacement with another ID", async () => {
    const start = Date.UTC(2026, 9, 25, 17);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const incidentId = await openContainer("nas-home", "old", start - 60_000);
    await setWatchSettings(
      "nas-home",
      ["old"],
      {
        old: {
          containerId: "4".repeat(64),
          composeProject: "media",
          composeService: "old",
        },
      },
      {},
      (start - 30_000) / 1000,
    );
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [
        {
          ...containerOf("replacement", "running"),
          id: "5".repeat(64),
          compose: { project: "media", service: "old" },
        },
      ],
    });

    await collectHost(host, start);

    const [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(row).toMatchObject({
      key: "container:replacement",
      resolvedAt: expect.any(Date),
      closedBy: "collector",
    });
    const [settingsRow] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(settingsRow.value.expectedContainers).toEqual(["replacement"]);
  });

  it("keeps both names pending when a scaled Compose service is ambiguous", async () => {
    const start = Date.UTC(2026, 9, 25, 18);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setWatchSettings(
      "nas-home",
      ["old"],
      {
        old: {
          containerId: "6".repeat(64),
          composeProject: "media",
          composeService: "old",
        },
      },
      {},
      (start - 30_000) / 1000,
    );
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [
        {
          ...containerOf("old-a", "running"),
          id: "7".repeat(64),
          compose: { project: "media", service: "old" },
        },
        {
          ...containerOf("old-b", "running"),
          id: "8".repeat(64),
          compose: { project: "media", service: "old" },
        },
      ],
    });

    await collectHost(host, start);

    const [settingsRow] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(settingsRow.value.expectedContainers).toEqual(["old"]);
    expect(settingsRow.value.watch!.entries.old).toMatchObject({
      accreditedMs: 0,
    });
    expect(await db.select().from(tables.incidents)).toHaveLength(0);
  });

  it("does not choose a destination claimed by two watched names", async () => {
    const start = Date.UTC(2026, 9, 25, 19);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setWatchSettings(
      "nas-home",
      ["a", "b"],
      {
        a: {
          containerId: "9".repeat(64),
          composeProject: "media",
          composeService: "shared",
        },
        b: {
          containerId: "a".repeat(64),
          composeProject: "media",
          composeService: "shared",
        },
      },
      {},
      (start - 30_000) / 1000,
    );
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [
        {
          ...containerOf("candidate", "running"),
          id: "b".repeat(64),
          compose: { project: "media", service: "shared" },
        },
      ],
    });

    await collectHost(host, start);

    const [settingsRow] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(settingsRow.value.expectedContainers).toEqual(["a", "b"]);
    expect(Object.keys(settingsRow.value.watch!.entries).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(await db.select().from(tables.incidents)).toHaveLength(0);
  });

  it("keeps the original episode and closes a duplicate destination row", async () => {
    const start = Date.UTC(2026, 9, 25, 20);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const oldId = "c".repeat(64);
    const original = await openContainer("nas-home", "old", start - 60_000);
    const duplicate = await openContainer("nas-home", "new", start - 50_000);
    await setWatchSettings(
      "nas-home",
      ["old"],
      {
        old: {
          containerId: oldId,
          composeProject: null,
          composeService: null,
        },
      },
      {},
      (start - 30_000) / 1000,
    );
    nas.metrics = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [{ ...containerOf("new", "running"), id: oldId }],
    });

    await collectHost(host, start);

    const rows = await db.select().from(tables.incidents);
    const kept = rows.find((row) => row.id === original)!;
    const resolved = rows.find((row) => row.id === duplicate)!;
    expect(kept).toMatchObject({
      id: original,
      key: "container:new",
      resolvedAt: expect.any(Date),
    });
    expect(resolved).toMatchObject({
      id: duplicate,
      key: "container:new",
      resolvedAt: expect.any(Date),
    });
    const events = await db.select().from(tables.incidentEvents);
    expect(
      events
        .filter((event) => event.incidentId === original)
        .map((event) => event.kind),
    ).toEqual(["opened", "reassigned", "closed"]);
    expect(
      events
        .filter((event) => event.incidentId === duplicate)
        .map((event) => event.kind),
    ).toEqual(["opened", "closed"]);
  });

  it("ignores an invalid maintenance payload without resolving its episodes", async () => {
    const start = Date.UTC(2026, 10, 26, 10);
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });
    await collect(start);
    let current = await state();
    const incident = current.incidents.find(
      (row) => row.key === "backup-failed",
    )!;
    expect(incident).toBeTruthy();
    const events = current.events.length;
    const outbox = current.outbox.length;

    nas.maintenance = {
      ...maintenanceSnapshot(),
      role: "unexpected-role",
      timestamp: "not-a-number",
    };
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents).toHaveLength(1);
    expect(current.incidents[0]).toMatchObject({
      id: incident.id,
      resolvedAt: null,
      seq: 1,
    });
    expect(current.events).toHaveLength(events);
    expect(current.outbox).toHaveLength(outbox);
  });

  it("ignores an invalid deployments payload without resolving its episodes", async () => {
    const start = Date.UTC(2026, 10, 27, 10);
    nas.deployments = failingDeployments();
    await collect(start);
    let current = await state();
    const incident = current.incidents.find(
      (row) => row.key === "deploy-failed",
    )!;
    expect(incident).toBeTruthy();
    const events = current.events.length;
    const outbox = current.outbox.length;

    nas.deployments = { ...deploymentsSnapshot(), history: "not-a-list" };
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents.find((row) => row.id === incident.id)).toMatchObject(
      { resolvedAt: null, seq: 1 },
    );
    expect(current.events).toHaveLength(events);
    expect(current.outbox).toHaveLength(outbox);
  });

  it("leaves a degraded section intact while an independent reading resolves its own condition", async () => {
    const start = Date.UTC(2026, 10, 28, 10);
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
      failedUnits: {
        stack: [{ name: "media-stack-upgrade.service", description: null }],
        other: [],
      },
    });
    await collect(start);
    let current = await state();
    expect(current.incidents.map((row) => row.key).sort()).toEqual([
      "backup-failed",
      "stack-unit-failed",
    ]);
    const backup = current.incidents.find(
      (row) => row.key === "backup-failed",
    )!;
    const stack = current.incidents.find(
      (row) => row.key === "stack-unit-failed",
    )!;

    nas.maintenance = maintenanceSnapshot({
      backup: { status: "ok", at: "2026-11-13T03:00:00Z" },
      failedUnits: {
        stack: [{ name: "media-stack-upgrade.service", description: null }],
        other: [],
      },
      degraded: ["failedUnits"],
    });
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents.find((row) => row.id === backup.id)).toMatchObject(
      { resolvedAt: expect.any(Date), seq: 2 },
    );
    expect(current.incidents.find((row) => row.id === stack.id)).toMatchObject({
      resolvedAt: null,
      seq: 1,
    });
    expect(
      current.events.filter((event) => event.incidentId === stack.id),
    ).toHaveLength(1);
  });

  it("does not resolve a retained release when the snapshot omits the list", async () => {
    const start = Date.UTC(2026, 10, 29, 10);
    nas.deployments = deploymentsSnapshot({
      retained: [
        {
          release: "v2.5.0",
          reason: "missing-configuration",
          blockedBy: null,
          breaking: false,
          manualSteps: [],
          missingSettings: ["NEW_SETTING"],
          secretSettings: [],
          services: [],
          sourceCommit: null,
          at: null,
        },
      ],
    });
    await collect(start);
    let current = await state();
    const incident = current.incidents.find(
      (row) => row.key === "release-retained",
    )!;
    expect(incident).toBeTruthy();

    const withoutRetained: Record<string, unknown> = {
      ...deploymentsSnapshot(),
    };
    delete withoutRetained.retained;
    nas.deployments = withoutRetained;
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents.find((row) => row.id === incident.id)).toMatchObject(
      { resolvedAt: null, seq: 1 },
    );
  });

  it("does not resolve a failed deployment from an empty history", async () => {
    const start = Date.UTC(2026, 10, 30, 10);
    nas.deployments = failingDeployments();
    await collect(start);
    let current = await state();
    const incident = current.incidents.find(
      (row) => row.key === "deploy-failed",
    )!;
    expect(incident).toBeTruthy();

    nas.deployments = deploymentsSnapshot({ history: [] });
    await collect(start + 61_000);
    current = await state();
    expect(current.incidents.find((row) => row.id === incident.id)).toMatchObject(
      { resolvedAt: null, seq: 1 },
    );
  });

  it("persists legacy_open when a pre-migration episode is revalidated", async () => {
    const start = Date.UTC(2026, 10, 31, 10);
    const [legacy] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "backup-failed",
        title: "Copia fallida legada",
        detail: "",
        severity: "warning",
        at: new Date(start - 86_400_000),
        fingerprint: store.incidentFingerprint("nas-home", "backup-failed"),
        seq: 0,
        origin: "legacy",
      })
      .returning();
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${legacy.id}:open`,
      incidentId: legacy.id,
      kind: "incident-open",
      channel: "telegram",
      status: "pending",
      revision: 0,
    });
    nas.maintenance = maintenanceSnapshot({
      backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
    });

    await collect(start);

    const [notice] = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.incidentId, legacy.id));
    expect(notice).toMatchObject({ status: "suppressed", channel: "telegram" });
    expect(notice.result).toMatchObject({ reason: "legacy_open" });
    const [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, legacy.id));
    expect(row).toMatchObject({ seq: 1, resolvedAt: null });
  });

  it("restarts the sustained CPU window after a sample without a CPU measurement", async () => {
    const start = Date.UTC(2026, 11, 1, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", {
      cpu: 10,
      memory: 90,
      disk: 90,
      temperature: 200,
      sustainedSeconds: 60,
      expectedContainers: [],
    });
    // A healthy baseline clears any timer left by another test.
    nas.metrics = metricsSnapshot({ cpu: 5, disks: [], temperatures: [] });
    await collectHost(host, start - 1_000);

    nas.metrics = metricsSnapshot({ cpu: 50, disks: [], temperatures: [] });
    await collectHost(host, start);
    nas.metrics = metricsSnapshot({ cpu: null, disks: [], temperatures: [] });
    await collectHost(host, start + 10_000);
    nas.metrics = metricsSnapshot({ cpu: 50, disks: [], temperatures: [] });
    await collectHost(host, start + 90_000);

    let current = await state();
    expect(current.incidents.filter((row) => row.key === "cpu")).toHaveLength(0);

    await collectHost(host, start + 151_000);
    current = await state();
    expect(current.incidents.filter((row) => row.key === "cpu")).toMatchObject([
      { resolvedAt: null, seq: 1 },
    ]);
  });

  it("restarts the temperature window after a sample without temperatures", async () => {
    const start = Date.UTC(2026, 11, 2, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", {
      cpu: 200,
      memory: 90,
      disk: 90,
      temperature: 50,
      sustainedSeconds: 0,
      expectedContainers: [],
    });
    nas.metrics = metricsSnapshot({ cpu: 5, disks: [], temperatures: [] });
    await collectHost(host, start - 1_000);

    nas.metrics = metricsSnapshot({ temperatures: [{ name: "CPU", value: 90 }] });
    await collectHost(host, start);
    nas.metrics = metricsSnapshot({ temperatures: [] });
    await collectHost(host, start + 10_000);
    nas.metrics = metricsSnapshot({ temperatures: [{ name: "CPU", value: 90 }] });
    await collectHost(host, start + 41_000);

    let current = await state();
    expect(
      current.incidents.filter((row) => row.key === "temperature"),
    ).toHaveLength(0);

    await collectHost(host, start + 72_000);
    current = await state();
    expect(
      current.incidents.filter((row) => row.key === "temperature"),
    ).toMatchObject([{ resolvedAt: null, seq: 1 }]);
  });

  it("restarts sustained windows after a malformed snapshot", async () => {
    const start = Date.UTC(2026, 11, 3, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", {
      cpu: 200,
      memory: 90,
      disk: 90,
      temperature: 50,
      sustainedSeconds: 0,
      expectedContainers: [],
    });
    nas.metrics = metricsSnapshot({ cpu: 5, disks: [], temperatures: [] });
    await collectHost(host, start - 1_000);

    nas.metrics = metricsSnapshot({ temperatures: [{ name: "CPU", value: 90 }] });
    await collectHost(host, start);
    nas.rawMetrics = '{"timestamp":';
    await collectHost(host, start + 10_000);
    nas.rawMetrics = null;
    nas.metrics = metricsSnapshot({ temperatures: [{ name: "CPU", value: 90 }] });
    await collectHost(host, start + 41_000);

    let current = await state();
    expect(
      current.incidents.filter((row) => row.key === "temperature"),
    ).toHaveLength(0);

    await collectHost(host, start + 72_000);
    current = await state();
    expect(
      current.incidents.filter((row) => row.key === "temperature"),
    ).toMatchObject([{ resolvedAt: null, seq: 1 }]);
  });

  it("groups a sustained outage into one services-down episode with a dated inventory", async () => {
    const start = Date.UTC(2027, 0, 5, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", { expectedContainers: [] });
    // A healthy baseline clears any sustained timer left by another test.
    await collectHost(host, start - 5_000);
    await db.insert(tables.samples).values({
      hostId: "nas-home",
      at: new Date(start - 30_000),
      data: metricsSnapshot({
        containersObservedAt: (start - 31_000) / 1000,
        containers: [
          containerOf("sonarr", "running"),
          containerOf("radarr", "exited"),
        ],
      }) as never,
    });
    nas.failMetrics = true;

    await collectHost(host, start);
    let current = await state();
    expect(
      current.incidents.filter((row) => row.key === "connection"),
    ).toHaveLength(0);

    await collectHost(host, start + 61_000);
    current = await state();
    const groups = current.incidents.filter((row) => row.key === "connection");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      hostId: "nas-home",
      key: "connection",
      severity: "critical",
      resolvedAt: null,
    });
    expect(groups[0].title).toContain("NAS-HOME");
    expect(groups[0].detail).not.toContain("sonarr");
    expect(groups[0].context).toMatchObject({
      kind: "services-down",
      observedFrom: "inventory",
      complete: true,
      omitted: 0,
      entries: [
        { name: "sonarr", state: "running" },
        { name: "radarr", state: "exited" },
      ],
    });
    expect(groups[0].context!.observedAt).toBeCloseTo(
      (start - 31_000) / 1000,
      3,
    );
    const notices = current.outbox.filter(
      (row) => row.incidentId === groups[0].id,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      key: `incident:${groups[0].id}:open`,
      kind: "incident-open",
      channel: "telegram",
      status: "pending",
    });

    await collectHost(host, start + 122_000);
    await collectHost(host, start + 183_000);
    current = await state();
    expect(
      current.incidents.filter((row) => row.key === "connection"),
    ).toHaveLength(1);
    expect(current.outbox).toHaveLength(1);
    expect(current.incidents.some((row) => row.hostId === "apps")).toBe(false);

    const [projected] = await store.projectIncidents(groups);
    expect(projected).toMatchObject({
      kind: "services-down",
      inventory: expect.objectContaining({
        complete: true,
        entries: [
          { name: "sonarr", state: "running" },
          { name: "radarr", state: "exited" },
        ],
      }),
    });
  });

  it("labels an older agent inventory with the sample date and keeps unknown state explicit", async () => {
    const start = Date.UTC(2027, 0, 5, 18);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", { expectedContainers: [] });
    await collectHost(host, start - 5_000);
    await db.insert(tables.samples).values({
      hostId: "nas-home",
      at: new Date(start - 45_000),
      data: metricsSnapshot({
        containers: [containerOf("sonarr", "running")],
      }) as never,
    });
    nas.failMetrics = true;
    await collectHost(host, start);
    await collectHost(host, start + 61_000);
    let current = await state();
    let group = current.incidents.find((row) => row.key === "connection")!;
    expect(group.context).toMatchObject({
      observedFrom: "sample",
      complete: true,
      observedAt: (start - 45_000) / 1000,
    });

    // A second host with no stored sample keeps an unknown state instead of
    // inventing an empty inventory.
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
    await db.delete(tables.samples);
    nas.reset();
    apps.failMetrics = true;
    const appsHost = getHosts().find((entry) => entry.id === "apps")!;
    await collectHost(appsHost, start + 200_000);
    await collectHost(appsHost, start + 261_000);
    current = await state();
    group = current.incidents.find((row) => row.key === "connection")!;
    expect(group.context).toEqual({
      kind: "services-down",
      observedAt: null,
      observedFrom: "unknown",
      complete: false,
      entries: [],
      omitted: 0,
    });
  });

  it("inhibits open container episodes during the outage and keeps their delivery", async () => {
    const start = Date.UTC(2027, 0, 6, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", { expectedContainers: [] });
    await collectHost(host, start - 5_000);
    const nasOpen = await openContainer("nas-home", "sonarr", start - 10_000);
    const appsOpen = await openContainer("apps", "sonarr", start - 10_000);
    const [nasRowBefore] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, nasOpen));
    nas.failMetrics = true;

    await collectHost(host, start);
    let [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, nasOpen));
    expect(row.inhibitedBy).toBeNull();
    expect(row.seq).toBe(1);

    await collectHost(host, start + 61_000);
    let current = await state();
    const group = current.incidents.find(
      (row) => row.key === "connection" && row.hostId === "nas-home",
    )!;
    [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, nasOpen));
    expect(row).toMatchObject({
      id: nasOpen,
      inhibitedBy: group.id,
      inhibitedReason: "host-unreachable",
      observationPending: true,
      resolvedAt: null,
      seq: 2,
    });
    expect(row.fingerprint).toBe(nasRowBefore.fingerprint);
    expect(
      current.events.filter(
        (event) => event.incidentId === nasOpen && event.kind === "inhibited",
      ),
    ).toHaveLength(1);
    const nasOutbox = current.outbox.filter(
      (notice) => notice.incidentId === nasOpen,
    );
    expect(nasOutbox).toHaveLength(1);
    expect(nasOutbox[0]).toMatchObject({
      key: `incident:${nasOpen}:open`,
      channel: "silent",
      status: "suppressed",
      result: expect.objectContaining({ reason: "policy_silent" }),
    });
    const appsRow = current.incidents.find((entry) => entry.id === appsOpen)!;
    expect(appsRow.inhibitedBy).toBeNull();
    expect(appsRow.seq).toBe(1);

    await collectHost(host, start + 122_000);
    // A restart loses the local window but the durable group and block stay
    // idempotent: no second opening and no repeated inhibition event.
    vi.resetModules();
    const recreated = await import("@/lib/collector");
    await recreated.collectHost(host, start + 130_000);
    await recreated.collectHost(host, start + 191_000);
    current = await state();
    expect(
      current.incidents.filter((entry) => entry.key === "connection"),
    ).toHaveLength(1);
    [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, nasOpen));
    expect(row).toMatchObject({
      id: nasOpen,
      inhibitedBy: group.id,
      observationPending: true,
      seq: 2,
    });
    expect(
      current.events.filter(
        (event) => event.incidentId === nasOpen && event.kind === "inhibited",
      ),
    ).toHaveLength(1);
    expect(
      current.outbox.filter((notice) => notice.incidentId === nasOpen),
    ).toHaveLength(1);

    const [projected] = await store.projectIncidents([group]);
    expect(projected.kind).toBe("services-down");
    expect(projected.inhibited).toHaveLength(1);
    expect(projected.inhibited![0]).toMatchObject({
      id: nasOpen,
      kind: "container",
      inhibitedBy: group.id,
      inhibitedReason: "host-unreachable",
      observationPending: true,
      delivery: { channel: "silent", state: "suppressed", reason: "policy_silent" },
    });
  });

  it.each(["retained", "orphaned"])(
    "resumes an inhibited episode when its container returns with a %s group",
    async (groupState) => {
      const start = Date.UTC(2027, 0, 6, 10);
      const host = getHosts().find((entry) => entry.id === "nas-home")!;
      await setSettings(host.id, { expectedContainers: ["service"] });
      const incidentId = await openContainer(host.id, "service", start - 20_000);
      const group = await store.recordIncidentObservation({
        hostId: host.id,
        key: "connection",
        failing: true,
        severity: "critical",
        now: start,
        delivery: { channel: "silent", reason: "policy_silent" },
        inhibitContainers: { reason: store.HOST_UNREACHABLE_REASON },
      });
      nas.metrics = metricsSnapshot({ timestamp: (start + 60_000) / 1000, containers: [] });
      await collectHost(host, start + 60_000);
      const reappearance = start + 32 * 86_400_000;
      const cutoff = new Date(reappearance - 30 * 86_400_000);
      if (groupState === "orphaned") {
        await db.delete(tables.incidents).where(eq(tables.incidents.id, group.incidentId!));
      } else {
        await store.cleanupExpiredIncidents(cutoff);
        expect((await state()).incidents).toContainEqual(expect.objectContaining({
          id: group.incidentId,
          resolvedAt: expect.any(Date),
        }));
      }
      expect((await state()).incidents).toContainEqual(expect.objectContaining({
        id: incidentId,
        inhibitedBy: group.incidentId,
        observationPending: true,
      }));

      nas.metrics = metricsSnapshot({
        timestamp: reappearance / 1000,
        containers: [containerOf("service", "exited")],
      });
      await collectHost(host, reappearance);
      const current = await state();
      expect(current.incidents.find((row) => row.id === incidentId)).toMatchObject({
        resolvedAt: null,
        inhibitedBy: null,
        observationPending: false,
      });
      expect(current.events).toContainEqual(expect.objectContaining({
        incidentId,
        kind: "resumed",
      }));
      await store.cleanupExpiredIncidents(cutoff);
      expect((await state()).incidents.map((row) => row.id)).toEqual([incidentId]);
    },
  );

  it("confirms previous episodes only with post-outage evidence and windows new failures", async () => {
    const start = Date.UTC(2027, 0, 7, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", {
      expectedContainers: [
        "legacy-running",
        "legacy-stopped",
        "legacy-absent",
        "healthy-now-stopped",
      ],
    });
    await collectHost(host, start - 5_000);
    const runningId = await openContainer(
      "nas-home",
      "legacy-running",
      start - 20_000,
    );
    const stoppedId = await openContainer(
      "nas-home",
      "legacy-stopped",
      start - 19_000,
    );
    const absentId = await openContainer(
      "nas-home",
      "legacy-absent",
      start - 18_000,
    );
    await db.insert(tables.samples).values({
      hostId: "nas-home",
      at: new Date(start - 30_000),
      data: metricsSnapshot({
        containersObservedAt: (start - 31_000) / 1000,
        containers: [
          containerOf("legacy-running", "running"),
          containerOf("legacy-stopped", "exited"),
          containerOf("legacy-absent", "running"),
          containerOf("healthy-now-stopped", "running"),
        ],
      }) as never,
    });
    nas.failMetrics = true;
    await collectHost(host, start);
    await collectHost(host, start + 61_000);
    let current = await state();
    const group = current.incidents.find(
      (row) => row.key === "connection" && row.hostId === "nas-home",
    )!;
    expect(
      current.incidents
        .filter((row) => row.inhibitedBy === group.id)
        .map((row) => row.key)
        .sort(),
    ).toEqual([
      "container:legacy-absent",
      "container:legacy-running",
      "container:legacy-stopped",
    ]);

    // A Docker cache from before the confirmed outage is not evidence.
    const stale = (start + 30_000) / 1000;
    nas.failMetrics = false;
    nas.metrics = metricsSnapshot({
      timestamp: (start + 62_000) / 1000,
      containersObservedAt: stale,
      containers: [
        containerOf("legacy-running", "running"),
        containerOf("legacy-stopped", "exited"),
        containerOf("healthy-now-stopped", "exited"),
      ],
    });
    await collectHost(host, start + 62_000);
    current = await state();
    expect(
      current.incidents.find((row) => row.id === group.id)!.resolvedAt,
    ).not.toBeNull();
    expect(
      current.incidents.find((row) => row.id === stoppedId),
    ).toMatchObject({ inhibitedBy: group.id, observationPending: true, seq: 2 });
    expect(
      current.incidents.find((row) => row.id === runningId),
    ).toMatchObject({ resolvedAt: null, seq: 2 });
    expect(
      current.incidents.find((row) => row.id === absentId),
    ).toMatchObject({
      resolvedAt: null,
      seq: 2,
      inhibitedBy: group.id,
      inhibitedReason: "host-unreachable",
      observationPending: true,
    });
    // Repeating the same cache is not a new observation.
    await collectHost(host, start + 72_000);
    current = await state();
    expect(
      current.incidents.find((row) => row.id === stoppedId)!.seq,
    ).toBe(2);
    expect(
      current.incidents.find((row) => row.key === "container:healthy-now-stopped"),
    ).toBeUndefined();

    // A fresh list releases each previous episode: running closes, stopped
    // resumes the same ID, absence stays pending for 03-02.
    nas.metrics = metricsSnapshot({
      timestamp: (start + 80_000) / 1000,
      containersObservedAt: (start + 80_000) / 1000,
      containers: [
        containerOf("legacy-running", "running"),
        containerOf("legacy-stopped", "exited"),
        containerOf("healthy-now-stopped", "exited"),
      ],
    });
    await collectHost(host, start + 80_000);
    current = await state();
    expect(
      current.incidents.find((row) => row.id === runningId),
    ).toMatchObject({ resolvedAt: expect.any(Date), seq: 3, observationPending: false });
    expect(
      current.incidents.find((row) => row.id === stoppedId),
    ).toMatchObject({
      id: stoppedId,
      resolvedAt: null,
      seq: 3,
      inhibitedBy: null,
      inhibitedReason: null,
      observationPending: false,
    });
    // The absent name leaves the outage block but stays open and pending: the
    // inventory reconciliation owns it from now on (D-06).
    expect(
      current.incidents.find((row) => row.id === absentId),
    ).toMatchObject({
      resolvedAt: null,
      seq: 3,
      inhibitedBy: null,
      inhibitedReason: "container-absent",
      observationPending: true,
    });
    expect(
      current.events.filter(
        (event) => event.incidentId === stoppedId && event.kind === "resumed",
      ),
    ).toHaveLength(1);
    expect(
      current.outbox.filter((notice) => notice.incidentId === stoppedId),
    ).toHaveLength(1);
    // The group closes exactly once and never creates a recovery message.
    expect(
      current.outbox.filter((notice) => notice.incidentId === group.id),
    ).toHaveLength(1);
    expect(
      current.incidents.find((row) => row.key === "container:healthy-now-stopped"),
    ).toBeUndefined();

    // The new failure needs its own 30-second window of fresh observations.
    nas.metrics = metricsSnapshot({
      timestamp: (start + 90_000) / 1000,
      containersObservedAt: (start + 90_000) / 1000,
      containers: [
        containerOf("legacy-running", "running"),
        containerOf("legacy-stopped", "exited"),
        containerOf("healthy-now-stopped", "exited"),
      ],
    });
    await collectHost(host, start + 90_000);
    current = await state();
    expect(
      current.incidents.find((row) => row.key === "container:healthy-now-stopped"),
    ).toBeUndefined();

    nas.metrics = metricsSnapshot({
      timestamp: (start + 110_000) / 1000,
      containersObservedAt: (start + 110_000) / 1000,
      containers: [
        containerOf("legacy-running", "running"),
        containerOf("legacy-stopped", "exited"),
        containerOf("healthy-now-stopped", "exited"),
      ],
    });
    await collectHost(host, start + 110_000);
    current = await state();
    const newFailure = current.incidents.find(
      (row) => row.key === "container:healthy-now-stopped",
    )!;
    expect(newFailure).toMatchObject({ resolvedAt: null, seq: 1 });
    const newNotice = current.outbox.find(
      (notice) => notice.incidentId === newFailure.id,
    )!;
    expect(newNotice).toMatchObject({
      channel: "silent",
      status: "suppressed",
    });
    expect(
      current.incidents.find((row) => row.id === group.id)!.seq,
    ).toBe(2);
  });

  it("delivers the outage notice with the host and link but never the inventory", async () => {
    const start = Date.UTC(2027, 0, 8, 10);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await setSettings("nas-home", { expectedContainers: [] });
    await collectHost(host, start - 5_000);
    await db.insert(tables.samples).values({
      hostId: "nas-home",
      at: new Date(start - 30_000),
      data: metricsSnapshot({
        containersObservedAt: (start - 31_000) / 1000,
        containers: [containerOf("sonarr", "running")],
      }) as never,
    });
    nas.failMetrics = true;
    await collectHost(host, start);
    await collectHost(host, start + 61_000);
    const current = await state();
    const group = current.incidents.find((row) => row.key === "connection")!;

    const calls: Array<{ body: Record<string, unknown> }> = [];
    const transport: TelegramTransport = async (_url, init) => {
      calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 501, chat: { id: -1001234567890 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const dispatch = await import("@/lib/notification-dispatch");
    const client = new Client({ connectionString: context.url });
    await client.connect();
    try {
      expect(await dispatch.acquireCollectionLock(client)).toBe(true);
      const config: RuntimeConfig = {
        databaseUrl: context.url,
        betterAuthSecret: "b".repeat(32),
        betterAuthUrl: "https://hub.example.com",
        setupToken: "s".repeat(32),
        trustedOrigins: [],
        hosts: [],
        telegram: {
          botToken: "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH",
          chatId: "-1001234567890",
        },
        vapid: null,
        pushWarnings: false,
        digestTime: "08:00",
      };
      const result = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => start + 62_000,
        fetchImpl: transport,
      });
      expect(result.action).toBe("sent");
      expect(calls).toHaveLength(1);
      const text = String(calls[0].body.text);
      expect(text).toContain("NAS-HOME");
      expect(text).toContain("critical");
      expect(text).not.toContain("sonarr");
      expect(text).not.toContain("inventory");
      const markup = calls[0].body.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; url: string }>>;
      };
      const url = new URL(markup.inline_keyboard[0][0].url);
      expect(url.searchParams.get("view")).toBe("alerts");
      expect(url.searchParams.get("host")).toBe("nas-home");
      expect(url.searchParams.get("incident")).toBe(String(group.id));
      expect(url.origin).toBe("https://hub.example.com");
    } finally {
      await client.end();
    }

    const after = await state();
    expect(
      after.outbox.filter((notice) => notice.incidentId === group.id),
    ).toHaveLength(1);
    expect(after.outbox[0].status).toBe("sent");
    // The inventory is stored for the authenticated detail, never serialized
    // into the provider payload asserted above.
    expect(after.incidents[0].context?.entries).toContainEqual({
      name: "sonarr",
      state: "running",
    });
  });

  function helperCleanup(
    overrides: Partial<
      NonNullable<
        import("@/lib/maintenance").MaintenanceSnapshot["helperCleanup"]
      >
    > = {},
  ) {
    return maintenanceSnapshot({
      helperCleanup: {
        available: true,
        status: "persistent",
        checkedAt: "2026-11-14T10:00:00Z",
        pending: 2,
        persistent: 1,
        ...overrides,
      },
    });
  }

  it("opens one digest episode for a persistent helper cleanup failure", async () => {
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const start = Date.UTC(2027, 1, 10, 10);
    nas.maintenance = { ...helperCleanup(), degraded: ["docker"] };
    await collectHost(host, start);

    const current = await state();
    const cleanup = current.incidents.filter(
      (row) => row.key === "helper-cleanup",
    );
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({
      hostId: "nas-home",
      severity: "warning",
      resolvedAt: null,
    });
    expect(current.events).toHaveLength(1);
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      channel: "digest",
      status: "suppressed",
    });
    expect(current.outbox[0].result).toMatchObject({
      reason: "digest_pending",
    });
  });

  it("keeps two scattered cleanup failures out of Avisos", async () => {
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const start = Date.UTC(2027, 1, 11, 10);
    nas.maintenance = helperCleanup({
      status: "failing",
      pending: 2,
      persistent: 0,
      checkedAt: "2026-11-14T11:00:00Z",
    });

    await collectHost(host, start);

    const current = await state();
    expect(
      current.incidents.filter((row) => row.key === "helper-cleanup"),
    ).toHaveLength(0);
  });

  it("keeps the episode while one helper remains pending and closes on the complete check", async () => {
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const start = Date.UTC(2027, 1, 12, 10);
    nas.maintenance = helperCleanup({
      checkedAt: "2026-11-14T12:00:00Z",
    });

    await collectHost(host, start);
    let current = await state();
    const [episode] = current.incidents;
    expect(episode.resolvedAt).toBeNull();

    // The persistent helper was removed but another one still failed once.
    nas.maintenance = helperCleanup({
      status: "failing",
      pending: 1,
      persistent: 0,
      checkedAt: "2026-11-14T12:01:00Z",
    });
    await collectHost(host, start + 61_000);
    current = await state();
    expect(current.incidents[0].resolvedAt).toBeNull();
    expect(current.events).toHaveLength(1);

    nas.maintenance = helperCleanup({
      status: "clean",
      pending: 0,
      persistent: 0,
      checkedAt: "2026-11-14T12:02:00Z",
    });
    await collectHost(host, start + 122_000);
    current = await state();
    expect(current.incidents[0].resolvedAt).not.toBeNull();
    expect(current.incidents[0].closedBy).toBe("collector");
    expect(current.events.filter((event) => event.kind === "closed")).toHaveLength(
      1,
    );
    // D-11: the closure does not queue a recovery notification.
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      channel: "digest",
      status: "suppressed",
    });
    expect(
      current.outbox.filter((notice) => notice.status === "pending"),
    ).toHaveLength(0);

    // The closed episode remains readable in Avisos with its digest policy.
    const alerts = await store.projectIncidents(
      await db.select().from(tables.incidents),
    );
    expect(alerts[0]).toMatchObject({
      key: "helper-cleanup",
      resolvedAt: expect.any(String),
      delivery: {
        channel: "digest",
        state: "suppressed",
        reason: "digest_pending",
      },
    });
  });

  it("does not let an older cleanup check close the episode", async () => {
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const start = Date.UTC(2027, 1, 13, 10);
    nas.maintenance = helperCleanup({
      checkedAt: "2026-11-14T13:02:00Z",
    });

    await collectHost(host, start);
    nas.maintenance = helperCleanup({
      status: "clean",
      pending: 0,
      persistent: 0,
      checkedAt: "2026-11-14T13:01:00Z",
    });
    await collectHost(host, start + 61_000);
    let current = await state();
    expect(current.incidents[0].resolvedAt).toBeNull();

    nas.maintenance = helperCleanup({
      status: "clean",
      pending: 0,
      persistent: 0,
      checkedAt: "2026-11-14T13:03:00Z",
    });
    await collectHost(host, start + 122_000);
    current = await state();
    expect(current.incidents[0].resolvedAt).not.toBeNull();
  });

  it("does not duplicate the episode on a repeated reading", async () => {
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const start = Date.UTC(2027, 1, 14, 10);
    nas.maintenance = helperCleanup({
      checkedAt: "2026-11-14T14:00:00Z",
    });

    await collectHost(host, start);
    await collectHost(host, start + 61_000);

    const current = await state();
    expect(
      current.incidents.filter((row) => row.key === "helper-cleanup"),
    ).toHaveLength(1);
    expect(current.events).toHaveLength(1);
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({
      channel: "digest",
      status: "suppressed",
    });
  });

  it("isolates the cleanup episode by host", async () => {
    const start = Date.UTC(2027, 1, 16, 10);
    nas.maintenance = helperCleanup({
      checkedAt: "2027-02-16T10:00:00Z",
    });
    apps.maintenance = maintenanceSnapshot({
      helperCleanup: {
        available: true,
        status: "clean",
        checkedAt: "2027-02-16T10:00:00Z",
        pending: 0,
        persistent: 0,
      },
    });

    await collect(start);

    const current = await state();
    const cleanup = current.incidents.filter(
      (row) => row.key === "helper-cleanup",
    );
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0].hostId).toBe("nas-home");
  });

  it("keeps the episode when the agent has no cleanup section", async () => {
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    const start = Date.UTC(2027, 1, 17, 10);
    nas.maintenance = helperCleanup({
      checkedAt: "2027-02-17T10:00:00Z",
    });

    await collectHost(host, start);
    nas.maintenance = maintenanceSnapshot();
    await collectHost(host, start + 61_000);

    const current = await state();
    expect(current.incidents[0].resolvedAt).toBeNull();
    expect(current.events).toHaveLength(1);
  });
  describe("ingest episodes", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const backupAt = (status: "ok" | "failed", at: number) =>
      maintenanceSnapshot({ backup: { status, at: iso(at) } });

    async function openByIngest(now: number) {
      const opened = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "backup-failed",
        failing: true,
        severity: "critical",
        title: "Copia fallida en NAS-HOME",
        detail: "",
        now,
        delivery: { channel: "telegram", reason: "policy_immediate" },
        closedBy: "ingest",
        origin: "ingest",
      });
      return opened.incidentId!;
    }

    it("ingest: an older ok snapshot leaves the notice open and a newer one closes it once", async () => {
      const opened = Date.UTC(2027, 2, 1, 10);
      const incidentId = await openByIngest(opened);
      await db
        .update(tables.notificationOutbox)
        .set({
          status: "sent",
          chatId: "100",
          messageId: "200",
          attemptStartedAt: new Date(opened),
        })
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      const before = await state();

      // The agent cache still holds a copy taken before the notice was opened.
      nas.maintenance = backupAt("ok", opened - 90_000);
      await collect(opened + 61_000);
      let current = await state();
      expect(current.incidents).toHaveLength(1);
      expect(current.incidents[0]).toMatchObject({
        id: incidentId,
        resolvedAt: null,
        seq: 1,
      });
      expect(current.events).toHaveLength(before.events.length);
      expect(current.outbox).toHaveLength(before.outbox.length);

      // An older failed copy does not open another episode either.
      nas.maintenance = backupAt("failed", opened - 90_000);
      await collect(opened + 122_000);
      current = await state();
      expect(current.incidents).toHaveLength(1);
      expect(current.incidents[0].resolvedAt).toBeNull();

      // A copy made after the notice proves the recovery.
      nas.maintenance = backupAt("ok", opened + 30_000);
      await collect(opened + 183_000);
      current = await state();
      expect(current.incidents).toHaveLength(1);
      expect(current.incidents[0]).toMatchObject({
        id: incidentId,
        resolvedAt: expect.any(Date),
        closedBy: "collector",
        seq: 2,
      });
      expect(
        current.outbox.filter((row) => row.kind === "incident-edit"),
      ).toHaveLength(1);

      nas.maintenance = backupAt("ok", opened + 60_000);
      await collect(opened + 244_000);
      current = await state();
      expect(current.incidents[0].seq).toBe(2);
      expect(
        current.outbox.filter((row) => row.kind === "incident-edit"),
      ).toHaveLength(1);
    });
  });
});
