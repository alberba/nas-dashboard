import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
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

const sessionState = vi.hoisted(() => ({ authenticated: true }));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        sessionState.authenticated
          ? {
              user: {
                id: "test-user",
                name: "Test",
                email: "test@hub.invalid",
              },
              session: { id: "test-session" },
            }
          : null,
      ),
      verifyPassword: vi.fn(),
    },
  },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));

type Behaviour = "ok" | "reject" | "uncertain";

const containerId = "c".repeat(64);
const containerKey = "container:sonarr";
const baseUrl = testDatabaseUrl();

function metrics(hostId: string) {
  return {
    timestamp: Date.now() / 1000,
    hostname: hostId,
    cpu: 10,
    memory: { total: 1000, used: 250 },
    network: { rx: 1, tx: 2 },
    io: { read: 3, write: 4 },
    uptime: 1000,
    disks: [],
    temperatures: [],
    containers: [
      {
        id: containerId,
        name: "sonarr",
        image: "lscr.io/linuxserver/sonarr:latest",
        state: "running",
        status: "Up 1 hour",
        protected: false,
        composeProject: "media-stack",
        composeService: "sonarr",
        oneShot: false,
        exitCode: null,
        orphan: false,
        recreateOnCompose: false,
        cpu: 1,
        memory: 2,
        network: null,
        compose: null,
      },
    ],
  };
}

type FakeAgent = {
  url: string;
  behaviour: Behaviour;
  metricsBody: unknown;
  beforeActionResponse?: () => Promise<void>;
  requests: unknown[];
  reset(): void;
  close(): Promise<void>;
};

async function fakeAgent(token: string): Promise<FakeAgent> {
  const agent: FakeAgent = {
    url: "",
    behaviour: "ok",
    metricsBody: null,
    requests: [],
    reset() {
      agent.behaviour = "ok";
      agent.metricsBody = null;
      agent.beforeActionResponse = undefined;
      agent.requests = [];
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "No autorizado" }));
      return;
    }
    const path = new URL(request.url ?? "/", "http://agent").pathname;
    if (path === "/metrics") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(agent.metricsBody ?? metrics("fake")));
      return;
    }
    if (path === "/action") await agent.beforeActionResponse?.();
    if (agent.behaviour === "uncertain") {
      response.destroy();
      return;
    }
    if (agent.behaviour === "reject") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "El contenedor no se detuvo" }));
      return;
    }
    agent.requests.push(raw ? JSON.parse(raw) : null);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ state: "stopped", name: "sonarr" }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

describe.skipIf(!baseUrl)("incidents API", () => {
  let context: TestDatabase;
  let agent: FakeAgent;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let routes: typeof import("../src/app/api/[...path]/route");
  let collectHost: typeof import("@/lib/collector").collectHost;
  let getHosts: typeof import("@/lib/hosts").getHosts;

  async function api(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    const request = new NextRequest(url, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return routes[method](request, {
      params: Promise.resolve({ path: route }),
    });
  }

  async function sample(hostId: string) {
    await db.insert(tables.samples).values({
      hostId,
      at: new Date(),
      data: metrics(hostId) as never,
    });
  }

  async function setSettingsValue(
    hostId: string,
    overrides: Record<string, unknown>,
  ) {
    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, hostId));
    await db
      .update(tables.configuration)
      .set({ value: { ...row.value, ...overrides } })
      .where(eq(tables.configuration.hostId, hostId));
  }

  function pendingOperation(
    action: string,
    target: string,
    at: Date,
    hostId = "nas-home",
  ) {
    return db
      .insert(tables.operations)
      .values({
        id: crypto.randomUUID(),
        hostId,
        userId: "test-user",
        action,
        target,
        status: "pending",
        at,
      })
      .returning();
  }

  function freshMetrics(
    start: number,
    containers: unknown[],
    marker = start,
  ) {
    const base = metrics("nas-home");
    return {
      ...base,
      timestamp: start / 1000,
      containersObservedAt: marker / 1000,
      containers,
    };
  }

  async function openIncident(hostId: string, key = containerKey) {
    const opened = await store.recordIncidentObservation({
      hostId,
      key,
      failing: true,
      severity: "critical",
      title: `Servicio detenido en ${hostId}`,
      detail: "sonarr",
      now: Date.now(),
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    return opened.incidentId!;
  }

  async function markSent(incidentId: number) {
    await db
      .update(tables.notificationOutbox)
      .set({
        status: "sent",
        chatId: "42",
        messageId: "9",
        attempts: 1,
        result: {
          state: "sent",
          reason: null,
          at: new Date().toISOString(),
        },
      })
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-open"),
        ),
      );
  }

  beforeAll(async () => {
    agent = await fakeAgent("a".repeat(32));
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: agent.url,
        token: "a".repeat(32),
      },
      {
        id: "apps",
        name: "Apps",
        role: "apps-server",
        url: agent.url,
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
    tables = await import("@/lib/schema");
    store = await import("@/lib/incident-store");
    routes = await import("../src/app/api/[...path]/route");
    ({ collectHost } = await import("@/lib/collector"));
    ({ getHosts } = await import("@/lib/hosts"));
    await db.insert(tables.user).values({
      id: "test-user",
      name: "Test",
      email: "test@hub.invalid",
    });
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await agent.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(async () => {
    sessionState.authenticated = true;
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidentSnoozes);
    await db.delete(tables.incidents);
    await db.delete(tables.digestRuns);
    await db.delete(tables.operations);
    await db.delete(tables.samples);
    await db.delete(tables.configuration);
    await sample("nas-home");
    await sample("apps");
    await db.insert(tables.configuration).values([
      {
        hostId: "nas-home",
        id: "settings",
        value: {
          cpu: 90,
          memory: 90,
          disk: 90,
          temperature: 85,
          sustainedSeconds: 300,
          expectedContainers: ["sonarr"],
          initialized: true,
        },
      },
      {
        hostId: "apps",
        id: "settings",
        value: {
          cpu: 90,
          memory: 90,
          disk: 90,
          temperature: 85,
          sustainedSeconds: 300,
          expectedContainers: ["sonarr"],
          initialized: true,
        },
      },
    ]);
    agent.reset();
  });

  it("requires a session and an explicit configured host", async () => {
    const nasIncident = await openIncident("nas-home");
    sessionState.authenticated = false;
    expect(
      (await api("GET", `/api/incidents/${nasIncident}?host=nas-home`)).status,
    ).toBe(401);

    sessionState.authenticated = true;
    expect(
      (await api("GET", `/api/incidents/${nasIncident}`)).status,
    ).toBe(404);
    expect(
      (await api("GET", `/api/incidents/${nasIncident}?host=ghost`)).status,
    ).toBe(404);
    expect(
      (await api("GET", `/api/incidents/0?host=nas-home`)).status,
    ).toBe(404);
    expect(
      (await api("GET", `/api/incidents/99999999999999999999?host=nas-home`))
        .status,
    ).toBe(404);
    // `incidents.id` is a PostgreSQL integer: one past the maximum is not found
    // instead of reaching the database and surfacing as a 503.
    expect(
      (await api("GET", "/api/incidents/2147483647?host=nas-home")).status,
    ).toBe(404);
    expect(
      (await api("GET", "/api/incidents/2147483648?host=nas-home")).status,
    ).toBe(404);
  });

  it("resolves the exact host and id pair without a cross-host fallback", async () => {
    const nasIncident = await openIncident("nas-home");
    const appsIncident = await openIncident("apps");
    expect(nasIncident).not.toBe(appsIncident);

    const mismatch = await api(
      "GET",
      `/api/incidents/${nasIncident}?host=apps`,
    );
    expect(mismatch.status).toBe(404);

    const correct = await api(
      "GET",
      `/api/incidents/${nasIncident}?host=nas-home`,
    );
    expect(correct.status).toBe(200);
    expect(await correct.json()).toMatchObject({
      host: { id: "nas-home" },
      incident: { id: nasIncident, hostId: "nas-home", key: containerKey },
    });
  });

  it("finds an episode older than the 100 recent ones", async () => {
    const now = Date.now();
    const filler = Array.from({ length: 105 }, (_, index) => ({
      hostId: "nas-home",
      key: `filler-${index}`,
      title: `Relleno ${index}`,
      detail: "",
      severity: "warning",
      at: new Date(now - index * 1000),
      fingerprint: store.incidentFingerprint("nas-home", `filler-${index}`),
      seq: 1,
      origin: "live",
    }));
    await db.insert(tables.incidents).values(filler);
    const [target] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "historical",
        title: "Incidencia histórica",
        detail: "",
        severity: "critical",
        at: new Date(now - 200_000),
        fingerprint: store.incidentFingerprint("nas-home", "historical"),
        seq: 4,
        origin: "live",
      })
      .returning();

    const overview = await (await api("GET", "/api/overview?host=nas-home")).json();
    expect(overview.alerts).toHaveLength(100);
    expect(
      overview.alerts.some((alert: { id: number }) => alert.id === target.id),
    ).toBe(false);

    const response = await api(
      "GET",
      `/api/incidents/${target.id}?host=nas-home`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      incident: { id: target.id, seq: 4 },
      alerts: [{ id: target.id }],
    });
  });

  it("projects finite delivery states and reasons for overview and detail", async () => {
    const now = Date.now();
    const seeded = async (key: string) => {
      const [row] = await db
        .insert(tables.incidents)
        .values({
          hostId: "nas-home",
          key,
          title: key,
          detail: "",
          severity: "warning",
          at: new Date(now),
          fingerprint: store.incidentFingerprint("nas-home", key),
          seq: 3,
          origin: "live",
        })
        .returning();
      return row;
    };
    const legacy = await seeded("legacy");
    const digest = await seeded("digest");
    const silent = await seeded("silent");
    const failed = await seeded("failed");
    const uncertain = await seeded("uncertain");
    const sent = await seeded("sent");
    const pending = await seeded("pending");

    await db.insert(tables.notificationOutbox).values([
      {
        key: `incident:${legacy.id}:open`,
        incidentId: legacy.id,
        kind: "incident-open",
        channel: "silent",
        status: "suppressed",
        result: {
          state: "suppressed",
          reason: "legacy_open",
          at: new Date(now).toISOString(),
        },
      },
      {
        key: `incident:${digest.id}:open`,
        incidentId: digest.id,
        kind: "incident-open",
        channel: "digest",
        status: "suppressed",
        result: {
          state: "suppressed",
          reason: "digest_pending",
          at: new Date(now).toISOString(),
        },
      },
      {
        key: `incident:${silent.id}:open`,
        incidentId: silent.id,
        kind: "incident-open",
        channel: "silent",
        status: "suppressed",
        result: {
          state: "suppressed",
          reason: "policy_silent",
          at: new Date(now).toISOString(),
        },
      },
      {
        key: `incident:${failed.id}:open`,
        incidentId: failed.id,
        kind: "incident-open",
        channel: "telegram",
        status: "failed",
        chatId: "999",
        messageId: "888",
        result: {
          state: "failed",
          reason: "telegram_403",
          at: new Date(now).toISOString(),
        },
      },
      {
        key: `incident:${uncertain.id}:open`,
        incidentId: uncertain.id,
        kind: "incident-open",
        channel: "telegram",
        status: "uncertain",
        result: {
          state: "uncertain",
          reason: "lease_expired_after_attempt",
          at: new Date(now).toISOString(),
        },
      },
      {
        key: `incident:${sent.id}:open`,
        incidentId: sent.id,
        kind: "incident-open",
        channel: "telegram",
        status: "sent",
        chatId: "999",
        messageId: "888",
        result: {
          state: "sent",
          reason: null,
          at: new Date(now).toISOString(),
        },
        fallbackResult: {
          state: "failed",
          reason: "endpoint_rejected",
          at: new Date(now).toISOString(),
        },
      },
      {
        key: `incident:${sent.id}:edit:3`,
        incidentId: sent.id,
        kind: "incident-edit",
        channel: "telegram",
        status: "uncertain",
        revision: 3,
        chatId: "999",
        messageId: "888",
        editResult: {
          state: "uncertain",
          reason: "endpoint_uncertain",
          at: new Date(now).toISOString(),
        },
      },
      {
        key: `incident:${pending.id}:open`,
        incidentId: pending.id,
        kind: "incident-open",
        channel: "telegram",
        status: "pending",
      },
      {
        key: `incident:${now}:disabled`,
        incidentId: null,
        kind: "push-test",
        channel: "push",
        status: "pending",
        ownerUserId: "test-user",
      },
    ]);

    const overview = await (
      await api("GET", "/api/overview?host=nas-home")
    ).json();
    const byKey = new Map(
      overview.alerts.map((alert: { key: string }) => [alert.key, alert]),
    );
    expect(byKey.get("legacy")).toMatchObject({
      delivery: { channel: "silent", state: "suppressed", reason: "legacy_open" },
    });
    expect(byKey.get("digest")).toMatchObject({
      delivery: {
        channel: "digest",
        state: "suppressed",
        reason: "digest_pending",
      },
    });
    expect(byKey.get("silent")).toMatchObject({
      delivery: { state: "suppressed", reason: "policy_silent" },
    });
    expect(byKey.get("failed")).toMatchObject({
      delivery: {
        channel: "telegram",
        state: "failed",
        reason: "permanent_rejection",
      },
    });
    expect(byKey.get("uncertain")).toMatchObject({
      delivery: { state: "uncertain", reason: "uncertain" },
    });
    expect(byKey.get("sent")).toMatchObject({
      delivery: { channel: "telegram", state: "sent", reason: null },
      fallback: {
        channel: "push",
        state: "failed",
        reason: "permanent_rejection",
      },
      lastUpdate: { state: "uncertain", reason: "uncertain" },
    });
    expect(byKey.get("pending")).toMatchObject({
      delivery: { channel: "telegram", state: "pending", reason: null },
      fallback: null,
      lastUpdate: null,
    });

    const detail = await (
      await api("GET", `/api/incidents/${sent.id}?host=nas-home`)
    ).json();
    expect(detail.incident).toMatchObject({
      id: sent.id,
      delivery: { state: "sent", reason: null },
      fallback: { state: "failed", reason: "permanent_rejection" },
      lastUpdate: { state: "uncertain", reason: "uncertain" },
    });
    for (const value of [overview, detail]) {
      const text = JSON.stringify(value);
      expect(text).not.toContain("999");
      expect(text).not.toContain("888");
      expect(text).not.toContain("api.telegram.org");
      expect(text).not.toContain("endpoint");
      expect(text).not.toContain("token");
    }
  });

  it("projects the outage group with its inventory and inhibited episodes beyond the recent list", async () => {
    const now = Date.now();
    const [group] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "connection",
        title: "NAS-HOME no responde",
        detail: "No se reciben métricas.",
        severity: "critical",
        at: new Date(now),
        fingerprint: store.incidentFingerprint("nas-home", "connection"),
        seq: 2,
        origin: "live",
        context: {
          kind: "services-down",
          observedAt: Math.floor(now / 1000) - 60,
          observedFrom: "inventory",
          complete: true,
          entries: [
            { name: "sonarr", state: "running" },
            { name: "radarr", state: "exited" },
          ],
          omitted: 0,
        },
      })
      .returning();
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${group.id}:open`,
      incidentId: group.id,
      kind: "incident-open",
      channel: "telegram",
      status: "sent",
      chatId: "999",
      messageId: "888",
      result: {
        state: "sent",
        reason: null,
        at: new Date(now).toISOString(),
      },
    });
    const [blocked] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "container:sonarr",
        title: "Servicio detenido en NAS-HOME: sonarr",
        detail: "El servicio estaba previsto en ejecución y no está disponible.",
        severity: "warning",
        at: new Date(now - 500_000),
        fingerprint: store.incidentFingerprint("nas-home", "container:sonarr"),
        seq: 2,
        origin: "live",
        inhibitedBy: group.id,
        inhibitedReason: "host-unreachable",
        observationPending: true,
      })
      .returning();
    await db.insert(tables.incidents).values(
      Array.from({ length: 105 }, (_, index) => ({
        hostId: "nas-home",
        key: `filler-${index}`,
        title: `Relleno ${index}`,
        detail: "",
        severity: "warning",
        at: new Date(now - 1_000 - index * 1_000),
        fingerprint: store.incidentFingerprint("nas-home", `filler-${index}`),
        seq: 1,
        origin: "live",
      })),
    );

    const overview = await (
      await api("GET", "/api/overview?host=nas-home")
    ).json();
    expect(overview.alerts).toHaveLength(100);
    const overviewGroup = overview.alerts.find(
      (alert: { id: number }) => alert.id === group.id,
    );
    expect(overviewGroup).toMatchObject({
      kind: "services-down",
      inventory: {
        observedFrom: "inventory",
        complete: true,
        entries: [
          { name: "sonarr", state: "running" },
          { name: "radarr", state: "exited" },
        ],
      },
    });
    expect(
      overview.alerts.some((alert: { id: number }) => alert.id === blocked.id),
    ).toBe(false);

    const detail = await (
      await api("GET", `/api/incidents/${group.id}?host=nas-home`)
    ).json();
    expect(detail.incident).toMatchObject({
      id: group.id,
      hostId: "nas-home",
      kind: "services-down",
      inventory: { complete: true },
    });
    expect(detail.incident.inhibited).toHaveLength(1);
    expect(detail.incident.inhibited[0]).toMatchObject({
      id: blocked.id,
      kind: "container",
      inhibitedBy: group.id,
      inhibitedReason: "host-unreachable",
      observationPending: true,
    });
    expect(JSON.stringify(detail)).not.toContain("999");
    expect(JSON.stringify(detail)).not.toContain("888");

    sessionState.authenticated = false;
    expect(
      (await api("GET", `/api/incidents/${group.id}?host=nas-home`)).status,
    ).toBe(401);
    expect(
      (await api("GET", "/api/overview?host=nas-home")).status,
    ).toBe(401);
    sessionState.authenticated = true;
    expect(
      (await api("GET", `/api/incidents/${group.id}?host=apps`)).status,
    ).toBe(404);
  });

  it("publishes a pending absence through the collector in the overview and the real episode", async () => {
    const start = Date.UTC(2026, 10, 26, 10);
    const incidentId = await openIncident("nas-home", "container:ghost");
    await db
      .update(tables.configuration)
      .set({
        value: {
          cpu: 90,
          memory: 90,
          disk: 90,
          temperature: 85,
          sustainedSeconds: 300,
          expectedContainers: ["ghost"],
          initialized: true,
        },
      })
      .where(eq(tables.configuration.hostId, "nas-home"));
    agent.metricsBody = {
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      hostname: "nas-home",
      cpu: 10,
      memory: { total: 1000, used: 250 },
      network: { rx: 1, tx: 2 },
      io: { read: 3, write: 4 },
      uptime: 1000,
      disks: [],
      temperatures: [],
      containers: [],
    };
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await collectHost(host, start);

    const overview = await (
      await api("GET", "/api/overview?host=nas-home")
    ).json();
    expect(overview.watchPending).toEqual([
      expect.objectContaining({
        name: "ghost",
        state: "pending",
        absentSince: start / 1000,
        accreditedMs: 0,
        thresholdMs: 30 * 60_000,
      }),
    ]);
    const alert = overview.alerts.find(
      (entry: { id: number }) => entry.id === incidentId,
    );
    expect(alert).toMatchObject({
      id: incidentId,
      key: "container:ghost",
      resolvedAt: null,
      inhibitedBy: null,
      inhibitedReason: "container-absent",
      observationPending: true,
      delivery: { channel: "telegram", state: "pending" },
    });

    const detail = await (
      await api("GET", `/api/incidents/${incidentId}?host=nas-home`)
    ).json();
    expect(detail.incident).toMatchObject({
      id: incidentId,
      observationPending: true,
      inhibitedReason: "container-absent",
      delivery: { channel: "telegram", state: "pending" },
    });

    const appsOverview = await (
      await api("GET", "/api/overview?host=apps")
    ).json();
    expect(appsOverview.watchPending).toEqual([]);
    expect(
      appsOverview.alerts.some(
        (entry: { id: number }) => entry.id === incidentId,
      ),
    ).toBe(false);
  });

  it("keeps the original link working after a proven container rename", async () => {
    const start = Date.UTC(2026, 10, 26, 11);
    const oldId = "d".repeat(64);
    const incidentId = await openIncident("nas-home", "container:old");
    const { currentWatchWorkerId } = await import("@/lib/container-watch");
    const [settingsRow] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    await db
      .update(tables.configuration)
      .set({
        value: {
          ...settingsRow.value,
          expectedContainers: ["old"],
          watch: {
            revision: 1,
            workerId: currentWatchWorkerId(),
            lastInventoryAt: (start - 30_000) / 1000,
            chainAt: (start - 30_000) / 1000,
            entries: {},
            identities: {
              old: {
                containerId: oldId,
                composeProject: null,
                composeService: null,
              },
            },
          },
        },
      })
      .where(eq(tables.configuration.hostId, "nas-home"));
    const base = metrics("nas-home");
    agent.metricsBody = {
      ...base,
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [
        {
          ...base.containers[0],
          id: oldId,
          name: "new",
          state: "running",
          status: "Up 1 minute",
        },
      ],
    };
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    await collectHost(host, start);

    // The link carries the original episode id, not the old operational key.
    const response = await api(
      "GET",
      `/api/incidents/${incidentId}?host=nas-home`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      incident: {
        id: incidentId,
        key: "container:new",
        kind: "container",
        resolvedAt: expect.any(String),
      },
    });
    const events = (await db.select().from(tables.incidentEvents)).filter(
      (event) => event.incidentId === incidentId,
    );
    expect(events.map((event) => event.kind)).toEqual([
      "opened",
      "reassigned",
      "closed",
    ]);
    expect(
      (await db.select().from(tables.notificationOutbox)).filter(
        (notice) => notice.incidentId === incidentId,
      ),
    ).toHaveLength(1);
  });

  it("rejects internal watch metadata and keeps the watch while saving thresholds", async () => {
    const watch = {
      revision: 4,
      workerId: "test-worker",
      lastInventoryAt: 100,
      chainAt: 100,
      entries: {},
      identities: {},
    };
    await setSettingsValue("nas-home", {
      expectedContainers: ["sonarr"],
      watch,
    });
    const rejected = await api("POST", "/api/settings?host=nas-home", {
      body: {
        cpu: 70,
        memory: 75,
        disk: 80,
        temperature: 90,
        sustainedSeconds: 60,
        watch: { revision: 999 },
      },
      headers: { Origin: "http://localhost:3000" },
    });
    expect(rejected.status).toBe(400);

    const accepted = await api("POST", "/api/settings?host=nas-home", {
      body: {
        cpu: 70,
        memory: 75,
        disk: 80,
        temperature: 90,
        sustainedSeconds: 60,
      },
      headers: { Origin: "http://localhost:3000" },
    });
    expect(accepted.status).toBe(200);
    const body = await accepted.json();
    expect(body.settings).toMatchObject({
      cpu: 70,
      memory: 75,
      expectedContainers: ["sonarr"],
    });
    expect(body.settings.watch).toBeUndefined();
    const [stored] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(stored.value.watch).toMatchObject({ revision: 4 });
    const [appsRow] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "apps"));
    expect(appsRow.value.cpu).toBe(90);
  });

  it("preserves a concurrent threshold edit and the watch reconciliation", async () => {
    const start = Date.UTC(2026, 10, 26, 12);
    const { currentWatchWorkerId } = await import("@/lib/container-watch");
    await setSettingsValue("nas-home", {
      expectedContainers: ["sonarr"],
      watch: {
        revision: 1,
        workerId: currentWatchWorkerId(),
        lastInventoryAt: (start - 30_000) / 1000,
        chainAt: (start - 30_000) / 1000,
        entries: {
          sonarr: {
            identity: {
              containerId,
              composeProject: "media-stack",
              composeService: "sonarr",
            },
            absentSince: (start - 60_000) / 1000,
            observedAt: (start - 30_000) / 1000,
            accreditedMs: 0,
          },
        },
        identities: {
          sonarr: {
            containerId,
            composeProject: "media-stack",
            composeService: "sonarr",
          },
        },
      },
    });
    agent.metricsBody = freshMetrics(start, []);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;

    const [saved] = await Promise.all([
      api("POST", "/api/settings?host=nas-home", {
        body: {
          cpu: 71,
          memory: 72,
          disk: 73,
          temperature: 74,
          sustainedSeconds: 75,
        },
        headers: { Origin: "http://localhost:3000" },
      }),
      collectHost(host, start),
    ]);
    expect(saved.status).toBe(200);

    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.cpu).toBe(71);
    expect(row.value.memory).toBe(72);
    expect(row.value.expectedContainers).toEqual(["sonarr"]);
    expect(row.value.watch!.entries.sonarr).toMatchObject({
      accreditedMs: 30_000,
    });
  });

  it("ignores a collector reading started before a confirmed stop", async () => {
    const start = Date.UTC(2026, 10, 26, 13);
    const { getSettings } = await import("@/lib/settings");
    const incidentId = await openIncident("nas-home");
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    agent.metricsBody = freshMetrics(start, [
      { ...metrics("nas-home").containers[0], state: "exited" },
    ]);
    const query = pool.query.bind(pool);
    let stopped = false;
    // Stop after the collector has read the open episode and before it can
    // use that episode to bypass the sustained failure threshold.
    const intercept = vi.spyOn(pool, "query").mockImplementation((async (
      config: { text: string },
      values: unknown[],
    ) => {
      const result = await query(config, values);
      if (config.text.includes('"incidents"."key" like') && !stopped) {
        stopped = true;
        const response = await api("POST", "/api/action?host=nas-home", {
          body: { action: "stop", id: containerId },
          headers: {
            Origin: "http://localhost:3000",
            "Idempotency-Key": crypto.randomUUID(),
          },
        });
        expect(response.status).toBe(200);
      }
      return result;
    }) as typeof pool.query);

    try {
      await collectHost(host, start);
      expect(stopped).toBe(true);
    } finally {
      intercept.mockRestore();
    }

    const settings = await getSettings("nas-home");
    expect(settings.expectedContainers).toEqual([]);
    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident).toMatchObject({
      resolvedAt: expect.any(Date),
      closedBy: "lifecycle",
    });
    expect(
      (await db.select().from(tables.incidents)).filter(
        (row) => row.key === "container:sonarr" && row.resolvedAt === null,
      ),
    ).toHaveLength(0);
  });

  it("promotes a lost start response once from a later fresh inventory", async () => {
    const start = Date.UTC(2026, 10, 26, 14);
    const [operation] = await pendingOperation(
      "start",
      containerId,
      new Date(start),
    );
    await setSettingsValue("nas-home", {
      expectedContainers: [],
      watch: undefined,
    });
    agent.metricsBody = freshMetrics(start + 30_000, [
      metrics("nas-home").containers[0],
    ]);
    const host = getHosts().find((entry) => entry.id === "nas-home")!;

    await collectHost(host, start + 30_000);

    const [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual(["sonarr"]);
    expect(row.value.watch!.identities.sonarr).toMatchObject({
      containerId,
      composeProject: "media-stack",
      composeService: "sonarr",
    });
    const [updated] = await db
      .select()
      .from(tables.operations)
      .where(eq(tables.operations.id, operation.id));
    expect(updated).toMatchObject({
      status: "success",
      detail: "Estado comprobado en el inventario posterior.",
    });
  });

  it("adds the confirmed identity on start and clears a pending window on restart", async () => {
    const start = Date.UTC(2026, 10, 26, 17);
    const { currentWatchWorkerId } = await import("@/lib/container-watch");
    await setSettingsValue("nas-home", {
      expectedContainers: [],
      watch: undefined,
    });
    const started = await api("POST", "/api/action?host=nas-home", {
      body: { action: "start", id: containerId },
      headers: {
        Origin: "http://localhost:3000",
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    expect(started.status).toBe(200);
    let [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual(["sonarr"]);
    expect(row.value.watch!.identities.sonarr).toMatchObject({
      containerId,
      composeProject: "media-stack",
      composeService: "sonarr",
    });

    await setSettingsValue("nas-home", {
      expectedContainers: ["sonarr"],
      watch: {
        revision: 2,
        workerId: currentWatchWorkerId(),
        lastInventoryAt: start / 1000 - 30,
        chainAt: start / 1000 - 30,
        entries: {
          sonarr: {
            identity: {
              containerId,
              composeProject: "media-stack",
              composeService: "sonarr",
            },
            absentSince: start / 1000 - 60,
            observedAt: start / 1000 - 30,
            accreditedMs: 60_000,
          },
        },
        identities: {
          sonarr: {
            containerId,
            composeProject: "media-stack",
            composeService: "sonarr",
          },
        },
      },
    });
    const restarted = await api("POST", "/api/action?host=nas-home", {
      body: { action: "restart", id: containerId },
      headers: {
        Origin: "http://localhost:3000",
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    expect(restarted.status).toBe(200);
    [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual(["sonarr"]);
    expect(row.value.watch!.entries.sonarr).toBeUndefined();
    expect(row.value.watch!.revision).toBe(3);
  });

  it("keeps a restart pending when a later inventory still shows the running container", async () => {
    await setSettingsValue("nas-home", { expectedContainers: [] });
    agent.behaviour = "uncertain";
    const response = await api("POST", "/api/action?host=nas-home", {
      body: { action: "restart", id: containerId },
      headers: {
        Origin: "http://localhost:3000",
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    expect(response.status).toBe(502);
    const [operation] = await db.select().from(tables.operations);
    const now = operation.at.getTime() + 30_000;
    agent.metricsBody = freshMetrics(now, metrics("nas-home").containers);
    await collectHost(getHosts().find((host) => host.id === "nas-home")!, now);

    expect(await db.select().from(tables.operations)).toMatchObject([
      { id: operation.id, status: "pending" },
    ]);
    const { getSettings } = await import("@/lib/settings");
    expect((await getSettings("nas-home")).expectedContainers).toEqual([]);
  });

  it.each(["reject", "uncertain"] as const)(
    "keeps the confirmed result if the POST response is %s after collection",
    async (behaviour) => {
      await setSettingsValue("nas-home", { expectedContainers: [] });
      agent.behaviour = behaviour;
      const host = getHosts().find((entry) => entry.id === "nas-home")!;
      agent.beforeActionResponse = async () => {
        const [operation] = await db.select().from(tables.operations);
        const now = operation.at.getTime() + 60_000;
        agent.metricsBody = freshMetrics(now, metrics(host.id).containers);
        await collectHost(host, now);
      };

      const response = await api("POST", "/api/action?host=nas-home", {
        body: { action: "start", id: containerId },
        headers: {
          Origin: "http://localhost:3000",
          "Idempotency-Key": crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "success" });
      expect(await db.select().from(tables.operations)).toMatchObject([
        { status: "success" },
      ]);
    },
  );

  it("does not apply a collector confirmation after the operation is rejected", async () => {
    const start = Date.UTC(2026, 10, 28, 15);
    await setSettingsValue("nas-home", { expectedContainers: [] });
    const [operation] = await pendingOperation("start", containerId, new Date(start));
    const query = pool.query.bind(pool);
    let rejected = false;
    const intercept = vi.spyOn(pool, "query").mockImplementation((async (
      config: { text: string },
      values: unknown[],
    ) => {
      const result = await query(config, values);
      if (config.text.includes('"operations"."status" =') && !rejected) {
        rejected = true;
        await db.update(tables.operations).set({ status: "failed" })
          .where(eq(tables.operations.id, operation.id));
      }
      return result;
    }) as typeof pool.query);

    try {
      agent.metricsBody = freshMetrics(start + 30_000, metrics("nas-home").containers);
      await collectHost(getHosts().find((host) => host.id === "nas-home")!, start + 30_000);
      expect(rejected).toBe(true);
    } finally {
      intercept.mockRestore();
    }
    const { getSettings } = await import("@/lib/settings");
    expect((await getSettings("nas-home")).expectedContainers).toEqual([]);
    expect(await db.select().from(tables.operations)).toMatchObject([
      { id: operation.id, status: "failed" },
    ]);
  });

  it("waits for a post-operation list before confirming a lost stop and closes once", async () => {
    const start = Date.UTC(2026, 10, 26, 15);
    const incidentId = await openIncident("nas-home");
    const [operation] = await pendingOperation(
      "stop",
      containerId,
      new Date(start),
    );
    const stopped = {
      ...metrics("nas-home").containers[0],
      state: "exited",
      status: "Exited (0)",
      exitCode: 0,
    };
    const host = getHosts().find((entry) => entry.id === "nas-home")!;

    // A cached list from before the operation cannot confirm it.
    agent.metricsBody = freshMetrics(start - 10_000, [stopped]);
    await collectHost(host, start + 10_000);
    let [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual(["sonarr"]);
    let [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident.resolvedAt).toBeNull();
    let [current] = await db
      .select()
      .from(tables.operations)
      .where(eq(tables.operations.id, operation.id));
    expect(current.status).toBe("pending");

    agent.metricsBody = freshMetrics(start + 30_000, [stopped]);
    await collectHost(host, start + 30_000);
    [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual([]);
    [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident).toMatchObject({
      resolvedAt: expect.any(Date),
      closedBy: "lifecycle",
    });
    const eventsAfter = (
      await db.select().from(tables.incidentEvents)
    ).filter((event) => event.incidentId === incidentId);
    expect(
      eventsAfter.filter((event) => event.kind === "closed"),
    ).toHaveLength(1);

    // Repeating the confirmation neither changes the result nor closes again.
    agent.metricsBody = freshMetrics(start + 60_000, [stopped]);
    await collectHost(host, start + 60_000);
    const eventsRepeated = (
      await db.select().from(tables.incidentEvents)
    ).filter((event) => event.incidentId === incidentId);
    expect(eventsRepeated).toHaveLength(eventsAfter.length);
    [current] = await db
      .select()
      .from(tables.operations)
      .where(eq(tables.operations.id, operation.id));
    expect(current).toMatchObject({
      status: "success",
      detail: "Estado comprobado en el inventario posterior.",
    });
  });

  it.each(["start", "stop"] as const)(
    "reconciles a lost %s on an older agent only after the Docker cache window",
    async (action) => {
      const start = Date.UTC(2026, 10, 29, 15);
      const host = getHosts().find((entry) => entry.id === "nas-home")!;
      await setSettingsValue(host.id, {
        expectedContainers: action === "start" ? [] : ["sonarr"],
      });
      const [operation] = await pendingOperation(action, containerId, new Date(start));
      const snapshot = {
        ...metrics(host.id),
        containers: [{
          ...metrics(host.id).containers[0],
          state: action === "start" ? "running" : "exited",
        }],
      };
      agent.metricsBody = { ...snapshot, timestamp: (start + 5_000) / 1000 };
      await collectHost(host, start + 5_000);
      await collectHost(host, start + 20_000);
      expect(await db.select().from(tables.operations)).toMatchObject([
        { id: operation.id, status: "pending" },
      ]);

      agent.metricsBody = { ...snapshot, timestamp: (start + 21_000) / 1000 };
      await collectHost(host, start + 21_000);
      expect(await db.select().from(tables.operations)).toMatchObject([
        { id: operation.id, status: "success" },
      ]);
      const { getSettings } = await import("@/lib/settings");
      expect((await getSettings(host.id)).expectedContainers)
        .toEqual(action === "start" ? ["sonarr"] : []);
    },
  );

  it("keeps a removal unconfirmed until the inventory proves the absence", async () => {
    const start = Date.UTC(2026, 10, 26, 16);
    const incidentId = await openIncident("nas-home");
    const [operation] = await pendingOperation(
      "remove-container",
      "sonarr",
      new Date(start),
    );
    const stopped = {
      ...metrics("nas-home").containers[0],
      state: "exited",
      status: "Exited (0)",
      exitCode: 0,
    };
    const host = getHosts().find((entry) => entry.id === "nas-home")!;

    agent.metricsBody = freshMetrics(start + 10_000, [stopped]);
    await collectHost(host, start + 10_000);
    let [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual(["sonarr"]);
    let [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident.resolvedAt).toBeNull();
    let [current] = await db
      .select()
      .from(tables.operations)
      .where(eq(tables.operations.id, operation.id));
    expect(current.status).toBe("pending");

    agent.metricsBody = {
      ...metrics("nas-home"),
      timestamp: (start + 25_000) / 1000,
      containers: [],
    };
    await collectHost(host, start + 25_000);
    [current] = await db.select().from(tables.operations)
      .where(eq(tables.operations.id, operation.id));
    expect(current.status).toBe("pending");

    agent.metricsBody = freshMetrics(start + 30_000, []);
    await collectHost(host, start + 30_000);
    [row] = await db
      .select()
      .from(tables.configuration)
      .where(eq(tables.configuration.hostId, "nas-home"));
    expect(row.value.expectedContainers).toEqual([]);
    [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident).toMatchObject({
      resolvedAt: expect.any(Date),
      closedBy: "lifecycle",
    });
    [current] = await db
      .select()
      .from(tables.operations)
      .where(eq(tables.operations.id, operation.id));
    expect(current).toMatchObject({
      status: "success",
      detail: "El inventario posterior confirma que el contenedor ya no existe.",
    });
  });

  it("closes only the selected host's incident through the store after a confirmed stop", async () => {
    const nasIncident = await openIncident("nas-home");
    const appsIncident = await openIncident("apps");
    await markSent(nasIncident);

    const response = await api("POST", "/api/action?host=nas-home", {
      body: { action: "stop", id: containerId },
      headers: {
        Origin: "http://localhost:3000",
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    expect(response.status).toBe(200);

    const rows = await db.select().from(tables.incidents);
    const nas = rows.find((row) => row.id === nasIncident)!;
    const apps = rows.find((row) => row.id === appsIncident)!;
    expect(nas).toMatchObject({
      resolvedAt: expect.any(Date),
      seq: 2,
      closedBy: "lifecycle",
    });
    expect(apps).toMatchObject({
      resolvedAt: null,
      seq: 1,
      closedBy: null,
    });

    const events = await db.select().from(tables.incidentEvents);
    expect(
      events
        .filter((event) => event.incidentId === nasIncident)
        .map((event) => ({ kind: event.kind, seq: event.seq })),
    ).toEqual([
      { kind: "opened", seq: 1 },
      { kind: "closed", seq: 2 },
    ]);
    expect(
      events.filter((event) => event.incidentId === appsIncident),
    ).toHaveLength(1);

    const outbox = await db.select().from(tables.notificationOutbox);
    expect(
      outbox.find((row) => row.key === `incident:${nasIncident}:edit:2`),
    ).toMatchObject({
      kind: "incident-edit",
      channel: "telegram",
      status: "pending",
      revision: 2,
      chatId: "42",
      messageId: "9",
    });
    expect(
      outbox.find(
        (row) =>
          row.incidentId === appsIncident &&
          row.kind === "incident-open",
      ),
    ).toMatchObject({ status: "pending", channel: "telegram" });

    const settings = await db.select().from(tables.configuration);
    expect(
      settings.find((row) => row.hostId === "nas-home")?.value
        .expectedContainers,
    ).toEqual([]);
    expect(
      settings.find((row) => row.hostId === "apps")?.value.expectedContainers,
    ).toEqual(["sonarr"]);
  });

  it("keeps both incidents open when the stop is rejected or uncertain", async () => {
    const nasIncident = await openIncident("nas-home");
    const appsIncident = await openIncident("apps");

    agent.behaviour = "reject";
    const rejected = await api("POST", "/api/action?host=nas-home", {
      body: { action: "stop", id: containerId },
      headers: {
        Origin: "http://localhost:3000",
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    expect(rejected.status).toBe(400);

    agent.behaviour = "uncertain";
    const uncertain = await api("POST", "/api/action?host=apps", {
      body: { action: "stop", id: containerId },
      headers: {
        Origin: "http://localhost:3000",
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    expect(uncertain.status).toBe(502);

    const rows = await db.select().from(tables.incidents);
    expect(rows.every((row) => row.resolvedAt === null)).toBe(true);
    expect(rows.map((row) => row.seq)).toEqual([1, 1]);
    expect(
      (await db.select().from(tables.incidentEvents)).every(
        (event) => event.kind === "opened",
      ),
    ).toBe(true);
    expect(
      (await db.select().from(tables.notificationOutbox)).every(
        (row) => row.status === "pending",
      ),
    ).toBe(true);
    expect(rows.map((row) => row.id)).toEqual([nasIncident, appsIncident]);
  });

  it("queues the push test for the session owner without contacting a provider", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const response = await api("POST", "/api/push/test", {
        body: { ownerUserId: "another-user" },
        headers: { Origin: "http://localhost:3000" },
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ ok: true, queued: true });

      const [job] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.kind, "push-test"));
      expect(job).toMatchObject({
        kind: "push-test",
        channel: "push",
        status: "pending",
        ownerUserId: "test-user",
        incidentId: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(agent.requests).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("projects the latest digest target globally with a finite reason", async () => {
    const now = Date.now();
    const secret = "payload-secreto-que-no-debe-salir";
    const target = (offset: number) => new Date(now + offset);
    // The older date is rewritten last: ordering must follow the target, not
    // the last write, and the newest target is the failed one.
    await db.insert(tables.digestRuns).values([
      {
        date: "2026-11-24",
        targetAt: target(-2 * 86_400_000),
        periodStartAt: target(-3 * 86_400_000),
        dueAt: target(-2 * 86_400_000 + 2 * 3_600_000),
        status: "sent",
        reason: "digest_sent",
        payload: "resumen antiguo",
        updatedAt: target(0),
      },
      {
        date: "2026-11-25",
        targetAt: target(-86_400_000),
        periodStartAt: target(-2 * 86_400_000),
        dueAt: target(-86_400_000 + 2 * 3_600_000),
        status: "sent",
        reason: "digest_sent",
        payload: "resumen de ayer",
        updatedAt: target(-86_400_000),
      },
      {
        date: "2026-11-26",
        targetAt: target(-60_000),
        periodStartAt: target(-86_400_000),
        dueAt: target(-60_000 + 2 * 3_600_000),
        status: "failed",
        reason: "telegram_401",
        payload: secret,
        updatedAt: target(-10 * 86_400_000),
      },
    ]);

    const response = await api("GET", "/api/overview?host=nas-home");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.digest).toEqual({
      date: "2026-11-26",
      targetAt: target(-60_000).toISOString(),
      status: "failed",
      reason: "telegram_401",
    });
    // The frozen payload never crosses the public projection.
    expect(JSON.stringify(body)).not.toContain(secret);

    // The projection is global: another host sees the same digest date.
    const other = await (
      await api("GET", "/api/overview?host=apps")
    ).json();
    expect(other.host.id).toBe("apps");
    expect(other.digest).toEqual(body.digest);
  });

  it("drops an unknown digest reason, keeps a prepared claim pending and reports zero history", async () => {
    const now = Date.now();
    const empty = await (await api("GET", "/api/overview")).json();
    expect(empty.digest).toBeNull();

    await db.insert(tables.digestRuns).values({
      date: "2026-11-26",
      targetAt: new Date(now - 30_000),
      periodStartAt: new Date(now - 86_400_000),
      dueAt: new Date(now + 6_000_000),
      status: "claimed",
      reason: "provider_body_never_public",
      payload: "texto privado",
    });
    const pending = await (await api("GET", "/api/overview")).json();
    expect(pending.digest).toMatchObject({
      date: "2026-11-26",
      status: "pending",
      reason: null,
    });
    expect(JSON.stringify(pending)).not.toContain("provider_body_never_public");
    expect(JSON.stringify(pending)).not.toContain("texto privado");
  });

  it("keeps the digest projection behind a session", async () => {
    await db.insert(tables.digestRuns).values({
      date: "2026-11-26",
      targetAt: new Date(Date.now() - 30_000),
      periodStartAt: new Date(Date.now() - 86_400_000),
      dueAt: new Date(Date.now() + 6_000_000),
      status: "failed",
      reason: "telegram_401",
      payload: "texto que no debe salir sin sesión",
    });
    sessionState.authenticated = false;
    const response = await api("GET", "/api/overview");
    expect(response.status).toBe(401);
    const raw = await response.text();
    expect(raw).not.toContain("digest");
    expect(raw).not.toContain("texto que no debe salir");
  });

  const hubOrigin = { Origin: "http://localhost:3000" };

  function hubAction(
    incidentId: number | string,
    action: "acknowledge" | "snooze" | "unsnooze",
    body: unknown,
    headers: Record<string, string> = hubOrigin,
  ) {
    return api("POST", `/api/incidents/${incidentId}/${action}`, {
      body,
      headers,
    });
  }

  async function incidentEvents(incidentId: number) {
    return (await db.select().from(tables.incidentEvents)).filter(
      (event) => event.incidentId === incidentId,
    );
  }

  async function silenceOf(hostId: string, key: string) {
    const [row] = await db
      .select()
      .from(tables.incidentSnoozes)
      .where(
        and(
          eq(tables.incidentSnoozes.hostId, hostId),
          eq(tables.incidentSnoozes.key, key),
        ),
      );
    return row ?? null;
  }

  it("applies acknowledge, snooze and unsnooze from the hub once per state", async () => {
    const incidentId = await openIncident("nas-home");
    await markSent(incidentId);

    const before = Date.now();
    const acknowledged = await hubAction(incidentId, "acknowledge", {
      host: "nas-home",
    });
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toMatchObject({
      outcome: "applied",
      incident: {
        id: incidentId,
        acknowledged: { via: "hub", by: "Test" },
        snooze: null,
      },
    });
    const [acked] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(acked).toMatchObject({
      acknowledgedVia: "hub",
      acknowledgedBy: "Test",
      seq: 2,
    });
    expect(acked.acknowledgedAt).toBeInstanceOf(Date);

    const repeated = await hubAction(incidentId, "acknowledge", {
      host: "nas-home",
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ outcome: "unchanged" });

    const snoozed = await hubAction(incidentId, "snooze", {
      host: "nas-home",
      hours: 24,
    });
    expect(snoozed.status).toBe(200);
    expect(await snoozed.json()).toMatchObject({
      outcome: "applied",
      incident: { snooze: { via: "hub" } },
    });
    const after = Date.now();
    const silence = await silenceOf("nas-home", containerKey);
    expect(silence).toMatchObject({ setVia: "hub", setBy: "Test" });
    expect(silence!.until.getTime()).toBeGreaterThanOrEqual(
      before + 86_400_000,
    );
    expect(silence!.until.getTime()).toBeLessThanOrEqual(after + 86_400_000);

    const repeatedSnooze = await hubAction(incidentId, "snooze", {
      host: "nas-home",
      hours: 24,
    });
    expect(repeatedSnooze.status).toBe(200);
    expect(await repeatedSnooze.json()).toMatchObject({ outcome: "unchanged" });

    const cleared = await hubAction(incidentId, "unsnooze", {
      host: "nas-home",
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      outcome: "applied",
      incident: { snooze: null },
    });
    expect(await silenceOf("nas-home", containerKey)).toBeNull();

    const edits = (await db.select().from(tables.notificationOutbox)).filter(
      (row) => row.kind === "incident-edit",
    );
    expect(edits.map((row) => row.revision).sort()).toEqual([2, 3, 4]);
    expect((await incidentEvents(incidentId)).map((event) => event.kind))
      .toEqual(["opened", "acknowledged", "snoozed", "unsnoozed"]);
  });

  it("queues no edit when the episode never had a Telegram notice", async () => {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "condition:disk",
      failing: true,
      severity: "warning",
      title: "Disco lleno",
      detail: "",
      now: Date.now(),
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    const incidentId = opened.incidentId!;

    const response = await hubAction(incidentId, "acknowledge", {
      host: "nas-home",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "applied" });
    expect(
      (await db.select().from(tables.notificationOutbox)).filter(
        (row) => row.kind === "incident-edit",
      ),
    ).toHaveLength(0);
  });

  it("never acts on another host's episode", async () => {
    const nasIncident = await openIncident("nas-home");
    const appsIncident = await openIncident("apps");
    await markSent(appsIncident);
    const rowsBefore = (await db.select().from(tables.incidents)).map((row) => [
      row.id,
      row.seq,
      row.acknowledgedAt,
    ]);
    const outboxBefore = await db.select().from(tables.notificationOutbox);

    expect(
      (await hubAction(appsIncident, "acknowledge", { host: "nas-home" }))
        .status,
    ).toBe(404);
    expect(
      (await hubAction(999_999, "acknowledge", { host: "nas-home" })).status,
    ).toBe(404);
    expect(
      (await hubAction(nasIncident, "acknowledge", { host: "ghost" })).status,
    ).toBe(404);

    expect(
      (await db.select().from(tables.incidents)).map((row) => [
        row.id,
        row.seq,
        row.acknowledgedAt,
      ]),
    ).toEqual(rowsBefore);
    expect(await db.select().from(tables.incidentSnoozes)).toHaveLength(0);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(
      outboxBefore.length,
    );
    expect(await incidentEvents(appsIncident)).toHaveLength(1);
  });

  it("refuses a resolved episode and any body outside the contract", async () => {
    const incidentId = await openIncident("nas-home");
    await store.recordIncidentObservation({
      hostId: "nas-home",
      key: containerKey,
      failing: false,
      now: Date.now(),
    });
    const eventsBefore = await incidentEvents(incidentId);
    const outboxBefore = await db.select().from(tables.notificationOutbox);

    expect(
      (await hubAction(incidentId, "acknowledge", { host: "nas-home" })).status,
    ).toBe(409);

    const invalid: unknown[] = [
      { host: "nas-home", extra: true },
      {},
      { host: "" },
      { host: "nas-home", hours: 6 },
      { host: "nas-home", hours: 1, other: "x" },
      { hours: 1 },
    ];
    for (const body of invalid) {
      expect((await hubAction(incidentId, "snooze", body)).status).toBe(400);
    }
    expect(
      (await hubAction(incidentId, "acknowledge", { host: "nas-home", hours: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await hubAction(incidentId, "unsnooze", { host: "nas-home", hours: 24 }))
        .status,
    ).toBe(400);

    expect(await db.select().from(tables.incidentSnoozes)).toHaveLength(0);
    expect(await incidentEvents(incidentId)).toHaveLength(eventsBefore.length);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(
      outboxBefore.length,
    );
  });

  it("requires a session and an allowed origin for the hub actions", async () => {
    const incidentId = await openIncident("nas-home");

    expect(
      (
        await hubAction(
          incidentId,
          "acknowledge",
          { host: "nas-home" },
          { Origin: "http://evil.example" },
        )
      ).status,
    ).toBe(403);

    sessionState.authenticated = false;
    expect(
      (await hubAction(incidentId, "acknowledge", { host: "nas-home" })).status,
    ).toBe(401);
    sessionState.authenticated = true;

    const [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(row.acknowledgedAt).toBeNull();
    expect(await db.select().from(tables.incidentSnoozes)).toHaveLength(0);
  });

  it("publishes the hub state and a silence-held opening without Telegram identifiers", async () => {
    const incidentId = await openIncident("nas-home");
    await markSent(incidentId);
    expect(
      (await hubAction(incidentId, "acknowledge", { host: "nas-home" })).status,
    ).toBe(200);
    expect(
      (await hubAction(incidentId, "snooze", { host: "nas-home", hours: 1 }))
        .status,
    ).toBe(200);

    const detail = await (
      await api("GET", `/api/incidents/${incidentId}?host=nas-home`)
    ).json();
    expect(detail.incident).toMatchObject({
      acknowledged: { via: "hub", by: "Test" },
      snooze: { via: "hub" },
    });
    expect(
      new Date(detail.incident.snooze.until).getTime(),
    ).toBeGreaterThan(Date.now());
    const published = JSON.stringify(detail.incident);
    expect(published).not.toContain("chatId");
    expect(published).not.toContain("messageId");
    expect(published).not.toContain("setBy");
    expect(published).not.toContain("api.telegram.org");

    // A live silence withholds a new opening and the hub publishes the reason.
    await db.insert(tables.incidentSnoozes).values({
      hostId: "nas-home",
      key: "condition:silencio",
      until: new Date(Date.now() + 3_600_000),
      setAt: new Date(),
      setVia: "hub",
      setBy: "Test",
    });
    const held = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "condition:silencio",
      failing: true,
      severity: "warning",
      title: "Condición silenciada",
      detail: "",
      now: Date.now(),
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    const heldDetail = await (
      await api("GET", `/api/incidents/${held.incidentId}?host=nas-home`)
    ).json();
    expect(heldDetail.incident).toMatchObject({
      id: held.incidentId,
      delivery: {
        channel: "telegram",
        state: "suppressed",
        reason: "snoozed",
      },
      acknowledged: null,
      snooze: { via: "hub" },
    });

    const overview = await (
      await api("GET", "/api/overview?host=nas-home")
    ).json();
    expect(
      overview.alerts.find(
        (alert: { id: number }) => alert.id === held.incidentId,
      ),
    ).toMatchObject({
      delivery: { reason: "snoozed" },
      snooze: { via: "hub" },
    });
  });
});
