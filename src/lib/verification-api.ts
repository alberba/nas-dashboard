import { z } from "zod";
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
      .parse(await request.json()));
  } catch {
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
