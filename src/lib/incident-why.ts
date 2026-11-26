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
import { madridClock } from "./madrid-day";
import type { NotificationPolicy } from "./notification-policy";
import { incidentEvents, incidents, notificationOutbox } from "./schema";
import type { Metrics } from "./types";

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

export type WhyReading = { value: number; unit: string };

/**
 * The value the rule read for one key, from the latest sample of the host.
 * Temperature is the highest sensor, CPU the busy percentage, memory the used
 * share and disk the fullest volume; any other key has no measurement to show
 * and explains rule and channel only.
 */
export function readingFor(
  key: string,
  metrics: Metrics | null | undefined,
): WhyReading | null {
  if (!metrics) return null;
  switch (key) {
    case "temperature": {
      const values = (metrics.temperatures ?? [])
        .map((sensor) => sensor.value)
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) return null;
      return { value: Math.max(...values), unit: "°C" };
    }
    case "cpu":
      return typeof metrics.cpu === "number" && Number.isFinite(metrics.cpu)
        ? { value: Math.round(metrics.cpu), unit: "%" }
        : null;
    case "memory": {
      const total = metrics.memory?.total;
      const used = metrics.memory?.used;
      if (typeof total !== "number" || total <= 0 || typeof used !== "number")
        return null;
      return { value: Math.round((used / total) * 100), unit: "%" };
    }
    case "disk": {
      const shares = (metrics.disks ?? [])
        .filter((disk) => disk.total > 0)
        .map((disk) => (disk.used / disk.total) * 100);
      if (shares.length === 0) return null;
      return { value: Math.round(Math.max(...shares)), unit: "%" };
    }
    default:
      return null;
  }
}

export type WhyFacts = {
  /** The rule that fired; its threshold is already part of the detail. */
  rule: string;
  /** What was read for this key, only while the episode is open. */
  reading: WhyReading | null;
  /** The channel the notice actually went out through. */
  channel: string;
  severity: string;
  resolved: boolean;
  snoozedUntil: Date | null;
  canSnooze: boolean;
};

export type WhyFactsInput = {
  incident: typeof incidents.$inferSelect;
  opening: { channel: string } | null;
  policy: Pick<NotificationPolicy, "channel">;
  snoozed: { until: Date } | null;
  metrics: Metrics | null | undefined;
};

/**
 * Facts of the explanation, generated when the reply is sent so it describes
 * the notice as it is now (D-08): a resolved episode shows no reading and a
 * live silence replaces the hint to silence.
 */
export function whyFacts(input: WhyFactsInput): WhyFacts {
  const { incident } = input;
  const resolved = incident.resolvedAt !== null;
  return {
    rule: incident.detail,
    reading: resolved ? null : readingFor(incident.key, input.metrics),
    channel: input.opening?.channel ?? input.policy.channel,
    severity: incident.severity,
    resolved,
    snoozedUntil: input.snoozed?.until ?? null,
    canSnooze: !resolved && input.snoozed === null,
  };
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: "Telegram",
  push: "push",
  digest: "el resumen diario",
  silent: "modo silencioso",
};

function readableReading(reading: WhyReading): string {
  const value = Number.isInteger(reading.value)
    ? String(reading.value)
    : reading.value.toFixed(1);
  return reading.unit === "%" ? `${value} %` : `${value} ${reading.unit}`;
}

/**
 * Spanish rendering of one to three sentences: the rule, the reading if there
 * is one, the severity with its channel and, only while it applies, the hint
 * that silencing avoids repetitions (D-07, D-08). Copy lives here and tests
 * assert the facts, never this wording.
 */
export function renderWhyText(facts: WhyFacts): string {
  const sentences: string[] = [];
  const rule = facts.rule.trim();
  if (rule) sentences.push(/[.!?]$/.test(rule) ? rule : `${rule}.`);
  if (facts.reading)
    sentences.push(`Última lectura: ${readableReading(facts.reading)}.`);
  const channel = CHANNEL_LABELS[facts.channel] ?? facts.channel;
  sentences.push(`${facts.severity} · llegó por ${channel}.`);
  if (facts.resolved) sentences.push("La incidencia ya está resuelta.");
  else if (facts.snoozedUntil)
    sentences.push(`Silenciada hasta ${madridClock(facts.snoozedUntil)}.`);
  else if (facts.canSnooze) sentences.push("Silenciar evita repeticiones.");
  return sentences.join(" ");
}
