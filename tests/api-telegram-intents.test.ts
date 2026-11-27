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
import type { RuntimeConfig } from "@/lib/runtime-config";

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
    action: "act_backup_now" | "act_start" | "act_restart" | "act_deploy_now" | "act_reboot",
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
});
