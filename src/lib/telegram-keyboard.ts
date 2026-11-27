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
import {
  INTENT_VERBS,
  tokenActionOf,
  type IntentActionId,
} from "./telegram-intents";

/** A rendered keyboard is usable for a week; later renders renew it. */
export const TELEGRAM_TOKEN_TTL_MS = 7 * 86_400_000;

/** Closed set of button actions; everything else is deduced server-side. */
export const TELEGRAM_ACTIONS = [
  "ack",
  "snooze_1h",
  "snooze_24h",
  "unsnooze",
  "why",
  "menu_open",
  "menu_close",
  "act_start",
  "act_restart",
  "act_reboot",
  "act_backup_now",
  "act_deploy_now",
  "intent_cancel",
] as const;

export type TelegramAction = (typeof TELEGRAM_ACTIONS)[number];

/** `v1:` versions the token format, not the phase scope. */
const CALLBACK_DATA_PATTERN = /^v1:[A-Za-z0-9_-]{22}$/;

const ACTION_LABELS: Record<TelegramAction, string> = {
  ack: "Reconocer",
  snooze_1h: "Silenciar 1 h",
  snooze_24h: "Silenciar 24 h",
  unsnooze: "Quitar silencio",
  why: "Por qué me llegó esto",
  menu_open: "Acciones…",
  menu_close: "Volver",
  intent_cancel: "Cancelar",
  act_start: INTENT_VERBS.start,
  act_restart: INTENT_VERBS.restart,
  act_reboot: INTENT_VERBS.reboot,
  act_backup_now: INTENT_VERBS["backup-now"],
  act_deploy_now: INTENT_VERBS["deploy-now"],
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

/** The two keyboards of an open notice: the usual one and the actions menu. */
export type KeyboardView = "normal" | "actions";

export type KeyboardState = {
  resolved: boolean;
  acknowledged: boolean;
  snoozed: boolean;
  /** Host actions the notice offers (D-01 to D-03); absent means none. */
  offered?: readonly IntentActionId[];
  view?: KeyboardView;
  /** A pending, unexpired intent already holds the notice (D-10). */
  liveIntent?: boolean;
};

/**
 * Actions a state offers. The explanation accompanies every state, resolved
 * included: it only reads the notice (D-10). A resolved episode offers no state
 * control and no menu (D-06); a silenced one replaces both silence buttons with
 * `unsnooze` (D-13) and acknowledging is never undone from the chat (D-13,
 * D-02). A live intent is the only thing the menu slot may show: its cancel
 * button, even after the episode resolved (D-05).
 */
export function keyboardActions(state: KeyboardState): TelegramAction[] {
  if (state.resolved)
    return state.liveIntent ? ["intent_cancel", "why"] : ["why"];
  const actions: TelegramAction[] = [];
  if (!state.acknowledged) actions.push("ack");
  if (state.snoozed) actions.push("unsnooze");
  else actions.push("snooze_1h", "snooze_24h");
  const offered = state.offered ?? [];
  if (state.liveIntent) actions.push("intent_cancel");
  else if (offered.length > 0) {
    if (state.view === "actions")
      actions.push(...offered.map(tokenActionOf), "menu_close");
    else actions.push("menu_open");
  }
  actions.push("why");
  return actions;
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
 * Acknowledging keeps its own row; the silence controls share the next one, so
 * a live silence shows a single "Quitar silencio" where the two buttons were.
 * The host actions of the open menu follow, then the confirmation link of a live
 * intent, and the menu, cancel and explanation controls close the keyboard in
 * one row. The explanation is the only action a resolved notice keeps (D-10).
 */
export function renderActionRows(
  issued: Partial<Record<TelegramAction, string>>,
  options: { confirm?: { text: string; url: string } } = {},
): TelegramActionButton[][] {
  const button = (action: TelegramAction) => {
    const token = issued[action];
    return token ? [{ text: ACTION_LABELS[action], callbackData: token }] : [];
  };
  const rows: TelegramActionButton[][] = [];
  const acknowledged = button("ack");
  if (acknowledged.length) rows.push(acknowledged);
  const silence = [
    ...button("snooze_1h"),
    ...button("snooze_24h"),
    ...button("unsnooze"),
  ];
  if (silence.length) rows.push(silence);
  const hostActions = TELEGRAM_ACTIONS.filter((action) =>
    action.startsWith("act_"),
  ).flatMap(button);
  for (let index = 0; index < hostActions.length; index += 2)
    rows.push(hostActions.slice(index, index + 2));
  if (options.confirm) rows.push([options.confirm]);
  const controls = (["menu_open", "menu_close", "intent_cancel", "why"] as const)
    .flatMap(button);
  if (controls.length) rows.push(controls);
  return rows;
}
