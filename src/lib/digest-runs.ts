import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import type { Client } from "pg";
import {
  DEFAULT_DIGEST_TIME,
  type RuntimeConfig,
} from "./runtime-config";
import * as schema from "./schema";
import { digestRuns, type NotificationOutcome } from "./schema";
import {
  madridDateOf,
  madridTarget,
  shiftCivilDate,
} from "./madrid-day";
import { buildDigestSnapshot, digestAlertsUrl } from "./digest-content";
import {
  beginTelegramCooldown,
  CollectionLockLost,
  holdsCollectionLock,
} from "./notification-dispatch";
import { sendTelegramMessage, type TelegramTransport } from "./telegram";

/**
 * Daily digest queue.
 *
 * `digest_runs` is the only authority for one Europe/Madrid civil date: the
 * claim, the durable attempt mark and the result live in that row, so no
 * second delivery row is needed. The SQL transaction always ends before the
 * provider request, and the dispatcher re-reads the clock immediately before
 * contacting Telegram: a commit that crosses `dueAt` must not start a request.
 */

/** Recovery window measured from the target: `[target, target + 2 h)`. */
export const DIGEST_WINDOW_MS = 2 * 60 * 60_000;
/** The HTTP request must finish well before its claim lease expires. */
export const DIGEST_LEASE_MS = 30_000;
export const DIGEST_REQUEST_TIMEOUT_MS = 10_000;
/** Confirmed rejections (429) allowed for one date. */
export const DIGEST_MAX_ATTEMPTS = 5;
/** Sanity bound for a configured civil time. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type DigestStatus =
  | "prepared"
  | "claimed"
  | "sent"
  | "empty"
  | "unconfigured"
  | "expired"
  | "failed"
  | "uncertain";

export type DigestTickAction =
  | "idle"
  | "prepared"
  | "sent"
  | "empty"
  | "unconfigured"
  | "expired"
  | "retry"
  | "failed"
  | "uncertain";

export type DigestTickResult = {
  action: DigestTickAction;
  date?: string;
  reason?: string;
};

export type DigestOptions = {
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

export type DigestRun = typeof digestRuns.$inferSelect;

/** Splits a validated `HH:mm` civil time. */
export function digestTimeParts(value: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(value);
  if (!match) throw new Error("DIGEST_TIME no es un horario válido");
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export type DigestSchedule = {
  date: string;
  /** Instant the digest is scheduled for. */
  target: Date;
  /** Previous target: start of the folded period. */
  periodStart: Date;
  /** Exclusive end of the recovery window. */
  dueAt: Date;
};

/** Schedule of one civil date at the configured Madrid time. */
export function digestSchedule(
  date: string,
  time = DEFAULT_DIGEST_TIME,
): DigestSchedule {
  const { hour, minute } = digestTimeParts(time);
  const target = madridTarget(date, hour, minute);
  return {
    date,
    target,
    periodStart: madridTarget(shiftCivilDate(date, -1), hour, minute),
    dueAt: new Date(target.getTime() + DIGEST_WINDOW_MS),
  };
}

function digestBackoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/**
 * Resolves leases left by a dead owner. An attempt that started may have been
 * accepted by the provider: it becomes uncertain and is never resent. A claim
 * that expired before the attempt mark is safe to reclaim inside the window.
 */
export async function recoverDigestRuns(
  client: Client,
  now: number,
): Promise<void> {
  const at = new Date(now);
  await client.query(
    `UPDATE digest_runs
        SET status = 'uncertain',
            reason = 'lease_expired_after_attempt',
            result = jsonb_build_object(
              'state', 'uncertain',
              'reason', 'lease_expired_after_attempt',
              'at', $2::text
            ),
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "finishedAt" = $1,
            "updatedAt" = $1
      WHERE status = 'claimed'
        AND "attemptStartedAt" IS NOT NULL
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)`,
    [at, at.toISOString()],
  );
  await client.query(
    `UPDATE digest_runs
        SET status = 'prepared',
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "updatedAt" = $1
      WHERE status = 'claimed'
        AND "attemptStartedAt" IS NULL
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)`,
    [at],
  );
}

/**
 * Inserts the missing run for every candidate date inside its window and
 * freezes its text. A cut without content closes empty — and without a
 * Telegram configuration closes as unconfigured — both without a request.
 */
export async function prepareDigestRuns(
  options: DigestOptions,
): Promise<DigestTickResult> {
  const clock = options.now ?? Date.now;
  const now = clock();
  const at = new Date(now);
  const time = options.config.digestTime;
  const today = madridDateOf(at);
  const scheduled = [today, shiftCivilDate(today, -1)].map((date) =>
    digestSchedule(date, time),
  );
  const live = scheduled.filter(
    (candidate) =>
      now >= candidate.target.getTime() && now < candidate.dueAt.getTime(),
  );

  // A run whose window closed before the attempt started can never be sent.
  await options.client.query(
    `UPDATE digest_runs
        SET status = 'expired',
            reason = 'window_closed',
            result = jsonb_build_object(
              'state', 'suppressed',
              'reason', 'window_closed',
              'at', $2::text
            ),
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "finishedAt" = $1,
            "updatedAt" = $1
      WHERE status IN ('prepared', 'claimed')
        AND "attemptStartedAt" IS NULL
        AND "dueAt" <= $1`,
    [at, at.toISOString()],
  );

  if (live.length > 0) {
    const alertsUrl = digestAlertsUrl(options.config.betterAuthUrl);
    const hostIds = options.config.hosts.map((host) => host.id);
    const hostNames = Object.fromEntries(
      options.config.hosts.map((host) => [host.id, host.name]),
    );
    let changed = false;
    await options.client.query("BEGIN");
    try {
      for (const candidate of live) {
        // A stored previous target keeps the cuts contiguous even when the
        // operator changed the schedule after that day was prepared.
        const previous = await options.client.query<{ targetAt: Date }>(
          `SELECT "targetAt" FROM digest_runs
            WHERE "date" < $1 ORDER BY "date" DESC LIMIT 1`,
          [candidate.date],
        );
        const { rowCount } = await options.client.query(
          `INSERT INTO digest_runs
             ("date", "targetAt", "periodStartAt", "dueAt", "nextAttemptAt",
              "preparedAt")
           VALUES ($1, $2, $3, $4, $2, $5)
           ON CONFLICT ("date") DO NOTHING`,
          [
            candidate.date,
            candidate.target,
            previous.rows[0]?.targetAt ?? candidate.periodStart,
            candidate.dueAt,
            at,
          ],
        );
        if (rowCount) changed = true;
      }
      const { rows } = await options.client.query<{
        id: number;
        targetAt: Date;
        periodStartAt: Date;
      }>(
        `SELECT id, "targetAt", "periodStartAt"
           FROM digest_runs
          WHERE "date" = ANY($1) AND status = 'prepared' AND payload IS NULL
          ORDER BY "targetAt" ASC, id ASC`,
        [live.map((candidate) => candidate.date)],
      );
      for (const row of rows) {
        if (!options.config.telegram) {
          await options.client.query(
            `UPDATE digest_runs
                SET status = 'unconfigured',
                    reason = 'telegram_disabled',
                    result = jsonb_build_object(
                      'state', 'suppressed',
                      'reason', 'telegram_disabled',
                      'at', $2::text
                    ),
                    "finishedAt" = $1,
                    "updatedAt" = $1
              WHERE id = $3 AND status = 'prepared'`,
            [at, at.toISOString(), row.id],
          );
          changed = true;
          continue;
        }
        const snapshot = await buildDigestSnapshot({
          client: options.client,
          hostIds,
          hostNames,
          periodStart: row.periodStartAt,
          periodEnd: row.targetAt,
          snapshotAt: at,
          alertsUrl,
        });
        if (!snapshot) {
          await options.client.query(
            `UPDATE digest_runs
                SET status = 'empty',
                    reason = 'digest_empty',
                    result = jsonb_build_object(
                      'state', 'suppressed',
                      'reason', 'digest_empty',
                      'at', $2::text
                    ),
                    "finishedAt" = $1,
                    "updatedAt" = $1
              WHERE id = $3 AND status = 'prepared'`,
            [at, at.toISOString(), row.id],
          );
        } else {
          await options.client.query(
            `UPDATE digest_runs
                SET payload = $2,
                    "preparedAt" = $1,
                    "updatedAt" = $1
              WHERE id = $3 AND status = 'prepared' AND payload IS NULL`,
            [at, snapshot.text, row.id],
          );
        }
        changed = true;
      }
      await options.client.query("COMMIT");
    } catch (error) {
      await options.client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    if (!changed) return { action: "idle" };
  }

  await recordMissedRun(options.client, now, time, live);
  return live.length === 0 ? { action: "idle" } : { action: "prepared" };
}

/**
 * After a stop of several days the latest digest whose window already closed is
 * recorded once as an omission. Older days are never replayed: a return to
 * service must not produce a burst of stale summaries.
 */
async function recordMissedRun(
  client: Client,
  now: number,
  time: string,
  live: DigestSchedule[],
): Promise<void> {
  const at = new Date(now);
  const today = madridDateOf(at);
  const date =
    now < digestSchedule(today, time).dueAt.getTime()
      ? shiftCivilDate(today, -1)
      : today;
  // A live candidate already covers this date.
  if (live.some((candidate) => candidate.date === date)) return;
  const gap = await client.query<{ recorded: boolean; history: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM digest_runs WHERE "date" = $1) AS recorded,
       EXISTS (SELECT 1 FROM digest_runs WHERE "date" < $1) AS history`,
    [date],
  );
  // No older digest exists (nothing was missed), or the omission is already
  // recorded. Either way no second marker is written.
  if (gap.rows[0]?.recorded !== false || gap.rows[0]?.history !== true) return;
  const missed = digestSchedule(date, time);
  await client.query(
    `INSERT INTO digest_runs
       ("date", "targetAt", "periodStartAt", "dueAt", status, reason,
        result, "preparedAt", "finishedAt")
     VALUES ($1, $2, $3, $4, 'expired', 'digest_missed',
        jsonb_build_object('state', 'suppressed', 'reason', 'digest_missed', 'at', $5::text),
        $6, $6)
     ON CONFLICT ("date") DO NOTHING`,
    [
      missed.date,
      missed.target,
      missed.periodStart,
      missed.dueAt,
      at.toISOString(),
      at,
    ],
  );
}

/**
 * Claims one due run with a fresh token and lease. The Telegram cooldown is
 * checked here as well so a row inserted after a 429 can never start a request
 * before the provider allows it.
 */
export async function claimDigestRun(
  client: Client,
  token: string,
  now: number,
  leaseMs = DIGEST_LEASE_MS,
): Promise<DigestRun | null> {
  const at = new Date(now);
  const lease = new Date(now + leaseMs);
  const { rows } = await client.query<{ id: number }>(
    `WITH candidate AS (
       SELECT id FROM digest_runs
        WHERE status IN ('prepared', 'claimed')
          AND "attemptStartedAt" IS NULL
          AND "nextAttemptAt" <= $1
          AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)
          AND NOT EXISTS (
            SELECT 1 FROM telegram_cooldown c WHERE c."until" > $1
          )
        ORDER BY "targetAt" ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE digest_runs AS d
        SET status = 'claimed',
            "claimToken" = $2,
            "leaseUntil" = $3,
            "updatedAt" = $1
       FROM candidate
      WHERE d.id = candidate.id
      RETURNING d.id`,
    [at, token, lease],
  );
  if (!rows[0]) return null;
  const db = drizzle(client, { schema });
  const [run] = await db
    .select()
    .from(digestRuns)
    .where(eq(digestRuns.id, rows[0].id))
    .limit(1);
  return run ?? null;
}

/**
 * Durable start of the request. It is conditional on the current token, a live
 * lease, an open window and an inactive cooldown, so no caller can contact the
 * provider after `dueAt` or during a pause.
 */
export async function beginDigestAttempt(
  client: Client,
  id: number,
  token: string,
  now: number,
): Promise<number | null> {
  const at = new Date(now);
  const { rows } = await client.query<{ attempts: number }>(
    `UPDATE digest_runs
        SET "attemptStartedAt" = $3,
            attempts = attempts + 1,
            "updatedAt" = $3
      WHERE id = $1
        AND "claimToken" = $2
        AND status = 'claimed'
        AND "attemptStartedAt" IS NULL
        AND ("leaseUntil" IS NULL OR "leaseUntil" > $3)
        AND "dueAt" > $3
        AND NOT EXISTS (
          SELECT 1 FROM telegram_cooldown c WHERE c."until" > $3
        )
      RETURNING attempts`,
    [id, token, at],
  );
  return rows[0]?.attempts ?? null;
}

/** Records a terminal state only for the owner of the current claim. */
async function finishDigestRun(
  client: Client,
  id: number,
  token: string,
  now: number,
  status: DigestStatus,
  reason: string,
  state: NotificationOutcome["state"],
): Promise<boolean> {
  const at = new Date(now);
  const { rowCount } = await client.query(
    `UPDATE digest_runs
        SET status = $4,
            reason = $5,
            result = jsonb_build_object('state', $6::text, 'reason', $5::text, 'at', $7::text),
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "finishedAt" = $3,
            "updatedAt" = $3
      WHERE id = $1 AND "claimToken" = $2 AND status = 'claimed'`,
    [id, token, at, status, reason, state, at.toISOString()],
  );
  return (rowCount ?? 0) > 0;
}

async function recordDigestSent(
  client: Client,
  run: DigestRun,
  token: string,
  now: number,
): Promise<void> {
  await finishDigestRun(client, run.id, token, now, "sent", "digest_sent", "sent");
}

async function recordDigestFailure(
  client: Client,
  run: DigestRun,
  token: string,
  now: number,
  reason: string,
): Promise<void> {
  await finishDigestRun(
    client,
    run.id,
    token,
    now,
    "failed",
    reason,
    "failed",
  );
}

async function recordDigestUncertain(
  client: Client,
  run: DigestRun,
  token: string,
  now: number,
  reason: string,
): Promise<void> {
  await finishDigestRun(
    client,
    run.id,
    token,
    now,
    "uncertain",
    reason,
    "uncertain",
  );
}

/**
 * A confirmed 429 keeps the episode's frozen text and reschedules it inside the
 * remaining window. The shared cooldown starts at the reception instant, so
 * every Telegram delivery of this bot respects it. Exhausting the attempt
 * budget or reaching the deadline ends the day with a finite reason.
 */
async function recordDigestRetry(
  options: DigestOptions,
  run: DigestRun,
  token: string,
  attempts: number,
  retryAfterMs: number | null,
  now: number,
): Promise<DigestTickResult> {
  const client = options.client;
  const delay =
    retryAfterMs && retryAfterMs > 0 ? retryAfterMs : digestBackoffMs(attempts);
  const deadline = now + delay;
  await beginTelegramCooldown(client, deadline, "rate_limited", now);
  const maxAttempts = options.maxAttempts ?? DIGEST_MAX_ATTEMPTS;
  if (attempts >= maxAttempts) {
    await recordDigestFailure(
      client,
      run,
      token,
      now,
      "retry_budget_exhausted",
    );
    return {
      action: "failed",
      date: run.date,
      reason: "retry_budget_exhausted",
    };
  }
  if (deadline >= run.dueAt.getTime()) {
    await recordDigestFailure(client, run, token, now, "window_closed");
    return { action: "failed", date: run.date, reason: "window_closed" };
  }
  const at = new Date(now);
  await client.query(
    `UPDATE digest_runs
        SET status = 'prepared',
            "nextAttemptAt" = $3,
            result = jsonb_build_object('state', 'failed', 'reason', 'rate_limited', 'at', $5::text),
            reason = 'rate_limited',
            "attemptStartedAt" = NULL,
            "claimToken" = NULL,
            "leaseUntil" = NULL,
            "updatedAt" = $4
      WHERE id = $1 AND "claimToken" = $2 AND status = 'claimed'`,
    [run.id, token, new Date(deadline), at, at.toISOString()],
  );
  return { action: "retry", date: run.date, reason: "rate_limited" };
}

/** Terminal expiry that only the live owner of the claim may record. */
async function expireDigestRun(
  client: Client,
  run: DigestRun,
  token: string,
  now: number,
): Promise<DigestTickResult> {
  const expired = await finishDigestRun(
    client,
    run.id,
    token,
    now,
    "expired",
    "window_closed",
    "suppressed",
  );
  return expired
    ? { action: "expired", date: run.date, reason: "window_closed" }
    : { action: "idle", date: run.date, reason: "claim_lost" };
}

async function dispatchDigestRun(
  options: DigestOptions,
  run: DigestRun,
  token: string,
  startedAt: number,
): Promise<DigestTickResult> {
  const client = options.client;
  const telegram = options.config.telegram;
  if (!telegram) {
    await finishDigestRun(
      client,
      run.id,
      token,
      startedAt,
      "unconfigured",
      "telegram_disabled",
      "suppressed",
    );
    return {
      action: "unconfigured",
      date: run.date,
      reason: "telegram_disabled",
    };
  }
  if (!run.payload) {
    await finishDigestRun(
      client,
      run.id,
      token,
      startedAt,
      "empty",
      "digest_empty",
      "suppressed",
    );
    return { action: "empty", date: run.date, reason: "digest_empty" };
  }

  const attempts = await beginDigestAttempt(client, run.id, token, startedAt);
  if (attempts === null)
    return { action: "idle", date: run.date, reason: "claim_lost" };

  // Re-read the clock immediately before the request. The commit of the start
  // mark may have crossed `dueAt`; this owner knows no request was sent yet, so
  // only it can close the day as expired with the same token.
  const clock = options.now ?? Date.now;
  const beforeRequest = clock();
  if (beforeRequest >= run.dueAt.getTime())
    return expireDigestRun(client, run, token, beforeRequest);

  const result = await sendTelegramMessage(
    {
      chatId: telegram.chatId,
      text: run.payload,
      buttonUrl: digestAlertsUrl(options.config.betterAuthUrl),
    },
    {
      botToken: telegram.botToken,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      timeoutMs: options.requestTimeoutMs ?? DIGEST_REQUEST_TIMEOUT_MS,
    },
  );

  switch (result.state) {
    case "sent":
      await recordDigestSent(client, run, token, beforeRequest);
      return { action: "sent", date: run.date };
    case "retry":
      return recordDigestRetry(
        options,
        run,
        token,
        attempts,
        result.retryAfterMs,
        beforeRequest,
      );
    case "rejected":
      await recordDigestFailure(
        client,
        run,
        token,
        beforeRequest,
        result.reason,
      );
      return { action: "failed", date: run.date, reason: result.reason };
    case "uncertain":
      await recordDigestUncertain(
        client,
        run,
        token,
        beforeRequest,
        result.reason,
      );
      return { action: "uncertain", date: run.date, reason: result.reason };
  }
}

/**
 * One digest opportunity on the lock session. It runs at most one attempt, so
 * the worker can interleave it with individual deliveries without holding a
 * transaction across the network.
 */
export async function runDigestOnce(
  options: DigestOptions,
): Promise<DigestTickResult> {
  const client = options.client;
  if (!(await holdsCollectionLock(client))) throw new CollectionLockLost();
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  await recoverDigestRuns(client, startedAt);
  await prepareDigestRuns({ ...options, now: () => startedAt });
  if (!(await holdsCollectionLock(client))) throw new CollectionLockLost();

  const token = options.claimToken?.() ?? randomUUID();
  const run = await claimDigestRun(
    client,
    token,
    startedAt,
    options.leaseMs ?? DIGEST_LEASE_MS,
  );
  if (!run) return { action: "idle" };
  return dispatchDigestRun(options, run, token, startedAt);
}
