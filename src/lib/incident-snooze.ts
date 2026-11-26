/**
 * Silences of a watched condition.
 *
 * A silence belongs to the `(hostId, key)` pair, not to one episode: while it
 * lasts neither a re-escalation nor a re-opening of the same condition
 * interrupts, and the deadline is the only thing that ends it (D-01, D-03).
 *
 * Every caller passes any Drizzle base — the pool `db`, a transaction or
 * `workerDb(client)` — so the incident write and the dispatch read consult the
 * very same row.
 */

import { and, eq, gt, lt } from "drizzle-orm";
import type { Transaction } from "./incident-store";
import { incidentSnoozes } from "./schema";

/** Closed set of allowed durations, in hours: a silence is never indefinite. */
export const SNOOZE_HOURS = [1, 24] as const;

export type SnoozeHours = (typeof SNOOZE_HOURS)[number];

/** Finite suppression reason of every delivery the silence withholds. */
export const SNOOZE_SUPPRESSION_REASON = "snoozed";

const HOUR_MS = 3_600_000;

/** Minimal writer both a pool client and a transaction satisfy. */
export type SnoozeExecutor = Pick<
  Transaction,
  "select" | "insert" | "update" | "delete"
>;

export type ActiveSnooze = {
  until: Date;
  setVia: string;
  setBy: string | null;
};

function instantOf(at: Date | number): Date {
  return at instanceof Date ? at : new Date(at);
}

/**
 * Rejects any duration outside the closed set. The type already narrows the
 * caller, so this only catches a runtime caller that bypassed it: a silence
 * with no deadline is exactly the failure the set exists to prevent (T-05-06).
 */
export function snoozeDeadline(at: Date | number, hours: number): Date {
  if (!SNOOZE_HOURS.includes(hours as SnoozeHours))
    throw new RangeError("Duración de silencio no permitida");
  return new Date(instantOf(at).getTime() + hours * HOUR_MS);
}

/** The live silence of the pair, or null when there is none or it expired. */
export async function activeSnooze(
  executor: SnoozeExecutor,
  hostId: string,
  key: string,
  at: Date | number,
): Promise<ActiveSnooze | null> {
  const [row] = await executor
    .select()
    .from(incidentSnoozes)
    .where(
      and(
        eq(incidentSnoozes.hostId, hostId),
        eq(incidentSnoozes.key, key),
        gt(incidentSnoozes.until, instantOf(at)),
      ),
    )
    .limit(1);
  return row ? { until: row.until, setVia: row.setVia, setBy: row.setBy } : null;
}

/**
 * Writes a silence whose deadline is later than the stored one. Repeating the
 * same duration, or asking for a shorter one while a silence is live, changes
 * nothing (`unchanged`); a later deadline replaces an earlier or expired one
 * (`extended` or `set`). The conditional upsert keeps that true even if two
 * writers interleave.
 */
export async function upsertSnooze(
  executor: SnoozeExecutor,
  input: {
    hostId: string;
    key: string;
    until: Date;
    via: string;
    by?: string | null;
    at: Date | number;
  },
): Promise<"set" | "extended" | "unchanged"> {
  const now = instantOf(input.at);
  const [existing] = await executor
    .select()
    .from(incidentSnoozes)
    .where(
      and(
        eq(incidentSnoozes.hostId, input.hostId),
        eq(incidentSnoozes.key, input.key),
      ),
    )
    .limit(1);
  const live = Boolean(existing && existing.until.getTime() > now.getTime());
  // The duration, not the absolute deadline, decides: pressing the same button
  // again seconds later must not create a second event (BOT-04).
  const requestedMs = input.until.getTime() - now.getTime();
  const liveMs = existing
    ? existing.until.getTime() - existing.setAt.getTime()
    : 0;
  if (live && requestedMs <= liveMs) return "unchanged";

  const [applied] = await executor
    .insert(incidentSnoozes)
    .values({
      hostId: input.hostId,
      key: input.key,
      until: input.until,
      setAt: now,
      setVia: input.via,
      setBy: input.by ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [incidentSnoozes.hostId, incidentSnoozes.key],
      set: {
        until: input.until,
        setAt: now,
        setVia: input.via,
        setBy: input.by ?? null,
        updatedAt: now,
      },
      setWhere: lt(incidentSnoozes.until, input.until),
    })
    .returning({ until: incidentSnoozes.until });
  if (!applied) return "unchanged";
  return live ? "extended" : "set";
}

/**
 * Removes the silence of the pair. An expired row is still removed, so a
 * keyboard rendered before the deadline can refresh the notice instead of
 * doing nothing; `expired` tells the caller which event to record.
 */
export async function clearSnooze(
  executor: SnoozeExecutor,
  hostId: string,
  key: string,
  at: Date | number = Date.now(),
): Promise<{ existed: boolean; expired: boolean }> {
  const [removed] = await executor
    .delete(incidentSnoozes)
    .where(
      and(
        eq(incidentSnoozes.hostId, hostId),
        eq(incidentSnoozes.key, key),
      ),
    )
    .returning({ until: incidentSnoozes.until });
  if (!removed) return { existed: false, expired: false };
  return {
    existed: true,
    expired: removed.until.getTime() <= instantOf(at).getTime(),
  };
}
