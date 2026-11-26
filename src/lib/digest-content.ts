import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import { routeHref } from "../components/views/routes";
import * as schema from "./schema";
import { incidents, notificationOutbox } from "./schema";
import { madridDateOf } from "./madrid-day";
import { telegramText } from "./telegram";

/**
 * Daily digest snapshot composition.
 *
 * The content is frozen inside the transaction that prepares the row: retries
 * reuse those exact bytes instead of rendering a moving picture of the hub.
 * Only configured hosts contribute, and the digest never writes a delivery
 * result on an episode: the aggregate is its own authority.
 */

/** Detailed lines shown before the omitted counter takes over. */
export const DIGEST_ENTRY_LIMIT = 12;
/** Awaits 04-02 sections; keeps the first cut bounded and readable. */
const TITLE_LIMIT = 120;

export type DigestSnapshot = {
  /** Plain text ready for the Telegram client; never empty. */
  text: string;
  /** Distinct episodes the snapshot accounts for. */
  entries: number;
};

export type DigestSnapshotInput = {
  /** Session of the transaction that prepares the run. */
  client: Client;
  /** Hosts the runtime configuration actually knows. */
  hostIds: readonly string[];
  /** Previous target: start of the period folded by the sections. */
  periodStart: Date;
  /** Current target: exclusive end of that period. */
  periodEnd: Date;
  /** Instant the snapshot was taken. */
  snapshotAt: Date;
  /** Absolute, token-free URL to Avisos already validated by the caller. */
  alertsUrl: string;
};

type DigestCandidate = {
  id: number;
  hostId: string;
  title: string;
  severity: string;
};

/** One visible row: no newline can impersonate another episode. */
function singleLine(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

function entryLine(row: DigestCandidate): string {
  return `· ${row.hostId} · ${row.severity} · ${singleLine(row.title, TITLE_LIMIT)}`;
}

/**
 * Episodes whose durable disposition is the digest: an opening notice recorded
 * as `kind=incident-open`, `channel=digest`, `status=suppressed` and
 * `reason=digest_pending`. A resolved, legacy or silently suppressed episode is
 * never listed.
 */
async function digestCandidates(
  client: Client,
  hostIds: readonly string[],
  limit: number,
): Promise<DigestCandidate[]> {
  const db = drizzle(client, { schema });
  return db
    .select({
      id: incidents.id,
      hostId: incidents.hostId,
      title: incidents.title,
      severity: incidents.severity,
    })
    .from(incidents)
    .innerJoin(
      notificationOutbox,
      eq(notificationOutbox.incidentId, incidents.id),
    )
    .where(
      and(
        inArray(incidents.hostId, [...hostIds]),
        isNull(incidents.resolvedAt),
        eq(notificationOutbox.kind, "incident-open"),
        eq(notificationOutbox.channel, "digest"),
        eq(notificationOutbox.status, "suppressed"),
        sql`${notificationOutbox.result}->>'reason' = 'digest_pending'`,
      ),
    )
    .orderBy(asc(incidents.at), asc(incidents.id))
    .limit(limit);
}

/**
 * Renders the daily snapshot, or returns null when the cut has no content: an
 * empty digest is a terminal state, never a message.
 */
export async function buildDigestSnapshot(
  input: DigestSnapshotInput,
): Promise<DigestSnapshot | null> {
  if (input.hostIds.length === 0) return null;
  const rows = await digestCandidates(
    input.client,
    input.hostIds,
    DIGEST_ENTRY_LIMIT + 1,
  );
  if (rows.length === 0) return null;

  const visible = rows.slice(0, DIGEST_ENTRY_LIMIT);
  const omitted = rows.length - visible.length;
  const lines = [
    `Resumen diario · ${madridDateOf(input.snapshotAt)}`,
    "",
    `Abiertas ahora (${rows.length}${omitted ? "+" : ""})`,
    ...visible.map(entryLine),
  ];
  if (omitted) lines.push(`… y ${omitted} más`);
  lines.push("", input.alertsUrl);
  return { text: telegramText(lines.join("\n")), entries: rows.length };
}

/**
 * Absolute link to Avisos derived from the canonical origin the runtime already
 * validated. It carries no token: the browser still needs a session.
 */
export function digestAlertsUrl(betterAuthUrl: string): string {
  let base: URL;
  try {
    base = new URL(betterAuthUrl);
  } catch {
    throw new Error("BETTER_AUTH_URL no es una URL válida");
  }
  if (base.username || base.password || base.search || base.hash)
    throw new Error("BETTER_AUTH_URL no puede llevar credenciales ni consulta");
  if (base.protocol !== "https:" && base.protocol !== "http:")
    throw new Error("BETTER_AUTH_URL debe usar HTTP o HTTPS");
  return new URL(
    routeHref({ view: "alerts", tab: "status" }),
    base.origin,
  ).toString();
}
