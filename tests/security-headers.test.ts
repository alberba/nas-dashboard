import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { buildContentSecurityPolicy } from "../src/lib/csp";

type Header = { key: string; value: string };
type Entry = { source: string; headers: Header[] };

async function entries(): Promise<Entry[]> {
  const result = await nextConfig.headers?.();
  return (result ?? []) as Entry[];
}

function withSource(list: Entry[], source: string) {
  const entry = list.find((candidate) => candidate.source === source);
  expect(entry, `missing header entry for ${source}`).toBeDefined();
  return entry!;
}

function header(entry: Entry, key: string) {
  return entry.headers.find(
    (candidate) => candidate.key.toLowerCase() === key.toLowerCase(),
  )?.value;
}

function directives(policy: string) {
  const parsed = new Map<string, string>();
  for (const raw of policy.split(";")) {
    const [name, ...sources] = raw.trim().split(/\s+/);
    if (name) parsed.set(name.toLowerCase(), sources.join(" "));
  }
  return parsed;
}

describe("next.config.ts headers", () => {
  it("adds a conservative HSTS to every path and keeps the previous headers", async () => {
    const entry = withSource(await entries(), "/:path*");
    const hsts = header(entry, "Strict-Transport-Security");
    expect(hsts).toBeDefined();
    const tokens = hsts!.split(";").map((token) => token.trim());
    expect(tokens).toContain("max-age=15552000");
    expect(hsts!.toLowerCase()).not.toContain("includesubdomains");
    expect(hsts!.toLowerCase()).not.toContain("preload");

    expect(header(entry, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(entry, "X-Frame-Options")).toBe("DENY");
    expect(header(entry, "Referrer-Policy")).toBe("same-origin");
    expect(header(entry, "Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("gives API responses a minimal CSP and no document entry sets one", async () => {
    const list = await entries();
    const apiEntry = withSource(list, "/api/:path*");
    const policy = header(apiEntry, "Content-Security-Policy");
    expect(policy).toBeDefined();
    const parsed = directives(policy!);
    expect(parsed.get("default-src")).toBe("'none'");
    expect(parsed.get("frame-ancestors")).toBe("'none'");

    const documentPolicies = list
      .filter((entry) => entry.source !== "/api/:path*")
      .map((entry) => header(entry, "Content-Security-Policy"))
      .filter((value) => value !== undefined);
    expect(documentPolicies).toEqual([]);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("keeps scripts strict in production", () => {
    const parsed = directives(buildContentSecurityPolicy("test-nonce", false));
    const script = parsed.get("script-src")!;
    expect(script).toContain("'nonce-test-nonce'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(parsed.get("object-src")).toBe("'none'");
    expect(parsed.get("base-uri")).toBe("'self'");
    expect(parsed.get("form-action")).toBe("'self'");
    expect(parsed.get("connect-src")).toBe("'self'");
    expect(parsed.get("frame-ancestors")).toBe("'none'");
  });

  it("only relaxes eval in development", () => {
    const parsed = directives(buildContentSecurityPolicy("test-nonce", true));
    const script = parsed.get("script-src")!;
    expect(script).toContain("'nonce-test-nonce'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
  });
});
