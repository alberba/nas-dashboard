import { createHash } from "node:crypto";
import { Client } from "pg";
import { eq, inArray } from "drizzle-orm";
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
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { TelegramTransport } from "@/lib/telegram";
import type { PushTransport } from "@/lib/push";

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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

function fakeProvider(
  respond: () => Response = () =>
    json({ ok: true, result: { message_id: OPEN_MESSAGE_ID, chat: { id: 1 } } }),
): { calls: Array<{ body: Record<string, unknown> }>; transport: TelegramTransport } {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const transport: TelegramTransport = async (_url, init) => {
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ body });
    return respond();
  };
  return { calls, transport };
}

describe.skipIf(!baseUrl)("snooze delivery", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let actions: typeof import("@/lib/incident-actions");
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
    actions = await import("@/lib/incident-actions");
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

  /** Writes the silence directly: these tests read the stored state. */
  async function setSnooze(until: number, key = "connection") {
    await db.insert(tables.incidentSnoozes).values({
      hostId: "nas-home",
      key,
      until: new Date(until),
      setAt: new Date(START),
      setVia: "telegram",
    });
  }

  async function openCritical(fake: ReturnType<typeof fakeProvider>, client: Client) {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "connection",
      failing: true,
      severity: "critical",
      title: "NAS sin respuesta",
      detail: "Sin métricas del agente",
      now: START,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    const sent = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 500,
      fetchImpl: fake.transport,
    });
    expect(sent.action).toBe("sent");
    return opened.incidentId!;
  }

  async function outboxOf(incidentId: number) {
    return db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.incidentId, incidentId));
  }

  it("suppresses the reopening of a silenced condition until the deadline", async () => {
    const fake = fakeProvider();
    const client = await lockOwner();
    try {
      const incidentId = await openCritical(fake, client);
      await setSnooze(START + 2 * HOUR_MS);

      const closed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: false,
        now: START + 60_000,
      });
      expect(closed.action).toBe("resolved");

      const reopened = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: true,
        severity: "critical",
        title: "NAS sin respuesta",
        detail: "Sin métricas del agente",
        now: START + 120_000,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });
      expect(reopened).toMatchObject({ action: "opened", delivery: "none" });

      const rows = await outboxOf(reopened.incidentId!);
      const opening = rows.find((row) => row.kind === "incident-open")!;
      expect(opening).toMatchObject({ status: "suppressed", channel: "telegram" });
      expect(opening.result?.reason).toBe("snoozed");
      // The event of the re-opening is recorded even though nothing interrupts.
      const events = await db
        .select()
        .from(tables.incidentEvents)
        .where(eq(tables.incidentEvents.incidentId, reopened.incidentId!));
      expect(events.filter((event) => event.kind === "opened")).toHaveLength(1);

      // The only Telegram request is the first, unsilenced notice.
      expect(fake.calls).toHaveLength(1);
      const idle = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 240_000,
        fetchImpl: fake.transport,
      });
      expect(idle.action).toBe("idle");
      expect(fake.calls).toHaveLength(1);

      // Past the deadline a new opening interrupts again.
      await db.delete(tables.incidentSnoozes);
      await setSnooze(START + 100_000);
      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: false,
        now: START + 300_000,
      });
      const again = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: true,
        severity: "critical",
        title: "NAS sin respuesta",
        detail: "Sin métricas del agente",
        now: START + 400_000,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });
      expect(again).toMatchObject({ action: "opened", delivery: "queued" });
      const againRows = await outboxOf(again.incidentId!);
      expect(againRows.find((row) => row.kind === "incident-open")).toMatchObject({
        status: "pending",
        channel: "telegram",
      });
      const sent = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 500_000,
        fetchImpl: fake.transport,
      });
      expect(sent.action).toBe("sent");
      expect(fake.calls).toHaveLength(2);
      expect(incidentId).toBeGreaterThan(0);
    } finally {
      await safeEnd(client);
    }
  });

  it("withholds the escalation of a silenced first notice", async () => {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "cpu",
      failing: true,
      severity: "warning",
      title: "CPU elevada",
      detail: "85 %",
      now: START,
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    expect(opened).toMatchObject({ action: "opened", delivery: "none" });
    await setSnooze(START + 2 * HOUR_MS, "cpu");

    const escalated = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "cpu",
      failing: true,
      severity: "critical",
      title: "CPU elevada",
      detail: "97 %",
      now: START + 60_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(escalated.action).toBe("escalated");
    const [row] = await outboxOf(opened.incidentId!);
    expect(row).toMatchObject({ status: "suppressed", channel: "telegram" });
    expect(row.result?.reason).toBe("snoozed");
    // The escalation itself stays in the timeline.
    const events = await db
      .select()
      .from(tables.incidentEvents)
      .where(eq(tables.incidentEvents.incidentId, opened.incidentId!));
    expect(events.filter((event) => event.kind === "severity")).toHaveLength(1);

    // Past the deadline the same escalation queues the notice again.
    const other = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "ram",
      failing: true,
      severity: "warning",
      title: "Memoria alta",
      detail: "80 %",
      now: START,
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    await setSnooze(START + 10_000, "ram");
    const later = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "ram",
      failing: true,
      severity: "critical",
      title: "Memoria alta",
      detail: "95 %",
      now: START + 60_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(later.action).toBe("escalated");
    const [laterRow] = await outboxOf(other.incidentId!);
    expect(laterRow.status).toBe("pending");
  });

  it("suppresses a queued opening and never resends it after the deadline", async () => {
    const fake = fakeProvider();
    const client = await lockOwner();
    try {
      const opened = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: true,
        severity: "critical",
        title: "NAS sin respuesta",
        detail: "Sin métricas del agente",
        now: START,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });
      expect(opened.delivery).toBe("queued");
      await setSnooze(START + 2 * HOUR_MS);

      const suppressed = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 1_000,
        fetchImpl: fake.transport,
      });
      expect(suppressed).toMatchObject({ action: "suppressed", reason: "snoozed" });
      expect(fake.calls).toHaveLength(0);
      const [row] = await outboxOf(opened.incidentId!);
      expect(row).toMatchObject({ status: "suppressed" });
      expect(row.result?.reason).toBe("snoozed");

      const after = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 3 * HOUR_MS,
        fetchImpl: fake.transport,
      });
      expect(after.action).toBe("idle");
      expect(fake.calls).toHaveLength(0);
    } finally {
      await safeEnd(client);
    }
  });

  it("suppresses the push fallback and a push opening without touching the transport", async () => {
    const rejected = fakeProvider(() =>
      json({ ok: false, description: "Bad Request" }, 400),
    );
    const pushCalls: string[] = [];
    const pushTransport: PushTransport = async (subscription) => {
      pushCalls.push(subscription.endpoint);
    };
    const vapidConfig: RuntimeConfig = {
      ...config,
      vapid: { publicKey: "test-public-key", privateKey: "test-private-key" },
    };
    const client = await lockOwner();
    try {
      // A permanent rejection of the Telegram opening queues exactly one push.
      const critical = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: true,
        severity: "critical",
        title: "NAS sin respuesta",
        detail: "Sin métricas del agente",
        now: START,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });
      const failed = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 500,
        fetchImpl: rejected.transport,
      });
      expect(failed.action).toBe("failed");
      const [pushJob] = (await outboxOf(critical.incidentId!)).filter(
        (row) => row.kind === "incident-push",
      );
      expect(pushJob).toMatchObject({ status: "pending", channel: "push" });

      await setSnooze(START + 2 * HOUR_MS);
      const suppressed = await dispatch.runDispatchOnce({
        client,
        config: vapidConfig,
        now: () => START + 1_000,
        pushTransport,
      });
      expect(suppressed).toMatchObject({ action: "suppressed", reason: "snoozed" });
      expect(pushCalls).toHaveLength(0);
      const rows = await outboxOf(critical.incidentId!);
      expect(rows.find((row) => row.kind === "incident-push")).toMatchObject({
        status: "suppressed",
        result: expect.objectContaining({ reason: "snoozed" }),
      });
      expect(
        rows.find((row) => row.kind === "incident-open")!.fallbackResult?.reason,
      ).toBe("snoozed");

      // A push opening queued before the silence is held back the same way.
      const pushed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "disk",
        failing: true,
        severity: "warning",
        title: "Disco lleno",
        detail: "92 %",
        now: START,
        delivery: { channel: "push", reason: "policy_immediate" },
      });
      await setSnooze(START + 2 * HOUR_MS, "disk");
      const held = await dispatch.runDispatchOnce({
        client,
        config: vapidConfig,
        now: () => START + 2_000,
        pushTransport,
      });
      expect(held).toMatchObject({ action: "suppressed", reason: "snoozed" });
      expect(pushCalls).toHaveLength(0);
      const [heldRow] = await outboxOf(pushed.incidentId!);
      expect(heldRow).toMatchObject({ status: "suppressed" });
      expect(heldRow.result?.reason).toBe("snoozed");
    } finally {
      await safeEnd(client);
    }
  });

  it("holds back a request when the silence arrives between the claim and the attempt mark", async () => {
    const fake = fakeProvider();
    const client = await lockOwner();
    try {
      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: true,
        severity: "critical",
        title: "NAS sin respuesta",
        detail: "Sin métricas del agente",
        now: START,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });

      // Another connection writes the silence right after the claim statement,
      // before the dispatcher marks the attempt.
      let injected = false;
      const proxied = new Proxy(client, {
        get(target, property) {
          if (property !== "query")
            return Reflect.get(target, property, target) as unknown;
          return async (...args: unknown[]) => {
            const result = await (
              Reflect.get(target, "query") as (
                ...inner: unknown[]
              ) => Promise<unknown>
            ).apply(target, args);
            const first = args[0];
            const text =
              typeof first === "string"
                ? first
                : String((first as { text?: string } | undefined)?.text ?? "");
            if (!injected && text.includes("status = 'claimed'")) {
              injected = true;
              await db.insert(tables.incidentSnoozes).values({
                hostId: "nas-home",
                key: "connection",
                until: new Date(START + 2 * HOUR_MS),
                setAt: new Date(START),
                setVia: "telegram",
              });
            }
            return result;
          };
        },
      });

      const outcome = await dispatch.runDispatchOnce({
        client: proxied,
        config,
        now: () => START + 1_000,
        fetchImpl: fake.transport,
      });
      expect(injected).toBe(true);
      expect(outcome).toMatchObject({ action: "suppressed", reason: "snoozed" });
      expect(fake.calls).toHaveLength(0);
    } finally {
      await safeEnd(client);
    }
  });

  it("still edits a sent notice while silent and offers to remove the silence", async () => {
    const fake = fakeProvider();
    const client = await lockOwner();
    try {
      const incidentId = await openCritical(fake, client);
      const at = START + 60_000;
      expect(
        await db.transaction((tx) =>
          actions.applyIncidentAction(tx, {
            action: "snooze",
            hours: 1,
            incidentId,
            via: "telegram",
            now: at,
          }),
        ),
      ).toBe("applied");

      const edited = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 120_000,
        fetchImpl: fake.transport,
      });
      expect(edited.action).toBe("edited");
      const editCall = fake.calls.at(-1)!;
      // The edited notice shows the Madrid hour of the deadline, not the copy.
      expect(String(editCall.body.text)).toContain(madridClockOf(at + HOUR_MS));

      const markup = editCall.body.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
      };
      const tokens = markup.inline_keyboard.flatMap((row) =>
        row.flatMap((button) =>
          typeof button.callback_data === "string" ? [button.callback_data] : [],
        ),
      );
      expect(tokens.length).toBeGreaterThan(0);
      const hashes = tokens.map((token) =>
        createHash("sha256").update(token).digest("hex"),
      );
      const stored = await db
        .select({ action: tables.telegramActionTokens.action })
        .from(tables.telegramActionTokens)
        .where(inArray(tables.telegramActionTokens.tokenHash, hashes));
      const offered = stored.map((row) => row.action);
      expect(offered).toContain("unsnooze");
      expect(offered).not.toContain("snooze_1h");
      expect(offered).not.toContain("snooze_24h");
    } finally {
      await safeEnd(client);
    }
  });
});
