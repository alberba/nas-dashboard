import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  CONNECTION_STALE_MS,
  getHosts,
  HostNotFound,
  resolveHost,
} from "./hosts";
import {
  executeHostCommand,
  hostCommandResponse,
  type HostCommandOutcome,
} from "./host-commands";
import { queueKeyboardEdit } from "./incident-store";
import { publicOperation } from "./lifecycle";
import { readJsonBody } from "./request-body";
import { incidents, operations, samples } from "./schema";
import { requiresVerificationForIntent } from "./sensitive-actions";
import {
  claimIntent,
  expireDueIntents,
  findIntentByToken,
  finishIntent,
  INTENT_VERBS,
  intentActionIds,
  releaseIntent,
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

type LoadedIntent = NonNullable<Awaited<ReturnType<typeof findIntentByToken>>> & {
  action: IntentActionId;
};

/**
 * Resolves the token to an intent of the session's own user. An unknown token,
 * another user's intent and a stored action outside the closed set are the same
 * answer (null), so nothing reveals which intents exist. A pending intent whose
 * time is up is marked expired here, lazily, because the partial unique index
 * cannot see the clock.
 */
async function loadIntent(
  token: string,
  userId: string,
  now: number,
): Promise<LoadedIntent | null> {
  let found = await findIntentByToken(db, token);
  if (!found || found.userId !== userId || !isIntentAction(found.action))
    return null;
  if (found.status === "pending" && found.expiresAt.getTime() <= now) {
    await expireDueIntents(db, found.incidentId, now);
    found = (await findIntentByToken(db, token)) ?? found;
  }
  return found as LoadedIntent;
}

type IntentState = "ready" | "expired" | "cancelled" | "consumed";

function stateOf(intent: LoadedIntent): IntentState {
  if (intent.status === "pending") return "ready";
  if (intent.status === "expired" || intent.status === "cancelled")
    return intent.status;
  return "consumed";
}

async function operationOf(intent: LoadedIntent) {
  const [operation] = await db
    .select()
    .from(operations)
    .where(eq(operations.id, intent.id))
    .limit(1);
  return operation ?? null;
}

/** The answer for an intent that is no longer ready: 410 or the replay. */
async function settledResponse(intent: LoadedIntent) {
  const state = stateOf(intent);
  if (state === "cancelled")
    return json(
      { error: "El aviso se canceló", code: "intent_cancelled" },
      410,
    );
  if (state !== "consumed")
    return json({ error: "El aviso ha caducado", code: "intent_expired" }, 410);
  const operation = await operationOf(intent);
  return json(
    operation
      ? {
          ok: true,
          status: operation.status,
          operation: publicOperation(operation),
        }
      : { ok: true, status: "pending" },
  );
}

/**
 * Completes in the hub the action started from the chat, once (BOT-07). The
 * action comes from the stored intent, never from the body, and a protected one
 * needs a recent verification before anything is claimed or sent (BOT-08).
 *
 * Order: body, lookup by digest (uniform 404), state (410 or replay), guard
 * (403 without consuming), 501 for an action the hub cannot run yet, host and
 * recent sample (503 without consuming), atomic claim, execution with the
 * intent id as the operation id, and closure plus the `:done` edit in one
 * transaction.
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
  const intent = await loadIntent(token, session.user.id, clock());
  if (!intent) return unknownIntent();
  if (stateOf(intent) !== "ready") return settledResponse(intent);
  const action = intent.action;

  const denied = await guardIntentAction({
    request,
    session,
    store,
    intent: { userId: intent.userId, action },
    now: new Date(clock()),
  });
  if (denied) return denied;

  // Start, restart and reboot run through the shared runner (07-04); until it
  // exists the hub fails closed and leaves the intent untouched.
  if (!isHostCommandIntent(action))
    return json(
      {
        error: "Esta acción todavía no se puede confirmar desde el hub",
        code: "action_unavailable",
      },
      501,
    );

  const host = resolveHost(getHosts(), intent.hostId);
  const [latest] = await db
    .select({ at: samples.at })
    .from(samples)
    .where(eq(samples.hostId, host.id))
    .orderBy(desc(samples.at))
    .limit(1);
  if (!latest || clock() - latest.at.getTime() > CONNECTION_STALE_MS)
    return json(
      { error: `${host.name} no está conectado. No se ha enviado el comando.` },
      503,
    );

  const claimed = await claimIntent(db, intent.id, clock());
  if (!claimed) {
    // Another execute won the race, or the intent lapsed in between.
    const fresh = await loadIntent(token, session.user.id, clock());
    if (!fresh) return unknownIntent();
    return settledResponse(
      stateOf(fresh) === "ready" ? { ...fresh, status: "expired" } : fresh,
    );
  }

  const outcome = await executeHostCommand({
    host,
    userId: intent.userId,
    command: action,
    operationId: intent.id,
    channel: "telegram",
    requestedBy: intent.userId,
  });
  if (outcome.status === "unavailable") {
    // Nothing reached the agent: the same link works again until it lapses.
    await releaseIntent(db, intent.id);
    return hostCommandResponse(outcome);
  }
  await db.transaction(async (tx) => {
    await finishIntent(tx, intent.id, intentStatusOf(outcome), clock());
    await queueKeyboardEdit(tx, intent.incidentId, `i${intent.id}:done`);
  });
  return hostCommandResponse(outcome);
}

async function hostNameOf(hostId: string) {
  try {
    return resolveHost(getHosts(), hostId).name;
  } catch (error) {
    if (error instanceof HostNotFound) return hostId;
    throw error;
  }
}

/**
 * What the hub shows before it asks for the passkey: the verb, the target, the
 * state of the intent and whether the incident is already resolved (D-05). It
 * writes nothing but the lazy expiry and never consumes the intent.
 */
export async function handleIntentInspect({
  request,
  session,
  now,
}: {
  request: Request;
  session: VerificationSession;
  now?: number;
}) {
  const { token } = tokenBody.parse(await readJsonBody(request));
  const intent = await loadIntent(token, session.user.id, now ?? Date.now());
  if (!intent) return unknownIntent();
  const [incident] = await db
    .select({ resolvedAt: incidents.resolvedAt })
    .from(incidents)
    .where(eq(incidents.id, intent.incidentId))
    .limit(1);
  const state = stateOf(intent);
  const operation = state === "consumed" ? await operationOf(intent) : null;
  return json({
    state,
    action: intent.action,
    verb: INTENT_VERBS[intent.action],
    target: intent.target,
    host: { id: intent.hostId, name: await hostNameOf(intent.hostId) },
    incident: { id: intent.incidentId, resolved: incident?.resolvedAt != null },
    requiresVerification: requiresVerificationForIntent(intent.action),
    expiresAt: intent.expiresAt.toISOString(),
    ...(operation ? { operation: publicOperation(operation) } : {}),
  });
}
