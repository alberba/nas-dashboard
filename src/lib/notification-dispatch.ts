import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { incidentHref } from "../components/views/routes";
import type { RuntimeConfig } from "./runtime-config";
import * as schema from "./schema";
import { incidents, notificationOutbox, type NotificationOutcome } from "./schema";
import { sendTelegramMessage, type TelegramTransport } from "./telegram";

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
  | "suppressed";

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
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)`,
    [at, iso],
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

/** Claims one due Telegram opening with a fresh token and lease. */
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
          AND kind = 'incident-open'
          AND channel = 'telegram'
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
  const [updated] = await db
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
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
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
  const [updated] = await db
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
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
  return {
    action: "retry",
    jobId: job.id,
    kind: job.kind,
    channel: job.channel,
    reason: "rate_limited",
  };
}

async function recordPermanentFailure(
  context: DispatcherContext,
  job: Job,
  reason: string,
): Promise<DispatchResult> {
  const db = workerDb(context.client);
  const [updated] = await db
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
  if (!updated) return { action: "idle", jobId: job.id, reason: "claim_lost" };
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
  await recoverOutbox(client, now);
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
  if (job.kind === "incident-open" && job.channel === "telegram")
    return dispatchTelegramOpening(context, job);
  return { action: "idle" };
}
