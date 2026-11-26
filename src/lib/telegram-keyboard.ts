/**
 * Keyboard tokens and the action matrix of a Telegram notice.
 *
 * Every button carries a random 128-bit token (`v1:` plus 22 base64url
 * characters, 25 bytes) that the server resolves on consumption. Only its
 * SHA-256 digest is stored, so a database reader cannot replay a button and the
 * callback never carries an episode id, a duration or a user id (BOT-06).
 */

import { createHash, randomBytes } from "node:crypto";
import type { Transaction } from "./incident-store";
import { telegramActionTokens } from "./schema";
import type { TelegramActionButton } from "./telegram";

/** A rendered keyboard is usable for a week; later renders renew it. */
export const TELEGRAM_TOKEN_TTL_MS = 7 * 86_400_000;

/** Closed set of button actions; everything else is deduced server-side. */
export const TELEGRAM_ACTIONS = [
  "ack",
  "snooze_1h",
  "snooze_24h",
  "unsnooze",
  "why",
] as const;

export type TelegramAction = (typeof TELEGRAM_ACTIONS)[number];

/** `v1:` versions the token format, not the phase scope. */
const CALLBACK_DATA_PATTERN = /^v1:[A-Za-z0-9_-]{22}$/;

const ACTION_LABELS: Record<TelegramAction, string> = {
  ack: "Reconocer",
  snooze_1h: "Silenciar 1 h",
  snooze_24h: "Silenciar 24 h",
  unsnooze: "Quitar silencio",
  why: "Por qué",
};

/** 128 random bits, base64url: 22 characters, 25 bytes with the prefix. */
export function generateActionToken(): string {
  return `v1:${randomBytes(16).toString("base64url")}`;
}

/** The digest that lives in the database; the plain token never persists. */
export function hashActionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Strict parser: anything that is not a well-formed token is null. */
export function parseCallbackData(data: unknown): string | null {
  return typeof data === "string" && CALLBACK_DATA_PATTERN.test(data) ? data : null;
}

export type KeyboardState = {
  resolved: boolean;
  acknowledged: boolean;
  snoozed: boolean;
};

/**
 * Actions a state offers. This plan emits only `ack` for an open, unread
 * episode; an acknowledged or resolved notice offers none. 05-02 and 05-03
 * widen the matrix without changing the lane.
 */
export function keyboardActions(state: KeyboardState): TelegramAction[] {
  if (state.resolved) return [];
  if (state.acknowledged) return [];
  return ["ack"];
}

/** Minimal writer both a pool client and a transaction satisfy. */
export type TokenExecutor = Pick<Transaction, "insert">;

/**
 * Persists one hashed token per action and returns the plain `callback_data`
 * values to render. Called at render time, so a failed send only leaves
 * harmless unused rows.
 */
export async function issueActionTokens(
  executor: TokenExecutor,
  input: {
    incidentId: number;
    chatId: string;
    actions: readonly TelegramAction[];
    now?: number;
  },
): Promise<Partial<Record<TelegramAction, string>>> {
  if (input.actions.length === 0) return {};
  const now = input.now ?? Date.now();
  const expiresAt = new Date(now + TELEGRAM_TOKEN_TTL_MS);
  const issued: Partial<Record<TelegramAction, string>> = {};
  const rows = input.actions.map((action) => {
    const token = generateActionToken();
    issued[action] = token;
    return {
      tokenHash: hashActionToken(token),
      incidentId: input.incidentId,
      action,
      chatId: input.chatId,
      expiresAt,
    };
  });
  await executor.insert(telegramActionTokens).values(rows);
  return issued;
}

/**
 * Turns issued tokens into the callback rows appended after the URL button.
 * Order follows `TELEGRAM_ACTIONS`, two buttons per row at most.
 */
export function renderActionRows(
  issued: Partial<Record<TelegramAction, string>>,
): TelegramActionButton[][] {
  const buttons = TELEGRAM_ACTIONS.flatMap((action) => {
    const token = issued[action];
    return token ? [{ text: ACTION_LABELS[action], callbackData: token }] : [];
  });
  const rows: TelegramActionButton[][] = [];
  for (let index = 0; index < buttons.length; index += 2)
    rows.push(buttons.slice(index, index + 2));
  return rows;
}
