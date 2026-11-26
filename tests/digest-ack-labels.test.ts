import { Client } from "pg";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { madridClock } from "@/lib/madrid-day";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

/**
 * The daily digest keeps listing an episode the operator acknowledged or
 * silenced, with a label and without moving any counter (D-01, D-04). The
 * Madrid deadline is asserted as the value the clock computes, never as a
 * phrase, so copy changes cannot break the test.
 */

const baseUrl = testDatabaseUrl();
const HOST = "nas-home";
const DAY_START = Date.UTC(2026, 10, 26, 0, 0, 0);
const DAY_END = DAY_START + 86_400_000;
const SNAPSHOT_AT = DAY_END + 60_000;
const ALERTS_URL = "https://hub.example.com/?view=alerts&tab=status";

/** The explicit line of one episode, found by its title, or null. */
function lineOf(text: string, title: string): string | null {
  return text.split("\n").find((line) => line.startsWith("· ") && line.includes(title)) ?? null;
}

/** The aggregated host rows: `· NAS-HOME · 3 anteriores`. */
function aggregateLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => / · \d+ anteriore?s?$/.test(line));
}

describe.skipIf(!baseUrl)("digest acknowledgement labels", () => {
  let context: TestDatabase;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let store: typeof import("@/lib/incident-store");
  let content: typeof import("@/lib/digest-content");
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
    content = await import("@/lib/digest-content");
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
  });

  beforeEach(async () => {
    for (const client of openClients) await client.end().catch(() => {});
    openClients.clear();
    await db.delete(tables.notificationOutbox);
    await db.delete(tables.incidentEvents);
    await db.delete(tables.incidentSnoozes);
    await db.delete(tables.incidents);
  });

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: context.url });
    await client.connect();
    openClients.add(client);
    return client;
  }

  async function snapshot(snapshotAt = SNAPSHOT_AT) {
    const client = await connect();
    try {
      return await content.buildDigestSnapshot({
        client,
        hostIds: [HOST],
        hostNames: { [HOST]: "NAS-HOME" },
        date: "2026-11-26",
        periodStart: new Date(DAY_START),
        periodEnd: new Date(DAY_END),
        snapshotAt: new Date(snapshotAt),
        alertsUrl: ALERTS_URL,
      });
    } finally {
      openClients.delete(client);
      await client.end();
    }
  }

  /** One episode whose durable opening was the digest. */
  async function digestEpisode(
    key: string,
    options: { at?: number; title?: string; severity?: string } = {},
  ) {
    const at = new Date(options.at ?? DAY_START + 3_600_000);
    const title = options.title ?? key;
    const severity = options.severity ?? "warning";
    const [row] = await db
      .insert(tables.incidents)
      .values({
        hostId: HOST,
        key,
        title,
        detail: "",
        severity,
        at,
        fingerprint: store.incidentFingerprint(HOST, key),
        seq: 1,
        origin: "live",
      })
      .returning();
    await db.insert(tables.notificationOutbox).values({
      key: `incident:${row.id}:open`,
      incidentId: row.id,
      kind: "incident-open",
      channel: "digest",
      status: "suppressed",
      revision: 1,
      result: {
        state: "suppressed",
        reason: "digest_pending",
        at: at.toISOString(),
      },
    });
    await db.insert(tables.incidentEvents).values({
      incidentId: row.id,
      seq: 1,
      kind: "opened",
      severity,
      title,
      detail: "",
      at,
    });
    return row.id;
  }

  async function silence(key: string, until: number, setAt = SNAPSHOT_AT) {
    await db.insert(tables.incidentSnoozes).values({
      hostId: HOST,
      key,
      until: new Date(until),
      setAt: new Date(setAt),
      setVia: "hub",
      setBy: "Test",
    });
  }

  it("labels an acknowledged digest episode without moving the counters", async () => {
    const incidentId = await digestEpisode("condition:disk");
    const before = await snapshot();
    expect(before).not.toBeNull();
    const original = lineOf(before!.text, "condition:disk");
    expect(original).not.toBeNull();

    await db
      .update(tables.incidents)
      .set({
        acknowledgedAt: new Date(DAY_START + 7_200_000),
        acknowledgedVia: "hub",
        acknowledgedBy: "Test",
      })
      .where(eq(tables.incidents.id, incidentId));

    const after = await snapshot();
    expect(after).not.toBeNull();
    expect(after!.counts).toEqual(before!.counts);
    expect(after!.listed).toEqual(before!.listed);
    expect(after!.listed).toContain(incidentId);
    expect(lineOf(after!.text, "condition:disk")).not.toBe(original);
  });

  it("writes the Madrid deadline of a live silence as a computed value", async () => {
    await digestEpisode("condition:disk");
    const until = SNAPSHOT_AT + 3_600_000;
    await silence("condition:disk", until);

    const built = await snapshot();
    expect(built).not.toBeNull();
    expect(lineOf(built!.text, "condition:disk")).toContain(
      madridClock(until),
    );
  });

  it("leaves an expired silence unlabelled", async () => {
    await digestEpisode("condition:disk");
    const plain = await snapshot();
    expect(plain).not.toBeNull();

    await silence("condition:disk", SNAPSHOT_AT - 1_000);
    const expired = await snapshot();
    expect(expired).not.toBeNull();
    expect(lineOf(expired!.text, "condition:disk")).toBe(
      lineOf(plain!.text, "condition:disk"),
    );
  });

  it("lists an opening withheld by a silence in the open cohort", async () => {
    const until = SNAPSHOT_AT + 3_600_000;
    await silence("condition:silenced", until, SNAPSHOT_AT - 60_000);
    const opened = await store.recordIncidentObservation({
      hostId: HOST,
      key: "condition:silenced",
      failing: true,
      severity: "warning",
      title: "Condición silenciada",
      detail: "",
      now: DAY_START + 7_200_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });
    expect(opened.delivery).toBe("none");

    const built = await snapshot();
    expect(built).not.toBeNull();
    expect(built!.counts.openNow).toBe(1);
    expect(built!.listed).toContain(opened.incidentId);
    expect(lineOf(built!.text, "Condición silenciada")).toContain(
      madridClock(until),
    );
  });

  it("counts a digest episode escalated to critical while silenced", async () => {
    const incidentId = await digestEpisode("condition:disk");
    await silence("condition:disk", SNAPSHOT_AT + 3_600_000);
    const before = await snapshot();
    expect(before).not.toBeNull();
    expect(before!.counts.critical).toBe(0);

    await store.recordIncidentObservation({
      hostId: HOST,
      key: "condition:disk",
      failing: true,
      severity: "critical",
      title: "condition:disk",
      detail: "",
      now: DAY_START + 3 * 3_600_000,
      delivery: { channel: "telegram", reason: "policy_immediate" },
    });

    const after = await snapshot();
    expect(after).not.toBeNull();
    expect(after!.counts.critical).toBe(before!.counts.critical + 1);
    expect(after!.counts.openNow).toBe(before!.counts.openNow);
    expect(after!.listed).toContain(incidentId);
  });

  it("keeps the aggregated rows of older episodes unchanged", async () => {
    await digestEpisode("condition:old", { at: DAY_START - 86_400_000 });
    const before = await snapshot();
    expect(before).not.toBeNull();
    expect(aggregateLines(before!.text)).toHaveLength(1);

    await digestEpisode("condition:new");
    const after = await snapshot();
    expect(after).not.toBeNull();
    expect(after!.counts.openNow).toBe(before!.counts.openNow + 1);
    expect(aggregateLines(after!.text)).toEqual(aggregateLines(before!.text));
  });

  it("keeps the footer and the link with forty labelled lines", async () => {
    for (let index = 0; index < 40; index += 1) {
      const key = `condition:long-${index}`;
      const incidentId = await digestEpisode(key, {
        title: `${"detalle ".repeat(20)}${index}`,
        at: DAY_START + 60_000 + index * 60_000,
      });
      await db
        .update(tables.incidents)
        .set({
          acknowledgedAt: new Date(DAY_START + 7_200_000),
          acknowledgedVia: "telegram",
        })
        .where(eq(tables.incidents.id, incidentId));
      await silence(key, SNAPSHOT_AT + 3_600_000);
    }

    const built = await snapshot();
    expect(built).not.toBeNull();
    expect(built!.text.length).toBeLessThanOrEqual(4096);
    expect(built!.text.endsWith(ALERTS_URL)).toBe(true);
    expect(built!.counts.openNow).toBe(40);
  });
});
