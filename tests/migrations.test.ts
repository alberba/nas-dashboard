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
    const last = entries.at(-1)!;
    expect(last.tag).toBe("0004_incidents");
    expect(last.when).toBeGreaterThan(entries.at(-2)!.when);

    const current = snapshot("0004_incidents");
    expect(current.prevId).toBe(snapshot("0003_multi_host").id);
    expect(current.tables["public.alerts"]).toBeUndefined();
    expect(current.tables["public.incidents"]).toBeDefined();

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
