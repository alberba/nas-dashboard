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
  } as {
    user: { id: string; name: string; email: string };
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
type Behaviour = "ok" | "reject" | "uncertain" | "invalid";

type FakeAgent = {
  url: string;
  token: string;
  requests: RecordedRequest[];
  behaviour: Behaviour;
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
    if (path !== "/command") {
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
      response.end(JSON.stringify({ error: "La unidad no está configurada" }));
      return;
    }
    if (agent.behaviour === "invalid") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ command: "deploy-now" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        command: (body as { command: string }).command,
        status: "success",
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
const commands = [
  "deploy-now",
  "pause-follower",
  "resume-follower",
  "run-security",
];

describe.skipIf(!baseUrl)("host command API", () => {
  let context: TestDatabase;
  let nas: FakeAgent;
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

  beforeAll(async () => {
    nas = await fakeAgent("a".repeat(32));
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
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await nas.close();
    await apps.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(async () => {
    session.value = {
      user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
    };
    await db.delete(tables.operations);
    await db.delete(tables.samples);
    await sample("nas-home");
    await sample("apps");
    nas.reset();
    apps.reset();
  });

  it("requires an authenticated session", async () => {
    session.value = null;

    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "deploy-now" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(401);
    expect(nas.requests).toEqual([]);
  });

  it.each(commands)(
    "forwards the whitelisted command %s to the selected host and records success",
    async (command) => {
      const response = await api(
        "/api/host-command?host=apps",
        { command },
        { "Idempotency-Key": crypto.randomUUID() },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: "success",
        result: { command, status: "success" },
        operation: {
          hostId: "apps",
          action: command,
          target: "Apps",
          status: "success",
        },
      });
      expect(apps.requests).toEqual([
        { method: "POST", path: "/command", body: { command } },
      ]);
      expect(nas.requests).toEqual([]);
      expect(JSON.stringify(body)).not.toContain(apps.token);
      expect(JSON.stringify(body)).not.toContain("127.0.0.1");
      const [operation] = await db.select().from(tables.operations);
      expect(operation).toMatchObject({
        id: body.operation.id,
        hostId: "apps",
        userId: "test-user",
        action: command,
        status: "success",
      });
    },
  );

  it("replays an idempotency key without running the command twice", async () => {
    const key = crypto.randomUUID();
    const first = await api(
      "/api/host-command?host=nas-home",
      { command: "pause-follower" },
      { "Idempotency-Key": key },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const replay = await api(
      "/api/host-command?host=nas-home",
      { command: "resume-follower" },
      { "Idempotency-Key": key },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).operation.id).toBe(firstBody.operation.id);
    expect(nas.requests).toHaveLength(1);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
  });

  it("refuses to reuse an idempotency key on another host", async () => {
    const key = crypto.randomUUID();
    const first = await api(
      "/api/host-command?host=nas-home",
      { command: "deploy-now" },
      { "Idempotency-Key": key },
    );
    expect(first.status).toBe(200);

    const otherHost = await api(
      "/api/host-command?host=apps",
      { command: "deploy-now" },
      { "Idempotency-Key": key },
    );

    expect(otherHost.status).toBe(409);
    expect(apps.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
  });

  it("rejects commands outside the closed whitelist without calling the agent", async () => {
    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "systemctl restart nginx" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("rejects free-form arguments next to the command name", async () => {
    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "deploy-now", unit: "evil.service" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("refuses to send a command when the host is not connected", async () => {
    await db.delete(tables.samples);

    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "deploy-now" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(503);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("records an agent rejection as failed and never retries it", async () => {
    nas.behaviour = "reject";

    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "run-security" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).status).toBe("failed");
    expect(nas.requests).toHaveLength(1);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("failed");
    expect(operation.detail).toEqual(expect.any(String));
  });

  it("leaves an uncertain result pending and never sends it again", async () => {
    nas.behaviour = "uncertain";
    const key = crypto.randomUUID();

    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "pause-follower" },
      { "Idempotency-Key": key },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).status).toBe("pending");
    expect(nas.requests).toHaveLength(1);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("pending");

    nas.behaviour = "ok";
    const retry = await api(
      "/api/host-command?host=nas-home",
      { command: "pause-follower" },
      { "Idempotency-Key": key },
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).operation.status).toBe("pending");
    expect(nas.requests).toHaveLength(1);
  });

  it("does not report success for a malformed agent response", async () => {
    nas.behaviour = "invalid";

    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "deploy-now" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).status).toBe("pending");
    expect(nas.requests).toHaveLength(1);
    const [operation] = await db.select().from(tables.operations);
    expect(operation.status).toBe("pending");
  });

  it("requires an allowed origin", async () => {
    const response = await api(
      "/api/host-command?host=nas-home",
      { command: "deploy-now" },
      {
        Origin: "https://evil.invalid",
        "Idempotency-Key": crypto.randomUUID(),
      },
    );

    expect(response.status).toBe(403);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("requires an Idempotency-Key", async () => {
    const response = await api("/api/host-command?host=nas-home", {
      command: "deploy-now",
    });

    expect(response.status).toBe(400);
    expect(nas.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("rejects an unknown host without calling any agent", async () => {
    const response = await api(
      "/api/host-command?host=ghost",
      { command: "deploy-now" },
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(404);
    expect(nas.requests).toEqual([]);
    expect(apps.requests).toEqual([]);
  });
});
