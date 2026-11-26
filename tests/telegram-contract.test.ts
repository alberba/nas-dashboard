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
} from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { createFakeBotApi } from "./telegram-fake";
import type { RuntimeConfig } from "@/lib/runtime-config";

/**
 * Contract of the `Update` the bot reads (BOT-02).
 *
 * The fixtures carry the shape Telegram really sends, extra fields included, so
 * the tolerant schema, the parser and the pure allowlist are fixed against
 * reality rather than against a hand-written subset. Every degenerate input has
 * to return a result: nothing a caller sends may throw inside the lane.
 */

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
/** A private chat: the operator's own user id is the chat id (D-11). */
const CHAT_ID = "123456789";
const BETTER_AUTH_URL = "https://hub.example.com";
const START = Date.now() + 60 * 60_000;
const OPEN_MESSAGE_ID = 501;
const TOKEN = `v1:${"A".repeat(22)}`;

type UpdateOptions = {
  updateId?: number;
  fromId?: unknown;
  fromIsBot?: boolean;
  fromName?: string;
  chatId?: unknown;
  chatType?: string;
  data?: unknown;
  date?: number;
  /** `null` leaves the message without `from`, as an inaccessible one. */
  botAuthor?: boolean | null;
  withMessage?: boolean;
};

/**
 * One update with the full shape of a real callback: `chat_instance`,
 * `language_code`, `entities` and `reply_markup` travel as Telegram sends them.
 */
function realUpdate(options: UpdateOptions = {}) {
  const botAuthor = options.botAuthor === undefined ? true : options.botAuthor;
  return {
    update_id: options.updateId ?? 400,
    callback_query: {
      id: `cb-${options.updateId ?? 400}`,
      from: {
        id: options.fromId ?? Number(CHAT_ID),
        is_bot: options.fromIsBot ?? false,
        first_name: options.fromName ?? "Operador",
        language_code: "es",
      },
      ...(options.withMessage === false
        ? {}
        : {
            message: {
              message_id: OPEN_MESSAGE_ID,
              date: options.date ?? 1_700_000_000,
              chat: {
                id: options.chatId ?? Number(CHAT_ID),
                type: options.chatType ?? "private",
                first_name: "Operador",
                username: "operador",
              },
              ...(botAuthor === null
                ? {}
                : {
                    from: {
                      id: 7,
                      is_bot: botAuthor,
                      first_name: "hub",
                    },
                  }),
              text: "NAS sin respuesta",
              entities: [{ type: "bold", offset: 0, length: 3 }],
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Abrir en el hub", url: BETTER_AUTH_URL }],
                ],
              },
            },
          }),
      chat_instance: "8912345678901234567",
      data: "data" in options ? options.data : TOKEN,
    },
  };
}

type Keyboard = {
  inline_keyboard: Array<
    Array<{ text?: string; url?: string; callback_data?: string }>
  >;
};

describe.skipIf(!baseUrl)("telegram update contract", () => {
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
    const [call] = fake.calls.filter((entry) => entry.method === "sendMessage");
    const keyboard = call.body.reply_markup as Keyboard;
    return {
      incidentId,
      token: keyboard.inline_keyboard[1][0].callback_data!,
    };
  }

  it("classifies every real-shaped fixture without throwing", () => {
    const fixtures: Array<{
      name: string;
      update: unknown;
      parsed: boolean;
      authorized: boolean;
    }> = [
      {
        name: "operator callback",
        update: realUpdate(),
        parsed: true,
        authorized: true,
      },
      {
        name: "inaccessible message",
        update: realUpdate({ date: 0, botAuthor: null }),
        parsed: true,
        authorized: true,
      },
      {
        name: "callback without message",
        update: realUpdate({ withMessage: false }),
        parsed: false,
        authorized: false,
      },
      {
        name: "another user",
        update: realUpdate({ fromId: 999 }),
        parsed: true,
        authorized: false,
      },
      {
        name: "another chat",
        update: realUpdate({ chatId: 987654 }),
        parsed: true,
        authorized: false,
      },
      {
        name: "a group",
        update: realUpdate({ chatType: "group" }),
        parsed: true,
        authorized: false,
      },
      {
        name: "a supergroup",
        update: realUpdate({ chatType: "supergroup" }),
        parsed: true,
        authorized: false,
      },
      {
        name: "a channel",
        update: realUpdate({ chatType: "channel" }),
        parsed: true,
        authorized: false,
      },
      {
        name: "a bot pressing",
        update: realUpdate({ fromIsBot: true }),
        parsed: true,
        authorized: false,
      },
      {
        name: "a message that is not the bot's",
        update: realUpdate({ botAuthor: false }),
        parsed: true,
        authorized: false,
      },
      {
        name: "data of 24 bytes",
        update: realUpdate({ data: `v1:${"A".repeat(21)}` }),
        parsed: true,
        authorized: false,
      },
      {
        name: "data of 26 bytes",
        update: realUpdate({ data: `v1:${"A".repeat(23)}` }),
        parsed: true,
        authorized: false,
      },
      {
        name: "data outside the alphabet",
        update: realUpdate({ data: `v1:${"!".repeat(22)}` }),
        parsed: true,
        authorized: false,
      },
      {
        name: "data with another prefix",
        update: realUpdate({ data: `v2:${"A".repeat(22)}` }),
        parsed: true,
        authorized: false,
      },
      {
        name: "empty data",
        update: realUpdate({ data: "" }),
        parsed: false,
        authorized: false,
      },
      {
        name: "a text message",
        update: {
          update_id: 401,
          message: {
            message_id: 5,
            date: 1_700_000_000,
            chat: { id: Number(CHAT_ID), type: "private" },
            from: {
              id: Number(CHAT_ID),
              is_bot: false,
              first_name: "Operador",
            },
            text: "/start",
          },
        },
        parsed: false,
        authorized: false,
      },
      {
        name: "an edited message",
        update: { update_id: 402, edited_message: { message_id: 5 } },
        parsed: false,
        authorized: false,
      },
      {
        name: "a channel post",
        update: { update_id: 403, channel_post: { message_id: 5 } },
        parsed: false,
        authorized: false,
      },
      {
        name: "a chat member change",
        update: { update_id: 404, my_chat_member: { chat: { id: 1 } } },
        parsed: false,
        authorized: false,
      },
      {
        name: "an inline query",
        update: { update_id: 405, inline_query: { id: "1", query: "" } },
        parsed: false,
        authorized: false,
      },
    ];

    for (const fixture of fixtures) {
      expect(() => lane.parseCallbackUpdate(fixture.update)).not.toThrow();
      const parsed = lane.parseCallbackUpdate(fixture.update);
      expect(parsed === null, fixture.name).toBe(!fixture.parsed);
      expect(
        lane.isAuthorizedCallback(parsed, { chatId: CHAT_ID }),
        fixture.name,
      ).toBe(fixture.authorized);
      // Every fixture with an update id is inside the tolerant schema.
      expect(lane.telegramUpdateSchema.safeParse(fixture.update).success).toBe(
        true,
      );
    }
  });

  it("denies on each allowlist condition on its own", () => {
    const check = (options: UpdateOptions) =>
      lane.isAuthorizedCallback(lane.parseCallbackUpdate(realUpdate(options)), {
        chatId: CHAT_ID,
      });

    expect(check({})).toBe(true);
    // One condition changed at a time: each one alone is enough to deny.
    expect(check({ fromId: 999 })).toBe(false);
    expect(check({ chatId: 987654 })).toBe(false);
    expect(check({ chatType: "group" })).toBe(false);
    expect(check({ fromIsBot: true })).toBe(false);
    expect(check({ botAuthor: false })).toBe(false);
    expect(check({ data: "v1:short" })).toBe(false);
  });

  it("returns a result for every degenerate input", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      1.5,
      -1,
      Number.NaN,
      "",
      "text",
      true,
      [],
      [realUpdate()],
      {},
      { update_id: 1 },
      { update_id: "1" },
      { update_id: 1, callback_query: null },
      { update_id: 1, callback_query: "no" },
      { update_id: 1, callback_query: [] },
      { update_id: 1, callback_query: { id: 1 } },
      {
        update_id: 1,
        callback_query: { id: "a", from: { id: "1" }, message: {}, data: TOKEN },
      },
      realUpdate({ fromId: Number.MAX_SAFE_INTEGER + 2 }),
      realUpdate({ chatId: Number.MAX_SAFE_INTEGER + 2 }),
      realUpdate({ data: `v1:${"A".repeat(500_000)}` }),
      realUpdate({ fromName: "N".repeat(100_000) }),
      deep,
    ];

    for (const input of inputs) {
      expect(() => lane.parseCallbackUpdate(input)).not.toThrow();
      expect(() =>
        lane.isAuthorizedCallback(lane.parseCallbackUpdate(input), {
          chatId: CHAT_ID,
        }),
      ).not.toThrow();
    }
    // An id outside the safe range parses but is never authorised.
    expect(
      lane.isAuthorizedCallback(
        lane.parseCallbackUpdate(
          realUpdate({ fromId: Number.MAX_SAFE_INTEGER + 2 }),
        ),
        { chatId: CHAT_ID },
      ),
    ).toBe(false);
  });

  it("advances the offset for every foreign update kind without answering", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId } = await sendOpening(fake, client);
      const callsBefore = fake.calls.length;
      const before = {
        incidents: (await db.select().from(tables.incidents)).length,
        events: (await db.select().from(tables.incidentEvents)).length,
        outbox: (await db.select().from(tables.notificationOutbox)).length,
        tokens: (await db.select().from(tables.telegramActionTokens)).length,
      };

      const foreign = [
        {
          update_id: 701,
          message: {
            message_id: 6,
            date: 1_700_000_000,
            chat: { id: Number(CHAT_ID), type: "private" },
            from: {
              id: Number(CHAT_ID),
              is_bot: false,
              first_name: "Operador",
            },
            text: "/status",
          },
        },
        { update_id: 702, edited_message: { message_id: 6, text: "editado" } },
        { update_id: 703, channel_post: { message_id: 7, text: "post" } },
        { update_id: 704, my_chat_member: { chat: { id: Number(CHAT_ID) } } },
        { update_id: 705, inline_query: { id: "inline-1", query: "hola" } },
      ];
      for (const update of foreign) fake.enqueueUpdate(update);

      const updates = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: fake.transport,
        now: () => START + 60_000,
      });
      const outcome = await updates.run({ waitSeconds: 0 });
      expect(outcome).toMatchObject({ ok: true, handled: 0 });

      const methodCalls = fake.calls
        .slice(callsBefore)
        .map((call) => call.method);
      // Only the webhook removal and the poll itself leave the process.
      expect(methodCalls).toEqual(["deleteWebhook", "getUpdates"]);

      const [state] = await db.select().from(tables.telegramPollState);
      expect(state.lastUpdateId).toBe(705);

      // A foreign update leaves no row behind.
      expect((await db.select().from(tables.incidents)).length).toBe(
        before.incidents,
      );
      expect((await db.select().from(tables.incidentEvents)).length).toBe(
        before.events,
      );
      expect((await db.select().from(tables.notificationOutbox)).length).toBe(
        before.outbox,
      );
      expect((await db.select().from(tables.telegramActionTokens)).length).toBe(
        before.tokens,
      );
      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.acknowledgedAt).toBeNull();
    } finally {
      await safeEnd(client);
    }
  });
});
