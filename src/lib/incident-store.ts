import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "./db";
import {
  incidentEvents,
  incidents,
  notificationOutbox,
  type NotificationOutcome,
} from "./schema";
import type {
  Alert,
  PublicDelivery,
  PublicDeliveryChannel,
  PublicDeliveryReason,
  PublicDeliveryState,
} from "./types";

/** How the caller wants the first notice of a new episode delivered. */
export type IncidentDeliveryChannel = "telegram" | "push" | "digest" | "silent";

export type IncidentDelivery = {
  channel: IncidentDeliveryChannel;
  /** Finite reason persisted when the notice is not sent immediately. */
  reason?: string;
};

export type IncidentObservation = {
  hostId: string;
  key: string;
  failing: boolean;
  severity?: string;
  title?: string;
  detail?: string;
  /** Injected clock in milliseconds; defaults to `Date.now()`. */
  now?: number;
  /** Caller-provided channel disposition, never chosen inside the transaction. */
  delivery?: IncidentDelivery;
  closedBy?: "collector" | "lifecycle";
};

export type IncidentObservationResult = {
  action: "ignored" | "observed" | "opened" | "escalated" | "resolved";
  incidentId?: number;
  seq?: number;
  delivery: "queued" | "none";
};

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const immediateChannels = new Set<IncidentDeliveryChannel>(["telegram", "push"]);

function isImmediate(delivery: IncidentDelivery | undefined) {
  return Boolean(delivery && immediateChannels.has(delivery.channel));
}

function openKey(incidentId: number) {
  return `incident:${incidentId}:open`;
}

function editKey(incidentId: number, seq: number) {
  return `incident:${incidentId}:edit:${seq}`;
}

/**
 * Stable identity of the watched condition. The length prefixes make the
 * concatenation injective and exactly match the 0004 backfill:
 * md5('incident:' || length(hostId) || ':' || hostId || ':' || length(key) ||
 * ':' || key). The same pair keeps this value across episodes and restarts.
 */
export function incidentFingerprint(hostId: string, key: string): string {
  return createHash("md5")
    .update(`incident:${hostId.length}:${hostId}:${key.length}:${key}`)
    .digest("hex");
}

function suppressed(reason: string, at: Date) {
  return { state: "suppressed" as const, reason, at: at.toISOString() };
}

async function suppressPending(
  tx: Transaction,
  incidentId: number,
  reason: string,
  at: Date,
) {
  await tx
    .update(notificationOutbox)
    .set({
      status: "suppressed",
      updatedAt: at,
      result: suppressed(reason, at),
      // A preempted claim must not be usable by a dispatcher that already read
      // the row but has not started the request yet.
      claimToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(notificationOutbox.incidentId, incidentId),
        inArray(notificationOutbox.status, ["pending", "claimed"]),
        isNull(notificationOutbox.attemptStartedAt),
      ),
    );
}

/**
 * Closes an episode inside the caller's transaction. A pending opening is
 * cancelled, never sent; a confirmed Telegram message gets an ordered edit.
 * No recovery message is ever created.
 */
async function closeEpisode(
  tx: Transaction,
  open: typeof incidents.$inferSelect,
  seq: number,
  at: Date,
): Promise<"queued" | "none"> {
  const [first] = await tx
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.key, openKey(open.id)))
    .limit(1);
  if (!first) return "none";

  if (
    (first.status === "pending" && !first.attemptStartedAt) ||
    (first.status === "claimed" && !first.attemptStartedAt)
  ) {
    await suppressPending(tx, open.id, "resolved_before_send", at);
    return "none";
  }

  if (
    first.status === "sent" &&
    first.channel === "telegram" &&
    first.chatId &&
    first.messageId
  ) {
    await tx.insert(notificationOutbox).values({
      key: editKey(open.id, seq),
      incidentId: open.id,
      kind: "incident-edit",
      channel: "telegram",
      status: "pending",
      revision: seq,
      chatId: first.chatId,
      messageId: first.messageId,
    });
    return "queued";
  }

  return "none";
}

/**
 * Applies a severity change to a live episode. A first notice that has not
 * started follows the new disposition (an escalation to immediate becomes
 * pending, a downgrade becomes suppressed). A confirmed Telegram message gets
 * an edit; a push or an uncertain delivery is never re-sent.
 */
async function changeSeverity(
  tx: Transaction,
  incident: typeof incidents.$inferSelect,
  seq: number,
  at: Date,
  delivery: IncidentDelivery | undefined,
): Promise<"queued" | "none"> {
  const [first] = await tx
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.key, openKey(incident.id)))
    .limit(1);
  if (!first) {
    if (isImmediate(delivery)) {
      await tx.insert(notificationOutbox).values({
        key: openKey(incident.id),
        incidentId: incident.id,
        kind: "incident-open",
        channel: delivery!.channel,
        status: "pending",
        revision: seq,
      });
      return "queued";
    }
    return "none";
  }

  if (
    (first.status === "pending" && !first.attemptStartedAt) ||
    ((first.status === "claimed" || first.status === "suppressed") &&
      !first.attemptStartedAt &&
      !first.messageId)
  ) {
    if (isImmediate(delivery)) {
      await tx
        .update(notificationOutbox)
        .set({
          channel: delivery!.channel,
          status: "pending",
          revision: seq,
          result: null,
          updatedAt: at,
          // Replace the pending opening before its send starts: any claim
          // already handed out is no longer valid.
          claimToken: null,
          leaseUntil: null,
          attemptStartedAt: null,
        })
        .where(eq(notificationOutbox.id, first.id));
      return "queued";
    }
    await tx
      .update(notificationOutbox)
      .set({
        channel: delivery?.channel ?? first.channel,
        status: "suppressed",
        revision: seq,
        updatedAt: at,
        result: suppressed(delivery?.reason ?? "policy_silent", at),
        claimToken: null,
        leaseUntil: null,
      })
      .where(eq(notificationOutbox.id, first.id));
    return "none";
  }

  if (
    first.status === "sent" &&
    first.channel === "telegram" &&
    first.chatId &&
    first.messageId
  ) {
    await tx.insert(notificationOutbox).values({
      key: editKey(incident.id, seq),
      incidentId: incident.id,
      kind: "incident-edit",
      channel: "telegram",
      status: "pending",
      revision: seq,
      chatId: first.chatId,
      messageId: first.messageId,
    });
    return "queued";
  }

  return "none";
}

/**
 * Records one health observation for a (hostId, key) condition. The episode
 * transition, its timeline event and the outbox work are written in a single
 * transaction: if the outbox insert fails, neither the episode nor the event
 * persists. Opening is arbitrated by the partial unique index plus a re-read;
 * a re-read after a conflict never counts as another opening.
 */
export async function recordIncidentObservation(
  input: IncidentObservation,
): Promise<IncidentObservationResult> {
  const now = input.now ?? Date.now();
  const at = new Date(now);

  return db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.hostId, input.hostId),
          eq(incidents.key, input.key),
          isNull(incidents.resolvedAt),
        ),
      )
      .limit(1)
      .for("update");

    if (!input.failing) {
      if (!open) return { action: "ignored", delivery: "none" };
      const seq = open.seq + 1;
      await tx
        .update(incidents)
        .set({
          resolvedAt: at,
          seq,
          closedBy: input.closedBy ?? "collector",
        })
        .where(eq(incidents.id, open.id));
      await tx.insert(incidentEvents).values({
        incidentId: open.id,
        seq,
        kind: "closed",
        severity: open.severity,
        title: open.title,
        detail: open.detail,
        at,
      });
      if (open.origin === "legacy") {
        await suppressPending(tx, open.id, "legacy_open", at);
        return { action: "resolved", incidentId: open.id, seq, delivery: "none" };
      }
      const delivery = await closeEpisode(tx, open, seq, at);
      return { action: "resolved", incidentId: open.id, seq, delivery };
    }

    const severity = input.severity ?? open?.severity ?? "warning";
    const title = input.title ?? open?.title ?? input.key;
    const detail = input.detail ?? "";

    if (open) {
      if (open.severity === severity) {
        return {
          action: "observed",
          incidentId: open.id,
          seq: open.seq,
          delivery: "none",
        };
      }
      const seq = open.seq + 1;
      await tx
        .update(incidents)
        .set({ severity, title, detail, seq })
        .where(eq(incidents.id, open.id));
      await tx.insert(incidentEvents).values({
        incidentId: open.id,
        seq,
        kind: "severity",
        severity,
        title,
        detail,
        at,
      });
      if (open.origin === "legacy") {
        await suppressPending(tx, open.id, "legacy_open", at);
        return {
          action: "escalated",
          incidentId: open.id,
          seq,
          delivery: "none",
        };
      }
      const delivery = await changeSeverity(tx, open, seq, at, input.delivery);
      return {
        action: "escalated",
        incidentId: open.id,
        seq,
        delivery,
      };
    }

    const [created] = await tx
      .insert(incidents)
      .values({
        hostId: input.hostId,
        key: input.key,
        title,
        detail,
        severity,
        at,
        fingerprint: incidentFingerprint(input.hostId, input.key),
        seq: 1,
        origin: "live",
      })
      .onConflictDoNothing()
      .returning();

    if (!created) {
      const [current] = await tx
        .select()
        .from(incidents)
        .where(
          and(
            eq(incidents.hostId, input.hostId),
            eq(incidents.key, input.key),
            isNull(incidents.resolvedAt),
          ),
        )
        .limit(1);
      if (!current) throw new Error("No se pudo abrir la incidencia");
      return {
        action: "observed",
        incidentId: current.id,
        seq: current.seq,
        delivery: "none",
      };
    }

    await tx.insert(incidentEvents).values({
      incidentId: created.id,
      seq: 1,
      kind: "opened",
      severity,
      title,
      detail,
      at,
    });

    if (isImmediate(input.delivery)) {
      await tx.insert(notificationOutbox).values({
        key: openKey(created.id),
        incidentId: created.id,
        kind: "incident-open",
        channel: input.delivery!.channel,
        status: "pending",
        revision: 1,
      });
      return { action: "opened", incidentId: created.id, seq: 1, delivery: "queued" };
    }

    await tx.insert(notificationOutbox).values({
      key: openKey(created.id),
      incidentId: created.id,
      kind: "incident-open",
      channel: input.delivery?.channel ?? "silent",
      status: "suppressed",
      revision: 1,
      result: suppressed(
        input.delivery?.reason ?? "policy_silent",
        at,
      ),
    });
    return { action: "opened", incidentId: created.id, seq: 1, delivery: "none" };
  });
}

const deliveryChannels = new Set<PublicDeliveryChannel>([
  "telegram",
  "push",
  "digest",
  "silent",
]);

/**
 * The only reasons the hub publishes. Provider messages, endpoints and raw
 * errors are mapped into these values instead of being forwarded.
 */
const finiteReasons: Record<string, PublicDeliveryReason> = {
  legacy_open: "legacy_open",
  digest_pending: "digest_pending",
  policy_silent: "policy_silent",
  telegram_disabled: "telegram_disabled",
  push_disabled: "telegram_disabled",
  resolved_before_send: "policy_silent",
  owner_required: "policy_silent",
  no_subscriptions: "policy_silent",
  superseded_by_later_seq: "policy_silent",
};

function publicChannel(value: string | null): PublicDeliveryChannel | null {
  return value && deliveryChannels.has(value as PublicDeliveryChannel)
    ? (value as PublicDeliveryChannel)
    : null;
}

function publicState(
  state: string,
  result: NotificationOutcome | null,
): PublicDeliveryState {
  if (result?.state) return result.state;
  if (state === "claimed" || state === "pending") return "pending";
  if (state === "sent" || state === "failed") return state;
  if (state === "suppressed" || state === "uncertain") return state;
  return "none";
}

function publicReason(
  state: PublicDeliveryState,
  reason: string | null,
): PublicDeliveryReason | null {
  if (state === "pending" || state === "sent" || state === "none")
    return null;
  if (state === "uncertain") return "uncertain";
  if (state === "failed") return "permanent_rejection";
  return finiteReasons[reason ?? ""] ?? "policy_silent";
}

type OutboxJob = typeof notificationOutbox.$inferSelect;

function deliveryOf(job: OutboxJob, result: NotificationOutcome | null) {
  const state = publicState(job.status, result);
  return {
    channel: publicChannel(job.channel),
    state,
    reason: publicReason(state, result?.reason ?? null),
  } satisfies PublicDelivery;
}

const emptyDelivery: PublicDelivery = {
  channel: null,
  state: "none",
  reason: null,
};

/**
 * Shared public projection for the overview list and the point lookup. It
 * keeps the initial result, the push fallback and the last edit separate and
 * never exposes claim tokens, Telegram destinations or provider bodies.
 */
export async function projectIncidents(
  rows: (typeof incidents.$inferSelect)[],
): Promise<Alert[]> {
  if (!rows.length) return [];
  const jobs = await db
    .select()
    .from(notificationOutbox)
    .where(
      inArray(
        notificationOutbox.incidentId,
        rows.map((row) => row.id),
      ),
    );
  const byIncident = new Map<number, OutboxJob[]>();
  for (const job of jobs) {
    if (job.incidentId === null) continue;
    const group = byIncident.get(job.incidentId);
    if (group) group.push(job);
    else byIncident.set(job.incidentId, [job]);
  }

  return rows.map((row) => {
    const group = byIncident.get(row.id) ?? [];
    const opening = group.find((job) => job.kind === "incident-open");
    const edits = group
      .filter((job) => job.kind === "incident-edit")
      .sort((a, b) => b.revision - a.revision || b.id - a.id);
    const latestEdit = edits[0];
    const fallback = opening?.fallbackResult;
    return {
      id: row.id,
      hostId: row.hostId,
      key: row.key,
      title: row.title,
      detail: row.detail,
      severity: row.severity,
      at: row.at.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      seq: row.seq,
      delivery: opening
        ? deliveryOf(opening, opening.result ?? null)
        : emptyDelivery,
      fallback: fallback
        ? {
            channel: "push" as const,
            state: fallback.state,
            reason: publicReason(fallback.state, fallback.reason),
          }
        : null,
      lastUpdate: latestEdit
        ? deliveryOf(latestEdit, latestEdit.editResult ?? null)
        : null,
    } satisfies Alert;
  });
}

/**
 * Removes episodes past retention, together with their terminal delivery
 * state, but keeps any episode that still has live work (pending or claimed).
 * Orphan push-test rows are removed by their own age. The incident cascade
 * deletes its events and terminal outbox rows in the same statement.
 */
export async function cleanupExpiredIncidents(cutoff: Date): Promise<void> {
  await db.execute(sql`
    DELETE FROM "incidents" AS i
    WHERE i."at" < ${cutoff}
      AND i."resolvedAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "notification_outbox" AS o
        WHERE o."incidentId" = i."id"
          AND o."status" IN ('pending', 'claimed')
      )
  `);
  await db
    .delete(notificationOutbox)
    .where(
      and(
        isNull(notificationOutbox.incidentId),
        lt(notificationOutbox.createdAt, cutoff),
      ),
    );
}
