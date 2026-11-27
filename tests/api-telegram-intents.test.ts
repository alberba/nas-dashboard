import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { eq } from "drizzle-orm";
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
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { createFakeBotApi } from "./telegram-fake";
import {
  clearVerification,
  seedVerifiedSession,
  TEST_USER_ID,
  testSession,
} from "./verified-session";
import { requiresVerificationForIntent } from "@/lib/sensitive-actions";
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { IntentActionId } from "@/lib/telegram-intents";

const session = vi.hoisted(() => ({
  value: null as unknown,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => session.value) } },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: [
    "http://localhost:3000",
    "https://hub.example",
    "https://private.example",
  ],
}));

type RecordedRequest = { method: string; path: string; body: unknown };
type Behaviour = "ok" | "reject" | "uncertain";

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
    const command = (body as { command: string }).command;
    const extra =
      command === "backup-now"
        ? {
            backup: {
              started: true,
              lastStatus: { status: "ok", at: "2026-11-13T04:04:49Z" },
            },
          }
        : {};
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ command, status: "success", ...extra }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
const CHAT_ID = "123456789";
const SECRET = "b".repeat(32);
// The injected clock stays ahead of the real one so a notice opened in the
// test timeline is due and its intent is still alive when the API reads it.
const START = Date.now() + 60 * 60_000;

describe.skipIf(!baseUrl)("telegram intent API", () => {
  let context: TestDatabase;
  let nas: FakeAgent;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let lane: typeof import("@/lib/telegram-updates");
  let keyboard: typeof import("@/lib/telegram-keyboard");
  let routes: typeof import("../src/app/api/[...path]/route");
  let intentsModule: typeof import("@/lib/telegram-intents");
  let config: RuntimeConfig;
  const openClients = new Set<Client>();

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
    return routes.POST(request, { params: Promise.resolve({ path: route }) });
  }

  const execute = (token: string, headers?: Record<string, string>) =>
    api("/api/telegram/intents/execute", { token }, headers);

  async function sample(hostId: string) {
    await db.insert(tables.samples).values({
      hostId,
      at: new Date(),
      data: metrics(hostId) as never,
    });
  }

  beforeAll(async () => {
    nas = await fakeAgent("a".repeat(32));
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: nas.url,
        token: nas.token,
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
    dispatch = await import("@/lib/notification-dispatch");
    lane = await import("@/lib/telegram-updates");
    keyboard = await import("@/lib/telegram-keyboard");
    intentsModule = await import("@/lib/telegram-intents");
    routes = await import("../src/app/api/[...path]/route");
    config = {
      databaseUrl: context.url,
      betterAuthSecret: SECRET,
      betterAuthUrl: "https://hub.example.com",
      setupToken: "s".repeat(32),
      trustedOrigins: [],
      hosts: [],
      telegram: { botToken: BOT_TOKEN, chatId: CHAT_ID },
      vapid: null,
      pushWarnings: false,
      digestTime: "08:00",
    };
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await nas.close();
    delete process.env.NAS_HOSTS;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of openClients) await client.end().catch(() => {});
    openClients.clear();
  });

  beforeEach(async () => {
    session.value = testSession;
    await db.delete(tables.telegramActionIntents);
    await db.delete(tables.operations);
    await db.delete(tables.telegramActionTokens);
    await db.delete(tables.incidentSnoozes);
    await db.delete(tables.telegramPollState);
    await db.delete(tables.digestRuns);
    await db.delete(tables.telegramCooldown);
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
    await db.delete(tables.subscriptions);
    await db.delete(tables.samples);
    await db.delete(tables.user);
    await seedVerifiedSession(db, tables);
    await sample("nas-home");
    nas.reset();
  });

  async function lockOwner(): Promise<Client> {
    const client = new Client({ connectionString: context.url });
    await client.connect();
    openClients.add(client);
    expect(await dispatch.acquireCollectionLock(client)).toBe(true);
    return client;
  }

  let updateId = 1_000;

  /**
   * The whole chat leg: a delivered notice, a button press that registers the
   * intent, and the worker edit whose url button carries the handoff token. The
   * button is found by its `#intent=` fragment, never by position or text.
   */
  async function handoffFor(
    key: string,
    action: ReturnType<typeof intentsModule.tokenActionOf>,
  ) {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity: "critical",
      title: "Aviso de prueba",
      detail: "Detalle de prueba",
      now: START,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    const sent = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 1_000,
      fetchImpl: fake.transport,
    });
    expect(sent.action).toBe("sent");
    const incidentId = opened.incidentId!;
    const issued = await keyboard.issueActionTokens(db, {
      incidentId,
      chatId: CHAT_ID,
      actions: [action],
      now: START + 2_000,
    });
    fake.enqueueUpdate(
      fake.callbackUpdate({
        updateId: ++updateId,
        data: issued[action]!,
        messageId: 501,
      }),
    );
    const updates = lane.createUpdatesLane({
      client,
      config,
      fetchImpl: fake.transport,
      now: () => START + 60_000,
    });
    expect(await updates.run({ waitSeconds: 0 })).toMatchObject({ ok: true });
    const edited = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 120_000,
      fetchImpl: fake.transport,
    });
    expect(edited.action).toBe("edited");
    const call = fake.calls
      .filter((entry) => entry.method === "editMessageText")
      .at(-1)!;
    const markup = call.body.reply_markup as {
      inline_keyboard: Array<Array<{ url?: string }>>;
    };
    const button = markup.inline_keyboard
      .flat()
      .find((entry) => entry.url?.includes("#intent="));
    const handoff = new URL(button!.url!).hash.replace(/^#intent=/, "");
    const [intent] = await db
      .select()
      .from(tables.telegramActionIntents)
      .where(eq(tables.telegramActionIntents.incidentId, incidentId));
    // The lock is per connection: releasing it lets one test build several
    // handoffs in a row.
    await client.end();
    openClients.delete(client);
    return { token: handoff, intent, incidentId };
  }

  const operations = () => db.select().from(tables.operations);
  const intentRow = async (id: string) =>
    (
      await db
        .select()
        .from(tables.telegramActionIntents)
        .where(eq(tables.telegramActionIntents.id, id))
    )[0];

  it("runs backup-now once from the chat handoff and records channel and requester", async () => {
    const { token, intent } = await handoffFor("backup-failed", "act_backup_now");

    const response = await execute(token);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      status: "success",
      operation: { id: intent.id, action: "backup-now", status: "success" },
    });
    expect(nas.requests).toEqual([
      { method: "POST", path: "/command", body: { command: "backup-now" } },
    ]);
    const rows = await operations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: intent.id,
      hostId: "nas-home",
      action: "backup-now",
      userId: TEST_USER_ID,
      channel: "telegram",
      requestedBy: TEST_USER_ID,
    });
    const finished = await intentRow(intent.id);
    expect(finished.status).toBe("executed");
    expect(finished.usedAt).not.toBeNull();
    expect(finished.finishedAt).not.toBeNull();
  });

  it("answers 403 without a recent verification and leaves the intent pending", async () => {
    const { token, intent } = await handoffFor("backup-failed", "act_backup_now");
    await clearVerification(db, tables);

    const response = await execute(token);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "recent_verification_required",
    });
    expect(nas.requests).toEqual([]);
    expect(await operations()).toEqual([]);
    expect((await intentRow(intent.id)).status).toBe("pending");
  });

  it("answers 404 for an unknown token and 400 for a body with extra fields", async () => {
    await handoffFor("backup-failed", "act_backup_now");

    const unknown = await execute("A".repeat(43));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "intent_unknown" });

    const extra = await api("/api/telegram/intents/execute", {
      token: "A".repeat(43),
      action: "start",
    });
    expect(extra.status).toBe(400);
    expect(nas.requests).toEqual([]);
  });

  it("answers 401 without a session", async () => {
    const { token, intent } = await handoffFor("backup-failed", "act_backup_now");
    session.value = null;

    const response = await execute(token);

    expect(response.status).toBe(401);
    expect(nas.requests).toEqual([]);
    expect((await intentRow(intent.id)).status).toBe("pending");
  });

  describe("inspect", () => {
    const inspect = (token: string) =>
      api("/api/telegram/intents/inspect", { token });

    it("describes a live intent without consuming it", async () => {
      const { token, intent, incidentId } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );

      for (let turn = 0; turn < 2; turn += 1) {
        const response = await inspect(token);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          state: "ready",
          action: "backup-now",
          target: "nas-home",
          host: { id: "nas-home", name: "NAS-HOME" },
          incident: { id: incidentId, resolved: false },
          requiresVerification: true,
          expiresAt: intent.expiresAt.toISOString(),
        });
      }
      expect((await intentRow(intent.id)).status).toBe("pending");
      expect(nas.requests).toEqual([]);
    });

    it("reports that start needs no verification", async () => {
      const { token } = await handoffFor("container:plex", "act_start");

      const body = await (await inspect(token)).json();

      expect(body).toMatchObject({
        state: "ready",
        action: "start",
        target: "plex",
        requiresVerification: false,
      });
    });

    it("keeps a live intent ready once its incident is resolved (D-05)", async () => {
      const { token, incidentId } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      const closed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "backup-failed",
        failing: false,
        now: START + 150_000,
      });
      expect(closed.action).toBe("resolved");

      const body = await (await inspect(token)).json();

      expect(body).toMatchObject({
        state: "ready",
        incident: { id: incidentId, resolved: true },
      });
    });

    it("marks a lapsed intent expired in the database", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await db
        .update(tables.telegramActionIntents)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(tables.telegramActionIntents.id, intent.id));

      const response = await inspect(token);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "expired" });
      expect((await intentRow(intent.id)).status).toBe("expired");
    });

    it("reports a cancelled intent", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await db
        .update(tables.telegramActionIntents)
        .set({ status: "cancelled" })
        .where(eq(tables.telegramActionIntents.id, intent.id));

      expect(await (await inspect(token)).json()).toMatchObject({
        state: "cancelled",
      });
    });

    it("reports a consumed intent with its operation", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      expect((await execute(token)).status).toBe(200);

      const body = await (await inspect(token)).json();

      expect(body).toMatchObject({
        state: "consumed",
        operation: { id: intent.id, status: "success" },
      });
    });

    it("answers the same 404 for an unknown token and for another user's intent", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await db
        .insert(tables.user)
        .values({ id: "other-user", name: "Other", email: "other@hub.invalid" });
      await db
        .update(tables.telegramActionIntents)
        .set({ userId: "other-user" })
        .where(eq(tables.telegramActionIntents.id, intent.id));

      const foreign = await inspect(token);
      const unknown = await inspect("A".repeat(43));

      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await foreign.json()).toEqual(await unknown.json());
      const foreignExecute = await execute(token);
      expect(foreignExecute.status).toBe(404);
      expect(await foreignExecute.json()).toMatchObject({
        code: "intent_unknown",
      });
      expect(nas.requests).toEqual([]);
    });

    it("answers 401 without a session and 400 for a body with extra fields", async () => {
      const { token } = await handoffFor("backup-failed", "act_backup_now");
      const extra = await api("/api/telegram/intents/inspect", {
        token,
        action: "start",
      });
      expect(extra.status).toBe(400);
      session.value = null;
      expect((await inspect(token)).status).toBe(401);
    });
  });

  describe("execute states", () => {
    it("answers 410 after the intent lapsed and runs nothing", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await db
        .update(tables.telegramActionIntents)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(tables.telegramActionIntents.id, intent.id));

      const response = await execute(token);

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "intent_expired" });
      expect(nas.requests).toEqual([]);
      expect(await operations()).toEqual([]);
    });

    it("answers 410 after the intent was cancelled and runs nothing", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await db
        .update(tables.telegramActionIntents)
        .set({ status: "cancelled" })
        .where(eq(tables.telegramActionIntents.id, intent.id));

      const response = await execute(token);

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "intent_cancelled" });
      expect(nas.requests).toEqual([]);
    });

    it("returns the existing operation when the intent already ran", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      expect((await execute(token)).status).toBe(200);

      const again = await execute(token);

      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({
        ok: true,
        status: "success",
        operation: { id: intent.id },
      });
      expect(nas.requests).toHaveLength(1);
      expect(await operations()).toHaveLength(1);
    });

    it("answers pending while an executing intent has no operation yet", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await db
        .update(tables.telegramActionIntents)
        .set({ status: "executing", usedAt: new Date() })
        .where(eq(tables.telegramActionIntents.id, intent.id));

      const response = await execute(token);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, status: "pending" });
      expect(nas.requests).toEqual([]);
    });

    it("sends one request to the agent for two concurrent executes", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );

      const [first, second] = await Promise.all([execute(token), execute(token)]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(nas.requests).toHaveLength(1);
      expect(await operations()).toHaveLength(1);
      expect((await intentRow(intent.id)).status).toBe("executed");
    });

    it("answers 503 without claiming when the host has no recent sample", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await db
        .update(tables.samples)
        .set({ at: new Date(Date.now() - 10 * 60_000) });

      const response = await execute(token);

      expect(response.status).toBe(503);
      expect(nas.requests).toEqual([]);
      expect(await operations()).toEqual([]);
      const row = await intentRow(intent.id);
      expect(row.status).toBe("pending");
      expect(row.usedAt).toBeNull();
    });

    it("gives the claim back when the executor sent nothing", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      // The precheck reads the injected clock and passes; the executor reads
      // the real one and finds the sample stale, so nothing is sent.
      const sampled = Date.now() - 100_000;
      await db.update(tables.samples).set({ at: new Date(sampled) });
      const { handleIntentExecute } = await import("@/lib/telegram-intent-api");

      const response = await handleIntentExecute({
        request: new Request("http://localhost/api/telegram/intents/execute", {
          method: "POST",
          headers: { Origin: "http://localhost:3000" },
          body: JSON.stringify({ token }),
        }),
        session: testSession,
        now: sampled + 10_000,
      });

      expect(response.status).toBe(503);
      expect(nas.requests).toEqual([]);
      expect(await operations()).toEqual([]);
      const row = await intentRow(intent.id);
      expect(row.status).toBe("pending");
      expect(row.usedAt).toBeNull();
    });

    it("closes the intent as failed when the agent rejects the command", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      nas.behaviour = "reject";

      const response = await execute(token);

      expect(response.status).toBe(400);
      expect(nas.requests).toHaveLength(1);
      expect((await operations())[0]).toMatchObject({
        id: intent.id,
        status: "failed",
      });
      expect((await intentRow(intent.id)).status).toBe("failed");
      expect((await execute(token)).status).toBe(200);
      expect(nas.requests).toHaveLength(1);
    });

    it("leaves a lost reply pending and the intent uncertain without resending", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      nas.behaviour = "uncertain";

      const response = await execute(token);

      expect(response.status).toBe(502);
      expect((await operations())[0]).toMatchObject({
        id: intent.id,
        status: "pending",
      });
      expect((await intentRow(intent.id)).status).toBe("uncertain");
      const again = await execute(token);
      expect(again.status).toBe(200);
      expect(nas.requests).toHaveLength(1);
    });

    it.each([
      ["container:plex", "act_start"],
      ["container:plex", "act_restart"],
      ["reboot-pending", "act_reboot"],
    ] as const)(
      "answers 501 for %s %s before claiming the intent",
      async (key, action) => {
        const { token, intent } = await handoffFor(key, action);

        const response = await execute(token);

        expect(response.status).toBe(501);
        expect(await response.json()).toMatchObject({
          code: "action_unavailable",
        });
        expect(nas.requests).toEqual([]);
        expect(await operations()).toEqual([]);
        expect((await intentRow(intent.id)).status).toBe("pending");
      },
    );
  });

  describe("manifest authority", () => {
    /** One notice key per action; the type keeps it exhaustive. */
    const keyFor: Record<IntentActionId, string> = {
      start: "container:svc-start",
      restart: "container:svc-restart",
      reboot: "reboot-pending",
      "backup-now": "backup-failed",
      "deploy-now": "deploy-failed",
    };

    it("answers 403 to every protected stored action without verification, and not to start", async () => {
      for (const action of intentsModule.intentActionIds) {
        const { token, intent } = await handoffFor(
          keyFor[action],
          intentsModule.tokenActionOf(action),
        );
        await clearVerification(db, tables);

        const response = await execute(token);

        if (requiresVerificationForIntent(action)) {
          expect(response.status, action).toBe(403);
          expect(await response.json(), action).toMatchObject({
            code: "recent_verification_required",
          });
          expect((await intentRow(intent.id)).status, action).toBe("pending");
        } else {
          expect(response.status, action).not.toBe(403);
        }
        expect(nas.requests, action).toEqual([]);
        expect(await operations(), action).toEqual([]);
        await seedVerifiedSession(db, tables);
      }
    });

    it("lets a body with an extra action neither lower nor raise the protection", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await clearVerification(db, tables);

      const response = await api("/api/telegram/intents/execute", {
        token,
        action: "start",
      });

      expect(response.status).toBe(400);
      expect(nas.requests).toEqual([]);
      expect(await operations()).toEqual([]);
      expect((await intentRow(intent.id)).status).toBe("pending");
    });
  });

  describe("verification factor by entry (D-13)", () => {
    const alternate = {
      Host: "private.example",
      Origin: "https://private.example",
    };
    const forged = { Host: "hub.example", Origin: "https://private.example" };
    let previousPrimary: string | undefined;

    beforeEach(() => {
      previousPrimary = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = "https://hub.example";
    });

    afterEach(() => {
      if (previousPrimary === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = previousPrimary;
    });

    it("does not run a protected intent on the primary host with a forged Origin and a password verification", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await seedVerifiedSession(db, tables, { method: "password" });

      const response = await execute(token, forged);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "recent_verification_required",
        method: "passkey",
      });
      expect((await intentRow(intent.id)).status).toBe("pending");
      expect(nas.requests).toEqual([]);
      expect(await operations()).toEqual([]);
    });

    it("lets the genuine alternate entry run it with a password verification", async () => {
      const { token, intent } = await handoffFor(
        "backup-failed",
        "act_backup_now",
      );
      await seedVerifiedSession(db, tables, { method: "password" });

      const response = await execute(token, alternate);

      expect(response.status).not.toBe(403);
      expect(response.status).toBe(200);
      expect(nas.requests).toHaveLength(1);
      expect((await intentRow(intent.id)).status).toBe("executed");
    });
  });
});
