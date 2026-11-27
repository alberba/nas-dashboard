import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_BODY_LIMIT } from "@/lib/request-body";

const handler = vi.hoisted(() =>
  vi.fn<(request: Request) => Promise<Response>>(async () =>
    Response.json({ delegated: true }),
  ),
);

vi.mock("@/lib/auth", () => ({ auth: { handler } }));

const { GET, POST } = await import("../src/app/api/auth/[...all]/route");

const url = "http://localhost:3000/api/auth/sign-in/email";
const headers = {
  "Content-Type": "application/json",
  Cookie: "better-auth.session_token=abc",
  Origin: "http://localhost:3000",
};

function post(body: BodyInit | undefined, extra: Record<string, string> = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { ...headers, ...extra },
    body,
  });
}

/** The request Better Auth was handed on its only call. */
function delegated(): Request {
  expect(handler).toHaveBeenCalledTimes(1);
  return handler.mock.calls[0][0];
}

describe("Better Auth body limit", () => {
  beforeEach(() => {
    handler.mockClear();
  });

  it("answers 413 above the limit and never calls Better Auth", async () => {
    const response = await POST(post("x".repeat(AUTH_BODY_LIMIT + 1)));

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 413 for a declared length above the limit with a small body", async () => {
    const response = await POST(
      post("{}", { "Content-Length": String(AUTH_BODY_LIMIT * 4) }),
    );

    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands Better Auth the same method, URL, headers and body at the limit", async () => {
    const body = JSON.stringify({ pad: "x".repeat(AUTH_BODY_LIMIT - 10) });
    expect(new TextEncoder().encode(body).byteLength).toBe(AUTH_BODY_LIMIT);

    const response = await POST(post(body, { "Content-Length": String(body.length) }));
    const received = delegated();

    expect(response.status).toBe(200);
    expect(received.method).toBe("POST");
    expect(received.url).toBe(url);
    expect(received.headers.get("content-type")).toBe(headers["Content-Type"]);
    expect(received.headers.get("cookie")).toBe(headers.Cookie);
    expect(received.headers.get("origin")).toBe(headers.Origin);
    expect(received.headers.get("content-length")).toBeNull();
    expect(await received.text()).toBe(body);
  });

  it("counts bytes, not characters, so a multibyte body fits exactly at the limit", async () => {
    const body = "é".repeat(AUTH_BODY_LIMIT / 2);

    const fits = await POST(post(body));

    expect(fits.status).toBe(200);
    expect(await delegated().text()).toBe(body);

    handler.mockClear();
    const over = await POST(post(`${body}é`));

    expect(over.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands Better Auth a request without a body when the POST has none", async () => {
    const response = await POST(post(undefined));
    const received = delegated();

    expect(response.status).toBe(200);
    expect(received.method).toBe("POST");
    expect(received.body).toBeNull();
    expect(received.headers.get("cookie")).toBe(headers.Cookie);
  });

  it("does not turn a failing body stream into a 413", async () => {
    const failing = new Request(url, {
      method: "POST",
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("stream failed"));
        },
      }),
      duplex: "half",
    } as RequestInit);

    await expect(POST(new NextRequest(failing))).rejects.toThrow(
      "stream failed",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps GET as the Better Auth handler on the original request", async () => {
    const request = new NextRequest(url, { method: "GET", headers });

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(delegated()).toBe(request);
  });
});
