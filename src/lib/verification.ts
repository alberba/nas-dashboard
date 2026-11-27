import { eq } from "drizzle-orm";
import { db } from "./db";
import { recentVerification } from "./schema";

export const RECENT_VERIFICATION_TTL_MS = 5 * 60_000;

export type VerificationMethod = "passkey" | "password";

export type VerificationSession = {
  user: { id: string };
  session: { id: string };
};

export type VerificationRecord = {
  sessionId: string;
  userId: string;
  method: VerificationMethod;
  verifiedAt: Date;
  expiresAt: Date;
};

export type VerificationFailure = {
  code: "recent_verification_required";
  reason: "missing" | "expired";
  method: VerificationMethod;
  error: string;
  verifiedAt: string | null;
  expiresAt: string | null;
};

export type VerificationState = {
  method: VerificationMethod;
  recent: boolean;
  reason: "missing" | "expired" | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  ttlSeconds: number;
};

export interface VerificationStore {
  find(sessionId: string): Promise<VerificationRecord | null>;
  save(record: VerificationRecord): Promise<void>;
}

export const verificationStore: VerificationStore = {
  async find(sessionId) {
    const [row] = await db
      .select()
      .from(recentVerification)
      .where(eq(recentVerification.sessionId, sessionId))
      .limit(1);
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      userId: row.userId,
      method: row.method as VerificationMethod,
      verifiedAt: row.verifiedAt,
      expiresAt: row.expiresAt,
    };
  },
  async save(record) {
    await db
      .insert(recentVerification)
      .values(record)
      .onConflictDoUpdate({
        target: recentVerification.sessionId,
        set: {
          userId: record.userId,
          method: record.method,
          verifiedAt: record.verifiedAt,
          expiresAt: record.expiresAt,
        },
      });
  },
};

export function primaryOrigin() {
  return (
    process.env.BETTER_AUTH_URL ??
    process.env.TRUSTED_ORIGINS?.split(",")[0]?.trim() ??
    null
  );
}

const HOST_HEADER = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i;

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// The name the proxy routed this connection to. The proxy rewrites Host when it
// forwards, so the client cannot choose it. A request built in-process carries
// no Host header and falls back to its URL. A list, an empty value or anything
// that is not name[:port] has no connection host.
function connectionHostname(request: Request) {
  const header = request.headers.get("host");
  if (header === null) return hostnameOf(request.url);
  return HOST_HEADER.exec(header.trim())?.[1].toLowerCase() ?? null;
}

/**
 * The method follows the Host the proxy sets, never the Origin the client
 * picks, and never a forwarded-host or forwarded-protocol header. An Origin
 * that disagrees with the connection host, or cannot be read, falls back to
 * the passkey, as does anything ambiguous.
 */
export function verificationMethodForRequest(
  request: Request,
): VerificationMethod {
  const connectionHost = connectionHostname(request);
  const primary = primaryOrigin();
  const primaryHost = primary ? hostnameOf(primary) : null;
  if (!connectionHost || !primaryHost) return "passkey";

  const origin = request.headers.get("origin");
  if (origin !== null && hostnameOf(origin) !== connectionHost)
    return "passkey";

  return connectionHost === primaryHost ? "passkey" : "password";
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

export function verificationState(
  record: VerificationRecord | null,
  method: VerificationMethod,
  now: Date,
): VerificationState {
  const base = {
    method,
    ttlSeconds: RECENT_VERIFICATION_TTL_MS / 1000,
  };
  if (!record || record.method !== method)
    return {
      ...base,
      recent: false,
      reason: "missing",
      verifiedAt: null,
      expiresAt: null,
    };
  if (now.getTime() >= record.expiresAt.getTime())
    return {
      ...base,
      recent: false,
      reason: "expired",
      verifiedAt: iso(record.verifiedAt),
      expiresAt: iso(record.expiresAt),
    };
  return {
    ...base,
    recent: true,
    reason: null,
    verifiedAt: iso(record.verifiedAt),
    expiresAt: iso(record.expiresAt),
  };
}

export async function requireRecentVerification(
  store: VerificationStore,
  session: VerificationSession,
  method: VerificationMethod,
  now = new Date(),
): Promise<VerificationFailure | null> {
  const record = await store.find(session.session.id);
  if (!record || record.userId !== session.user.id || record.method !== method)
    return {
      code: "recent_verification_required",
      reason: "missing",
      method,
      error: "Necesitas verificar tu identidad para continuar.",
      verifiedAt: null,
      expiresAt: null,
    };
  if (now.getTime() >= record.expiresAt.getTime())
    return {
      code: "recent_verification_required",
      reason: "expired",
      method,
      error: "La verificación ha caducado. Vuelve a confirmar tu identidad.",
      verifiedAt: iso(record.verifiedAt),
      expiresAt: iso(record.expiresAt),
    };
  return null;
}

export async function recordRecentVerification(
  store: VerificationStore,
  session: VerificationSession,
  method: VerificationMethod,
  now = new Date(),
) {
  const record: VerificationRecord = {
    sessionId: session.session.id,
    userId: session.user.id,
    method,
    verifiedAt: now,
    expiresAt: new Date(now.getTime() + RECENT_VERIFICATION_TTL_MS),
  };
  await store.save(record);
  return verificationState(record, method, now);
}

export type PasskeyAuthContext = {
  path: string;
  context: {
    newSession:
      | {
          session: { id: string };
          user: { id: string };
        }
      | null;
  };
};

/**
 * Better Auth calls this after it has cryptographically verified a passkey
 * assertion and created the session. The client cannot supply this record.
 */
export async function rememberPasskeyVerification(
  ctx: PasskeyAuthContext,
  store: VerificationStore = verificationStore,
  now = new Date(),
) {
  if (ctx.path !== "/passkey/verify-authentication") return false;
  const created = ctx.context.newSession;
  if (!created?.session?.id || !created.user?.id) return false;
  await recordRecentVerification(
    store,
    {
      session: { id: created.session.id },
      user: { id: created.user.id },
    },
    "passkey",
    now,
  );
  return true;
}
