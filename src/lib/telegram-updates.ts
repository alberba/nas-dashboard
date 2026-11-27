/**
 * Inbound Telegram lane: long polling inside the loop that owns the collection
 * lock.
 *
 * Only the lock owner reads `getUpdates`, so there is a single updates consumer
 * (INCD-06). Each authorised callback is consumed, applied and acknowledged in
 * one pool transaction that also advances the durable offset: a process death
 * before the commit leaves the token unused and the update is redelivered,
 * while a death after it never re-applies the effect (BOT-02, BOT-06).
 *
 * Anything that is not an authorised button press only advances the offset: no
 * action, no `answerCallbackQuery`, no log of its content (D-11, D-12).
 */

import type { Client } from "pg";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import {
  CollectionLockLost,
  TELEGRAM_COOLDOWN_CHANNEL,
  beginTelegramCooldown,
  holdsCollectionLock,
} from "./notification-dispatch";
import { db } from "./db";
import { incidents, telegramCooldown, telegramPollState } from "./schema";
import type { RuntimeConfig } from "./runtime-config";
import {
  applyIncidentAction,
  consumeActionToken,
  type ActionTokenConsumption,
  type IncidentActionOutcome,
} from "./incident-actions";
import { enqueueWhyReply } from "./incident-why";
import type { Transaction } from "./incident-store";
import {
  answerTelegramCallback,
  deleteTelegramWebhook,
  getTelegramUpdates,
  redactToken,
  type TelegramTransport,
} from "./telegram";
import {
  createIntent,
  hostActionsFor,
  intentActionOfToken,
  type IntentActionId,
} from "./telegram-intents";
import { parseCallbackData, type TelegramAction } from "./telegram-keyboard";
import { WORKER_IDLE_MS } from "./worker-loop";

/** One row of `telegram_poll_state`; only this consumer exists today. */
export const TELEGRAM_POLL_STATE_NAME = "updates";
/**
 * Telegram picks random update ids after a week without updates, so a persisted
 * offset older than this cannot be trusted. The lane then omits it (A1).
 */
export const OFFSET_RESET_AFTER_MS = 6 * 86_400_000;
/** Failure backoff of the lane: 1 s doubling up to 30 s, reset on success. */
export const TELEGRAM_UPDATES_BACKOFF_MS = 1_000;
export const TELEGRAM_UPDATES_MAX_BACKOFF_MS = 30_000;
/** A deterministic error is skipped after this many attempts, never forever. */
export const POISON_MAX_ATTEMPTS = 3;
const TELEGRAM_UPDATES_LIMIT = 20;

export type UpdatesOutcome = {
  handled: number;
  ok: boolean;
  waitedSeconds: number;
};

const telegramUser = z.looseObject({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
});

const telegramChat = z.looseObject({
  id: z.number().int(),
  type: z.string(),
});

const telegramMessage = z.looseObject({
  message_id: z.number().int(),
  /** 0 marks an inaccessible message, which has no `from`. */
  date: z.number().int(),
  chat: telegramChat,
  from: telegramUser.optional(),
});

/**
 * Tolerant contract of the only update kind this bot reads. Telegram adds
 * fields without notice, so every object is loose; text, commands and the rest
 * of the update types simply have no `callback_query` and are ignored.
 */
export const telegramUpdateSchema = z.looseObject({
  update_id: z.number().int(),
  callback_query: z
    .looseObject({
      id: z.string(),
      from: telegramUser,
      message: telegramMessage.optional(),
      data: z.string().optional(),
    })
    .optional(),
});

/** The pieces of the update the pure allowlist needs. */export type CallbackUpdate = {
  updateId: number;
  callbackQueryId: string;
  fromId: number;
  fromIsBot: boolean;
  chatId: number;
  chatType: string;
  messageId: number;
  messageDate: number;
  messageFromIsBot: boolean | null;
  data: string;
};

/** Parses a `callback_query`; every other update kind returns null. */
export function parseCallbackUpdate(raw: unknown): CallbackUpdate | null {
  const parsed = telegramUpdateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const query = parsed.data.callback_query;
  if (!query?.message || !query.data) return null;
  return {
    updateId: parsed.data.update_id,
    callbackQueryId: query.id,
    fromId: query.from.id,
    fromIsBot: query.from.is_bot === true,
    chatId: query.message.chat.id,
    chatType: query.message.chat.type,
    messageId: query.message.message_id,
    messageDate: query.message.date,
    messageFromIsBot:
      query.message.from === undefined ? null : query.message.from.is_bot === true,
    data: query.data,
  };
}

/**
 * Pure allowlist (D-11): the operator's own user id and the private chat must
 * both be the configured chat, the press must come from a message the bot sent
 * and the payload must be a well-formed token. No network, no database.
 */
export function isAuthorizedCallback(
  update: CallbackUpdate | null,
  options: { chatId: string },
): boolean {
  if (!update) return false;
  if (!Number.isSafeInteger(update.fromId)) return false;
  if (String(update.fromId) !== options.chatId) return false;
  if (update.fromIsBot) return false;
  if (!Number.isSafeInteger(update.chatId)) return false;
  if (String(update.chatId) !== options.chatId) return false;
  if (update.chatType !== "private") return false;
  if (!parseCallbackData(update.data)) return false;
  // An inaccessible message (`date === 0`) has no author; the token binding is
  // then the proof that the button is ours.
  if (update.messageDate !== 0 && update.messageFromIsBot !== true) return false;
  return true;
}

export type TokenActionResult = "applied" | "unchanged" | "ignored";

/** `resolved` and `not_found` have no user-visible effect: only the toast. */
function translate(outcome: IncidentActionOutcome): TokenActionResult {
  if (outcome === "applied") return "applied";
  if (outcome === "unchanged") return "unchanged";
  return "ignored";
}

/**
 * A host action only registers an intention (D-00a): the lane records a pending
 * intent and the silent edit that carries the hub link, and never runs, calls
 * the agent or writes an operation. A resolved notice or a key that does not
 * offer the action creates nothing (D-06, D-01 to D-03).
 */
async function registerIntent(
  tx: Transaction,
  incidentId: number,
  action: IntentActionId,
  context: { now: number; secret: string },
): Promise<TokenActionResult> {
  const [incident] = await tx
    .select({
      id: incidents.id,
      hostId: incidents.hostId,
      key: incidents.key,
      resolvedAt: incidents.resolvedAt,
    })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for("update");
  if (!incident || incident.resolvedAt) return "ignored";
  if (!hostActionsFor(incident.key).includes(action)) return "ignored";
  const created = await createIntent(tx, {
    incident,
    action,
    secret: context.secret,
    now: context.now,
  });
  if (created.state === "created") return "applied";
  if (created.state === "live") return "unchanged";
  return "ignored";
}

/**
 * Applies a consumed token inside the caller's transaction. Acknowledging,
 * silencing and the "why" explanation all share this seam, so Telegram and the
 * hub cannot drift apart.
 */
export async function applyTokenAction(
  tx: Transaction,
  consumed: { incidentId: number; action: TelegramAction },
  context: { via: "telegram"; now: number; secret: string },
): Promise<TokenActionResult> {
  const target = {
    incidentId: consumed.incidentId,
    via: context.via,
    by: null,
    now: context.now,
  } as const;
  switch (consumed.action) {
    case "ack":
      return translate(await applyIncidentAction(tx, { action: "ack", ...target }));
    case "snooze_1h":
    case "snooze_24h":
      return translate(
        await applyIncidentAction(tx, {
          action: "snooze",
          hours: consumed.action === "snooze_1h" ? 1 : 24,
          ...target,
        }),
      );
    case "unsnooze":
      return translate(await applyIncidentAction(tx, { action: "unsnooze", ...target }));
    case "why": {
      // One reply per notice state: a fresh token of the same state is a
      // duplicate and gets the "already answered" toast without another send.
      const outcome = await enqueueWhyReply(tx, {
        incidentId: consumed.incidentId,
      });
      if (outcome === "queued") return "applied";
      if (outcome === "duplicate") return "unchanged";
      return "ignored";
    }
    case "act_start":
    case "act_restart":
    case "act_reboot":
    case "act_backup_now":
    case "act_deploy_now": {
      const action = intentActionOfToken(consumed.action);
      if (!action) return "ignored";
      return registerIntent(tx, consumed.incidentId, action, context);
    }
    // The menu and the cancellation arrive with the keyboard views (07-03);
    // until then no render emits their tokens and a stray one changes nothing.
    case "menu_open":
    case "menu_close":
    case "intent_cancel":
      return "ignored";
  }
}

function updateIdOf(raw: unknown): number | null {
  const parsed = telegramUpdateSchema.safeParse(raw);
  if (!parsed.success) return null;
  return Number.isSafeInteger(parsed.data.update_id) ? parsed.data.update_id : null;
}

function answerText(outcome: {
  consumed: ActionTokenConsumption;
  result: TokenActionResult;
}): string {
  if (outcome.consumed.ok) {
    if (intentActionOfToken(outcome.consumed.action)) {
      if (outcome.result === "applied") return "Confirma en el hub";
      if (outcome.result === "unchanged") return "Ya hay una acción pendiente";
      return "No se pudo aplicar";
    }
    if (outcome.result === "applied") return "Hecho";
    // A repeated "why" is D-09's "already answered"; the other actions were
    // already applied or had nothing to change.
    if (outcome.consumed.action === "why") return "Ya respondido";
    return "Sin cambios";
  }
  switch (outcome.consumed.reason) {
    case "used":
      return "Ya usado";
    case "expired":
      return "Caducado";
    case "unknown":
    case "chat_mismatch":
    case "message_mismatch":
    case "incident_missing":
      return "No se pudo aplicar";
  }
}

export type UpdatesLaneInput = {
  /** Dedicated connection that owns the collection lock. */
  client: Client;
  config: RuntimeConfig;
  /** Aborted on process shutdown or when the lock session is lost. */
  signal?: AbortSignal;
  fetchImpl?: TelegramTransport;
  now?: () => number;
  /** Every line is redacted before it leaves the lane. */
  log?: (line: string) => void;
};

export type UpdatesLane = {
  run: (input: { waitSeconds: number }) => Promise<UpdatesOutcome>;
  /** 0 when the next turn should start at once, a bounded pause otherwise. */
  idleMs: () => number;
};

/**
 * Builds the lane. It is disabled, with a single finite log line and no API
 * call, when Telegram is absent or the configured chat is not private (D-11).
 */
export function createUpdatesLane(input: UpdatesLaneInput): UpdatesLane {
  const clock = input.now ?? Date.now;
  const telegram = input.config.telegram;
  const token = telegram?.botToken ?? "";
  const chatId = telegram?.chatId ?? "";
  const enabled = Boolean(telegram && chatId && !chatId.startsWith("-"));
  const say = (line: string) => input.log?.(redactToken(line, token || undefined));

  let webhookDeleted = false;
  let lastFailure: string | null = null;
  let backoffMs = 0;
  let lastOk = false;
  let lastWaitSeconds = 0;
  let lastHandled = 0;
  const attemptsByUpdate = new Map<number, number>();

  if (!enabled)
    say(
      "Carril de updates desactivado: el chat configurado no es un chat privado",
    );

  async function openCooldown(retryAfterMs: number | null): Promise<void> {
    await beginTelegramCooldown(
      input.client,
      clock() + (retryAfterMs ?? TELEGRAM_UPDATES_BACKOFF_MS),
      "rate_limited",
      clock(),
    );
  }

  function failure(reason: string): UpdatesOutcome {
    if (reason !== lastFailure) {
      lastFailure = reason;
      say(`Carril de updates: ${reason}`);
    }
    backoffMs = Math.min(
      Math.max(backoffMs * 2, TELEGRAM_UPDATES_BACKOFF_MS),
      TELEGRAM_UPDATES_MAX_BACKOFF_MS,
    );
    lastOk = false;
    return { handled: 0, ok: false, waitedSeconds: 0 };
  }

  async function advanceOffset(updateId: number): Promise<void> {
    const at = new Date(clock());
    await db
      .insert(telegramPollState)
      .values({
        name: TELEGRAM_POLL_STATE_NAME,
        lastUpdateId: updateId,
        lastUpdateAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: telegramPollState.name,
        set: { lastUpdateId: updateId, lastUpdateAt: at, updatedAt: at },
      });
  }

  async function answer(
    callbackQueryId: string,
    outcome: {
      consumed: ActionTokenConsumption;
      result: TokenActionResult;
    },
  ): Promise<void> {
    try {
      const answered = await answerTelegramCallback(
        { callbackQueryId, text: answerText(outcome) },
        {
          botToken: token,
          fetchImpl: input.fetchImpl,
          signal: input.signal,
        },
      );
      if (answered.state === "retry") await openCooldown(answered.retryAfterMs);
      else if (answered.state === "failed")
        say(`Carril de updates: no se pudo cerrar el callback (${answered.reason})`);
    } catch {
      // Closing the spinner is best effort: the effect is already committed.
      say("Carril de updates: no se pudo cerrar el callback");
    }
  }

  async function run({ waitSeconds }: { waitSeconds: number }): Promise<UpdatesOutcome> {
    if (!enabled) return { handled: 0, ok: false, waitedSeconds: 0 };
    if (!(await holdsCollectionLock(input.client)))
      throw new CollectionLockLost();

    const [cooldown] = await db
      .select({ until: telegramCooldown.until })
      .from(telegramCooldown)
      .where(
        and(
          eq(telegramCooldown.channel, TELEGRAM_COOLDOWN_CHANNEL),
          gt(telegramCooldown.until, new Date(clock())),
        ),
      )
      .limit(1);
    if (cooldown) {
      // The provider asked for silence; respecting it is not a failure.
      lastOk = true;
      backoffMs = 0;
      lastWaitSeconds = 0;
      lastHandled = 0;
      return { handled: 0, ok: true, waitedSeconds: 0 };
    }

    if (!webhookDeleted) {
      const removed = await deleteTelegramWebhook({
        botToken: token,
        fetchImpl: input.fetchImpl,
        signal: input.signal,
      });
      if (removed.state === "retry") {
        await openCooldown(removed.retryAfterMs);
        return failure("rate_limited");
      }
      if (removed.state === "failed") return failure(`webhook_${removed.reason}`);
      webhookDeleted = true;
    }

    const [state] = await db
      .select()
      .from(telegramPollState)
      .where(eq(telegramPollState.name, TELEGRAM_POLL_STATE_NAME))
      .limit(1);
    const fresh =
      state?.lastUpdateId !== null &&
      state?.lastUpdateId !== undefined &&
      state.lastUpdateAt !== null &&
      state.lastUpdateAt.getTime() >= clock() - OFFSET_RESET_AFTER_MS;
    const offset = fresh && state?.lastUpdateId != null ? state.lastUpdateId + 1 : null;

    const poll = await getTelegramUpdates(
      { offset, timeoutSeconds: waitSeconds, limit: TELEGRAM_UPDATES_LIMIT },
      {
        botToken: token,
        fetchImpl: input.fetchImpl,
        signal: input.signal,
      },
    );
    if (poll.state === "retry") {
      await openCooldown(poll.retryAfterMs);
      return failure("rate_limited");
    }
    if (poll.state === "failed") {
      // A conflict means another consumer or a webhook is back: remove it again
      // before the next poll, and back off so the lane never polls hot (T-05-17).
      if (poll.reason === "conflict") webhookDeleted = false;
      return failure(poll.reason);
    }

    // The lock may have been lost while the long poll was waiting.
    if (!(await holdsCollectionLock(input.client)))
      throw new CollectionLockLost();

    let handled = 0;
    for (const raw of poll.updates) {
      const updateId = updateIdOf(raw);
      if (updateId === null) continue;
      const callback = parseCallbackUpdate(raw);
      const authorized =
        callback !== null && isAuthorizedCallback(callback, { chatId });

      if (!authorized) {
        // Unauthorised, text or malformed: only the offset moves.
        await advanceOffset(updateId);
        continue;
      }

      try {
        const outcome = await db.transaction(async (tx) => {
          const consumed = await consumeActionToken(tx, {
            token: callback.data,
            chatId: String(callback.chatId),
            messageId: String(callback.messageId),
            now: clock(),
          });
          const result: TokenActionResult = consumed.ok
            ? await applyTokenAction(tx, consumed, {
                via: "telegram",
                now: clock(),
                secret: input.config.betterAuthSecret,
              })
            : "ignored";
          const at = new Date(clock());
          await tx
            .insert(telegramPollState)
            .values({
              name: TELEGRAM_POLL_STATE_NAME,
              lastUpdateId: updateId,
              lastUpdateAt: at,
              updatedAt: at,
            })
            .onConflictDoUpdate({
              target: telegramPollState.name,
              set: { lastUpdateId: updateId, lastUpdateAt: at, updatedAt: at },
            });
          return { consumed, result };
        });
        attemptsByUpdate.delete(updateId);
        handled += 1;
        await answer(callback.callbackQueryId, outcome);
      } catch (error) {
        if (error instanceof CollectionLockLost) throw error;
        const attempts = (attemptsByUpdate.get(updateId) ?? 0) + 1;
        if (attempts >= POISON_MAX_ATTEMPTS) {
          // A deterministic failure must not block the queue forever. The line
          // names no update and no content: only the bounded attempt count.
          attemptsByUpdate.delete(updateId);
          await advanceOffset(updateId);
          handled += 1;
          say(`Update descartado tras ${attempts} intentos`);
          continue;
        }
        attemptsByUpdate.set(updateId, attempts);
        return failure("update_failed");
      }
    }

    lastOk = true;
    lastFailure = null;
    backoffMs = 0;
    lastWaitSeconds = waitSeconds;
    lastHandled = handled;
    return { handled, ok: true, waitedSeconds: waitSeconds };
  }

  function idleMs(): number {
    if (!lastOk) return backoffMs > 0 ? backoffMs : TELEGRAM_UPDATES_BACKOFF_MS;
    return lastWaitSeconds >= 1 || lastHandled > 0 ? 0 : WORKER_IDLE_MS;
  }

  return { run, idleMs };
}
