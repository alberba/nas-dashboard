import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inspect } from "node:util";
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
  vi,
} from "vitest";
import {
  answerTelegramCallback,
  deleteTelegramWebhook,
  editTelegramMessage,
  getTelegramUpdates,
  sendTelegramMessage,
  sendTelegramReply,
  type TelegramClientOptions,
  type TelegramTransport,
} from "@/lib/telegram";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";
import { createFakeBotApi } from "./telegram-fake";
import type { RuntimeConfig } from "@/lib/runtime-config";

/**
 * Redaction of the bot token (BOT-10, T-05-16).
 *
 * Every method of the client is driven through every way it can fail, with a
 * provider body, a transport error and a redirect that all repeat the token.
 * Neither the returned value nor anything the worker logs nor any row of the
 * outbox or the digest may carry it, and the URL that embeds it is built in one
 * single place.
 */

const baseUrl = testDatabaseUrl();
const TOKEN = "987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const NUMERIC = "987654321";
const CHAT_ID = "123456789";
const BETTER_AUTH_URL = "https://hub.example.com";
const START = Date.now() + 60 * 60_000;
const CANARY = "CANARIO-DE-UN-UPDATE-4b81";
const ALERTS_URL = `${BETTER_AUTH_URL}/?view=alerts`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fails if the value, serialized or fully inspected, carries the token. */
function expectNoToken(value: unknown, context: string) {
  const serialized = JSON.stringify(value) ?? "";
  const shown = inspect(value, { depth: null, maxArrayLength: null });
  for (const probe of [TOKEN, `bot${TOKEN}`, `${NUMERIC}:`]) {
    expect(serialized, `${context}: serialized`).not.toContain(probe);
    expect(shown, `${context}: inspected`).not.toContain(probe);
  }
}

type Mode = {
  id: string;
  transport: TelegramTransport;
  options?: Partial<TelegramClientOptions>;
};

/** The provider body that repeats the credential, as a real error can. */
function echoBody(status: number, method = "sendMessage") {
  return {
    ok: false,
    description: `Bad Request: /bot${TOKEN}/${method}`,
    parameters: { migrate_to_chat_id: -100 },
    status,
  };
}

const MODES: Mode[] = [
  {
    id: "success",
    transport: async () =>
      json({ ok: true, result: { message_id: 501, chat: { id: 1 } } }),
  },
  ...[400, 401, 403, 404, 409, 500].map((status) => ({
    id: `${status}`,
    transport: (async () => json(echoBody(status), status)) as TelegramTransport,
  })),
  {
    id: "429",
    transport: async () =>
      json(
        {
          ok: false,
          description: `Too Many Requests: retry after 1 /bot${TOKEN}/getUpdates`,
          parameters: { retry_after: 1 },
        },
        429,
      ),
  },
  {
    id: "200 with invalid json",
    transport: async () =>
      new Response(`not json at all /bot${TOKEN}/sendMessage`, { status: 200 }),
  },
  {
    id: "transport rejection",
    transport: async () => {
      const failure = new Error(`network down /bot${TOKEN}/sendMessage`);
      failure.cause = { detail: `connect ECONNREFUSED /bot${TOKEN}/x` };
      throw failure;
    },
  },
  {
    id: "aborted",
    transport: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new Error(`aborted /bot${TOKEN}/sendMessage`));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener("abort", fail, { once: true });
      }),
    options: { signal: AbortSignal.abort() },
  },
  {
    id: "timeout",
    transport: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new Error(`timeout /bot${TOKEN}/sendMessage`));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener("abort", fail, { once: true });
      }),
    options: { timeoutMs: 5 },
  },
  {
    id: "redirect",
    transport: async () =>
      new Response(null, {
        status: 302,
        headers: { Location: `https://api.telegram.org/bot${TOKEN}/sendMessage` },
      }),
  },
];

const METHODS: Array<{
  name: string;
  call: (options: TelegramClientOptions) => Promise<unknown>;
}> = [
  {
    name: "sendMessage",
    call: (options) =>
      sendTelegramMessage(
        {
          chatId: CHAT_ID,
          text: "NAS sin respuesta",
          buttonUrl: ALERTS_URL,
        },
        options,
      ),
  },
  {
    name: "editMessageText",
    call: (options) =>
      editTelegramMessage(
        {
          chatId: CHAT_ID,
          messageId: "501",
          text: "NAS sin respuesta",
          buttonUrl: ALERTS_URL,
        },
        options,
      ),
  },
  {
    name: "reply",
    call: (options) =>
      sendTelegramReply(
        { chatId: CHAT_ID, replyToMessageId: "501", text: "Por qué" },
        options,
      ),
  },
  {
    name: "getUpdates",
    call: (options) =>
      getTelegramUpdates({ offset: 1, timeoutSeconds: 0 }, options),
  },
  {
    name: "deleteWebhook",
    call: (options) => deleteTelegramWebhook(options),
  },
  {
    name: "answerCallbackQuery",
    call: (options) =>
      answerTelegramCallback({ callbackQueryId: "cb-1", text: "Hecho" }, options),
  },
];

/**
 * Every failure injected into the shared action. The lane calls it inside the
 * update transaction, so throwing here is the infrastructure-failure case whose
 * log line must stay finite.
 */
const poison = vi.hoisted(() => ({ failures: 0 }));

vi.mock("@/lib/incident-actions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/incident-actions")>();
  return {
    ...actual,
    applyIncidentAction: (
      ...args: Parameters<typeof actual.applyIncidentAction>
    ) => {
      if (poison.failures > 0) {
        poison.failures -= 1;
        return Promise.reject(new Error(`fallo /bot${TOKEN}/x`));
      }
      return actual.applyIncidentAction(...args);
    },
  };
});

describe("telegram token redaction in the client", () => {
  it.each(METHODS)(
    "returns a finite result for $name under every failure mode",
    async (method) => {
      for (const mode of MODES) {
        const options: TelegramClientOptions = {
          botToken: TOKEN,
          fetchImpl: mode.transport,
          ...mode.options,
        };
        const result = await method.call(options);
        expect(result, `${method.name} on ${mode.id}`).toHaveProperty("state");
        expectNoToken(result, `${method.name} on ${mode.id}`);
      }
    },
  );

  it("builds the URL with the token in a single place", () => {
    const src = join(process.cwd(), "src");
    const pattern = /\/bot\$\{/g;
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
      }
    };
    walk(src);

    const hits = files
      .map((file) => ({
        file: relative(process.cwd(), file),
        count: (readFileSync(file, "utf8").match(pattern) ?? []).length,
      }))
      .filter((hit) => hit.count > 0);

    // The expectation is measured on the real tree: one construction, one file.
    expect(hits).toEqual([{ file: "src/lib/telegram.ts", count: 1 }]);
  });
});

type Keyboard = {
  inline_keyboard: Array<
    Array<{ text?: string; url?: string; callback_data?: string }>
  >;
};

describe.skipIf(!baseUrl)("telegram token redaction across the worker", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let dispatch: typeof import("@/lib/notification-dispatch");
  let digest: typeof import("@/lib/digest-runs");
  let lane: typeof import("@/lib/telegram-updates");
  let actions: typeof import("@/lib/incident-actions");
  let why: typeof import("@/lib/incident-why");
  let config: RuntimeConfig;
  const openClients = new Set<Client>();

  const DIGEST_DAY = "2026-11-26";
  const DIGEST_TARGET = Date.parse("2026-11-26T07:00:00.000Z");

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
    lane = await import("@/lib/telegram-updates");
    actions = await import("@/lib/incident-actions");
    why = await import("@/lib/incident-why");
    config = {
      databaseUrl: context.url,
      betterAuthSecret: "b".repeat(32),
      betterAuthUrl: BETTER_AUTH_URL,
      setupToken: "s".repeat(32),
      trustedOrigins: [],
      hosts: [
        {
          id: "nas-home",
          name: "NAS-HOME",
          role: "instance",
          url: "http://127.0.0.1:9450",
          token: "t".repeat(32),
        },
      ],
      telegram: { botToken: TOKEN, chatId: CHAT_ID },
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
    poison.failures = 0;
    vi.restoreAllMocks();
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

  async function openCritical(key = "connection", at = START): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity: "critical",
      title: "NAS sin respuesta",
      detail: "Sin métricas del agente",
      now: at,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    return opened.incidentId!;
  }

  async function openWarning(key = "cpu", at = START): Promise<number> {
    const opened = await store.recordIncidentObservation({
      hostId: "nas-home",
      key,
      failing: true,
      severity: "warning",
      title: "Disco a vigilar",
      detail: "sda: watch",
      now: at,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened.action).toBe("opened");
    return opened.incidentId!;
  }

  /** Provider that rejects every call with a body repeating the token. */
  function failingTransport(): TelegramTransport {
    return async (url) => {
      const method = url.slice(url.lastIndexOf("/") + 1);
      return json(echoBody(400, method), 400);
    };
  }

  async function sendOpening(
    client: Client,
    fake = createFakeBotApi({ chatId: Number(CHAT_ID) }),
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
    const markup = call?.body.reply_markup as Keyboard | undefined;
    const token = markup?.inline_keyboard[1]?.[0]?.callback_data ?? "";
    return { incidentId, token };
  }

  async function outboxRow(key: string) {
    const [row] = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.key, key));
    return row;
  }

  it("keeps the token out of the opening and the edit rows", async () => {
    const client = await lockOwner();
    try {
      // A rejected opening: the row must record a finite reason only. A warning
      // is used so no push fallback competes for the next claim.
      const failedOpeningId = await openWarning("cpu");
      const failed = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 1_000,
        fetchImpl: failingTransport(),
      });
      expect(failed.action).toBe("failed");
      const failedRow = await outboxRow(`incident:${failedOpeningId}:open`);
      expectNoToken(failedRow, "failed opening row");

      // A sent opening, then a rejected edit.
      const { incidentId } = await sendOpening(client);
      await db.transaction((tx) =>
        actions.applyIncidentAction(tx, {
          action: "ack",
          incidentId,
          via: "hub",
          by: "test",
          now: START + 2_000,
        }),
      );
      const edited = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 120_000,
        fetchImpl: failingTransport(),
      });
      expect(edited.action).toBe("failed");
      const editRows = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      const editRow = editRows.find((row) => row.kind === "incident-edit");
      expect(editRow).toBeDefined();
      expectNoToken(editRow, "failed edit row");
      expectNoToken(editRows, "every row of the episode");
    } finally {
      await safeEnd(client);
    }
  });

  it("keeps the token out of the reply row", async () => {
    const client = await lockOwner();
    try {
      const { incidentId } = await sendOpening(client);
      await db.transaction((tx) => why.enqueueWhyReply(tx, { incidentId }));
      const replied = await dispatch.runDispatchOnce({
        client,
        config,
        now: () => START + 120_000,
        fetchImpl: failingTransport(),
      });
      expect(replied.action).toBe("failed");
      const rows = await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId));
      const replyRow = rows.find((row) => row.kind === "incident-why");
      expect(replyRow).toBeDefined();
      expectNoToken(replyRow, "failed reply row");
    } finally {
      await safeEnd(client);
    }
  });

  it("keeps the token out of the digest row", async () => {
    const client = await lockOwner();
    try {
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

      const result = await digest.runDigestOnce({
        client,
        config,
        now: () => DIGEST_TARGET + 60_000,
        fetchImpl: failingTransport(),
      });
      expect(result).toMatchObject({ action: "failed", date: DIGEST_DAY });

      const runs = await db.select().from(tables.digestRuns);
      expect(runs).toHaveLength(1);
      expectNoToken(runs, "digest row");
      expectNoToken(runs[0]?.payload, "digest payload");
    } finally {
      await safeEnd(client);
    }
  });

  it("keeps the token and the update content out of every log line", async () => {
    const fake = createFakeBotApi({ chatId: Number(CHAT_ID) });
    const client = await lockOwner();
    const captured: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(
          args.map((arg) => inspect(arg, { depth: null })).join(" "),
        );
      }),
    );
    try {
      const { token } = await sendOpening(client, fake);
      const update = fake.callbackUpdate({
        updateId: 950,
        data: token,
        messageId: 501,
      }) as unknown as {
        update_id: number;
        callback_query: {
          from: Record<string, unknown>;
          message: Record<string, unknown>;
        };
      };
      update.callback_query.from.first_name = CANARY;
      update.callback_query.message.text = CANARY;
      fake.enqueueUpdate(update);

      poison.failures = 3;
      const updates = lane.createUpdatesLane({
        client,
        config,
        fetchImpl: fake.transport,
        now: () => START + 60_000,
        log: (line) => console.error(line),
      });
      for (let turn = 0; turn < 3; turn += 1)
        await updates.run({ waitSeconds: 0 });

      expect(captured.length).toBeGreaterThan(0);
      for (const entry of captured) {
        expect(entry).not.toContain(TOKEN);
        expect(entry).not.toContain(CANARY);
        expect(entry).not.toContain(`bot${TOKEN}`);
        // A finite line: it never carries the update body.
        expect(entry.length).toBeLessThan(200);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      await safeEnd(client);
    }
  });
});
