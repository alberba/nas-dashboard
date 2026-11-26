/**
 * Telegram Bot API client: outgoing notices plus the inbound polling lane.
 *
 * The origin is fixed, redirects are never followed, requests have a bounded
 * timeout and every response is validated. The client never sets `parse_mode`
 * and truncates plain text to the provider limit. It returns a finite outcome
 * instead of throwing so the dispatcher can distinguish a confirmed rejection
 * from an attempt whose result is unknown (D-01).
 *
 * The bot token only ever touches the URL built inside `botRequest`; every
 * caller sees finite results, so no log or stored value can carry it (BOT-10).
 */

export const TELEGRAM_ORIGIN = "https://api.telegram.org";
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
/** `answerCallbackQuery` rejects longer texts; the toast is always brief. */
export const TELEGRAM_ANSWER_TEXT_LIMIT = 200;
/**
 * Ceiling for a provider-supplied wait, in milliseconds.
 *
 * `retry_after` pauses every Telegram delivery of the bot, so it cannot be
 * left entirely provider-chosen: a value past the representable `Date` range
 * cannot even be stored, and the statement that would reschedule the delivery
 * fails after the attempt mark was committed. The cap is the digest recovery
 * window, so a confirmed 429 is always respected for as long as any queued
 * digest could still use it; a genuine longer pause simply repeats the 429.
 */
export const TELEGRAM_MAX_RETRY_AFTER_MS = 2 * 60 * 60_000;

/** Only the provider origin is reachable, even when a test injects fetch. */
export type TelegramTransport = (url: string, init: RequestInit) => Promise<Response>;

export type TelegramFailureReason =
  | "rate_limited"
  | "telegram_400"
  | "telegram_401"
  | "telegram_403"
  | "telegram_404"
  | "telegram_server_error"
  | "message_missing"
  | "network"
  | "timeout"
  | "aborted"
  | "invalid_response"
  | "missing_message_id";

export type TelegramSendResult =
  | { state: "sent"; chatId: string; messageId: string }
  | { state: "retry"; retryAfterMs: number | null; status: number; reason: "rate_limited" }
  | { state: "rejected"; status: number; reason: TelegramFailureReason }
  | { state: "uncertain"; reason: TelegramFailureReason };

export type TelegramEditResult = TelegramSendResult;

/** One `callback_data` button of the keyboard rendered by `telegram-keyboard`. */
export type TelegramActionButton = {
  text: string;
  callbackData: string;
};

export type TelegramClientOptions = {
  botToken: string;
  fetchImpl?: TelegramTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const BOT_TOKEN_PATTERN = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;
/** Any string shaped like a bot token, with or without the `/bot` prefix. */
const TOKEN_LIKE_PATTERN = /\d{5,12}:[A-Za-z0-9_-]{30,}/g;

/** Truncates to the Bot API limit without splitting a surrogate pair. */
export function telegramText(value: string): string {
  if (value.length <= TELEGRAM_TEXT_LIMIT) return value;
  let end = TELEGRAM_TEXT_LIMIT - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/**
 * Removes the bot token from a log line. The literal token is replaced first,
 * then any remaining string shaped like a token, so a value built elsewhere
 * cannot leak either.
 */
export function redactToken(text: string, token?: string): string {
  const withoutLiteral = token ? text.split(token).join("[token]") : text;
  return withoutLiteral.replace(TOKEN_LIKE_PATTERN, "[token]");
}

type TelegramEnvelope = {
  ok?: unknown;
  result?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown };
};

function parseEnvelope(raw: string): TelegramEnvelope | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as TelegramEnvelope)
      : null;
  } catch {
    return null;
  }
}

function resultObject(envelope: TelegramEnvelope): Record<string, unknown> | null {
  const value = envelope.result;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resultItems(envelope: TelegramEnvelope): unknown[] | null {
  return Array.isArray(envelope.result) ? envelope.result : null;
}

function retryAfterMs(envelope: TelegramEnvelope): number | null {
  const seconds = envelope.parameters?.retry_after;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    return null;
  // Clamp after the multiplication as well: a finite `seconds` can still
  // overflow to Infinity and an unbounded wait cannot be represented.
  return Math.min(
    Math.ceil(seconds * 1000),
    TELEGRAM_MAX_RETRY_AFTER_MS,
  );
}

function messageId(envelope: TelegramEnvelope): string | null {
  const value = resultObject(envelope)?.message_id;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return null;
  return String(value);
}

function providerChatId(envelope: TelegramEnvelope, fallback: string): string {
  const chat = resultObject(envelope)?.chat;
  const value =
    chat && typeof chat === "object" && !Array.isArray(chat)
      ? (chat as Record<string, unknown>).id
      : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function isNotModified(envelope: TelegramEnvelope): boolean {
  const description = envelope.description;
  return (
    typeof description === "string" &&
    /message is not modified/i.test(description)
  );
}

function isMissingMessage(status: number, envelope: TelegramEnvelope): boolean {
  if (status === 404) return true;
  const description = envelope.description;
  return (
    typeof description === "string" &&
    /message to edit not found|message can't be edited|message_id_invalid|message to delete not found/i.test(
      description,
    )
  );
}

function httpReason(status: number, envelope: TelegramEnvelope): TelegramFailureReason {
  if (status >= 500) return "telegram_server_error";
  if (status === 400 || status === 401 || status === 403) {
    const description = envelope.description;
    if (
      typeof description === "string" &&
      /chat not found|bot was blocked|bot is not a member|forbidden/i.test(description)
    )
      return status === 403 ? "telegram_403" : "telegram_400";
    return status === 401 ? "telegram_401" : "telegram_400";
  }
  if (status === 404) return "telegram_404";
  return "telegram_400";
}

type TelegramMethod =
  | "sendMessage"
  | "editMessageText"
  | "getUpdates"
  | "deleteWebhook"
  | "answerCallbackQuery";

type BotRequestContext = {
  method: TelegramMethod;
  body: Record<string, unknown>;
  botToken: string;
  fetchImpl: TelegramTransport;
  signal?: AbortSignal;
  timeoutMs: number;
};

type BotRequestFailureReason = "aborted" | "timeout" | "network" | "invalid_response";

type BotRequestResult =
  | { state: "failed"; reason: BotRequestFailureReason }
  | { state: "response"; status: number; envelope: TelegramEnvelope | null };

/**
 * The only place that builds the URL with the bot token. A failed request is
 * reported as a finite transport reason; the provider body is parsed as an
 * envelope and never kept as text.
 */
async function botRequest(context: BotRequestContext): Promise<BotRequestResult> {
  if (!BOT_TOKEN_PATTERN.test(context.botToken))
    return { state: "failed", reason: "invalid_response" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  const signals = [controller.signal, context.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal =
    signals.length > 1 ? AbortSignal.any(signals) : signals[0] ?? controller.signal;

  let response: Response;
  try {
    response = await context.fetchImpl(
      `${TELEGRAM_ORIGIN}/bot${context.botToken}/${context.method}`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context.body),
        signal,
      },
    );
  } catch {
    clearTimeout(timer);
    // A connection that failed after the durable attempt mark may have reached
    // the provider: never treat it as a confirmed rejection (D-01).
    if (context.signal?.aborted) return { state: "failed", reason: "aborted" };
    return {
      state: "failed",
      reason: controller.signal.aborted ? "timeout" : "network",
    };
  }

  let raw = "";
  try {
    // The timer also covers a stalled response body, not only its headers.
    raw = await response.text();
  } catch {
    clearTimeout(timer);
    return {
      state: "failed",
      reason: controller.signal.aborted ? "timeout" : "invalid_response",
    };
  }
  clearTimeout(timer);
  return { state: "response", status: response.status, envelope: parseEnvelope(raw) };
}

type RequestContext = BotRequestContext & {
  method: "sendMessage" | "editMessageText";
  fallbackChatId: string;
  fallbackMessageId?: string;
};

async function post(context: RequestContext): Promise<TelegramSendResult> {
  const request = await botRequest(context);
  if (request.state === "failed")
    return { state: "uncertain", reason: request.reason };

  const { status, envelope } = request;

  if (status === 429) {
    return {
      state: "retry",
      status: 429,
      retryAfterMs: envelope ? retryAfterMs(envelope) : null,
      reason: "rate_limited",
    };
  }

  if (status >= 500)
    return { state: "uncertain", reason: "telegram_server_error" };

  if (status >= 300) {
    if (
      context.method === "editMessageText" &&
      status === 400 &&
      envelope &&
      isNotModified(envelope)
    ) {
      const applied = context.fallbackMessageId;
      if (!applied) return { state: "uncertain", reason: "missing_message_id" };
      return {
        state: "sent",
        chatId: context.fallbackChatId,
        messageId: applied,
      };
    }
    if (
      context.method === "editMessageText" &&
      envelope &&
      isMissingMessage(status, envelope)
    )
      return { state: "rejected", status, reason: "message_missing" };
    return {
      state: "rejected",
      status,
      reason: envelope ? httpReason(status, envelope) : "telegram_400",
    };
  }

  if (!envelope || envelope.ok !== true || status !== 200) {
    // A 2xx body that cannot be validated is not a confirmation (D-01).
    return { state: "uncertain", reason: "invalid_response" };
  }

  if (context.method === "editMessageText") {
    const applied = messageId(envelope) ?? context.fallbackMessageId ?? null;
    if (!applied) return { state: "uncertain", reason: "missing_message_id" };
    return {
      state: "sent",
      chatId: providerChatId(envelope, context.fallbackChatId),
      messageId: applied,
    };
  }

  const confirmed = messageId(envelope);
  if (!confirmed) return { state: "uncertain", reason: "missing_message_id" };
  return {
    state: "sent",
    chatId: providerChatId(envelope, context.fallbackChatId),
    messageId: confirmed,
  };
}

function normalizeOptions(options: TelegramClientOptions) {
  return {
    botToken: options.botToken,
    fetchImpl: options.fetchImpl ?? fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? TELEGRAM_REQUEST_TIMEOUT_MS,
  };
}

function buttons(buttonUrl: string, actionRows?: TelegramActionButton[][]) {
  const rows: Array<Array<Record<string, unknown>>> = [
    [{ text: "Abrir en el hub", url: buttonUrl }],
  ];
  for (const row of actionRows ?? []) {
    if (row.length === 0) continue;
    rows.push(
      row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      })),
    );
  }
  return { inline_keyboard: rows };
}

/** Sends the plain-text opening with the URL button and any action rows. */
export async function sendTelegramMessage(
  input: {
    chatId: string;
    text: string;
    buttonUrl: string;
    actionRows?: TelegramActionButton[][];
  },
  options: TelegramClientOptions,
): Promise<TelegramSendResult> {
  const normalized = normalizeOptions(options);
  return post({
    method: "sendMessage",
    body: {
      chat_id: input.chatId,
      text: telegramText(input.text),
      disable_web_page_preview: true,
      reply_markup: buttons(input.buttonUrl, input.actionRows),
    },
    fallbackChatId: input.chatId,
    ...normalized,
  });
}

/**
 * Edits the original confirmed message. "message is not modified" is success:
 * the provider already has that content.
 */
export async function editTelegramMessage(
  input: {
    chatId: string;
    messageId: string;
    text: string;
    buttonUrl: string;
    actionRows?: TelegramActionButton[][];
  },
  options: TelegramClientOptions,
): Promise<TelegramEditResult> {
  const normalized = normalizeOptions(options);
  return post({
    method: "editMessageText",
    body: {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: telegramText(input.text),
      disable_web_page_preview: true,
      reply_markup: buttons(input.buttonUrl, input.actionRows),
    },
    fallbackChatId: input.chatId,
    fallbackMessageId: input.messageId,
    ...normalized,
  });
}

/**
 * Replies in the chat quoting the notice: `reply_parameters` binds the answer
 * to the message it explains and `disable_notification` keeps it silent (D-06).
 * It carries no keyboard, because the buttons live in the quoted notice.
 */
export async function sendTelegramReply(
  input: { chatId: string; replyToMessageId: string; text: string },
  options: TelegramClientOptions,
): Promise<TelegramSendResult> {
  const replyTo = Number(input.replyToMessageId);
  // A non-numeric id would be a provider 400 with a wasted attempt: refuse it
  // locally with the finite reason the dispatcher already handles.
  if (!Number.isSafeInteger(replyTo) || replyTo <= 0)
    return { state: "rejected", status: 400, reason: "message_missing" };
  const normalized = normalizeOptions(options);
  return post({
    method: "sendMessage",
    body: {
      chat_id: input.chatId,
      text: telegramText(input.text),
      disable_web_page_preview: true,
      disable_notification: true,
      reply_parameters: {
        message_id: replyTo,
        allow_sending_without_reply: true,
      },
    },
    fallbackChatId: input.chatId,
    ...normalized,
  });
}

export type TelegramPollResult =
  | { state: "ok"; updates: unknown[] }
  | { state: "retry"; retryAfterMs: number | null }
  | { state: "failed"; reason: TelegramFailureReason | "conflict" };

/** `getUpdates` caps the provider wait at 50 s; the lane never asks that long. */
const TELEGRAM_POLL_MAX_SECONDS = 50;

/**
 * Reads pending updates. `allowed_updates` is always sent: omitting it makes
 * Telegram reuse the previous setting, which could keep delivering text.
 * The fetch timer is the requested wait plus the regular request margin, so
 * the poll is never aborted by its own timeout.
 */
export async function getTelegramUpdates(
  input: { offset: number | null; timeoutSeconds: number; limit?: number },
  options: TelegramClientOptions,
): Promise<TelegramPollResult> {
  const normalized = normalizeOptions(options);
  const timeoutSeconds = Math.min(
    Math.max(Math.trunc(input.timeoutSeconds), 0),
    TELEGRAM_POLL_MAX_SECONDS,
  );
  const request = await botRequest({
    method: "getUpdates",
    body: {
      ...(input.offset === null ? {} : { offset: input.offset }),
      timeout: timeoutSeconds,
      limit: input.limit ?? 20,
      allowed_updates: ["callback_query"],
    },
    botToken: normalized.botToken,
    fetchImpl: normalized.fetchImpl,
    signal: normalized.signal,
    timeoutMs: timeoutSeconds * 1000 + normalized.timeoutMs,
  });
  if (request.state === "failed")
    return { state: "failed", reason: request.reason };

  if (request.status === 429)
    return {
      state: "retry",
      retryAfterMs: request.envelope ? retryAfterMs(request.envelope) : null,
    };
  if (request.status === 409) return { state: "failed", reason: "conflict" };

  const updates =
    request.status === 200 && request.envelope?.ok === true
      ? resultItems(request.envelope)
      : null;
  if (!updates)
    return {
      state: "failed",
      reason: request.envelope
        ? httpReason(request.status, request.envelope)
        : "invalid_response",
    };
  return { state: "ok", updates };
}

export type TelegramAckResult =
  | { state: "ok" }
  | { state: "retry"; retryAfterMs: number | null }
  | { state: "failed"; reason: TelegramFailureReason };

async function voidRequest(
  method: "deleteWebhook" | "answerCallbackQuery",
  body: Record<string, unknown>,
  options: TelegramClientOptions,
): Promise<TelegramAckResult> {
  const request = await botRequest({ method, body, ...normalizeOptions(options) });
  if (request.state === "failed")
    return { state: "failed", reason: request.reason };
  if (request.status === 429)
    return {
      state: "retry",
      retryAfterMs: request.envelope ? retryAfterMs(request.envelope) : null,
    };
  if (request.status === 200 && request.envelope?.ok === true)
    return { state: "ok" };
  return {
    state: "failed",
    reason: request.envelope
      ? httpReason(request.status, request.envelope)
      : "invalid_response",
  };
}

/**
 * Removes any outgoing webhook so `getUpdates` is allowed to poll. Pending
 * updates are kept on purpose: a button pressed while the worker was stopped
 * must still arrive.
 */
export async function deleteTelegramWebhook(
  options: TelegramClientOptions,
): Promise<TelegramAckResult> {
  return voidRequest("deleteWebhook", {}, options);
}

/** Closes the callback spinner. `show_alert` is never used: the toast is brief. */
export async function answerTelegramCallback(
  input: { callbackQueryId: string; text?: string },
  options: TelegramClientOptions,
): Promise<TelegramAckResult> {
  const body: Record<string, unknown> = {
    callback_query_id: input.callbackQueryId,
  };
  const text = input.text?.slice(0, TELEGRAM_ANSWER_TEXT_LIMIT);
  if (text) body.text = text;
  return voidRequest("answerCallbackQuery", body, options);
}
