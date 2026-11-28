import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

type Ingest = typeof import("@/lib/notification-ingest");

/** Contract vector shared with the media-stack producers (08-01 objective). */
const SECRET = "ingest-contract-secret-0123456789abcdef";
const VECTOR = {
  timestamp: "1700000000",
  body: '{"v":1,"source":"backup","eventId":"backup-failed:1700000000","hostId":"nas-home","key":"backup-failed","state":"open","data":{"errors":["restic backup failed (exit 1)"]}}',
  signature: "4525b5167d3882979d6b063dde511c6c28d2bec94d65811d2f512581b76eada1",
};

const baseUrl = testDatabaseUrl();
let context: TestDatabase | null = null;
let ingest: Ingest;
let route: typeof import("@/app/api/notifications/ingest/route");
let db: typeof import("@/lib/db").db;
let pool: typeof import("@/lib/db").pool;
let tables: typeof import("@/lib/schema");

beforeAll(async () => {
  process.env.NAS_HOSTS = JSON.stringify([
    {
      id: "nas-home",
      name: "NAS-HOME",
      role: "instance",
      url: "http://127.0.0.1:9",
      token: "a".repeat(32),
    },
  ]);
  if (baseUrl) {
    context = await createTestDatabase(baseUrl);
    process.env.DATABASE_URL = context.url;
  }
  ingest = await import("@/lib/notification-ingest");
  if (baseUrl) {
    const database = await import("@/lib/db");
    db = database.db;
    pool = database.pool;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: "./drizzle" });
    tables = await import("@/lib/schema");
    route = await import("@/app/api/notifications/ingest/route");
  }
});

afterAll(async () => {
  if (pool) await pool.end();
  if (context) await dropTestDatabase(context);
  delete process.env.NAS_HOSTS;
  delete process.env.NOTIFY_INGEST_SECRET;
  delete process.env.NOTIFY_INGEST_SECRET_PREVIOUS;
});

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    source: "backup",
    eventId: "backup-failed:1700000000",
    hostId: "nas-home",
    key: "backup-failed",
    state: "open",
    data: { errors: ["restic backup failed (exit 1)"] },
    ...overrides,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

type Signing = {
  secret?: string;
  timestamp?: string | null;
  signature?: string | null;
  headers?: Record<string, string>;
};

/** Builds a request the way a producer does; `null` omits the header. */
function ingestRequest(body: string, signing: Signing = {}): Request {
  const timestamp =
    signing.timestamp === undefined ? String(nowSeconds()) : signing.timestamp;
  const signature =
    signing.signature === undefined
      ? `v1=${ingest.signIngest(signing.secret ?? SECRET, timestamp ?? "", body)}`
      : signing.signature;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...signing.headers,
  };
  if (timestamp !== null) headers["x-ingest-timestamp"] = timestamp;
  if (signature !== null) headers["x-ingest-signature"] = signature;
  return new Request("http://hub.test/api/notifications/ingest", {
    method: "POST",
    headers,
    body,
  });
}

describe("contrato", () => {
  it("firma el vector de contrato byte a byte y lo verifica", () => {
    expect(ingest.signIngest(SECRET, VECTOR.timestamp, VECTOR.body)).toBe(
      VECTOR.signature,
    );
    expect(
      ingest.verifyIngest({
        secrets: { secret: SECRET, previous: null },
        timestamp: VECTOR.timestamp,
        signature: `v1=${VECTOR.signature}`,
        body: VECTOR.body,
        now: 1700000000,
      }),
    ).toBe(true);
  });

  it("acota la ventana a 300 s en ambos sentidos", () => {
    const verify = (now: number) =>
      ingest.verifyIngest({
        secrets: { secret: SECRET, previous: null },
        timestamp: VECTOR.timestamp,
        signature: `v1=${VECTOR.signature}`,
        body: VECTOR.body,
        now,
      });
    expect(verify(1700000300)).toBe(true);
    expect(verify(1699999700)).toBe(true);
    expect(verify(1700000301)).toBe(false);
    expect(verify(1699999699)).toBe(false);
  });

  it("compone el aviso de copia fallida en el hub, sin marcado", () => {
    const notice = ingest.composeIngestNotice(
      {
        source: "backup",
        data: { errors: ["<b>boom</b>\u0007 failed", "second"] },
      },
      { name: "NAS-HOME" },
    );
    expect(notice.severity).toBe("critical");
    expect(notice.title).toContain("NAS-HOME");
    expect(notice.detail).not.toMatch(/[<>\u0007]/);
    expect(notice.detail).toContain("second");
  });

  it("acota el aviso de issue-automator", () => {
    const notice = ingest.composeIngestNotice(
      {
        source: "issue-automator",
        data: {
          subject: "x".repeat(200),
          reportedBy: "ana",
          problem: "p",
          action: "a",
        },
      },
      { name: "NAS-HOME" },
    );
    expect(notice.severity).toBe("warning");
    expect(notice.title.length).toBeLessThanOrEqual(120);
    expect(notice.detail).toContain("ana");
  });
});

describe.skipIf(!baseUrl)("ingest firmado", () => {
  async function counts() {
    return {
      events: (await db.select().from(tables.ingestEvents)).length,
      incidents: (await db.select().from(tables.incidents)).length,
      outbox: (await db.select().from(tables.notificationOutbox)).length,
    };
  }

  beforeEach(async () => {
    process.env.NOTIFY_INGEST_SECRET = SECRET;
    delete process.env.NOTIFY_INGEST_SECRET_PREVIOUS;
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
    await db.delete(tables.ingestEvents);
  });

  it("abre una incidencia inmediata de Telegram con su outbox", async () => {
    const body = JSON.stringify(envelope());
    const response = await route.POST(ingestRequest(body));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      action: "opened",
    });
    const events = await db.select().from(tables.ingestEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "backup",
      eventId: "backup-failed:1700000000",
      bodyHash: createHash("sha256").update(body).digest("hex"),
    });
    const incidents = await db.select().from(tables.incidents);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      hostId: "nas-home",
      key: "backup-failed",
      severity: "critical",
    });
    expect(incidents[0].title).toContain("NAS-HOME");
    expect(incidents[0].detail).toContain("restic backup failed (exit 1)");
    expect(events[0].incidentId).toBe(incidents[0].id);
    const outbox = await db.select().from(tables.notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      kind: "incident-open",
      channel: "telegram",
      status: "pending",
    });
  });

  it("deja la respuesta sin caché", async () => {
    const response = await route.POST(
      ingestRequest(JSON.stringify(envelope())),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
