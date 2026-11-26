/**
 * Simulated Bot API for the updates lane.
 *
 * It routes by method, confirms updates by `offset` exactly like the provider
 * (an update is only confirmed once a call sends a higher offset), records
 * `allowed_updates` and `timeout`, and can fail once per method so the retry and
 * cooldown paths are exercised without a network.
 */

import type { TelegramTransport } from "@/lib/telegram";

export type FakeBotMethod =
  | "getUpdates"
  | "deleteWebhook"
  | "answerCallbackQuery"
  | "sendMessage"
  | "editMessageText";

export type FakeBotFailure = "rate_limited" | "server_error";

export type FakeBotCall = {
  method: string;
  url: string;
  body: Record<string, unknown>;
};

export type FakeBotApiOptions = {
  chatId?: number;
  /** One-shot failures consumed by the first call of that method. */
  failOnce?: Partial<Record<FakeBotMethod, FakeBotFailure>>;
  startMessageId?: number;
};

export type CallbackUpdateInput = {
  updateId: number;
  data: string;
  callbackQueryId?: string;
  fromId?: number;
  fromIsBot?: boolean;
  chatId?: number;
  chatType?: string;
  messageId?: number;
  messageDate?: number;
  messageFromIsBot?: boolean;
};

type KeyboardButton = {
  text?: string;
  url?: string;
  callback_data?: string;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createFakeBotApi(options: FakeBotApiOptions = {}) {
  const chatId = options.chatId ?? 123456789;
  const calls: FakeBotCall[] = [];
  const queued: Array<{ update_id: number }> = [];
  const failures = { ...options.failOnce };
  let nextMessageId = options.startMessageId ?? 501;
  let keyboard: string[] = [];

  function recordKeyboard(body: Record<string, unknown>) {
    const markup = body.reply_markup as
      | { inline_keyboard?: KeyboardButton[][] }
      | undefined;
    keyboard = (markup?.inline_keyboard ?? []).flatMap((row) =>
      row.flatMap((button) =>
        typeof button.callback_data === "string" ? [button.callback_data] : [],
      ),
    );
  }

  const transport: TelegramTransport = async (url, init) => {
    const method = url.slice(url.lastIndexOf("/") + 1);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    calls.push({ method, url, body });

    const failure = failures[method as FakeBotMethod];
    if (failure) {
      delete failures[method as FakeBotMethod];
      if (failure === "rate_limited")
        return json({ ok: false, parameters: { retry_after: 2 } }, 429);
      return json({ ok: false }, 500);
    }

    switch (method) {
      case "getUpdates": {
        const offset = typeof body.offset === "number" ? body.offset : null;
        // Confirmation by offset: everything below the offset is already done.
        return json({
          ok: true,
          result: queued.filter(
            (update) => offset === null || update.update_id >= offset,
          ),
        });
      }
      case "deleteWebhook":
        return json({ ok: true, result: true });
      case "answerCallbackQuery":
        return json({ ok: true, result: true });
      case "sendMessage": {
        recordKeyboard(body);
        return json({
          ok: true,
          result: { message_id: nextMessageId++, chat: { id: chatId } },
        });
      }
      case "editMessageText": {
        recordKeyboard(body);
        const edited =
          typeof body.message_id === "number" ? body.message_id : nextMessageId++;
        return json({ ok: true, result: { message_id: edited, chat: { id: chatId } } });
      }
      default:
        return json({ ok: false, description: "unknown method" }, 404);
    }
  };

  /** Queues an update, keeping the provider's ascending `update_id` order. */
  function enqueueUpdate(update: unknown) {
    queued.push(update as { update_id: number });
    queued.sort((left, right) => left.update_id - right.update_id);
  }

  /** Builds a `callback_query` update with the operator's defaults. */
  function callbackUpdate(input: CallbackUpdateInput) {
    return {
      update_id: input.updateId,
      callback_query: {
        id: input.callbackQueryId ?? `cb-${input.updateId}`,
        from: {
          id: input.fromId ?? chatId,
          is_bot: input.fromIsBot ?? false,
          first_name: "Operador",
        },
        chat_instance: "1",
        data: input.data,
        message: {
          message_id: input.messageId ?? 501,
          date: input.messageDate ?? 1_700_000_000,
          chat: {
            id: input.chatId ?? chatId,
            type: input.chatType ?? "private",
          },
          from: {
            id: 7,
            is_bot: input.messageFromIsBot ?? true,
            first_name: "hub",
          },
        },
      },
    };
  }

  /** `callback_data` values of the last sent or edited keyboard. */
  function lastKeyboard(): string[] {
    return [...keyboard];
  }

  return { transport, calls, enqueueUpdate, callbackUpdate, lastKeyboard };
}
