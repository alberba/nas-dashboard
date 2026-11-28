import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)("incident store", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");

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
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
  });

  beforeEach(async () => {
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidents);
  });

  async function observation(
    input: Parameters<typeof store.recordIncidentObservation>[0],
  ) {
    return store.recordIncidentObservation(input);
  }

  it("opens once, closes once and keeps the fingerprint across episodes", async () => {
    const start = Date.UTC(2026, 10, 20, 10);
    const first = await observation({
      hostId: "nas-home",
      key: "connection",
      failing: true,
      severity: "critical",
      title: "NAS sin respuesta",
      detail: "Sin métricas",
      now: start,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(first).toMatchObject({
      action: "opened",
      seq: 1,
      delivery: "queued",
    });

    const repeated = await observation({
      hostId: "nas-home",
      key: "connection",
      failing: true,
      severity: "critical",
      title: "NAS sin respuesta",
      detail: "Sin métricas",
      now: start + 1_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(repeated).toMatchObject({
      action: "observed",
      seq: 1,
      delivery: "none",
    });

    let [incident] = await db.select().from(tables.incidents);
    expect(incident).toMatchObject({
      hostId: "nas-home",
      key: "connection",
      severity: "critical",
      seq: 1,
      origin: "live",
    });
    expect(incident.resolvedAt).toBeNull();
    expect(await db.select().from(tables.incidentEvents)).toHaveLength(1);
    let outbox = await db.select().from(tables.notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      key: `incident:${incident.id}:open`,
      incidentId: incident.id,
      kind: "incident-open",
      channel: "telegram",
      status: "pending",
      revision: 1,
    });

    const closed = await observation({
      hostId: "nas-home",
      key: "connection",
      failing: false,
      now: start + 2_000,
      closedBy: "collector",
    });
    expect(closed).toMatchObject({ action: "resolved", seq: 2, delivery: "none" });
    [incident] = await db.select().from(tables.incidents);
    expect(incident.resolvedAt).not.toBeNull();
    expect(incident.seq).toBe(2);
    expect(incident.closedBy).toBe("collector");
    const events = await db.select().from(tables.incidentEvents);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.seq === 2)).toMatchObject({
      kind: "closed",
      incidentId: incident.id,
    });
    outbox = await db.select().from(tables.notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      status: "suppressed",
      result: expect.objectContaining({ reason: "resolved_before_send" }),
    });

    const reopened = await observation({
      hostId: "nas-home",
      key: "connection",
      failing: true,
      severity: "critical",
      title: "NAS sin respuesta",
      detail: "Sin métricas",
      now: start + 3_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(reopened.action).toBe("opened");
    expect(reopened.incidentId).not.toBe(first.incidentId);
    const rows = await db.select().from(tables.incidents);
    expect(rows).toHaveLength(2);
    expect(rows[1].fingerprint).toBe(rows[0].fingerprint);
    expect(rows[1].resolvedAt).toBeNull();
    outbox = await db.select().from(tables.notificationOutbox);
    expect(outbox).toHaveLength(2);
    expect(outbox.find((row) => row.incidentId === reopened.incidentId)).toMatchObject({
      status: "pending",
      channel: "telegram",
    });
  });

  describe("recovery evidence", () => {
    const opened = Date.UTC(2026, 10, 22, 10);

    async function open(origin?: "live" | "ingest") {
      return observation({
        hostId: "nas-home",
        key: "backup-failed",
        failing: true,
        severity: "critical",
        title: "Copia fallida",
        detail: "",
        now: opened,
        delivery: { channel: "telegram", reason: "policy_immediate" },
        ...(origin ? { origin } : {}),
      });
    }

    const recover = (evidenceAt: number | undefined, now = opened + 60_000) =>
      observation({
        hostId: "nas-home",
        key: "backup-failed",
        failing: false,
        now,
        closedBy: "collector",
        ...(evidenceAt === undefined ? {} : { evidenceAt }),
      });

    async function snapshot() {
      return {
        incidents: await db.select().from(tables.incidents),
        events: await db.select().from(tables.incidentEvents),
        outbox: await db.select().from(tables.notificationOutbox),
      };
    }

    it("stores the origin the caller asks for and defaults to live", async () => {
      await open("ingest");
      expect((await snapshot()).incidents[0].origin).toBe("ingest");
      await recover(undefined);
      await open();
      const rows = (await snapshot()).incidents;
      expect(rows.map((row) => row.origin).sort()).toEqual(["ingest", "live"]);
    });

    it("ignores a recovery whose evidence predates an ingest episode", async () => {
      await open("ingest");
      const before = await snapshot();

      const result = await recover(opened - 1);

      expect(result).toEqual({ action: "ignored", delivery: "none" });
      const after = await snapshot();
      expect(after.incidents[0].resolvedAt).toBeNull();
      expect(after.events).toHaveLength(before.events.length);
      expect(after.outbox).toHaveLength(before.outbox.length);
    });

    it("closes an ingest episode when the evidence is as new or newer", async () => {
      await open("ingest");
      expect(await recover(opened)).toMatchObject({ action: "resolved" });
      expect((await snapshot()).incidents[0].resolvedAt).not.toBeNull();

      await open("ingest");
      expect(await recover(opened + 30_000, opened + 90_000)).toMatchObject({
        action: "resolved",
      });
    });

    it("does not hold a live episode back, whatever the evidence", async () => {
      await open("live");
      expect(await recover(opened - 1)).toMatchObject({ action: "resolved" });
      expect((await snapshot()).incidents[0].resolvedAt).not.toBeNull();
    });
  });

  it("confirms a single opening when several observations race", async () => {
    const start = Date.UTC(2026, 10, 21, 10);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        observation({
          hostId: "nas-home",
          key: "cpu",
          failing: true,
          severity: "warning",
          title: "CPU elevada",
          detail: "Uso sostenido",
          now: start + index,
          delivery: { channel: "digest", reason: "digest_pending" },
        }),
      ),
    );
    expect(results.filter((result) => result.action === "opened")).toHaveLength(
      1,
    );
    const incidents = await db.select().from(tables.incidents);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].seq).toBe(1);
    const events = await db.select().from(tables.incidentEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "opened", seq: 1 });
    const outbox = await db.select().from(tables.notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      status: "suppressed",
      result: expect.objectContaining({ reason: "digest_pending" }),
    });
  });

  it("rolls back the episode and its event when the outbox cannot be written", async () => {
    const sequence = await pool.query<{ id: number }>(
      "SELECT nextval(pg_get_serial_sequence('incidents','id'))::int AS id",
    );
    const target = Number(sequence.rows[0].id) + 1;
    const key = `incident:${target}:open`;
    await db.insert(tables.notificationOutbox).values({
      key,
      kind: "incident-open",
      channel: "telegram",
      status: "pending",
    });

    await expect(
      observation({
        hostId: "nas-home",
        key: "atomic-probe",
        failing: true,
        severity: "critical",
        title: "Probe",
        detail: "",
        now: Date.UTC(2026, 10, 22, 10),
        delivery: { channel: "telegram", reason: "policy_immediate" },
      }),
    ).rejects.toThrow();

    expect(
      await db
        .select()
        .from(tables.incidents)
        .where(eq(tables.incidents.key, "atomic-probe")),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(tables.incidentEvents)
        .where(eq(tables.incidentEvents.incidentId, target)),
    ).toEqual([]);

    await db
      .delete(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.key, key));
    const opened = await observation({
      hostId: "nas-home",
      key: "atomic-probe",
      failing: true,
      severity: "critical",
      title: "Probe",
      detail: "",
      now: Date.UTC(2026, 10, 22, 10),
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened).toMatchObject({
      action: "opened",
      incidentId: target + 1,
      delivery: "queued",
    });
  });

  it("keeps legacy open episodes silent through revalidation, escalation and closure", async () => {
    const start = Date.UTC(2026, 10, 23, 10);
    const [legacy] = await db
      .insert(tables.incidents)
      .values({
        hostId: "apps",
        key: "backup-failed",
        title: "Copia fallida legada",
        detail: "",
        severity: "warning",
        at: new Date(start - 86_400_000),
        fingerprint: store.incidentFingerprint("apps", "backup-failed"),
        seq: 0,
        origin: "legacy",
      })
      .returning();

    const observed = await observation({
      hostId: "apps",
      key: "backup-failed",
      failing: true,
      severity: "warning",
      title: "Copia fallida legada",
      detail: "",
      now: start,
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    expect(observed).toMatchObject({ action: "observed", seq: 0 });
    expect(
      await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, legacy.id)),
    ).toEqual([]);

    const escalated = await observation({
      hostId: "apps",
      key: "backup-failed",
      failing: true,
      severity: "critical",
      title: "Copia fallida legada",
      detail: "",
      now: start + 1_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(escalated).toMatchObject({ action: "escalated", seq: 1, delivery: "none" });
    expect(
      await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, legacy.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(tables.incidentEvents)
        .where(eq(tables.incidentEvents.incidentId, legacy.id)),
    ).toHaveLength(1);

    const closed = await observation({
      hostId: "apps",
      key: "backup-failed",
      failing: false,
      now: start + 2_000,
      closedBy: "collector",
    });
    expect(closed).toMatchObject({ action: "resolved", seq: 2, delivery: "none" });
    expect(
      await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, legacy.id)),
    ).toEqual([]);

    const fresh = await observation({
      hostId: "apps",
      key: "backup-failed",
      failing: true,
      severity: "critical",
      title: "Copia fallida nueva",
      detail: "",
      now: start + 3_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(fresh.action).toBe("opened");
    const [newIncident] = await db
      .select()
      .from(tables.incidents)
      .where(and(eq(tables.incidents.id, fresh.incidentId!), eq(tables.incidents.origin, "live")));
    expect(newIncident.fingerprint).toBe(legacy.fingerprint);
    expect(
      await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, newIncident.id)),
    ).toHaveLength(1);
  });

  it("follows severity changes and edits a confirmed Telegram message by seq", async () => {
    const start = Date.UTC(2026, 10, 24, 10);
    const opened = await observation({
      hostId: "nas-home",
      key: "disk-health",
      failing: true,
      severity: "warning",
      title: "Disco a vigilar",
      detail: "sda: watch",
      now: start,
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    const incidentId = opened.incidentId!;
    let outbox = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.incidentId, incidentId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: "suppressed", channel: "digest" });

    const escalated = await observation({
      hostId: "nas-home",
      key: "disk-health",
      failing: true,
      severity: "critical",
      title: "Disco con fallo",
      detail: "sda: fail",
      now: start + 1_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(escalated).toMatchObject({ action: "escalated", seq: 2, delivery: "queued" });
    outbox = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.incidentId, incidentId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      status: "pending",
      channel: "telegram",
      revision: 2,
      result: null,
    });

    const stable = await observation({
      hostId: "nas-home",
      key: "disk-health",
      failing: true,
      severity: "critical",
      title: "Disco con fallo",
      detail: "sda: fail",
      now: start + 2_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(stable).toMatchObject({ action: "observed", seq: 2, delivery: "none" });
    expect(
      await db
        .select()
        .from(tables.incidentEvents)
        .where(eq(tables.incidentEvents.incidentId, incidentId)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.incidentId, incidentId)),
    ).toHaveLength(1);

    await db
      .update(tables.notificationOutbox)
      .set({
        status: "sent",
        chatId: "42",
        messageId: "7",
        attempts: 1,
        result: { state: "sent", reason: null, at: new Date(start).toISOString() },
      })
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-open"),
        ),
      );

    const downgraded = await observation({
      hostId: "nas-home",
      key: "disk-health",
      failing: true,
      severity: "warning",
      title: "Disco a vigilar",
      detail: "sda: watch",
      now: start + 3_000,
      delivery: { channel: "digest", reason: "digest_pending" },
    });
    expect(downgraded).toMatchObject({ action: "escalated", seq: 3, delivery: "queued" });
    const firstEdit = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:edit:3`));
    expect(firstEdit).toHaveLength(1);
    expect(firstEdit[0]).toMatchObject({
      kind: "incident-edit",
      channel: "telegram",
      status: "pending",
      revision: 3,
      chatId: "42",
      messageId: "7",
    });

    const closed = await observation({
      hostId: "nas-home",
      key: "disk-health",
      failing: false,
      now: start + 4_000,
      closedBy: "collector",
    });
    expect(closed).toMatchObject({ action: "resolved", seq: 4, delivery: "queued" });
    expect(
      await db
        .select()
        .from(tables.notificationOutbox)
        .where(eq(tables.notificationOutbox.key, `incident:${incidentId}:edit:4`)),
    ).toHaveLength(1);
    const rows = await db
      .select()
      .from(tables.notificationOutbox)
      .where(eq(tables.notificationOutbox.incidentId, incidentId));
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.kind === "incident-open")!.status).toBe("sent");
  });

  it("projects a queued retry as pending even when its last attempt failed", async () => {
    const start = Date.UTC(2026, 10, 25, 10);
    const opened = await observation({
      hostId: "nas-home",
      key: "rate-limited",
      failing: true,
      severity: "warning",
      title: "Aviso en espera",
      detail: "",
      now: start,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    const incidentId = opened.incidentId!;
    await db
      .update(tables.notificationOutbox)
      .set({
        status: "pending",
        result: {
          state: "failed",
          reason: "rate_limited",
          at: new Date(start + 1_000).toISOString(),
        },
      })
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-open"),
        ),
      );

    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    const [alert] = await store.projectIncidents([incident]);
    expect(alert.delivery).toEqual({
      channel: "telegram",
      state: "pending",
      reason: null,
    });
  });

  it("projects a disabled push channel with its own finite reason", async () => {
    const start = Date.UTC(2026, 10, 25, 11);
    const opened = await observation({
      hostId: "nas-home",
      key: "push-disabled",
      failing: true,
      severity: "critical",
      title: "Aviso sin push",
      detail: "",
      now: start,
      delivery: { channel: "push", reason: "policy_immediate" },
    });
    const incidentId = opened.incidentId!;
    await db
      .update(tables.notificationOutbox)
      .set({
        status: "suppressed",
        result: {
          state: "suppressed",
          reason: "push_disabled",
          at: new Date(start + 1_000).toISOString(),
        },
      })
      .where(
        and(
          eq(tables.notificationOutbox.incidentId, incidentId),
          eq(tables.notificationOutbox.kind, "incident-open"),
        ),
      );

    const [incident] = await db
      .select()
      .from(tables.incidents)
      .where(eq(tables.incidents.id, incidentId));
    const [alert] = await store.projectIncidents([incident]);
    expect(alert.delivery).toEqual({
      channel: "push",
      state: "suppressed",
      reason: "push_disabled",
    });
  });
});
