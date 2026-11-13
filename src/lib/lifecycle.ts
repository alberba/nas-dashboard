import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  CONNECTION_STALE_MS,
  resolveHost,
  type HostConfig,
} from "./hosts";
import { nasForHost, NasRejected } from "./nas";
import { alerts, operations, samples } from "./schema";
import { getSettings, saveSettings } from "./settings";
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

function response(operation: typeof operations.$inferSelect, result?: RemovalResult) {
  return json({
    ok: true,
    status: operation.status,
    operation,
    ...(result ? { result } : {}),
  });
}

async function forgetExpectedContainer(hostId: string, name: string) {
  const settings = await getSettings(hostId);
  if (settings.expectedContainers.includes(name)) {
    settings.expectedContainers = settings.expectedContainers.filter(
      (container) => container !== name,
    );
    await saveSettings(hostId, settings);
  }
  await db
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(alerts.hostId, hostId),
        eq(alerts.key, "container:" + name),
        isNull(alerts.resolvedAt),
      ),
    );
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
      target: input.confirmation,
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
    const [operation] = await db
      .update(operations)
      .set({ status: "success", detail })
      .where(eq(operations.id, operationId))
      .returning();
    await forgetExpectedContainer(host.id, input.confirmation).catch(() => {});
    return response(operation, result);
  } catch (error) {
    if (error instanceof NasRejected && error.status < 500) {
      const [operation] = await db
        .update(operations)
        .set({ status: "failed", detail: error.message })
        .where(eq(operations.id, operationId))
        .returning();
      return json(
        { error: error.message, status: "failed", operation },
        400,
      );
    }
    // The agent may have removed the container before the response was lost.
    const [operation] = await db
      .update(operations)
      .set({ detail: pendingDetail })
      .where(eq(operations.id, operationId))
      .returning();
    return json(
      {
        error:
          "Resultado pendiente de verificar. No se ha repetido la eliminación.",
        status: "pending",
        operation,
      },
      502,
    );
  }
}
