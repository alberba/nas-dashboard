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

const session = vi.hoisted(() => ({
  value: {
    user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
    session: { id: "test-session" },
  } as {
    user: { id: string; name: string; email: string };
    session: { id: string };
  } | null,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => session.value) } },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));

type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
};
type Behaviour = "ok" | "reject" | "uncertain" | "invalid" | "echo-secret";

type FakeAgent = {
  url: string;
  token: string;
  requests: RecordedRequest[];
  behaviour: Behaviour;
  reset(): void;
  close(): Promise<void>;
};

const SECRET = "value-that-must-never-be-returned";

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
    reset() {
      agent.requests = [];
      agent.behaviour = "ok";
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
    if (path !== "/deployments/settings") {
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
          error: `La variable falló con el valor ${SECRET}`,
        }),
      );
      return;
    }
    if (agent.behaviour === "invalid") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ release: "v2.5.0" }));
      return;
    }
    const values = (body as { values?: Record<string, string> }).values ?? {};
    const saved = Object.keys(values);
    if (agent.behaviour === "echo-secret") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          release: (body as { release: string }).release,
          saved: [...saved, SECRET],
          missingSettings: [],
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        release: (body as { release: string }).release,
        saved,
        missingSettings: [],
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

describe.skipIf(!baseUrl)("deployment settings API", () => {
  let context: TestDatabase;
  let nas: FakeAgent;
  let secondary: FakeAgent;
  let apps: FakeAgent;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
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

  async function verify() {
    await db.insert(tables.recentVerification).values({
      sessionId: "test-session",
      userId: "test-user",
      method: "passkey",
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
    });
  }

  const body = {
    release: "v2.5.0",
    values: { NEW_SETTING: "value", SECRET_SETTING: SECRET },
    acknowledgedManualSteps: true,
  };

  beforeAll(async () => {
    nas = await fakeAgent("a".repeat(32));
    secondary = await fakeAgent("c".repeat(32));
    apps = await fakeAgent("b".repeat(32));
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: nas.url,
        token: nas.token,
      },
      {
        id: "nas-secondary",
        name: "NAS-SECONDARY",
        role: "instance",
        url: secondary.url,
        token: secondary.token,
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
    tables = await import("@/lib/schema");
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
    await nas.close();
    await secondary.close();
    await apps.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(async () => {
    session.value = {
      user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
      session: { id: "test-session" },
    };
    await db.delete(tables.operations);
    await db.delete(tables.recentVerification);
    await db.delete(tables.samples);
    await sample("nas-home");
    await sample("nas-secondary");
    await sample("apps");
    await verify();
    nas.reset();
    secondary.reset();
    apps.reset();
  });

  it("requires an authenticated session", async () => {
    session.value = null;

    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(401);
    expect(nas.requests).toEqual([]);
  });

  it("requires a recent verification before calling the agent", async () => {
    await db.delete(tables.recentVerification);

    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "recent_verification_required",
      reason: "missing",
      method: "passkey",
    });
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("requires an allowed origin", async () => {
    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      {
        Origin: "https://evil.invalid",
        "Idempotency-Key": crypto.randomUUID(),
      },
    );

    expect(response.status).toBe(403);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("saves the settings through the instance agent and records names only", async () => {
    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      status: "success",
      result: {
        release: "v2.5.0",
        saved: ["NEW_SETTING", "SECRET_SETTING"],
      },
      operation: {
        hostId: "nas-home",
        action: "deployment-settings",
        target: "NAS-HOME",
        status: "success",
      },
    });
    expect(nas.requests).toEqual([
      {
        method: "POST",
        path: "/deployments/settings",
        body,
      },
    ]);
    expect(secondary.requests).toEqual([]);
    expect(apps.requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(nas.token);
    const [operation] = await db.select().from(tables.operations);
    expect(operation).toMatchObject({
      id: result.operation.id,
      hostId: "nas-home",
      userId: "test-user",
      action: "deployment-settings",
      target: "NAS-HOME",
      status: "success",
    });
    expect(JSON.stringify(operation)).not.toContain(SECRET);
  });

  it("refuses to write settings on an apps server", async () => {
    const response = await api(
      "/api/deployments/settings?host=apps",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty("operation");
    expect(apps.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("replays an idempotency key without writing twice", async () => {
    const key = crypto.randomUUID();
    const first = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": key },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const replay = await api(
      "/api/deployments/settings?host=nas-home",
      { ...body, values: { NEW_SETTING: "changed" } },
      { "Idempotency-Key": key },
    );

    expect(replay.status).toBe(200);
    expect((await replay.json()).operation.id).toBe(firstBody.operation.id);
    expect(nas.requests).toHaveLength(1);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
  });

  it("refuses to reuse an idempotency key on another instance", async () => {
    const key = crypto.randomUUID();
    const first = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": key },
    );
    expect(first.status).toBe(200);

    const other = await api(
      "/api/deployments/settings?host=nas-secondary",
      body,
      { "Idempotency-Key": key },
    );

    expect(other.status).toBe(409);
    expect(secondary.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
  });

  it("records an agent rejection as failed and never leaks its message", async () => {
    nas.behaviour = "reject";

    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(nas.requests).toHaveLength(1);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("failed");
    expect(JSON.stringify(operation)).not.toContain(SECRET);
  });

  it("leaves an incomplete agent response pending without reporting success", async () => {
    nas.behaviour = "invalid";

    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).status).toBe("pending");
    expect(nas.requests).toHaveLength(1);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("pending");
  });

  it("leaves an uncertain result pending and never sends it again", async () => {
    nas.behaviour = "uncertain";
    const key = crypto.randomUUID();

    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": key },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).status).toBe("pending");
    expect(nas.requests).toHaveLength(1);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("pending");
    expect(JSON.stringify(operation)).not.toContain(SECRET);

    nas.behaviour = "ok";
    const retry = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": key },
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).operation.status).toBe("pending");
    expect(nas.requests).toHaveLength(1);
  });

  it("refuses to call a host that is not connected", async () => {
    await db.delete(tables.samples);

    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(503);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("drops names the agent adds outside the request and never echoes values", async () => {
    nas.behaviour = "echo-secret";

    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.result.saved).toEqual(["NEW_SETTING", "SECRET_SETTING"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("success");
    expect(JSON.stringify(operation)).not.toContain(SECRET);
  });

  it.each([
    ["extra field", { ...body, extra: true }],
    ["empty values", { ...body, values: {} }],
    ["invalid release", { ...body, release: "2.5.0" }],
    ["invalid name", { ...body, values: { "lower-case": "value" } }],
    ["control characters", { ...body, values: { NEW_SETTING: "a\nb" } }],
    ["bad acknowledgement", { ...body, acknowledgedManualSteps: "yes" }],
  ])("rejects an invalid body (%s) without calling the agent", async (_label, value) => {
    const response = await api(
      "/api/deployments/settings?host=nas-home",
      value,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("requires an Idempotency-Key", async () => {
    const response = await api(
      "/api/deployments/settings?host=nas-home",
      body,
    );

    expect(response.status).toBe(400);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("rejects an unknown host without calling any agent", async () => {
    const response = await api(
      "/api/deployments/settings?host=ghost",
      body,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(404);
    expect(nas.requests).toEqual([]);
    expect(secondary.requests).toEqual([]);
    expect(apps.requests).toEqual([]);
  });
});
