import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  actionPolicies,
  hostCommandPolicies,
  requiresVerificationForAction,
  requiresVerificationForCommand,
  patternRoutes,
  routeFiles,
  routeManifest,
  routeVerdict,
  type ActionId,
  type ProtectedPostRoute,
  type RouteMethod,
} from "@/lib/sensitive-actions";
import { hostCommandIds } from "@/lib/host-command-contract";
import { actionSchema } from "@/lib/validation";
import { DEFAULT_BODY_LIMIT } from "@/lib/request-body";
import {
  clearVerification,
  seedVerifiedSession,
  testSession,
  VERIFICATION_TTL_MS,
} from "./verified-session";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

const session = vi.hoisted(() => ({
  value: null as unknown,
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

type FakeAgent = {
  url: string;
  token: string;
  requests: RecordedRequest[];
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
    reset() {
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
    const body = raw ? JSON.parse(raw) : undefined;
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "No autorizado" }));
      return;
    }
    const path = new URL(request.url ?? "/", "http://agent").pathname;
    if (path !== "/action" && path !== "/command") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "No encontrado" }));
      return;
    }
    agent.requests.push({ method: request.method ?? "", path, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    if (path === "/command") {
      const command = (body as { command: string }).command;
      const extra =
        command === "backup-now"
          ? {
              backup: {
                started: true,
                lastStatus: { status: "ok", at: "2026-11-13T04:04:49Z" },
              },
            }
          : command === "clean-images"
            ? {
                cleanup: {
                  reclaimedBytes: 30_000_000_000,
                  imagesRemoved: 12,
                  imagesPreserved: 4,
                  imagesFailed: 0,
                },
              }
            : command === "check-health"
              ? {
                  health: {
                    vpn: {
                      applicable: true,
                      connected: true,
                      state: "running",
                      health: "healthy",
                    },
                    apps: [],
                    healthy: true,
                  },
                }
              : command === "reconnect-apps"
                ? { wiring: { started: true } }
                : {};
      response.end(JSON.stringify({ command, status: "success", ...extra }));
      return;
    }
    response.end(JSON.stringify({ state: "ok" }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

const baseUrl = testDatabaseUrl();
const containerId = "a".repeat(64);
const fileId = "3f1d9c2a-0000-4000-8000-000000000001";

/** One valid body per action; the coverage test keeps it in sync with the schema. */
const bodies = {
  start: { action: "start", id: containerId },
  stop: { action: "stop", id: containerId },
  restart: { action: "restart", id: containerId },
  "update-container": { action: "update-container", id: containerId },
  reboot: { action: "reboot", confirmation: "REINICIAR NAS" },
  move: {
    action: "move",
    root: "media",
    path: "series/temporada/a.mkv",
    destination: "series/temporada/b.mkv",
  },
  trash: { action: "trash", root: "media", path: "series/temporada/a.mkv" },
  restore: { action: "restore", root: "media", id: fileId },
  purge: { action: "purge", root: "media", id: fileId },
  "empty-trash": { action: "empty-trash", confirmation: "VACIAR PAPELERA" },
} satisfies Record<ActionId, unknown>;

/** The shape of zod 4's introspection def this test reads. */
type EnumeratedDef = {
  type: string;
  entries?: Record<string, string>;
  values?: string[];
};

/** The ids `actionSchema` accepts, read through zod 4's introspection. */
function schemaActionIds(): string[] {
  const ids: string[] = [];
  for (const option of actionSchema.options) {
    const def = (
      option.shape as Record<string, { _zod: { def: EnumeratedDef } }>
    ).action._zod.def;
    if (def.type === "enum") ids.push(...Object.values(def.entries ?? {}));
    else if (def.type === "literal") ids.push(...(def.values ?? []));
  }
  return ids;
}

const allActions = Object.keys(actionPolicies) as ActionId[];

let settingsBodyLimit: number;

type BodyLimitCase = {
  name: string;
  path: string;
  method: "POST" | "DELETE";
  /** Bytes the route admits; the default is the global limit. */
  limit?: () => number;
  /** The setup route answers 403 before reading once an account exists. */
  withoutAccounts?: true;
  /** The password route answers 403 before reading on the passkey domain. */
  passwordDomain?: true;
  /** The route never reads the body, so a large one is not a 413. */
  readsBody: boolean;
};

const bodyLimitCases: BodyLimitCase[] = [
  { name: "setup", path: "/api/setup", method: "POST", withoutAccounts: true, readsBody: true },
  { name: "verification/password", path: "/api/verification/password", method: "POST", passwordDomain: true, readsBody: true },
  { name: "containers/remove", path: "/api/containers/remove?host=nas-home", method: "POST", readsBody: true },
  { name: "host-command", path: "/api/host-command?host=nas-home", method: "POST", readsBody: true },
  { name: "incidents acknowledge", path: "/api/incidents/1/acknowledge", method: "POST", readsBody: true },
  { name: "incidents snooze", path: "/api/incidents/1/snooze", method: "POST", readsBody: true },
  { name: "incidents unsnooze", path: "/api/incidents/1/unsnooze", method: "POST", readsBody: true },
  { name: "deployments/settings", path: "/api/deployments/settings?host=nas-home", method: "POST", limit: () => settingsBodyLimit, readsBody: true },
  { name: "renovate/merge", path: "/api/renovate/merge", method: "POST", readsBody: true },
  { name: "presence", path: "/api/presence", method: "POST", readsBody: true },
  { name: "action", path: "/api/action?host=nas-home", method: "POST", readsBody: true },
  { name: "settings", path: "/api/settings?host=nas-home", method: "POST", readsBody: true },
  { name: "push POST", path: "/api/push", method: "POST", readsBody: true },
  { name: "push DELETE", path: "/api/push", method: "DELETE", readsBody: true },
  { name: "push/test", path: "/api/push/test", method: "POST", readsBody: false },
];

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const catchAllFile = "src/app/api/[...path]/route.ts";

function source(relative: string) {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

function withoutComments(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function typeScriptFiles(directory: string): string[] {
  return readdirSync(path.join(repoRoot, directory), { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((entry) => /\.tsx?$/.test(entry))
    .map((entry) => `${directory}/${entry}`);
}

/** The route a body-limit row exercises, without the query string. */
function rowRoute(row: BodyLimitCase) {
  return row.path.replace(/^\/api\//, "").split("?")[0];
}

describe("route declarations", () => {
  const catchAll = withoutComments(source(catchAllFile));
  const mutationMethods: RouteMethod[] = ["POST", "DELETE"];

  it("declares every route === literal of the catch-all, and nothing stale", () => {
    const literals = new Set(
      [...catchAll.matchAll(/route === "([^"]+)"/g)].map((match) => match[1]),
    );

    expect([...literals].sort()).toEqual(Object.keys(routeManifest).sort());
  });

  it("declares every regular-expression route of the catch-all", () => {
    expect((catchAll.match(/\.exec\(route\)/g) ?? []).length).toBe(
      patternRoutes.length,
    );
  });

  it("dispatches only by exact name or by the declared patterns", () => {
    expect(catchAll).not.toMatch(/switch\s*\(\s*route\s*\)/);
    expect(catchAll).not.toMatch(/route\.(startsWith|endsWith|includes)\(/);
  });

  it("lists every route.ts under src/app/api, and nothing stale", () => {
    const files = readdirSync(path.join(repoRoot, "src/app/api"), {
      recursive: true,
    })
      .map((entry) => String(entry).split(path.sep).join("/"))
      .filter((entry) => /(^|\/)route\.(ts|tsx|js|jsx|mjs)$/.test(entry))
      .map((entry) => `src/app/api/${entry}`);

    expect(files.sort()).toEqual(Object.keys(routeFiles).sort());
  });

  it("exports exactly the verbs the manifest declares", () => {
    const exported = new Set(
      [
        ...catchAll.matchAll(
          /export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
        ),
      ].map((match) => match[1]),
    );
    const declared = new Set<string>();
    for (const entry of [
      ...Object.values(routeManifest),
      ...patternRoutes.map((route) => route.entry),
    ])
      for (const method of Object.keys(entry)) declared.add(method);

    expect([...exported].sort()).toEqual([...declared].sort());
  });

  it("reads no request body outside request-body.ts", () => {
    const readers =
      /\b\w*(?:[Rr]equest|req)\s*\??\.\s*(?:json|text|formData|arrayBuffer|blob|body)\b/;
    const offenders = [
      ...typeScriptFiles("src/app/api"),
      ...typeScriptFiles("src/lib"),
    ]
      .filter((file) => file !== "src/lib/request-body.ts")
      .filter((file) => readers.test(withoutComments(source(file))));

    expect(offenders).toEqual([]);
  });

  it("covers every mutation with a 413 row or marks it as not reading a body", () => {
    const missing: string[] = [];
    for (const [route, entry] of Object.entries(routeManifest))
      for (const method of mutationMethods)
        if (
          Object.hasOwn(entry, method) &&
          !bodyLimitCases.some(
            (row) => rowRoute(row) === route && row.method === method,
          )
        )
          missing.push(`${method} ${route}`);
    for (const { pattern, entry } of patternRoutes)
      for (const method of mutationMethods)
        if (
          Object.hasOwn(entry, method) &&
          !bodyLimitCases.some(
            (row) => pattern.test(rowRoute(row)) && row.method === method,
          )
        )
          missing.push(`${method} ${pattern.source}`);

    expect(missing).toEqual([]);
  });

  it("keeps no 413 row for a route the manifest does not declare", () => {
    for (const row of bodyLimitCases)
      expect(routeVerdict(rowRoute(row), row.method), row.name).toEqual({
        verdict: "ok",
      });
  });
});

describe.skipIf(!baseUrl)("sensitive actions", () => {
  let context: TestDatabase;
  let agent: FakeAgent;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method: "GET" | "POST" | "DELETE" = "POST",
  ) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    const request = new NextRequest(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    routes = await import("../src/app/api/[...path]/route");
    ({ DEPLOYMENT_SETTINGS_BODY_LIMIT: settingsBodyLimit } = await import(
      "@/lib/deployment-settings"
    ));
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await agent.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(async () => {
    session.value = testSession;
    await db.delete(tables.operations);
    await db.delete(tables.samples);
    await sample("nas-home");
    await sample("apps");
    agent.reset();
  });

  it("declares every action of the schema exactly once, with a reason", () => {
    const ids = schemaActionIds().sort();

    expect(ids).toEqual([...allActions].sort());
    expect(Object.keys(bodies).sort()).toEqual(ids);
    expect(ids).toHaveLength(10);
    for (const [id, policy] of Object.entries(actionPolicies)) {
      expect(policy.kind, id).toMatch(/^(protected|exempt)$/);
      expect(policy.reason.trim().length, id).toBeGreaterThan(0);
    }
  });

  it("protects exactly the actions that cut service or lose data", () => {
    const protectedIds = allActions
      .filter((action) => requiresVerificationForAction(action))
      .sort();

    expect(protectedIds).toEqual(
      [
        "empty-trash",
        "purge",
        "reboot",
        "restart",
        "stop",
        "update-container",
      ].sort(),
    );
  });

  it("does not protect an id outside the manifest", () => {
    expect(requiresVerificationForAction("remove-container")).toBe(false);
    expect(requiresVerificationForAction(undefined)).toBe(false);
    expect(requiresVerificationForAction({ action: "stop" })).toBe(false);
  });

  it.each(allActions)(
    "without verification %s answers 403 for protected actions only",
    async (action) => {
      await clearVerification(db, tables);

      const response = await api(
        "/api/action?host=nas-home",
        bodies[action],
        { "Idempotency-Key": crypto.randomUUID() },
      );

      if (requiresVerificationForAction(action)) {
        expect(response.status, action).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "recent_verification_required",
          reason: "missing",
        });
        expect(agent.requests, action).toEqual([]);
        expect(await db.select().from(tables.operations)).toEqual([]);
      } else {
        expect(response.status, action).toBe(200);
        expect((await response.json()).code).not.toBe(
          "recent_verification_required",
        );
        expect(agent.requests, action).toHaveLength(1);
      }
    },
  );

  it.each(allActions)(
    "with a recent verification %s is not blocked by the gate",
    async (action) => {
      await seedVerifiedSession(db, tables);

      const response = await api(
        "/api/action?host=nas-home",
        bodies[action],
        { "Idempotency-Key": crypto.randomUUID() },
      );

      expect(response.status, action).toBe(200);
      expect((await response.json()).code).not.toBe(
        "recent_verification_required",
      );
      expect(agent.requests, action).toHaveLength(1);
    },
  );

  it("treats an expiresAt at the request instant as expired", async () => {
    const now = Date.now();
    await seedVerifiedSession(db, tables, {
      verifiedAt: new Date(now - 10_000),
      ttlMs: 10_000,
    });

    const response = await api(
      "/api/action?host=nas-home",
      bodies.stop,
      { "Idempotency-Key": crypto.randomUUID() },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "recent_verification_required",
      reason: "expired",
    });
    expect(agent.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toEqual([]);
  });

  it("replays a registered operation without asking for a new verification", async () => {
    await clearVerification(db, tables);
    const key = crypto.randomUUID();
    await db.insert(tables.operations).values({
      id: key,
      hostId: "nas-home",
      userId: "test-user",
      action: "stop",
      target: containerId,
      status: "success",
      detail: "Operación completada y comprobada.",
    });

    const response = await api(
      "/api/action?host=nas-home",
      bodies.stop,
      { "Idempotency-Key": key },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: key,
      action: "stop",
      status: "success",
    });
    expect(agent.requests).toEqual([]);
    expect(await db.select().from(tables.operations)).toHaveLength(1);
  });

  it("still keeps the verification window at five minutes", () => {
    expect(VERIFICATION_TTL_MS).toBe(300_000);
  });

  it("declares every host command of the closed list with a reason", () => {
    expect(Object.keys(hostCommandPolicies).sort()).toEqual(
      [...hostCommandIds].sort(),
    );
    for (const [id, policy] of Object.entries(hostCommandPolicies)) {
      expect(policy.kind, id).toMatch(/^(protected|exempt)$/);
      expect(policy.reason.trim().length, id).toBeGreaterThan(0);
    }
  });

  it("protects exactly the host commands that change state", () => {
    const protectedIds = hostCommandIds
      .filter((command) => requiresVerificationForCommand(command))
      .sort();

    expect(protectedIds).toEqual(
      [
        "backup-now",
        "clean-images",
        "deploy-now",
        "pause-follower",
        "reconnect-apps",
        "resume-follower",
        "run-security",
      ].sort(),
    );
    expect(requiresVerificationForCommand("check-health")).toBe(false);
    expect(requiresVerificationForCommand("unknown")).toBe(false);
  });

  it.each(hostCommandIds)(
    "without verification the host command %s answers 403 only when it changes state",
    async (command) => {
      await clearVerification(db, tables);

      const response = await api(
        "/api/host-command?host=nas-home",
        { command },
        { "Idempotency-Key": crypto.randomUUID() },
      );

      if (requiresVerificationForCommand(command)) {
        expect(response.status, command).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "recent_verification_required",
          reason: "missing",
        });
        expect(agent.requests, command).toEqual([]);
        expect(await db.select().from(tables.operations)).toEqual([]);
      } else {
        expect(response.status, command).toBe(200);
        expect((await response.json()).code).not.toBe(
          "recent_verification_required",
        );
        expect(agent.requests, command).toHaveLength(1);
      }
    },
  );

  it.each(hostCommandIds)(
    "with a recent verification the host command %s answers 200",
    async (command) => {
      await seedVerifiedSession(db, tables);

      const response = await api(
        "/api/host-command?host=nas-home",
        { command },
        { "Idempotency-Key": crypto.randomUUID() },
      );

      expect(response.status, command).toBe(200);
      expect(agent.requests, command).toHaveLength(1);
    },
  );
  describe("route manifest dispatch", () => {
    it.each([
      ["/api/action?host=nas-home", "POST"],
      ["/api/settings?host=nas-home", "GET, POST"],
    ])(
      "answers 405 with Allow for DELETE %s and never reaches the handler",
      async (path, allow) => {
        await seedVerifiedSession(db, tables);

        const response = await api(path, undefined, {}, "DELETE");

        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe(allow);
        expect(await db.select().from(tables.operations)).toEqual([]);
        expect(agent.requests).toEqual([]);
      },
    );

    it("answers 405 to a read-only method on a mutation route and the reverse", async () => {
      const get = await api("/api/action?host=nas-home", undefined, {}, "GET");
      const post = await api("/api/hosts", { padding: "x" });

      expect(get.status).toBe(405);
      expect(get.headers.get("Allow")).toBe("POST");
      expect(post.status).toBe(405);
      expect(post.headers.get("Allow")).toBe("GET");
      expect(agent.requests).toEqual([]);
    });

    it.each(["GET", "POST"] as const)(
      "answers 404 to an unknown route with %s",
      async (method) => {
        const response = await api(
          "/api/no-existe",
          method === "POST" ? {} : undefined,
          {},
          method,
        );

        expect(response.status).toBe(404);
      },
    );

    it.each(["/api/ACTION", "/api/action/extra", "/api/constructor"])(
      "answers 404 to %s because only the exact route name matches",
      async (path) => {
        await seedVerifiedSession(db, tables);

        const response = await api(path, bodies.stop);

        expect(response.status).toBe(404);
        expect(agent.requests).toEqual([]);
        expect(await db.select().from(tables.operations)).toEqual([]);
      },
    );

    it.each([
      ["DELETE", "/api/action?host=nas-home"],
      ["POST", "/api/no-existe"],
      ["GET", "/api/no-existe"],
      ["GET", "/api/action?host=nas-home"],
    ] as const)(
      "answers 401 before 404 or 405 without a session for %s %s",
      async (method, path) => {
        session.value = null;

        const response = await api(
          path,
          method === "POST" ? {} : undefined,
          {},
          method,
        );

        expect(response.status).toBe(401);
      },
    );

    it("answers 405 to an undeclared method on the public setup route without a session", async () => {
      session.value = null;

      const response = await api("/api/setup", undefined, {}, "DELETE");

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST");
    });

    it("gives a verdict for every declared pair and rejects the rest", () => {
      const methods = ["GET", "POST", "DELETE", "PUT", "PATCH"];
      for (const [route, entry] of Object.entries(routeManifest)) {
        const declared = methods.filter((method) =>
          Object.hasOwn(entry, method),
        );
        expect(declared.length, route).toBeGreaterThan(0);
        for (const method of methods) {
          const verdict = routeVerdict(route, method);
          if (declared.includes(method)) {
            expect(verdict, `${method} ${route}`).toEqual({ verdict: "ok" });
          } else {
            expect(verdict, `${method} ${route}`).toEqual({
              verdict: "method_not_allowed",
              allow: declared,
            });
          }
        }
      }
    });

    it("gives a verdict for the incident pattern routes", () => {
      expect(routeVerdict("incidents/7", "GET")).toEqual({ verdict: "ok" });
      expect(routeVerdict("incidents/7", "POST")).toEqual({
        verdict: "method_not_allowed",
        allow: ["GET"],
      });
      for (const action of ["acknowledge", "snooze", "unsnooze"]) {
        expect(routeVerdict(`incidents/7/${action}`, "POST")).toEqual({
          verdict: "ok",
        });
        expect(routeVerdict(`incidents/7/${action}`, "DELETE")).toEqual({
          verdict: "method_not_allowed",
          allow: ["POST"],
        });
      }
      for (const route of [
        "incidents",
        "incidents/7/other",
        "incidents/7/acknowledge/extra",
        "INCIDENTS/7",
      ])
        expect(routeVerdict(route, "GET"), route).toEqual({
          verdict: "not_found",
        });
    });

    it("does not resolve inherited object keys as routes", () => {
      for (const route of ["constructor", "__proto__", "toString", ""])
        expect(routeVerdict(route, "GET"), route).toEqual({
          verdict: "not_found",
        });
    });
  });
  describe("whole-route protection", () => {
    /** One valid request per route whose `POST` is protected as a whole. */
    const protectedRouteRequests = {
      "containers/remove": {
        path: "/api/containers/remove?host=nas-home",
        body: { id: containerId, confirmation: "sonarr" },
      },
      "deployments/settings": {
        path: "/api/deployments/settings?host=nas-home",
        body: {
          release: "v2.5.0",
          values: { NEW_SETTING: "value" },
          acknowledgedManualSteps: true,
        },
      },
      "renovate/merge": {
        path: "/api/renovate/merge?host=nas-home",
        body: { number: 100, headSha: "1".repeat(40), deployNow: false },
      },
    } satisfies Record<ProtectedPostRoute, { path: string; body: unknown }>;

    /** Exempt by D-06: they accept a valid request without any verification. */
    const exemptRouteRequests = {
      presence: {
        path: "/api/presence",
        body: { id: "3f1d9c2a-0000-4000-8000-0000000000aa", visible: true },
      },
      "push/test": { path: "/api/push/test", body: {} },
      settings: {
        path: "/api/settings?host=nas-home",
        body: {
          cpu: 90,
          memory: 90,
          disk: 90,
          temperature: 80,
          sustainedSeconds: 60,
        },
      },
    };

    // `push/test` queues a job for the session owner; leaving it would make
    // the next test that deletes the user cascade it away mid-comparison.
    afterEach(async () => {
      await db.delete(tables.notificationOutbox);
      await db.delete(tables.presence);
    });

    it.each(Object.entries(protectedRouteRequests))(
      "answers 403 for %s without verification, with no agent request or operation",
      async (_route, request) => {
        await clearVerification(db, tables);

        const response = await api(request.path, request.body, {
          "Idempotency-Key": crypto.randomUUID(),
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "recent_verification_required",
        });
        expect(agent.requests).toEqual([]);
        expect(await db.select().from(tables.operations)).toEqual([]);
      },
    );

    it.each(Object.entries(exemptRouteRequests))(
      "accepts %s without a verification",
      async (_route, request) => {
        await clearVerification(db, tables);

        const response = await api(request.path, request.body, {
          "Idempotency-Key": crypto.randomUUID(),
        });

        expect(response.status).toBeLessThan(300);
        expect((await response.json()).code).not.toBe(
          "recent_verification_required",
        );
      },
    );

    it("keeps the typed fixtures in step with the manifest", () => {
      const protectedRoutes = Object.entries(routeManifest)
        .filter(([, entry]) => {
          const post = (entry as { POST?: { kind: string } }).POST;
          return post?.kind === "protected";
        })
        .map(([route]) => route)
        .sort();

      expect(Object.keys(protectedRouteRequests).sort()).toEqual(
        protectedRoutes,
      );
    });
  });
  describe("request body limit on /api/action", () => {
    const oversized = {
      ...bodies.stop,
      padding: "x".repeat(DEFAULT_BODY_LIMIT + 1024),
    };

    it.each([true, false])(
      "answers 413 for a body over the limit with verification seeded=%s",
      async (seeded) => {
        if (seeded) await seedVerifiedSession(db, tables);
        else await clearVerification(db, tables);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          const response = await api("/api/action?host=nas-home", oversized, {
            "Idempotency-Key": crypto.randomUUID(),
          });

          expect(response.status).toBe(413);
          expect(await db.select().from(tables.operations)).toEqual([]);
          expect(logged).not.toHaveBeenCalled();
          expect(agent.requests).toEqual([]);
        } finally {
          logged.mockRestore();
        }
      },
    );

    it.each([true, false])(
      "answers 413 for a declared length over the limit with a small body, seeded=%s",
      async (seeded) => {
        if (seeded) await seedVerifiedSession(db, tables);
        else await clearVerification(db, tables);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          const response = await api("/api/action?host=nas-home", bodies.stop, {
            "Idempotency-Key": crypto.randomUUID(),
            "Content-Length": String(DEFAULT_BODY_LIMIT * 4),
          });

          expect(response.status).toBe(413);
          expect(await db.select().from(tables.operations)).toEqual([]);
          expect(logged).not.toHaveBeenCalled();
          expect(agent.requests).toEqual([]);
        } finally {
          logged.mockRestore();
        }
      },
    );
  });
  describe("request body limit on every mutation", () => {
    /** Row counts of every table a rejected request must leave untouched. */
    async function traces() {
      return {
        operations: (await db.select().from(tables.operations)).length,
        incidents: (await db.select().from(tables.incidents)).length,
        incidentEvents: (await db.select().from(tables.incidentEvents))
          .length,
        outbox: (await db.select().from(tables.notificationOutbox)).length,
      };
    }

    async function sendLarge(entry: BodyLimitCase) {
      const limit = entry.limit?.() ?? DEFAULT_BODY_LIMIT;
      const previousPrimary = process.env.BETTER_AUTH_URL;
      if (entry.passwordDomain)
        process.env.BETTER_AUTH_URL = "https://hub.example";
      if (entry.withoutAccounts) await db.delete(tables.user);
      try {
        return await api(
          entry.path,
          { padding: "x".repeat(limit + 1) },
          { "Idempotency-Key": crypto.randomUUID() },
          entry.method,
        );
      } finally {
        if (previousPrimary === undefined) delete process.env.BETTER_AUTH_URL;
        else process.env.BETTER_AUTH_URL = previousPrimary;
        if (entry.withoutAccounts) await seedVerifiedSession(db, tables);
      }
    }

    it.each(bodyLimitCases.filter((entry) => entry.readsBody))(
      "answers 413 and leaves no trace for $method $name",
      async (entry) => {
        await clearVerification(db, tables);
        const before = await traces();
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          const response = await sendLarge(entry);

          expect(response.status).toBe(413);
          expect(await traces()).toEqual(before);
          expect(logged).not.toHaveBeenCalled();
          expect(agent.requests).toEqual([]);
        } finally {
          logged.mockRestore();
        }
      },
    );

    it("does not degrade the password route's 413 to a 400", async () => {
      const response = await sendLarge(
        bodyLimitCases.find((entry) => entry.name === "verification/password")!,
      );

      expect(response.status).not.toBe(400);
      expect(response.status).toBe(413);
    });

    it("still answers 400 to a malformed password body", async () => {
      process.env.BETTER_AUTH_URL = "https://hub.example";
      try {
        const response = await api("/api/verification/password", "{nope");

        expect(response.status).toBe(400);
      } finally {
        delete process.env.BETTER_AUTH_URL;
      }
    });

    it.each(bodyLimitCases.filter((entry) => !entry.readsBody))(
      "does not read a body on $name, so a large one is not a 413",
      async (entry) => {
        const response = await sendLarge(entry);

        expect(response.status).not.toBe(413);
      },
    );
  });
});
