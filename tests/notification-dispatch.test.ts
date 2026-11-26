import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { TelegramTransport } from "@/lib/telegram";
import type { PushTransport } from "@/lib/push";

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
  let digest: typeof import("@/lib/digest-runs");
  let content: typeof import("@/lib/digest-content");
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
    digest = await import("@/lib/digest-runs");
    content = await import("@/lib/digest-content");
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

  async function openWarning(key: string, severity = "warning"): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity,
      title: "Disco a vigilar",
      detail: "sda: watch",
      now: START,
      delivery: { channel: "push", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    return opened.incidentId!;
  }

  function fakePush(
    respond: (endpoint: string) => void | Promise<void> = () => {},
  ): { calls: Array<{ endpoint: string; body: Record<string, unknown> }>; transport: PushTransport } {
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const transport: PushTransport = async (subscription, body) => {
      calls.push({
        endpoint: subscription.endpoint,
        body: JSON.parse(body) as Record<string, unknown>,
      });
      return respond(subscription.endpoint);
    };
    return { calls, transport };
  }

  async function createUser(id: string) {
    await db.insert(tables.user).values({
      id,
      name: id,
      email: `${id}@example.com`,
    });
  }

  async function createSubscription(userId: string, endpoint: string) {
    await db.insert(tables.subscriptions).values({
      endpoint,
      userId,
      keys: { p256dh: "p".repeat(40), auth: "a".repeat(20) },
    });
  }

  function vapidConfig(): RuntimeConfig {
    return {
      ...config,
      vapid: { publicKey: "test-public-key", privateKey: "test-private-key" },
    };
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
      const markup = call.body.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; url: string }>>;
      };
      expect(markup.inline_keyboard[0][0].url).toBe(
        `https://hub.example.com/?view=alerts&host=nas-home&incident=${incidentId}`,
      );

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

  it("queues the final edit when a closure commits during the send confirmation", async () => {
    const incidentId = await openCritical();
    let sendStarted!: () => void;
    const sendStartedPromise = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const transport: TelegramTransport = async () => {
      sendStarted();
      await sendGate;
      return json({
        ok: true,
        result: { message_id: 701, chat: { id: -1001234567890 } },
      });
    };
    const owner = await lockOwner();
    const closer = await connect();
    try {
      const ownerPid = (
        await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      const dispatchPromise = dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: transport,
      });
      await sendStartedPromise;
      // The dispatcher read the incident at seq 1 before the provider replied.
      const [before] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(before.seq).toBe(1);

      // A closer commits the resolution while the send is still in flight.
      await closer.query("BEGIN");
      await closer.query(
        `UPDATE incidents
            SET "resolvedAt" = $2, seq = 2, "closedBy" = 'collector'
          WHERE id = $1`,
        [incidentId, new Date(START + 2_000)],
      );
      const opening = await closer.query<{
        status: string;
        attemptStartedAt: Date | null;
      }>(
        `SELECT status, "attemptStartedAt"
           FROM notification_outbox
          WHERE key = $1`,
        [`incident:${incidentId}:open`],
      );
      expect(opening.rows[0]).toMatchObject({ status: "claimed" });
      expect(opening.rows[0].attemptStartedAt).not.toBeNull();

      releaseSend();
      // The confirmation must wait for the closer instead of reading seq 1.
      const deadline = Date.now() + 5_000;
      let waited = false;
      while (Date.now() < deadline) {
        const { rows } = await closer.query<{
          wait_event_type: string | null;
        }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [ownerPid],
        );
        if (rows[0]?.wait_event_type === "Lock") {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waited).toBe(true);
      await closer.query("COMMIT");

      await expect(dispatchPromise).resolves.toMatchObject({ action: "sent" });
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
      expect(edits[0]).toMatchObject({
        revision: 2,
        status: "pending",
        chatId: CHAT_ID,
        messageId: "701",
      });
    } finally {
      await closer.query("ROLLBACK").catch(() => {});
      await safeEnd(owner);
      await safeEnd(closer);
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
  it("honours retry_after across a restart and shares the cooldown", async () => {
    await openCritical("connection");
    await openCritical("backup-failed");
    let calls = 0;
    const provider = fakeProvider(() => {
      calls += 1;
      if (calls === 1)
        return json(
          {
            ok: false,
            error_code: 429,
            parameters: { retry_after: 60 },
          },
          429,
        );
      return json({ ok: true, result: { message_id: 600 + calls } });
    });
    const owner = await lockOwner();
    try {
      const first = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: provider.transport,
      });
      expect(first.action).toBe("retry");
      const rows = await db
        .select()
        .from(tables.notificationOutbox)
        .orderBy(tables.notificationOutbox.id);
      expect(rows).toHaveLength(2);
      const deadline = START + 1_000 + 60_000;
      for (const row of rows) {
        expect(row.nextAttemptAt.getTime()).toBe(deadline);
        expect(row.status).toBe("pending");
      }

      const early = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 31_000,
        fetchImpl: provider.transport,
      });
      expect(early.action).toBe("idle");
      expect(provider.calls).toHaveLength(1);

      // A fresh dispatcher with the same durable row does not advance the wait.
      const resumed = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 62_000,
        fetchImpl: provider.transport,
      });
      expect(resumed.action).toBe("sent");
      expect(provider.calls).toHaveLength(2);
    } finally {
      await safeEnd(owner);
    }
  });

  it("fails permanently on 400, 403 and 404 and creates one fallback per critical", async () => {
    for (const status of [400, 403, 404]) {
      const incidentId = await openCritical(`permanent-${status}`);
      const provider = fakeProvider(() => json({ ok: false }, status));
      const owner = await lockOwner();
      try {
        const result = await dispatch.runDispatchOnce({
          client: owner,
          config,
          now: () => START + 1_000,
          fetchImpl: provider.transport,
        });
        expect(result.action).toBe("failed");
        expect(provider.calls).toHaveLength(1);

        let rows = await db
          .select()
          .from(tables.notificationOutbox)
          .where(
            eq(tables.notificationOutbox.incidentId, incidentId),
          )
          .orderBy(tables.notificationOutbox.id);
        const opening = rows.find((row) => row.kind === "incident-open")!;
        expect(opening).toMatchObject({ status: "failed" });
        expect(opening.result).toMatchObject({ state: "failed" });
        expect(rows.filter((row) => row.kind === "incident-push")).toHaveLength(
          1,
        );
        const fallback = rows.find((row) => row.kind === "incident-push")!;
        expect(fallback).toMatchObject({
          channel: "push",
          status: "pending",
          revision: 1,
        });

        // Park the fallback so the next iteration claims only its own opening.
        await db
          .update(tables.notificationOutbox)
          .set({ nextAttemptAt: new Date(START + 86_400_000) })
          .where(eq(tables.notificationOutbox.id, fallback.id));

        await dispatch.runDispatchOnce({
          client: owner,
          config,
          now: () => START + 2_000,
          fetchImpl: provider.transport,
        });
        rows = await db
          .select()
          .from(tables.notificationOutbox)
          .where(
            eq(tables.notificationOutbox.incidentId, incidentId),
          );
        expect(rows).toHaveLength(2);
        expect(provider.calls).toHaveLength(1);
      } finally {
        await safeEnd(owner);
      }
    }
  });

  it("keeps an ambiguous attempt uncertain without a resend or fallback", async () => {
    const incidentId = await openCritical();
    const failing: TelegramTransport = async () => {
      throw new Error("connection reset");
    };
    const owner = await lockOwner();
    try {
      const result = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: failing,
      });
      expect(result.action).toBe("uncertain");
      const rows = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "uncertain" });
      expect(rows[0].result).toMatchObject({
        state: "uncertain",
        reason: "network",
      });
      expect(rows.some((row) => row.kind === "incident-push")).toBe(false);

      const again = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 2_000,
        fetchImpl: failing,
      });
      expect(again.action).toBe("idle");
      expect(
        await db
          .select()
          .from(tables.notificationOutbox)
          .where(eq(tables.notificationOutbox.incidentId, incidentId)),
      ).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("edits the original Telegram message in seq order without a second send", async () => {
    const incidentId = await openCritical("disk-health");
    const provider = fakeProvider(() =>
      json({ ok: true, result: { message_id: 77 } }),
    );
    const owner = await lockOwner();
    try {
      expect(
        (
          await dispatch.runDispatchOnce({
            client: owner,
            config,
            now: () => START + 1_000,
            fetchImpl: provider.transport,
          })
        ).action,
      ).toBe("sent");

      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "disk-health",
        failing: true,
        severity: "warning",
        title: "Disco a vigilar",
        detail: "sda: watch",
        now: START + 2_000,
        delivery: { channel: "digest", reason: "digest_pending" },
      });
      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "disk-health",
        failing: false,
        now: START + 3_000,
        closedBy: "collector",
      });

      let edits = await db
        .select()
        .from(tables.notificationOutbox)
        .where(
          and(
            eq(tables.notificationOutbox.incidentId, incidentId),
            eq(tables.notificationOutbox.kind, "incident-edit"),
          ),
        )
        .orderBy(tables.notificationOutbox.revision);
      expect(edits.map((row) => row.revision)).toEqual([2, 3]);

      const coalesced = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 4_000,
        fetchImpl: provider.transport,
      });
      expect(coalesced.action).toBe("superseded");
      const edited = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 5_000,
        fetchImpl: provider.transport,
      });
      expect(edited.action).toBe("edited");

      expect(provider.calls).toHaveLength(2);
      const editCall = provider.calls[1];
      expect(editCall.url).toBe(
        `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`,
      );
      expect(editCall.body.message_id).toBe("77");
      expect(editCall.body).not.toHaveProperty("parse_mode");
      expect(String(editCall.body.text)).toContain("Disco a vigilar");

      edits = await db
        .select()
        .from(tables.notificationOutbox)
        .where(
          and(
            eq(tables.notificationOutbox.incidentId, incidentId),
            eq(tables.notificationOutbox.kind, "incident-edit"),
          ),
        )
        .orderBy(tables.notificationOutbox.revision);
      expect(edits).toHaveLength(2);
      expect(edits[0]).toMatchObject({ status: "superseded" });
      expect(edits[1]).toMatchObject({ status: "sent" });
      expect(edits[1].editResult).toMatchObject({ state: "sent" });
      expect(edits[0].result).toBeNull();

      const [opening] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:open`));
      expect(opening).toMatchObject({
        status: "sent",
        revision: 1,
        messageId: "77",
      });
      expect(opening.result).toMatchObject({ state: "sent" });
    } finally {
      await safeEnd(owner);
    }
  });

  it("never edits after an uncertain opening", async () => {
    const incidentId = await openCritical();
    const failing: TelegramTransport = async () => {
      throw new Error("timeout");
    };
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: failing,
      });
      await db.insert(tables.notificationOutbox).values({
        key: `incident:${incidentId}:edit:2`,
        incidentId,
        kind: "incident-edit",
        channel: "telegram",
        status: "pending",
        revision: 2,
        chatId: CHAT_ID,
        messageId: "77",
      });
      const result = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 2_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("failed");
      expect(provider.calls).toHaveLength(0);
      const [edit] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:edit:2`));
      expect(edit.status).toBe("failed");
      expect(edit.editResult).toMatchObject({
        state: "failed",
        reason: "initial_uncertain",
      });
    } finally {
      await safeEnd(owner);
    }
  });

  it("cancels an opening closed before the attempt started", async () => {
    const incidentId = await openCritical();
    const provider = fakeProvider();
    const owner = await lockOwner();
    try {
      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "connection",
        failing: false,
        now: START + 500,
        closedBy: "collector",
      });
      const result = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("idle");
      expect(provider.calls).toHaveLength(0);
      const [row] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(row.status).toBe("suppressed");
      expect(row.result).toMatchObject({
        reason: "resolved_before_send",
      });
    } finally {
      await safeEnd(owner);
    }
  });

  it("records a deleted message as a permanent edit failure", async () => {
    const incidentId = await openCritical("disk-health");
    let calls = 0;
    const provider = fakeProvider(() => {
      calls += 1;
      if (calls === 1) return json({ ok: true, result: { message_id: 88 } });
      return json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message to edit not found",
        },
        400,
      );
    });
    const owner = await lockOwner();
    try {
      await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: provider.transport,
      });
      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "disk-health",
        failing: true,
        severity: "warning",
        title: "Disco a vigilar",
        detail: "sda: watch",
        now: START + 2_000,
        delivery: { channel: "digest", reason: "digest_pending" },
      });
      const result = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 3_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("failed");
      const [edit] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:edit:2`));
      expect(edit.status).toBe("failed");
      expect(edit.editResult).toMatchObject({
        state: "failed",
        reason: "message_missing",
      });
      expect(provider.calls).toHaveLength(2);
      expect(
        provider.calls.filter((call) => call.url.endsWith("/sendMessage")),
      ).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("keeps the accepted push channel when the warning escalates", async () => {
    await createUser("owner");
    await createSubscription("owner", "https://push.example/owner");
    const incidentId = await openWarning("disk-health");
    const push = fakePush();
    const telegram = fakeProvider();
    const owner = await lockOwner();
    try {
      const first = await dispatch.runDispatchOnce({
        client: owner,
        config: vapidConfig(),
        now: () => START + 1_000,
        pushTransport: push.transport,
        fetchImpl: telegram.transport,
      });
      expect(first.action).toBe("sent");
      expect(push.calls).toHaveLength(1);
      expect(push.calls[0].body).toMatchObject({
        tag: `hub:incident:nas-home:${incidentId}`,
        seq: 1,
        url: `/?view=alerts&host=nas-home&incident=${incidentId}`,
      });

      await store.recordIncidentObservation({
        hostId: "nas-home",
        key: "disk-health",
        failing: true,
        severity: "critical",
        title: "Disco con fallo",
        detail: "sda: fail",
        now: START + 2_000,
        delivery: { channel: "telegram", reason: "policy_immediate" },
      });

      const rows = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "sent",
        channel: "push",
      });

      const next = await dispatch.runDispatchOnce({
        client: owner,
        config: vapidConfig(),
        now: () => START + 3_000,
        pushTransport: push.transport,
        fetchImpl: telegram.transport,
      });
      expect(next.action).toBe("idle");
      expect(push.calls).toHaveLength(1);
      expect(telegram.calls).toHaveLength(0);
      const [incident] = await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.id, incidentId));
      expect(incident.severity).toBe("critical");
    } finally {
      await safeEnd(owner);
    }
  });

  it("scopes a push test to its owner and removes gone endpoints", async () => {
    await createUser("owner");
    await createUser("other");
    await createSubscription("owner", "https://push.example/owner-a");
    await createSubscription("owner", "https://push.example/owner-gone");
    await createSubscription("other", "https://push.example/other");
    await db.insert(tables.notificationOutbox).values({
      key: "push-test:owner:1",
      ownerUserId: "owner",
      kind: "push-test",
      channel: "push",
      status: "pending",
    });
    const push = fakePush((endpoint) => {
      if (endpoint.endsWith("owner-gone")) {
        throw { statusCode: 410 };
      }
    });
    const owner = await lockOwner();
    try {
      const result = await dispatch.runDispatchOnce({
        client: owner,
        config: vapidConfig(),
        now: () => START + 1_000,
        pushTransport: push.transport,
      });
      expect(result.action).toBe("sent");
      expect(push.calls.map((call) => call.endpoint).sort()).toEqual([
        "https://push.example/owner-a",
        "https://push.example/owner-gone",
      ]);
      const endpoints = (
        await db.select().from(tables.subscriptions)
      ).map((row) => row.endpoint);
      expect(endpoints.sort()).toEqual([
        "https://push.example/other",
        "https://push.example/owner-a",
      ]);
      const [row] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.key, "push-test:owner:1"));
      expect(row).toMatchObject({ status: "sent", channel: "push" });
      expect(row.result).toMatchObject({ state: "sent" });
    } finally {
      await safeEnd(owner);
    }
  });

  it("records transient push responses as uncertain and other 4xx as failed", async () => {
    await createUser("owner");
    await createSubscription("owner", "https://push.example/owner");
    const owner = await lockOwner();
    try {
      for (const [status, action] of [
        [429, "uncertain"],
        [500, "uncertain"],
        [400, "failed"],
      ] as const) {
        const incidentId = await openWarning(`push-${status}`);
        const push = fakePush(() => {
          throw { statusCode: status };
        });
        const result = await dispatch.runDispatchOnce({
          client: owner,
          config: vapidConfig(),
          now: () => START + 1_000,
          pushTransport: push.transport,
        });
        expect(result.action).toBe(action);
        const [row] = await db
          .select()
          .from(tables.notificationOutbox)
          .where(eq(tables.notificationOutbox.incidentId, incidentId));
        expect(row.status).toBe(action);
        expect(row.result).toMatchObject(
          action === "uncertain"
            ? { state: "uncertain", reason: "endpoint_uncertain" }
            : { state: "failed", reason: "endpoint_rejected" },
        );
      }
    } finally {
      await safeEnd(owner);
    }
  });

  it("persists the fallback result separately from the initial failure", async () => {
    await createUser("owner");
    await createSubscription("owner", "https://push.example/owner");
    const incidentId = await openCritical();
    const telegram = fakeProvider(() => json({ ok: false }, 400));
    const push = fakePush();
    const owner = await lockOwner();
    try {
      await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => START + 1_000,
        fetchImpl: telegram.transport,
      });
      const fallback = await dispatch.runDispatchOnce({
        client: owner,
        config: vapidConfig(),
        now: () => START + 2_000,
        pushTransport: push.transport,
        fetchImpl: telegram.transport,
      });
      expect(fallback.action).toBe("sent");
      expect(push.calls).toHaveLength(1);
      expect(push.calls[0].body.tag).toBe(
        `hub:incident:nas-home:${incidentId}`,
      );

      const [opening] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:open`));
      expect(opening.result).toMatchObject({ state: "failed" });
      expect(opening.fallbackResult).toMatchObject({ state: "sent" });
      expect(opening.status).toBe("failed");

      const [fallbackRow] = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:push`));
      expect(fallbackRow).toMatchObject({
        status: "sent",
        channel: "push",
        kind: "incident-push",
      });
      expect(fallbackRow.result).toMatchObject({ state: "sent" });
    } finally {
      await safeEnd(owner);
    }
  });

  it("keeps live work when retention removes a resolved episode", async () => {
    const old = new Date(START - 40 * 86_400_000);
    const [terminal] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "old-terminal",
        title: "Vieja terminal",
        detail: "",
        severity: "warning",
        at: old,
        resolvedAt: new Date(START - 35 * 86_400_000),
        fingerprint: store.incidentFingerprint("nas-home", "old-terminal"),
        seq: 2,
        origin: "live",
      })
      .returning();
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${terminal.id}:open`,
      incidentId: terminal.id,
      kind: "incident-open",
      channel: "telegram",
      status: "sent",
      revision: 1,
      chatId: CHAT_ID,
      messageId: "1",
    });
    const [live] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "old-live",
        title: "Vieja con trabajo",
        detail: "",
        severity: "critical",
        at: old,
        resolvedAt: new Date(START - 35 * 86_400_000),
        fingerprint: store.incidentFingerprint("nas-home", "old-live"),
        seq: 3,
        origin: "live",
      })
      .returning();
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${live.id}:edit:3`,
      incidentId: live.id,
      kind: "incident-edit",
      channel: "telegram",
      status: "pending",
      revision: 3,
      chatId: CHAT_ID,
      messageId: "2",
    });

    await store.cleanupExpiredIncidents(new Date(START));

    const remaining = await db
      .select()
      .from(tables.incidents)
      .orderBy(tables.incidents.id);
    expect(remaining.map((row) => row.id)).toEqual([live.id]);
    const remainingOutbox = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.incidentId, live.id));
    expect(remainingOutbox).toHaveLength(1);
  });

  // 2026-11-26 08:00 Europe/Madrid (CET). The whole digest lane runs on this
  // fixed clock so the window boundaries are reproducible.
  const DIGEST_DAY = "2026-11-26";
  const DIGEST_TARGET = Date.parse("2026-11-26T07:00:00.000Z");
  const DIGEST_DUE = DIGEST_TARGET + 2 * 3_600_000;

  /** Configured hosts are the only ones the snapshot may read. */
  function digestConfig(): RuntimeConfig {
    return {
    ...config,
    hosts: [
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: "http://127.0.0.1:9450",
        token: "t".repeat(32),
      },
    ],
    };
  }

  async function openDigestWarning(): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key: "disk",
      failing: true,
      severity: "warning",
      title: "Disco casi lleno",
      detail: "sda1 al 91%",
      now: DIGEST_TARGET - 60_000,
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    expect(opened.action).toBe("opened");
    expect(opened.delivery).toBe("none");
    return opened.incidentId!;
  }

  /** Immediate Telegram episode whose row is due on the injected clock. */
  async function openTelegramAt(
    now: number,
    key = "connection",
    severity = "critical",
  ): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity,
      title: "NAS sin respuesta",
      detail: "Sin métricas del agente",
      now,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    expect(opened.delivery).toBe("queued");
    await db
      .update(tables.notificationOutbox)
      .set({ nextAttemptAt: new Date(now) })
      .where(eq(tables.notificationOutbox.incidentId, opened.incidentId!));
    return opened.incidentId!;
  }

  /** Warning delivered by push, due on the injected clock. */
  async function openPushAt(now: number, key = "disk-health"): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity: "warning",
      title: "Disco a vigilar",
      detail: "sda: watch",
      now,
      delivery: { channel: "push", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    await db
      .update(tables.notificationOutbox)
      .set({ nextAttemptAt: new Date(now) })
      .where(eq(tables.notificationOutbox.incidentId, opened.incidentId!));
    return opened.incidentId!;
  }

  async function digestRun() {
    const [row] = await db.select().from(tables.digestRuns);
    return row;
  }

  const DIGEST_PERIOD_START = DIGEST_TARGET - 24 * 3_600_000;
  const HOUR = 3_600_000;

  type DigestEpisodeOptions = {
    at: number;
    key: string;
    hostId?: string;
    title?: string;
    severity?: "warning" | "critical" | "info";
    channel?: "digest" | "telegram" | "push" | "silent";
    reason?:
      | "digest_pending"
      | "policy_immediate"
      | "policy_silent"
      | "legacy_open";
  };

  /** One episode with the disposition the policy would have persisted. */
  async function digestEpisode(options: DigestEpisodeOptions): Promise<number> {
    const channel = options.channel ?? "digest";
    const opened = await store.recordIncidentObservation({
      hostId: options.hostId ?? "nas-home",
      key: options.key,
      failing: true,
      severity: options.severity ?? "warning",
      title: options.title ?? `Aviso ${options.key}`,
      detail: "Detalle interno que no debe salir",
      now: options.at,
      delivery: {
        channel,
        reason:
          options.reason ??
          (channel === "digest"
            ? "digest_pending"
            : channel === "silent"
              ? "policy_silent"
              : "policy_immediate"),
      },
    });
    expect(opened.action).toBe("opened");
    return opened.incidentId!;
  }

  async function resolveEpisode(
    key: string,
    at: number,
    hostId = "nas-home",
  ): Promise<void> {
    const resolved = await store.recordIncidentObservation({
      hostId,
      key,
      failing: false,
      now: at,
    });
    expect(resolved.action).toBe("resolved");
  }

  async function escalateEpisode(
    key: string,
    at: number,
    severity: "warning" | "critical",
    channel: "digest" | "telegram",
  ): Promise<void> {
    const escalated = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity,
      now: at,
      delivery: {
        channel,
        reason: channel === "digest" ? "digest_pending" : "policy_immediate",
      },
    });
    expect(escalated.action).toBe("escalated");
  }

  /** Episode written before the outbox existed: no opening row at all. */
  async function insertHistory(options: {
    key: string;
    at: number;
    resolvedAt?: number;
    closedBy?: "collector" | "migration-dedup";
    origin?: "legacy" | "live";
  }): Promise<number> {
    const [row] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: options.key,
        title: "Histórica duplicada",
        detail: "",
        severity: "warning",
        at: new Date(options.at),
        resolvedAt:
          options.resolvedAt === undefined ? null : new Date(options.resolvedAt),
        fingerprint: store.incidentFingerprint("nas-home", options.key),
        seq: 2,
        origin: options.origin ?? "legacy",
        ...(options.closedBy ? { closedBy: options.closedBy } : {}),
      })
      .returning();
    return row.id;
  }

  function digestSnapshotInput(overrides: {
    periodStart?: number;
    periodEnd?: number;
    snapshotAt?: number;
    alertsUrl?: string;
  } = {}) {
    return {
      hostIds: ["nas-home"],
      hostNames: { "nas-home": "NAS-HOME" },
      periodStart: new Date(overrides.periodStart ?? DIGEST_PERIOD_START),
      periodEnd: new Date(overrides.periodEnd ?? DIGEST_TARGET),
      snapshotAt: new Date(overrides.snapshotAt ?? DIGEST_TARGET + 60_000),
      alertsUrl:
        overrides.alertsUrl ?? content.digestAlertsUrl(BETTER_AUTH_URL),
    };
  }

  function bulletLines(text: string): string[] {
    return text.split("\n").filter((line) => line.startsWith("· "));
  }

  it("builds the daily cohorts and counters from the durable disposition", async () => {
    const ids = {
      old: await digestEpisode({
        key: "disk",
        at: DIGEST_PERIOD_START - 3 * 86_400_000,
        title: "Antigua todavía abierta",
      }),
      oldSecond: await digestEpisode({
        key: "memory",
        at: DIGEST_PERIOD_START - 4 * 86_400_000,
        title: "Segunda antigua abierta",
      }),
      start: await digestEpisode({
        key: "cpu",
        at: DIGEST_PERIOD_START,
        title: "Frontera inicial",
      }),
      end: await digestEpisode({
        key: "reboot-pending",
        at: DIGEST_TARGET,
        title: "Abierta tras el corte",
      }),
      recovered: await digestEpisode({
        key: "release-retained",
        at: DIGEST_TARGET - 30 * 60_000,
        title: "Recuperada durante la ventana",
      }),
      helper: await digestEpisode({
        key: "helper-cleanup",
        at: DIGEST_PERIOD_START + 5 * HOUR,
        title: "Ayudante pendiente",
      }),
      closed: await digestEpisode({
        key: "disk-health",
        at: DIGEST_PERIOD_START + 3 * HOUR,
        title: "Nueva ya cerrada",
      }),
      pushed: await digestEpisode({
        key: "temperature",
        at: DIGEST_PERIOD_START + 6 * HOUR,
        channel: "push",
        title: "Aviso entregado por push",
      }),
      silent: await digestEpisode({
        key: "container:web",
        at: DIGEST_PERIOD_START + 4 * HOUR,
        channel: "silent",
        title: "Silenciosa",
      }),
      escalated: await digestEpisode({
        key: "backup-failed",
        at: DIGEST_PERIOD_START + 7 * HOUR,
        title: "Escalada y vuelta",
      }),
      individualClosed: await digestEpisode({
        key: "stack-unit-failed",
        at: DIGEST_PERIOD_START + 11 * HOUR,
        channel: "telegram",
        title: "Individual cerrada",
      }),
      silentClosed: await digestEpisode({
        key: "container:db",
        at: DIGEST_PERIOD_START + 13 * HOUR,
        channel: "silent",
        title: "Silenciosa cerrada",
      }),
      oldCritical: await digestEpisode({
        key: "connection",
        at: DIGEST_PERIOD_START - 2 * HOUR,
        title: "Crítica por escalada posterior",
      }),
      foreign: await digestEpisode({
        key: "disk",
        hostId: "nas-apps",
        at: DIGEST_PERIOD_START + 16 * HOUR,
        title: "Host ajeno",
      }),
    };
    // A closure before the snapshot and one committed after it: only the
    // first leaves the open set at the snapshot instant.
    await resolveEpisode("disk-health", DIGEST_TARGET - HOUR);
    await resolveEpisode("stack-unit-failed", DIGEST_PERIOD_START + 12 * HOUR);
    await resolveEpisode("container:db", DIGEST_PERIOD_START + 14 * HOUR);
    await resolveEpisode("release-retained", DIGEST_TARGET + 90_000);
    // An escalation inside the period counts the critical even though the
    // episode returns to warning and the digest keeps listing it.
    await escalateEpisode("backup-failed", DIGEST_PERIOD_START + 8 * HOUR, "critical", "telegram");
    await escalateEpisode("backup-failed", DIGEST_PERIOD_START + 9 * HOUR, "warning", "digest");
    // An episode opened before the period escalates inside it.
    await escalateEpisode("connection", DIGEST_PERIOD_START + 10 * HOUR, "critical", "telegram");
    const migration = await insertHistory({
      key: "migration-dedup",
      at: DIGEST_PERIOD_START - 5 * 86_400_000,
      resolvedAt: DIGEST_TARGET - 30 * 60_000,
      closedBy: "migration-dedup",
      origin: "live",
    });
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${migration}:open`,
      incidentId: migration,
      kind: "incident-open",
      channel: "digest",
      status: "suppressed",
      revision: 1,
      result: {
        state: "suppressed",
        reason: "digest_pending",
        at: new Date(DIGEST_PERIOD_START - 5 * 86_400_000).toISOString(),
      },
    });
    await insertHistory({
      key: "legacy-open",
      at: DIGEST_PERIOD_START + 2 * HOUR,
    });

    const client = await connect();
    let snapshot: Awaited<ReturnType<typeof content.buildDigestSnapshot>>;
    try {
      snapshot = await content.buildDigestSnapshot({
        client,
        ...digestSnapshotInput(),
      });
    } finally {
      await safeEnd(client);
    }
    expect(snapshot).not.toBeNull();
    const built = snapshot!;
    expect(built.counts).toEqual({
      openNow: 7,
      newInPeriod: 7,
      newOpen: 5,
      newClosed: 2,
      critical: 2,
      resolved: 2,
    });
    expect(built.listed).toEqual([
      ids.start,
      ids.helper,
      ids.escalated,
      ids.recovered,
      ids.end,
    ]);
    expect(built.entries).toBe(7);
    expect(built.omitted).toBe(0);
    expect(built.text.length).toBeLessThanOrEqual(4096);
    expect(built.text.endsWith(digestSnapshotInput().alertsUrl)).toBe(true);

    const bullets = bulletLines(built.text);
    expect(bullets).toHaveLength(6);
    expect(built.text).toContain("NAS-HOME");
    for (const title of [
      "Frontera inicial",
      "Ayudante pendiente",
      "Escalada y vuelta",
      "Recuperada durante la ventana",
      "Abierta tras el corte",
    ])
      expect(bullets.some((line) => line.includes(title))).toBe(true);
    expect(bullets.some((line) => line.includes("2 anteriores"))).toBe(true);
    // Only the agents' own fields leave the database.
    expect(built.text).not.toContain("Detalle interno");
    for (const hidden of [
      "Host ajeno",
      "Silenciosa",
      "Individual cerrada",
      "Crítica por escalada posterior",
      "Antigua todavía abierta",
      "Histórica duplicada",
    ])
      expect(built.text).not.toContain(hidden);

    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const delivered = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(delivered).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(provider.calls).toHaveLength(1);
      const run = await digestRun();
      // The frozen payload is exactly the snapshot rendered at that instant.
      expect(run.payload).toBe(built.text);
      expect(provider.calls[0].body.text).toBe(built.text);
      expect(await db.select().from(tables.digestRuns)).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("sends a footer-only digest when there is activity but no eligible row", async () => {
    await digestEpisode({
      key: "cpu",
      at: DIGEST_PERIOD_START + HOUR,
      title: "Nueva ya cerrada",
    });
    await resolveEpisode("cpu", DIGEST_TARGET - HOUR);
    await digestEpisode({
      key: "connection",
      at: DIGEST_PERIOD_START + 2 * HOUR,
      channel: "telegram",
      severity: "critical",
      title: "Crítica inmediata",
    });

    const client = await connect();
    let snapshot: Awaited<ReturnType<typeof content.buildDigestSnapshot>>;
    try {
      snapshot = await content.buildDigestSnapshot({
        client,
        ...digestSnapshotInput(),
      });
    } finally {
      await safeEnd(client);
    }
    expect(snapshot).not.toBeNull();
    const built = snapshot!;
    expect(built.counts).toEqual({
      openNow: 0,
      newInPeriod: 2,
      newOpen: 1,
      newClosed: 1,
      critical: 1,
      resolved: 1,
    });
    expect(built.entries).toBe(0);
    expect(built.omitted).toBe(0);
    expect(bulletLines(built.text)).toHaveLength(0);
    expect(built.text).toContain(content.digestCountersLine(built.counts));
    expect(built.text.endsWith(digestSnapshotInput().alertsUrl)).toBe(true);

    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const delivered = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(delivered).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].body.text).toBe(built.text);
      expect((await digestRun()).payload).toBe(built.text);
    } finally {
      await safeEnd(owner);
    }
  });

  it("stays silent when the day has no details and no countable activity", async () => {
    await digestEpisode({
      key: "container:web",
      at: DIGEST_PERIOD_START + HOUR,
      channel: "silent",
      title: "Silenciosa",
    });
    await insertHistory({
      key: "legacy-open",
      at: DIGEST_PERIOD_START + 2 * HOUR,
    });
    await digestEpisode({
      key: "disk",
      hostId: "nas-apps",
      at: DIGEST_PERIOD_START + 3 * HOUR,
      title: "Host ajeno",
    });

    const client = await connect();
    try {
      expect(
        await content.buildDigestSnapshot({
          client,
          ...digestSnapshotInput(),
        }),
      ).toBeNull();
    } finally {
      await safeEnd(client);
    }

    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("idle");
      expect(provider.calls).toHaveLength(0);
      expect(await digestRun()).toMatchObject({
        status: "empty",
        reason: "digest_empty",
        payload: null,
      });
    } finally {
      await safeEnd(owner);
    }
  });

  it("leaves the individual queue and the timeline untouched", async () => {
    await openTelegramAt(DIGEST_TARGET - 120_000);
    await openDigestWarning();
    const outboxBefore = await db
      .select()
      .from(tables.notificationOutbox)
      .orderBy(tables.notificationOutbox.id);
    const eventsBefore = await db
      .select()
      .from(tables.incidentEvents)
      .orderBy(tables.incidentEvents.incidentId, tables.incidentEvents.seq);
    expect(outboxBefore.some((row) => row.channel === "telegram")).toBe(true);

    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("sent");
      expect(provider.calls).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }

    expect(
      await db
        .select()
        .from(tables.notificationOutbox)
        .orderBy(tables.notificationOutbox.id),
    ).toEqual(outboxBefore);
    expect(
      await db
        .select()
        .from(tables.incidentEvents)
        .orderBy(tables.incidentEvents.incidentId, tables.incidentEvents.seq),
    ).toEqual(eventsBefore);
  });

  it("caps the materialised details and reports the rest as omitted", async () => {
    const total = content.DIGEST_DETAIL_LIMIT + 5;
    for (let index = 0; index < total; index++) {
      await digestEpisode({
        key: `cpu-${index}`,
        at: DIGEST_PERIOD_START + index * 1_000,
        title: `Aviso ${index}`,
      });
    }

    const client = await connect();
    let snapshot: Awaited<ReturnType<typeof content.buildDigestSnapshot>>;
    try {
      snapshot = await content.buildDigestSnapshot({
        client,
        ...digestSnapshotInput(),
      });
    } finally {
      await safeEnd(client);
    }
    expect(snapshot).not.toBeNull();
    const built = snapshot!;
    expect(built.counts.openNow).toBe(total);
    expect(built.entries).toBe(content.DIGEST_DETAIL_LIMIT);
    expect(built.omitted).toBe(5);
    expect(bulletLines(built.text)).toHaveLength(content.DIGEST_DETAIL_LIMIT);
    expect(built.text).toContain("+5 más");
    expect(built.text.endsWith(content.digestAlertsUrl(BETTER_AUTH_URL))).toBe(
      true,
    );
    expect(built.entries + built.omitted).toBe(total);
  });

  it("delivers a bounded digest with exact omissions when the details exceed the text", async () => {
    const total = 45;
    for (let index = 0; index < total; index++) {
      await digestEpisode({
        key: `disk-${index}`,
        at: DIGEST_PERIOD_START + index * 1_000,
        title: `Seguimiento ${index} ${"x".repeat(110)}`,
      });
    }

    const client = await connect();
    let snapshot: Awaited<ReturnType<typeof content.buildDigestSnapshot>>;
    try {
      snapshot = await content.buildDigestSnapshot({
        client,
        ...digestSnapshotInput(),
      });
    } finally {
      await safeEnd(client);
    }
    expect(snapshot).not.toBeNull();
    const built = snapshot!;
    const alertsUrl = content.digestAlertsUrl(BETTER_AUTH_URL);
    expect(built.counts.openNow).toBe(total);
    expect(built.text.length).toBeLessThanOrEqual(4096);
    expect(built.text.endsWith(alertsUrl)).toBe(true);
    expect(built.omitted).toBeGreaterThanOrEqual(
      total - content.DIGEST_DETAIL_LIMIT,
    );
    expect(built.entries + built.omitted).toBe(total);
    expect(built.text).toContain(`+${built.omitted} más`);
    expect(bulletLines(built.text)).toHaveLength(built.entries);

    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const delivered = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(delivered).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(provider.calls).toHaveLength(1);
      const wire = String(provider.calls[0].body.text);
      expect(wire.length).toBeLessThanOrEqual(4096);
      expect(wire).toBe(built.text);
      expect(wire.endsWith(alertsUrl)).toBe(true);
      expect(wire).toContain(`+${built.omitted} más`);
    } finally {
      await safeEnd(owner);
    }
  });

  it("repeats the frozen digest after an authorized retry even when the episodes change", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const limited = fakeProvider(() =>
      json(
        { ok: false, error_code: 429, parameters: { retry_after: 120 } },
        429,
      ),
    );
    try {
      const first = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 30_000,
        fetchImpl: limited.transport,
      });
      expect(first).toMatchObject({
        action: "retry",
        date: DIGEST_DAY,
        reason: "rate_limited",
      });
      const frozen = (await digestRun()).payload!;
      const alertsUrl = content.digestAlertsUrl(BETTER_AUTH_URL);
      expect(frozen.endsWith(alertsUrl)).toBe(true);

      // The hub moves between attempts: the listed episode is resolved and a
      // new one opens. An authorized repetition must still send the old bytes.
      await resolveEpisode("disk", DIGEST_TARGET + 60_000);
      await digestEpisode({
        key: "memory",
        at: DIGEST_TARGET + 61_000,
        title: "Cambio posterior",
      });

      const retried = fakeProvider();
      const second = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 151_000,
        fetchImpl: retried.transport,
      });
      expect(second).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(retried.calls).toHaveLength(1);
      expect(retried.calls[0].body.text).toBe(frozen);
      expect(retried.calls[0].body.text).toContain("Disco casi lleno");
      expect(retried.calls[0].body.text).not.toContain("Cambio posterior");
      const markup = retried.calls[0].body.reply_markup as {
        inline_keyboard: Array<Array<{ url: string }>>;
      };
      expect(markup.inline_keyboard[0][0].url).toBe(alertsUrl);
    } finally {
      await safeEnd(owner);
    }
  });

  it("sends one digest per Madrid date with frozen content and keeps it after a restart", async () => {
    await openDigestWarning();
    const provider = fakeProvider();
    let owner = await lockOwner();
    try {
      const first = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(first).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(provider.calls).toHaveLength(1);
      const [call] = provider.calls;
      expect(call.url).toBe(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      );
      expect(call.body.chat_id).toBe(CHAT_ID);
      expect(call.body).not.toHaveProperty("parse_mode");

      const run = await digestRun();
      expect(run).toMatchObject({
        date: DIGEST_DAY,
        status: "sent",
        attempts: 1,
        claimToken: null,
        leaseUntil: null,
      });
      expect(run.targetAt.getTime()).toBe(DIGEST_TARGET);
      expect(run.dueAt.getTime()).toBe(DIGEST_DUE);
      expect(run.preparedAt).not.toBeNull();
      // The wire text is exactly the frozen payload, footer included.
      expect(String(call.body.text)).toBe(run.payload);
      expect(run.payload).toContain("Disco casi lleno");
      const link = new URL(run.payload!.split("\n").at(-1)!);
      expect(link.origin).toBe(BETTER_AUTH_URL);
      expect(link.searchParams.get("view")).toBe("alerts");

      // A restart around the hour reuses the confirmed row: no second POST.
      await safeEnd(owner);
      owner = await lockOwner();
      const resumed = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 120_000,
        fetchImpl: provider.transport,
      });
      expect(resumed.action).toBe("idle");
      expect(provider.calls).toHaveLength(1);
      expect(await db.select().from(tables.digestRuns)).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("does not let a competing session deliver the same date", async () => {
    await openDigestWarning();
    const provider = fakeProvider();
    const owner = await lockOwner();
    const competitor = await connect();
    try {
      await expect(
        digest.runDigestOnce({
          client: competitor,
          config: digestConfig(),
          now: () => DIGEST_TARGET + 60_000,
          fetchImpl: provider.transport,
        }),
      ).rejects.toBeInstanceOf(dispatch.CollectionLockLost);
      expect(provider.calls).toHaveLength(0);

      const sent = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(sent.action).toBe("sent");
      expect(provider.calls).toHaveLength(1);

      await dispatch.releaseCollectionLock(owner);
      expect(await dispatch.acquireCollectionLock(competitor)).toBe(true);
      const again = await digest.runDigestOnce({
        client: competitor,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 90_000,
        fetchImpl: provider.transport,
      });
      expect(again.action).toBe("idle");
      expect(provider.calls).toHaveLength(1);
      expect(await db.select().from(tables.digestRuns)).toHaveLength(1);
    } finally {
      await dispatch.releaseCollectionLock(owner).catch(() => {});
      await safeEnd(owner);
      await safeEnd(competitor);
    }
  });

  it("recovers a claim that expired before the attempt started", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    await digest.prepareDigestRuns({
      client: owner,
      config: digestConfig(),
      now: () => DIGEST_TARGET + 60_000,
    });
    const claimed = await digest.claimDigestRun(
      owner,
      "stale-token",
      DIGEST_TARGET + 60_000,
      1_000,
    );
    expect(claimed).not.toBeNull();
    expect(claimed!.attemptStartedAt).toBeNull();
    await safeEnd(owner);

    const next = await lockOwner();
    const provider = fakeProvider();
    try {
      const result = await digest.runDigestOnce({
        client: next,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 90_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("sent");
      expect(provider.calls).toHaveLength(1);
      expect(await digestRun()).toMatchObject({ status: "sent", attempts: 1 });
    } finally {
      await safeEnd(next);
    }
  });

  it("keeps an attempt-started lease uncertain without a resend", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    await digest.prepareDigestRuns({
      client: owner,
      config: digestConfig(),
      now: () => DIGEST_TARGET + 60_000,
    });
    const claimed = await digest.claimDigestRun(
      owner,
      "started-token",
      DIGEST_TARGET + 60_000,
      1_000,
    );
    expect(claimed).not.toBeNull();
    const attempts = await digest.beginDigestAttempt(
      owner,
      claimed!.id,
      "started-token",
      DIGEST_TARGET + 60_000,
    );
    expect(attempts).toBe(1);
    await safeEnd(owner);

    const next = await lockOwner();
    const provider = fakeProvider();
    const transitions: unknown[] = [];
    try {
      const first = await digest.runDigestOnce({
        client: next,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 120_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(first.action).not.toBe("sent");
      expect(provider.calls).toHaveLength(0);
      const run = await digestRun();
      expect(run).toMatchObject({
        status: "uncertain",
        attempts: 1,
        claimToken: null,
        leaseUntil: null,
      });
      expect(run.reason).toBe("lease_expired_after_attempt");
      // The recovery is reported once, with the finite reason only.
      expect(transitions).toEqual([
        {
          date: DIGEST_DAY,
          status: "uncertain",
          reason: "lease_expired_after_attempt",
        },
      ]);

      const second = await digest.runDigestOnce({
        client: next,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 180_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(second.action).toBe("idle");
      expect(provider.calls).toHaveLength(0);
      expect(transitions).toHaveLength(1);
      expect(await db.select().from(tables.digestRuns)).toHaveLength(1);
    } finally {
      await safeEnd(next);
    }
  });

  it("expires when the clock crosses the deadline during the start mark", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      // Freeze the run first so the tick below only reaches the start mark.
      await digest.prepareDigestRuns({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
      });
      expect((await digestRun()).payload).not.toBeNull();

      let reads = 0;
      const times = [DIGEST_TARGET + 120_000, DIGEST_DUE];
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => times[Math.min(reads++, times.length - 1)],
        fetchImpl: provider.transport,
      });
      expect(result).toMatchObject({
        action: "expired",
        date: DIGEST_DAY,
        reason: "window_closed",
      });
      expect(provider.calls).toHaveLength(0);
      const run = await digestRun();
      expect(run).toMatchObject({ status: "expired", attempts: 1 });
      expect(run.reason).toBe("window_closed");
    } finally {
      await safeEnd(owner);
    }
  });

  it("closes an empty cut without a request", async () => {
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("idle");
      expect(provider.calls).toHaveLength(0);
      const run = await digestRun();
      expect(run).toMatchObject({ status: "empty", attempts: 0 });
      expect(run.reason).toBe("digest_empty");
      expect(run.payload).toBeNull();
    } finally {
      await safeEnd(owner);
    }
  });

  it("closes the date as unconfigured when Telegram is absent", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      await digest.runDigestOnce({
        client: owner,
        config: { ...config, telegram: null },
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      expect(provider.calls).toHaveLength(0);
      const run = await digestRun();
      expect(run).toMatchObject({ status: "unconfigured", attempts: 0 });
      expect(run.reason).toBe("telegram_disabled");
      expect(run.payload).toBeNull();
    } finally {
      await safeEnd(owner);
    }
  });

  it("honours a configured civil time that crosses midnight", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    // 23:30 Europe/Madrid, read from the runtime configuration.
    const late: RuntimeConfig = { ...digestConfig(), digestTime: "23:30" };
    try {
      // 00:00 Europe/Madrid on 2026-11-27: yesterday's 23:30 target is still
      // inside its two-hour window, so the date is served after midnight.
      const result = await digest.runDigestOnce({
        client: owner,
        config: late,
        now: () => Date.parse("2026-11-26T23:00:00.000Z"),
        fetchImpl: provider.transport,
      });
      expect(result).toMatchObject({ action: "sent", date: "2026-11-26" });
      expect(provider.calls).toHaveLength(1);
      const run = await digestRun();
      expect(run.targetAt.getTime()).toBe(
        Date.parse("2026-11-26T22:30:00.000Z"),
      );
      expect(run.dueAt.getTime()).toBe(Date.parse("2026-11-27T00:30:00.000Z"));
    } finally {
      await safeEnd(owner);
    }
  });

  it("keeps the frozen target when the configured time changes", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      // 08:00 prepared the date; the operator later moves DIGEST_TIME to 23:30.
      await digest.prepareDigestRuns({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
      });
      const changed: RuntimeConfig = {
        ...digestConfig(),
        digestTime: "23:30",
      };
      const result = await digest.runDigestOnce({
        client: owner,
        config: changed,
        now: () => DIGEST_TARGET + 120_000,
        fetchImpl: provider.transport,
      });
      expect(result).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(provider.calls).toHaveLength(1);
      const run = await digestRun();
      expect(run.targetAt.getTime()).toBe(DIGEST_TARGET);
      expect(run.dueAt.getTime()).toBe(DIGEST_DUE);
      // A second date is never opened for the same civil day.
      expect(await db.select().from(tables.digestRuns)).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("keeps contiguous periods across a schedule change", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
      });
      // The next day runs at 23:30: its period still starts at the target the
      // previous date actually used, not at the new schedule.
      const late: RuntimeConfig = { ...digestConfig(), digestTime: "23:30" };
      const next = await digest.runDigestOnce({
        client: owner,
        config: late,
        now: () => Date.parse("2026-11-27T22:31:00.000Z"),
        fetchImpl: provider.transport,
      });
      expect(next).toMatchObject({ action: "sent", date: "2026-11-27" });
      expect(provider.calls).toHaveLength(2);
      const runs = await db
        .select()
        .from(tables.digestRuns)
        .orderBy(tables.digestRuns.date);
      expect(runs[1].targetAt.getTime()).toBe(
        Date.parse("2026-11-27T22:30:00.000Z"),
      );
      expect(runs[1].periodStartAt.getTime()).toBe(DIGEST_TARGET);
    } finally {
      await safeEnd(owner);
    }
  });

  it("records one omission after a long stop instead of replaying days", async () => {
    await db.insert(tables.digestRuns).values({
      date: "2026-11-23",
      targetAt: new Date("2026-11-23T07:00:00.000Z"),
      periodStartAt: new Date("2026-11-22T07:00:00.000Z"),
      dueAt: new Date("2026-11-23T09:00:00.000Z"),
      status: "sent",
      payload: "Resumen anterior",
    });
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    const transitions: unknown[] = [];
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(result).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(provider.calls).toHaveLength(1);
      // The single omitted window is reported once with its finite reason.
      expect(transitions).toEqual([
        { date: "2026-11-25", status: "expired", reason: "digest_missed" },
      ]);
      const runs = await db
        .select()
        .from(tables.digestRuns)
        .orderBy(tables.digestRuns.date);
      // Only the latest omission is recorded; the two older dates are absent.
      expect(runs.map((run) => run.date)).toEqual([
        "2026-11-23",
        "2026-11-25",
        "2026-11-26",
      ]);
      expect(runs[1]).toMatchObject({
        status: "expired",
        reason: "digest_missed",
        payload: null,
      });
    } finally {
      await safeEnd(owner);
    }
  });

  it("delays a new digest while a confirmed Telegram 429 is active", async () => {
    await openTelegramAt(DIGEST_TARGET - 120_000);
    await openDigestWarning();
    const owner = await lockOwner();
    const limited = fakeProvider(() =>
      json(
        { ok: false, error_code: 429, parameters: { retry_after: 300 } },
        429,
      ),
    );
    try {
      const opening = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => DIGEST_TARGET - 120_000,
        fetchImpl: limited.transport,
      });
      expect(opening.action).toBe("retry");
      expect(limited.calls).toHaveLength(1);

      // The opening's 429 precedes the digest enqueue: no POST inside the pause.
      const blocked = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: limited.transport,
      });
      expect(blocked.action).toBe("idle");
      expect(limited.calls).toHaveLength(1);
      expect(await digestRun()).toMatchObject({
        status: "prepared",
        attempts: 0,
      });

      const resumed = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 240_000,
        fetchImpl: fakeProvider().transport,
      });
      expect(resumed).toMatchObject({ action: "sent", date: DIGEST_DAY });
    } finally {
      await safeEnd(owner);
    }
  });

  it("pauses new Telegram notices after a confirmed digest 429", async () => {
    await createUser("owner");
    await createSubscription("owner", "https://push.example/owner");
    await openDigestWarning();
    let owner = await lockOwner();
    const limited = fakeProvider(() =>
      json(
        { ok: false, error_code: 429, parameters: { retry_after: 120 } },
        429,
      ),
    );
    const push = fakePush();
    try {
      const digestLimited = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 30_000,
        fetchImpl: limited.transport,
      });
      expect(digestLimited).toMatchObject({
        action: "retry",
        date: DIGEST_DAY,
        reason: "rate_limited",
      });
      expect(limited.calls).toHaveLength(1);
      const frozen = (await digestRun()).payload;
      expect(frozen).toContain("Disco casi lleno");

      // A notice queued after the digest 429 waits for the same pause.
      await openTelegramAt(DIGEST_TARGET + 40_000, "temperature");
      const blocked = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: limited.transport,
      });
      expect(blocked.action).toBe("idle");
      expect(limited.calls).toHaveLength(1);

      // A fresh session reads the same durable pause after a restart.
      await safeEnd(owner);
      owner = await lockOwner();
      const stillBlocked = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => DIGEST_TARGET + 65_000,
        fetchImpl: limited.transport,
      });
      expect(stillBlocked.action).toBe("idle");
      expect(limited.calls).toHaveLength(1);

      // Push keeps its own path during the Telegram pause.
      await openPushAt(DIGEST_TARGET + 40_000);
      const pushed = await dispatch.runDispatchOnce({
        client: owner,
        config: vapidConfig(),
        now: () => DIGEST_TARGET + 70_000,
        pushTransport: push.transport,
        fetchImpl: limited.transport,
      });
      expect(pushed.action).toBe("sent");
      expect(push.calls).toHaveLength(1);
      expect(limited.calls).toHaveLength(1);

      // The pause expires and the digest repeats the exact frozen bytes.
      const resumed = fakeProvider();
      const retried = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 180_000,
        fetchImpl: resumed.transport,
      });
      expect(retried).toMatchObject({ action: "sent", date: DIGEST_DAY });
      expect(resumed.calls).toHaveLength(1);
      expect(resumed.calls[0].body.text).toBe(frozen);
    } finally {
      await safeEnd(owner);
    }
  });

  it("shares the pause from a confirmed edit 429 with the digest", async () => {
    await openDigestWarning();
    const [incident] = await db
      .insert(tables.incidents)
      .values({
        hostId: "nas-home",
        key: "temperature",
        title: "Temperatura alta",
        detail: "",
        severity: "warning",
        at: new Date(DIGEST_TARGET - 3_600_000),
        fingerprint: store.incidentFingerprint("nas-home", "temperature"),
        seq: 2,
        origin: "live",
      })
      .returning();
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${incident.id}:open`,
      incidentId: incident.id,
      kind: "incident-open",
      channel: "telegram",
      status: "sent",
      revision: 1,
      chatId: CHAT_ID,
      messageId: "88",
      result: {
        state: "sent",
        reason: null,
        at: new Date(DIGEST_TARGET - 3_600_000).toISOString(),
      },
    });
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${incident.id}:edit:2`,
      incidentId: incident.id,
      kind: "incident-edit",
      channel: "telegram",
      status: "pending",
      revision: 2,
      chatId: CHAT_ID,
      messageId: "88",
      nextAttemptAt: new Date(DIGEST_TARGET - 60_000),
    });
    const owner = await lockOwner();
    const limited = fakeProvider(() =>
      json(
        { ok: false, error_code: 429, parameters: { retry_after: 300 } },
        429,
      ),
    );
    try {
      const edit = await dispatch.runDispatchOnce({
        client: owner,
        config,
        now: () => DIGEST_TARGET - 30_000,
        fetchImpl: limited.transport,
      });
      expect(edit.action).toBe("retry");
      expect(limited.calls).toHaveLength(1);

      const blocked = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: fakeProvider().transport,
      });
      expect(blocked.action).toBe("idle");
      expect(await digestRun()).toMatchObject({
        status: "prepared",
        attempts: 0,
      });
    } finally {
      await safeEnd(owner);
    }
  });

  it("ends the date when the confirmed retry passes the window", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const limited = fakeProvider(() =>
      json(
        { ok: false, error_code: 429, parameters: { retry_after: 7_200 } },
        429,
      ),
    );
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: limited.transport,
      });
      expect(result).toMatchObject({
        action: "failed",
        date: DIGEST_DAY,
        reason: "window_closed",
      });
      expect(limited.calls).toHaveLength(1);
      const run = await digestRun();
      expect(run).toMatchObject({ status: "failed", reason: "window_closed" });
      // The confirmed 429 still records the shared pause.
      const cooldown = await db.select().from(tables.telegramCooldown);
      expect(cooldown).toHaveLength(1);
      expect(cooldown[0].until.getTime()).toBe(
        DIGEST_TARGET + 60_000 + 7_200_000,
      );
    } finally {
      await safeEnd(owner);
    }
  });

  it("does not send before the configured time and sends once it arrives", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const early = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET - 60_000,
        fetchImpl: provider.transport,
      });
      expect(early.action).toBe("idle");
      expect(provider.calls).toHaveLength(0);
      expect(await db.select().from(tables.digestRuns)).toHaveLength(0);

      const onTime = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 1_000,
        fetchImpl: provider.transport,
      });
      expect(onTime.action).toBe("sent");
      expect(provider.calls).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("never starts a request at the exact end of the window", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_DUE,
        fetchImpl: provider.transport,
      });
      expect(result.action).toBe("idle");
      expect(provider.calls).toHaveLength(0);
      // No live candidate covers that date, so nothing is scheduled for it.
      expect(await db.select().from(tables.digestRuns)).toHaveLength(0);
    } finally {
      await safeEnd(owner);
    }
  });

  it("reports one bounded failure transition for a confirmed rejection", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider(() =>
      json(
        { ok: false, error_code: 400, description: "Bad Request: chat not found" },
        400,
      ),
    );
    const transitions: unknown[] = [];
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(result).toMatchObject({
        action: "failed",
        date: DIGEST_DAY,
        reason: "telegram_400",
      });
      expect(transitions).toEqual([
        { date: DIGEST_DAY, status: "failed", reason: "telegram_400" },
      ]);
      const logged = JSON.stringify(transitions);
      expect(logged).not.toContain(BOT_TOKEN);
      expect(logged).not.toContain(CHAT_ID);
      expect(logged).not.toContain("Disco casi lleno");
      // The failure never queues a second notice on another channel. The only
      // outbox row is the opening disposition that keeps the episode for the
      // summary, not a new delivery attempt.
      const outbox = await db.select().from(tables.notificationOutbox);
      expect(outbox.every((row) => row.channel === "digest")).toBe(true);

      // Reading the terminal row again does not repeat the transition.
      const again = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 120_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(again.action).toBe("idle");
      expect(transitions).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("reports an ambiguous attempt as uncertain without claiming a delivery", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider(() => {
      throw new Error("socket closed after the attempt mark");
    });
    const transitions: unknown[] = [];
    try {
      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(result).toMatchObject({
        action: "uncertain",
        date: DIGEST_DAY,
        reason: "network",
      });
      expect(transitions).toEqual([
        { date: DIGEST_DAY, status: "uncertain", reason: "network" },
      ]);
      expect(await digestRun()).toMatchObject({
        status: "uncertain",
        reason: "network",
        attempts: 1,
      });

      const again = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 180_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(again.action).toBe("idle");
      expect(transitions).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

  it("reports the last lost window once when the tick returns after the deadline", async () => {
    await openDigestWarning();
    const owner = await lockOwner();
    const provider = fakeProvider();
    const transitions: unknown[] = [];
    try {
      await digest.prepareDigestRuns({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_TARGET + 60_000,
      });
      expect((await digestRun()).status).toBe("prepared");

      const result = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_DUE,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(result).toMatchObject({ action: "idle" });
      expect(provider.calls).toHaveLength(0);
      expect(transitions).toEqual([
        { date: DIGEST_DAY, status: "expired", reason: "window_closed" },
      ]);
      expect(await digestRun()).toMatchObject({
        status: "expired",
        reason: "window_closed",
      });

      const again = await digest.runDigestOnce({
        client: owner,
        config: digestConfig(),
        now: () => DIGEST_DUE + 60_000,
        fetchImpl: provider.transport,
        onTransition: (event) => transitions.push(event),
      });
      expect(again.action).toBe("idle");
      expect(transitions).toHaveLength(1);
    } finally {
      await safeEnd(owner);
    }
  });

});

describe("worker health", () => {
  type WorkerHealthLike = import("@/lib/worker-health").WorkerHealth;
  let healthModule: typeof import("@/lib/worker-health");
  let loopModule: typeof import("@/lib/worker-loop");
  let CollectionLockLost: typeof import("@/lib/notification-dispatch").CollectionLockLost;
  const pid = 4242;
  const startIdentity = "777";
  let root: string;
  let procRoot: string;
  let file: string;
  let clock: number;

  // Loaded after the database suite has pointed DATABASE_URL at its disposable
  // database: the loop module imports the dispatcher, which imports the pool.
  beforeAll(async () => {
    healthModule = await import("@/lib/worker-health");
    loopModule = await import("@/lib/worker-loop");
    CollectionLockLost = (
      await import("@/lib/notification-dispatch")
    ).CollectionLockLost;
  });

  function statLine(identity: string) {
    const fields = [
      "1",
      "4242",
      "4242",
      "0",
      "-1",
      "4194304",
      "100",
      "0",
      "0",
      "0",
      "1",
      "1",
      "0",
      "0",
      "20",
      "0",
      "1",
      "0",
      identity,
    ];
    return `${pid} (node) S ${fields.join(" ")} 0 0`;
  }

  beforeEach(async () => {
    clock = 1_000_000;
    root = await mkdtemp(join(tmpdir(), "hub-worker-health-"));
    procRoot = join(root, "proc");
    file = join(root, "worker-health.json");
    await mkdir(join(procRoot, String(pid)), { recursive: true });
    await writeFile(join(procRoot, String(pid), "stat"), statLine(startIdentity));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function health(holdsLock: () => Promise<boolean> = async () => true) {
    return new healthModule.WorkerHealth({
      file,
      pid,
      procRoot,
      now: () => clock,
      holdsLock,
    });
  }

  it("writes a fresh private mark that the compose probe accepts", async () => {
    expect(await health().renew()).toBe(true);
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: true,
      reason: "ok",
    });
  });

  it("stops renewing after losing the lock and clears the mark on shutdown", async () => {
    const owner = health();
    expect(await owner.renew()).toBe(true);
    const lost = health(async () => false);
    expect(await lost.renew()).toBe(false);
    // The last real milestone stays until the shutdown path clears it, and a
    // refused renewal never extends it.
    expect((await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).ok).toBe(
      true,
    );
    owner.closeSync();
    expect(await owner.renew()).toBe(false);
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("marks a stopped loop unhealthy while the process is still alive and recovers", async () => {
    expect(await health().renew()).toBe(true);
    clock += healthModule.WORKER_STALE_MS + 1;
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "stale",
    });
    // The PID is still alive with the same start identity: only progress is
    // missing, so a new milestone restores health.
    expect(await healthModule.readProcessStartIdentity(pid, procRoot)).toBe(startIdentity);
    expect(await health().renew()).toBe(true);
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: true,
      reason: "ok",
    });
  });

  it("rejects a fresh mark from a reused PID with another start identity", async () => {
    await healthModule.writeWorkerHealth(file, {
      progressAt: clock - 1_000,
      pid,
      startedAt: "999",
    });
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "wrong_start",
    });
  });

  it("rejects missing, malformed, future, unsafe, dead and unreadable marks", async () => {
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "missing",
    });

    await writeFile(file, "not json", { mode: 0o600 });
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "malformed",
    });

    await healthModule.writeWorkerHealth(file, {
      progressAt: clock + 60_000,
      pid,
      startedAt: startIdentity,
    });
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "future",
    });

    await chmod(file, 0o644);
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "unsafe",
    });

    await healthModule.writeWorkerHealth(file, {
      progressAt: clock,
      pid: pid + 1,
      startedAt: startIdentity,
    });
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "dead_pid",
    });

    await mkdir(join(procRoot, String(pid + 2)));
    await healthModule.writeWorkerHealth(file, {
      progressAt: clock,
      pid: pid + 2,
      startedAt: startIdentity,
    });
    expect(await healthModule.checkWorkerHealth({ file, procRoot, now: clock })).toEqual({
      ok: false,
      reason: "identity_unreadable",
    });
  });

  it("renews after every completed delivery lane and stops once both are idle", async () => {
    const renewals: number[] = [];
    let step = 0;
    let dispatched = 0;
    let digested = 0;
    const healthFake = {
      renew: async () => {
        renewals.push(step);
        return true;
      },
    } as unknown as WorkerHealthLike;
    const actions = ["sent", "idle"];
    await loopModule.drainWorker({
      health: healthFake,
      runDispatch: async () => {
        step += 1;
        dispatched += 1;
        return { action: actions[dispatched - 1] };
      },
      runDigest: async () => {
        step += 1;
        digested += 1;
        return { action: actions[digested - 1] };
      },
      stopping: () => false,
    });
    expect(dispatched).toBe(2);
    expect(digested).toBe(2);
    expect(renewals).toEqual([1, 2, 3, 4]);
  });

  it("does not extend health when a delivery turn throws", async () => {
    let renewals = 0;
    const healthFake = {
      renew: async () => {
        renewals += 1;
        return true;
      },
    } as unknown as WorkerHealthLike;
    await expect(
      loopModule.drainWorker({
        health: healthFake,
        runDispatch: async () => {
          throw new Error("db down");
        },
        runDigest: async () => ({ action: "idle" }),
        stopping: () => false,
      }),
    ).rejects.toThrow("db down");
    expect(renewals).toBe(0);
  });

  it("renews only after real milestones of the loop that owns the lock", async () => {
    const order: string[] = [];
    let now = 5_000_000;
    const state = { lastCollection: 0, lastCleanup: 0 };
    await loopModule.workerTurn({
      health: {
        renew: async () => {
          order.push("renew");
          return true;
        },
      } as unknown as WorkerHealthLike,
      holdsLock: async () => {
        order.push("lock");
        return true;
      },
      stopping: () => false,
      now: () => now,
      presenceActive: async () => {
        order.push("presence");
        return true;
      },
      sampleInterval: () => 30_000,
      collect: async () => {
        order.push("collect");
        now += 1_000;
      },
      drain: async () => {
        order.push("drain");
        now += 1_000;
      },
      cleanup: async () => {
        order.push("cleanup");
      },
      state,
    });
    expect(order).toEqual([
      "lock",
      "presence",
      "renew",
      "collect",
      "renew",
      "drain",
      "renew",
      "cleanup",
      "renew",
    ]);
    expect(state.lastCollection).toBe(5_000_000);
    expect(state.lastCleanup).toBe(5_002_000);
  });

  it("does not renew after losing the lock, while stopping or past a failed milestone", async () => {
    let renewals = 0;
    const healthFake = {
      renew: async () => {
        renewals += 1;
        return true;
      },
    } as unknown as WorkerHealthLike;
    const base = {
      health: healthFake,
      stopping: () => false,
      now: () => 5_000_000,
      presenceActive: async () => true,
      sampleInterval: () => 30_000,
      collect: async () => {},
      drain: async () => {},
      cleanup: async () => {},
      state: { lastCollection: 0, lastCleanup: 0 },
    };

    await expect(
      loopModule.workerTurn({ ...base, holdsLock: async () => false }),
    ).rejects.toBeInstanceOf(CollectionLockLost);
    await loopModule.workerTurn({ ...base, holdsLock: async () => true, stopping: () => true });
    await expect(
      loopModule.workerTurn({
        ...base,
        holdsLock: async () => true,
        collect: async () => {
          throw new Error("agent down");
        },
      }),
    ).rejects.toThrow("agent down");
    // Only the completed presence query renewed before the failure.
    expect(renewals).toBe(1);
  });

  it("exits non-zero from the compose probe when the mark is missing", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-worker-health.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKER_HEALTH_FILE: join(root, "absent.json"),
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing");
  });
});
