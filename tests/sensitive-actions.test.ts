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
  actionPolicies,
  hostCommandPolicies,
  requiresVerificationForAction,
  requiresVerificationForCommand,
  type ActionId,
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
});
