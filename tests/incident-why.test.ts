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
import type { TelegramTransport } from "@/lib/telegram";
import type { Metrics } from "@/lib/types";

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

type Severity = "warning" | "critical";

describe.skipIf(!baseUrl)("incident why", () => {
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
    await db.delete(tables.samples);
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

  /** Opens one episode the way the collector does, with a Telegram delivery. */
  async function openIncident(
    options: {
      key?: string;
      severity?: Severity;
      title?: string;
      detail?: string;
      at?: number;
    } = {},
  ): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: options.key ?? "temperature",
      failing: true,
      severity: options.severity ?? "warning",
      title: options.title ?? "Temperatura elevada en nas-home",
      detail: options.detail ?? "Algún sensor supera 70 °C.",
      now: options.at ?? START,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    return opened.incidentId!;
  }

  /** Sends the real notice so a reply has a message to quote. */
  async function sendOpening(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    options: { key?: string; severity?: Severity } = {},
  ): Promise<number> {
    const incidentId = await openIncident(options);
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
    action: "ack" | "snooze_1h" | "snooze_24h" | "unsnooze" | "why",
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

  async function whyRows(incidentId: number) {
    return db
      .select()
      .from(tables.notificationOutbox)
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-why"),
        ),
      )
      .orderBy(tables.notificationOutbox.id);
  }

  async function openingRow(incidentId: number) {
    const [opening] = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:open`))
      .limit(1);
    return opening;
  }

  async function eventsOf(incidentId: number) {
    return db
      .select()
      .from(tables.incidentEvents)
      .where(eq(tables.incidentEvents.incidentId, incidentId));
  }

  async function incidentOf(incidentId: number) {
    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    return incident;
  }

  function answers(fake: ReturnType<typeof createFakeBotApi>) {
    return fake.calls.filter((call) => call.method === "answerCallbackQuery");
  }

  function sends(fake: ReturnType<typeof createFakeBotApi>) {
    return fake.calls.filter((call) => call.method === "sendMessage");
  }

  async function runAction(
    input: Parameters<typeof actions.applyIncidentAction>[1],
  ) {
    return db.transaction((tx) => actions.applyIncidentAction(tx, input));
  }

  it("queues one pending reply for the notice state without changing the incident", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const opening = await openingRow(incidentId);
      const before = await incidentOf(incidentId);
      const eventsBefore = await eventsOf(incidentId);
      const sendsBefore = sends(fake).length;
      const token = await issueToken(incidentId, "why");
      const at = START + 60_000;

      const outcome = await press(fake, client, { token, updateId: 101, at });
      expect(outcome).toMatchObject({ ok: true, handled: 1 });

      const rows = await whyRows(incidentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        key: `incident:${incidentId}:why:1`,
        kind: "incident-why",
        channel: "telegram",
        status: "pending",
        revision: 1,
        chatId: opening.chatId,
        messageId: opening.messageId,
      });
      expect(rows[0].chatId).toBe(String(CHAT_ID));
      expect(rows[0].messageId).toBe(String(OPEN_MESSAGE_ID));

      // The press explains, it never changes what the incident says.
      const after = await incidentOf(incidentId);
      expect(after.seq).toBe(before.seq);
      expect(await eventsOf(incidentId)).toHaveLength(eventsBefore.length);

      // One spinner close and no direct message: the reply is outbox work.
      expect(answers(fake)).toHaveLength(1);
      expect(sends(fake)).toHaveLength(sendsBefore);
    } finally {
      await safeEnd(client);
    }
  });

  it("answers a fresh token of the same state after acknowledging without a second row", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 111,
          at,
        }),
      ).toMatchObject({ handled: 1 });
      expect(await whyRows(incidentId)).toHaveLength(1);

      expect(
        await runAction({
          action: "ack",
          incidentId,
          via: "telegram",
          now: at + 1_000,
        }),
      ).toBe("applied");
      const answersBefore = answers(fake).length;

      // A fresh token of the same notice state: already answered, no message.
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 112,
          at: at + 5_000,
        }),
      ).toMatchObject({ handled: 1 });

      const rows = await whyRows(incidentId);
      expect(rows).toHaveLength(1);
      expect(rows[0].revision).toBe(1);
      expect(answers(fake)).toHaveLength(answersBefore + 1);
    } finally {
      await safeEnd(client);
    }
  });

  it("opens a new reply after a severity escalation and after a close", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 121,
          at,
        }),
      ).toMatchObject({ handled: 1 });

      const escalated = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "temperature",
        failing: true,
        severity: "critical",
        title: "Temperatura elevada en nas-home",
        detail: "Algún sensor supera 70 °C.",
        now: at + 10_000,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });
      expect(escalated.action).toBe("escalated");
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 122,
          at: at + 20_000,
        }),
      ).toMatchObject({ handled: 1 });

      const closed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "temperature",
        failing: false,
        now: at + 30_000,
      });
      expect(closed.action).toBe("resolved");
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 123,
          at: at + 40_000,
        }),
      ).toMatchObject({ handled: 1 });

      const rows = await whyRows(incidentId);
      expect(rows.map((row) => row.key)).toEqual([
        `incident:${incidentId}:why:1`,
        `incident:${incidentId}:why:2`,
        `incident:${incidentId}:why:3`,
      ]);
      expect(rows.map((row) => row.revision)).toEqual([1, 2, 3]);
    } finally {
      await safeEnd(client);
    }
  });

  it("keeps the notice state across acknowledging, silencing and removing the silence", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 131,
          at,
        }),
      ).toMatchObject({ handled: 1 });

      expect(
        await runAction({
          action: "ack",
          incidentId,
          via: "telegram",
          now: at + 1_000,
        }),
      ).toBe("applied");
      expect(
        await runAction({
          action: "snooze",
          hours: 1,
          incidentId,
          via: "telegram",
          now: at + 2_000,
        }),
      ).toBe("applied");
      expect(
        await runAction({
          action: "unsnooze",
          incidentId,
          via: "telegram",
          now: at + 3_000,
        }),
      ).toBe("applied");

      // None of the three actions changed what the notice explains.
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 132,
          at: at + 4_000,
        }),
      ).toMatchObject({ handled: 1 });
      const rows = await whyRows(incidentId);
      expect(rows).toHaveLength(1);
      expect(rows[0].revision).toBe(1);
    } finally {
      await safeEnd(client);
    }
  });

  it("ignores a repeated, expired or foreign why token", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const before = await incidentOf(incidentId);
      const token = await issueToken(incidentId, "why");
      const at = START + 60_000;

      expect(
        await press(fake, client, { token, updateId: 141, at }),
      ).toMatchObject({ handled: 1 });
      // The same callback delivered twice: already used, no second reply.
      expect(
        await press(fake, client, { token, updateId: 142, at: at + 5_000 }),
      ).toMatchObject({ handled: 1 });
      // A token pressed on another message is void.
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 143,
          messageId: OPEN_MESSAGE_ID + 7,
          at: at + 10_000,
        }),
      ).toMatchObject({ handled: 1 });
      // A token rendered before the TTL expired is refused.
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why", START - 30 * 86_400_000),
          updateId: 144,
          at: at + 20_000,
        }),
      ).toMatchObject({ handled: 1 });

      expect(await whyRows(incidentId)).toHaveLength(1);
      const after = await incidentOf(incidentId);
      expect(after.seq).toBe(before.seq);
      // Every refused press still closes its spinner with a finite answer.
      expect(answers(fake)).toHaveLength(4);
      for (const answer of answers(fake))
        expect(String(answer.body.text ?? "").length).toBeGreaterThan(0);
    } finally {
      await safeEnd(client);
    }
  });

  it("offers why in every keyboard state and only why once resolved", async () => {
    for (const resolved of [false, true])
      for (const acknowledged of [false, true])
        for (const snoozed of [false, true]) {
          const state = { resolved, acknowledged, snoozed };
          const offered = keyboard.keyboardActions(state);
          expect(offered).toContain("why");
          expect(new Set(offered).size).toBe(offered.length);
        }
    expect(
      keyboard.keyboardActions({
        resolved: true,
        acknowledged: true,
        snoozed: true,
      }),
    ).toEqual(["why"]);
    expect(
      keyboard.keyboardActions({
        resolved: false,
        acknowledged: true,
        snoozed: true,
      }),
    ).toContain("why");

    // The explanation keeps its own row and is the only action of a resolved
    // notice (D-10).
    const rows = keyboard.renderActionRows({ why: "v1:token" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0][0]).toEqual({
      text: "Por qué me llegó esto",
      callbackData: "v1:token",
    });
  });

  it("renders a single why row on the resolved notice edit", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const closed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "temperature",
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

      const edit = fake.calls.filter(
        (call) => call.method === "editMessageText",
      )[0];
      const markup = edit.body.reply_markup as {
        inline_keyboard: Array<
          Array<{ text?: string; url?: string; callback_data?: string }>
        >;
      };
      // The URL button keeps its row; the only state control left is why.
      expect(markup.inline_keyboard).toHaveLength(2);
      expect(markup.inline_keyboard[0]).toHaveLength(1);
      const actionButtons = markup.inline_keyboard.slice(1).flat();
      expect(actionButtons).toHaveLength(1);
      expect(typeof actionButtons[0].callback_data).toBe("string");
      expect(actionButtons[0].callback_data).toMatch(/^v1:[A-Za-z0-9_-]{22}$/);
      expect(markup.inline_keyboard[1][0]).toBe(actionButtons[0]);
      expect(incidentId).toBeGreaterThan(0);
    } finally {
      await safeEnd(client);
    }
  });

  it("moves the notice state only on an escalation or a closure", async () => {
    const why = await import("@/lib/incident-why");
    const incidentId = await openIncident();
    expect(await why.noticeSeq(db, incidentId)).toBe(1);

    expect(
      await runAction({
        action: "ack",
        incidentId,
        via: "telegram",
        now: START + 1_000,
      }),
    ).toBe("applied");
    expect(
      await runAction({
        action: "snooze",
        hours: 1,
        incidentId,
        via: "telegram",
        now: START + 2_000,
      }),
    ).toBe("applied");
    expect(
      await runAction({
        action: "unsnooze",
        incidentId,
        via: "telegram",
        now: START + 3_000,
      }),
    ).toBe("applied");
    expect(await why.noticeSeq(db, incidentId)).toBe(1);

    const escalated = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "temperature",
      failing: true,
      severity: "critical",
      title: "Temperatura elevada en nas-home",
      detail: "Algún sensor supera 70 °C.",
      now: START + 10_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(escalated.action).toBe("escalated");
    const severityEvent = (await eventsOf(incidentId)).find(
      (event) => event.kind === "severity",
    )!;
    expect(await why.noticeSeq(db, incidentId)).toBe(severityEvent.seq);

    const closed = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "temperature",
      failing: false,
      now: START + 20_000,
    });
    expect(closed.action).toBe("resolved");
    const closedEvent = (await eventsOf(incidentId)).find(
      (event) => event.kind === "closed",
    )!;
    expect(await why.noticeSeq(db, incidentId)).toBe(closedEvent.seq);
  });

  it("leaves one row when two presses of the same state run concurrently", async () => {
    const why = await import("@/lib/incident-why");
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);

      // Two separate transactions, as two concurrent presses would.
      const outcomes = await Promise.all([
        db.transaction((tx) => why.enqueueWhyReply(tx, { incidentId })),
        db.transaction((tx) => why.enqueueWhyReply(tx, { incidentId })),
      ]);
      expect(outcomes.filter((value) => value === "queued")).toHaveLength(1);
      expect(outcomes.filter((value) => value === "duplicate")).toHaveLength(1);
      expect(await whyRows(incidentId)).toHaveLength(1);
    } finally {
      await safeEnd(client);
    }
  });

  function sample(
    overrides: {
      cpu?: number | null;
      memory?: { total: number; used: number };
      disks?: { name: string; root: string; total: number; used: number; free: number }[];
      temperatures?: { name: string; value: number }[];
    } = {},
  ): Metrics {
    return {
      timestamp: Math.floor(START / 1_000),
      hostname: "nas-home",
      cpu: overrides.cpu ?? 12,
      memory: overrides.memory ?? { total: 16_000, used: 4_000 },
      network: { rx: 0, tx: 0 },
      io: { read: 0, write: 0 },
      uptime: 1,
      disks: overrides.disks ?? [],
      temperatures: overrides.temperatures ?? [],
      containers: [],
    };
  }

  async function seedSample(data: Metrics) {
    await db.insert(tables.samples).values({
      hostId: "nas-home",
      at: new Date(START),
      data,
    });
  }

  async function tick(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    at: number,
  ) {
    return dispatch.runDispatchOnce({
      client,
      config,
      now: () => at,
      fetchImpl: fake.transport,
    });
  }

  /** Runs ticks until `done`, because an edit may be due before the reply. */
  async function tickUntil(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    at: number,
    done: () => Promise<boolean>,
    attempts = 5,
  ): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
      if (await done()) return;
      await tick(fake, client, at + index);
    }
    expect(await done()).toBe(true);
  }

  function replyCalls(fake: ReturnType<typeof createFakeBotApi>) {
    return sends(fake).filter((call) => call.body.reply_parameters !== undefined);
  }

  it("sends the reply quoting the notice, without sound and with the rule and the reading", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      await seedSample(
        sample({
          temperatures: [
            { name: "cpu", value: 62 },
            { name: "nvme", value: 74 },
          ],
        }),
      );
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 201,
          at,
        }),
      ).toMatchObject({ handled: 1 });

      const sent = await tick(fake, client, at + 60_000);
      expect(sent).toMatchObject({ action: "sent", kind: "incident-why" });

      const replies = replyCalls(fake);
      expect(replies).toHaveLength(1);
      const [reply] = replies;
      expect(reply.body.reply_parameters).toEqual({
        message_id: OPEN_MESSAGE_ID,
        allow_sending_without_reply: true,
      });
      expect(reply.body.disable_notification).toBe(true);
      expect(reply.body).not.toHaveProperty("reply_markup");
      expect(reply.body.chat_id).toBe(CHAT_ID);

      const text = String(reply.body.text ?? "");
      // The highest sensor, the threshold of the rule, and the severity.
      expect(text).toContain("74");
      expect(text).toContain("Algún sensor supera 70 °C");
      expect(text).toContain("warning");

      const [row] = await whyRows(incidentId);
      expect(row.status).toBe("sent");
      expect(row.messageId).toBe(String(OPEN_MESSAGE_ID));
      expect(row.result?.state).toBe("sent");
      expect(JSON.stringify(row.result)).not.toContain(BOT_TOKEN);
      expect(reply.url).not.toContain(BOT_TOKEN);
    } finally {
      await safeEnd(client);
    }
  });

  it("explains each key with its own reading and none without a measurement", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      await seedSample(
        sample({
          cpu: 42,
          memory: { total: 16_000, used: 4_000 },
          disks: [
            { name: "data", root: "/data", total: 100, used: 80, free: 20 },
            { name: "system", root: "/", total: 100, used: 30, free: 70 },
          ],
          temperatures: [{ name: "cpu", value: 61 }],
        }),
      );

      const cases: Array<{ key: string; reading: string | null }> = [
        { key: "cpu", reading: "42" },
        { key: "memory", reading: "25" },
        { key: "disk", reading: "80" },
        { key: "container:plex", reading: null },
        { key: "backup-failed", reading: null },
      ];
      let updateId = 300;
      for (const { key, reading } of cases) {
        const incidentId = await sendOpening(fake, client, { key });
        const at = START + 60_000 + updateId * 1_000;
        expect(
          await press(fake, client, {
            token: await issueToken(incidentId, "why"),
            updateId,
            at,
          }),
        ).toMatchObject({ handled: 1 });
        await tickUntil(fake, client, at + 30_000, async () =>
          (await whyRows(incidentId)).some((row) => row.status === "sent"),
        );

        const reply = replyCalls(fake).at(-1)!;
        const text = String(reply.body.text ?? "");
        if (reading === null) {
          // A key without a measurement explains rule and channel, no value.
          expect(text).not.toContain("42");
          expect(text).not.toContain("25");
          expect(text).not.toContain("80");
        } else {
          expect(text).toContain(reading);
        }
        updateId += 1;
      }
    } finally {
      await safeEnd(client);
    }
  });

  it("explains a resolved notice without a reading", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      await seedSample(sample({ temperatures: [{ name: "cpu", value: 74 }] }));
      const closed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "temperature",
        failing: false,
        now: START + 30_000,
      });
      expect(closed.action).toBe("resolved");

      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 401,
          at,
        }),
      ).toMatchObject({ handled: 1 });
      await tickUntil(fake, client, at + 30_000, async () =>
        (await whyRows(incidentId)).some((row) => row.status === "sent"),
      );

      const reply = replyCalls(fake).at(-1)!;
      const text = String(reply.body.text ?? "");
      expect(text).not.toContain("74");
      expect(text).toContain("Algún sensor supera 70 °C");
    } finally {
      await safeEnd(client);
    }
  });

  it("reflects an escalation in the severity of the text, one message per state", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 501,
          at,
        }),
      ).toMatchObject({ handled: 1 });
      await tickUntil(fake, client, at + 30_000, async () =>
        (await whyRows(incidentId)).some((row) => row.status === "sent"),
      );
      const first = String(replyCalls(fake).at(-1)!.body.text ?? "");
      expect(first).toContain("warning");

      const escalated = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "temperature",
        failing: true,
        severity: "critical",
        title: "Temperatura elevada en nas-home",
        detail: "Algún sensor supera 70 °C.",
        now: at + 40_000,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });
      expect(escalated.action).toBe("escalated");

      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 502,
          at: at + 60_000,
        }),
      ).toMatchObject({ handled: 1 });
      const repliesBefore = replyCalls(fake).length;
      await tickUntil(fake, client, at + 90_000, async () =>
        (await whyRows(incidentId)).every((row) => row.status === "sent"),
      );
      const replies = replyCalls(fake);
      // One reply per state: the second press added exactly one message.
      expect(replies.length).toBe(repliesBefore + 1);
      expect(String(replies.at(-1)!.body.text ?? "")).toContain("critical");
    } finally {
      await safeEnd(client);
    }
  });

  it("never resends an uncertain confirmation", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    let attempts = 0;
    const failing: TelegramTransport = async () => {
      attempts += 1;
      throw new Error("network down");
    };
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 601,
          at,
        }),
      ).toMatchObject({ handled: 1 });

      expect(
        await dispatch.runDispatchOnce({
          client,
          config,
          now: () => at + 30_000,
          fetchImpl: failing,
        }),
      ).toMatchObject({ action: "uncertain" });
      expect(attempts).toBe(1);
      const [row] = await whyRows(incidentId);
      expect(row.status).toBe("uncertain");

      expect(
        await dispatch.runDispatchOnce({
          client,
          config,
          now: () => at + 60_000,
          fetchImpl: failing,
        }),
      ).toMatchObject({ action: "idle" });
      expect(attempts).toBe(1);
    } finally {
      await safeEnd(client);
    }
  });

  it("honours the shared pause after a 429 and sends the reply once", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 701,
          at,
        }),
      ).toMatchObject({ handled: 1 });

      const limiting = createFakeBotApi({
        chatId: Number(CHAT_ID),
        failOnce: { sendMessage: "rate_limited" },
      });
      const first = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => at + 30_000,
        fetchImpl: limiting.transport,
      });
      expect(first).toMatchObject({ action: "retry", reason: "rate_limited" });
      const [retried] = await whyRows(incidentId);
      expect(retried.status).toBe("pending");
      const cooldowns = await db.select().from(tables.telegramCooldown);
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0].until.getTime()).toBeGreaterThan(at + 30_000);

      const second = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => at + 40_000,
        fetchImpl: limiting.transport,
      });
      expect(second).toMatchObject({ action: "sent" });
      expect(
        limiting.calls.filter((call) => call.method === "sendMessage"),
      ).toHaveLength(2);
      const [sent] = await whyRows(incidentId);
      expect(sent.status).toBe("sent");
    } finally {
      await safeEnd(client);
    }
  });

  it("leaves a confirmed rejection failed and never falls back to push", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const rejecting: TelegramTransport = async () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 801,
          at,
        }),
      ).toMatchObject({ handled: 1 });

      expect(
        await dispatch.runDispatchOnce({
          client,
          config,
          now: () => at + 30_000,
          fetchImpl: rejecting,
        }),
      ).toMatchObject({ action: "failed" });
      const [row] = await whyRows(incidentId);
      expect(row.status).toBe("failed");

      const pushRows = await db
        .select()
        .from(tables.notificationOutbox)
        .where(
          and(
            eq(tables.notificationOutbox.incidentId, incidentId),
            eq(tables.notificationOutbox.kind, "incident-push"),
          ),
        );
      expect(pushRows).toHaveLength(0);
    } finally {
      await safeEnd(client);
    }
  });

  it("sends the reply while a silence is active", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const at = START + 60_000;
      expect(
        await runAction({
          action: "snooze",
          hours: 1,
          incidentId,
          via: "telegram",
          now: at,
        }),
      ).toBe("applied");
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 901,
          at: at + 1_000,
        }),
      ).toMatchObject({ handled: 1 });

      await tickUntil(fake, client, at + 30_000, async () =>
        (await whyRows(incidentId)).some((row) => row.status === "sent"),
      );
      expect(replyCalls(fake)).toHaveLength(1);
    } finally {
      await safeEnd(client);
    }
  });

  it("does not change the delivery the hub publishes", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const before = await store.projectIncidents([await incidentOf(incidentId)]);
      const at = START + 60_000;
      expect(
        await press(fake, client, {
          token: await issueToken(incidentId, "why"),
          updateId: 1_001,
          at,
        }),
      ).toMatchObject({ handled: 1 });
      await tickUntil(fake, client, at + 30_000, async () =>
        (await whyRows(incidentId)).some((row) => row.status === "sent"),
      );

      const after = await store.projectIncidents([await incidentOf(incidentId)]);
      expect(after[0].delivery).toEqual(before[0].delivery);
      expect(after[0].lastUpdate).toEqual(before[0].lastUpdate);
    } finally {
      await safeEnd(client);
    }
  });
});
