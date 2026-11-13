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

const ID = "a".repeat(64);
const T1 = "2026-11-13T10:00:00.000000001Z";
const T2 = "2026-11-13T10:00:00.000000002Z";
const T3 = "2026-11-13T10:00:01.000000001Z";

type LogLine = { stream: "stdout" | "stderr"; at: string; message: string };

const logLines: LogLine[] = [
  { stream: "stdout", at: T1, message: "first" },
  { stream: "stderr", at: T2, message: "second" },
  { stream: "stdout", at: T3, message: "third" },
];

type Recorded = { path: string; query: URLSearchParams };
type FakeAgent = {
  token: string;
  url: string;
  requests: Recorded[];
  reset(): void;
  close(): Promise<void>;
};

async function fakeAgent(token: string): Promise<FakeAgent> {
  const agent = {
    token,
    url: "",
    requests: [] as Recorded[],
    reset() {
      agent.requests = [];
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://agent");
    agent.requests.push({ path: url.pathname, query: url.searchParams });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: "No autorizado" });
    if (url.pathname !== "/logs") return send(404, { error: "No encontrado" });
    const since = url.searchParams.get("since");
    const lines = since
      ? logLines.filter((entry) => entry.at > since.split("#")[0])
      : logLines.slice(0, 2);
    const cursor = lines.length
      ? `${lines.at(-1)!.at}#1`
      : since;
    return send(200, { id: ID, lines, cursor, truncated: false });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)("container logs API", () => {
  let context: TestDatabase;
  let agent: FakeAgent;
  let nas: FakeAgent;
  let pool: typeof import("@/lib/db").pool;
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(
    method: "GET" | "POST",
    path: string,
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
    });
    return routes[method](request, {
      params: Promise.resolve({ path: route }),
    });
  }

  beforeAll(async () => {
    agent = await fakeAgent("b".repeat(32));
    nas = await fakeAgent("c".repeat(32));
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
        url: agent.url,
        token: agent.token,
      },
    ]);
    context = await createTestDatabase(baseUrl!);
    process.env.DATABASE_URL = context.url;
    pool = (await import("@/lib/db")).pool;
    routes = await import("../src/app/api/[...path]/route");
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await agent.close();
    await nas.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(() => {
    session.value = {
      user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
    };
    agent.reset();
    nas.reset();
  });

  it("requires an authenticated session", async () => {
    session.value = null;
    const response = await api("GET", `/api/logs?id=${ID}`);
    expect(response.status).toBe(401);
    expect(agent.requests).toEqual([]);
    expect(nas.requests).toEqual([]);
  });

  it("scopes the read to the selected host and forwards an incremental cursor", async () => {
    const first = await api(
      "GET",
      `/api/logs?host=apps&id=${ID}&lines=2`,
    );
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.host).toEqual({ id: "apps", name: "Apps", role: "apps-server" });
    expect(body.id).toBe(ID);
    expect(body.lines.map((entry: LogLine) => entry.message)).toEqual([
      "first",
      "second",
    ]);
    expect(body.cursor).toBe(`${T2}#1`);
    expect(body.truncated).toBe(false);
    expect(agent.requests.at(-1)?.query.get("lines")).toBe("2");
    expect(agent.requests.at(-1)?.query.has("since")).toBe(false);
    expect(nas.requests).toEqual([]);

    const second = await api(
      "GET",
      `/api/logs?host=apps&id=${ID}&lines=2&since=${encodeURIComponent(body.cursor)}`,
    );
    expect(second.status).toBe(200);
    const next = await second.json();
    expect(next.lines.map((entry: LogLine) => entry.message)).toEqual([
      "third",
    ]);
    expect(agent.requests.at(-1)?.query.get("since")).toBe(body.cursor);
    expect(agent.requests.at(-1)?.query.get("lines")).toBe("2");
  });

  it("accepts a plain timestamp as the incremental mark", async () => {
    const response = await api(
      "GET",
      `/api/logs?host=apps&id=${ID}&since=${encodeURIComponent(T1)}`,
    );
    expect(response.status).toBe(200);
    expect(agent.requests.at(-1)?.query.get("since")).toBe(T1);
  });

  it("rejects invalid container identifiers before calling the agent", async () => {
    for (const id of ["short", "A".repeat(64), `${"a".repeat(64)};rm`]) {
      const response = await api(
        "GET",
        `/api/logs?host=apps&id=${encodeURIComponent(id)}`,
      );
      expect(response.status).toBe(400);
    }
    expect(agent.requests).toEqual([]);
  });

  it("keeps the line limit between one and 5000", async () => {
    for (const lines of ["0", "5001", "many"]) {
      const response = await api(
        "GET",
        `/api/logs?host=apps&id=${ID}&lines=${lines}`,
      );
      expect(response.status).toBe(400);
    }
    expect(agent.requests).toEqual([]);

    const maximum = await api(
      "GET",
      `/api/logs?host=apps&id=${ID}&lines=5000`,
    );
    expect(maximum.status).toBe(200);
    expect(agent.requests.at(-1)?.query.get("lines")).toBe("5000");
  });

  it("rejects a malformed incremental mark", async () => {
    const response = await api(
      "GET",
      `/api/logs?host=apps&id=${ID}&since=yesterday`,
    );
    expect(response.status).toBe(400);
    expect(agent.requests).toEqual([]);
  });

  it("rejects an unknown host without calling an agent", async () => {
    const response = await api(
      "GET",
      `/api/logs?host=ghost&id=${ID}`,
    );
    expect(response.status).toBe(404);
    expect(agent.requests).toEqual([]);
  });

  it("never exposes a log write or console route", async () => {
    const response = await api("POST", `/api/logs?host=apps&id=${ID}`);
    expect(response.status).toBe(404);
    expect(agent.requests).toEqual([]);
  });
});
