import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildContentSecurityPolicy } from "@/lib/csp";

/**
 * Adds a per-request nonce and the document Content Security Policy. Next
 * reads the nonce from the request `Content-Security-Policy` header and
 * applies it to the framework and page scripts during dynamic rendering.
 *
 * The matcher only covers documents: API responses get their own static
 * policy from `next.config.ts`, and every static asset (including `sw.js`,
 * the manifest and the icons) is served untouched.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|.*\\..*).*)"],
};
