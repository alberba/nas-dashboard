/**
 * Outgoing Telegram Bot API client for incident openings and edits.
 *
 * The origin is fixed, redirects are never followed, requests have a bounded
 * timeout and every response is validated. The client never sets `parse_mode`
 * and truncates plain text to the provider limit. It returns a finite outcome
 * instead of throwing so the dispatcher can distinguish a confirmed rejection
 * from an attempt whose result is unknown (D-01).
 */

export const TELEGRAM_ORIGIN = "https://api.telegram.org";
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

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

export type TelegramClientOptions = {
  botToken: string;
  fetchImpl?: TelegramTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const BOT_TOKEN_PATTERN = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;

/** Truncates to the Bot API limit without splitting a surrogate pair. */
export function telegramText(value: string): string {
  if (value.length <= TELEGRAM_TEXT_LIMIT) return value;
  let end = TELEGRAM_TEXT_LIMIT - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

type TelegramEnvelope = {
  ok?: unknown;
  result?: { message_id?: unknown; chat?: { id?: unknown } };
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

function retryAfterMs(envelope: TelegramEnvelope): number | null {
  const seconds = envelope.parameters?.retry_after;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    return null;
  return Math.ceil(seconds * 1000);
}

function messageId(envelope: TelegramEnvelope): string | null {
  const value = envelope.result?.message_id;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return null;
  return String(value);
}

function providerChatId(envelope: TelegramEnvelope, fallback: string): string {
  const value = envelope.result?.chat?.id;
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

type RequestContext = {
  method: "sendMessage" | "editMessageText";
  body: Record<string, unknown>;
  botToken: string;
  fetchImpl: TelegramTransport;
  signal?: AbortSignal;
  timeoutMs: number;
  fallbackChatId: string;
  fallbackMessageId?: string;
};

async function post(context: RequestContext): Promise<TelegramSendResult> {
  if (!BOT_TOKEN_PATTERN.test(context.botToken))
    return { state: "uncertain", reason: "invalid_response" };

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
    if (context.signal?.aborted) return { state: "uncertain", reason: "aborted" };
    return {
      state: "uncertain",
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
      state: "uncertain",
      reason: controller.signal.aborted ? "timeout" : "invalid_response",
    };
  }
  clearTimeout(timer);
  const envelope = parseEnvelope(raw);

  if (response.status === 429) {
    return {
      state: "retry",
      status: 429,
      retryAfterMs: envelope ? retryAfterMs(envelope) : null,
      reason: "rate_limited",
    };
  }

  if (response.status >= 500)
    return { state: "uncertain", reason: "telegram_server_error" };

  if (response.status >= 300) {
    if (
      context.method === "editMessageText" &&
      response.status === 400 &&
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
      isMissingMessage(response.status, envelope)
    )
      return { state: "rejected", status: response.status, reason: "message_missing" };
    return {
      state: "rejected",
      status: response.status,
      reason: envelope ? httpReason(response.status, envelope) : "telegram_400",
    };
  }

  if (!envelope || envelope.ok !== true || response.status !== 200) {
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

function buttons(buttonUrl: string) {
  return {
    inline_keyboard: [[{ text: "Abrir en el hub", url: buttonUrl }]],
  };
}

/** Sends the plain-text opening with one URL button to the episode. */
export async function sendTelegramMessage(
  input: { chatId: string; text: string; buttonUrl: string },
  options: TelegramClientOptions,
): Promise<TelegramSendResult> {
  const normalized = normalizeOptions(options);
  return post({
    method: "sendMessage",
    body: {
      chat_id: input.chatId,
      text: telegramText(input.text),
      disable_web_page_preview: true,
      reply_markup: buttons(input.buttonUrl),
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
  input: { chatId: string; messageId: string; text: string; buttonUrl: string },
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
      reply_markup: buttons(input.buttonUrl),
    },
    fallbackChatId: input.chatId,
    fallbackMessageId: input.messageId,
    ...normalized,
  });
}
