import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { incidentHref, routeHref } from "../components/views/routes";
import type { RuntimeConfig } from "./runtime-config";
import * as schema from "./schema";
import { incidents, notificationOutbox, type NotificationOutcome } from "./schema";
import {
  editTelegramMessage,
  sendTelegramMessage,
  type TelegramTransport,
} from "./telegram";
import { deliverPush, type PushTransport } from "./push";

/** Session-level PostgreSQL advisory lock already used by the collector. */
export const COLLECTION_LOCK_KEY = 734921;
/** The HTTP request must finish well before its claim lease expires. */
export const CLAIM_LEASE_MS = 30_000;
export const CLAIM_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_CONFIRMED_ATTEMPTS = 5;

export type DispatchAction =
  | "idle"
  | "sent"
  | "retry"
  | "failed"
  | "uncertain"
  | "suppressed"
  | "edited"
  | "superseded";

export type DispatchResult = {
  action: DispatchAction;
  jobId?: number;
  kind?: string;
  channel?: string;
  reason?: string;
};

export type DispatcherOptions = {
  /** Dedicated connection that owns the advisory lock. */
  client: Client;
  config: RuntimeConfig;
  now?: () => number;
  fetchImpl?: TelegramTransport;
  pushTransport?: PushTransport;
  /** Aborted on process shutdown or when the lock session is lost. */
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  claimToken?: () => string;
};

export class CollectionLockLost extends Error {
  constructor() {
    super("Se perdió el lock de recolección");
    this.name = "CollectionLockLost";
  }
}

class ClaimLostError extends Error {
  constructor() {
    super("La reclamación ya no es válida");
    this.name = "ClaimLostError";
  }
}

export async function acquireCollectionLock(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS ok",
    [COLLECTION_LOCK_KEY],
  );
  return rows[0]?.ok === true;
}

export async function releaseCollectionLock(client: Client): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [COLLECTION_LOCK_KEY]);
}

/**
 * Checks the current backend actually owns the session advisory lock. A dead
 * or replaced session must never claim or start a provider request.
 */
export async function holdsCollectionLock(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid()
         AND classid = 0 AND objid = $1 AND granted
     ) AS held`,
    [COLLECTION_LOCK_KEY],
  );
  return rows[0]?.held === true;
}

function workerDb(client: Client) {
  return drizzle(client, { schema });
}

/** Stable per-episode label shared with the service worker and 02-05. */
export function incidentTag(hostId: string, incidentId: number): string {
  return `hub:incident:${hostId}:${incidentId}`;
}

function openKey(incidentId: number) {
  return `incident:${incidentId}:open`;
}

function editKey(incidentId: number, seq: number) {
  return `incident:${incidentId}:edit:${seq}`;
}

function outcome(
  state: NotificationOutcome["state"],
  reason: string | null,
  at: number,
): NotificationOutcome {
  return { state, reason, at: new Date(at).toISOString() };
}

function boundedBackoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

type Job = typeof notificationOutbox.$inferSelect;

/**
 * Resolves leases left behind by a dead owner. A lease that expired before the
 * attempt mark is safe to claim again; a lease that expired after it is an
 * uncertain initial delivery, never a resend (D-01).
 */
export async function recoverOutbox(
  client: Client,
  now: number,
  maxAttempts = MAX_CONFIRMED_ATTEMPTS,
): Promise<void> {
  const at = new Date(now);
  const iso = at.toISOString();
  await client.query(
    `UPDATE notification_outbox
        SET status = 'uncertain',
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "updatedAt" = $1,
            result = jsonb_build_object(
              'state', 'uncertain',
              'reason', 'lease_expired_after_attempt',
              'at', $2::text
            )
      WHERE status = 'claimed'
        AND "attemptStartedAt" IS NOT NULL
        AND kind <> 'incident-edit'
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)`,
    [at, iso],
  );
  await client.query(
    `UPDATE notification_outbox
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            "editResult" = jsonb_build_object(
              'state', CASE WHEN attempts >= $3 THEN 'failed' ELSE 'uncertain' END,
              'reason', CASE WHEN attempts >= $3 THEN 'edit_retry_exhausted' ELSE 'lease_expired_edit' END,
              'at', $2::text
            ),
            "attemptStartedAt" = NULL,
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "updatedAt" = $1,
            "nextAttemptAt" = CASE WHEN attempts >= $3 THEN "nextAttemptAt" ELSE $1 END
      WHERE status = 'claimed'
        AND "attemptStartedAt" IS NOT NULL
        AND kind = 'incident-edit'
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)`,
    [at, iso, maxAttempts],
  );
  await client.query(
    `UPDATE notification_outbox
        SET status = 'pending',
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "updatedAt" = $1
      WHERE status = 'claimed'
        AND "attemptStartedAt" IS NULL
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)`,
    [at],
  );
}

/** Claims one due delivery job with a fresh token and lease. */
export async function claimOutboxJob(
  client: Client,
  token: string,
  now: number,
  leaseMs = CLAIM_LEASE_MS,
): Promise<Job | null> {
  const at = new Date(now);
  const lease = new Date(now + leaseMs);
  const { rows } = await client.query<{ id: number }>(
    `WITH candidate AS (
       SELECT id FROM notification_outbox
        WHERE status IN ('pending', 'claimed')
          AND "attemptStartedAt" IS NULL
          AND "nextAttemptAt" <= $1
          AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)
          AND kind IN ('incident-open', 'incident-edit', 'incident-push', 'push-test')
        ORDER BY "nextAttemptAt" ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE notification_outbox AS o
        SET status = 'claimed',
            "claimToken" = $2,
            "leaseUntil" = $3,
            "updatedAt" = $1
       FROM candidate
      WHERE o.id = candidate.id
      RETURNING o.id`,
    [at, token, lease],
  );
  if (!rows[0]) return null;
  const db = workerDb(client);
  const [job] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, rows[0].id))
    .limit(1);
  return job ?? null;
}

/**
 * Marks the durable start of the request before any network call. The update
 * is conditional on the current token and a live lease; a false result means
 * the dispatcher must not contact the provider.
 */
export async function beginOutboxAttempt(
  client: Client,
  id: number,
  token: string,
  now: number,
): Promise<number | null> {
  const at = new Date(now);
  const { rows } = await client.query<{ attempts: number }>(
    `UPDATE notification_outbox
        SET "attemptStartedAt" = $3,
            attempts = attempts + 1,
            "updatedAt" = $3
      WHERE id = $1
        AND "claimToken" = $2
        AND status = 'claimed'
        AND "attemptStartedAt" IS NULL
        AND ("leaseUntil" IS NULL OR "leaseUntil" > $3)
      RETURNING attempts`,
    [id, token, at],
  );
  return rows[0]?.attempts ?? null;
}

type DispatcherContext = {
  client: Client;
  config: RuntimeConfig;
  token: string;
  now: number;
  options: DispatcherOptions;
};

function delayFor(attempts: number): number {
  return boundedBackoffMs(attempts);
}

async function loadIncident(
  db: ReturnType<typeof workerDb>,
  id: number,
): Promise<typeof incidents.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1);
  return row ?? null;
}

function openingText(incident: typeof incidents.$inferSelect): string {
  const lines = [incident.title];
  if (incident.detail) lines.push(incident.detail);
  lines.push(`${incident.hostId} · ${incident.severity}`);
  return lines.join("\n");
}

async function suppressJob(
  context: DispatcherContext,
  job: Job,
  reason: string,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const [updated] = await db
    .update(notificationOutbox)
    .set({
      status: "suppressed",
      result: outcome("suppressed", reason, context.now),
      claimToken: null,
      leaseUntil: null,
      updatedAt: new Date(context.now),
    })
    .where(
      and(
        eq(notificationOutbox.id, job.id),
        eq(notificationOutbox.claimToken, context.token),
      ),
    )
    .returning({ id: notificationOutbox.id });
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
  return {
    action: "suppressed",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason,
  };
}

async function recordTelegramSent(
  context: DispatcherContext,
  job: Job,
  chatId: string,
  messageId: string,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(notificationOutbox)
      .set({
        status: "sent",
        chatId,
        messageId,
        result: outcome("sent", null, context.now),
        claimToken: null,
        leaseUntil: null,
        updatedAt: new Date(context.now),
      })
      .where(
        and(
          eq(notificationOutbox.id, job.id),
          eq(notificationOutbox.claimToken, context.token),
        ),
      )
      .returning({ id: notificationOutbox.id });
    if (!updated) throw new ClaimLostError();

    const [incident] = await tx
      .select()
      .from(incidents)
      .where(eq(incidents.id, job.incidentId!))
      .limit(1)
      // Serialize with a closure or severity change: only this side locks the
      // incident row, so the closer never waits on a confirmation lock.
      .for("update");
    if (!incident || incident.seq <= job.revision) return;
    // The episode changed while the opening was in flight: confirm the message
    // and immediately schedule its final edit for the current seq (D-06).
    await tx
      .insert(notificationOutbox)
      .values({
        key: editKey(incident.id, incident.seq),
        incidentId: incident.id,
        kind: "incident-edit",
        channel: "telegram",
        status: "pending",
        revision: incident.seq,
        chatId,
        messageId,
      })
      .onConflictDoNothing();
  });
  return { action: "sent", jobId: job.id, kind: job.kind, channel: job.channel };
}

async function recordTelegramRetry(
  context: DispatcherContext,
  job: Job,
  attempts: number,
  retryAfterMs: number | null,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const delay = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : delayFor(attempts);
  const nextAttemptAt = new Date(context.now + delay);
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(notificationOutbox)
      .set({
        status: "pending",
        nextAttemptAt,
        result: outcome("failed", "rate_limited", context.now),
        claimToken: null,
        leaseUntil: null,
        attemptStartedAt: null,
        updatedAt: new Date(context.now),
      })
      .where(
        and(
          eq(notificationOutbox.id, job.id),
          eq(notificationOutbox.claimToken, context.token),
        ),
      )
      .returning({ id: notificationOutbox.id });
    if (!updated) throw new ClaimLostError();
    // A shared durable cooldown for this bot/chat: no other Telegram job starts
    // before the provider's retry_after, even after a restart.
    await tx
      .update(notificationOutbox)
      .set({ nextAttemptAt, updatedAt: new Date(context.now) })
      .where(
        and(
          eq(notificationOutbox.channel, "telegram"),
          inArray(notificationOutbox.status, ["pending", "claimed"]),
          isNull(notificationOutbox.attemptStartedAt),
          lt(notificationOutbox.nextAttemptAt, nextAttemptAt),
        ),
      );
  });
  return {
    action: "retry",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason: "rate_limited",
  };
}

/**
 * A confirmed rejection is terminal for the initial notice. A critical
 * episode gets exactly one push fallback, written in the same transaction.
 */
async function recordPermanentFailure(
  context: DispatcherContext,
  job: Job,
  reason: string,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(notificationOutbox)
      .set({
        status: "failed",
        result: outcome("failed", reason, context.now),
        claimToken: null,
        leaseUntil: null,
        updatedAt: new Date(context.now),
      })
      .where(
        and(
          eq(notificationOutbox.id, job.id),
          eq(notificationOutbox.claimToken, context.token),
        ),
      )
      .returning({ id: notificationOutbox.id });
    if (!updated) throw new ClaimLostError();
    if (job.kind !== "incident-open" || !job.incidentId) return;
    const [incident] = await tx
      .select()
      .from(incidents)
      .where(eq(incidents.id, job.incidentId))
      .limit(1);
    if (!incident || incident.severity !== "critical" || incident.resolvedAt)
      return;
    await tx
      .insert(notificationOutbox)
      .values({
        key: `incident:${incident.id}:push`,
        incidentId: incident.id,
        kind: "incident-push",
        channel: "push",
        status: "pending",
        revision: incident.seq,
      })
      .onConflictDoNothing();
  });
  return {
    action: "failed",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason,
  };
}

async function recordTelegramUncertain(
  context: DispatcherContext,
  job: Job,
  reason: string,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const [updated] = await db
    .update(notificationOutbox)
    .set({
      status: "uncertain",
      result: outcome("uncertain", reason, context.now),
      claimToken: null,
      leaseUntil: null,
      updatedAt: new Date(context.now),
    })
    .where(
      and(
        eq(notificationOutbox.id, job.id),
        eq(notificationOutbox.claimToken, context.token),
      ),
    )
    .returning({ id: notificationOutbox.id });
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
  return {
    action: "uncertain",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason,
  };
}

async function dispatchTelegramOpening(
  context: DispatcherContext,
  job: Job,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const incident = job.incidentId
    ? await loadIncident(db, job.incidentId)
    : null;
  if (!incident)
    return recordPermanentFailure(context, job, "incident_missing");
  // A closing observation before the attempt mark cancels the opening.
  if (incident.resolvedAt) return suppressJob(context, job, "resolved_before_send");
  const telegram = context.config.telegram;
  if (!telegram) return suppressJob(context, job, "telegram_disabled");
  if (!(await holdsCollectionLock(context.client)))
    throw new CollectionLockLost();

  const attempts = await beginOutboxAttempt(
    context.client,
    job.id,
    context.token,
    context.now,
  );
  if (attempts === null)
    return { action: "idle", jobId: job.id, reason: "claim_lost" };

  const result = await sendTelegramMessage(
    {
      chatId: telegram.chatId,
      text: openingText(incident),
      buttonUrl: incidentHref(
        context.config.betterAuthUrl,
        incident.hostId,
        incident.id,
      ),
    },
    {
      botToken: telegram.botToken,
      fetchImpl: context.options.fetchImpl,
      signal: context.options.signal,
      timeoutMs:
        context.options.requestTimeoutMs ?? CLAIM_REQUEST_TIMEOUT_MS,
    },
  );

  switch (result.state) {
    case "sent":
      return recordTelegramSent(context, job, result.chatId, result.messageId);
    case "retry":
      if (attempts >= (context.options.maxAttempts ?? MAX_CONFIRMED_ATTEMPTS))
        return recordPermanentFailure(
          context,
          job,
          "retry_budget_exhausted",
        );
      return recordTelegramRetry(
        context,
        job,
        attempts,
        result.retryAfterMs,
      );
    case "rejected":
      return recordPermanentFailure(context, job, result.reason);
    case "uncertain":
      return recordTelegramUncertain(context, job, result.reason);
  }
}

async function markEditSuperseded(
  context: DispatcherContext,
  job: Job,
  reason = "superseded_by_later_seq",
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const [updated] = await db
    .update(notificationOutbox)
    .set({
      status: "superseded",
      editResult: outcome("suppressed", reason, context.now),
      claimToken: null,
      leaseUntil: null,
      updatedAt: new Date(context.now),
    })
    .where(
      and(
        eq(notificationOutbox.id, job.id),
        eq(notificationOutbox.claimToken, context.token),
      ),
    )
    .returning({ id: notificationOutbox.id });
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
  return {
    action: "superseded",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason,
  };
}

async function recordEditFailure(
  context: DispatcherContext,
  job: Job,
  reason: string,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const [updated] = await db
    .update(notificationOutbox)
    .set({
      status: "failed",
      editResult: outcome("failed", reason, context.now),
      claimToken: null,
      leaseUntil: null,
      updatedAt: new Date(context.now),
    })
    .where(
      and(
        eq(notificationOutbox.id, job.id),
        eq(notificationOutbox.claimToken, context.token),
      ),
    )
    .returning({ id: notificationOutbox.id });
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
  return {
    action: "failed",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason,
  };
}

async function recordEditRetry(
  context: DispatcherContext,
  job: Job,
  attempts: number,
  reason: string,
  retryAfterMs: number | null,
): Promise<DispatchResult> {
  if (attempts >= (context.options.maxAttempts ?? MAX_CONFIRMED_ATTEMPTS))
    return recordEditFailure(context, job, "edit_retry_exhausted");
  const db = workerDb(context.client);
  const delay =
    retryAfterMs && retryAfterMs > 0
      ? retryAfterMs
      : boundedBackoffMs(attempts);
  const [updated] = await db
    .update(notificationOutbox)
    .set({
      status: "pending",
      nextAttemptAt: new Date(context.now + delay),
      editResult: outcome("uncertain", reason, context.now),
      claimToken: null,
      leaseUntil: null,
      attemptStartedAt: null,
      updatedAt: new Date(context.now),
    })
    .where(
      and(
        eq(notificationOutbox.id, job.id),
        eq(notificationOutbox.claimToken, context.token),
      ),
    )
    .returning({ id: notificationOutbox.id });
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
  return {
    action: "retry",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason,
  };
}

async function recordEditSent(
  context: DispatcherContext,
  job: Job,
  chatId: string,
  messageId: string,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const [updated] = await db
    .update(notificationOutbox)
    .set({
      status: "sent",
      chatId,
      messageId,
      editResult: outcome("sent", null, context.now),
      claimToken: null,
      leaseUntil: null,
      updatedAt: new Date(context.now),
    })
    .where(
      and(
        eq(notificationOutbox.id, job.id),
        eq(notificationOutbox.claimToken, context.token),
      ),
    )
    .returning({ id: notificationOutbox.id });
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
  return {
    action: "edited",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
  };
}

function editText(incident: typeof incidents.$inferSelect): string {
  const lines = [incident.title];
  if (incident.detail) lines.push(incident.detail);
  lines.push(
    `${incident.hostId} · ${incident.severity}${
      incident.resolvedAt ? " · resuelta" : ""
    }`,
  );
  return lines.join("\n");
}

/**
 * Edits the confirmed original message. Pending changes for the same episode
 * coalesce on the highest seq so a stale revision never overwrites a newer
 * one; the initial delivery revision and its result stay untouched (D-06).
 */
async function dispatchEdit(
  context: DispatcherContext,
  job: Job,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const incident = job.incidentId
    ? await loadIncident(db, job.incidentId)
    : null;
  if (!incident) return recordEditFailure(context, job, "incident_missing");
  const [original] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.key, openKey(incident.id)))
    .limit(1);
  if (!original || original.status === "uncertain")
    return recordEditFailure(context, job, "initial_uncertain");
  if (
    original.status !== "sent" ||
    original.channel !== "telegram" ||
    !original.chatId ||
    !original.messageId
  )
    return recordEditFailure(context, job, "message_unavailable");

  const latestRevision = async () => {
    const [latest] = await db
      .select({ revision: notificationOutbox.revision })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.incidentId, incident.id),
          eq(notificationOutbox.kind, "incident-edit"),
          inArray(notificationOutbox.status, ["pending", "claimed"]),
        ),
      )
      .orderBy(desc(notificationOutbox.revision))
      .limit(1);
    return latest?.revision ?? job.revision;
  };
  if (job.revision < (await latestRevision()))
    return markEditSuperseded(context, job);
  const telegram = context.config.telegram;
  if (!telegram) return recordEditFailure(context, job, "telegram_disabled");
  if (!(await holdsCollectionLock(context.client)))
    throw new CollectionLockLost();

  const attempts = await beginOutboxAttempt(
    context.client,
    job.id,
    context.token,
    context.now,
  );
  if (attempts === null)
    return { action: "idle", jobId: job.id, reason: "claim_lost" };
  // A newer change may have arrived between the coalesce check and the mark.
  if (job.revision < (await latestRevision()))
    return markEditSuperseded(context, job);

  const result = await editTelegramMessage(
    {
      chatId: original.chatId,
      messageId: original.messageId,
      text: editText(incident),
      buttonUrl: incidentHref(
        context.config.betterAuthUrl,
        incident.hostId,
        incident.id,
      ),
    },
    {
      botToken: telegram.botToken,
      fetchImpl: context.options.fetchImpl,
      signal: context.options.signal,
      timeoutMs:
        context.options.requestTimeoutMs ?? CLAIM_REQUEST_TIMEOUT_MS,
    },
  );
  switch (result.state) {
    case "sent":
      return recordEditSent(
        context,
        job,
        result.chatId,
        result.messageId,
      );
    case "retry":
      return recordEditRetry(
        context,
        job,
        attempts,
        "rate_limited",
        result.retryAfterMs,
      );
    case "rejected":
      return recordEditFailure(context, job, result.reason);
    case "uncertain":
      return recordEditRetry(context, job, attempts, result.reason, null);
  }
}

function pushPayloadFor(
  job: Job,
  incident: typeof incidents.$inferSelect | null,
): { title: string; body: string; tag: string; url: string; seq?: number } {
  if (!incident)
    return {
      title: "hub.",
      body: "Notificaciones del hub",
      tag: "test",
      url: "/?view=alerts",
    };
  return {
    title: incident.title,
    body: incident.detail || incident.title,
    tag: incidentTag(incident.hostId, incident.id),
    url: routeHref({
      view: "alerts",
      tab: "status",
      host: incident.hostId,
      incident: incident.id,
    }),
    seq: incident.seq,
  };
}

async function recordPushOutcome(
  context: DispatcherContext,
  job: Job,
  state: NotificationOutcome["state"],
  reason: string | null,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const result = outcome(state, reason, context.now);
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(notificationOutbox)
      .set({
        status: state,
        result,
        claimToken: null,
        leaseUntil: null,
        updatedAt: new Date(context.now),
      })
      .where(
        and(
          eq(notificationOutbox.id, job.id),
          eq(notificationOutbox.claimToken, context.token),
        ),
      )
      .returning({ id: notificationOutbox.id });
    if (!updated) throw new ClaimLostError();
    if (job.kind === "incident-push" && job.incidentId) {
      await tx
        .update(notificationOutbox)
        .set({ fallbackResult: result })
        .where(eq(notificationOutbox.key, openKey(job.incidentId)));
    }
  });
  return {
    action: state,
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason: reason ?? undefined,
  };
}

async function dispatchPushJob(
  context: DispatcherContext,
  job: Job,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const incident = job.incidentId
    ? await loadIncident(db, job.incidentId)
    : null;
  if (job.kind !== "push-test" && !incident)
    return recordPushOutcome(context, job, "failed", "incident_missing");
  if (incident?.resolvedAt)
    return suppressJob(context, job, "resolved_before_send");
  if (job.kind === "push-test" && !job.ownerUserId)
    return suppressJob(context, job, "owner_required");
  if (!context.config.vapid)
    return suppressJob(context, job, "push_disabled");
  if (!(await holdsCollectionLock(context.client)))
    throw new CollectionLockLost();
  // A push whose confirmation is lost after this mark is uncertain, never
  // retried: a second delivery could duplicate the notification (D-01).
  const attempts = await beginOutboxAttempt(
    context.client,
    job.id,
    context.token,
    context.now,
  );
  if (attempts === null)
    return { action: "idle", jobId: job.id, reason: "claim_lost" };

  const result = await deliverPush(pushPayloadFor(job, incident), {
    ownerUserId: job.ownerUserId ?? undefined,
    vapid: context.config.vapid,
    transport: context.options.pushTransport,
  });
  switch (result.state) {
    case "accepted":
      return recordPushOutcome(context, job, "sent", null);
    case "no_subscriptions":
      return recordPushOutcome(
        context,
        job,
        "suppressed",
        "no_subscriptions",
      );
    case "suppressed":
      return recordPushOutcome(context, job, "suppressed", result.reason);
    case "failed":
      return recordPushOutcome(context, job, "failed", result.reason);
    case "uncertain":
      return recordPushOutcome(context, job, "uncertain", result.reason);
  }
}

/**
 * Runs one dispatch tick on the dedicated lock session: recover stale leases,
 * claim one job, then deliver it. No transaction stays open across the network.
 */
export async function runDispatchOnce(
  options: DispatcherOptions,
): Promise<DispatchResult> {
  const client = options.client;
  if (!(await holdsCollectionLock(client))) throw new CollectionLockLost();
  const now = (options.now ?? Date.now)();
  await recoverOutbox(
    client,
    now,
    options.maxAttempts ?? MAX_CONFIRMED_ATTEMPTS,
  );
  if (!(await holdsCollectionLock(client))) throw new CollectionLockLost();

  const token = options.claimToken?.() ?? randomUUID();
  const job = await claimOutboxJob(
    client,
    token,
    now,
    options.leaseMs ?? CLAIM_LEASE_MS,
  );
  if (!job) return { action: "idle" };

  const context: DispatcherContext = {
    client,
    config: options.config,
    token,
    now,
    options,
  };
  try {
    if (job.kind === "incident-edit") return await dispatchEdit(context, job);
    if (job.channel === "push") return await dispatchPushJob(context, job);
    if (job.kind === "incident-open" && job.channel === "telegram")
      return await dispatchTelegramOpening(context, job);
    return { action: "idle" };
  } catch (error) {
    if (error instanceof ClaimLostError)
      return { action: "idle", jobId: job.id, reason: "claim_lost" };
    throw error;
  }
}
