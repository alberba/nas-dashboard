import { z } from "zod";
import { db } from "./db";
import { getHosts, resolveHost } from "./hosts";
import {
  executeHostCommand,
  hostCommandResponse,
  type HostCommandOutcome,
} from "./host-commands";
import { queueKeyboardEdit } from "./incident-store";
import { readJsonBody } from "./request-body";
import {
  claimIntent,
  findIntentByToken,
  finishIntent,
  intentActionIds,
  type IntentActionId,
} from "./telegram-intents";
import { guardIntentAction } from "./verification-api";
import {
  verificationStore,
  type VerificationSession,
  type VerificationStore,
} from "./verification";

const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: noStore });

/** The token travels in the body only, never in the URL (T-07-08). */
const tokenBody = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const unknownIntent = () =>
  json(
    {
      error: "El aviso no existe o ya no está disponible",
      code: "intent_unknown",
    },
    404,
  );

/** Actions the hub runs through `executeHostCommand`. */
type HostCommandIntent = Extract<IntentActionId, "backup-now" | "deploy-now">;

function isHostCommandIntent(action: string): action is HostCommandIntent {
  return action === "backup-now" || action === "deploy-now";
}

function isIntentAction(action: string): action is IntentActionId {
  return (intentActionIds as readonly string[]).includes(action);
}

/** `success` closes as executed, a rejection as failed, a lost reply as uncertain. */
function intentStatusOf(outcome: HostCommandOutcome) {
  if (outcome.status === "success") return "executed" as const;
  if (outcome.status === "pending") return "uncertain" as const;
  return "failed" as const;
}

/**
 * Completes in the hub the action started from the chat, once (BOT-07). The
 * action comes from the stored intent, never from the body, and a protected one
 * needs a recent verification before anything is claimed or sent (BOT-08).
 */
export async function handleIntentExecute({
  request,
  session,
  store = verificationStore,
  now,
}: {
  request: Request;
  session: VerificationSession;
  store?: VerificationStore;
  now?: number;
}) {
  const clock = () => now ?? Date.now();
  const { token } = tokenBody.parse(await readJsonBody(request));
  const intent = await findIntentByToken(db, token);
  if (
    !intent ||
    intent.userId !== session.user.id ||
    !isIntentAction(intent.action)
  )
    return unknownIntent();
  const action = intent.action;

  const denied = await guardIntentAction({
    request,
    session,
    store,
    intent: { userId: intent.userId, action },
    now: new Date(clock()),
  });
  if (denied) return denied;

  if (!isHostCommandIntent(action))
    return json(
      { error: "Esta acción todavía no se puede confirmar desde el hub", code: "action_unavailable" },
      501,
    );

  const host = resolveHost(getHosts(), intent.hostId);
  const claimed = await claimIntent(db, intent.id, clock());
  if (!claimed) return unknownIntent();

  const outcome = await executeHostCommand({
    host,
    userId: intent.userId,
    command: action,
    operationId: intent.id,
    channel: "telegram",
    requestedBy: intent.userId,
  });
  await db.transaction(async (tx) => {
    await finishIntent(tx, intent.id, intentStatusOf(outcome), clock());
    await queueKeyboardEdit(tx, intent.incidentId, `i${intent.id}:done`);
  });
  return hostCommandResponse(outcome);
}
