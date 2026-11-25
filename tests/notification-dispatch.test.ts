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
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { TelegramTransport } from "@/lib/telegram";

const baseUrl = testDatabaseUrl();
const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
const CHAT_ID = "-1001234567890";
const BETTER_AUTH_URL = "https://hub.example.com";
// The database defaults `nextAttemptAt` to the real clock; keep the injected
// clock comfortably ahead so a freshly opened row is due in the test timeline.
const START = Date.now() + 60 * 60_000;

type ProviderCall = {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeProvider(
  respond: (call: ProviderCall) => Response | Promise<Response> = () =>
    json({ ok: true, result: { message_id: 501, chat: { id: -1001234567890 } } }),
): { calls: ProviderCall[]; transport: TelegramTransport } {
  const calls: ProviderCall[] = [];
  const transport: TelegramTransport = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const call = { url, init, body };
    calls.push(call);
    return respond(call);
  };
  return { calls, transport };
}

describe.skipIf(!baseUrl)("notification dispatch", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
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

  it("delivers one opening with the configured chat and episode button", async () => {
    const incidentId = await openCritical();
    const provider = fakeProvider();
    const client = await lockOwner();
    try {
      const first = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 1_000,
        fetchImpl: provider.transport,
      });
      expect(first.action).toBe("sent");
      expect(provider.calls).toHaveLength(1);
      const [call] = provider.calls;
      expect(call.url).toBe(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      );
      expect(call.body.chat_id).toBe(CHAT_ID);
      expect(call.body).not.toHaveProperty("parse_mode");
      expect(String(call.body.text)).toContain("NAS sin respuesta");
      expect(call.body.reply_markup).toEqual({
        inline_keyboard: [
          [
            {
              text: "Abrir en el hub",
              url: `https://hub.example.com/?view=alerts&host=nas-home&incident=${incidentId}`,
            },
          ],
        ],
      });

      const [row] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(row).toMatchObject({
        status: "sent",
        chatId: CHAT_ID,
        messageId: "501",
        attempts: 1,
        claimToken: null,
        leaseUntil: null,
      });
      expect(row.result).toMatchObject({ state: "sent", reason: null });
      expect(row.attemptStartedAt).not.toBeNull();

      const second = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 2_000,
        fetchImpl: provider.transport,
      });
      expect(second.action).toBe("idle");
      expect(provider.calls).toHaveLength(1);
    } finally {
      await safeEnd(client);
    }
  });

  it("does not let a competing session send the same opening", async () => {
    const incidentId = await openCritical();
    const provider = fakeProvider();
    const owner = await lockOwner();
    const competitor = await connect();
    try {
      await expect(
        dispatch.runDispatchOnce({
          client: competitor,
          config,
          now: () => START + 1_000,
          fetchImpl: provider.transport,
        }),
      ).rejects.toBeInstanceOf(dispatch.CollectionLockLost);
      expect(provider.calls).toHaveLength(0);

      const result = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("sent");
      expect(provider.calls).toHaveLength(1);

      await dispatch.releaseCollectionLock(owner);
      expect(await dispatch.acquireCollectionLock(competitor)).toBe(true);
      const loser = await dispatch.runDispatchOnce({
        client: competitor,
        config,
        now: () => START + 2_000,
        fetchImpl: provider.transport,
      });
      expect(loser.action).toBe("idle");
      expect(provider.calls).toHaveLength(1);
      const [row] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(row.status).toBe("sent");
    } finally {
      await dispatch.releaseCollectionLock(owner).catch(() => {});
      await safeEnd(owner);
      await safeEnd(competitor);
    }
  });

  it("recovers a lease that expired before the attempt started", async () => {
    const incidentId = await openCritical();
    const provider = fakeProvider();
    const owner = await lockOwner();
    const claimed = await dispatch.claimOutboxJob(
      owner,
      "stale-token",
      START,
      1_000,
    );
    expect(claimed).not.toBeNull();
    expect(claimed!.attemptStartedAt).toBeNull();
    await safeEnd(owner);

    const next = await lockOwner();
    try {
      const result = await dispatch.runDispatchOnce({
        client: next,
        config,
        now: () => START + 2_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("sent");
      expect(provider.calls).toHaveLength(1);
      const [row] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(row).toMatchObject({ status: "sent", attempts: 1 });
    } finally {
      await safeEnd(next);
    }
  });

  it("keeps an attempt-started lease uncertain without a resend or fallback", async () => {
    const incidentId = await openCritical();
    const provider = fakeProvider();
    const owner = await lockOwner();
    const claimed = await dispatch.claimOutboxJob(
      owner,
      "started-token",
      START,
      1_000,
    );
    expect(claimed).not.toBeNull();
    const attempts = await dispatch.beginOutboxAttempt(
      owner,
      claimed!.id,
      "started-token",
      START,
    );
    expect(attempts).toBe(1);
    await safeEnd(owner);

    const next = await lockOwner();
    try {
      const first = await dispatch.runDispatchOnce({
        client: next,
        config,
        now: () => START + 2_000,
        fetchImpl: provider.transport,
      });
      expect(first.action).not.toBe("sent");
      expect(provider.calls).toHaveLength(0);
      const rows = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "uncertain",
        attempts: 1,
        claimToken: null,
        leaseUntil: null,
      });
      expect(rows[0].result).toMatchObject({
        state: "uncertain",
        reason: "lease_expired_after_attempt",
      });

      const second = await dispatch.runDispatchOnce({
        client: next,
        config,
        now: () => START + 60_000,
        fetchImpl: provider.transport,
      });
      expect(second.action).toBe("idle");
      expect(provider.calls).toHaveLength(0);
      expect(
        await db
          .select()
          .from(tables.notificationOutbox)
          .where(eq(tables.notificationOutbox.incidentId, incidentId)),
      ).toHaveLength(1);
    } finally {
      await safeEnd(next);
    }
  });

  it("suppresses the notice when Telegram is disabled and never calls the provider", async () => {
    const incidentId = await openCritical();
    const provider = fakeProvider();
    const client = await lockOwner();
    try {
      const result = await dispatch.runDispatchOnce({
        client,
        config: { ...config, telegram: null },
        now: () => START + 1_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("suppressed");
      expect(provider.calls).toHaveLength(0);
      const [row] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(row).toMatchObject({ status: "suppressed" });
      expect(row.result).toMatchObject({
        state: "suppressed",
        reason: "telegram_disabled",
      });
    } finally {
      await safeEnd(client);
    }
  });
});
