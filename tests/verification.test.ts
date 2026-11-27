import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_VERIFICATION_TTL_MS,
  recordRecentVerification,
  rememberPasskeyVerification,
  type VerificationRecord,
  type VerificationSession,
  type VerificationStore,
} from "../src/lib/verification";
import {
  guardSensitiveAction,
  handlePasswordVerification,
  handleVerificationStatus,
} from "../src/lib/verification-api";

class MemoryStore implements VerificationStore {
  readonly records = new Map<string, VerificationRecord>();

  async find(sessionId: string) {
    return this.records.get(sessionId) ?? null;
  }

  async save(record: VerificationRecord) {
    this.records.set(record.sessionId, record);
  }
}

const session: VerificationSession = {
  user: { id: "user-1" },
  session: { id: "session-1" },
};
const now = new Date("2026-11-13T10:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.BETTER_AUTH_URL;
});

describe("recent verification for sensitive actions", () => {
  it("uses the passkey on the primary domain and the password on the alternate one", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();

    const primary = await handleVerificationStatus({
      request: new Request("https://hub.example/api/verification"),
      session,
      store,
      now,
    });
    const alternate = await handleVerificationStatus({
      request: new Request("https://private.example/api/verification"),
      session,
      store,
      now,
    });

    expect(await primary.json()).toMatchObject({ method: "passkey" });
    expect(await alternate.json()).toMatchObject({ method: "password" });
  });

  it("keeps passkeys on the primary host when the proxy reports http", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const response = await handleVerificationStatus({
      request: new Request("http://hub.example/api/verification"),
      session,
      store: new MemoryStore(),
      now,
    });

    expect(await response.json()).toMatchObject({ method: "passkey" });
  });

  it("reads the public host from the proxy headers on an internal request", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const response = await handleVerificationStatus({
      request: new Request("http://127.0.0.1:3000/api/verification", {
        headers: { host: "hub.example", "x-forwarded-proto": "" },
      }),
      session,
      store: new MemoryStore(),
      now,
    });

    expect(await response.json()).toMatchObject({ method: "passkey" });
  });

  it("rejects a sensitive action with a typed error when there is no verification", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const response = await guardSensitiveAction({
      request: new Request("https://hub.example/api/action", {
        headers: { "x-recent-verification": "true", "x-verified-at": now.toISOString() },
      }),
      session,
      store: new MemoryStore(),
      now,
    });

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({
      code: "recent_verification_required",
      reason: "missing",
      method: "passkey",
      verifiedAt: null,
      expiresAt: null,
    });
  });

  it("rejects a sensitive action with a typed error when the verification has expired", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    const verifiedAt = new Date(
      now.getTime() - RECENT_VERIFICATION_TTL_MS - 1_000,
    );
    await recordRecentVerification(store, session, "passkey", verifiedAt);

    const response = await guardSensitiveAction({
      request: new Request("https://hub.example/api/action"),
      session,
      store,
      now,
    });
    const body = await response?.json();

    expect(response?.status).toBe(403);
    expect(body).toMatchObject({
      code: "recent_verification_required",
      reason: "expired",
      method: "passkey",
    });
    expect(body.verifiedAt).toBe(verifiedAt.toISOString());
    expect(body.expiresAt).toBe(
      new Date(verifiedAt.getTime() + RECENT_VERIFICATION_TTL_MS).toISOString(),
    );
  });

  it("accepts a sensitive action during the five minutes after passkey verification", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    await recordRecentVerification(
      store,
      session,
      "passkey",
      new Date(now.getTime() - RECENT_VERIFICATION_TTL_MS + 1),
    );

    const response = await guardSensitiveAction({
      request: new Request("https://hub.example/api/action", {
        headers: { "x-recent-verification": "false" },
      }),
      session,
      store,
      now,
    });

    expect(response).toBeNull();
  });

  it("accepts the password on the alternate domain for five minutes", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    const verifyPassword = vi.fn().mockResolvedValue({ status: true });

    const verified = await handlePasswordVerification({
      request: new Request("https://private.example/api/verification/password", {
        method: "POST",
        headers: {
          origin: "https://private.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "a long enough password" }),
      }),
      session,
      store,
      now,
      verifyPassword,
    });

    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      method: "password",
      recent: true,
      verifiedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + RECENT_VERIFICATION_TTL_MS,
      ).toISOString(),
    });
    expect(store.records.get("session-1")).toMatchObject({
      userId: "user-1",
      method: "password",
    });
    expect(verifyPassword).toHaveBeenCalledOnce();

    const guarded = await guardSensitiveAction({
      request: new Request("https://private.example/api/action"),
      session,
      store,
      now,
    });
    expect(guarded).toBeNull();
  });

  it("does not record a password that the auth service rejects", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    const verifyPassword = vi.fn().mockRejectedValue(new Error("invalid"));

    const response = await handlePasswordVerification({
      request: new Request("https://private.example/api/verification/password", {
        method: "POST",
        headers: {
          origin: "https://private.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "the wrong password" }),
      }),
      session,
      store,
      now,
      verifyPassword,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "invalid_password",
    });
    expect(store.records.size).toBe(0);
  });

  it("does not offer the password on the primary domain", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    const verifyPassword = vi.fn().mockResolvedValue({ status: true });

    const response = await handlePasswordVerification({
      request: new Request("https://hub.example/api/verification/password", {
        method: "POST",
        headers: {
          origin: "https://hub.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "a long enough password" }),
      }),
      session,
      store,
      now,
      verifyPassword,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "password_not_allowed",
      method: "passkey",
    });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });

  it("does not give the password to a forged alternate Origin on the primary host", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    const verifyPassword = vi.fn().mockResolvedValue({ status: true });

    const response = await handlePasswordVerification({
      request: new Request("https://hub.example/api/verification/password", {
        method: "POST",
        headers: {
          host: "hub.example",
          origin: "https://private.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "a long enough password" }),
      }),
      session,
      store,
      now,
      verifyPassword,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "password_not_allowed",
      method: "passkey",
    });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });

  it("does not let a stored password verification satisfy an action sent with a forged Origin", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    await recordRecentVerification(store, session, "password", now);

    const response = await guardSensitiveAction({
      request: new Request("https://hub.example/api/action", {
        method: "POST",
        headers: {
          host: "hub.example",
          origin: "https://private.example",
        },
      }),
      session,
      store,
      now,
    });

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({
      code: "recent_verification_required",
      method: "passkey",
    });
  });

  it("keeps the password on the genuine alternate entry, end to end", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();
    const verifyPassword = vi.fn().mockResolvedValue({ status: true });
    const headers = {
      host: "private.example",
      origin: "https://private.example",
    };

    const verified = await handlePasswordVerification({
      request: new Request("http://127.0.0.1:3000/api/verification/password", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ password: "a long enough password" }),
      }),
      session,
      store,
      now,
      verifyPassword,
    });

    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ method: "password" });
    expect(store.records.get("session-1")).toMatchObject({ method: "password" });

    const guarded = await guardSensitiveAction({
      request: new Request("http://127.0.0.1:3000/api/action", {
        method: "POST",
        headers,
      }),
      session,
      store,
      now,
    });
    expect(guarded).toBeNull();
  });

  describe("method by connection host", () => {
    type Row = {
      name: string;
      headers: Record<string, string>;
      method: "passkey" | "password";
      primary?: string | null;
    };
    const rows: Row[] = [
      {
        name: "alternate Host and Origin",
        headers: { host: "private.example", origin: "https://private.example" },
        method: "password",
      },
      {
        name: "alternate Host without Origin",
        headers: { host: "private.example" },
        method: "password",
      },
      {
        name: "primary Host without Origin",
        headers: { host: "hub.example" },
        method: "passkey",
      },
      {
        name: "primary Origin against an alternate Host",
        headers: { host: "private.example", origin: "https://hub.example" },
        method: "passkey",
      },
      {
        name: "alternate Origin against the primary Host",
        headers: { host: "hub.example", origin: "https://private.example" },
        method: "passkey",
      },
      {
        name: "the literal null Origin against an alternate Host",
        headers: { host: "private.example", origin: "null" },
        method: "passkey",
      },
      {
        name: "the same name on another port",
        headers: {
          host: "private.example:8443",
          origin: "https://private.example",
        },
        method: "password",
      },
      {
        name: "a forwarded host against the primary Host",
        headers: { host: "hub.example", "x-forwarded-host": "private.example" },
        method: "passkey",
      },
      {
        name: "a forwarded host and protocol against the primary Host",
        headers: {
          host: "hub.example",
          "x-forwarded-host": "private.example",
          "x-forwarded-proto": "https",
          origin: "https://private.example",
        },
        method: "passkey",
      },
      {
        name: "a Host list",
        headers: { host: "private.example, hub.example" },
        method: "passkey",
      },
      {
        name: "an empty Host",
        headers: { host: "" },
        method: "passkey",
      },
      {
        name: "an unreadable Host",
        headers: { host: "private example" },
        method: "passkey",
      },
      {
        name: "a bracketed IPv6 Host",
        headers: { host: "[::1]:3000" },
        method: "passkey",
      },
      {
        name: "no primary domain configured",
        headers: { host: "private.example", origin: "https://private.example" },
        method: "passkey",
        primary: null,
      },
    ];

    it.each(rows)("answers $method for $name", async (row) => {
      // primaryOrigin() falls back to TRUSTED_ORIGINS, so both go for "none".
      const primary = row.primary === null ? undefined : "https://hub.example";
      vi.stubEnv("BETTER_AUTH_URL", primary);
      if (!primary) vi.stubEnv("TRUSTED_ORIGINS", undefined);

      const response = await handleVerificationStatus({
        request: new Request("http://127.0.0.1:3000/api/verification", {
          headers: row.headers,
        }),
        session,
        store: new MemoryStore(),
        now,
      });

      expect((await response.json()).method).toBe(row.method);
    });
  });

  it("reports whether a verification is still valid", async () => {
    process.env.BETTER_AUTH_URL = "https://hub.example";
    const store = new MemoryStore();

    const missing = await handleVerificationStatus({
      request: new Request("https://hub.example/api/verification"),
      session,
      store,
      now,
    });
    expect(await missing.json()).toMatchObject({
      method: "passkey",
      recent: false,
      reason: "missing",
      verifiedAt: null,
      expiresAt: null,
    });

    await recordRecentVerification(store, session, "passkey", now);
    const fresh = await handleVerificationStatus({
      request: new Request("https://hub.example/api/verification"),
      session,
      store,
      now,
    });
    expect(await fresh.json()).toMatchObject({
      method: "passkey",
      recent: true,
      reason: null,
      verifiedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + RECENT_VERIFICATION_TTL_MS,
      ).toISOString(),
    });
  });

  it("records a verified passkey only after the auth service completes it", async () => {
    const store = new MemoryStore();

    const ignored = await rememberPasskeyVerification(
      {
        path: "/sign-in/email",
        context: {
          newSession: { session: { id: "session-1" }, user: { id: "user-1" } },
        },
      },
      store,
      now,
    );
    expect(ignored).toBe(false);
    expect(store.records.size).toBe(0);

    const recorded = await rememberPasskeyVerification(
      {
        path: "/passkey/verify-authentication",
        context: {
          newSession: { session: { id: "session-1" }, user: { id: "user-1" } },
        },
      },
      store,
      now,
    );
    expect(recorded).toBe(true);
    expect(store.records.get("session-1")).toMatchObject({
      userId: "user-1",
      method: "passkey",
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + RECENT_VERIFICATION_TTL_MS),
    });
  });
});
