/**
 * Shared fixture for the API suites that hit a protected route: the session the
 * mocked `getSession` returns plus a seeded recent verification.
 *
 * `db` and `tables` are imported as types only: every suite sets `DATABASE_URL`
 * before importing `@/lib/db`, so the module must not resolve it at import time.
 */

type Database = typeof import("@/lib/db").db;
type Tables = typeof import("@/lib/schema");
type VerificationMethod = "passkey" | "password";

/** The value the mocked `getSession` returns; carries `session.id`. */
export const testSession = {
  user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
  session: { id: "test-session" },
};

export const TEST_USER_ID = "test-user";
export const TEST_SESSION_ID = "test-session";
export const VERIFICATION_TTL_MS = 300_000;

/**
 * Inserts the user and session the verification row references, then upserts a
 * recent verification for `test-session`. Safe to call once per test.
 */
export async function seedVerifiedSession(
  db: Database,
  tables: Tables,
  options: {
    method?: VerificationMethod;
    verifiedAt?: Date;
    ttlMs?: number;
  } = {},
) {
  const verifiedAt = options.verifiedAt ?? new Date();
  await db
    .insert(tables.user)
    .values({
      id: TEST_USER_ID,
      name: "Test",
      email: "test@hub.invalid",
    })
    .onConflictDoNothing();
  await db
    .insert(tables.session)
    .values({
      id: TEST_SESSION_ID,
      token: "test-session-token",
      expiresAt: new Date(Date.now() + 86_400_000),
      userId: TEST_USER_ID,
    })
    .onConflictDoNothing();
  const record = {
    sessionId: TEST_SESSION_ID,
    userId: TEST_USER_ID,
    method: options.method ?? "passkey",
    verifiedAt,
    expiresAt: new Date(
      verifiedAt.getTime() + (options.ttlMs ?? VERIFICATION_TTL_MS),
    ),
  };
  await db
    .insert(tables.recentVerification)
    .values(record)
    .onConflictDoUpdate({
      target: tables.recentVerification.sessionId,
      set: {
        userId: record.userId,
        method: record.method,
        verifiedAt: record.verifiedAt,
        expiresAt: record.expiresAt,
      },
    });
}

/** Removes the verification row, leaving the session authenticated. */
export async function clearVerification(db: Database, tables: Tables) {
  await db.delete(tables.recentVerification);
}
