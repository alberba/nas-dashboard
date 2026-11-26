import type { Client } from "pg";
import { routeHref } from "../components/views/routes";
import { TELEGRAM_TEXT_LIMIT, telegramText } from "./telegram";

/**
 * Daily digest snapshot composition.
 *
 * The content is frozen inside the transaction that prepares the row: retries
 * reuse those exact bytes instead of rendering a moving picture of the hub.
 * One PostgreSQL statement reads the cohorts, the counters and the bounded
 * detail rows, so every part of the message describes the same instant. Only
 * configured hosts contribute, the durable opening disposition decides what is
 * listed and the aggregate never writes a delivery result on an episode.
 */

/** Detail rows materialised before the rest is folded into `+N`. */
export const DIGEST_DETAIL_LIMIT = 40;
/** Conservative ceiling for the identifying fields of one line. */
const HOST_LIMIT = 40;
const TITLE_LIMIT = 120;
const SEVERITY_LIMIT = 16;

export type DigestCounts = {
  /** Digest episodes open at the snapshot instant. */
  openNow: number;
  /** New episodes of the period with a visible disposition. */
  newInPeriod: number;
  /** New episodes that are still open at the snapshot instant. */
  newOpen: number;
  /** New episodes that were already closed at the snapshot instant. */
  newClosed: number;
  /** Distinct episodes with an opening or escalada crítica in the period. */
  critical: number;
  /** Episodes of the period closed with a digest or individual disposition. */
  resolved: number;
};

export type DigestDetail = {
  id: number;
  hostId: string;
  title: string;
  severity: string;
  /** Instant used only for a stable order; already bounded by the query. */
  at: number;
};

export type DigestAggregate = {
  hostId: string;
  count: number;
};

export type DigestSnapshot = {
  /** Plain text ready for the Telegram client; never empty. */
  text: string;
  /** Distinct episodes represented by an explicit or aggregated line. */
  entries: number;
  /** Distinct episodes without a line; the `+N` figure. */
  omitted: number;
  /** Episodes with an explicit line, in message order. */
  listed: number[];
  /** Exact totals the sections and the footer describe. */
  counts: DigestCounts;
};

export type DigestSnapshotInput = {
  /** Session of the transaction that prepares the run. */
  client: Client;
  /** Hosts the runtime configuration actually knows. */
  hostIds: readonly string[];
  /** Optional display names by configured host id. */
  hostNames?: Readonly<Record<string, string>>;
  /**
   * Civil date the run belongs to, `YYYY-MM-DD`. It names the title, so a
   * delivery that lands after midnight still labels its own day instead of the
   * next one: the recovery window exists precisely for that crossing.
   */
  date: string;
  /** Previous target: start of the period folded by the sections. */
  periodStart: Date;
  /** Current target: exclusive end of that period. */
  periodEnd: Date;
  /** Instant the snapshot was taken. */
  snapshotAt: Date;
  /** Absolute, token-free URL to Avisos already validated by the caller. */
  alertsUrl: string;
};

export type DigestRenderInput = {
  /** Civil date shown in the title, `YYYY-MM-DD`. */
  date: string;
  counts: DigestCounts;
  details: readonly DigestDetail[];
  aggregates: readonly DigestAggregate[];
  hostNames?: Readonly<Record<string, string>>;
  alertsUrl: string;
  /** UTF-16 ceiling; the provider limit unless a test exercises a narrow one. */
  limit?: number;
};

export type DigestRendered = {
  text: string;
  entries: number;
  omitted: number;
  listed: number[];
};

/**
 * Control, line-separator and bidi characters could impersonate another row.
 * The zero-width joiner stays so emoji sequences remain intact.
 */
const UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\u200c\u200e\u200f\u2060-\u2069\ufeff]/g;

/** Collapses everything that could forge a line into one printable phrase. */
function clean(value: string): string {
  return value.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

/** Clips at a code point boundary so a surrogate pair is never split. */
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let out = "";
  for (const character of value) {
    // One unit stays free for the ellipsis.
    if (out.length + character.length > limit - 1) break;
    out += character;
  }
  return `${out}…`;
}

function field(value: string, limit: number): string {
  return clip(clean(value), limit);
}

function hostLabel(
  hostId: string,
  names?: Readonly<Record<string, string>>,
): string {
  const name = names?.[hostId];
  return field(name && name.trim() ? name : hostId, HOST_LIMIT);
}

function detailLine(detail: DigestDetail, names?: Readonly<Record<string, string>>): string {
  return `· ${hostLabel(detail.hostId, names)} · ${field(detail.severity, SEVERITY_LIMIT)} · ${field(detail.title, TITLE_LIMIT)}`;
}

function aggregateLine(
  aggregate: DigestAggregate,
  names?: Readonly<Record<string, string>>,
): string {
  const noun = aggregate.count === 1 ? "anterior" : "anteriores";
  return `· ${hostLabel(aggregate.hostId, names)} · ${aggregate.count} ${noun}`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Counter line of the footer: observed activity, never a delivery claim. */
export function digestCountersLine(counts: DigestCounts): string {
  return `Actividad observada · ${plural(counts.critical, "crítica", "críticas")} · ${plural(counts.resolved, "resuelta", "resueltas")}`;
}

/** New-episodes line; null when the period observed no visible episode. */
export function digestNewLine(counts: DigestCounts): string | null {
  if (counts.newInPeriod === 0) return null;
  const open = plural(counts.newOpen, "abierta", "abiertas");
  const closed = plural(counts.newClosed, "cerrada", "cerradas");
  return `Nuevas en el periodo (${counts.newInPeriod}) · ${open} · ${closed}`;
}

type RenderLine = {
  text: string;
  weight: number;
  ids: number[];
};

function compose(
  input: Pick<DigestRenderInput, "date" | "counts" | "alertsUrl">,
  lines: readonly RenderLine[],
  omitted: number,
): string {
  const parts = [`Resumen diario · ${input.date}`];
  if (input.counts.openNow > 0) {
    parts.push("", `Abiertas ahora (${input.counts.openNow})`);
    for (const line of lines) parts.push(line.text);
    if (omitted > 0) parts.push(`+${omitted} más`);
  }
  const newLine = digestNewLine(input.counts);
  if (newLine) parts.push("", newLine);
  parts.push("", digestCountersLine(input.counts), "", input.alertsUrl);
  return parts.join("\n");
}

/**
 * Renders the sections of one snapshot. Lines are dropped from the end until
 * the exact `+N` fits, so the footer, the counters and the authenticated link
 * always survive. An aggregated host row represents its whole group while it
 * stays; once dropped, the whole group joins the omitted figure.
 */
export function renderDigestSnapshot(input: DigestRenderInput): DigestRendered {
  const limit = input.limit ?? TELEGRAM_TEXT_LIMIT;
  const explicit: RenderLine[] = [...input.details]
    .sort((left, right) => left.at - right.at || left.id - right.id)
    .map((detail) => ({
      text: detailLine(detail, input.hostNames),
      weight: 1,
      ids: [detail.id],
    }));
  const aggregates: RenderLine[] = [...input.aggregates]
    .filter((aggregate) => aggregate.count > 0)
    .sort((left, right) => (left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0))
    .map((aggregate) => ({
      text: aggregateLine(aggregate, input.hostNames),
      weight: aggregate.count,
      ids: [],
    }));
  const candidates = [...explicit, ...aggregates];

  let kept = candidates.length;
  let text = "";
  for (;;) {
    const lines = candidates.slice(0, kept);
    const entries = lines.reduce((total, line) => total + line.weight, 0);
    // Every candidate that is not kept is unrepresented: the rows the bounded
    // query never materialised fall in the same figure by construction.
    const omitted = Math.max(0, input.counts.openNow - entries);
    text = compose(input, lines, omitted);
    if (text.length <= limit) break;
    if (kept === 0) {
      // Only a pathological link or title reaches this: keep the provider
      // bound even though the footer may then be cut.
      text = telegramText(text);
      break;
    }
    kept -= 1;
  }

  const lines = candidates.slice(0, kept);
  const entries = lines.reduce((total, line) => total + line.weight, 0);
  return {
    text,
    entries,
    omitted: Math.max(0, input.counts.openNow - entries),
    listed: lines.flatMap((line) => line.ids),
  };
}

type DigestQueryRow = {
  totals: Omit<DigestCounts, "critical">;
  critical: number;
  detail: DigestDetail[];
  aggregated: DigestAggregate[];
};

/**
 * Cohorts, counters and bounded detail rows from one statement.
 *
 * The detail set follows the durable opening disposition, not today's policy:
 * `incident-open` recorded as `channel=digest`, `status=suppressed` and
 * `reason=digest_pending`. A later escalada rewrites that row, so an episode
 * that became an individual notice stops being a digest line. Legacy, silent
 * and individually delivered episodes never become details.
 *
 * The incident timestamps are stored by Drizzle as UTC wall-clock values, so
 * every comparison normalises them with `AT TIME ZONE 'UTC'` before applying
 * the instant range: the period keeps meaning instants across a DST change.
 */
async function readSnapshot(
  input: DigestSnapshotInput,
): Promise<DigestQueryRow> {
  const { rows } = await input.client.query<DigestQueryRow>(
    `WITH watched AS MATERIALIZED (
       SELECT i.id,
              i."hostId" AS "hostId",
              i.title,
              i.severity,
              i.at,
              i."resolvedAt" AS "resolvedAt",
              i.origin,
              i."closedBy" AS "closedBy",
              opening.channel AS "openChannel",
              opening.status AS "openStatus",
              opening.reason AS "openReason"
         FROM incidents i
         LEFT JOIN LATERAL (
           SELECT o.channel, o.status, o.result->>'reason' AS reason
             FROM notification_outbox o
            WHERE o."incidentId" = i.id AND o.kind = 'incident-open'
            ORDER BY o.id ASC
            LIMIT 1
         ) opening ON true
        WHERE i."hostId" = ANY($3::text[])
     ),
     flagged AS MATERIALIZED (
       SELECT w.*,
              (w."resolvedAt" IS NULL
                OR w."resolvedAt" AT TIME ZONE 'UTC' > $4::timestamptz) AS "openNow",
              (w.at AT TIME ZONE 'UTC' >= $1::timestamptz
                AND w.at AT TIME ZONE 'UTC' < $2::timestamptz) AS "newInPeriod",
              (w.origin <> 'legacy'
                AND w."openChannel" IN ('digest', 'telegram', 'push')) AS visible,
              (w."openChannel" = 'digest'
                AND w."openStatus" = 'suppressed'
                AND w."openReason" = 'digest_pending') AS "digestOpen"
         FROM watched w
     ),
     totals AS (
       SELECT count(*) FILTER (WHERE "openNow" AND "digestOpen")::int AS "openNow",
              count(*) FILTER (WHERE "newInPeriod" AND visible)::int AS "newInPeriod",
              count(*) FILTER (WHERE "newInPeriod" AND visible AND "openNow")::int AS "newOpen",
              count(*) FILTER (WHERE "newInPeriod" AND visible AND NOT "openNow")::int AS "newClosed",
              count(*) FILTER (WHERE "resolvedAt" AT TIME ZONE 'UTC' >= $1::timestamptz
                                 AND "resolvedAt" AT TIME ZONE 'UTC' < $2::timestamptz
                                 AND visible
                                 AND "closedBy" IS DISTINCT FROM 'migration-dedup')::int AS resolved
         FROM flagged
     ),
     detail AS (
       SELECT f.id,
              f."hostId" AS "hostId",
              f.title,
              f.severity,
              (extract(epoch FROM (f.at AT TIME ZONE 'UTC')) * 1000)::double precision AS at
         FROM flagged f
        WHERE f."openNow" AND f."digestOpen"
          AND f.at AT TIME ZONE 'UTC' >= $1::timestamptz
        ORDER BY f.at ASC, f.id ASC
        LIMIT $5
     ),
     aggregated AS (
       SELECT f."hostId" AS "hostId", count(*)::int AS count
         FROM flagged f
        WHERE f."openNow" AND f."digestOpen"
          AND f.at AT TIME ZONE 'UTC' < $1::timestamptz
        GROUP BY f."hostId"
     ),
     critical AS (
       SELECT count(DISTINCT e."incidentId")::int AS critical
         FROM incident_events e
         JOIN flagged f ON f.id = e."incidentId"
        WHERE e.kind IN ('opened', 'severity')
          AND e.severity = 'critical'
          AND e.at AT TIME ZONE 'UTC' >= $1::timestamptz
          AND e.at AT TIME ZONE 'UTC' < $2::timestamptz
     )
     SELECT to_json(t) AS totals,
            (SELECT critical FROM critical) AS critical,
            COALESCE((SELECT json_agg(d ORDER BY d.at, d.id) FROM detail d), '[]'::json) AS detail,
            COALESCE((SELECT json_agg(a ORDER BY a."hostId") FROM aggregated a), '[]'::json) AS aggregated
       FROM totals t`,
    [
      input.periodStart,
      input.periodEnd,
      [...input.hostIds],
      input.snapshotAt,
      DIGEST_DETAIL_LIMIT,
    ],
  );
  return rows[0];
}

/**
 * Renders the daily snapshot, or returns null when the cut has no content: an
 * empty day is a terminal state, never a message. A footer with observed
 * activity is content even when no episode deserves a detailed line.
 */
export async function buildDigestSnapshot(
  input: DigestSnapshotInput,
): Promise<DigestSnapshot | null> {
  if (input.hostIds.length === 0) return null;
  const row = await readSnapshot(input);
  const counts: DigestCounts = { ...row.totals, critical: row.critical };
  if (
    counts.openNow === 0 &&
    counts.newInPeriod === 0 &&
    counts.critical === 0 &&
    counts.resolved === 0
  )
    return null;

  const rendered = renderDigestSnapshot({
    date: input.date,
    counts,
    details: row.detail,
    aggregates: row.aggregated,
    hostNames: input.hostNames,
    alertsUrl: input.alertsUrl,
  });
  return { ...rendered, counts };
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
