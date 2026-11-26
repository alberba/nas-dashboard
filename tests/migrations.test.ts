import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/schema";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

const baseUrl = testDatabaseUrl();

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

type SnapshotTable = {
  name: string;
  columns: Record<string, { name: string; type: string; notNull: boolean }>;
  indexes: Record<string, { name: string; columns: unknown[]; isUnique: boolean }>;
};

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, SnapshotTable>;
};

function journal(): Journal {
  return JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
}

function snapshot(tag: string): Snapshot {
  const prefix = tag.split("_")[0];
  return JSON.parse(
    readFileSync(`drizzle/meta/${prefix}_snapshot.json`, "utf8"),
  );
}

async function apply(client: Client, file: string) {
  const sql = readFileSync(`drizzle/${file}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}

/**
 * Runs the real Drizzle migrator against a journal truncated at `lastIdx`,
 * which is how the lane reaches 0003 before seeding historical rows.
 */
async function migrateThrough(client: Client, lastIdx: number) {
  const full = journal();
  const entries = full.entries.filter((entry) => entry.idx <= lastIdx);
  const folder = mkdtempSync(join(process.cwd(), ".tmp-migrations-"));
  try {
    mkdirSync(join(folder, "meta"), { recursive: true });
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ ...full, entries }),
    );
    for (const entry of entries)
      writeFileSync(
        join(folder, `${entry.tag}.sql`),
        readFileSync(`drizzle/${entry.tag}.sql`),
      );
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function migrateAll(client: Client) {
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
}

async function liveColumns(client: Client, table: string) {
  const { rows } = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows;
}

async function liveIndexes(client: Client, table: string) {
  const { rows } = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
    [table],
  );
  return rows.map((row) => row.indexname);
}

describe.skipIf(!baseUrl)("multi-host migration", () => {
  let context: TestDatabase;
  beforeAll(async () => {
    context = await createTestDatabase(baseUrl!);
  });
  afterAll(async () => {
    await dropTestDatabase(context);
  });

  it("assigns existing samples, alerts, operations and settings to the NAS", async () => {
    const migrations = readdirSync("drizzle")
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const target = "0003_multi_host.sql";
    const targetIndex = migrations.indexOf(target);
    expect(targetIndex).toBeGreaterThan(0);
    const client = new Client({ connectionString: context.url });
    await client.connect();
    try {
      for (const file of migrations.slice(0, targetIndex)) await apply(client, file);
      await client.query(`
        INSERT INTO samples ("at", data) VALUES (now(), '{"timestamp":1}'::jsonb);
        INSERT INTO alerts ("key", title, detail, severity)
          VALUES ('connection', 'El NAS no responde', 'Sin métricas', 'critical');
        INSERT INTO operations (id, "userId", action, target, status)
          VALUES ('legacy-operation', 'legacy-user', 'reboot', 'NAS', 'success');
        INSERT INTO configuration (id, value) VALUES ('settings', '{"cpu":90}'::jsonb);
      `);

      await apply(client, target);

      for (const table of ["samples", "alerts", "operations"]) {
        const { rows } = await client.query(
          `SELECT DISTINCT "hostId" FROM ${table}`,
        );
        expect(rows.map((row) => row.hostId)).toEqual(["nas-home"]);
      }
      const settings = await client.query(
        'SELECT "hostId", id FROM configuration',
      );
      expect(settings.rows).toEqual([{ hostId: "nas-home", id: "settings" }]);

      await client.query(
        `INSERT INTO configuration ("hostId", id, value) VALUES ('apps', 'settings', '{"cpu":80}'::jsonb)`,
      );
      const hostSettings = await client.query(
        'SELECT "hostId" FROM configuration ORDER BY "hostId"',
      );
      expect(hostSettings.rows.map((row) => row.hostId)).toEqual([
        "apps",
        "nas-home",
      ]);
    } finally {
      await client.end();
    }
  });
});

describe.skipIf(!baseUrl)("incidents migration 0004", () => {
  let context: TestDatabase;
  let client: Client;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    context = await createTestDatabase(baseUrl!);
    client = new Client({ connectionString: context.url });
    await client.connect();
    db = drizzle(client, { schema });
    await migrateThrough(client, 3);
  });

  afterAll(async () => {
    await client.end();
    await dropTestDatabase(context);
  });

  it("keeps history, closes duplicates and leaves the legacy backfill silent", async () => {
    const seeds = await client.query<{
      id: number;
      title: string;
      at: Date;
      resolvedAt: Date | null;
      resolvedEpoch: number | null;
    }>(`
      INSERT INTO alerts ("hostId", key, title, detail, severity, at, "resolvedAt") VALUES
        ('nas-home','connection','hist-resolved','', 'critical', now() - interval '10 days', now() - interval '9 days'),
        ('nas-home','backup-failed','dup-older','', 'warning', now() - interval '2 days', NULL),
        ('nas-home','backup-failed','dup-tied-old','', 'warning', now() - interval '1 day', NULL),
        ('nas-home','backup-failed','dup-tied-new','', 'critical', now() - interval '1 day', NULL),
        ('apps','backup-failed','other-host-open','', 'warning', now() - interval '1 day', NULL),
        ('nas-home','cpu','same-pair-closed','', 'warning', now() - interval '5 days', now() - interval '4 days'),
        ('nas-home','cpu','same-pair-open','', 'warning', now() - interval '30 minutes', NULL),
        ('apps','disk-health','apps-disc','', 'warning', now() - interval '90 minutes', NULL)
      RETURNING id, title, at, "resolvedAt",
        extract(epoch from "resolvedAt")::double precision AS "resolvedEpoch"
    `);
    const before = new Map(seeds.rows.map((row) => [row.title, row]));
    const maxIdBefore = Math.max(...seeds.rows.map((row) => row.id));

    await migrateAll(client);

    const rows = await db.select().from(schema.incidents);
    expect(rows).toHaveLength(seeds.rows.length);
    expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      seeds.rows.map((row) => row.id).sort((a, b) => a - b),
    );
    const byTitle = new Map(rows.map((row) => [row.title, row]));

    const historical = byTitle.get("hist-resolved")!;
    expect(historical.resolvedAt!.getTime() / 1000).toBeCloseTo(
      before.get("hist-resolved")!.resolvedEpoch!,
      2,
    );
    expect(historical.closedBy).toBeNull();
    expect(historical.origin).toBe("live");

    const survivor = byTitle.get("dup-tied-new")!;
    expect(survivor.resolvedAt).toBeNull();
    expect(survivor.origin).toBe("legacy");
    expect(survivor.id).toBeGreaterThan(byTitle.get("dup-tied-old")!.id);

    for (const title of ["dup-older", "dup-tied-old"]) {
      const closed = byTitle.get(title)!;
      expect(closed.resolvedAt).not.toBeNull();
      expect(closed.closedBy).toBe("migration-dedup");
      expect(closed.previousResolvedAt).toBeNull();
      expect(closed.origin).toBe("legacy");
    }

    expect(byTitle.get("other-host-open")!.resolvedAt).toBeNull();
    expect(byTitle.get("same-pair-open")!.resolvedAt).toBeNull();
    expect(byTitle.get("apps-disc")!.resolvedAt).toBeNull();

    const closedSamePair = byTitle.get("same-pair-closed")!;
    expect(closedSamePair.resolvedAt!.getTime() / 1000).toBeCloseTo(
      before.get("same-pair-closed")!.resolvedEpoch!,
      2,
    );
    expect(closedSamePair.origin).toBe("live");
    expect(closedSamePair.fingerprint).toBe(
      byTitle.get("same-pair-open")!.fingerprint,
    );
    expect(survivor.fingerprint).toBe(byTitle.get("dup-older")!.fingerprint);
    expect(survivor.fingerprint).not.toBe(
      byTitle.get("other-host-open")!.fingerprint,
    );
    for (const row of rows) {
      expect(row.fingerprint).toMatch(/^[a-f0-9]{32}$/);
      expect(row.seq).toBe(0);
    }

    const openPairs = new Map<string, number>();
    for (const row of rows.filter((row) => row.resolvedAt === null)) {
      const pair = `${row.hostId}\u0000${row.key}`;
      openPairs.set(pair, (openPairs.get(pair) ?? 0) + 1);
    }
    expect([...openPairs.values()].every((count) => count === 1)).toBe(true);

    const dedupEvents = await db.select().from(schema.incidentEvents);
    expect(dedupEvents).toEqual([]);
    const backfillWork = await db.select().from(schema.notificationOutbox);
    expect(backfillWork).toEqual([]);

    const index = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'incidents_open_host_key_idx'",
    );
    expect(index.rows[0].indexdef).toContain("UNIQUE");
    expect(index.rows[0].indexdef).toContain('"resolvedAt" IS NULL');

    const probe = await db
      .insert(schema.incidents)
      .values({
        hostId: "nas-home",
        key: "probe-new",
        title: "probe",
        detail: "",
        severity: "warning",
        fingerprint: "probe",
      })
      .returning();
    expect(probe[0].id).toBeGreaterThan(maxIdBefore);

    await expect(
      db.insert(schema.incidents).values({
        hostId: "nas-home",
        key: "probe-new",
        title: "second open",
        detail: "",
        severity: "warning",
        fingerprint: "probe",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint: "incidents_open_host_key_idx",
      },
    });

    // A resolved row for the same pair never conflicts with the partial index.
    await db.insert(schema.incidents).values({
      hostId: "nas-home",
      key: "probe-new",
      title: "closed episode",
      detail: "",
      severity: "warning",
      fingerprint: "probe",
      resolvedAt: new Date(),
    });

    // The same key stays open on an independent host that had no open row.
    await db.insert(schema.incidents).values({
      hostId: "apps",
      key: "probe-new",
      title: "other host",
      detail: "",
      severity: "warning",
      fingerprint: "probe-apps",
    });

    const applied = await client.query<{ created_at: string }>(
      "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id",
    );
    expect(applied.rows.map((row) => Number(row.created_at))).toEqual(
      journal().entries.map((entry) => entry.when),
    );
  });

  it("keeps SQL, snapshot and journal aligned", async () => {
    const entries = journal().entries;
    const index = entries.findIndex(
      (entry) => entry.tag === "0005_incident_context",
    );
    // The historical migration keeps its own check even after a new advance.
    expect(index).toBeGreaterThan(0);
    expect(entries[index].when).toBeGreaterThan(entries[index - 1].when);

    const current = snapshot("0005_incident_context");
    expect(current.prevId).toBe(snapshot("0004_incidents").id);
    expect(current.tables["public.alerts"]).toBeUndefined();
    expect(current.tables["public.incidents"]).toBeDefined();
    expect(current.tables["public.alerts"]).toBeUndefined();
    expect(snapshot("0004_incidents").tables["public.incidents"]).toBeDefined();

    for (const table of [
      "incidents",
      "incident_events",
      "notification_outbox",
    ] as const) {
      const expected = current.tables[`public.${table}`];
      expect(expected).toBeDefined();
      const columns = await liveColumns(client, table);
      expect(columns.map((column) => column.column_name).sort()).toEqual(
        Object.keys(expected.columns).sort(),
      );
      const nullability = new Map(
        columns.map((column) => [column.column_name, column.is_nullable]),
      );
      for (const column of Object.values(expected.columns)) {
        expect(nullability.get(column.name)).toBe(column.notNull ? "NO" : "YES");
      }
      const expectedIndexes = Object.keys(expected.indexes).sort();
      const primary = table === "incident_events" ? ["incident_events_incidentId_seq_pk"] : [`${table}_pkey`];
      const actualIndexes = (await liveIndexes(client, table))
        .filter((name) => !primary.includes(name) && !name.endsWith("_pkey"))
        .sort();
      expect(actualIndexes).toEqual(expectedIndexes);
    }
  });
});

describe.skipIf(!baseUrl)("incidents migration 0005", () => {
  it("adds the context and observation columns without rewriting history or delivery", async () => {
    const context = await createTestDatabase(baseUrl!);
    const client = new Client({ connectionString: context.url });
    await client.connect();
    try {
      await migrateThrough(client, 4);
      const seeded = await client.query<{
        id: number;
        title: string;
        resolvedEpoch: number | null;
      }>(`
        INSERT INTO incidents ("hostId", key, title, detail, severity, at, "resolvedAt", fingerprint, seq, origin)
        VALUES
          ('nas-home','connection','NAS caído','', 'critical', now() - interval '2 hours', NULL, 'fp-open', 4, 'live'),
          ('apps','connection','Apps caído','', 'critical', now() - interval '90 minutes', NULL, 'fp-pending', 1, 'live'),
          ('nas-home','container:sonarr','Sonarr detenido','', 'warning', now() - interval '3 hours', now() - interval '2 hours', 'fp-closed', 2, 'live')
        RETURNING id, title, extract(epoch from "resolvedAt")::double precision AS "resolvedEpoch"
      `);
      const before = new Map(seeded.rows.map((row) => [row.title, row]));
      const open = before.get("NAS caído")!;
      const pending = before.get("Apps caído")!;
      await client.query(
        `INSERT INTO notification_outbox (key, "incidentId", kind, channel, status, "chatId", "messageId", result)
         VALUES
           ('incident:${open.id}:open', ${open.id}, 'incident-open', 'telegram', 'sent', '42', '9', '{"state":"sent","reason":null,"at":"2026-11-25T00:00:00.000Z"}'::jsonb),
           ('incident:${pending.id}:open', ${pending.id}, 'incident-open', 'telegram', 'pending', NULL, NULL, NULL)`,
      );

      await migrateAll(client);

      const rows = await client.query<{
        id: number;
        title: string;
        resolvedEpoch: number | null;
        fingerprint: string;
        seq: number;
        origin: string;
        context: unknown;
        inhibitedBy: number | null;
        inhibitedReason: string | null;
        observationPending: boolean;
      }>(`
        SELECT id, title, fingerprint, seq, origin, context, "inhibitedBy",
          "inhibitedReason", "observationPending",
          extract(epoch from "resolvedAt")::double precision AS "resolvedEpoch"
        FROM incidents ORDER BY id
      `);
      expect(rows.rows).toHaveLength(3);
      for (const row of rows.rows) {
        const previous = before.get(row.title)!;
        expect(row.id).toBe(previous.id);
        expect(row.resolvedEpoch).toBeCloseTo(previous.resolvedEpoch ?? 0, 2);
        if (previous.resolvedEpoch === null)
          expect(row.resolvedEpoch).toBeNull();
        expect(row.context).toBeNull();
        expect(row.inhibitedBy).toBeNull();
        expect(row.inhibitedReason).toBeNull();
        expect(row.observationPending).toBe(false);
      }
      expect(
        rows.rows.find((row) => row.title === "NAS caído")!.fingerprint,
      ).toBe("fp-open");
      expect(rows.rows.find((row) => row.title === "Apps caído")!.seq).toBe(1);
      expect(
        rows.rows.find((row) => row.title === "Sonarr detenido")!.origin,
      ).toBe("live");

      const outbox = await client.query<{
        key: string;
        status: string;
        chatId: string | null;
        messageId: string | null;
      }>('SELECT key, status, "chatId", "messageId" FROM notification_outbox ORDER BY id');
      expect(outbox.rows).toEqual([
        {
          key: `incident:${open.id}:open`,
          status: "sent",
          chatId: "42",
          messageId: "9",
        },
        {
          key: `incident:${pending.id}:open`,
          status: "pending",
          chatId: null,
          messageId: null,
        },
      ]);

      // The previous binary keeps working: it only knows the old columns and
      // the new ones are nullable or defaulted.
      const legacy = await client.query<{
        id: number;
        context: unknown;
        observationPending: boolean;
      }>(`
        INSERT INTO incidents ("hostId", key, title, detail, severity, fingerprint, seq, origin)
        VALUES ('nas-home','cpu','CPU alta','', 'warning','fp-legacy-insert',1,'live')
        RETURNING id, context, "observationPending"
      `);
      expect(legacy.rows[0].context).toBeNull();
      expect(legacy.rows[0].observationPending).toBe(false);

      const applied = await client.query<{ created_at: string }>(
        "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id",
      );
      expect(applied.rows.map((row) => Number(row.created_at))).toEqual(
        journal().entries.map((entry) => entry.when),
      );
      expect(
        journal().entries.some(
          (entry) => entry.tag === "0005_incident_context",
        ),
      ).toBe(true);
    } finally {
      await client.end();
      await dropTestDatabase(context);
    }
  });
});

describe.skipIf(!baseUrl)("digest migration 0006", () => {
  it("adds the daily queue and the shared pause without rewriting delivery", async () => {
    const context = await createTestDatabase(baseUrl!);
    const client = new Client({ connectionString: context.url });
    await client.connect();
    try {
      await migrateThrough(client, 5);
      const seeded = await client.query<{ id: number; title: string }>(`
        INSERT INTO incidents ("hostId", key, title, detail, severity, at, "resolvedAt", fingerprint, seq, origin)
        VALUES
          ('nas-home','disk','Disco lleno','', 'warning', now() - interval '1 hour', NULL, 'fp-digest', 1, 'live'),
          ('apps','connection','Apps caído','', 'critical', now() - interval '2 hours', now() - interval '1 hour', 'fp-closed', 2, 'live')
        RETURNING id, title
      `);
      const open = seeded.rows.find((row) => row.title === "Disco lleno")!;
      await client.query(
        `INSERT INTO notification_outbox (key, "incidentId", kind, channel, status, result)
         VALUES ($1, $2, 'incident-open', 'digest', 'suppressed',
           '{"state":"suppressed","reason":"digest_pending","at":"2026-11-26T06:00:00.000Z"}'::jsonb)`,
        [`incident:${open.id}:open`, open.id],
      );

      await migrateAll(client);

      // Delivery rows and episodes survive the additive migration untouched.
      const outbox = await client.query<{
        key: string;
        channel: string;
        status: string;
        reason: string;
      }>(
        `SELECT key, channel, status, result->>'reason' AS reason
           FROM notification_outbox ORDER BY id`,
      );
      expect(outbox.rows).toEqual([
        {
          key: `incident:${open.id}:open`,
          channel: "digest",
          status: "suppressed",
          reason: "digest_pending",
        },
      ]);
      const incidents = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM incidents",
      );
      expect(incidents.rows[0].count).toBe(2);

      // One row per Madrid civil date, enforced by the unique index.
      await client.query(
        `INSERT INTO digest_runs ("date", "targetAt", "periodStartAt", "dueAt")
         VALUES ('2026-11-26', now(), now(), now() + interval '2 hours')`,
      );
      await expect(
        client.query(
          `INSERT INTO digest_runs ("date", "targetAt", "periodStartAt", "dueAt")
           VALUES ('2026-11-26', now(), now(), now() + interval '2 hours')`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      const runs = await client.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM digest_runs",
      );
      expect(runs.rows).toEqual([{ status: "prepared", attempts: 0 }]);

      // The pause is a single row: absence means no pause and the upsert
      // extends the known deadline instead of appending a second one.
      await client.query(
        `INSERT INTO telegram_cooldown (channel, "until", reason)
         VALUES ('telegram', now(), 'rate_limited')`,
      );
      await client.query(
        `INSERT INTO telegram_cooldown (channel, "until", reason)
         VALUES ('telegram', now() + interval '1 minute', 'rate_limited')
         ON CONFLICT (channel) DO UPDATE SET "until" = EXCLUDED."until"`,
      );
      const cooldown = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM telegram_cooldown",
      );
      expect(cooldown.rows[0].count).toBe(1);

      // Re-running the real migrator applies nothing twice.
      await migrateAll(client);
      const reapplied = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
      );
      expect(reapplied.rows[0].count).toBe(journal().entries.length);

      const current = snapshot("0006_digest_runs");
      expect(current.prevId).toBe(snapshot("0005_incident_context").id);
      for (const table of ["digest_runs", "telegram_cooldown"] as const) {
        const expected = current.tables[`public.${table}`];
        expect(expected).toBeDefined();
        const columns = await liveColumns(client, table);
        expect(columns.map((column) => column.column_name).sort()).toEqual(
          Object.keys(expected.columns).sort(),
        );
        const nullability = new Map(
          columns.map((column) => [column.column_name, column.is_nullable]),
        );
        for (const column of Object.values(expected.columns)) {
          expect(nullability.get(column.name)).toBe(
            column.notNull ? "NO" : "YES",
          );
        }
        const actualIndexes = (await liveIndexes(client, table))
          .filter((name) => !name.endsWith("_pkey"))
          .sort();
        expect(actualIndexes).toEqual(Object.keys(expected.indexes).sort());
      }
    } finally {
      await client.end();
      await dropTestDatabase(context);
    }
  });
});

describe.skipIf(!baseUrl)("incidents rollback rehearsal", () => {
  async function rehearsal() {
    const context = await createTestDatabase(baseUrl!);
    const client = new Client({ connectionString: context.url });
    await client.connect();
    return { context, client };
  }

  async function runRollback(client: Client) {
    await client.query(
      readFileSync("scripts/rollback/0004_incidents.sql", "utf8"),
    );
  }

  it("rehearses 0003 → 0004 → rollback → 0004 without repeating or losing ids", async () => {
    const { context, client } = await rehearsal();
    try {
      await migrateThrough(client, 3);
      const seeds = await client.query<{
        id: number;
        title: string;
        resolvedEpoch: number | null;
      }>(`
        INSERT INTO alerts ("hostId", key, title, detail, severity, at, "resolvedAt") VALUES
          ('nas-home','connection','hist-resolved','', 'critical', now() - interval '10 days', now() - interval '9 days'),
          ('nas-home','backup-failed','dup-older','', 'warning', now() - interval '2 days', NULL),
          ('nas-home','backup-failed','dup-tied-old','', 'warning', now() - interval '1 day', NULL),
          ('nas-home','backup-failed','dup-tied-new','', 'critical', now() - interval '1 day', NULL),
          ('apps','backup-failed','other-host-open','', 'warning', now() - interval '1 day', NULL)
        RETURNING id, title, extract(epoch from "resolvedAt")::double precision AS "resolvedEpoch"
      `);
      const seedIds = seeds.rows.map((row) => row.id).sort((a, b) => a - b);
      const historical = seeds.rows.find((row) => row.title === "hist-resolved")!;

      await migrateThrough(client, 4);
      const migrated = await client.query<{
        id: number;
        title: string;
        closedBy: string | null;
      }>('SELECT id, title, "closedBy" FROM incidents ORDER BY id');
      expect(migrated.rows.map((row) => row.id)).toEqual(seedIds);
      expect(
        migrated.rows
          .filter((row) => row.closedBy === "migration-dedup")
          .map((row) => row.title)
          .sort(),
      ).toEqual(["dup-older", "dup-tied-old"]);

      const activity = await client.query<{ id: number }>(`
        INSERT INTO incidents ("hostId", key, title, detail, severity, fingerprint, seq, origin)
        VALUES ('apps','connection','post-open','', 'critical','post-open-fp',1,'live')
        RETURNING id
      `);
      const activityId = activity.rows[0].id;
      await client.query(
        `INSERT INTO incident_events ("incidentId", seq, kind, severity, title, detail)
         VALUES ($1, 1, 'opened', 'critical', 'post-open', '')`,
        [activityId],
      );
      await client.query(
        `INSERT INTO notification_outbox (key, "incidentId", kind, channel, status, result)
         VALUES ($1, $2, 'incident-open', 'telegram', 'sent', '{"state":"sent","reason":null,"at":"2026-11-25T00:00:00.000Z"}'::jsonb)`,
        [`incident:${activityId}:open`, activityId],
      );
      const postResolved = await client.query<{ id: number }>(`
        INSERT INTO incidents ("hostId", key, title, detail, severity, fingerprint, seq, origin, "resolvedAt")
        VALUES ('nas-home','memory','post-resolved','', 'warning','post-resolved-fp',2,'live', now() - interval '1 minute')
        RETURNING id
      `);
      const postResolvedId = postResolved.rows[0].id;

      await runRollback(client);

      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('alerts','incidents','incident_events','notification_outbox')
        ORDER BY table_name
      `);
      expect(tables.rows.map((row) => row.table_name)).toEqual(["alerts"]);

      const after = await client.query<{
        id: number;
        title: string;
        resolvedEpoch: number | null;
      }>(`
        SELECT id, title, extract(epoch from "resolvedAt")::double precision AS "resolvedEpoch"
        FROM alerts ORDER BY id
      `);
      expect(after.rows.map((row) => row.id)).toEqual(
        [...seedIds, activityId, postResolvedId].sort((a, b) => a - b),
      );
      const openTitles = after.rows
        .filter((row) => row.resolvedEpoch === null)
        .map((row) => row.title)
        .sort();
      expect(openTitles).toEqual(
        ["dup-older", "dup-tied-new", "dup-tied-old", "other-host-open", "post-open"].sort(),
      );
      expect(
        after.rows.find((row) => row.title === "hist-resolved")!.resolvedEpoch,
      ).toBeCloseTo(historical.resolvedEpoch!, 2);
      expect(
        after.rows.find((row) => row.title === "post-resolved")!.resolvedEpoch,
      ).not.toBeNull();

      const appliedAfterRollback = await client.query<{ created_at: string }>(
        "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id",
      );
      expect(
        appliedAfterRollback.rows.map((row) => Number(row.created_at)),
      ).toEqual(journal().entries.slice(0, 4).map((entry) => entry.when));

      const maxAfterRollback = Math.max(...after.rows.map((row) => row.id));
      const probe = await client.query<{ id: number }>(`
        INSERT INTO alerts ("hostId", key, title, detail, severity)
        VALUES ('apps','rollback-probe','probe','','warning')
        RETURNING id
      `);
      expect(probe.rows[0].id).toBeGreaterThan(maxAfterRollback);

      await migrateThrough(client, 4);
      const reapplied = await client.query<{
        id: number;
        origin: string;
        fingerprint: string;
      }>("SELECT id, origin, fingerprint FROM incidents ORDER BY id");
      expect(reapplied.rows.map((row) => row.id)).toEqual(
        [...after.rows.map((row) => row.id), probe.rows[0].id].sort(
          (a, b) => a - b,
        ),
      );
      const probeRow = reapplied.rows.find(
        (row) => row.id === probe.rows[0].id,
      )!;
      expect(probeRow.origin).toBe("legacy");
      expect(probeRow.fingerprint).toMatch(/^[a-f0-9]{32}$/);

      const duplicateOpens = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM (
          SELECT "hostId", key, count(*) FROM incidents
          WHERE "resolvedAt" IS NULL GROUP BY "hostId", key HAVING count(*) > 1
        ) duplicated
      `);
      expect(duplicateOpens.rows[0].count).toBe("0");

      expect(
        (await client.query("SELECT count(*)::int AS count FROM notification_outbox")).rows[0].count,
      ).toBe(0);
      expect(
        (await client.query("SELECT count(*)::int AS count FROM incident_events")).rows[0].count,
      ).toBe(0);

      const next = await client.query<{ id: number }>(`
        INSERT INTO incidents ("hostId", key, title, detail, severity, fingerprint)
        VALUES ('apps','after-reapply','after','', 'warning','after-fp')
        RETURNING id
      `);
      expect(next.rows[0].id).toBeGreaterThan(probe.rows[0].id);

      const appliedAfterReapply = await client.query<{ created_at: string }>(
        "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id",
      );
      expect(
        appliedAfterReapply.rows.map((row) => Number(row.created_at)),
      ).toEqual(journal().entries.slice(0, 5).map((entry) => entry.when));
    } finally {
      await client.end();
      await dropTestDatabase(context);
    }
  });

  it("refuses a journal where 0004 is not the last applied advance", async () => {
    const { context, client } = await rehearsal();
    try {
      await migrateThrough(client, 3);
      await migrateAll(client);
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('future-migration', 1795591379121)`,
      );

      let message = "";
      try {
        await runRollback(client);
      } catch (error) {
        message = (error as Error).message;
        await client.query("ROLLBACK");
      }
      expect(message).toContain("no es el último avance");

      const incidents = await client.query<{ name: string | null }>(
        "SELECT to_regclass('public.incidents') AS name",
      );
      expect(incidents.rows[0].name).toBe("incidents");
      const alerts = await client.query<{ name: string | null }>(
        "SELECT to_regclass('public.alerts') AS name",
      );
      expect(alerts.rows[0].name).toBeNull();
      const journalRows = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
      );
      expect(journalRows.rows[0].count).toBe(
        String(journal().entries.length + 1),
      );
    } finally {
      await client.end();
      await dropTestDatabase(context);
    }
  });
});
