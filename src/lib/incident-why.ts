/**
 * "Why did this reach me?": the notice state and its queued reply.
 *
 * One reply is sent per state of the notice (D-09). A state is the last event
 * that changed what the notice says: its opening, a severity change or its
 * closure. Acknowledging and silencing are "I saw it" and "not now", so they do
 * not open a new state and never allow a second reply (BOT-06).
 *
 * The reply is outbox work like any other Telegram send: the unique `key` is
 * what makes two concurrent presses of one state leave a single row, and the
 * dispatcher owns retries, the shared 429 pause and the uncertain attempt.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Transaction } from "./incident-store";
import { incidentEvents, incidents, notificationOutbox } from "./schema";

/** Events that change what the notice explains; every other kind is ignored. */
export const WHY_STATE_EVENT_KINDS = ["opened", "severity", "closed"] as const;

/** Minimal Drizzle base a pool, a transaction and `workerDb` all satisfy. */
export type WhyExecutor = Pick<Transaction, "select" | "insert">;

/** Logical key of one reply for one state of the notice. */
export function whyKey(incidentId: number, noticeSeq: number): string {
  return `incident:${incidentId}:why:${noticeSeq}`;
}

/**
 * Highest `seq` of the events that change the notice, or null when the episode
 * has none (an episode always starts with its `opened` event).
 */
export async function noticeSeq(
  executor: WhyExecutor,
  incidentId: number,
): Promise<number | null> {
  const [row] = await executor
    .select({ seq: incidentEvents.seq })
    .from(incidentEvents)
    .where(
      and(
        eq(incidentEvents.incidentId, incidentId),
        inArray(incidentEvents.kind, [...WHY_STATE_EVENT_KINDS]),
      ),
    )
    .orderBy(desc(incidentEvents.seq))
    .limit(1);
  return row?.seq ?? null;
}

export type WhyEnqueueOutcome = "queued" | "duplicate" | "unavailable";

/**
 * Queues the reply of the current notice state inside the caller's
 * transaction. It never writes the episode, its events or its edits: explaining
 * a notice is read-only for the incident (BOT-06). A missing episode, or one
 * without a confirmed Telegram notice to quote, cannot be explained.
 */
export async function enqueueWhyReply(
  executor: WhyExecutor,
  input: { incidentId: number },
): Promise<WhyEnqueueOutcome> {
  const [incident] = await executor
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.id, input.incidentId))
    .limit(1);
  if (!incident) return "unavailable";

  const seq = await noticeSeq(executor, incident.id);
  if (seq === null) return "unavailable";

  // The quoted message is the confirmed opening; without it there is nothing
  // to reply to and the button could not have been rendered.
  const [opening] = await executor
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.key, `incident:${incident.id}:open`))
    .limit(1);
  if (
    !opening ||
    opening.status !== "sent" ||
    opening.channel !== "telegram" ||
    !opening.chatId ||
    !opening.messageId
  )
    return "unavailable";

  const [queued] = await executor
    .insert(notificationOutbox)
    .values({
      key: whyKey(incident.id, seq),
      incidentId: incident.id,
      kind: "incident-why",
      channel: "telegram",
      status: "pending",
      revision: seq,
      chatId: opening.chatId,
      messageId: opening.messageId,
    })
    .onConflictDoNothing()
    .returning({ id: notificationOutbox.id });
  return queued ? "queued" : "duplicate";
}
