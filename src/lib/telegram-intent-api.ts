import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  CONNECTION_STALE_MS,
  getHosts,
  HostNotFound,
  resolveHost,
  type HostConfig,
} from "./hosts";
import {
  executeHostCommand,
  hostCommandResponse,
  type HostCommandOutcome,
} from "./host-commands";
import { queueKeyboardEdit } from "./incident-store";
import { publicOperation } from "./lifecycle";
import { readJsonBody } from "./request-body";
import { loadLatestSample, runAgentAction } from "./operation-runner";
import { incidents, operations } from "./schema";
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
import type { Metrics } from "./types";
import { actionSchema } from "./validation";
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

/** What the hub sends to the agent for an action that is not a host command. */
type AgentIntent = Exclude<IntentActionId, HostCommandIntent>;

/**
 * The body for the agent, or null when a container no longer carries that name.
 * The id is read from the newest sample at execution time, never from the
 * notice, because a recreated container has a new id (P-17, T-07-16). A reboot
 * carries the confirmation `actionSchema` demands, supplied by the server: the
 * handoff already asked for a tap and the passkey (D-12).
 */
function agentBodyOf(
  action: AgentIntent,
  target: string,
  metrics: Metrics,
): z.infer<typeof actionSchema> | null {
  if (action === "reboot")
    return { action, confirmation: "REINICIAR NAS" };
  const container = metrics.containers.find((entry) => entry.name === target);
  if (!container) return null;
  const parsed = actionSchema.safeParse({ action, id: container.id });
  return parsed.success ? parsed.data : null;
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

  // Start and reboot are wired in the next step; until then the hub fails
  // closed and leaves the intent untouched.
  if (!isHostCommandIntent(action) && action !== "restart")
    return json(
      {
        error: "Esta acción todavía no se puede confirmar desde el hub",
        code: "action_unavailable",
      },
      501,
    );

  const host = resolveHost(getHosts(), intent.hostId);
  const latest = await loadLatestSample(host.id);
  if (!latest || clock() - latest.at.getTime() > CONNECTION_STALE_MS)
    return json(
      { error: `${host.name} no está conectado. No se ha enviado el comando.` },
      503,
    );
  let run: () => Promise<Closing>;
  if (isHostCommandIntent(action)) {
    run = () => runHostCommandIntent(intent, host, action);
  } else {
    const body = agentBodyOf(action, intent.target, latest.data as Metrics);
    if (!body)
      return json(
        {
          error: "El contenedor ya no existe con ese nombre",
          code: "container_gone",
        },
        409,
      );
    run = () => runAgentIntent(intent, host, body);
  }

  const claimed = await claimIntent(db, intent.id, clock());
  if (!claimed) {
    // Another execute won the race, or the intent lapsed in between.
    const fresh = await loadIntent(token, session.user.id, clock());
    if (!fresh) return unknownIntent();
    return settledResponse(
      stateOf(fresh) === "ready" ? { ...fresh, status: "expired" } : fresh,
    );
  }

  const closing = await run();
  if (closing.intentStatus === "released") {
    // Nothing reached the agent: the same link works again until it lapses.
    await releaseIntent(db, intent.id);
    return closing.response;
  }
  const status = closing.intentStatus;
  await db.transaction(async (tx) => {
    await finishIntent(tx, intent.id, status, clock());
    await queueKeyboardEdit(tx, intent.incidentId, `i${intent.id}:done`);
  });
  return closing.response;
}

/** How a run ended for the intent, and the answer the caller gets. */
type Closing = {
  intentStatus: "executed" | "failed" | "uncertain" | "released";
  response: Response;
};

async function runHostCommandIntent(
  intent: LoadedIntent,
  host: HostConfig,
  command: HostCommandIntent,
): Promise<Closing> {
  const outcome = await executeHostCommand({
    host,
    userId: intent.userId,
    command,
    operationId: intent.id,
    channel: "telegram",
    requestedBy: intent.userId,
  });
  return {
    intentStatus:
      outcome.status === "unavailable" ? "released" : intentStatusOf(outcome),
    response: hostCommandResponse(outcome),
  };
}

/**
 * Runs start, restart or reboot through the same runner `/api/action` uses. A
 * reboot the agent accepted closes the intent as executed and leaves the
 * operation pending until the collector sees the host boot again (P-18).
 */
async function runAgentIntent(
  intent: LoadedIntent,
  host: HostConfig,
  body: NonNullable<ReturnType<typeof agentBodyOf>>,
): Promise<Closing> {
  const outcome = await runAgentAction({
    host,
    userId: intent.userId,
    body,
    operationId: intent.id,
    channel: "telegram",
    requestedBy: intent.userId,
  });
  if (outcome.status === "unavailable")
    return {
      intentStatus: "released",
      response: json({ error: outcome.error }, 503),
    };
  const operation = await operationOf(intent);
  const shown = operation ? publicOperation(operation) : undefined;
  switch (outcome.status) {
    case "success":
    case "requested":
      return {
        intentStatus: "executed",
        response: json({
          ok: true,
          status: outcome.status === "success" ? "success" : "pending",
          operation: shown,
          result: outcome.result,
        }),
      };
    case "failed":
      return {
        intentStatus: "failed",
        response: json(
          { error: outcome.error, status: "failed", operation: shown },
          400,
        ),
      };
    case "uncertain":
      return {
        intentStatus: "uncertain",
        response: json(
          {
            error:
              "Resultado pendiente de verificar. No se ha repetido la acción.",
            status: "pending",
            operation: shown,
          },
          502,
        ),
      };
    case "duplicate":
      // The id already ran: close the claim by what the stored row says.
      return {
        intentStatus:
          operation?.status === "success"
            ? "executed"
            : operation?.status === "failed"
              ? "failed"
              : "uncertain",
        response: json(
          shown
            ? { ok: true, status: shown.status, operation: shown }
            : { ok: true, status: "pending" },
        ),
      };
  }
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
