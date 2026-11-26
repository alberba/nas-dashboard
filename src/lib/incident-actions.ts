/**
 * Operator actions shared by Telegram callbacks and the hub.
 *
 * Acknowledging writes the episode, its timeline event and the silent edit in
 * one transaction, so both channels leave the same state and the same message
 * (D-14). The action never reads or writes the delivery policy: acknowledging
 * is "I saw it", so a later escalation to critical still interrupts (D-02).
 *
 * Silencing writes the `(hostId, key)` silence and its timeline event in the
 * same transaction; it neither acknowledges nor hides an event (D-01, D-02).
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { queueEdit, type Transaction } from "./incident-store";
import {
  clearSnooze,
  snoozeDeadline,
  upsertSnooze,
  type SnoozeHours,
} from "./incident-snooze";import {
  incidentEvents,
  incidents,
  notificationOutbox,
  telegramActionTokens,
} from "./schema";
import { hashActionToken, type TelegramAction } from "./telegram-keyboard";

/** `acknowledgedVia` accepts only the two write channels of this phase. */
export type IncidentActionChannel = "telegram" | "hub";

export type IncidentActionOutcome = "applied" | "unchanged" | "resolved" | "not_found";

type IncidentActionTarget = {
  incidentId: number;
  via: IncidentActionChannel;
  /** Internal session name from the hub; null or absent for Telegram. */
  by?: string | null;
  now?: number;
};

export type IncidentActionInput =
  | ({ action: "ack" } & IncidentActionTarget)
  | ({ action: "snooze"; hours: SnoozeHours } & IncidentActionTarget)
  | ({ action: "unsnooze" } & IncidentActionTarget);


/** Logical key of the confirmed opening of an episode. */
function openKey(incidentId: number) {
  return `incident:${incidentId}:open`;
}

async function acknowledge(
  tx: Transaction,
  input: IncidentActionTarget,
): Promise<IncidentActionOutcome> {
  const now = input.now ?? Date.now();
  const at = new Date(now);
  // The collector and this action compete for `seq`; lock the episode first.
  const locked = await lockEpisode(tx, input.incidentId);
  if (!locked.ok) return locked.outcome;
  const incident = locked.incident;
  // Acknowledging twice is a no-op: no event, no seq, no edit.
  if (incident.acknowledgedAt) return "unchanged";

  const seq = incident.seq + 1;
  await tx
    .update(incidents)
    .set({
      acknowledgedAt: at,
      acknowledgedVia: input.via,
      acknowledgedBy: input.by ?? null,
      seq,
    })
    .where(eq(incidents.id, incident.id));
  await tx.insert(incidentEvents).values({
    incidentId: incident.id,
    seq,
    kind: "acknowledged",
    severity: incident.severity,
    title: incident.title,
    detail: incident.detail,
    at,
  });
  await queueEdit(tx, incident.id, seq);
  return "applied";
}

/**
 * Applies one operator action inside the caller's transaction. Every branch
 * locks the episode first, so the collector and the two channels compete for
 * `seq` in one order. Unknown action names never reach the database because the
 * callback is parsed against a closed set first.
 */
export async function applyIncidentAction(
  tx: Transaction,
  input: IncidentActionInput,
): Promise<IncidentActionOutcome> {
  switch (input.action) {
    case "ack":
      return acknowledge(tx, input);
    case "snooze":
      return snooze(tx, input);
    case "unsnooze":
      return unsnooze(tx, input);
  }
}

type EpisodeLock =
  | { ok: false; outcome: "not_found" | "resolved" }
  | { ok: true; incident: typeof incidents.$inferSelect };

/**
 * Locks the open episode an action targets. A closed or missing episode writes
 * nothing: after resolution the state controls are gone and the silence expires
 * on its own (D-10).
 */
async function lockEpisode(
  tx: Transaction,
  incidentId: number,
): Promise<EpisodeLock> {
  const [incident] = await tx
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for("update");
  if (!incident) return { ok: false, outcome: "not_found" };
  if (incident.resolvedAt) return { ok: false, outcome: "resolved" };
  return { ok: true, incident };
}

/** Writes the new revision, its timeline event and the silent edit. */
async function recordAction(
  tx: Transaction,
  incident: typeof incidents.$inferSelect,
  at: Date,
  event: { kind: "snoozed" | "unsnoozed"; detail: string },
): Promise<IncidentActionOutcome> {
  const seq = incident.seq + 1;
  await tx.update(incidents).set({ seq }).where(eq(incidents.id, incident.id));
  await tx.insert(incidentEvents).values({
    incidentId: incident.id,
    seq,
    kind: event.kind,
    severity: incident.severity,
    title: incident.title,
    detail: event.detail,
    at,
  });
  await queueEdit(tx, incident.id, seq);
  return "applied";
}

/**
 * Silences the whole condition for a closed set of hours. Repeating the same
 * duration, or asking for a shorter one while the silence is live, is a no-op:
 * no second event and no second edit (BOT-04).
 */
async function snooze(
  tx: Transaction,
  input: { incidentId: number; via: IncidentActionChannel; hours: SnoozeHours; by?: string | null; now?: number },
): Promise<IncidentActionOutcome> {
  const now = input.now ?? Date.now();
  const at = new Date(now);
  const locked = await lockEpisode(tx, input.incidentId);
  if (!locked.ok) return locked.outcome;
  const incident = locked.incident;

  const until = snoozeDeadline(at, input.hours);
  const outcome = await upsertSnooze(tx, {
    hostId: incident.hostId,
    key: incident.key,
    until,
    via: input.via,
    by: input.by ?? null,
    at,
  });
  if (outcome === "unchanged") return "unchanged";
  return recordAction(tx, incident, at, {
    kind: "snoozed",
    detail: until.toISOString(),
  });
}

/**
 * Ends the silence of the condition. A live row and an expired one are both
 * removed, because a keyboard rendered before the deadline must still refresh
 * the notice; only a missing row is a no-op.
 */
async function unsnooze(
  tx: Transaction,
  input: { incidentId: number; via: IncidentActionChannel; by?: string | null; now?: number },
): Promise<IncidentActionOutcome> {
  const now = input.now ?? Date.now();
  const at = new Date(now);
  const locked = await lockEpisode(tx, input.incidentId);
  if (!locked.ok) return locked.outcome;
  const incident = locked.incident;

  const cleared = await clearSnooze(tx, incident.hostId, incident.key, at);
  if (!cleared.existed) return "unchanged";
  return recordAction(tx, incident, at, {
    kind: "unsnoozed",
    detail: cleared.expired ? "expired" : "cleared",
  });
}

export type ActionTokenFailure =
  | "unknown"
  | "used"
  | "expired"
  | "chat_mismatch"
  | "message_mismatch"
  | "incident_missing";

export type ActionTokenConsumption =
  | { ok: true; incidentId: number; action: TelegramAction }
  | { ok: false; reason: ActionTokenFailure };

const KNOWN_ACTIONS = new Set<TelegramAction>([
  "ack",
  "snooze_1h",
  "snooze_24h",
  "unsnooze",
  "why",
]);

/**
 * Consumes one callback token atomically. Every failed validation returns a
 * finite reason and leaves the token untouched; nothing here throws, so a
 * replay or a forged callback can never poison the queue (BOT-06).
 */
export async function consumeActionToken(
  tx: Transaction,
  input: { token: string; chatId: string; messageId: string; now?: number },
): Promise<ActionTokenConsumption> {
  const now = input.now ?? Date.now();
  const at = new Date(now);
  const tokenHash = hashActionToken(input.token);
  const [row] = await tx
    .select()
    .from(telegramActionTokens)
    .where(eq(telegramActionTokens.tokenHash, tokenHash))
    .limit(1)
    .for("update");
  if (!row) return { ok: false, reason: "unknown" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= now) return { ok: false, reason: "expired" };
  if (row.chatId !== input.chatId) return { ok: false, reason: "chat_mismatch" };

  const [incident] = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.id, row.incidentId))
    .limit(1);
  if (!incident) return { ok: false, reason: "incident_missing" };

  // The token is bound to the notice it was rendered for: the confirmed
  // opening of this episode must be the very message that was pressed.
  const [opening] = await tx
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.key, openKey(row.incidentId)))
    .limit(1);
  if (
    !opening ||
    opening.status !== "sent" ||
    opening.channel !== "telegram" ||
    opening.chatId !== input.chatId ||
    opening.messageId !== input.messageId
  )
    return { ok: false, reason: "message_mismatch" };

  const action = KNOWN_ACTIONS.has(row.action as TelegramAction)
    ? (row.action as TelegramAction)
    : null;
  if (!action) return { ok: false, reason: "unknown" };

  const [consumed] = await tx
    .update(telegramActionTokens)
    .set({ usedAt: at })
    .where(
      and(
        eq(telegramActionTokens.tokenHash, tokenHash),
        isNull(telegramActionTokens.usedAt),
        gt(telegramActionTokens.expiresAt, at),
      ),
    )
    .returning({ incidentId: telegramActionTokens.incidentId });
  if (!consumed) return { ok: false, reason: "used" };
  return { ok: true, incidentId: consumed.incidentId, action };
}
