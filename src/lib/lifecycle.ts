import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  CONNECTION_STALE_MS,
  resolveHost,
  type HostConfig,
} from "./hosts";
import { recordIncidentObservationIn } from "./incident-store";
import { nasForHost, NasRejected } from "./nas";
import { operations, samples } from "./schema";
import { mutateSettings } from "./settings";
import { identityOf, watchOf } from "./container-watch";
import type { Container, ContainerIdentity } from "./types";
import { guardSensitiveAction } from "./verification-api";
import {
  verificationStore,
  type VerificationSession,
  type VerificationStore,
} from "./verification";

const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: noStore });

const dockerName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

/** The operator types the container name, never a "remove volumes" option. */
export const removalRequestSchema = z.strictObject({
  host: z.string().min(1).max(40).optional(),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z
    .string()
    .min(1)
    .max(255)
    .regex(dockerName, "El nombre del contenedor no es válido"),
});

export type RemovalResult = {
  state: string;
  name: string;
  composeProject: string | null;
  composeService: string | null;
  recreateOnCompose: boolean;
  volumesRemoved: false;
};

const pendingDetail =
  "No se pudo confirmar el resultado. Comprueba el estado del contenedor antes de repetir la operación.";

// Docker names cannot contain a colon, so older name-only rows still parse.
export function removalTarget(target: string) {
  const [name, id] = target.split(":");
  return { name, id };
}

export function publicOperation(operation: typeof operations.$inferSelect) {
  return operation.action === "remove-container"
    ? { ...operation, target: removalTarget(operation.target).name }
    : operation;
}

function response(operation: typeof operations.$inferSelect, result?: RemovalResult) {
  return json({
    ok: true,
    status: operation.status,
    operation: publicOperation(operation),
    ...(result ? { result } : {}),
  });
}

export type ContainerOperationAction =
  | "start"
  | "restart"
  | "stop"
  | "remove-container";

/**
 * Shared idempotent close-out of a confirmed container operation. The row
 * lock, the operation result, the watching intention and the episode closure
 * commit in one transaction, so the collector and the API can never apply the
 * same operation twice or leave one half behind. A repeated confirmation
 * returns without touching the result or the history.
 */
export async function finalizeContainerOperation(input: {
  hostId: string;
  hostName: string;
  operationId: string;
  action: ContainerOperationAction;
  name: string;
  containerId?: string | null;
  container?: Container | null;
  identity?: ContainerIdentity | null;
  detail: string;
  now?: number;
}): Promise<{
  applied: boolean;
  operation?: typeof operations.$inferSelect;
}> {
  const at = new Date(input.now ?? Date.now());
  let applied = false;
  let operation: typeof operations.$inferSelect | undefined;
  await mutateSettings(input.hostId, async (current, tx) => {
    const [locked] = await tx
      .select()
      .from(operations)
      .where(eq(operations.id, input.operationId))
      .for("update");
    operation = locked;
    if (!locked || locked.hostId !== input.hostId) return current;
    if (locked.status !== "pending" || locked.action !== input.action) return current;
    const [updated] = await tx
      .update(operations)
      .set({ status: "success", detail: input.detail })
      .where(eq(operations.id, input.operationId))
      .returning();
    operation = updated;
    applied = true;
    const watch = watchOf(current);
    const expected = [...current.expectedContainers];
    const identity =
      input.identity ?? (input.container ? identityOf(input.container) : null);
    // The confirmed ID wins over the name of the sample that started the
    // action: a rename between the request and its confirmation must move the
    // watched entry, not create a second one.
    const watchedName = input.containerId
      ? Object.entries(watch.identities).find(
          ([, identity]) => identity.containerId === input.containerId,
        )?.[0]
      : undefined;
    const name =
      watchedName && expected.includes(watchedName) ? watchedName : input.name;
    if (input.action === "start" || input.action === "restart") {
      if (!expected.includes(name)) expected.push(name);
      delete watch.entries[name];
      if (identity) watch.identities[name] = identity;
    } else {
      const index = expected.indexOf(name);
      if (index >= 0) expected.splice(index, 1);
      delete watch.entries[name];
      delete watch.identities[name];
      // Only the selected host and key are touched; the episode closure keeps
      // its phase 2 transition, delivery result and outbox.
      await recordIncidentObservationIn(tx, {
        hostId: input.hostId,
        key: "container:" + name,
        failing: false,
        now: at.getTime(),
        closedBy: "lifecycle",
      });
    }
    watch.revision += 1;
    return { ...current, expectedContainers: expected, watch };
  });
  return { applied, operation };
}

/** Records a rejection or uncertainty without replacing a terminal result. */
export async function updatePendingOperation(
  id: string,
  values: { status?: "failed"; detail: string },
) {
  const [updated] = await db
    .update(operations)
    .set(values)
    .where(and(eq(operations.id, id), eq(operations.status, "pending")))
    .returning();
  if (updated) return { updated: true, operation: updated };
  const [operation] = await db.select().from(operations).where(eq(operations.id, id));
  return { updated: false, operation };
}

/**
 * Removes one stopped container. The agent is the authority on state,
 * protection and the exact name; the hub adds recent verification, origin,
 * per-host idempotency and the operations record. A lost response stays
 * pending and is never retried automatically.
 */
export async function removeContainer({
  request,
  session,
  hosts,
  store = verificationStore,
  now = new Date(),
}: {
  request: Request & { nextUrl?: URL };
  session: VerificationSession;
  hosts: HostConfig[];
  store?: VerificationStore;
  now?: Date;
}) {
  const input = removalRequestSchema.parse(await request.json());
  const host = resolveHost(
    hosts,
    request.nextUrl?.searchParams.get("host") ?? input.host,
  );
  const operationId = z.uuid().parse(request.headers.get("idempotency-key"));
  const [existing] = await db
    .select()
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1);
  if (existing) {
    if (existing.hostId !== host.id)
      return json(
        { error: "La clave de idempotencia ya se usó en otro host" },
        409,
      );
    return response(existing);
  }

  const denied = await guardSensitiveAction({ request, session, store, now });
  if (denied) return denied;

  const [latest] = await db
    .select()
    .from(samples)
    .where(eq(samples.hostId, host.id))
    .orderBy(desc(samples.at))
    .limit(1);
  if (!latest || Date.now() - latest.at.getTime() > CONNECTION_STALE_MS)
    return json(
      {
        error: `${host.name} no está conectado. No se ha eliminado nada.`,
      },
      503,
    );

  const inserted = await db
    .insert(operations)
    .values({
      id: operationId,
      hostId: host.id,
      userId: session.user.id,
      action: "remove-container",
      target: `${input.confirmation}:${input.id}`,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const [current] = await db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1);
    if (current && current.hostId !== host.id)
      return json(
        { error: "La clave de idempotencia ya se usó en otro host" },
        409,
      );
    return current
      ? response(current)
      : json({ error: "No se pudo registrar la operación" }, 503);
  }

  try {
    const result = await nasForHost<RemovalResult>(host, "/action", {
      action: "remove-container",
      id: input.id,
      confirmation: input.confirmation,
    });
    const detail = result.recreateOnCompose
      ? "Contenedor eliminado sin volúmenes. El proyecto Compose lo recreará al levantar sus servicios."
      : "Contenedor eliminado sin volúmenes.";
    const finalized = await finalizeContainerOperation({
      hostId: host.id,
      hostName: host.name,
      operationId,
      action: "remove-container",
      name: input.confirmation,
      containerId: input.id,
      detail,
    });
    const [operation] = finalized.operation
      ? [finalized.operation]
      : await db
          .select()
          .from(operations)
          .where(eq(operations.id, operationId));
    return response(operation, result);
  } catch (error) {
    if (error instanceof NasRejected && error.status < 500) {
      const { updated, operation } = await updatePendingOperation(operationId, {
        status: "failed",
        detail: error.message,
      });
      if (!updated && operation) return response(operation);
      return json(
        { error: error.message, status: "failed", operation: publicOperation(operation) },
        400,
      );
    }
    // The agent may have removed the container before the response was lost.
    const { updated, operation } = await updatePendingOperation(operationId, {
      detail: pendingDetail,
    });
    if (!updated && operation) return response(operation);
    return json(
      {
        error:
          "Resultado pendiente de verificar. No se ha repetido la eliminación.",
        status: "pending",
        operation: publicOperation(operation),
      },
      502,
    );
  }
}
