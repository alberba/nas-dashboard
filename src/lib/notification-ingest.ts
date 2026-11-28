import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { getHosts, type HostConfig } from "./hosts";
import {
  recordIncidentObservationIn,
  type IncidentDelivery,
  type IncidentObservation,
  type IncidentObservationResult,
  type Transaction,
} from "./incident-store";
import { notificationPolicy, pushWarningsEnabled } from "./notification-policy";
import { BodyTooLarge, readBodyText } from "./request-body";
import { readIngestSecrets, type IngestSecrets } from "./runtime-config";
import { ingestEvents } from "./schema";

/**
 * Signed notification ingest, contract v1 (CONT-02).
 *
 * A producer outside the hub (media-stack) sends one JSON event with two
 * headers: `X-Ingest-Timestamp` (10 digits, epoch seconds) and
 * `X-Ingest-Signature: v1=<64 lowercase hex>`, the HMAC-SHA256 of
 * `<timestamp>.<raw body>`. The hub owns title, detail and delivery: the
 * producer only reports a fact.
 *
 * Check order (P-02): secret configured (503), body limit (413), headers,
 * window and HMAC (one 401), schema (400), scope (422), one transaction.
 * Nothing touches the database before the signature is verified.
 */

export const INGEST_BODY_LIMIT = 8 * 1024;
export const INGEST_WINDOW_SECONDS = 300;
export const INGEST_SOURCES = ["backup", "issue-automator"] as const;

export type IngestSource = (typeof INGEST_SOURCES)[number];

const text = (max: number) => z.string().max(max);

export const ingestEnvelope = z.strictObject({
  v: z.literal(1),
  source: z.enum(INGEST_SOURCES),
  eventId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  hostId: z.string().min(1).max(64),
  key: z.string().min(1).max(64),
  state: z.enum(["open", "resolved"]),
  data: z
    .strictObject({
      errors: z.array(text(200)).max(5).optional(),
      subject: text(200).optional(),
      reportedBy: text(100).optional(),
      problem: text(300).optional(),
      action: text(500).optional(),
    })
    .optional(),
});

export type IngestEvent = z.infer<typeof ingestEnvelope>;

const ISSUE_KEY = /^issue:seerr:\d{1,9}$/;

/** D-07: each source may only open and close its own fixed conditions. */
export function ingestScopeAllows(source: string, key: string): boolean {
  if (source === "backup") return key === "backup-failed";
  if (source === "issue-automator") return ISSUE_KEY.test(key);
  return false;
}

/** HMAC-SHA256 over `<timestamp>.<raw body>`, lowercase hex. */
export function signIngest(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

const TIMESTAMP_PATTERN = /^\d{10}$/;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;

/**
 * Header, window and signature check in one boolean: callers answer a single
 * 401 for all of them, so the response is never an oracle. `now` is epoch
 * seconds. Both secrets are always evaluated, with no short circuit.
 */
export function verifyIngest(input: {
  secrets: IngestSecrets;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now: number;
}): boolean {
  const { timestamp, signature } = input;
  if (timestamp === null || !TIMESTAMP_PATTERN.test(timestamp)) return false;
  const match = signature === null ? null : SIGNATURE_PATTERN.exec(signature);
  if (!match) return false;
  if (Math.abs(input.now - Number(timestamp)) > INGEST_WINDOW_SECONDS)
    return false;

  const received = Buffer.from(match[1], "hex");
  const candidates = [input.secrets.secret, input.secrets.previous];
  let valid = false;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const expected = Buffer.from(
      signIngest(candidate, timestamp, input.body),
      "hex",
    );
    const equal = timingSafeEqual(received, expected);
    valid = valid || equal;
  }
  return valid;
}

const TITLE_LIMIT = 120;
const DETAIL_LIMIT = 600;

/** Plain text: no control characters, no markup, bounded. */
function plain(value: string, limit: number): string {
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

export type IngestNotice = {
  title: string;
  detail: string;
  severity: "critical" | "warning";
};

/** The hub composes the notice; the producer never chooses its wording. */
export function composeIngestNotice(
  event: Pick<IngestEvent, "source" | "data">,
  host: Pick<HostConfig, "name">,
): IngestNotice {
  const data = event.data ?? {};
  if (event.source === "backup") {
    const errors = (data.errors ?? []).map((line) => plain(line, 200));
    return {
      title: plain(`Copia fallida en ${host.name}`, TITLE_LIMIT),
      detail: plain(
        errors.filter(Boolean).join("; ") ||
          "La última copia registrada ha fallado.",
        DETAIL_LIMIT,
      ),
      severity: "critical",
    };
  }
  const parts = [
    data.reportedBy ? `Reporta: ${plain(data.reportedBy, 100)}` : "",
    data.problem ? `Problema: ${plain(data.problem, 300)}` : "",
    data.action ? `Acción: ${plain(data.action, 500)}` : "",
  ].filter(Boolean);
  return {
    title: plain(data.subject ?? "Incidencia de Seerr", TITLE_LIMIT) ||
      "Incidencia de Seerr",
    detail: plain(parts.join(" · "), DETAIL_LIMIT),
    severity: "warning",
  };
}

export type IngestOptions = {
  /** Injected clock in epoch milliseconds; defaults to `Date.now()`. */
  now?: number;
  /** Injected recorder, only to prove atomicity; defaults to the real store. */
  record?: (
    tx: Transaction,
    input: IncidentObservation,
  ) => Promise<IncidentObservationResult>;
};

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function deliveryFor(key: string, severity: "critical" | "warning") {
  const decision = notificationPolicy(key, severity, {
    pushWarnings: pushWarningsEnabled(),
  });
  return {
    channel: decision.channel,
    reason: decision.reason,
  } satisfies IncidentDelivery;
}

type Outcome =
  | { kind: "accepted"; action: IncidentObservationResult["action"] }
  | { kind: "duplicate" }
  | { kind: "conflict" };

export async function handleIngest(
  request: Request,
  options: IngestOptions = {},
): Promise<Response> {
  const secrets = readIngestSecrets(process.env);
  if (!secrets) return reply(503, { status: "unavailable" });

  let body: string;
  try {
    body = await readBodyText(request, INGEST_BODY_LIMIT);
  } catch (error) {
    if (error instanceof BodyTooLarge) return reply(413, { status: "too-large" });
    return reply(400, { status: "invalid" });
  }

  const now = options.now ?? Date.now();
  if (
    !verifyIngest({
      secrets,
      timestamp: request.headers.get("x-ingest-timestamp"),
      signature: request.headers.get("x-ingest-signature"),
      body,
      now: Math.floor(now / 1000),
    })
  )
    return reply(401, { status: "unauthorized" });

  let parsed: z.ZodSafeParseResult<IngestEvent>;
  try {
    parsed = ingestEnvelope.safeParse(JSON.parse(body));
  } catch {
    return reply(400, { status: "invalid" });
  }
  if (!parsed.success) return reply(400, { status: "invalid" });
  const event = parsed.data;

  let host: HostConfig | undefined;
  try {
    host = getHosts().find((entry) => entry.id === event.hostId);
  } catch {
    return reply(503, { status: "unavailable" });
  }
  if (!ingestScopeAllows(event.source, event.key) || !host)
    return reply(422, { status: "out-of-scope" });

  const bodyHash = createHash("sha256").update(body).digest("hex");
  const notice = composeIngestNotice(event, host);
  const record = options.record ?? recordIncidentObservationIn;

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [inserted] = await tx
        .insert(ingestEvents)
        .values({ source: event.source, eventId: event.eventId, bodyHash })
        .onConflictDoNothing()
        .returning({ eventId: ingestEvents.eventId });
      if (!inserted) {
        const [existing] = await tx
          .select({ bodyHash: ingestEvents.bodyHash })
          .from(ingestEvents)
          .where(
            and(
              eq(ingestEvents.source, event.source),
              eq(ingestEvents.eventId, event.eventId),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("Evento de ingest no localizable");
        return { kind: existing.bodyHash === bodyHash ? "duplicate" : "conflict" };
      }
      const result = await record(tx, {
        hostId: host.id,
        key: event.key,
        failing: event.state === "open",
        severity: notice.severity,
        title: notice.title,
        detail: notice.detail,
        now,
        delivery: deliveryFor(event.key, notice.severity),
        closedBy: "ingest",
      });
      if (result.incidentId !== undefined)
        await tx
          .update(ingestEvents)
          .set({ incidentId: result.incidentId })
          .where(
            and(
              eq(ingestEvents.source, event.source),
              eq(ingestEvents.eventId, event.eventId),
            ),
          );
      return { kind: "accepted", action: result.action };
    });
  } catch (error) {
    // Never echo the cause: database errors can carry request values.
    console.error(
      `notification ingest failed (${error instanceof Error ? error.name : "unknown"})`,
    );
    return reply(503, { status: "unavailable" });
  }

  if (outcome.kind === "duplicate") return reply(200, { status: "duplicate" });
  if (outcome.kind === "conflict") return reply(409, { status: "conflict" });
  return reply(202, { status: "accepted", action: outcome.action });
}
