/**
 * Operator actions shared by Telegram callbacks and the hub.
 *
 * Acknowledging writes the episode, its timeline event and the silent edit in
 * one transaction, so both channels leave the same state and the same message
 * (D-14). The action never reads or writes the delivery policy: acknowledging
 * is "I saw it", so a later escalation to critical still interrupts (D-02).
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { queueEdit, type Transaction } from "./incident-store";
import {
  incidentEvents,
  incidents,
  notificationOutbox,
  telegramActionTokens,
} from "./schema";
import { hashActionToken, type TelegramAction } from "./telegram-keyboard";

/** `acknowledgedVia` accepts only the two write channels of this phase. */
export type IncidentActionChannel = "telegram" | "hub";

export type IncidentActionOutcome = "applied" | "unchanged" | "resolved" | "not_found";

export type IncidentActionInput = {
  action: TelegramAction;
  incidentId: number;
  via: IncidentActionChannel;
  /** Internal session name from the hub; null or absent for Telegram. */
  by?: string | null;
  now?: number;
};

/** Logical key of the confirmed opening of an episode. */
function openKey(incidentId: number) {
  return `incident:${incidentId}:open`;
}

async function acknowledge(
  tx: Transaction,
  input: IncidentActionInput,
): Promise<IncidentActionOutcome> {
  const now = input.now ?? Date.now();
  const at = new Date(now);
  // The collector and this action compete for `seq`; lock the episode first.
  const [incident] = await tx
    .select()
    .from(incidents)
    .where(eq(incidents.id, input.incidentId))
    .limit(1)
    .for("update");
  if (!incident) return "not_found";
  if (incident.resolvedAt) return "resolved";
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
 * Applies one operator action inside the caller's transaction. Only `ack`
 * exists in this plan; 05-02 and 05-03 add their branches without changing the
 * lane. Unknown action names never reach the database because the callback is
 * parsed against a closed set first.
 */
export async function applyIncidentAction(
  tx: Transaction,
  input: IncidentActionInput,
): Promise<IncidentActionOutcome> {
  switch (input.action) {
    case "ack":
      return acknowledge(tx, input);
    default:
      return "unchanged";
  }
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
