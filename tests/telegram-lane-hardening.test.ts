import { Client } from "pg";
import { eq } from "drizzle-orm";
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
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { TelegramTransport } from "@/lib/telegram";

/**
 * Hardening of the inbound lane: a poisoned update cannot block the queue, a
 * week of silence cannot swallow a random id, a 409 re-arms the webhook removal
 * and the token and silence tables are pruned on their own (T-05-17, T-05-18).
 */

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
/** A private chat: the operator's own user id is the chat id (D-11). */
const CHAT_ID = "123456789";
const BETTER_AUTH_URL = "https://hub.example.com";
// The database defaults `nextAttemptAt` to the real clock; keep the injected
// clock comfortably ahead so a freshly opened row is due in the test timeline.
const START = Date.now() + 60 * 60_000;
const DAY = 86_400_000;
/** A value that must never reach a log line or a stored row. */
const CANARY = "CANARIO-DEL-UPDATE-9f3a";

/**
 * Infrastructure failures injected into the shared action. `applyTokenAction`
 * calls it inside the lane transaction, so throwing here is exactly the
 * "database or code failed while handling an authorised update" case.
 */
const poison = vi.hoisted(() => ({ failures: 0 }));

vi.mock("@/lib/incident-actions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/incident-actions")>();
  return {
    ...actual,
    applyIncidentAction: (...args: Parameters<typeof actual.applyIncidentAction>) => {
      if (poison.failures > 0) {
        poison.failures -= 1;
        return Promise.reject(new Error("fallo de infraestructura"));
      }
      return actual.applyIncidentAction(...args);
    },
  };
});

type Keyboard = {
  inline_keyboard: Array<
    Array<{ text?: string; url?: string; callback_data?: string }>
  >;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe.skipIf(!baseUrl)("telegram lane hardening", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let lane: typeof import("@/lib/telegram-updates");
  let config: RuntimeConfig;
  const openClients = new Set<Client>();

  beforeAll(async () => {
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
    config = {
      databaseUrl: context.url,
      betterAuthSecret: "b".repeat(32),
      betterAuthUrl: BETTER_AUTH_URL,
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
  });

  afterEach(async () => {
    poison.failures = 0;
    for (const client of openClients) await client.end().catch(() => {});
    openClients.clear();
  });

  beforeEach(async () => {
    await db.delete(tables.telegramActionTokens);
    await db.delete(tables.incidentSnoozes);
    await db.delete(tables.telegramPollState);
    await db.delete(tables.digestRuns);
    await db.delete(tables.telegramCooldown);
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
    await db.delete(tables.subscriptions);
    await db.delete(tables.user);
  });

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: context.url });
    await client.connect();
    openClients.add(client);
    return client;
  }

  async function lockOwner(): Promise<Client> {
    const client = await connect();
    expect(await dispatch.acquireCollectionLock(client)).toBe(true);
    return client;
  }

  async function safeEnd(client: Client) {
    openClients.delete(client);
    await client.end().catch(() => {});
  }

  /** One open critical episode and the acknowledged-me envelope. */
  async function openCritical(key = "connection"): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity: "critical",
      title: "NAS sin respuesta",
      detail: "Sin métricas del agente",
      now: START,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    return opened.incidentId!;
  }

  /** Sends the real opening and returns the rendered `ack` token. */
  async function sendOpening(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
  ): Promise<{ incidentId: number; token: string }> {
    const incidentId = await openCritical();
    const sent = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 1_000,
      fetchImpl: fake.transport,
    });
    expect(sent.action).toBe("sent");
    const keyboards = fake.calls.filter((call) => call.method === "sendMessage");
    const keyboard = keyboards[0].body.reply_markup as Keyboard;
    const token = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    expect(typeof token).toBe("string");
    return { incidentId, token: token! };
  }

  function laneAt(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    now: number,
    log?: (line: string) => void,
  ) {
    return lane.createUpdatesLane({
      client,
      config,
      fetchImpl: fake.transport,
      now: () => now,
      log,
    });
  }

  it("drops a poisoned update after three attempts and keeps the queue moving", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const lines: string[] = [];
    try {
      const { incidentId, token } = await sendOpening(fake, client);

      const update = fake.callbackUpdate({
        updateId: 901,
        data: token,
        messageId: 501,
      }) as unknown as {
        update_id: number;
        callback_query: { from: Record<string, unknown>; message: Record<string, unknown> };
      };
      update.callback_query.from.first_name = CANARY;
      update.callback_query.message.text = CANARY;
      fake.enqueueUpdate(update);

      poison.failures = 3;
      const updates = laneAt(fake, client, START + 60_000, (line) =>
        lines.push(line),
      );

      const first = await updates.run({ waitSeconds: 0 });
      expect(first).toMatchObject({ ok: false, handled: 0 });
      let [state] = await db.select().from(tables.telegramPollState);
      expect(state?.lastUpdateId ?? null).toBeNull();

      const second = await updates.run({ waitSeconds: 0 });
      expect(second).toMatchObject({ ok: false, handled: 0 });
      [state] = await db.select().from(tables.telegramPollState);
      expect(state?.lastUpdateId ?? null).toBeNull();

      const third = await updates.run({ waitSeconds: 0 });
      expect(third).toMatchObject({ ok: true, handled: 1 });

      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      // The poisoned update left no trace on the episode.
      expect(incident.acknowledgedAt).toBeNull();
      expect(incident.seq).toBe(1);

      const fourth = await updates.run({ waitSeconds: 0 });
      expect(fourth.ok).toBe(true);
      const polls = fake.calls.filter((call) => call.method === "getUpdates");
      // The fourth poll already asks for the update after the poisoned one.
      expect(polls.at(-1)!.body.offset).toBe(902);
      expect(fake.calls.filter((call) => call.method === "answerCallbackQuery"))
        .toHaveLength(0);

      const text = lines.join("\n");
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(token);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(3);
    } finally {
      await safeEnd(client);
    }
  });

  it("treats a user failure as a result, never as a poisoned update", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      await openCritical();
      // Well-formed but unknown token: a user case, not an infrastructure one.
      fake.enqueueUpdate(
        fake.callbackUpdate({
          updateId: 910,
          data: `v1:${"B".repeat(22)}`,
          messageId: 501,
        }),
      );

      const updates = laneAt(fake, client, START + 60_000);
      const outcome = await updates.run({ waitSeconds: 0 });
      expect(outcome).toMatchObject({ ok: true, handled: 1 });

      const [state] = await db.select().from(tables.telegramPollState);
      expect(state.lastUpdateId).toBe(910);
      expect(
        fake.calls.filter((call) => call.method === "answerCallbackQuery"),
      ).toHaveLength(1);
    } finally {
      await safeEnd(client);
    }
  });

  it("omits a stale offset so a random id after a week is still processed", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId, token } = await sendOpening(fake, client);
      // A week of silence: the stored id can no longer be trusted.
      await db.insert(tables.telegramPollState).values({
        name: lane.TELEGRAM_POLL_STATE_NAME,
        lastUpdateId: 5_000,
        lastUpdateAt: new Date(START - 7 * DAY),
        updatedAt: new Date(START - 7 * DAY),
      });
      fake.enqueueUpdate(
        fake.callbackUpdate({ updateId: 42, data: token, messageId: 501 }),
      );

      const updates = laneAt(fake, client, START + 60_000);
      const outcome = await updates.run({ waitSeconds: 0 });
      expect(outcome).toMatchObject({ ok: true, handled: 1 });

      const poll = fake.calls.find((call) => call.method === "getUpdates")!;
      expect(poll.body).not.toHaveProperty("offset");
      expect(poll.body.allowed_updates).toEqual(["callback_query"]);

      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.acknowledgedAt).not.toBeNull();

      // The offset is written without a monotonic guard: it moves down.
      const [state] = await db.select().from(tables.telegramPollState);
      expect(state.lastUpdateId).toBe(42);
    } finally {
      await safeEnd(client);
    }
  });

  it("keeps the offset while the stored id is fresh", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId, token } = await sendOpening(fake, client);
      await db.insert(tables.telegramPollState).values({
        name: lane.TELEGRAM_POLL_STATE_NAME,
        lastUpdateId: 500,
        lastUpdateAt: new Date(START - 5 * DAY),
        updatedAt: new Date(START - 5 * DAY),
      });
      fake.enqueueUpdate(
        fake.callbackUpdate({ updateId: 501, data: token, messageId: 501 }),
      );

      const updates = laneAt(fake, client, START + 60_000);
      const outcome = await updates.run({ waitSeconds: 0 });
      expect(outcome).toMatchObject({ ok: true, handled: 1 });

      const poll = fake.calls.find((call) => call.method === "getUpdates")!;
      expect(poll.body.offset).toBe(501);
      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.acknowledgedAt).not.toBeNull();
    } finally {
      await safeEnd(client);
    }
  });

  it("removes the webhook again before polling after a conflict", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    let conflicts = 0;
    const methods: string[] = [];
    const transport: TelegramTransport = async (url, init) => {
      methods.push(url.slice(url.lastIndexOf("/") + 1));
      if (url.endsWith("/getUpdates") && conflicts++ === 0) {
        // A second consumer or a leftover webhook: the provider refuses.
        return json({ ok: false, description: "Conflict" }, 409);
      }
      return fake.transport(url, init);
    };
    try {
      const updates = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: transport,
        now: () => START + 60_000,
      });

      const first = await updates.run({ waitSeconds: 0 });
      expect(first.ok).toBe(false);
      // The backoff of 1 s applies: a conflict never polls in a hot loop.
      expect(updates.idleMs()).toBe(lane.TELEGRAM_UPDATES_BACKOFF_MS);

      const second = await updates.run({ waitSeconds: 0 });
      expect(second.ok).toBe(true);

      expect(methods).toEqual([
        "deleteWebhook",
        "getUpdates",
        "deleteWebhook",
        "getUpdates",
      ]);
    } finally {
      await safeEnd(client);
    }
  });

  it("prunes expired tokens and silences without touching live state", async () => {
    const cleanup = await import("@/lib/telegram-cleanup");
    const now = START + 60_000;
    const incidentId = await openCritical();

    const token = (hash: string, expiresAt: number) => ({
      tokenHash: hash,
      incidentId,
      action: "ack",
      chatId: CHAT_ID,
      expiresAt: new Date(expiresAt),
    });
    await db.insert(tables.telegramActionTokens).values([
      token("a".repeat(64), now - 2 * DAY),
      token("b".repeat(64), now - 3_600_000),
      token("c".repeat(64), now + DAY),
    ]);

    const silence = (key: string, until: number) => ({
      hostId: "nas-home",
      key,
      until: new Date(until),
      setAt: new Date(now - 30 * DAY),
      setVia: "telegram",
      updatedAt: new Date(now - 30 * DAY),
    });
    await db.insert(tables.incidentSnoozes).values([
      silence("temperature", now - 8 * DAY),
      silence("cpu", now - DAY),
      silence("disk", now + DAY),
    ]);

    await db.insert(tables.telegramPollState).values({
      name: lane.TELEGRAM_POLL_STATE_NAME,
      lastUpdateId: 777,
      lastUpdateAt: new Date(now - 1_000),
      updatedAt: new Date(now - 1_000),
    });

    const deleted = await cleanup.cleanupTelegramState(db, new Date(now));
    expect(deleted).toEqual({ tokens: 1, snoozes: 1 });

    const tokens = await db.select().from(tables.telegramActionTokens);
    expect(tokens.map((row) => row.tokenHash).sort()).toEqual([
      "b".repeat(64),
      "c".repeat(64),
    ]);
    const snoozes = await db.select().from(tables.incidentSnoozes);
    expect(snoozes.map((row) => row.key).sort()).toEqual(["cpu", "disk"]);

    const [state] = await db.select().from(tables.telegramPollState);
    expect(state.lastUpdateId).toBe(777);
  });

  it("keeps the retention windows of the cleanup at a day and a week", async () => {
    const cleanup = await import("@/lib/telegram-cleanup");
    expect(cleanup.TOKEN_RETENTION_AFTER_EXPIRY_MS).toBe(DAY);
    expect(cleanup.SNOOZE_RETENTION_MS).toBe(7 * DAY);
    expect(lane.POISON_MAX_ATTEMPTS).toBe(3);
    expect(lane.OFFSET_RESET_AFTER_MS).toBe(6 * DAY);
  });
});
