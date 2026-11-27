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
import {
  HANDOFF_TTL_MS,
  handoffToken,
  hostActionsFor,
  intentActionIds,
  intentActionOfToken,
  tokenActionOf,
} from "@/lib/telegram-intents";
import type { RuntimeConfig } from "@/lib/runtime-config";

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
/** A private chat: the operator's own user id is the chat id (D-11). */
const CHAT_ID = "123456789";
const SECRET = "b".repeat(32);
// The database defaults `nextAttemptAt` to the real clock; keep the injected
// clock comfortably ahead so a freshly opened row is due in the test timeline.
const START = Date.now() + 60 * 60_000;

describe("hostActionsFor", () => {
  it("offers start and restart only to a container", () => {
    expect(hostActionsFor("container:plex")).toEqual(["start", "restart"]);
  });

  it("offers each maintenance condition its own action", () => {
    expect(hostActionsFor("backup-failed")).toEqual(["backup-now"]);
    expect(hostActionsFor("deploy-failed")).toEqual(["deploy-now"]);
    expect(hostActionsFor("reboot-pending")).toEqual(["reboot"]);
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
      expect(hostActionsFor(key)).toEqual([]);
  });

  it("never offers update, stop or remove as an intent action", () => {
    expect([...intentActionIds].sort()).toEqual(
      ["backup-now", "deploy-now", "reboot", "restart", "start"].sort(),
    );
    for (const forbidden of ["update", "update-container", "stop", "remove"])
      expect(intentActionIds).not.toContain(forbidden);
  });

  it("maps every keyboard button to one intent action and back", () => {
    for (const action of intentActionIds)
      expect(intentActionOfToken(tokenActionOf(action))).toBe(action);
    expect(intentActionOfToken("ack")).toBeNull();
    expect(intentActionOfToken("menu_open")).toBeNull();
  });
});

describe.skipIf(!baseUrl)("telegram intents", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let lane: typeof import("@/lib/telegram-updates");
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
    keyboard = await import("@/lib/telegram-keyboard");
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
    action: "act_backup_now" | "act_start" | "act_restart",
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
    expect(intent.expiresAt.getTime()).toBe(at + HANDOFF_TTL_MS);

    // Only the digest of the derived handoff token is stored; the token is not
    // in any column of the row.
    const handoff = handoffToken(SECRET, intent.id);
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
      now: () => START + 60_000 + HANDOFF_TTL_MS + 1_000,
      fetchImpl: fake.transport,
    });
    expect(edited.action).toBe("edited");
    const editCall = fake.calls.find(
      (call) => call.method === "editMessageText",
    );
    expect(handoffButtonOf(editCall!)).toBeUndefined();
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
