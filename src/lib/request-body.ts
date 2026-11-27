/**
 * Bounded request-body reader (SEC-04, D-08).
 *
 * Every mutation reads its body through here so a huge request is rejected
 * before the hub buffers it whole or hands it to `JSON.parse`. The declared
 * `Content-Length` is only a shortcut: a header that is missing or understates
 * the body does not skip the limit, because the streaming byte count is the
 * authority.
 */

export const DEFAULT_BODY_LIMIT = 16 * 1024;

/** Thrown when a body exceeds its limit. The route answers 413, never 400/503. */
export class BodyTooLarge extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "BodyTooLarge";
    this.limit = limit;
  }
}

function declaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null || header.trim() === "") return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}

/** Reads the body as UTF-8 text; exactly `limit` bytes pass, one more does not. */
export async function readBodyText(
  request: Request,
  limit: number = DEFAULT_BODY_LIMIT,
): Promise<string> {
  const declared = declaredLength(request);
  if (declared !== null && declared > limit) throw new BodyTooLarge(limit);

  const stream = request.body;
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Decode once over the whole buffer: decoding per chunk would split a
  // multibyte character that straddles two chunks.
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Parses the body as JSON only once it fit. An empty or malformed body keeps
 * the `JSON.parse` error, exactly as `request.json()` did.
 */
export async function readJsonBody(
  request: Request,
  options: { limit?: number } = {},
): Promise<unknown> {
  return JSON.parse(await readBodyText(request, options.limit));
}
