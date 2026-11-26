import { describe, expect, it } from "vitest";
import { incidentHref, readRoute, routeHref } from "@/components/views/routes";
import {
  digestCountersLine,
  renderDigestSnapshot,
  type DigestCounts,
  type DigestDetail,
} from "@/lib/digest-content";
import {
  TELEGRAM_MAX_RETRY_AFTER_MS,
  TELEGRAM_ORIGIN,
  TELEGRAM_TEXT_LIMIT,
  editTelegramMessage,
  sendTelegramMessage,
  sendTelegramReply,
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

describe("daily digest rendering", () => {
  const ALERTS_URL = `${BASE_URL}/?view=alerts`;

  function counts(overrides: Partial<DigestCounts> = {}): DigestCounts {
    return {
      openNow: 0,
      newInPeriod: 0,
      newOpen: 0,
      newClosed: 0,
      critical: 0,
      resolved: 0,
      ...overrides,
    };
  }

  function detail(
    id: number,
    title: string,
    at = id,
    hostId = "nas-home",
  ): DigestDetail {
    return { id, hostId, title, severity: "warning", at };
  }

  function bullets(text: string): string[] {
    return text.split("\n").filter((line) => line.startsWith("· "));
  }

  it("keeps the footer and the exact omitted count inside the provider limit", () => {
    const details = Array.from({ length: 60 }, (_, index) =>
      detail(index + 1, `Seguimiento ${index + 1} ${"x".repeat(120)}`),
    );
    const totals = counts({
      openNow: 60,
      newInPeriod: 60,
      newOpen: 60,
      critical: 3,
      resolved: 4,
    });
    const rendered = renderDigestSnapshot({
      date: "2026-11-26",
      counts: totals,
      details,
      aggregates: [],
      alertsUrl: ALERTS_URL,
    });

    expect(rendered.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(rendered.text.endsWith(ALERTS_URL)).toBe(true);
    expect(rendered.text).toContain(digestCountersLine(totals));
    expect(rendered.omitted).toBeGreaterThan(0);
    expect(rendered.entries + rendered.omitted).toBe(totals.openNow);
    expect(rendered.text).toContain(`+${rendered.omitted} más`);
    expect(rendered.listed).toHaveLength(rendered.entries);
    expect(bullets(rendered.text)).toHaveLength(rendered.entries);
  });

  it("counts a dropped host group as omitted instead of representing it", () => {
    const totals = counts({
      openNow: 100,
      newInPeriod: 80,
      newOpen: 80,
    });
    const details = Array.from({ length: 30 }, (_, index) =>
      detail(index + 1, `Línea ${index + 1} ${"y".repeat(110)}`),
    );
    const aggregates = [
      { hostId: "a-host", count: 50 },
      { hostId: "z-host", count: 20 },
    ];
    const rendered = renderDigestSnapshot({
      date: "2026-11-26",
      counts: totals,
      details,
      aggregates,
      alertsUrl: ALERTS_URL,
      limit: 1_200,
    });

    expect(rendered.text.length).toBeLessThanOrEqual(1_200);
    expect(rendered.text.endsWith(ALERTS_URL)).toBe(true);
    // Both aggregate lines leave before their group can be claimed.
    expect(rendered.text).not.toContain("50 anteriores");
    expect(rendered.text).not.toContain("20 anteriores");
    expect(rendered.omitted).toBeGreaterThanOrEqual(70);
    expect(rendered.entries + rendered.omitted).toBe(totals.openNow);
    expect(rendered.text).toContain(`+${rendered.omitted} más`);
    expect(bullets(rendered.text)).toHaveLength(rendered.entries);
  });

  it("keeps a represented host group out of the omitted figure", () => {
    const totals = counts({ openNow: 30, newInPeriod: 1, newOpen: 1 });
    const rendered = renderDigestSnapshot({
      date: "2026-11-26",
      counts: totals,
      details: [detail(1, "Nueva abierta")],
      aggregates: [{ hostId: "nas-home", count: 29 }],
      alertsUrl: ALERTS_URL,
    });

    expect(rendered.entries).toBe(30);
    expect(rendered.omitted).toBe(0);
    expect(rendered.text).toContain("29 anteriores");
    expect(rendered.text).not.toContain("+0");
  });

  it("does not split surrogate pairs or let a title forge another row", () => {
    const hostile = `${"😀".repeat(80)}\n· forged · critical · fake\u0000\u0007\u202e`;
    const rendered = renderDigestSnapshot({
      date: "2026-11-26",
      counts: counts({ openNow: 2, newInPeriod: 2, newOpen: 2 }),
      details: [detail(1, hostile), detail(2, "Sin sorpresas")],
      aggregates: [],
      alertsUrl: ALERTS_URL,
    });

    expect(rendered.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(rendered.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(rendered.text).not.toContain("\u0000");
    expect(rendered.text).not.toMatch(/\n· forged/);
    expect(rendered.text).toContain("Sin sorpresas");
    expect(bullets(rendered.text)).toHaveLength(2);
  });

  it("orders episodes that share an instant by id", () => {
    const first = detail(3, "Tercera", 5);
    const second = detail(1, "Primera", 5);
    const third = detail(2, "Segunda", 5);
    const rendered = renderDigestSnapshot({
      date: "2026-11-26",
      counts: counts({ openNow: 3, newInPeriod: 3, newOpen: 3 }),
      details: [first, second, third],
      aggregates: [],
      alertsUrl: ALERTS_URL,
    });

    expect(rendered.listed).toEqual([1, 2, 3]);
    const lines = rendered.text.split("\n");
    const positions = ["Primera", "Segunda", "Tercera"].map((title) =>
      lines.findIndex((line) => line.includes(title)),
    );
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("keeps the footer when there are no detail lines", () => {
    const totals = counts({
      newInPeriod: 2,
      newOpen: 1,
      newClosed: 1,
      critical: 1,
      resolved: 1,
    });
    const rendered = renderDigestSnapshot({
      date: "2026-11-26",
      counts: totals,
      details: [],
      aggregates: [],
      alertsUrl: ALERTS_URL,
    });

    expect(rendered.entries).toBe(0);
    expect(rendered.omitted).toBe(0);
    expect(rendered.text).toContain(digestCountersLine(totals));
    expect(rendered.text.endsWith(ALERTS_URL)).toBe(true);
    expect(bullets(rendered.text)).toHaveLength(0);
  });

  it("honours a narrow budget while keeping the footer", () => {
    const totals = counts({ openNow: 80, newInPeriod: 80, newOpen: 80 });
    const details = Array.from({ length: 80 }, (_, index) =>
      detail(index + 1, `Aviso ${index + 1} ${"z".repeat(100)}`),
    );
    for (const limit of [260, 320, 512, 2_048]) {
      const rendered = renderDigestSnapshot({
        date: "2026-11-26",
        counts: totals,
        details,
        aggregates: [],
        alertsUrl: ALERTS_URL,
        limit,
      });
      expect(rendered.text.length).toBeLessThanOrEqual(limit);
      expect(rendered.text.endsWith(ALERTS_URL)).toBe(true);
      expect(rendered.entries + rendered.omitted).toBe(totals.openNow);
      if (rendered.omitted > 0)
        expect(rendered.text).toContain(`+${rendered.omitted} más`);
      else expect(rendered.text).not.toContain("+0");
    }
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

  it("clamps a provider wait that would leave the representable range", async () => {
    for (const retryAfter of [TELEGRAM_MAX_RETRY_AFTER_MS, 1e12, 1e308]) {
      const provider = fakeFetch(() =>
        json(
          { ok: false, error_code: 429, parameters: { retry_after: retryAfter } },
          429,
        ),
      );
      const result = await sendTelegramMessage(
        { chatId: CHAT_ID, text: "aviso", buttonUrl: incidentHref(BASE_URL, "nas-home", 1) },
        { botToken: BOT_TOKEN, fetchImpl: provider.transport },
      );
      expect(result).toMatchObject({
        state: "retry",
        reason: "rate_limited",
        retryAfterMs: TELEGRAM_MAX_RETRY_AFTER_MS,
      });
    }
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

  it("replies quoting the notice without sound and without a keyboard", async () => {
    const provider = fakeFetch(() =>
      json({ ok: true, result: { message_id: 88, chat: { id: -1001234567890 } } }),
    );
    const result = await sendTelegramReply(
      { chatId: CHAT_ID, replyToMessageId: "77", text: "Por qué me llegó" },
      { botToken: BOT_TOKEN, fetchImpl: provider.transport },
    );

    expect(provider.calls).toHaveLength(1);
    const [call] = provider.calls;
    expect(call.url).toBe(`${TELEGRAM_ORIGIN}/bot${BOT_TOKEN}/sendMessage`);
    expect(call.body).toMatchObject({
      chat_id: CHAT_ID,
      text: "Por qué me llegó",
      disable_notification: true,
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    });
    expect(call.body).not.toHaveProperty("reply_markup");
    expect(call.body).not.toHaveProperty("parse_mode");
    expect(result).toEqual({
      state: "sent",
      chatId: String(-1001234567890),
      messageId: "88",
    });
    // The token only lives in the URL `botRequest` builds; no result carries it.
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });

  it("refuses a reply to a message id that is not a safe integer", async () => {
    const provider = fakeFetch(() =>
      json({ ok: true, result: { message_id: 1 } }),
    );
    for (const replyToMessageId of ["", "abc", "1.5", "-3", "0"]) {
      expect(
        await sendTelegramReply(
          { chatId: CHAT_ID, replyToMessageId, text: "x" },
          { botToken: BOT_TOKEN, fetchImpl: provider.transport },
        ),
      ).toEqual({ state: "rejected", status: 400, reason: "message_missing" });
    }
    // A refused reply never reaches the provider.
    expect(provider.calls).toHaveLength(0);
  });
});
