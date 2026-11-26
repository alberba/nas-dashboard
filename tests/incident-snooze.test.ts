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
const HOUR_MS = 3_600_000;
const OPEN_MESSAGE_ID = 501;

describe.skipIf(!baseUrl)("incident snooze", () => {
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

  /** Sends the real notice so a later change has a message to edit. */
  async function sendOpening(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
  ): Promise<number> {
    const incidentId = await openCritical();
    const sent = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 1_000,
      fetchImpl: fake.transport,
    });
    expect(sent.action).toBe("sent");
    return incidentId;
  }

  /** Issues one real callback token exactly as a rendered keyboard would. */
  async function issueToken(
    incidentId: number,
    action: "ack" | "snooze_1h" | "snooze_24h" | "unsnooze",
    now = START + 1_000,
  ): Promise<string> {
    const issued = await keyboard.issueActionTokens(db, {
      incidentId,
      chatId: CHAT_ID,
      actions: [action],
      now,
    });
    expect(typeof issued[action]).toBe("string");
    return issued[action]!;
  }

  /** Presses a button through the real lane, as Telegram would deliver it. */
  async function press(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    input: {
      token: string;
      updateId: number;
      messageId?: number;
      at?: number;
    },
  ) {
    fake.enqueueUpdate(
      fake.callbackUpdate({
        updateId: input.updateId,
        data: input.token,
        messageId: input.messageId ?? OPEN_MESSAGE_ID,
      }),
    );
    const updates = lane.createUpdatesLane({
      client,
      config,
      fetchImpl: fake.transport,
      now: () => input.at ?? START + 60_000,
    });
    return updates.run({ waitSeconds: 0 });
  }

  async function snoozeRows() {
    return db.select().from(tables.incidentSnoozes);
  }

  async function eventsOf(incidentId: number) {
    return db
      .select()
      .from(tables.incidentEvents)
      .where(eq(tables.incidentEvents.incidentId, incidentId));
  }

  async function editsOf(incidentId: number) {
    return db
      .select()
      .from(tables.notificationOutbox)
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-edit"),
        ),
      );
  }

  async function incidentOf(incidentId: number) {
    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    return incident;
  }

  /** Runs the shared action the hub will use in 05-04. */
  async function runAction(
    input: Parameters<typeof actions.applyIncidentAction>[1],
  ) {
    return db.transaction((tx) => actions.applyIncidentAction(tx, input));
  }

  it("stores a one-hour silence from the pressed button", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const token = await issueToken(incidentId, "snooze_1h");
      const at = START + 60_000;

      const outcome = await press(fake, client, {
        token,
        updateId: 101,
        at,
      });
      expect(outcome).toMatchObject({ ok: true, handled: 1 });

      const rows = await snoozeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        hostId: "nas-home",
        key: "connection",
        setVia: "telegram",
        setBy: null,
      });
      // The deadline is the injected action clock plus exactly one hour.
      expect(rows[0].until.getTime()).toBe(at + HOUR_MS);

      const incident = await incidentOf(incidentId);
      expect(incident.seq).toBe(2);
      expect(incident.acknowledgedAt).toBeNull();

      const events = await eventsOf(incidentId);
      expect(events.filter((event) => event.kind === "snoozed")).toHaveLength(1);
      expect(
        events.find((event) => event.kind === "snoozed")!.detail,
      ).toBe(new Date(at + HOUR_MS).toISOString());

      const edits = await editsOf(incidentId);
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ status: "pending", revision: 2 });

      const answers = fake.calls.filter(
        (call) => call.method === "answerCallbackQuery",
      );
      expect(answers).toHaveLength(1);
      expect(answers[0].body.callback_query_id).toBe("cb-101");
    } finally {
      await safeEnd(client);
    }
  });

  it("stores a twenty-four hour silence from the pressed button", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const token = await issueToken(incidentId, "snooze_24h");
      const at = START + 30_000;

      expect(
        await press(fake, client, { token, updateId: 111, at }),
      ).toMatchObject({ handled: 1 });

      const rows = await snoozeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].until.getTime()).toBe(at + 24 * HOUR_MS);
    } finally {
      await safeEnd(client);
    }
  });

  it("keeps a repeated silence and extends a longer one", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 10_000;
      const first = await runAction({
        action: "snooze",
        hours: 1,
        incidentId,
        via: "telegram",
        now: at,
      });
      expect(first).toBe("applied");

      const repeated = await runAction({
        action: "snooze",
        hours: 1,
        incidentId,
        via: "telegram",
        now: at + 5_000,
      });
      expect(repeated).toBe("unchanged");

      const rows = await snoozeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].until.getTime()).toBe(at + HOUR_MS);
      expect(
        (await eventsOf(incidentId)).filter((event) => event.kind === "snoozed"),
      ).toHaveLength(1);
      expect(await editsOf(incidentId)).toHaveLength(1);

      const extended = await runAction({
        action: "snooze",
        hours: 24,
        incidentId,
        via: "telegram",
        now: at + 10_000,
      });
      expect(extended).toBe("applied");
      const extendedRows = await snoozeRows();
      expect(extendedRows).toHaveLength(1);
      expect(extendedRows[0].until.getTime()).toBe(at + 10_000 + 24 * HOUR_MS);
      // One event per applied change and one silent edit per change.
      expect(
        (await eventsOf(incidentId)).filter((event) => event.kind === "snoozed"),
      ).toHaveLength(2);
      expect(await editsOf(incidentId)).toHaveLength(2);
    } finally {
      await safeEnd(client);
    }
  });

  it("removes an active silence and records the removal", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 10_000;
      expect(
        await runAction({
          action: "snooze",
          hours: 1,
          incidentId,
          via: "telegram",
          now: at,
        }),
      ).toBe("applied");
      const before = await incidentOf(incidentId);

      const outcome = await runAction({
        action: "unsnooze",
        incidentId,
        via: "telegram",
        now: at + 60_000,
      });
      expect(outcome).toBe("applied");

      expect(await snoozeRows()).toHaveLength(0);
      const incident = await incidentOf(incidentId);
      expect(incident.seq).toBe(before.seq + 1);
      const events = await eventsOf(incidentId);
      expect(events.filter((event) => event.kind === "unsnoozed")).toHaveLength(1);
      expect(events.find((event) => event.kind === "unsnoozed")!.detail).toBe(
        "cleared",
      );
      expect(await editsOf(incidentId)).toHaveLength(2);
    } finally {
      await safeEnd(client);
    }
  });

  it("clears an expired silence so an obsolete button still refreshes the notice", async () => {
    const incidentId = await openCritical();
    await db.insert(tables.incidentSnoozes).values({
      hostId: "nas-home",
      key: "connection",
      until: new Date(START - HOUR_MS),
      setAt: new Date(START - 2 * HOUR_MS),
      setVia: "telegram",
    });

    const outcome = await runAction({
      action: "unsnooze",
      incidentId,
      via: "telegram",
      now: START,
    });
    expect(outcome).toBe("applied");
    expect(await snoozeRows()).toHaveLength(0);
    const events = await eventsOf(incidentId);
    expect(events.find((event) => event.kind === "unsnoozed")!.detail).toBe(
      "expired",
    );
  });

  it("answers without a change when there is no silence to remove", async () => {
    const incidentId = await openCritical();
    const before = await incidentOf(incidentId);

    const outcome = await runAction({
      action: "unsnooze",
      incidentId,
      via: "telegram",
      now: START + 10_000,
    });
    expect(outcome).toBe("unchanged");
    const after = await incidentOf(incidentId);
    expect(after.seq).toBe(before.seq);
    expect(
      (await eventsOf(incidentId)).filter((event) => event.kind === "unsnoozed"),
    ).toHaveLength(0);
    expect(await editsOf(incidentId)).toHaveLength(0);
  });

  it("keeps acknowledging and silencing independent", async () => {
    const incidentId = await openCritical();

    expect(
      await runAction({
        action: "ack",
        incidentId,
        via: "hub",
        by: "albertsalom",
        now: START + 10_000,
      }),
    ).toBe("applied");
    // Acknowledging writes no silence.
    expect(await snoozeRows()).toHaveLength(0);

    expect(
      await runAction({
        action: "snooze",
        hours: 1,
        incidentId,
        via: "hub",
        by: "albertsalom",
        now: START + 20_000,
      }),
    ).toBe("applied");
    const incident = await incidentOf(incidentId);
    // Silencing neither clears nor sets the acknowledgement.
    expect(incident.acknowledgedAt).not.toBeNull();
    expect(incident.acknowledgedVia).toBe("hub");
    expect(incident.acknowledgedBy).toBe("albertsalom");
    expect((await snoozeRows())[0].setBy).toBe("albertsalom");
  });

  it("silences nothing on a resolved episode", async () => {
    const incidentId = await openCritical();
    await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "connection",
      failing: false,
      now: START + 5_000,
    });
    const before = await incidentOf(incidentId);

    expect(
      await runAction({
        action: "snooze",
        hours: 1,
        incidentId,
        via: "telegram",
        now: START + 10_000,
      }),
    ).toBe("resolved");
    expect(
      await runAction({
        action: "unsnooze",
        incidentId,
        via: "telegram",
        now: START + 10_000,
      }),
    ).toBe("resolved");

    expect(await snoozeRows()).toHaveLength(0);
    const after = await incidentOf(incidentId);
    expect(after.seq).toBe(before.seq);
    expect(
      (await eventsOf(incidentId)).filter(
        (event) => event.kind === "snoozed" || event.kind === "unsnoozed",
      ),
    ).toHaveLength(0);
  });

  it("silences nothing on an episode that does not exist", async () => {
    const missing = 2_147_000_000;
    expect(
      await runAction({
        action: "snooze",
        hours: 24,
        incidentId: missing,
        via: "telegram",
        now: START,
      }),
    ).toBe("not_found");
    expect(
      await runAction({
        action: "unsnooze",
        incidentId: missing,
        via: "telegram",
        now: START,
      }),
    ).toBe("not_found");
    expect(await snoozeRows()).toHaveLength(0);
  });

  it("offers silence controls only while they make sense", () => {
    expect(
      keyboard.keyboardActions({
        resolved: false,
        acknowledged: false,
        snoozed: false,
      }),
    ).toEqual(["ack", "snooze_1h", "snooze_24h"]);
    expect(
      keyboard.keyboardActions({
        resolved: false,
        acknowledged: true,
        snoozed: false,
      }),
    ).toEqual(["snooze_1h", "snooze_24h"]);
    expect(
      keyboard.keyboardActions({
        resolved: false,
        acknowledged: false,
        snoozed: true,
      }),
    ).toEqual(["ack", "unsnooze"]);
    expect(
      keyboard.keyboardActions({
        resolved: false,
        acknowledged: true,
        snoozed: true,
      }),
    ).toEqual(["unsnooze"]);
    for (const acknowledged of [false, true])
      for (const snoozed of [false, true])
        expect(
          keyboard.keyboardActions({ resolved: true, acknowledged, snoozed }),
        ).toEqual([]);
  });

  it("refuses any silence duration outside the closed set", async () => {
    const snooze = await import("@/lib/incident-snooze");
    expect(() => snooze.snoozeDeadline(START, 2)).toThrow(RangeError);
    expect(() => snooze.snoozeDeadline(START, 0)).toThrow(RangeError);
    expect(snooze.snoozeDeadline(START, 1).getTime()).toBe(START + HOUR_MS);
    expect(snooze.snoozeDeadline(START, 24).getTime()).toBe(START + 24 * HOUR_MS);

    // A caller that bypassed the type still cannot persist an indefinite one.
    const incidentId = await openCritical();
    const invalid = {
      action: "snooze",
      hours: 2,
      incidentId,
      via: "telegram",
      now: START + 10_000,
    } as unknown as Parameters<typeof actions.applyIncidentAction>[1];
    await expect(
      db.transaction((tx) => actions.applyIncidentAction(tx, invalid)),
    ).rejects.toThrow(RangeError);
    expect(await snoozeRows()).toHaveLength(0);
  });

  it("ignores a repeated, expired or foreign silence token", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const token = await issueToken(incidentId, "snooze_1h");
      const repeatedAt = START + 60_000;

      expect(
        await press(fake, client, { token, updateId: 201, at: repeatedAt }),
      ).toMatchObject({ handled: 1 });
      const firstRows = await snoozeRows();
      expect(firstRows).toHaveLength(1);
      const firstUntil = firstRows[0].until.getTime();

      // The same callback delivered twice: already used, no second effect.
      expect(
        await press(fake, client, {
          token,
          updateId: 202,
          at: repeatedAt + 5_000,
        }),
      ).toMatchObject({ handled: 1 });

      // A token pressed on another message is void.
      const foreign = await issueToken(incidentId, "snooze_24h");
      expect(
        await press(fake, client, {
          token: foreign,
          updateId: 203,
          messageId: OPEN_MESSAGE_ID + 7,
          at: repeatedAt + 10_000,
        }),
      ).toMatchObject({ handled: 1 });

      // A token rendered before the TTL expired is refused.
      const stale = await issueToken(incidentId, "snooze_24h", START - 30 * 86_400_000);
      expect(
        await press(fake, client, {
          token: stale,
          updateId: 204,
          at: repeatedAt + 20_000,
        }),
      ).toMatchObject({ handled: 1 });

      const rows = await snoozeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].until.getTime()).toBe(firstUntil);
      const incident = await incidentOf(incidentId);
      expect(incident.acknowledgedAt).toBeNull();
      expect(
        (await eventsOf(incidentId)).filter((event) => event.kind === "snoozed"),
      ).toHaveLength(1);
      expect(await editsOf(incidentId)).toHaveLength(1);

      // Every refused press still closes its spinner with a finite answer.
      const answers = fake.calls.filter(
        (call) => call.method === "answerCallbackQuery",
      );
      expect(answers).toHaveLength(4);
      for (const answer of answers)
        expect(String(answer.body.text ?? "").length).toBeGreaterThan(0);
    } finally {
      await safeEnd(client);
    }
  });
});
