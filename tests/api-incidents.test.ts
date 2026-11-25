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
    await db.delete(tables.incidents);
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
});
