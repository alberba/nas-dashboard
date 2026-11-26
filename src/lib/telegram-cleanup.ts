/**
 * Pruning of the bot state that outlives its usefulness.
 *
 * Buttons rendered for a long episode and silences that already expired would
 * otherwise accumulate forever: the token table grows with every render and the
 * silence table keeps one row per watched condition. The hourly worker cleanup
 * calls this, and only this, on the two tables (T-05-18).
 *
 * A token is kept one day past its expiry, so a press on an old message still
 * receives the generic answer with the row present or already gone. A silence is
 * kept a week past its deadline: the timeline already records what happened, and
 * the extra window keeps a stale keyboard click meaningful. The poll state is
 * never touched here: the offset is the lane's own durable position.
 */

import { lt } from "drizzle-orm";
import type { Transaction } from "./incident-store";
import { incidentSnoozes, telegramActionTokens } from "./schema";

/** A token lives this long after its expiry before the cleanup removes it. */
export const TOKEN_RETENTION_AFTER_EXPIRY_MS = 86_400_000;
/** An expired silence is kept this long before the cleanup removes it. */
export const SNOOZE_RETENTION_MS = 7 * 86_400_000;

/** Minimal writer both the pool `db` and a transaction satisfy. */
export type CleanupExecutor = Pick<Transaction, "delete">;

export type TelegramCleanupCounts = {
  /** Rows removed from `telegram_action_tokens`. */
  tokens: number;
  /** Rows removed from `incident_snoozes`. */
  snoozes: number;
};

/**
 * Deletes the expired tokens and silences older than their retention window and
 * reports how many rows of each table went away. It never reads the incident,
 * the outbox or the poll state, so a cleanup cannot alter what the bot answers.
 */
export async function cleanupTelegramState(
  executor: CleanupExecutor,
  now: Date | number,
): Promise<TelegramCleanupCounts> {
  const at = now instanceof Date ? now : new Date(now);
  const tokens = await executor
    .delete(telegramActionTokens)
    .where(
      lt(
        telegramActionTokens.expiresAt,
        new Date(at.getTime() - TOKEN_RETENTION_AFTER_EXPIRY_MS),
      ),
    )
    .returning({ tokenHash: telegramActionTokens.tokenHash });
  const snoozes = await executor
    .delete(incidentSnoozes)
    .where(
      lt(incidentSnoozes.until, new Date(at.getTime() - SNOOZE_RETENTION_MS)),
    )
    .returning({ key: incidentSnoozes.key });
  return { tokens: tokens.length, snoozes: snoozes.length };
}
