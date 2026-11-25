import { describe, expect, it } from "vitest";
import { incidentHref, readRoute, routeHref } from "@/components/views/routes";
import {
  TELEGRAM_ORIGIN,
  TELEGRAM_TEXT_LIMIT,
  editTelegramMessage,
  sendTelegramMessage,
  telegramText,
  type TelegramTransport,
} from "@/lib/telegram";

const BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
const CHAT_ID = "-1001234567890";
const BASE_URL = "https://hub.example.com";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeFetch(
  respond: (call: Call) => Response | Promise<Response>,
): { calls: Call[]; transport: TelegramTransport } {
  const calls: Call[] = [];
  const transport: TelegramTransport = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const call = { url, init, body };
    calls.push(call);
    return respond(call);
  };
  return { calls, transport };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("incidentHref", () => {
  it("builds the absolute alerts link for one episode without credentials", () => {
    const href = incidentHref(BASE_URL, "nas-home", 12);
    const url = new URL(href);
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("view")).toBe("alerts");
    expect(url.searchParams.get("host")).toBe("nas-home");
    expect(url.searchParams.get("incident")).toBe("12");
    expect(href).not.toMatch(/token|secret|passkey/i);
  });

  it("rejects an invalid host, episode or base URL", () => {
    expect(() => incidentHref(BASE_URL, "../etc", 1)).toThrow();
    expect(() => incidentHref(BASE_URL, "nas-home", 0)).toThrow();
    expect(() => incidentHref(BASE_URL, "nas-home", 1.5)).toThrow();
    expect(() =>
      incidentHref("https://user:pass@hub.example.com", "nas-home", 1),
    ).toThrow();
    expect(() => incidentHref("not-a-url", "nas-home", 1)).toThrow();
    expect(() => incidentHref("ftp://hub.example.com", "nas-home", 1)).toThrow();
  });

  it("keeps the incident in the route helpers", () => {
    const route = readRoute("?view=alerts&host=nas-home&incident=12");
    expect(route).toMatchObject({ view: "alerts", host: "nas-home", incident: 12 });
    expect(routeHref(route)).toBe("/?view=alerts&host=nas-home&incident=12");
    expect(readRoute("?view=alerts&incident=0").incident).toBeUndefined();
    expect(
      readRoute("?view=alerts&incident=2147483647").incident,
    ).toBe(2147483647);
    expect(
      readRoute("?view=alerts&incident=2147483648").incident,
    ).toBeUndefined();
  });
});

describe("telegram client", () => {
  it("sends plain text with a URL button to the fixed provider origin", async () => {
    const provider = fakeFetch(() =>
      json({ ok: true, result: { message_id: 77, chat: { id: -1001234567890 } } }),
    );
    const result = await sendTelegramMessage(
      {
        chatId: CHAT_ID,
        text: "Incidencia de prueba",
        buttonUrl: incidentHref(BASE_URL, "nas-home", 12),
      },
      { botToken: BOT_TOKEN, fetchImpl: provider.transport },
    );

    expect(provider.calls).toHaveLength(1);
    const [call] = provider.calls;
    expect(call.url).toBe(
      `${TELEGRAM_ORIGIN}/bot${BOT_TOKEN}/sendMessage`,
    );
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect(call.body.chat_id).toBe(CHAT_ID);
    expect(call.body.text).toBe("Incidencia de prueba");
    expect(call.body).not.toHaveProperty("parse_mode");
    const markup = call.body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
    expect(markup.inline_keyboard[0]).toHaveLength(1);
    expect(markup.inline_keyboard[0][0].url).toBe(
      incidentHref(BASE_URL, "nas-home", 12),
    );
    expect(typeof markup.inline_keyboard[0][0].text).toBe("string");
    expect(result).toEqual({
      state: "sent",
      chatId: String(-1001234567890),
      messageId: "77",
    });
  });

  it("truncates plain text to the provider limit", async () => {
    const provider = fakeFetch(() =>
      json({ ok: true, result: { message_id: 1 } }),
    );
    await sendTelegramMessage(
      {
        chatId: CHAT_ID,
        text: "x".repeat(TELEGRAM_TEXT_LIMIT + 50),
        buttonUrl: incidentHref(BASE_URL, "nas-home", 1),
      },
      { botToken: BOT_TOKEN, fetchImpl: provider.transport },
    );
    const text = String(provider.calls[0].body.text);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(telegramText("y".repeat(TELEGRAM_TEXT_LIMIT + 5)).length).toBe(
      TELEGRAM_TEXT_LIMIT,
    );
  });

  it("honours retry_after in seconds", async () => {
    const provider = fakeFetch(() =>
      json(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 12 },
        },
        429,
      ),
    );
    const result = await sendTelegramMessage(
      { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
      { botToken: BOT_TOKEN, fetchImpl: provider.transport },
    );
    expect(result).toMatchObject({
      state: "retry",
      status: 429,
      retryAfterMs: 12_000,
      reason: "rate_limited",
    });
  });

  it("classifies 429 without a usable wait as a retry with no deadline", async () => {
    const provider = fakeFetch(() => json({ ok: false }, 429));
    const result = await sendTelegramMessage(
      { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
      { botToken: BOT_TOKEN, fetchImpl: provider.transport },
    );
    expect(result).toMatchObject({ state: "retry", retryAfterMs: null });
  });

  it("treats 400, 403 and 404 as confirmed permanent rejections", async () => {
    for (const status of [400, 403, 404]) {
      const provider = fakeFetch(() => json({ ok: false }, status));
      const result = await sendTelegramMessage(
        { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
        { botToken: BOT_TOKEN, fetchImpl: provider.transport },
      );
      expect(result).toMatchObject({ state: "rejected", status });
    }
  });

  it("does not confirm a 5xx, a broken body or a missing message id", async () => {
    const server = fakeFetch(() => json({ ok: false }, 500));
    expect(
      await sendTelegramMessage(
        { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
        { botToken: BOT_TOKEN, fetchImpl: server.transport },
      ),
    ).toMatchObject({ state: "uncertain", reason: "telegram_server_error" });

    const broken = fakeFetch(() => new Response("{", { status: 200 }));
    expect(
      await sendTelegramMessage(
        { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
        { botToken: BOT_TOKEN, fetchImpl: broken.transport },
      ),
    ).toMatchObject({ state: "uncertain", reason: "invalid_response" });

    const noId = fakeFetch(() => json({ ok: true, result: {} }));
    expect(
      await sendTelegramMessage(
        { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
        { botToken: BOT_TOKEN, fetchImpl: noId.transport },
      ),
    ).toMatchObject({ state: "uncertain", reason: "missing_message_id" });
  });

  it("treats a transport failure as an uncertain attempt", async () => {
    const failed: TelegramTransport = async () => {
      throw new Error("network down");
    };
    const result = await sendTelegramMessage(
      { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
      { botToken: BOT_TOKEN, fetchImpl: failed },
    );
    expect(result).toMatchObject({ state: "uncertain", reason: "network" });
  });

  it("edits the original message and accepts already-applied content", async () => {
    const applied = fakeFetch(() =>
      json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, 400),
    );
    const result = await editTelegramMessage(
      {
        chatId: CHAT_ID,
        messageId: "77",
        text: "Severidad actualizada",
        buttonUrl: incidentHref(BASE_URL, "nas-home", 12),
      },
      { botToken: BOT_TOKEN, fetchImpl: applied.transport },
    );
    expect(result).toMatchObject({
      state: "sent",
      chatId: CHAT_ID,
      messageId: "77",
    });
    const [call] = applied.calls;
    expect(call.url).toBe(`${TELEGRAM_ORIGIN}/bot${BOT_TOKEN}/editMessageText`);
    expect(call.body).toMatchObject({ chat_id: CHAT_ID, message_id: "77" });
    expect(call.body).not.toHaveProperty("parse_mode");
  });

  it("reports a deleted message as a permanent edit failure", async () => {
    const provider = fakeFetch(() =>
      json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message to edit not found",
        },
        400,
      ),
    );
    const result = await editTelegramMessage(
      {
        chatId: CHAT_ID,
        messageId: "77",
        text: "Cierre",
        buttonUrl: incidentHref(BASE_URL, "nas-home", 12),
      },
      { botToken: BOT_TOKEN, fetchImpl: provider.transport },
    );
    expect(result).toMatchObject({
      state: "rejected",
      status: 400,
      reason: "message_missing",
    });
  });
});
