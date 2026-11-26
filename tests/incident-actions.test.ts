/**
 * Behaviour of the operator actions shared by Telegram and the hub.
 *
 * The suite covers what 05-01 built end to end: acknowledging is idempotent
 * across channels (BOT-04), it is measurable against the sent opening (D-05),
 * it never touches the delivery policy (D-02), and a callback token reports
 * every failure as a value without burning itself (BOT-06).
 */

import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
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

describe.skipIf(!baseUrl)("incident actions", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
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
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
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

  async function openEpisode(options: {
    key?: string;
    severity?: string;
    title?: string;
    delivery?: { channel: "telegram" | "push" | "digest" | "silent"; reason?: string };
    now?: number;
  } = {}): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: options.key ?? "connection",
      failing: true,
      severity: options.severity ?? "critical",
      title: options.title ?? "NAS sin respuesta",
      detail: "Sin métricas del agente",
      now: options.now ?? START,
      delivery: options.delivery ?? {
        channel: "telegram",
        reason: "policy_immediate",
      },
    });
    expect(opened.action).toBe("opened");
    return opened.incidentId!;
  }

  /** Opens an episode and sends its real opening, returning the incident id. */
  async function sendOpening(
    fake: ReturnType<typeof createFakeBotApi>,
    client: Client,
  ): Promise<number> {
    const incidentId = await openEpisode();
    const sent = await dispatch.runDispatchOnce({
      client,
      config,
      now: () => START + 1_000,
      fetchImpl: fake.transport,
    });
    expect(sent.action).toBe("sent");
    return incidentId;
  }

  function acknowledge(input: {
    incidentId: number;
    via: "telegram" | "hub";
    by?: string;
    now: number;
  }) {
    return db.transaction((tx) =>
      actions.applyIncidentAction(tx, { action: "ack", ...input }),
    );
  }

  function consume(
    token: string,
    overrides: {
      chatId?: string;
      messageId?: string;
      now?: number;
    } = {},
  ) {
    return db.transaction((tx) =>
      actions.consumeActionToken(tx, {
        token,
        chatId: overrides.chatId ?? CHAT_ID,
        messageId: overrides.messageId ?? "501",
        now: overrides.now ?? START + 1_000,
      }),
    );
  }

  async function incidentRow(incidentId: number) {
    const [row] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    return row;
  }

  async function openRow(incidentId: number) {
    const [row] = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:open`));
    return row;
  }

  /** Row counts of one episode, to prove a no-op wrote nothing. */
  async function counts(incidentId: number) {
    const events = await db
      .select()
      .from(tables.incidentEvents)
      .where(eq(tables.incidentEvents.incidentId, incidentId));
    const outbox = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.incidentId, incidentId));
    return {
      events: events.length,
      acknowledged: events.filter((event) => event.kind === "acknowledged")
        .length,
      outbox: outbox.length,
      edits: outbox.filter((row) => row.kind === "incident-edit").length,
    };
  }

  async function tokenRow(token: string) {
    const [row] = await db
      .select()
      .from(tables.telegramActionTokens)
      .where(
        eq(tables.telegramActionTokens.tokenHash, keyboard.hashActionToken(token)),
      );
    return row ?? null;
  }

  async function issueAckToken(incidentId: number, now: number) {
    const issued = await db.transaction((tx) =>
      keyboard.issueActionTokens(tx, {
        incidentId,
        chatId: CHAT_ID,
        actions: ["ack"],
        now,
      }),
    );
    expect(typeof issued.ack).toBe("string");
    return issued.ack!;
  }

  it("keeps one acknowledgement when it is repeated by either channel", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);

      const applied = await acknowledge({
        incidentId,
        via: "telegram",
        now: START + 90_000,
      });
      expect(applied).toBe("applied");
      const first = await incidentRow(incidentId);
      expect(first.seq).toBe(2);
      const afterFirst = await counts(incidentId);
      expect(afterFirst).toMatchObject({ acknowledged: 1, edits: 1 });

      // Same channel, then the other one: the action already happened, so
      // neither writes an event, a revision or a second edit.
      const again = await acknowledge({
        incidentId,
        via: "telegram",
        now: START + 120_000,
      });
      expect(again).toBe("unchanged");
      const fromHub = await acknowledge({
        incidentId,
        via: "hub",
        by: "operador-nas",
        now: START + 150_000,
      });
      expect(fromHub).toBe("unchanged");

      const second = await incidentRow(incidentId);
      expect(second.seq).toBe(2);
      // The first acknowledgement keeps its channel and author: nothing was
      // overwritten by the repeats.
      expect(second.acknowledgedAt).toEqual(first.acknowledgedAt);
      expect(second.acknowledgedVia).toBe("telegram");
      expect(second.acknowledgedBy).toBeNull();
      expect(await counts(incidentId)).toEqual(afterFirst);
    } finally {
      await safeEnd(client);
    }
  });

  it("reports a resolved or unknown episode without writing anything", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      await acknowledge({ incidentId, via: "telegram", now: START + 90_000 });
      const closed = await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: false,
        now: START + 100_000,
      });
      expect(closed.action).toBe("resolved");

      const before = await counts(incidentId);
      const seqBefore = (await incidentRow(incidentId)).seq;

      const resolved = await acknowledge({
        incidentId,
        via: "hub",
        by: "operador-nas",
        now: START + 110_000,
      });
      expect(resolved).toBe("resolved");
      const missing = await acknowledge({
        incidentId: 999_999,
        via: "hub",
        by: "operador-nas",
        now: START + 110_000,
      });
      expect(missing).toBe("not_found");

      expect(await counts(incidentId)).toEqual(before);
      expect((await incidentRow(incidentId)).seq).toBe(seqBefore);
    } finally {
      await safeEnd(client);
    }
  });

  it("measures the time to acknowledge against the sent opening", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);
      const opening = await openRow(incidentId);
      expect(opening.result?.state).toBe("sent");
      const sentAt = new Date(opening.result!.at);
      expect(sentAt.toISOString()).toBe(new Date(START + 1_000).toISOString());

      const acknowledgedAt = START + 90_000;
      expect(
        await acknowledge({ incidentId, via: "telegram", now: acknowledgedAt }),
      ).toBe("applied");

      const incident = await incidentRow(incidentId);
      // A zone-carrying instant, not a wall-clock string: the span against the
      // stored send time is the injected clock difference.
      expect(incident.acknowledgedAt).toBeInstanceOf(Date);
      expect(incident.acknowledgedAt!.toISOString()).toBe(
        new Date(acknowledgedAt).toISOString(),
      );
      const type = await client.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'incidents'
            AND column_name = 'acknowledgedAt'`,
      );
      expect(type.rows[0].data_type).toBe("timestamp with time zone");

      // median(sentAt -> ackAt) over the measured episodes, with the columns
      // that already exist: no later migration is needed for D-05.
      const spans = [incident.acknowledgedAt!.getTime() - sentAt.getTime()];
      const sorted = [...spans].sort((left, right) => left - right);
      const median = sorted[Math.floor(sorted.length / 2)];
      expect(median).toBe(89_000);
    } finally {
      await safeEnd(client);
    }
  });

  it("lets a later critical escalation interrupt an episode acknowledged from the hub", async () => {
    // The first delivery is retained for the digest, so nobody was interrupted.
    const incidentId = await openEpisode({
      key: "disk",
      severity: "warning",
      title: "Disco lleno",
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    const retained = await openRow(incidentId);
    expect(retained).toMatchObject({
      status: "suppressed",
      channel: "digest",
    });

    expect(
      await acknowledge({
        incidentId,
        via: "hub",
        by: "operador-nas",
        now: START + 60_000,
      }),
    ).toBe("applied");

    const escalated = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "disk",
      failing: true,
      severity: "critical",
      title: "Disco lleno",
      now: START + 120_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(escalated.action).toBe("escalated");

    // Acknowledging is "I saw it": it never suppresses, delays or replaces the
    // later interruption (D-02).
    const interrupted = await openRow(incidentId);
    expect(interrupted).toMatchObject({
      status: "pending",
      channel: "telegram",
    });
    expect((await incidentRow(incidentId)).acknowledgedAt).not.toBeNull();
  });

  it("returns every token failure without burning the token", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    try {
      const incidentId = await sendOpening(fake, client);

      /** Runs one failing consumption and proves nothing was written. */
      async function failsWith(
        token: string,
        reason: string,
        overrides: { chatId?: string; messageId?: string; now?: number } = {},
      ) {
        const rowsBefore = (
          await db.select().from(tables.telegramActionTokens)
        ).length;
        const unusedBefore = await tokenRow(token);
        // `unknown` has no row at all; every other reason leaves it unused.
        if (unusedBefore) expect(unusedBefore.usedAt).toBeNull();
        const outcome = await consume(token, overrides);
        expect(outcome).toEqual({ ok: false, reason });
        const rowsAfter = (
          await db.select().from(tables.telegramActionTokens)
        ).length;
        expect(rowsAfter).toBe(rowsBefore);
        const unusedAfter = await tokenRow(token);
        expect(unusedAfter).toEqual(unusedBefore);
        if (unusedAfter) expect(unusedAfter.usedAt).toBeNull();
      }

      // A digest that matches no row.
      await failsWith(`v1:${"A".repeat(22)}`, "unknown");

      const token = await issueAckToken(incidentId, START);
      await failsWith(token, "expired", {
        now: START + keyboard.TELEGRAM_TOKEN_TTL_MS + 1,
      });
      await failsWith(token, "chat_mismatch", { chatId: "987654" });
      await failsWith(token, "message_mismatch", { messageId: "999" });

      // The only path that consumes: usedAt is set once, and the replay is
      // reported as `used` instead of repeating the action.
      const consumed = await consume(token);
      expect(consumed).toMatchObject({ ok: true, incidentId, action: "ack" });
      const burned = await tokenRow(token);
      expect(burned?.usedAt).toEqual(new Date(START + 1_000));
      const replay = await consume(token, { now: START + 2_000 });
      expect(replay).toEqual({ ok: false, reason: "used" });
      expect(await tokenRow(token)).toEqual(burned);

      // `incident_missing` is unreachable with real data: the token row is
      // deleted in cascade with its episode. It is probed inside a transaction
      // that drops the restriction and is rolled back, so the database keeps
      // the same shape afterwards (suppressing DDL is transactional).
      const orphan = await issueAckToken(incidentId, START);
      let orphanOutcome:
        | Awaited<ReturnType<typeof actions.consumeActionToken>>
        | undefined;
      await expect(
        db.transaction(async (tx) => {
          const found = await tx.execute<{ conname: string }>(sql`
            SELECT conname FROM pg_constraint
             WHERE conrelid = 'telegram_action_tokens'::regclass
               AND contype = 'f'
          `);
          expect(found.rows).toHaveLength(1);
          await tx.execute(
            sql`ALTER TABLE telegram_action_tokens DROP CONSTRAINT ${sql.identifier(
              found.rows[0].conname,
            )}`,
          );
          await tx
            .delete(tables.incidents)
            .where(eq(tables.incidents.id, incidentId));
          orphanOutcome = await actions.consumeActionToken(tx, {
            token: orphan,
            chatId: CHAT_ID,
            messageId: "501",
            now: START + 1_000,
          });
          throw new Error("rollback incident_missing probe");
        }),
      ).rejects.toThrow("rollback incident_missing probe");
      expect(orphanOutcome).toEqual({ ok: false, reason: "incident_missing" });

      // The rollback restored both the episode and its untouched token.
      expect(await incidentRow(incidentId)).toBeDefined();
      expect((await tokenRow(orphan))?.usedAt).toBeNull();
      const constraints = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_constraint
          WHERE conrelid = 'telegram_action_tokens'::regclass AND contype = 'f'`,
      );
      expect(constraints.rows[0].count).toBe(1);
    } finally {
      await safeEnd(client);
    }
  });
});
