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

type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
};
type FakeAgent = {
  name: string;
  token: string;
  url: string;
  requests: RecordedRequest[];
  failMetrics: boolean;
  reset(): void;
  close(): Promise<void>;
};

function metrics(name: string) {
  return {
    timestamp: Date.now() / 1000,
    hostname: name,
    cpu: name === "nas" ? 11 : 42,
    memory: { total: 1000, used: 250 },
    network: { rx: 10, tx: 20 },
    io: { read: 30, write: 40 },
    uptime: 1000,
    disks: [
      { name: "Volumen", root: "media", total: 100, used: 10, free: 90 },
    ],
    temperatures: [],
    containers: [
      {
        id: "c".repeat(64),
        name: `${name}-service`,
        image: "image:1",
        state: "running",
        status: "Up 1 hour",
        protected: false,
        cpu: 1,
        memory: 2,
      },
    ],
  };
}

async function fakeAgent(name: string, token: string): Promise<FakeAgent> {
  const agent = {
    name,
    token,
    url: "",
    requests: [] as RecordedRequest[],
    failMetrics: false,
    reset() {
      agent.requests = [];
      agent.failMetrics = false;
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
    agent.requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      body: raw ? JSON.parse(raw) : undefined,
      authorization: request.headers.authorization,
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: "No autorizado" });
    const path = new URL(request.url ?? "/", "http://agent").pathname;
    if (path === "/metrics") {
      if (agent.failMetrics)
        return send(503, { error: "El host no responde" });
      return send(200, metrics(name));
    }
    if (path === "/action") return send(200, { state: "running" });
    if (path === "/files")
      return send(200, [
        {
          name: `${name}.mkv`,
          path: `${name}.mkv`,
          directory: false,
          symlink: false,
          size: 1,
          modified: 1,
        },
      ]);
    if (path === "/trash") return send(200, []);
    return send(404, { error: "No encontrado" });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)("multi-host API", () => {
  let context: TestDatabase;
  let nas: FakeAgent;
  let apps: FakeAgent;
  let collectAll: typeof import("@/lib/collector").collectAll;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    const request = new NextRequest(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(method === "POST" ? { Origin: "http://localhost:3000" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return routes[method](request, {
      params: Promise.resolve({ path: route }),
    });
  }

  beforeAll(async () => {
    nas = await fakeAgent("nas", "a".repeat(32));
    apps = await fakeAgent("apps", "b".repeat(32));
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
    await db.delete(tables.operations);
    await db.delete(tables.alerts);
    await db.delete(tables.samples);
    await db.delete(tables.configuration);
    nas.reset();
    apps.reset();
  });

  it("collects samples from both agents and reports each connection", async () => {
    await collectAll();
    const nasOverview = await (await api("GET", "/api/overview?host=nas-home")).json();
    const appsOverview = await (await api("GET", "/api/overview?host=apps")).json();
    expect(nasOverview.host.id).toBe("nas-home");
    expect(nasOverview.latest.hostname).toBe("nas");
    expect(appsOverview.host).toEqual({
      id: "apps",
      name: "Apps",
      role: "apps-server",
    });
    expect(appsOverview.latest.hostname).toBe("apps");
    expect(appsOverview.connected).toBe(true);
    expect(nasOverview.settings.expectedContainers).toEqual(["nas-service"]);
    expect(appsOverview.settings.expectedContainers).toEqual(["apps-service"]);

    const hosts = await (await api("GET", "/api/hosts")).json();
    expect(hosts.default).toBe("nas-home");
    expect(hosts.hosts.map((host: { id: string }) => host.id)).toEqual([
      "nas-home",
      "apps",
    ]);
    expect(hosts.hosts.every((host: { connected: boolean }) => host.connected)).toBe(true);
    expect(JSON.stringify(hosts)).not.toContain("127.0.0.1");
    expect(JSON.stringify(hosts)).not.toContain(nas.token);

    await db
      .update(tables.samples)
      .set({ at: new Date(Date.now() - 120_000) })
      .where(eq(tables.samples.hostId, "apps"));
    const stale = await (await api("GET", "/api/hosts")).json();
    expect(
      stale.hosts.find((host: { id: string }) => host.id === "apps").connected,
    ).toBe(false);
    expect(
      stale.hosts.find((host: { id: string }) => host.id === "nas-home")
        .connected,
    ).toBe(true);
  });

  it("scopes an alert to the host that fails", async () => {
    apps.failMetrics = true;
    const now = Date.now();
    await collectAll(undefined, now);
    await collectAll(undefined, now + 61_000);
    const appsOverview = await (await api("GET", "/api/overview?host=apps")).json();
    const nasOverview = await (await api("GET", "/api/overview?host=nas-home")).json();
    expect(appsOverview.alerts).toHaveLength(1);
    expect(appsOverview.alerts[0]).toMatchObject({
      hostId: "apps",
      key: "connection",
    });
    expect(nasOverview.alerts).toEqual([]);
  });

  it("sends an action only to the selected host", async () => {
    await collectAll();
    const response = await api(
      "POST",
      "/api/action?host=apps",
      { action: "restart", id: "a".repeat(64) },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    expect(response.status).toBe(200);
    expect(apps.requests.some((entry) => entry.path === "/action")).toBe(true);
    expect(nas.requests.some((entry) => entry.path === "/action")).toBe(false);
    const overview = await (await api("GET", "/api/overview?host=apps")).json();
    expect(overview.operations[0].hostId).toBe("apps");
  });

  it("refuses an action when the selected host is not connected", async () => {
    const response = await api(
      "POST",
      "/api/action?host=apps",
      { action: "restart", id: "a".repeat(64) },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    expect(response.status).toBe(503);
    expect(apps.requests.some((entry) => entry.path === "/action")).toBe(false);
  });

  it("keeps file reads on the selected host and defaults to the NAS", async () => {
    await (await api("GET", "/api/files?host=apps&root=media&path=")).json();
    expect(apps.requests.at(-1)?.path).toContain("/files");
    expect(nas.requests).toEqual([]);

    const entries = await (
      await api("GET", "/api/files?root=media&path=")
    ).json();
    expect(entries[0].name).toBe("nas.mkv");
    expect(nas.requests.at(-1)?.path).toContain("/files");
  });

  it("rejects an unknown host without calling an agent", async () => {
    const response = await api("GET", "/api/overview?host=ghost");
    expect(response.status).toBe(404);
    expect(nas.requests).toEqual([]);
    expect(apps.requests).toEqual([]);
  });

  it("saves thresholds for one host without changing the other", async () => {
    const save = await api("POST", "/api/settings?host=apps", {
      cpu: 75,
      memory: 80,
      disk: 85,
      temperature: 90,
      sustainedSeconds: 60,
    });
    expect(save.status).toBe(200);
    const appsOverview = await (await api("GET", "/api/overview?host=apps")).json();
    const nasOverview = await (await api("GET", "/api/overview?host=nas-home")).json();
    expect(appsOverview.settings.cpu).toBe(75);
    expect(nasOverview.settings.cpu).toBe(90);
  });
});
