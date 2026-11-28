import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
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

  describe("idempotencia", () => {
    const body = JSON.stringify(envelope());

    it("responde 200 a la repetición exacta sin filas nuevas", async () => {
      const first = await route.POST(ingestRequest(body));
      const second = await route.POST(ingestRequest(body));

      expect([first.status, second.status]).toEqual([202, 200]);
      expect(await second.json()).toEqual({ status: "duplicate" });
      expect(await counts()).toEqual({ events: 1, incidents: 1, outbox: 1 });
    });

    it("responde 200 a una repetición con otra marca de tiempo y la misma firma válida", async () => {
      await route.POST(ingestRequest(body));
      const later = await route.POST(
        ingestRequest(body, { timestamp: String(nowSeconds() + 5) }),
      );
      expect(later.status).toBe(200);
      expect(await counts()).toEqual({ events: 1, incidents: 1, outbox: 1 });
    });

    it("responde 409 al mismo eventId con otro cuerpo", async () => {
      await route.POST(ingestRequest(body));
      const other = JSON.stringify(
        envelope({ data: { errors: ["a different failure"] } }),
      );
      const response = await route.POST(ingestRequest(other));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ status: "conflict" });
      expect(await counts()).toEqual({ events: 1, incidents: 1, outbox: 1 });
    });

    it("deja una sola incidencia con dos peticiones simultáneas", async () => {
      const responses = await Promise.all([
        route.POST(ingestRequest(body)),
        route.POST(ingestRequest(body)),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 202,
      ]);
      expect(await counts()).toEqual({ events: 1, incidents: 1, outbox: 1 });
    });

    it("revierte la fila del ingest si falla el registro y el reintento se procesa", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const failed = await ingest.handleIngest(ingestRequest(body), {
        record: async () => {
          throw new Error("boom with secret detail");
        },
      });
      const logged = JSON.stringify(spy.mock.calls);
      spy.mockRestore();

      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("boom");
      expect(logged).not.toContain("boom");
      expect(await counts()).toEqual({ events: 0, incidents: 0, outbox: 0 });

      const retry = await route.POST(ingestRequest(body));
      expect(retry.status).toBe(202);
      expect(await counts()).toEqual({ events: 1, incidents: 1, outbox: 1 });
    });

    it("revierte la incidencia entera si el fallo llega tras escribirla", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const failed = await ingest.handleIngest(ingestRequest(body), {
        record: async (tx, input) => {
          const { recordIncidentObservationIn } = await import(
            "@/lib/incident-store"
          );
          await recordIncidentObservationIn(tx, input);
          throw new Error("late failure");
        },
      });
      spy.mockRestore();

      expect(failed.status).toBe(503);
      expect(await counts()).toEqual({ events: 0, incidents: 0, outbox: 0 });
    });
  });

  describe("ciclo", () => {
    it("abre con open y cierra con resolved sobre la misma clave", async () => {
      const opened = await route.POST(
        ingestRequest(JSON.stringify(envelope({ eventId: "backup-failed:1:open" }))),
      );
      expect(await opened.json()).toEqual({ status: "accepted", action: "opened" });

      const closed = await route.POST(
        ingestRequest(
          JSON.stringify(
            envelope({ eventId: "backup-failed:1:resolved", state: "resolved" }),
          ),
        ),
      );
      expect(closed.status).toBe(202);
      expect(await closed.json()).toEqual({
        status: "accepted",
        action: "resolved",
      });
      const [incident] = await db.select().from(tables.incidents);
      expect(incident.resolvedAt).not.toBeNull();
      expect(incident.closedBy).toBe("ingest");
    });

    const issueEvent = (overrides: Record<string, unknown> = {}) =>
      envelope({
        source: "issue-automator",
        eventId: "issue:seerr:42:open",
        key: "issue:seerr:42",
        state: "open",
        data: {
          subject: "Sin audio en el capítulo 3",
          reportedBy: "ana",
          problem: "Audio",
        },
        ...overrides,
      });
    const send = (event: Record<string, unknown>) =>
      route.POST(ingestRequest(JSON.stringify(event)));

    /** Marks the first notice as delivered, as the dispatcher would. */
    async function confirmSent() {
      await db
        .update(tables.notificationOutbox)
        .set({
          status: "sent",
          chatId: "100",
          messageId: "200",
          attemptStartedAt: new Date(),
        })
        .where(eq(tables.notificationOutbox.kind, "incident-open"));
    }

    it("abre una issue de Seerr como incidencia inmediata de Telegram con origen ingest", async () => {
      const response = await send(issueEvent());

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        status: "accepted",
        action: "opened",
      });
      const [incident] = await db.select().from(tables.incidents);
      expect(incident).toMatchObject({
        hostId: "nas-home",
        key: "issue:seerr:42",
        severity: "warning",
        origin: "ingest",
        resolvedAt: null,
      });
      const outbox = await db.select().from(tables.notificationOutbox);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        kind: "incident-open",
        channel: "telegram",
        status: "pending",
      });
    });

    it("no depende de PUSH_WARNINGS para entregar la issue por Telegram", async () => {
      const previous = process.env.PUSH_WARNINGS;
      process.env.PUSH_WARNINGS = "true";
      try {
        await send(issueEvent());
      } finally {
        if (previous === undefined) delete process.env.PUSH_WARNINGS;
        else process.env.PUSH_WARNINGS = previous;
      }
      const outbox = await db.select().from(tables.notificationOutbox);
      expect(outbox.map((row) => [row.kind, row.channel])).toEqual([
        ["incident-open", "telegram"],
      ]);
    });

    it("cierra la issue editando el mensaje original, sin mensaje nuevo", async () => {
      await send(issueEvent());
      await confirmSent();

      const closed = await send(
        issueEvent({ eventId: "issue:seerr:42:resolved", state: "resolved" }),
      );

      expect(closed.status).toBe(202);
      expect(await closed.json()).toEqual({
        status: "accepted",
        action: "resolved",
      });
      const [incident] = await db.select().from(tables.incidents);
      expect(incident.resolvedAt).not.toBeNull();
      expect(incident.closedBy).toBe("ingest");
      const outbox = await db.select().from(tables.notificationOutbox);
      expect(outbox.map((row) => row.kind).sort()).toEqual([
        "incident-edit",
        "incident-open",
      ]);
    });

    it("no abre otra incidencia con un reintento ni con otro open sobre la clave abierta", async () => {
      const first = await send(issueEvent());
      const retry = await send(issueEvent());
      const again = await send(issueEvent({ eventId: "issue:seerr:42:open-2" }));

      expect(first.status).toBe(202);
      expect(retry.status).toBe(200);
      expect(await again.json()).toEqual({
        status: "accepted",
        action: "observed",
      });
      expect(await db.select().from(tables.incidents)).toHaveLength(1);
      expect(await db.select().from(tables.notificationOutbox)).toHaveLength(1);
    });

    it("abre un episodio nuevo al reabrir la misma issue tras cerrarla", async () => {
      await send(issueEvent());
      await send(
        issueEvent({ eventId: "issue:seerr:42:resolved", state: "resolved" }),
      );
      const reopened = await send(
        issueEvent({ eventId: "issue:seerr:42:reopen" }),
      );

      expect(await reopened.json()).toEqual({
        status: "accepted",
        action: "opened",
      });
      const rows = await db.select().from(tables.incidents);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
      expect(rows.filter((row) => row.resolvedAt === null)).toHaveLength(1);
    });

    it("una resolved de una fuente no cierra la incidencia de otra", async () => {
      await send(issueEvent());
      const crossed = await send(
        envelope({
          source: "backup",
          eventId: "backup-failed:cross",
          key: "issue:seerr:42",
          state: "resolved",
        }),
      );

      expect(crossed.status).toBe(422);
      const [incident] = await db.select().from(tables.incidents);
      expect(incident.resolvedAt).toBeNull();
    });

    describe("texto compuesto por el hub", () => {
      const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
      // Built with fromCharCode so no invisible character sits in the source:
      // NUL, bidi override, line separator, then markup, mentions and fences.
      const invisible = String.fromCharCode(0x0000, 0x202e, 0x2028);
      const hostile = (limit: number) =>
        `L1\n\tL2\r${invisible}<b>x</b> **y** _z_ [a](http://evil.test) @usuario ${"`".repeat(3)}`
          .padEnd(limit, "·")
          .slice(0, limit);

      it("guarda un título plano y de 120 caracteres como mucho", async () => {
        const response = await send(
          issueEvent({ data: { subject: hostile(200) } }),
        );
        expect(response.status).toBe(202);
        const [incident] = await db.select().from(tables.incidents);
        expect(incident.title).not.toMatch(CONTROL);
        expect(incident.title.length).toBeLessThanOrEqual(120);
        expect(incident.title.length).toBeGreaterThan(0);
      });

      it("guarda un detalle plano y de 600 caracteres como mucho con los campos en su tope", async () => {
        const response = await send(
          issueEvent({
            data: {
              subject: hostile(200),
              reportedBy: hostile(100),
              problem: hostile(300),
              action: hostile(500),
            },
          }),
        );
        expect(response.status).toBe(202);
        const [incident] = await db.select().from(tables.incidents);
        expect(incident.detail).not.toMatch(CONTROL);
        expect(incident.detail.length).toBeLessThanOrEqual(600);
        expect(incident.detail.length).toBeGreaterThan(0);
      });

      it("acota el detalle de un evento de copia con cinco errores de 200 caracteres", async () => {
        const response = await send(
          envelope({
            data: { errors: Array.from({ length: 5 }, () => hostile(200)) },
          }),
        );
        expect(response.status).toBe(202);
        const [incident] = await db.select().from(tables.incidents);
        expect(incident.detail).not.toMatch(CONTROL);
        expect(incident.detail.length).toBeLessThanOrEqual(600);
        expect(incident.title).not.toMatch(CONTROL);
      });

      it("entrega el texto por Telegram sin parse_mode", async () => {
        const { Client } = await import("pg");
        const dispatch = await import("@/lib/notification-dispatch");
        await send(issueEvent({ data: { subject: hostile(200) } }));
        const [incident] = await db.select().from(tables.incidents);

        const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
        const client = new Client({ connectionString: context!.url });
        await client.connect();
        try {
          expect(await dispatch.acquireCollectionLock(client)).toBe(true);
          const result = await dispatch.runDispatchOnce({
            client,
            config: {
              databaseUrl: context!.url,
              betterAuthSecret: "b".repeat(32),
              betterAuthUrl: "https://hub.example.com",
              setupToken: "s".repeat(32),
              trustedOrigins: [],
              hosts: [],
              telegram: {
                botToken: "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH",
                chatId: "-1001234567890",
              },
              vapid: null,
              pushWarnings: false,
              digestTime: "08:00",
            },
            now: () => Date.now() + 60_000,
            fetchImpl: async (url, init) => {
              calls.push({
                url,
                body: JSON.parse(String(init.body)) as Record<string, unknown>,
              });
              return Response.json({
                ok: true,
                result: { message_id: 501, chat: { id: -1001234567890 } },
              });
            },
          });
          expect(result.action).toBe("sent");
        } finally {
          await client.end().catch(() => undefined);
        }

        expect(calls).toHaveLength(1);
        expect(calls[0].url.endsWith("/sendMessage")).toBe(true);
        expect(calls[0].body).not.toHaveProperty("parse_mode");
        expect(String(calls[0].body.text)).toContain(incident.title);
      });
    });

    it("responde 202 ignored si no hay nada abierto que cerrar", async () => {
      const response = await route.POST(
        ingestRequest(
          JSON.stringify(envelope({ eventId: "backup-failed:2:resolved", state: "resolved" })),
        ),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        status: "accepted",
        action: "ignored",
      });
      const events = await db
        .select()
        .from(tables.ingestEvents)
        .where(
          and(
            eq(tables.ingestEvents.source, "backup"),
            eq(tables.ingestEvents.eventId, "backup-failed:2:resolved"),
          ),
        );
      expect(events).toHaveLength(1);
      expect(events[0].incidentId).toBeNull();
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
