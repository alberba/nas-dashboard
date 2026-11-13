import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  hostCommandIds,
  hostCommandRequestSchema,
  type HostCommand,
  type HostCommandResult,
} from "./host-command-contract";
import {
  CONNECTION_STALE_MS,
  resolveHost,
  type HostConfig,
} from "./hosts";
import { nasForHost, NasRejected } from "./nas";
import { operations, samples } from "./schema";

export {
  hostCommandIds,
  hostCommandRequestSchema,
  type HostCommand,
  type HostCommandResult,
} from "./host-command-contract";

const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: noStore });

const resultSchema = z.object({
  command: z.enum(hostCommandIds),
  status: z.literal("success"),
});

const completedDetail: Record<HostCommand, string> = {
  "deploy-now": "Despliegue lanzado; el seguidor continúa en segundo plano.",
  "pause-follower": "Seguidor pausado.",
  "resume-follower": "Seguidor reanudado.",
  "run-security": "Actualizador de seguridad lanzado.",
};

const pendingDetail =
  "No se pudo confirmar el resultado. Comprueba el estado del host antes de repetir la operación.";

function response(
  operation: typeof operations.$inferSelect,
  result?: HostCommandResult,
) {
  return json({
    ok: true,
    status: operation.status,
    operation,
    ...(result ? { result } : {}),
  });
}

/**
 * Runs one named host command. The body only carries the command name; the
 * agent owns the unit names and the fixed argv. Idempotency is per host and a
 * lost response stays pending, never retried automatically.
 */
export async function runHostCommand({
  request,
  session,
  hosts,
}: {
  request: Request & { nextUrl?: URL };
  session: { user: { id: string } };
  hosts: HostConfig[];
}) {
  const input = hostCommandRequestSchema.parse(await request.json());
  const host = resolveHost(hosts, request.nextUrl?.searchParams.get("host"));
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

  const [latest] = await db
    .select()
    .from(samples)
    .where(eq(samples.hostId, host.id))
    .orderBy(desc(samples.at))
    .limit(1);
  if (!latest || Date.now() - latest.at.getTime() > CONNECTION_STALE_MS)
    return json(
      {
        error: `${host.name} no está conectado. No se ha enviado el comando.`,
      },
      503,
    );

  const inserted = await db
    .insert(operations)
    .values({
      id: operationId,
      hostId: host.id,
      userId: session.user.id,
      action: input.command,
      target: host.name,
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
    const raw = await nasForHost<unknown>(host, "/command", {
      command: input.command,
    });
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Respuesta del agente no válida");
    const [operation] = await db
      .update(operations)
      .set({ status: "success", detail: completedDetail[input.command] })
      .where(eq(operations.id, operationId))
      .returning();
    return response(operation, parsed.data);
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
    // The command may have reached the host before its response was lost.
    const [operation] = await db
      .update(operations)
      .set({ detail: pendingDetail })
      .where(eq(operations.id, operationId))
      .returning();
    return json(
      {
        error:
          "Resultado pendiente de verificar. No se ha repetido el comando.",
        status: "pending",
        operation,
      },
      502,
    );
  }
}
