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

/**
 * Replays of every bot action (BOT-06).
 *
 * For each of the five buttons the lane is driven with a real token through the
 * fake provider under the six ways an update can arrive twice, late, foreign or
 * after a restart. The assertion is always the same: at most one effect, no
 * exception out of the lane and one `answerCallbackQuery` per treated update.
 * The facts are counted in the durable rows, never in the wording of the toast.
 */

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
/** A private chat: the operator's own user id is the chat id (D-11). */
const CHAT_ID = "123456789";
const BETTER_AUTH_URL = "https://hub.example.com";
const START = Date.now() + 60 * 60_000;
const DAY = 86_400_000;
const OPEN_MESSAGE_ID = 501;
const OTHER_MESSAGE_ID = 999;

type ActionName = "ack" | "snooze_1h" | "snooze_24h" | "unsnooze" | "why";

/** Where each rendered button sits in the opening keyboard. */
const BUTTONS: Record<Exclude<ActionName, "unsnooze">, [number, number]> = {
  ack: [1, 0],
  snooze_1h: [2, 0],
  snooze_24h: [2, 1],
  why: [3, 0],
};

const ACTIONS: ActionName[] = [
  "ack",
  "snooze_1h",
  "snooze_24h",
  "unsnooze",
  "why",
];

type Scenario = {
  id:
    | "repeated token"
    | "update repeated because the offset was not confirmed"
    | "expired token"
    | "token of another message"
    | "token of a deleted episode"
    | "lane restarted";
  /** Effects the scenario may produce: never more than one. */
  effects: 0 | 1;
  /** One answer per treated update, exactly one per delivered press. */
  answers: number;
};

const SCENARIOS: Scenario[] = [
  { id: "repeated token", effects: 1, answers: 2 },
  {
    id: "update repeated because the offset was not confirmed",
    effects: 1,
    answers: 2,
  },
  { id: "expired token", effects: 0, answers: 1 },
  { id: "token of another message", effects: 0, answers: 1 },
  { id: "token of a deleted episode", effects: 0, answers: 1 },
  { id: "lane restarted", effects: 1, answers: 1 },
];

type Keyboard = {
  inline_keyboard: Array<
    Array<{ text?: string; url?: string; callback_data?: string }>
  >;
};

describe.skipIf(!baseUrl)("telegram action replays", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let lane: typeof import("@/lib/telegram-updates");
  let actions: typeof import("@/lib/incident-actions");
  let keyboard: typeof import("@/lib/telegram-keyboard");
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
    actions = await import("@/lib/incident-actions");
    keyboard = await import("@/lib/telegram-keyboard");
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

  /** Sends the real notice and returns its rendered keyboard. */
  async function sendOpening(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
  ): Promise<{ incidentId: number; tokens: Record<string, string> }> {
    const incidentId = await openCritical();
    const sent = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 1_000,
      fetchImpl: fake.transport,
    });
    expect(sent.action).toBe("sent");
    const [call] = fake.calls.filter((entry) => entry.method === "sendMessage");
    const markup = call.body.reply_markup as Keyboard;
    const tokens: Record<string, string> = {};
    for (const [action, [row, column]] of Object.entries(BUTTONS)) {
      const value = markup.inline_keyboard[row]?.[column]?.callback_data;
      expect(typeof value, action).toBe("string");
      tokens[action] = value!;
    }
    return { incidentId, tokens };
  }

  /** One turn of a fresh lane over the durable offset. */
  async function runLane(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    at: number,
  ) {
    const updates = lane.createUpdatesLane({
      client,
      config,
      fetchImpl: fake.transport,
      now: () => at,
    });
    return updates.run({ waitSeconds: 0 });
  }

  /** Presses one button through the real lane, as Telegram would deliver it. */
  async function press(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    input: { token: string; updateId: number; messageId?: number; at: number },
  ) {
    fake.enqueueUpdate(
      fake.callbackUpdate({
        updateId: input.updateId,
        data: input.token,
        messageId: input.messageId ?? OPEN_MESSAGE_ID,
      }),
    );
    return runLane(fake, client, input.at);
  }

  async function eventsOf(incidentId: number) {
    return db
      .select()
      .from(tables.incidentEvents)
      .where(eq(tables.incidentEvents.incidentId, incidentId));
  }

  async function whyRows(incidentId: number) {
    return db
      .select()
      .from(tables.notificationOutbox)
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-why"),
        ),
      );
  }

  async function snoozeRows() {
    return db.select().from(tables.incidentSnoozes);
  }

  /** Durable count of effects one action can have produced. */
  async function effectCount(
    action: ActionName,
    incidentId: number,
  ): Promise<number> {
    if (action === "why") return (await whyRows(incidentId)).length;
    const events = await eventsOf(incidentId);
    const kind =
      action === "ack"
        ? "acknowledged"
        : action === "unsnooze"
          ? "unsnoozed"
          : "snoozed";
    return events.filter((event) => event.kind === kind).length;
  }

  /** Whether the action left the state it is supposed to leave. */
  async function stateApplied(
    action: ActionName,
    incidentId: number,
  ): Promise<boolean> {
    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    switch (action) {
      case "ack":
        return incident.acknowledgedAt !== null;
      case "snooze_1h":
      case "snooze_24h":
        return (await snoozeRows()).length === 1;
      case "unsnooze":
        return (await snoozeRows()).length === 0;
      case "why":
        return (await whyRows(incidentId)).length === 1;
    }
  }

  describe.each(ACTIONS)("%s", (action) => {
    async function prepare() {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      const { incidentId, tokens } = await sendOpening(fake, client);
      let token: string;
      if (action === "unsnooze") {
        // A live silence is what the "Quitar silencio" button needs; the token
        // is issued exactly as the silent edit would render it.
        await db.transaction((tx) =>
          actions.applyIncidentAction(tx, {
            action: "snooze",
            hours: 1,
            incidentId,
            via: "hub",
            by: "test",
            now: START + 2_000,
          }),
        );
        const issued = await keyboard.issueActionTokens(db, {
          incidentId,
          chatId: CHAT_ID,
          actions: ["unsnooze"],
          now: START + 2_000,
        });
        token = issued.unsnooze!;
      } else {
        token = tokens[action];
      }
      return { fake, client, incidentId, token };
    }

    it.each(SCENARIOS)(
      "at most one effect on a $id",
      async (scenario: Scenario) => {
        const { fake, client, incidentId, token } = await prepare();
        const at = START + 60_000;
        const outcomes = [];
        try {
          switch (scenario.id) {
            case "repeated token": {
              outcomes.push(
                await press(fake, client, { token, updateId: 801, at }),
              );
              outcomes.push(
                await press(fake, client, {
                  token,
                  updateId: 802,
                  at: at + 1_000,
                }),
              );
              break;
            }
            case "update repeated because the offset was not confirmed": {
              outcomes.push(
                await press(fake, client, { token, updateId: 803, at }),
              );
              // A crash between the commit and the offset: Telegram redelivers
              // the same update, so the lane is re-run without enqueuing it.
              await db.delete(tables.telegramPollState);
              outcomes.push(await runLane(fake, client, at + 1_000));
              break;
            }
            case "expired token": {
              // Seven-day TTL: pressing a week later finds it expired.
              outcomes.push(
                await press(fake, client, {
                  token,
                  updateId: 804,
                  at: START + 8 * DAY,
                }),
              );
              break;
            }
            case "token of another message": {
              outcomes.push(
                await press(fake, client, {
                  token,
                  updateId: 805,
                  at,
                  messageId: OTHER_MESSAGE_ID,
                }),
              );
              break;
            }
            case "token of a deleted episode": {
              await db
                .delete(tables.incidents)
                .where(eq(tables.incidents.id, incidentId));
              outcomes.push(
                await press(fake, client, { token, updateId: 806, at }),
              );
              break;
            }
            case "lane restarted": {
              outcomes.push(
                await press(fake, client, { token, updateId: 807, at }),
              );
              // A new lane reads the durable offset and delivers nothing twice.
              outcomes.push(await runLane(fake, client, at + 1_000));
              break;
            }
          }

          for (const outcome of outcomes) expect(outcome.ok).toBe(true);
          if (scenario.id === "lane restarted")
            expect(outcomes[1]).toMatchObject({ ok: true, handled: 0 });

          expect(
            await effectCount(action, incidentId),
            `${action} on a ${scenario.id}`,
          ).toBe(scenario.effects);
          if (scenario.effects === 1)
            expect(await stateApplied(action, incidentId)).toBe(true);

          const answers = fake.calls.filter(
            (call) => call.method === "answerCallbackQuery",
          );
          expect(answers).toHaveLength(scenario.answers);
        } finally {
          await safeEnd(client);
        }
      },
    );
  });

  it("answers generically when the opening delivery stayed uncertain", async () => {
    // Pitfall 8: the notice may have arrived, but its row has no messageId.
    const [incident] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "connection",
        title: "NAS sin respuesta",
        detail: "Sin métricas del agente",
        severity: "critical",
        at: new Date(START),
        fingerprint: store.incidentFingerprint("nas-home", "connection"),
        seq: 1,
        origin: "live",
      })
      .returning();
    await db.insert(tables.incidentEvents).values({
      incidentId: incident.id,
      seq: 1,
      kind: "opened",
      severity: "critical",
      title: "NAS sin respuesta",
      detail: "Sin métricas del agente",
      at: new Date(START),
    });
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${incident.id}:open`,
      incidentId: incident.id,
      kind: "incident-open",
      channel: "telegram",
      status: "uncertain",
      revision: 1,
      chatId: CHAT_ID,
      messageId: null,
    });
    const issued = await keyboard.issueActionTokens(db, {
      incidentId: incident.id,
      chatId: CHAT_ID,
      actions: ["ack"],
      now: START + 1_000,
    });

    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const outcome = await press(fake, client, {
        token: issued.ack!,
        updateId: 820,
        at: START + 60_000,
      });
      expect(outcome.ok).toBe(true);

      const [after] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incident.id));
      expect(after.acknowledgedAt).toBeNull();
      expect(after.seq).toBe(1);
      expect(await effectCount("ack", incident.id)).toBe(0);
      // Nothing was written and the token was not burned: the hub still acts.
      const [token] = await db
        .select()
        .from(tables.telegramActionTokens)
        .where(
          eq(
            tables.telegramActionTokens.tokenHash,
            keyboard.hashActionToken(issued.ack!),
          ),
        );
      expect(token.usedAt).toBeNull();
      // The spinner is closed even though nothing was applied.
      expect(
        fake.calls.filter((call) => call.method === "answerCallbackQuery"),
      ).toHaveLength(1);
    } finally {
      await safeEnd(client);
    }
  });

  it("keeps the second button of an unedited keyboard independent", async () => {
    // Pitfall 9: the old keyboard is still on screen until the edit lands.
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const { incidentId, tokens } = await sendOpening(fake, client);
      const first = await press(fake, client, {
        token: tokens.ack,
        updateId: 830,
        at: START + 60_000,
      });
      expect(first.ok).toBe(true);

      const second = await press(fake, client, {
        token: tokens.snooze_1h,
        updateId: 831,
        at: START + 61_000,
      });
      expect(second.ok).toBe(true);

      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.acknowledgedAt).not.toBeNull();
      const events = await eventsOf(incidentId);
      expect(events.filter((event) => event.kind === "acknowledged")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "snoozed")).toHaveLength(1);
      expect(await snoozeRows()).toHaveLength(1);
      expect(
        fake.calls.filter((call) => call.method === "answerCallbackQuery"),
      ).toHaveLength(2);
    } finally {
      await safeEnd(client);
    }
  });
});
