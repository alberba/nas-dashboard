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
  vi,
} from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { createFakeBotApi } from "./telegram-fake";
import { seedVerifiedSession } from "./verified-session";
import type { RuntimeConfig } from "@/lib/runtime-config";

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
/** A private chat: the operator's own user id is the chat id (D-11). */
const CHAT_ID = "123456789";
const SECRET = "b".repeat(32);
// The database defaults `nextAttemptAt` to the real clock; keep the injected
// clock comfortably ahead so a freshly opened row is due in the test timeline.
const START = Date.now() + 60 * 60_000;

describe.skipIf(!baseUrl)("telegram intents", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let lane: typeof import("@/lib/telegram-updates");
  let keyboard: typeof import("@/lib/telegram-keyboard");
  let intentsModule: typeof import("@/lib/telegram-intents");
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
    keyboard = await import("@/lib/telegram-keyboard");
    intentsModule = await import("@/lib/telegram-intents");
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of openClients) await client.end().catch(() => {});
    openClients.clear();
  });

  beforeEach(async () => {
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
    await db.delete(tables.user);
  });

  describe("hostActionsFor", () => {
    it("offers start and restart only to a container", () => {
      expect(intentsModule.hostActionsFor("container:plex")).toEqual(["start", "restart"]);
    });

    it("offers each maintenance condition its own action", () => {
      expect(intentsModule.hostActionsFor("backup-failed")).toEqual(["backup-now"]);
      expect(intentsModule.hostActionsFor("deploy-failed")).toEqual(["deploy-now"]);
      expect(intentsModule.hostActionsFor("reboot-pending")).toEqual(["reboot"]);
    });

    it("offers nothing to the outage or to any other condition", () => {
      for (const key of [
        "connection",
        "disk-health",
        "services-down",
        "stack-unit-failed",
        "container:",
        "",
      ])
        expect(intentsModule.hostActionsFor(key)).toEqual([]);
    });

    it("never offers update, stop or remove as an intent action", () => {
      expect([...intentsModule.intentActionIds].sort()).toEqual(
        ["backup-now", "deploy-now", "reboot", "restart", "start"].sort(),
      );
      for (const forbidden of ["update", "update-container", "stop", "remove"])
        expect(intentsModule.intentActionIds).not.toContain(forbidden);
    });

    it("maps every keyboard button to one intent action and back", () => {
      for (const action of intentsModule.intentActionIds)
        expect(intentsModule.intentActionOfToken(intentsModule.tokenActionOf(action))).toBe(action);
      expect(intentsModule.intentActionOfToken("ack")).toBeNull();
      expect(intentsModule.intentActionOfToken("menu_open")).toBeNull();
    });
  });

  async function lockOwner(): Promise<Client> {
    const client = new Client({ connectionString: context.url });
    await client.connect();
    openClients.add(client);
    expect(await dispatch.acquireCollectionLock(client)).toBe(true);
    return client;
  }

  /** Opens a notice for `key`, delivers it and returns its episode id. */
  async function sendNotice(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    key: string,
  ): Promise<number> {
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
    expect(opened.action).toBe("opened");
    const sent = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 1_000,
      fetchImpl: fake.transport,
    });
    expect(sent.action).toBe("sent");
    return opened.incidentId!;
  }

  async function issueToken(
    incidentId: number,
    action:
      | "act_backup_now"
      | "act_start"
      | "act_restart"
      | "menu_open"
      | "intent_cancel",
  ): Promise<string> {
    const issued = await keyboard.issueActionTokens(db, {
      incidentId,
      chatId: CHAT_ID,
      actions: [action],
      now: START + 2_000,
    });
    return issued[action]!;
  }

  /** One lane turn that delivers a press of `token` on the notice message. */
  async function press(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    token: string,
    updateId: number,
    at = START + 60_000,
  ) {
    fake.enqueueUpdate(
      fake.callbackUpdate({ updateId, data: token, messageId: 501 }),
    );
    const updates = lane.createUpdatesLane({
      client,
      config,
      fetchImpl: fake.transport,
      now: () => at,
    });
    const outcome = await updates.run({ waitSeconds: 0 });
    expect(outcome).toMatchObject({ ok: true });
    return outcome;
  }

  async function intents() {
    return db.select().from(tables.telegramActionIntents);
  }

  it("turns a backup press into one pending intent without running anything", async () => {
    await seedVerifiedSession(db, tables);
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const at = START + 60_000;
    const incidentId = await sendNotice(fake, client, "backup-failed");
    const token = await issueToken(incidentId, "act_backup_now");

    await press(fake, client, token, 301, at);

    const rows = await intents();
    expect(rows).toHaveLength(1);
    const [intent] = rows;
    expect(intent).toMatchObject({
      incidentId,
      hostId: "nas-home",
      action: "backup-now",
      target: "nas-home",
      userId: "test-user",
      status: "pending",
      usedAt: null,
      finishedAt: null,
    });
    expect(intent.expiresAt.getTime()).toBe(at + intentsModule.HANDOFF_TTL_MS);

    // Only the digest of the derived handoff token is stored; the token is not
    // in any column of the row.
    const handoff = intentsModule.handoffToken(SECRET, intent.id);
    expect(handoff).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(intent.handoffHash).toBe(
      createHash("sha256").update(handoff).digest("hex"),
    );
    expect(JSON.stringify(intent)).not.toContain(handoff);

    // The button was consumed and the offset moved in the same transaction.
    const [consumed] = await db
      .select()
      .from(tables.telegramActionTokens)
      .where(
        eq(
          tables.telegramActionTokens.tokenHash,
          keyboard.hashActionToken(token),
        ),
      );
    expect(consumed.usedAt).not.toBeNull();
    const [pollState] = await db.select().from(tables.telegramPollState);
    expect(pollState.lastUpdateId).toBe(301);
    const answers = fake.calls.filter(
      (call) => call.method === "answerCallbackQuery",
    );
    expect(answers).toHaveLength(1);

    // The chat never executes: no operation row and no request beyond Telegram.
    expect(await db.select().from(tables.operations)).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("registers a container action against the container name", async () => {
    await seedVerifiedSession(db, tables);
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "container:plex");
    const token = await issueToken(incidentId, "act_restart");

    await press(fake, client, token, 302);

    const [intent] = await intents();
    expect(intent).toMatchObject({ action: "restart", target: "plex" });
  });

  it("creates no intent on a key that does not offer the action", async () => {
    await seedVerifiedSession(db, tables);
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "connection");
    const token = await issueToken(incidentId, "act_backup_now");

    await press(fake, client, token, 303);

    expect(await intents()).toHaveLength(0);
    const [consumed] = await db
      .select()
      .from(tables.telegramActionTokens)
      .where(
        eq(
          tables.telegramActionTokens.tokenHash,
          keyboard.hashActionToken(token),
        ),
      );
    expect(consumed.usedAt).not.toBeNull();
  });

  it("creates no intent from an old button once the episode is resolved", async () => {
    await seedVerifiedSession(db, tables);
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "backup-failed");
    const token = await issueToken(incidentId, "act_backup_now");
    const closed = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "backup-failed",
      failing: false,
      now: START + 30_000,
    });
    expect(closed.action).toBe("resolved");

    await press(fake, client, token, 304);

    expect(await intents()).toHaveLength(0);
  });

  async function keyboardEdits(incidentId: number) {
    const rows = await db
      .select()
      .from(tables.notificationOutbox)
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-edit"),
        ),
      );
    return rows.filter((row) => row.key.includes(":kb:"));
  }

  /** The url button of the last edit that carries a handoff fragment. */
  function handoffButtonOf(call: { body: Record<string, unknown> }) {
    const markup = call.body.reply_markup as {
      inline_keyboard: Array<
        Array<{ text?: string; url?: string; callback_data?: string }>
      >;
    };
    return markup.inline_keyboard
      .flat()
      .find((button) => button.url?.includes("#intent="));
  }

  it("queues a keyboard-only edit in the transaction that creates the intent", async () => {
    await seedVerifiedSession(db, tables);
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "backup-failed");
    const token = await issueToken(incidentId, "act_backup_now");

    await press(fake, client, token, 311);

    const [intent] = await intents();
    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    const edits = await keyboardEdits(incidentId);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      key: `incident:${incidentId}:kb:i${intent.id}:open`,
      kind: "incident-edit",
      channel: "telegram",
      status: "pending",
      chatId: CHAT_ID,
      messageId: "501",
      revision: incident.seq,
    });
  });

  it("queues a keyboard edit once per discriminator and never without a confirmed message", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "backup-failed");

    const first = await db.transaction((tx) =>
      store.queueKeyboardEdit(tx, incidentId, "probe"),
    );
    const second = await db.transaction((tx) =>
      store.queueKeyboardEdit(tx, incidentId, "probe"),
    );
    expect(first).toBe("queued");
    expect(second).toBe("queued");
    expect(await keyboardEdits(incidentId)).toHaveLength(1);

    // A notice whose opening was never confirmed has nothing to edit.
    const unsent = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "deploy-failed",
      failing: true,
      severity: "critical",
      title: "Aviso sin enviar",
      detail: "Detalle",
      now: START + 5_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    const none = await db.transaction((tx) =>
      store.queueKeyboardEdit(tx, unsent.incidentId!, "probe"),
    );
    expect(none).toBe("none");
    expect(await keyboardEdits(unsent.incidentId!)).toHaveLength(0);
  });

  it("delays a keyboard edit until notBefore when asked", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "backup-failed");
    const notBefore = new Date(START + 600_000);

    await db.transaction((tx) =>
      store.queueKeyboardEdit(tx, incidentId, "later", { notBefore }),
    );

    const [edit] = await keyboardEdits(incidentId);
    expect(edit.nextAttemptAt.getTime()).toBe(notBefore.getTime());
  });

  it("edits the notice silently with a url button that carries the handoff token", async () => {
    await seedVerifiedSession(db, tables);
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "backup-failed");
    const token = await issueToken(incidentId, "act_backup_now");
    await press(fake, client, token, 312);
    const [intent] = await intents();

    const edited = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 120_000,
      fetchImpl: fake.transport,
    });
    expect(edited.action).toBe("edited");

    // One opening and one edit of the same message: nothing new is sent.
    expect(
      fake.calls.filter((call) => call.method === "sendMessage"),
    ).toHaveLength(1);
    const editCalls = fake.calls.filter(
      (call) => call.method === "editMessageText",
    );
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0].body.message_id).toBe("501");

    const button = handoffButtonOf(editCalls[0]);
    expect(button).toBeDefined();
    expect(button).not.toHaveProperty("callback_data");
    const url = new URL(button!.url!);
    expect(url.origin + url.pathname).toBe("https://hub.example.com/");
    expect(url.searchParams.get("view")).toBe("alerts");
    expect(url.searchParams.get("host")).toBe("nas-home");
    expect(url.searchParams.get("incident")).toBe(String(incidentId));
    const handoff = url.hash.replace(/^#intent=/, "");
    expect(handoff).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(handoff).digest("hex")).toBe(
      intent.handoffHash,
    );

    // The token is recomputed, not stored: a second edit of the same state
    // renders the same link.
    await db.transaction((tx) =>
      store.queueKeyboardEdit(tx, incidentId, "again"),
    );
    const again = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 180_000,
      fetchImpl: fake.transport,
    });
    expect(again.action).toBe("edited");
    const secondCall = fake.calls.filter(
      (call) => call.method === "editMessageText",
    )[1];
    expect(handoffButtonOf(secondCall)?.url).toBe(button!.url);
  });

  it("renders no handoff button once the intent has expired", async () => {
    await seedVerifiedSession(db, tables);
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "backup-failed");
    await press(
      fake,
      client,
      await issueToken(incidentId, "act_backup_now"),
      313,
    );

    const edited = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 60_000 + intentsModule.HANDOFF_TTL_MS + 1_000,
      fetchImpl: fake.transport,
    });
    expect(edited.action).toBe("edited");
    const editCall = fake.calls.find(
      (call) => call.method === "editMessageText",
    );
    expect(handoffButtonOf(editCall!)).toBeUndefined();
  });

  /** Creates an intent straight through the module, as the lane does. */
  async function create(
    incidentId: number,
    now: number,
    key = "backup-failed",
    action: "backup-now" | "restart" = "backup-now",
  ) {
    return db.transaction((tx) =>
      intentsModule.createIntent(tx, {
        incident: { id: incidentId, hostId: "nas-home", key },
        action,
        secret: SECRET,
        now,
      }),
    );
  }

  async function createdIntent(incidentId: number, now = START + 60_000) {
    const created = await create(incidentId, now);
    expect(created.state).toBe("created");
    if (created.state !== "created") throw new Error("intent not created");
    return created;
  }

  async function seedNotice(): Promise<number> {
    await seedVerifiedSession(db, tables);
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    return sendNotice(fake, client, "backup-failed");
  }

  it("keeps one live intent per notice and allows another once it lapsed", async () => {
    const incidentId = await seedNotice();
    const at = START + 60_000;
    const first = await createdIntent(incidentId, at);

    const second = await create(incidentId, at + 1_000);
    expect(second.state).toBe("live");
    expect(await intents()).toHaveLength(1);

    const later = at + intentsModule.HANDOFF_TTL_MS + 1_000;
    const third = await create(incidentId, later);
    expect(third.state).toBe("created");
    const rows = await intents();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)?.status).toBe("expired");
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("lets a notice take a new intent after the previous one was claimed", async () => {
    const incidentId = await seedNotice();
    const first = await createdIntent(incidentId);
    expect(
      await intentsModule.claimIntent(db, first.id, START + 61_000),
    ).not.toBeNull();

    expect((await create(incidentId, START + 62_000)).state).toBe("created");
  });

  it("claims an intent once even when two claims race", async () => {
    const incidentId = await seedNotice();
    const intent = await createdIntent(incidentId);
    const at = START + 61_000;

    const results = await Promise.all([
      intentsModule.claimIntent(db, intent.id, at),
      intentsModule.claimIntent(db, intent.id, at),
    ]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    const claimed = results.find((row) => row !== null)!;
    expect(claimed.status).toBe("executing");
    expect(claimed.usedAt?.getTime()).toBe(at);
    const [row] = await intents();
    expect(row.status).toBe("executing");
  });

  it("does not claim an expired, cancelled or already claimed intent", async () => {
    const incidentId = await seedNotice();
    const intent = await createdIntent(incidentId);

    // Past its time.
    expect(
      await intentsModule.claimIntent(
        db,
        intent.id,
        intent.expiresAt.getTime() + 1,
      ),
    ).toBeNull();

    // Cancelled.
    await db
      .update(tables.telegramActionIntents)
      .set({ status: "cancelled" })
      .where(eq(tables.telegramActionIntents.id, intent.id));
    expect(
      await intentsModule.claimIntent(db, intent.id, START + 61_000),
    ).toBeNull();

    // Already claimed.
    await db
      .update(tables.telegramActionIntents)
      .set({ status: "pending" })
      .where(eq(tables.telegramActionIntents.id, intent.id));
    expect(
      await intentsModule.claimIntent(db, intent.id, START + 61_000),
    ).not.toBeNull();
    expect(
      await intentsModule.claimIntent(db, intent.id, START + 62_000),
    ).toBeNull();
  });

  it("releases only a claimed intent back to pending", async () => {
    const incidentId = await seedNotice();
    const intent = await createdIntent(incidentId);

    expect(await intentsModule.releaseIntent(db, intent.id)).toBeNull();
    await intentsModule.claimIntent(db, intent.id, START + 61_000);

    const released = await intentsModule.releaseIntent(db, intent.id);
    expect(released).toMatchObject({ status: "pending", usedAt: null });
    expect(
      await intentsModule.claimIntent(db, intent.id, START + 62_000),
    ).not.toBeNull();
  });

  it("finishes an intent only from the executing state", async () => {
    const incidentId = await seedNotice();
    const intent = await createdIntent(incidentId);
    const at = START + 70_000;

    expect(
      await intentsModule.finishIntent(db, intent.id, "executed", at),
    ).toBeNull();
    await intentsModule.claimIntent(db, intent.id, START + 61_000);
    const done = await intentsModule.finishIntent(
      db,
      intent.id,
      "uncertain",
      at,
    );
    expect(done).toMatchObject({ status: "uncertain" });
    expect(done?.finishedAt?.getTime()).toBe(at);
    expect(
      await intentsModule.finishIntent(db, intent.id, "failed", at + 1_000),
    ).toBeNull();
    expect((await intents())[0].status).toBe("uncertain");
  });

  it("finds an intent by its token and not by an altered one", async () => {
    const incidentId = await seedNotice();
    const intent = await createdIntent(incidentId);
    const token = intentsModule.handoffToken(SECRET, intent.id);

    const found = await intentsModule.findIntentByToken(db, token);
    expect(found?.id).toBe(intent.id);

    const flipped = `${token.slice(0, 10)}${token[10] === "A" ? "B" : "A"}${token.slice(11)}`;
    expect(await intentsModule.findIntentByToken(db, flipped)).toBeNull();
    expect(await intentsModule.findIntentByToken(db, "")).toBeNull();
  });

  type FakeCall = { method: string; body: Record<string, unknown> };

  /** `callback_data` values of the keyboard a sent or edited call carried. */
  function callbacksOf(call: FakeCall): string[] {
    const markup = call.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    return markup.inline_keyboard
      .flat()
      .flatMap((button) =>
        typeof button.callback_data === "string" ? [button.callback_data] : [],
      );
  }

  /** What each token of a keyboard does, resolved from its stored digest. */
  async function actionsOf(call: FakeCall): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const data of callbacksOf(call)) {
      const [row] = await db
        .select()
        .from(tables.telegramActionTokens)
        .where(
          eq(
            tables.telegramActionTokens.tokenHash,
            keyboard.hashActionToken(data),
          ),
        );
      found.set(row.action, data);
    }
    return found;
  }

  const sends = (fake: ReturnType<typeof createFakeBotApi>) =>
    fake.calls.filter((call) => call.method === "sendMessage");
  const edits = (fake: ReturnType<typeof createFakeBotApi>) =>
    fake.calls.filter((call) => call.method === "editMessageText");

  async function deliverEdit(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
    at: number,
  ) {
    const result = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => at,
      fetchImpl: fake.transport,
    });
    expect(result.action).toBe("edited");
    return edits(fake).at(-1)!;
  }

  async function viewOf(incidentId: number) {
    const [open] = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:open`));
    return open.keyboardView;
  }

  describe("actions menu", () => {
    it("offers the menu on a notice with actions and not on one without", async () => {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      await sendNotice(fake, client, "backup-failed");
      const withActions = await actionsOf(sends(fake)[0]);
      expect(withActions.has("menu_open")).toBe(true);
      expect(withActions.has("act_backup_now")).toBe(false);

      const plain = createFakeBotApi({ chatId: Number(CHAT_ID) });
      await sendNotice(plain, client, "connection");
      const without = await actionsOf(sends(plain)[0]);
      expect(without.has("menu_open")).toBe(false);
      expect(without.has("ack")).toBe(true);
    });

    it("opens and closes the menu with silent edits of the same message", async () => {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      const incidentId = await sendNotice(fake, client, "backup-failed");
      const opening = await actionsOf(sends(fake)[0]);

      await press(fake, client, opening.get("menu_open")!, 321);
      expect(await viewOf(incidentId)).toBe("actions");
      const queued = await keyboardEdits(incidentId);
      expect(queued).toHaveLength(1);
      expect(queued[0].key).toMatch(
        new RegExp(`^incident:${incidentId}:kb:m[0-9a-f]{16}$`),
      );
      expect(queued[0].key).toBe(
        `incident:${incidentId}:kb:m${keyboard
          .hashActionToken(opening.get("menu_open")!)
          .slice(0, 16)}`,
      );

      const opened = await actionsOf(await deliverEdit(fake, client, START + 120_000));
      expect(opened.has("act_backup_now")).toBe(true);
      expect(opened.has("menu_close")).toBe(true);
      expect(opened.has("menu_open")).toBe(false);

      await press(fake, client, opened.get("menu_close")!, 322, START + 130_000);
      expect(await viewOf(incidentId)).toBe("normal");
      const closed = await actionsOf(await deliverEdit(fake, client, START + 140_000));
      expect(closed.has("menu_open")).toBe(true);
      expect(closed.has("act_backup_now")).toBe(false);
      expect(closed.has("menu_close")).toBe(false);

      // Only edits of the one message: nothing new was sent.
      expect(sends(fake)).toHaveLength(1);
      expect(edits(fake)).toHaveLength(2);
      expect(await keyboardEdits(incidentId)).toHaveLength(2);
    });

    it("does not repeat the effect of a token that was already used", async () => {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      const incidentId = await sendNotice(fake, client, "backup-failed");
      const token = (await actionsOf(sends(fake)[0])).get("menu_open")!;

      await press(fake, client, token, 331);
      await press(fake, client, token, 332, START + 61_000);

      expect(await keyboardEdits(incidentId)).toHaveLength(1);
      expect(await viewOf(incidentId)).toBe("actions");
    });

    it("ignores a menu press once the episode is resolved", async () => {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      const incidentId = await sendNotice(fake, client, "backup-failed");
      const stale = (await actionsOf(sends(fake)[0])).get("menu_open")!;
      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "backup-failed",
        failing: false,
        now: START + 30_000,
      });
      const queuedBefore = await keyboardEdits(incidentId);

      await press(fake, client, stale, 341);

      expect(await viewOf(incidentId)).toBe("normal");
      expect(await keyboardEdits(incidentId)).toHaveLength(queuedBefore.length);
    });

    it("ignores a menu press on a notice that offers no action", async () => {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      const incidentId = await sendNotice(fake, client, "connection");
      const forged = await issueToken(incidentId, "menu_open");

      await press(fake, client, forged, 342);

      expect(await viewOf(incidentId)).toBe("normal");
      expect(await keyboardEdits(incidentId)).toHaveLength(0);
    });

    it("does not open the menu while an intent is live", async () => {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      await seedVerifiedSession(db, tables);
      const incidentId = await sendNotice(fake, client, "backup-failed");
      const token = (await actionsOf(sends(fake)[0])).get("menu_open")!;
      await createdIntent(incidentId);
      const before = (await keyboardEdits(incidentId)).length;

      await press(fake, client, token, 343, START + 70_000);

      expect(await keyboardEdits(incidentId)).toHaveLength(before);
      expect(await viewOf(incidentId)).toBe("normal");
    });

    it("never offers update, stop or remove in the menu", async () => {
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      const incidentId = await sendNotice(fake, client, "container:plex");
      await press(
        fake,
        client,
        (await actionsOf(sends(fake)[0])).get("menu_open")!,
        351,
      );
      const opened = await actionsOf(await deliverEdit(fake, client, START + 120_000));
      expect([...opened.keys()].filter((action) => action.startsWith("act_")).sort()).toEqual([
        "act_restart",
        "act_start",
      ]);
      expect(await viewOf(incidentId)).toBe("actions");
    });
  });

  describe("live intent", () => {
    /** A notice with a live backup intent and its delivered `:open` edit. */
    async function liveNotice() {
      await seedVerifiedSession(db, tables);
      const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
      const client = await lockOwner();
      const incidentId = await sendNotice(fake, client, "backup-failed");
      await press(fake, client, await issueToken(incidentId, "act_backup_now"), 361);
      const [intent] = await intents();
      const call = await deliverEdit(fake, client, START + 120_000);
      return { fake, client, incidentId, intent, call };
    }

    const expireRowOf = async (incidentId: number, intentId: string) =>
      (await keyboardEdits(incidentId)).find(
        (row) => row.key === `incident:${incidentId}:kb:i${intentId}:expire`,
      );

    it("shows the confirmation link and cancel while an intent is live", async () => {
      const { call } = await liveNotice();
      expect(handoffButtonOf(call)).toBeDefined();
      const offered = await actionsOf(call);
      expect(offered.has("intent_cancel")).toBe(true);
      expect(offered.has("menu_open")).toBe(false);
      expect(offered.has("act_backup_now")).toBe(false);
    });

    it("cancels the intent and restores the normal keyboard in silence", async () => {
      const { fake, client, incidentId, intent, call } = await liveNotice();
      const cancelToken = (await actionsOf(call)).get("intent_cancel")!;

      await press(fake, client, cancelToken, 362, START + 130_000);

      expect((await intents())[0]).toMatchObject({ id: intent.id, status: "cancelled" });
      expect(await viewOf(incidentId)).toBe("normal");
      const restored = await deliverEdit(fake, client, START + 140_000);
      expect(handoffButtonOf(restored)).toBeUndefined();
      const offered = await actionsOf(restored);
      expect(offered.has("menu_open")).toBe(true);
      expect(offered.has("intent_cancel")).toBe(false);
      expect(sends(fake)).toHaveLength(1);
    });

    it("answers a second cancel of the same state without editing", async () => {
      const { fake, client, incidentId, call } = await liveNotice();
      const first = (await actionsOf(call)).get("intent_cancel")!;
      const second = await issueToken(incidentId, "intent_cancel");
      await press(fake, client, first, 363, START + 130_000);
      const queued = (await keyboardEdits(incidentId)).length;

      await press(fake, client, second, 364, START + 131_000);

      expect(await keyboardEdits(incidentId)).toHaveLength(queued);
      expect((await intents())[0].status).toBe("cancelled");
    });

    it("keeps a single link when an action is pressed while an intent is live", async () => {
      const { fake, client, incidentId } = await liveNotice();
      const queued = (await keyboardEdits(incidentId)).length;

      await press(
        fake,
        client,
        await issueToken(incidentId, "act_backup_now"),
        365,
        START + 130_000,
      );

      expect(await intents()).toHaveLength(1);
      expect(await keyboardEdits(incidentId)).toHaveLength(queued);
    });

    it("queues the expiry row at expiresAt and delivers it only then", async () => {
      const { fake, client, incidentId, intent } = await liveNotice();
      const row = await expireRowOf(incidentId, intent.id);
      expect(row?.nextAttemptAt.getTime()).toBe(intent.expiresAt.getTime());

      const early = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => intent.expiresAt.getTime() - 1_000,
        fetchImpl: fake.transport,
      });
      expect(early.action).toBe("idle");

      const restored = await deliverEdit(
        fake,
        client,
        intent.expiresAt.getTime() + 1_000,
      );
      expect(handoffButtonOf(restored)).toBeUndefined();
      expect((await actionsOf(restored)).has("menu_open")).toBe(true);
      expect((await intents())[0].status).toBe("expired");
      expect(sends(fake)).toHaveLength(1);
    });

    it("only re-edits the current state when the intent was already cancelled", async () => {
      const { fake, client, incidentId, intent, call } = await liveNotice();
      await press(
        fake,
        client,
        (await actionsOf(call)).get("intent_cancel")!,
        366,
        START + 130_000,
      );
      await deliverEdit(fake, client, START + 140_000);

      const late = await deliverEdit(
        fake,
        client,
        intent.expiresAt.getTime() + 1_000,
      );

      expect(handoffButtonOf(late)).toBeUndefined();
      expect((await intents())[0].status).toBe("cancelled");
      expect(await viewOf(incidentId)).toBe("normal");
    });

    it("lets a new action create another intent after the previous one expired", async () => {
      const { fake, client, incidentId, intent } = await liveNotice();
      const after = intent.expiresAt.getTime() + 1_000;
      await deliverEdit(fake, client, after);

      await press(
        fake,
        client,
        await issueToken(incidentId, "act_backup_now"),
        367,
        after + 1_000,
      );

      const rows = await intents();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    });
  });

  it("fails closed without exactly one user", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const incidentId = await sendNotice(fake, client, "backup-failed");

    // No user at all.
    await press(
      fake,
      client,
      await issueToken(incidentId, "act_backup_now"),
      305,
    );
    expect(await intents()).toHaveLength(0);

    // Two users: the instance has no single operator to bind the intent to.
    await db.insert(tables.user).values([
      { id: "user-a", name: "A", email: "a@hub.invalid" },
      { id: "user-b", name: "B", email: "b@hub.invalid" },
    ]);
    await press(
      fake,
      client,
      await issueToken(incidentId, "act_backup_now"),
      306,
    );
    expect(await intents()).toHaveLength(0);
    expect(await db.select().from(tables.operations)).toHaveLength(0);
  });
});
