import { createHash } from "node:crypto";
import { Client } from "pg";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { createFakeBotApi } from "./telegram-fake";
import type { RuntimeConfig } from "@/lib/runtime-config";

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
/** A private chat: the operator's own user id is the chat id (D-11). */
const CHAT_ID = "123456789";
const BETTER_AUTH_URL = "https://hub.example.com";
// The database defaults `nextAttemptAt` to the real clock; keep the injected
// clock comfortably ahead so a freshly opened row is due in the test timeline.
const START = Date.now() + 60 * 60_000;

/** The `HH:mm` of an instant in Europe/Madrid, computed by the test itself. */
function madridClockOf(at: Date | number): string {
  const instant = at instanceof Date ? at : new Date(at);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

type Keyboard = {
  inline_keyboard: Array<
    Array<{ text?: string; url?: string; callback_data?: string }>
  >;
};

describe.skipIf(!baseUrl)("telegram updates", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let lane: typeof import("@/lib/telegram-updates");
  let loop: typeof import("@/lib/worker-loop");
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
    loop = await import("@/lib/worker-loop");
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

  it("acknowledges a real notice once and edits the same message", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId, token } = await sendOpening(fake, client);

      const markup = fake.calls[0].body.reply_markup as Keyboard;
      expect(markup.inline_keyboard[0]).toHaveLength(1);
      expect(typeof markup.inline_keyboard[0][0].url).toBe("string");
      // Acknowledging keeps its own row; the two silence controls share the next.
      expect(markup.inline_keyboard[1]).toHaveLength(1);
      expect(markup.inline_keyboard[2]).toHaveLength(2);
      expect(token).toMatch(/^v1:[A-Za-z0-9_-]{22}$/);
      expect(Buffer.byteLength(token, "utf8")).toBe(25);

      // The database only knows the digest of the button.
      const hash = createHash("sha256").update(token).digest("hex");
      const tokens = await db
        .select()
        .from(tables.telegramActionTokens)
        .where(eq(tables.telegramActionTokens.tokenHash, hash));
      expect(tokens).toHaveLength(1);
      expect(tokens[0].action).toBe("ack");
      expect(tokens[0].usedAt).toBeNull();

      fake.enqueueUpdate(
        fake.callbackUpdate({
          updateId: 101,
          data: token,
          messageId: 501,
        }),
      );

      const updates = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: fake.transport,
        now: () => START + 60_000,
      });
      const outcome = await updates.run({ waitSeconds: 0 });
      expect(outcome).toMatchObject({ ok: true, handled: 1 });

      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.acknowledgedAt).not.toBeNull();
      expect(incident.acknowledgedVia).toBe("telegram");
      expect(incident.acknowledgedBy).toBeNull();
      expect(incident.seq).toBe(2);

      const events = await db
        .select()
        .from(tables.incidentEvents)
        .where(eq(tables.incidentEvents.incidentId, incidentId));
      expect(events.filter((event) => event.kind === "acknowledged")).toHaveLength(1);

      const [pollState] = await db.select().from(tables.telegramPollState);
      expect(pollState.lastUpdateId).toBe(101);

      const edits = await db
        .select()
        .from(tables.notificationOutbox)
        .where(
          and(
            eq(tables.notificationOutbox.incidentId, incidentId),
            eq(tables.notificationOutbox.kind, "incident-edit"),
          ),
        );
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ status: "pending", revision: 2 });

      const [consumed] = await db
        .select()
        .from(tables.telegramActionTokens)
        .where(eq(tables.telegramActionTokens.tokenHash, hash));
      expect(consumed.usedAt).not.toBeNull();

      const answers = fake.calls.filter(
        (call) => call.method === "answerCallbackQuery",
      );
      expect(answers).toHaveLength(1);
      expect(answers[0].body.callback_query_id).toBe("cb-101");

      // The silent edit drops the Reconocer button: it cannot be undone, and the
      // two silence controls remain.
      const edited = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 120_000,
        fetchImpl: fake.transport,
      });
      expect(edited.action).toBe("edited");
      const editTokens = fake.lastKeyboard();
      // The two silence controls plus the explanation that every state keeps.
      expect(editTokens).toHaveLength(3);
      expect(editTokens).not.toContain(token);
      for (const value of editTokens)
        expect(value).toMatch(/^v1:[A-Za-z0-9_-]{22}$/);
      const editCalls = fake.calls.filter(
        (call) => call.method === "editMessageText",
      );
      expect(editCalls).toHaveLength(1);
      expect(editCalls[0].body.message_id).toBe("501");
      const editMarkup = editCalls[0].body.reply_markup as Keyboard;
      // The URL button keeps its row; the silence controls take the next one
      // and the explanation its own row.
      expect(editMarkup.inline_keyboard).toHaveLength(3);
      expect(editMarkup.inline_keyboard[1]).toHaveLength(2);
      expect(editMarkup.inline_keyboard[2]).toHaveLength(1);
      expect(editMarkup.inline_keyboard[0][0].url).toBe(
        `https://hub.example.com/?view=alerts&host=nas-home&incident=${incidentId}`,
      );
      // The acknowledged notice carries the Madrid clock of the acknowledgement,
      // computed here instead of compared against the copy.
      expect(String(editCalls[0].body.text)).toContain(
        madridClockOf(incident.acknowledgedAt!),
      );
    } finally {
      await safeEnd(client);
    }
  });

  it("ignores every unauthorised update, only advancing the offset", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId, token } = await sendOpening(fake, client);
      const callsBefore = fake.calls.length;

      const stranger = {
        update_id: 201,
        message: {
          message_id: 5,
          date: 1_700_000_000,
          chat: { id: Number(CHAT_ID), type: "private" },
          text: "hola",
          from: { id: Number(CHAT_ID), is_bot: false, first_name: "Operador" },
        },
      };
      const command = {
        update_id: 202,
        message: {
          message_id: 6,
          date: 1_700_000_000,
          chat: { id: Number(CHAT_ID), type: "private" },
          text: "/start",
          from: { id: Number(CHAT_ID), is_bot: false, first_name: "Operador" },
        },
      };
      const unauthorised = [
        fake.callbackUpdate({ updateId: 203, data: token, fromId: 999 }),
        fake.callbackUpdate({ updateId: 204, data: token, chatId: 987654 }),
        fake.callbackUpdate({ updateId: 205, data: token, chatType: "group" }),
        fake.callbackUpdate({
          updateId: 206,
          data: token,
          messageFromIsBot: false,
        }),
        fake.callbackUpdate({ updateId: 207, data: "v1:too-short" }),
        fake.callbackUpdate({ updateId: 208, data: token, fromIsBot: true }),
        stranger,
        command,
      ];
      for (const update of unauthorised) fake.enqueueUpdate(update);

      const updates = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: fake.transport,
        now: () => START + 60_000,
      });
      const outcome = await updates.run({ waitSeconds: 0 });
      expect(outcome).toMatchObject({ ok: true, handled: 0 });

      // The first poll of a lane removes the webhook; nothing else leaves.
      const outgoing = fake.calls
        .slice(callsBefore)
        .map((call) => call.method);
      expect(outgoing).toEqual(["deleteWebhook", "getUpdates"]);
      expect(
        fake.calls.filter((call) => call.method === "answerCallbackQuery"),
      ).toHaveLength(0);

      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.acknowledgedAt).toBeNull();
      expect(incident.seq).toBe(1);

      const edits = await db
        .select()
        .from(tables.notificationOutbox)
        .where(
          and(
            eq(tables.notificationOutbox.incidentId, incidentId),
            eq(tables.notificationOutbox.kind, "incident-edit"),
          ),
        );
      expect(edits).toHaveLength(0);

      const [pollState] = await db.select().from(tables.telegramPollState);
      expect(pollState.lastUpdateId).toBe(208);
    } finally {
      await safeEnd(client);
    }
  });

  it("always sends allowed_updates and removes the webhook first", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const updates = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: fake.transport,
        now: () => START + 60_000,
      });
      await updates.run({ waitSeconds: 0 });
      await updates.run({ waitSeconds: 0 });

      expect(fake.calls[0].method).toBe("deleteWebhook");
      expect(fake.calls[0].body).not.toHaveProperty("drop_pending_updates");
      expect(
        fake.calls.filter((call) => call.method === "deleteWebhook"),
      ).toHaveLength(1);
      const polls = fake.calls.filter((call) => call.method === "getUpdates");
      expect(polls.length).toBeGreaterThanOrEqual(2);
      for (const poll of polls)
        expect(poll.body.allowed_updates).toEqual(["callback_query"]);
    } finally {
      await safeEnd(client);
    }
  });

  it("does not call the API when the chat is not private", async () => {
    const fake = createFakeBotApi({ chatId: -100123 });
    const client = await lockOwner();
    const lines: string[] = [];
    try {
      const updates = lane.createUpdatesLane({
        client,
        config: {
          ...config,
          telegram: { botToken: BOT_TOKEN, chatId: "-100123" },
        },
        fetchImpl: fake.transport,
        now: () => START + 60_000,
        log: (line) => lines.push(line),
      });
      const outcome = await updates.run({ waitSeconds: 0 });
      expect(outcome.ok).toBe(false);
      expect(fake.calls).toHaveLength(0);
      expect(lines).toHaveLength(1);
    } finally {
      await safeEnd(client);
    }
  });

  it("repeats no effect when the same update or button arrives again", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId, token } = await sendOpening(fake, client);
      fake.enqueueUpdate(
        fake.callbackUpdate({ updateId: 301, data: token, messageId: 501 }),
      );

      const first = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: fake.transport,
        now: () => START + 60_000,
      });
      expect((await first.run({ waitSeconds: 0 })).handled).toBe(1);

      // Telegram redelivers the update after a crash between commit and offset:
      // the token is already used, so the effect must not repeat.
      await db.delete(tables.telegramPollState);
      const second = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: fake.transport,
        now: () => START + 61_000,
      });
      const outcome = await second.run({ waitSeconds: 0 });
      expect(outcome.ok).toBe(true);

      const events = await db
        .select()
        .from(tables.incidentEvents)
        .where(eq(tables.incidentEvents.incidentId, incidentId));
      expect(events.filter((event) => event.kind === "acknowledged")).toHaveLength(1);

      const edits = await db
        .select()
        .from(tables.notificationOutbox)
        .where(
          and(
            eq(tables.notificationOutbox.incidentId, incidentId),
            eq(tables.notificationOutbox.kind, "incident-edit"),
          ),
        );
      expect(edits).toHaveLength(1);

      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.seq).toBe(2);
    } finally {
      await safeEnd(client);
    }
  });

  it("leaves the acknowledgement clock out of an unacknowledged notice", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId } = await sendOpening(fake, client);
      // Closing the episode queues a silent edit, but nobody acknowledged it.
      const closed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: false,
        now: START + 30_000,
      });
      expect(closed.action).toBe("resolved");

      const edited = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 120_000,
        fetchImpl: fake.transport,
      });
      expect(edited.action).toBe("edited");
      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.acknowledgedAt).toBeNull();
      const editCall = fake.calls
        .filter((call) => call.method === "editMessageText")
        .at(-1)!;
      expect(String(editCall.body.text)).not.toMatch(/\b\d{2}:\d{2}\b/);
    } finally {
      await safeEnd(client);
    }
  });

  it("does not renew the health mark when the poll fails", async () => {
    let renewals = 0;
    const health = {
      renew: async () => {
        renewals += 1;
        return true;
      },
    } as unknown as import("@/lib/worker-health").WorkerHealth;
    const base = {
      health,
      holdsLock: async () => true,
      stopping: () => false,
      now: () => START,
      presenceActive: async () => false,
      sampleInterval: () => 30_000,
      collect: async () => {},
      drain: async () => {},
      cleanup: async () => {},
      state: { lastCollection: START, lastCleanup: START },
    };

    await loop.workerTurn({
      ...base,
      updates: async () => ({ handled: 0, ok: false, waitedSeconds: 0 }),
    });
    // The turn renews after the lock and after the drain; the failed poll adds
    // nothing.
    expect(renewals).toBe(2);

    await loop.workerTurn({
      ...base,
      updates: async () => ({ handled: 0, ok: true, waitedSeconds: 1 }),
    });
    expect(renewals - 2).toBe(3);
  });

  it("authorises only the operator pressing a button in the private chat", () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const token = `v1:${"A".repeat(22)}`;
    const check = (
      overrides: Omit<
        Parameters<typeof fake.callbackUpdate>[0],
        "updateId" | "data"
      >,
    ) =>
      lane.isAuthorizedCallback(
        lane.parseCallbackUpdate(
          fake.callbackUpdate({ updateId: 1, data: token, ...overrides }),
        ),
        { chatId: CHAT_ID },
      );

    expect(check({})).toBe(true);
    expect(check({ fromId: 999 })).toBe(false);
    expect(check({ chatId: 987654 })).toBe(false);
    expect(check({ chatType: "group" })).toBe(false);
    expect(check({ messageFromIsBot: false })).toBe(false);
    expect(check({ fromIsBot: true })).toBe(false);
    expect(
      lane.isAuthorizedCallback(
        lane.parseCallbackUpdate(
          fake.callbackUpdate({ updateId: 1, data: "v1:short" }),
        ),
        { chatId: CHAT_ID },
      ),
    ).toBe(false);
    // An inaccessible message has no author; the token binding proves ownership.
    expect(check({ messageDate: 0, messageFromIsBot: false })).toBe(true);
    expect(
      lane.parseCallbackUpdate({
        update_id: 2,
        message: { message_id: 1, date: 1, text: "hola" },
      }),
    ).toBeNull();
  });

  it("bounds the poll wait to the next collection", () => {
    expect(loop.updatesWaitSeconds(0)).toBe(0);
    expect(loop.updatesWaitSeconds(1)).toBe(1);
    expect(loop.updatesWaitSeconds(4_400)).toBe(3);
    expect(loop.updatesWaitSeconds(-5_000)).toBe(0);
  });
});
