import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BodyTooLarge,
  DEFAULT_BODY_LIMIT,
  readBodyText,
  readJsonBody,
} from "../src/lib/request-body";

const encoder = new TextEncoder();

/** A request whose body is a stream of the given chunks, read only on demand. */
function streamed(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  probe: { pulled?: boolean; cancelled?: boolean } = {},
) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        probe.pulled = true;
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      cancel() {
        probe.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return new Request("http://localhost/api/action", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

function textRequest(text: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/action", {
    method: "POST",
    headers,
    body: text,
  });
}

describe("bounded request body", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a declared length over the limit without reading the stream", async () => {
    const probe = { pulled: false };
    const request = streamed(
      [encoder.encode("{}")],
      { "Content-Length": String(DEFAULT_BODY_LIMIT + 1) },
      probe,
    );

    await expect(readBodyText(request)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(probe.pulled).toBe(false);
  });

  it("cuts a chunked body without a header and cancels the reader", async () => {
    const probe = { cancelled: false };
    const chunk = new Uint8Array(1024).fill(97);
    const request = streamed(
      Array.from({ length: 64 }, () => chunk),
      {},
      probe,
    );

    await expect(readBodyText(request)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(probe.cancelled).toBe(true);
  });

  it("carries the limit it enforced", async () => {
    const error = await readBodyText(textRequest("x".repeat(20)), 10).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BodyTooLarge);
    expect((error as BodyTooLarge).limit).toBe(10);
  });

  it.each([
    ["without a header", {}],
    ["with an honest header", { "Content-Length": "16384" }],
  ])("accepts exactly the limit %s", async (_label, headers) => {
    const body = "a".repeat(DEFAULT_BODY_LIMIT);

    expect(
      await readBodyText(
        streamed([encoder.encode(body)], headers),
        DEFAULT_BODY_LIMIT,
      ),
    ).toBe(body);
  });

  it.each([
    ["without a header", {}],
    ["with a header that understates", { "Content-Length": "16384" }],
  ])("rejects one byte over the limit %s", async (_label, headers) => {
    const body = encoder.encode("a".repeat(DEFAULT_BODY_LIMIT + 1));

    await expect(
      readBodyText(streamed([body], headers), DEFAULT_BODY_LIMIT),
    ).rejects.toBeInstanceOf(BodyTooLarge);
  });

  it("is not fooled by a Content-Length that lies downwards", async () => {
    const request = streamed(
      [encoder.encode("a".repeat(DEFAULT_BODY_LIMIT * 2))],
      { "Content-Length": "5" },
    );

    await expect(readBodyText(request)).rejects.toBeInstanceOf(BodyTooLarge);
  });

  it("falls back to the stream when the header is not numeric", async () => {
    const small = streamed([encoder.encode("hola")], {
      "Content-Length": "abc",
    });
    const large = streamed([encoder.encode("a".repeat(20))], {
      "Content-Length": "abc",
    });

    expect(await readBodyText(small, 10)).toBe("hola");
    await expect(readBodyText(large, 10)).rejects.toBeInstanceOf(BodyTooLarge);
  });

  it("decodes a multibyte character split between chunks at every cut", async () => {
    const text = '{"n":"ñ é € 日本語 😀 𝄞"}';
    const bytes = encoder.encode(text);

    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const request = streamed([bytes.slice(0, cut), bytes.slice(cut)]);
      expect(await readBodyText(request), `cut at ${cut}`).toBe(text);
    }
  });

  it("returns an empty string when there is no body", async () => {
    const request = new Request("http://localhost/api/action", {
      method: "POST",
    });

    expect(await readBodyText(request)).toBe("");
  });

  it("parses a body that fits as JSON", async () => {
    expect(await readJsonBody(textRequest('{"a":1}'))).toEqual({ a: 1 });
  });

  it("does not call JSON.parse on a body over the limit", async () => {
    const parse = vi.spyOn(JSON, "parse");

    await expect(
      readJsonBody(textRequest("x".repeat(DEFAULT_BODY_LIMIT + 1))),
    ).rejects.toBeInstanceOf(BodyTooLarge);
    expect(parse).not.toHaveBeenCalled();
  });

  it("honours a per-call limit above the default", async () => {
    const value = { padding: "x".repeat(DEFAULT_BODY_LIMIT * 2) };
    const request = textRequest(JSON.stringify(value));

    expect(
      await readJsonBody(request, { limit: DEFAULT_BODY_LIMIT * 4 }),
    ).toEqual(value);
  });

  it("keeps the JSON.parse error for an empty or malformed body", async () => {
    await expect(readJsonBody(textRequest(""))).rejects.toBeInstanceOf(
      SyntaxError,
    );
    await expect(readJsonBody(textRequest("{nope"))).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});
