import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, like, lt, lte, sql } from "drizzle-orm";
import { db } from "./db";
import {
  incidentEvents,
  incidents,
  notificationOutbox,
  samples,
  type NotificationOutcome,
} from "./schema";
import type {
  Alert,
  IncidentInventoryContext,
  IncidentInventoryEntry,
  Metrics,
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
  closedBy?: "collector" | "lifecycle" | "reconciliation";
  /** Inventory captured only when a `connection` episode is actually created. */
  context?: IncidentInventoryContext | null;
  /** Removes the observation block after valid evidence for a container. */
  clearObservation?: boolean;
  /**
   * For a `connection` observation: block the open container episodes of the
   * same host in the same transaction. The reason is persisted on each row.
   */
  inhibitContainers?: { reason: string };
};

export type IncidentObservationResult = {
  action: "ignored" | "observed" | "opened" | "escalated" | "resolved";
  incidentId?: number;
  seq?: number;
  delivery: "queued" | "none";
  /** Container episodes whose observation block changed in this transaction. */
  inhibitedIncidentIds?: number[];
};

export type Transaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/** Public inventory list bound: the UI shows the rest as an omitted count. */
export const INCIDENT_INVENTORY_LIMIT = 50;
/** Finite cause persisted when a host outage blocks a container episode. */
export const HOST_UNREACHABLE_REASON = "host-unreachable";
const CONTAINER_PREFIX = "container:";

/** Public episode kind derived from the audited durable key. */
export function incidentKind(
  key: string,
): "services-down" | "container" | "condition" {
  if (key === "connection") return "services-down";
  if (key.startsWith(CONTAINER_PREFIX)) return "container";
  return "condition";
}

function inventoryObservation(
  value: unknown,
): { observedAt: number; observedFrom: "inventory" | "sample" } | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  return { observedAt: value, observedFrom: "inventory" };
}

/**
 * Builds the public inventory snapshot from one stored sample. A genuinely
 * empty container list is complete evidence; a missing list or a missing
 * sample is absence of evidence and stays `complete: false`.
 */
export function inventoryContextFromSample(
  sample: { at: Date; data: unknown } | undefined,
): IncidentInventoryContext {
  const unknown: IncidentInventoryContext = {
    kind: "services-down",
    observedAt: null,
    observedFrom: "unknown",
    complete: false,
    entries: [],
    omitted: 0,
  };
  if (!sample) return unknown;
  const data = sample.data as Metrics | null;
  if (!data || !Array.isArray(data.containers)) return unknown;
  const entries: IncidentInventoryEntry[] = data.containers
    .filter(
      (item) =>
        Boolean(item) &&
        typeof item.name === "string" &&
        item.name.length > 0 &&
        typeof item.state === "string" &&
        item.state.length > 0,
    )
    .map((item) => ({ name: item.name, state: item.state }));
  const marker = inventoryObservation(data.containersObservedAt);
  return {
    kind: "services-down",
    observedAt: marker?.observedAt ?? sample.at.getTime() / 1000,
    observedFrom: marker?.observedFrom ?? "sample",
    complete: true,
    entries: entries.slice(0, INCIDENT_INVENTORY_LIMIT),
    omitted: Math.max(0, entries.length - INCIDENT_INVENTORY_LIMIT),
  };
}

/** Last stored inventory at or before `before`; never a remote inspection. */
export async function captureServiceInventory(
  hostId: string,
  before: Date,
): Promise<IncidentInventoryContext> {
  const [sample] = await db
    .select({ at: samples.at, data: samples.data })
    .from(samples)
    .where(and(eq(samples.hostId, hostId), lte(samples.at, before)))
    .orderBy(desc(samples.at))
    .limit(1);
  return inventoryContextFromSample(sample);
}

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
 * Queues one silent edit of the confirmed Telegram notice for `seq`. It is the
 * only writer of `incident-edit` rows, shared by closures, severity changes and
 * operator actions, so every state change reaches the message the same way. No
 * confirmed message means no edit: nothing is ever re-sent.
 */
export async function queueEdit(
  tx: Transaction,
  incidentId: number,
  seq: number,
): Promise<"queued" | "none"> {
  const [first] = await tx
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.key, openKey(incidentId)))
    .limit(1);
  if (
    !first ||
    first.status !== "sent" ||
    first.channel !== "telegram" ||
    !first.chatId ||
    !first.messageId
  )
    return "none";
  await tx.insert(notificationOutbox).values({
    key: editKey(incidentId, seq),
    incidentId,
    kind: "incident-edit",
    channel: "telegram",
    status: "pending",
    revision: seq,
    chatId: first.chatId,
    messageId: first.messageId,
  });
  return "queued";
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
  )
    return queueEdit(tx, open.id, seq);

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
  )
    return queueEdit(tx, incident.id, seq);

  return "none";
}

/**
 * Blocks the open container episodes of the same host inside the caller's
 * transaction. The group row is already locked; containers are locked in id
 * order, so repeated outages cannot interleave two inhibition revisions. The
 * block never closes an episode, never changes its severity and never creates
 * delivery work.
 */
async function inhibitOpenContainers(
  tx: Transaction,
  group: { id: number; hostId: string },
  reason: string,
  at: Date,
): Promise<number[]> {
  const rows = await tx
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.hostId, group.hostId),
        like(incidents.key, `${CONTAINER_PREFIX}%`),
        isNull(incidents.resolvedAt),
      ),
    )
    .orderBy(asc(incidents.id))
    .for("update");
  const changed: number[] = [];
  for (const row of rows) {
    if (
      row.inhibitedBy === group.id &&
      row.inhibitedReason === reason &&
      row.observationPending
    )
      continue;
    const seq = row.seq + 1;
    await tx
      .update(incidents)
      .set({
        seq,
        inhibitedBy: group.id,
        inhibitedReason: reason,
        observationPending: true,
      })
      .where(eq(incidents.id, row.id));
    await tx.insert(incidentEvents).values({
      incidentId: row.id,
      seq,
      kind: "inhibited",
      severity: row.severity,
      title: row.title,
      detail: reason,
      at,
    });
    changed.push(row.id);
  }
  return changed;
}

/**
 * Marks an open container episode as waiting for its name to reappear in a
 * fresh, complete inventory. Only the observation block changes: the episode,
 * its ID, history and delivery stay untouched (D-06).
 */
export async function markContainerObservationPendingIn(
  tx: Transaction,
  input: { hostId: string; key: string; reason: string; now?: number },
): Promise<number | null> {
  const at = new Date(input.now ?? Date.now());
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
  if (!open) return null;
  if (
    open.inhibitedBy === null &&
    open.inhibitedReason === input.reason &&
    open.observationPending
  )
    return open.id;
  const seq = open.seq + 1;
  await tx
    .update(incidents)
    .set({
      seq,
      inhibitedBy: null,
      inhibitedReason: input.reason,
      observationPending: true,
    })
    .where(eq(incidents.id, open.id));
  await tx.insert(incidentEvents).values({
    incidentId: open.id,
    seq,
    kind: "pending",
    severity: open.severity,
    title: open.title,
    detail: input.reason,
    at,
  });
  return open.id;
}

export type ContainerWatchTransfer = {
  hostId: string;
  fromName: string;
  toName: string;
  /** Title showing the new reference, already formatted by the caller. */
  title: string;
  now?: number;
  /** True when the confirmed replacement is running (D-08). */
  running: boolean;
  /** Close an existing destination episode only when it is the same watch. */
  mergeDestination: boolean;
};

export type ContainerWatchTransferResult = {
  action: "none" | "transferred" | "closed" | "blocked";
  incidentId?: number;
  closedIncidentId?: number;
};

/**
 * Moves the open episode of a watched name to its proven replacement. The row
 * keeps its ID, opening date, origin, delivery result and outbox keys; only
 * the operational key, its fingerprint and the visible title move. A running
 * replacement closes the episode with the phase 2 closure; a stopped one
 * resumes the same row. A destination episode is only closed when the caller
 * proved it is the same watch.
 */
export async function transferContainerWatchIn(
  tx: Transaction,
  input: ContainerWatchTransfer,
): Promise<ContainerWatchTransferResult> {
  const at = new Date(input.now ?? Date.now());
  const fromKey = `${CONTAINER_PREFIX}${input.fromName}`;
  const toKey = `${CONTAINER_PREFIX}${input.toName}`;
  const rows = await tx
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.hostId, input.hostId),
        inArray(incidents.key, [fromKey, toKey]),
        isNull(incidents.resolvedAt),
      ),
    )
    .orderBy(asc(incidents.id))
    .for("update");
  const from = rows.find((row) => row.key === fromKey);
  const destination = rows.find((row) => row.key === toKey);
  if (!from)
    return destination
      ? { action: "blocked", closedIncidentId: destination.id }
      : { action: "none" };
  if (destination && !input.mergeDestination)
    return {
      action: "blocked",
      incidentId: from.id,
      closedIncidentId: destination.id,
    };

  if (destination)
    await recordIncidentObservationIn(tx, {
      hostId: input.hostId,
      key: toKey,
      failing: false,
      now: at.getTime(),
      closedBy: "collector",
    });

  const seq = from.seq + 1;
  await tx
    .update(incidents)
    .set({
      key: toKey,
      fingerprint: incidentFingerprint(input.hostId, toKey),
      title: input.title,
      seq,
    })
    .where(eq(incidents.id, from.id));
  await tx.insert(incidentEvents).values({
    incidentId: from.id,
    seq,
    kind: "reassigned",
    severity: from.severity,
    title: input.title,
    detail: `${fromKey} -> ${toKey}`,
    at,
  });

  if (input.running) {
    await recordIncidentObservationIn(tx, {
      hostId: input.hostId,
      key: toKey,
      failing: false,
      now: at.getTime(),
      closedBy: "collector",
    });
    return {
      action: "closed",
      incidentId: from.id,
      ...(destination ? { closedIncidentId: destination.id } : {}),
    };
  }

  await recordIncidentObservationIn(tx, {
    hostId: input.hostId,
    key: toKey,
    failing: true,
    severity: from.severity,
    title: input.title,
    detail: from.detail,
    now: at.getTime(),
    clearObservation: true,
  });
  return {
    action: "transferred",
    incidentId: from.id,
    ...(destination ? { closedIncidentId: destination.id } : {}),
  };
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
  return db.transaction((tx) => recordIncidentObservationIn(tx, input));
}

/**
 * Same transition inside a caller-owned transaction, so settings, the
 * operation result and the episode always commit or roll back together.
 */
export async function recordIncidentObservationIn(
  tx: Transaction,
  input: IncidentObservation,
): Promise<IncidentObservationResult> {
  const now = input.now ?? Date.now();
  const at = new Date(now);

  {
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
          inhibitedBy: null,
          inhibitedReason: null,
          observationPending: false,
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
    const inhibit = async (groupId: number) =>
      input.key === "connection" && input.inhibitContainers
        ? await inhibitOpenContainers(
            tx,
            { id: groupId, hostId: input.hostId },
            input.inhibitContainers.reason,
            at,
          )
        : undefined;

    if (open) {
      if (open.severity === severity) {
        const inhibitedIncidentIds = await inhibit(open.id);
        if (
          input.clearObservation &&
          (open.inhibitedBy !== null ||
            open.inhibitedReason !== null ||
            open.observationPending)
        ) {
          // The same episode resumes with its ID and delivery result; only the
          // observation block is removed after valid evidence (D-04).
          const seq = open.seq + 1;
          await tx
            .update(incidents)
            .set({
              seq,
              inhibitedBy: null,
              inhibitedReason: null,
              observationPending: false,
            })
            .where(eq(incidents.id, open.id));
          await tx.insert(incidentEvents).values({
            incidentId: open.id,
            seq,
            kind: "resumed",
            severity,
            title: open.title,
            detail: open.detail,
            at,
          });
          return {
            action: "observed",
            incidentId: open.id,
            seq,
            delivery: "none",
            ...(inhibitedIncidentIds ? { inhibitedIncidentIds } : {}),
          };
        }
        return {
          action: "observed",
          incidentId: open.id,
          seq: open.seq,
          delivery: "none",
          ...(inhibitedIncidentIds ? { inhibitedIncidentIds } : {}),
        };
      }
      const seq = open.seq + 1;
      await tx
        .update(incidents)
        .set({
          severity,
          title,
          detail,
          seq,
          ...(input.clearObservation
            ? {
                inhibitedBy: null,
                inhibitedReason: null,
                observationPending: false,
              }
            : {}),
        })
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
      const inhibitedIncidentIds = await inhibit(open.id);
      if (open.origin === "legacy") {
        await suppressPending(tx, open.id, "legacy_open", at);
        return {
          action: "escalated",
          incidentId: open.id,
          seq,
          delivery: "none",
          ...(inhibitedIncidentIds ? { inhibitedIncidentIds } : {}),
        };
      }
      const delivery = await changeSeverity(tx, open, seq, at, input.delivery);
      return {
        action: "escalated",
        incidentId: open.id,
        seq,
        delivery,
        ...(inhibitedIncidentIds ? { inhibitedIncidentIds } : {}),
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
        context: input.context ?? null,
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
      const inhibitedIncidentIds = await inhibit(current.id);
      return {
        action: "observed",
        incidentId: current.id,
        seq: current.seq,
        delivery: "none",
        ...(inhibitedIncidentIds ? { inhibitedIncidentIds } : {}),
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

    const inhibitedIncidentIds = await inhibit(created.id);
    if (isImmediate(input.delivery)) {
      await tx.insert(notificationOutbox).values({
        key: openKey(created.id),
        incidentId: created.id,
        kind: "incident-open",
        channel: input.delivery!.channel,
        status: "pending",
        revision: 1,
      });
      return {
        action: "opened",
        incidentId: created.id,
        seq: 1,
        delivery: "queued",
        ...(inhibitedIncidentIds ? { inhibitedIncidentIds } : {}),
      };
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
    return {
      action: "opened",
      incidentId: created.id,
      seq: 1,
      delivery: "none",
      ...(inhibitedIncidentIds ? { inhibitedIncidentIds } : {}),
    };
  }
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
  push_disabled: "push_disabled",
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
  // The persisted row status wins over the last attempt result: a queued or
  // claimed retry is still pending even when its previous attempt failed.
  if (state === "claimed" || state === "pending") return "pending";
  if (result?.state) return result.state;
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

type IncidentRow = typeof incidents.$inferSelect;

function projectRow(
  row: IncidentRow,
  jobs: OutboxJob[],
  inventory: IncidentInventoryContext | null,
): Alert {
  const opening = jobs.find((job) => job.kind === "incident-open");
  const edits = jobs
    .filter((job) => job.kind === "incident-edit")
    .sort((a, b) => b.revision - a.revision || b.id - a.id);
  const latestEdit = edits[0];
  const fallback = opening?.fallbackResult;
  return {
    id: row.id,
    hostId: row.hostId,
    key: row.key,
    kind: incidentKind(row.key),
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
    inventory: row.key === "connection" ? inventory : null,
    inhibitedBy: row.inhibitedBy,
    inhibitedReason: row.inhibitedReason,
    observationPending: row.observationPending,
    inhibited: row.key === "connection" ? [] : null,
  } satisfies Alert;
}

/**
 * Old open groups keep a null `context`; when their samples are still inside
 * retention, the last one before the opening is shown without rewriting the
 * stored episode.
 */
async function legacyInventoryContexts(rows: IncidentRow[]) {
  const contexts = new Map<number, IncidentInventoryContext>();
  for (const row of rows) {
    if (row.key !== "connection" || row.context) continue;
    contexts.set(row.id, await captureServiceInventory(row.hostId, row.at));
  }
  return contexts;
}

/**
 * Shared public projection for the overview list and the point lookup. It
 * keeps the initial result, the push fallback and the last edit separate and
 * never exposes claim tokens, Telegram destinations or provider bodies. A
 * `services-down` group also carries the open container episodes it blocks,
 * even when they fall outside the bounded overview list.
 */
export async function projectIncidents(rows: IncidentRow[]): Promise<Alert[]> {
  if (!rows.length) return [];
  const legacyContexts = await legacyInventoryContexts(rows);
  const groupIds = rows
    .filter((row) => row.key === "connection")
    .map((row) => row.id);
  const inhibitedRows = groupIds.length
    ? await db
        .select()
        .from(incidents)
        .where(
          and(
            inArray(incidents.inhibitedBy, groupIds),
            isNull(incidents.resolvedAt),
          ),
        )
        .orderBy(asc(incidents.id))
    : [];
  const byId = new Map<number, IncidentRow>(rows.map((row) => [row.id, row]));
  for (const row of inhibitedRows) if (!byId.has(row.id)) byId.set(row.id, row);
  const allRows = [...byId.values()];
  const jobs = await db
    .select()
    .from(notificationOutbox)
    .where(
      inArray(
        notificationOutbox.incidentId,
        allRows.map((row) => row.id),
      ),
    );
  const byIncident = new Map<number, OutboxJob[]>();
  for (const job of jobs) {
    if (job.incidentId === null) continue;
    const group = byIncident.get(job.incidentId);
    if (group) group.push(job);
    else byIncident.set(job.incidentId, [job]);
  }
  const projected = new Map<number, Alert>();
  for (const row of allRows) {
    projected.set(
      row.id,
      projectRow(
        row,
        byIncident.get(row.id) ?? [],
        row.key === "connection"
          ? (row.context ?? legacyContexts.get(row.id) ?? null)
          : null,
      ),
    );
  }
  const inhibitedByGroup = new Map<number, Alert[]>();
  for (const row of inhibitedRows) {
    if (row.inhibitedBy === null) continue;
    const alert = projected.get(row.id);
    if (!alert) continue;
    const list = inhibitedByGroup.get(row.inhibitedBy);
    if (list) list.push(alert);
    else inhibitedByGroup.set(row.inhibitedBy, [alert]);
  }
  return rows.map((row) => {
    const alert = projected.get(row.id)!;
    if (row.key === "connection")
      alert.inhibited = inhibitedByGroup.get(row.id) ?? [];
    return alert;
  });
}

/**
 * Removes episodes past retention, together with their terminal delivery
 * state. Keeps groups referenced by open episodes and episodes with live work.
 * Orphan push-test rows are removed by their own age. The incident cascade
 * deletes its events and terminal outbox rows in the same statement.
 */
export async function cleanupExpiredIncidents(cutoff: Date): Promise<void> {
  await db.execute(sql`
    DELETE FROM "incidents" AS i
    WHERE i."at" < ${cutoff}
      AND i."resolvedAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "incidents" AS member
        WHERE member."inhibitedBy" = i."id"
          AND member."resolvedAt" IS NULL
      )
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
