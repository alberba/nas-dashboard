import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
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
import { AGENT_RESPONSE_LIMITS } from "@/lib/nas";
import { seedVerifiedSession } from "./verified-session";

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
        session: { id: "test-session" },
      })),
      verifyPassword: vi.fn(),
    },
  },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));

type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
};
type Behaviour = "ok" | "reject" | "uncertain" | "oversized";

type FakeAgent = {
  url: string;
  token: string;
  requests: RecordedRequest[];
  behaviour: Behaviour;
  recreate: boolean;
  metricsBody: unknown;
  reset(): void;
  close(): Promise<void>;
};

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
    containers: [],
  };
}

async function fakeAgent(token: string): Promise<FakeAgent> {
  const agent = {
    url: "",
    token,
    requests: [] as RecordedRequest[],
    behaviour: "ok" as Behaviour,
    recreate: false,
    metricsBody: null as unknown,
    reset() {
      agent.requests = [];
      agent.behaviour = "ok";
      agent.recreate = false;
      agent.metricsBody = null;
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
    const body = raw ? JSON.parse(raw) : undefined;
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
    if (path !== "/action") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "No encontrado" }));
      return;
    }
    agent.requests.push({ method: request.method ?? "", path, body });
    if (agent.behaviour === "uncertain") {
      response.destroy();
      return;
    }
    if (agent.behaviour === "reject") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: "El contenedor debe estar detenido",
        }),
      );
      return;
    }
    if (agent.behaviour === "oversized") {
      // A well-formed success whose body does not fit the cap of a POST answer.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          state: "stopped",
          padding: "x".repeat(AGENT_RESPONSE_LIMITS.post),
        }),
      );
      return;
    }
    if ((body as { action?: string }).action === "update-container") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          state: "updated",
          name: "jellyfin",
          service: "jellyfin",
          image: "lscr.io/linuxserver/jellyfin:latest",
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        state: "removed",
        name: (body as { confirmation: string }).confirmation,
        composeProject: agent.recreate ? "media-stack" : null,
        composeService: agent.recreate ? "sonarr" : null,
        recreateOnCompose: agent.recreate,
        volumesRemoved: false,
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

const baseUrl = testDatabaseUrl();
const containerId = "a".repeat(64);

describe.skipIf(!baseUrl)("container removal API", () => {
  let context: TestDatabase;
  let agent: FakeAgent;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    const request = new NextRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return routes.POST(request, {
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

  async function seedContainerIncident(hostId: string, sent: boolean) {
    const opened = await store.recordIncidentObservation({
      hostId,
      key: "container:sonarr",
      failing: true,
      severity: "critical",
      title: `Servicio detenido en ${hostId}: sonarr`,
      detail: "",
      now: Date.now(),
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    if (sent) {
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
        .where(eq(tables.notificationOutbox.incidentId, opened.incidentId!));
    }
    return opened.incidentId!;
  }

  beforeAll(async () => {
    agent = await fakeAgent("a".repeat(32));
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: agent.url,
        token: agent.token,
      },
      {
        id: "apps",
        name: "Apps",
        role: "apps-server",
        url: agent.url,
        token: agent.token,
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
    await db.insert(tables.user).values({
      id: "test-user",
      name: "Test",
      email: "test@hub.invalid",
    });
    await db.insert(tables.session).values({
      id: "test-session",
      token: "test-session-token",
      expiresAt: new Date(Date.now() + 86_400_000),
      userId: "test-user",
    });
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await agent.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(async () => {
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
    await db.delete(tables.operations);
    await db.delete(tables.samples);
    await db.delete(tables.configuration);
    await db.delete(tables.recentVerification);
    await sample("nas-home");
    await sample("apps");
    await seedVerifiedSession(db, tables);
    agent.reset();
  });

  it("requires a recent verification before recording or sending a removal", async () => {
    await db.delete(tables.recentVerification);
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "homarr-v2-native-preview" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "recent_verification_required",
      reason: "missing",
      method: "passkey",
    });
    expect(agent.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("removes a stopped container on the selected host and records the operation", async () => {
    agent.recreate = true;
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "sonarr" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      status: "success",
      result: {
        name: "sonarr",
        recreateOnCompose: true,
        volumesRemoved: false,
      },
    });
    expect(agent.requests).toEqual([
      {
        method: "POST",
        path: "/action",
        body: {
          action: "remove-container",
          id: containerId,
          confirmation: "sonarr",
        },
      },
    ]);
    const [operation] = await db.select().from(tables.operations);
    expect(operation).toMatchObject({
      id: result.operation.id,
      hostId: "nas-home",
      action: "remove-container",
      target: `sonarr:${containerId}`,
      status: "success",
    });
  });

  it("scopes operations to the selected host", async () => {
    const response = await api(
      "/api/containers/remove?host=apps",
      { id: containerId, confirmation: "old-preview" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(200);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.hostId).toBe("apps");
  });

  it("closes only the selected host's container incident after a confirmed removal", async () => {
    const nasIncident = await seedContainerIncident("nas-home", true);
    const appsIncident = await seedContainerIncident("apps", false);
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "sonarr" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(200);
    const incidents = await db
      .select()
      .from(tables.incidents)
      .orderBy(tables.incidents.id);
    const nas = incidents.find((row) => row.id === nasIncident)!;
    const apps = incidents.find((row) => row.id === appsIncident)!;
    expect(nas).toMatchObject({ resolvedAt: expect.any(Date), seq: 2, closedBy: "lifecycle" });
    expect(apps).toMatchObject({ resolvedAt: null, seq: 1, closedBy: null });

    const events = await db.select().from(tables.incidentEvents);
    expect(
      events
        .filter((event) => event.incidentId === nasIncident)
        .map((event) => event.kind)
        .sort(),
    ).toEqual(["closed", "opened"]);
    expect(
      events.find(
        (event) => event.incidentId === nasIncident && event.kind === "closed",
      )!.seq,
    ).toBe(2);
    expect(
      events
        .filter((event) => event.incidentId === appsIncident)
        .map((event) => event.kind),
    ).toEqual(["opened"]);

    const outbox = await db.select().from(tables.notificationOutbox);
    expect(
      outbox.find(
        (row) => row.incidentId === nasIncident && row.kind === "incident-open",
      ),
    ).toMatchObject({ status: "sent", chatId: "42", messageId: "9" });
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
    expect(outbox.find((row) => row.incidentId === appsIncident)).toMatchObject({
      status: "pending",
      channel: "telegram",
    });
  });

  it("records the hub channel and the session user on an operation from /api/action", async () => {
    const response = await api(
      "/api/action?host=nas-home",
      { action: "update-container", id: containerId },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(200);
    const [operation] = await db.select().from(tables.operations);
    expect(operation).toMatchObject({
      channel: "hub",
      requestedBy: "test-user",
      userId: "test-user",
    });
  });

  it("updates a container image on the selected host and records the operation", async () => {
    const response = await api(
      "/api/action?host=nas-home",
      { action: "update-container", id: containerId },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "success",
      result: { state: "updated", name: "jellyfin" },
    });
    expect(agent.requests).toEqual([
      {
        method: "POST",
        path: "/action",
        body: { action: "update-container", id: containerId },
      },
    ]);
    const [operation] = await db.select().from(tables.operations);
    expect(operation).toMatchObject({
      hostId: "nas-home",
      action: "update-container",
      target: containerId,
      status: "success",
    });
  });

  it("replays an idempotency key without deleting twice or across hosts", async () => {
    const key = crypto.randomUUID();
    const body = { id: containerId, confirmation: "old-preview" };
    const first = await api("/api/containers/remove?host=nas-home", body, {
      "Idempotency-Key": key,
    });
    expect(first.status).toBe(200);

    const replay = await api(
      "/api/containers/remove?host=nas-home",
      { id: "b".repeat(64), confirmation: "another-preview" },
      { "Idempotency-Key": key },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).operation.id).toBe(
      (await first.clone().json()).operation.id,
    );

    const otherHost = await api(
      "/api/containers/remove?host=apps",
      body,
      { "Idempotency-Key": key },
    );
    expect(otherHost.status).toBe(409);
    expect(agent.requests).toHaveLength(1);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
  });

  it("records an agent rejection once and never retries it", async () => {
    const incidentId = await seedContainerIncident("nas-home", true);
    agent.behaviour = "reject";
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "old-preview" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).status).toBe("failed");
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("failed");
    expect(operation.detail).toEqual(expect.any(String));
    expect(agent.requests).toHaveLength(1);
    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident).toMatchObject({ resolvedAt: null, seq: 1, closedBy: null });
    expect(await db.select().from(tables.incidentEvents)).toHaveLength(1);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(1);
  });

  it("leaves an uncertain result pending and does not send it again", async () => {
    const incidentId = await seedContainerIncident("nas-home", true);
    agent.behaviour = "uncertain";
    const key = crypto.randomUUID();
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "old-preview" },
      { "Idempotency-Key": key },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).status).toBe("pending");
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("pending");

    agent.behaviour = "ok";
    const retry = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "old-preview" },
      { "Idempotency-Key": key },
    );
    expect(retry.status).toBe(200);
    expect(agent.requests).toHaveLength(1);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident).toMatchObject({ resolvedAt: null, seq: 1, closedBy: null });
    expect(await db.select().from(tables.incidentEvents)).toHaveLength(1);
    expect(await db.select().from(tables.notificationOutbox)).toHaveLength(1);
  });

  it("leaves an action answered over the cap pending and does not send it again", async () => {
    agent.behaviour = "oversized";
    const key = crypto.randomUUID();
    const body = { action: "stop", id: containerId };

    const response = await api("/api/action?host=nas-home", body, {
      "Idempotency-Key": key,
    });

    // Over the cap is a broken contract, not a rejection: the action may have
    // run, so it stays pending instead of being recorded as failed.
    expect(response.status).toBe(502);
    expect((await response.json()).status).toBe("pending");
    const [operation] = await db.select().from(tables.operations);
    expect(operation).toMatchObject({ action: "stop", status: "pending" });

    agent.behaviour = "ok";
    const retry = await api("/api/action?host=nas-home", body, {
      "Idempotency-Key": key,
    });
    expect(retry.status).toBe(200);
    expect(agent.requests).toHaveLength(1);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
  });

  it("reconciles a lost removal response using the ID recorded by the POST", async () => {
    const incidentId = await seedContainerIncident("nas-home", false);
    const { collectHost } = await import("@/lib/collector");
    const { getHosts } = await import("@/lib/hosts");
    const { metricsSnapshot } = await import("./host-fixtures");
    agent.behaviour = "uncertain";
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "sonarr" },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      operation: { target: "sonarr", status: "pending" },
    });
    const [operation] = await db.select().from(tables.operations);
    const start = operation.at.getTime() + 20_000;
    const host = getHosts().find((entry) => entry.id === "nas-home")!;
    agent.metricsBody = metricsSnapshot({
      timestamp: start / 1000,
      containersObservedAt: start / 1000,
      containers: [{
        ...metricsSnapshot().containers[0],
        id: containerId,
        name: "renamed",
        state: "exited",
      }],
    });
    await collectHost(host, start);
    expect(await db.select().from(tables.operations)).toMatchObject([
      { id: operation.id, status: "pending" },
    ]);

    agent.metricsBody = metricsSnapshot({
      timestamp: (start + 10_000) / 1000,
      containersObservedAt: (start + 10_000) / 1000,
      containers: [],
    });
    await collectHost(host, start + 10_000);
    expect(await db.select().from(tables.operations)).toMatchObject([
      { id: operation.id, status: "success" },
    ]);
    const [incident] = await db.select().from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    expect(incident).toMatchObject({
      resolvedAt: expect.any(Date),
      closedBy: "lifecycle",
    });
    expect(agent.requests.filter((request) => request.path === "/action")).toHaveLength(1);
  });

  it("refuses an action when the host is not connected", async () => {
    await db.delete(tables.samples);
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "old-preview" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(503);
    expect(agent.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("rejects a body that tries to remove volumes", async () => {
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "old-preview", removeVolumes: true },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    expect(agent.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("requires an allowed origin", async () => {
    const response = await api(
      "/api/containers/remove?host=nas-home",
      { id: containerId, confirmation: "old-preview" },
      {
        Origin: "https://evil.invalid",
        "Idempotency-Key": crypto.randomUUID(),
      },
    );

    expect(response.status).toBe(403);
    expect(agent.requests).toEqual([]);
  });
});
