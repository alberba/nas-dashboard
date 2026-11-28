import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterAll,
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

type Ingest = typeof import("@/lib/notification-ingest");

/** Contract vector shared with the media-stack producers (08-01 objective). */
const SECRET = "ingest-contract-secret-0123456789abcdef";
const PREVIOUS = "previous-ingest-secret-0123456789abcdef";
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

  /** A rejection answers its code and leaves every table untouched. */
  async function rejected(request: Request, status: number) {
    const response = await route.POST(request);
    expect(response.status).toBe(status);
    expect(await counts()).toEqual({ events: 0, incidents: 0, outbox: 0 });
    return response;
  }

  describe("rechaza", () => {
    const body = JSON.stringify(envelope());
    const fresh = () => String(nowSeconds());
    const tamperedSignature = `v1=${"0".repeat(64)}`;

    const unauthorized: Array<[string, () => Request]> = [
      ["firma alterada", () => ingestRequest(body, { signature: tamperedSignature })],
      [
        "firma de otro secreto",
        () => ingestRequest(body, { secret: "another-secret-0123456789abcdefghij" }),
      ],
      ["cabecera de firma ausente", () => ingestRequest(body, { signature: null })],
      ["cabecera de firma vacía", () => ingestRequest(body, { signature: "" })],
      [
        "firma sin prefijo v1",
        () =>
          ingestRequest(body, {
            signature: ingest.signIngest(SECRET, fresh(), body),
            timestamp: fresh(),
          }),
      ],
      [
        "firma en mayúsculas",
        () => {
          const timestamp = fresh();
          return ingestRequest(body, {
            timestamp,
            signature: `v1=${ingest.signIngest(SECRET, timestamp, body).toUpperCase()}`,
          });
        },
      ],
      ["timestamp ausente", () => ingestRequest(body, { timestamp: null, signature: tamperedSignature })],
      [
        "timestamp con letras",
        () => ingestRequest(body, { timestamp: "17000000ab" }),
      ],
      ["timestamp de 9 dígitos", () => ingestRequest(body, { timestamp: "170000000" })],
      ["timestamp de 11 dígitos", () => ingestRequest(body, { timestamp: "17000000000" })],
      [
        "timestamp 301 s en el pasado",
        () => ingestRequest(body, { timestamp: String(nowSeconds() - 301) }),
      ],
      [
        "timestamp 301 s en el futuro",
        () => ingestRequest(body, { timestamp: String(nowSeconds() + 301) }),
      ],
    ];

    it.each(unauthorized)(
      "responde 401 sin efectos: %s",
      async (_name, build) => {
        await rejected(build(), 401);
      },
    );

    it("usa un único cuerpo de respuesta 401 para todas las variantes", async () => {
      const bodies = new Set<string>();
      for (const [, build] of unauthorized) {
        const response = await route.POST(build());
        expect(response.status).toBe(401);
        bodies.add(await response.text());
      }
      expect(bodies.size).toBe(1);
      const [only] = [...bodies];
      expect(only).not.toContain(SECRET);
      expect(only).not.toContain("backup-failed");
    });

    it("acepta 300 s exactos y rechaza 301 s con un reloj fijo", async () => {
      const now = 1_800_000_000_000;
      const at = (offset: number) =>
        ingest.handleIngest(
          ingestRequest(body, {
            timestamp: String(now / 1000 + offset),
          }),
          { now },
        );
      expect((await at(301)).status).toBe(401);
      expect((await at(-301)).status).toBe(401);
      expect((await at(-300)).status).toBe(202);
    });

    it("no escribe secreto ni cuerpo en la consola al rechazar", async () => {
      const spies = (["log", "error", "warn", "info"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => undefined),
      );
      await route.POST(ingestRequest(body, { signature: tamperedSignature }));
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      spies.forEach((spy) => spy.mockRestore());
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("restic");
    });

    it("lee el cuerpo solo con readBodyText", () => {
      for (const file of [
        "src/lib/notification-ingest.ts",
        "src/app/api/notifications/ingest/route.ts",
      ]) {
        const code = readFileSync(file, "utf8");
        expect(code).not.toMatch(
          /\b\w*(?:[Rr]equest|req)\s*\??\.\s*(?:json|text|formData|arrayBuffer|blob|body)\b/,
        );
      }
      expect(readFileSync("src/lib/notification-ingest.ts", "utf8")).toContain(
        "readBodyText(",
      );
    });

    it("responde 413 por encima de 8 KiB sin consultar la base", async () => {
      const transaction = vi.spyOn(db, "transaction");
      const padded = JSON.stringify(envelope()) + " ".repeat(8 * 1024);
      const responses = [
        await route.POST(ingestRequest(padded)),
        // The declared length understates the real body: the stream decides.
        await route.POST(
          ingestRequest(padded, { headers: { "content-length": "10" } }),
        ),
      ];
      expect(responses.map((response) => response.status)).toEqual([413, 413]);
      expect(transaction).not.toHaveBeenCalled();
      transaction.mockRestore();
      expect(await counts()).toEqual({ events: 0, incidents: 0, outbox: 0 });
    });

    it("acepta un cuerpo de exactamente 8 KiB", async () => {
      const base = JSON.stringify(envelope());
      const exact = base + " ".repeat(8 * 1024 - Buffer.byteLength(base));
      expect(Buffer.byteLength(exact)).toBe(8 * 1024);
      const response = await route.POST(ingestRequest(exact));
      expect(response.status).toBe(202);
    });

    const invalid: Array<[string, string]> = [
      ["JSON mal formado", "{not json"],
      ["campo desconocido", JSON.stringify(envelope({ extra: 1 }))],
      ["versión distinta de 1", JSON.stringify(envelope({ v: 2 }))],
      [
        "eventId con caracteres fuera de la clase",
        JSON.stringify(envelope({ eventId: "backup failed/1" })),
      ],
      [
        "seis errores",
        JSON.stringify(envelope({ data: { errors: ["a", "b", "c", "d", "e", "f"] } })),
      ],
      [
        "campo desconocido dentro de data",
        JSON.stringify(envelope({ data: { secret: "x" } })),
      ],
      ["fuente desconocida", JSON.stringify(envelope({ source: "other" }))],
    ];

    it.each(invalid)("responde 400 sin efectos: %s", async (_name, raw) => {
      await rejected(ingestRequest(raw), 400);
    });
  });

  describe("secreto", () => {
    const body = JSON.stringify(envelope());

    it("acepta la firma hecha con el secreto anterior durante la rotación", async () => {
      process.env.NOTIFY_INGEST_SECRET_PREVIOUS = PREVIOUS;
      const withPrevious = await route.POST(
        ingestRequest(body, { secret: PREVIOUS }),
      );
      expect(withPrevious.status).toBe(202);
    });

    it("sigue aceptando el secreto actual con uno anterior configurado", async () => {
      process.env.NOTIFY_INGEST_SECRET_PREVIOUS = PREVIOUS;
      const response = await route.POST(ingestRequest(body));
      expect(response.status).toBe(202);
    });

    it("rechaza un secreto desconocido, y el anterior si ya no está configurado", async () => {
      await rejected(ingestRequest(body, { secret: PREVIOUS }), 401);
      process.env.NOTIFY_INGEST_SECRET_PREVIOUS = PREVIOUS;
      await rejected(
        ingestRequest(body, { secret: "unknown-secret-0123456789abcdefghijkl" }),
        401,
      );
    });

    it("responde 503 sin ningún secreto configurado, sin eco", async () => {
      delete process.env.NOTIFY_INGEST_SECRET;
      const response = await rejected(ingestRequest(body), 503);
      const text = await response.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("restic");
    });

    it("responde 503 con un secreto mal formado en lugar de verificar con él", async () => {
      process.env.NOTIFY_INGEST_SECRET = "short";
      await rejected(ingestRequest(body, { secret: "short" }), 503);
    });
  });

  describe("alcance", () => {
    const scoped: Array<[string, Record<string, unknown>]> = [
      ["backup con otra clave", { key: "disk" }],
      [
        "issue-automator con backup-failed",
        { source: "issue-automator", key: "backup-failed" },
      ],
      [
        "issue-automator con issue:seerr: sin dígitos",
        { source: "issue-automator", key: "issue:seerr:" },
      ],
      [
        "issue-automator con una clave con letras",
        { source: "issue-automator", key: "issue:seerr:12a" },
      ],
      ["hostId ausente de getHosts", { hostId: "unknown-host" }],
    ];

    it.each(scoped)("responde 422 sin efectos: %s", async (_name, overrides) => {
      await rejected(
        ingestRequest(JSON.stringify(envelope(overrides))),
        422,
      );
    });

    it("admite issue-automator con issue:seerr:<n>", async () => {
      const response = await route.POST(
        ingestRequest(
          JSON.stringify(
            envelope({
              source: "issue-automator",
              eventId: "issue:seerr:42:open",
              key: "issue:seerr:42",
              data: { subject: "Sin audio", reportedBy: "ana" },
            }),
          ),
        ),
      );
      expect(response.status).toBe(202);
      const incidents = await db.select().from(tables.incidents);
      expect(incidents.map((row) => row.key)).toEqual(["issue:seerr:42"]);
    });
  });
});
