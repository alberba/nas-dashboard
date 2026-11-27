import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import {
  AUTH_BODY_LIMIT,
  BodyTooLarge,
  readBodyText,
} from "@/lib/request-body";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

/**
 * SEC-04 (D-08): the credential endpoints are the most exposed surface without
 * a session, so their body is bounded like every other mutation. The body is
 * read once under the limit and a fresh request carries it to Better Auth: the
 * original stream is already consumed. Method, URL and headers pass unchanged
 * except `content-length`, which the new request computes itself.
 */
export async function POST(request: Request) {
  let text: string;
  try {
    text = await readBodyText(request, AUTH_BODY_LIMIT);
  } catch (error) {
    if (error instanceof BodyTooLarge)
      return Response.json(
        { error: "La solicitud es demasiado grande." },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    throw error;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return handlers.POST(
    new Request(request.url, {
      method: request.method,
      headers,
      body: text === "" ? undefined : text,
    }),
  );
}
