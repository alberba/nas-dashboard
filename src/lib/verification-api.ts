import { z } from "zod";
import { BodyTooLarge, readJsonBody } from "./request-body";
import {
  requiresVerificationForIntent,
} from "./sensitive-actions";
import type { IntentActionId } from "./telegram-intents";
import {
  recordRecentVerification,
  requireRecentVerification,
  verificationMethodForRequest,
  verificationState,
  type VerificationSession,
  type VerificationStore,
} from "./verification";

const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: noStore });

export type VerifyPassword = (input: {
  body: { password: string };
  headers: Headers;
}) => Promise<unknown>;

export async function handleVerificationStatus({
  request,
  session,
  store,
  now = new Date(),
}: {
  request: Request;
  session: VerificationSession;
  store: VerificationStore;
  now?: Date;
}) {
  const method = verificationMethodForRequest(request);
  return json(
    verificationState(await store.find(session.session.id), method, now),
  );
}

export async function handlePasswordVerification({
  request,
  session,
  store,
  now = new Date(),
  verifyPassword,
}: {
  request: Request;
  session: VerificationSession;
  store: VerificationStore;
  now?: Date;
  verifyPassword: VerifyPassword;
}) {
  const method = verificationMethodForRequest(request);
  if (method !== "password")
    return json(
      {
        code: "password_not_allowed",
        method,
        error: "Este dominio utiliza passkeys para confirmar la identidad.",
      },
      403,
    );

  let password: string;
  try {
    ({ password } = z
      .object({ password: z.string().min(1).max(128) })
      .parse(await readJsonBody(request)));
  } catch (error) {
    // An oversized body is not "invalid data": the catch-all answers 413.
    if (error instanceof BodyTooLarge) throw error;
    return json({ error: "Datos no válidos" }, 400);
  }

  try {
    await verifyPassword({ body: { password }, headers: request.headers });
  } catch {
    return json(
      {
        code: "invalid_password",
        method,
        error: "La contraseña no es correcta.",
      },
      403,
    );
  }

  return json(await recordRecentVerification(store, session, "password", now));
}

/**
 * The only source of truth is the server-side record created after Better Auth
 * verified a passkey or after the password route verified the current session.
 * Headers or body fields sent by the client are never consulted.
 */
export async function guardSensitiveAction({
  request,
  session,
  store,
  now = new Date(),
}: {
  request: Request;
  session: VerificationSession;
  store: VerificationStore;
  now?: Date;
}) {
  const method = verificationMethodForRequest(request);
  const failure = await requireRecentVerification(
    store,
    session,
    method,
    now,
  );
  return failure ? json(failure, 403) : null;
}

/**
 * Guard of the Telegram handoff. The decision comes from the action stored in
 * the intent and from the phase 6 manifest, never from the request body, and a
 * protected action is then judged by the same recent-verification rule as any
 * other (`guardSensitiveAction`). A session that is not the intent's owner gets
 * the same 404 as an unknown token, so intents cannot be enumerated.
 */
export async function guardIntentAction({
  request,
  session,
  store,
  intent,
  now = new Date(),
}: {
  request: Request;
  session: VerificationSession;
  store: VerificationStore;
  intent: { userId: string; action: IntentActionId };
  now?: Date;
}) {
  if (session.user.id !== intent.userId)
    return json(
      { error: "El aviso no existe o ya no está disponible", code: "intent_unknown" },
      404,
    );
  if (!requiresVerificationForIntent(intent.action)) return null;
  return guardSensitiveAction({ request, session, store, now });
}
