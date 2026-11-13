import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  hostCommandRequestSchema,
  hostCommandResultSchema,
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

const resultSchema = hostCommandResultSchema;

function formatBytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} kB`;
  return `${value} B`;
}

function completedDetail(result: HostCommandResult) {
  switch (result.command) {
    case "deploy-now":
      return "Despliegue lanzado; el seguidor continúa en segundo plano.";
    case "pause-follower":
      return "Seguidor pausado.";
    case "resume-follower":
      return "Seguidor reanudado.";
    case "run-security":
      return "Actualizador de seguridad lanzado.";
    case "backup-now":
      return result.backup.lastStatus.status === "unknown"
        ? "Copia iniciada. Todavía no hay un estado de la última copia."
        : `Copia iniciada. Última copia: ${result.backup.lastStatus.status}.`;
    case "clean-images":
      return `Limpieza completada: ${formatBytes(result.cleanup.reclaimedBytes)} recuperados.`;
    case "check-health":
      return result.health.healthy
        ? "Comprobación completada: todo sano."
        : "Comprobación completada: hay servicios que requieren atención.";
    case "reconnect-apps":
      return "Wiring lanzada.";
  }
}

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

export type HostCommandOutcome = {
  status: "success" | "failed" | "pending" | "unavailable" | "conflict";
  operation: typeof operations.$inferSelect | null;
  result?: HostCommandResult;
  error?: string;
  replayed?: boolean;
};

function storedStatus(value: string): "success" | "failed" | "pending" {
  return value === "success" || value === "failed" ? value : "pending";
}

/**
 * Runs exactly one host command and records it in `operations`. It is shared
 * by the direct host-command route and by "deploy now" after a merge. A lost
 * response stays pending and is never sent again: callers only catch the
 * outcome and report it.
 */
export async function executeHostCommand({
  host,
  userId,
  command,
  operationId,
}: {
  host: HostConfig;
  userId: string;
  command: HostCommand;
  operationId: string;
}): Promise<HostCommandOutcome> {
  const [existing] = await db
    .select()
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1);
  if (existing) {
    if (existing.hostId !== host.id)
      return {
        status: "conflict",
        operation: null,
        error: "La clave de idempotencia ya se usó en otro host",
      };
    return {
      status: storedStatus(existing.status),
      operation: existing,
      replayed: true,
    };
  }

  const [latest] = await db
    .select()
    .from(samples)
    .where(eq(samples.hostId, host.id))
    .orderBy(desc(samples.at))
    .limit(1);
  if (!latest || Date.now() - latest.at.getTime() > CONNECTION_STALE_MS)
    return {
      status: "unavailable",
      operation: null,
      error: `${host.name} no está conectado. No se ha enviado el comando.`,
    };

  const inserted = await db
    .insert(operations)
    .values({
      id: operationId,
      hostId: host.id,
      userId,
      action: command,
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
      return {
        status: "conflict",
        operation: null,
        error: "La clave de idempotencia ya se usó en otro host",
      };
    return current
      ? {
          status: storedStatus(current.status),
          operation: current,
          replayed: true,
        }
      : {
          status: "unavailable",
          operation: null,
          error: "No se pudo registrar la operación",
        };
  }

  try {
    const raw = await nasForHost<unknown>(host, "/command", { command });
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Respuesta del agente no válida");
    const [operation] = await db
      .update(operations)
      .set({ status: "success", detail: completedDetail(parsed.data) })
      .where(eq(operations.id, operationId))
      .returning();
    return { status: "success", operation, result: parsed.data };
  } catch (error) {
    if (error instanceof NasRejected && error.status < 500) {
      const [operation] = await db
        .update(operations)
        .set({ status: "failed", detail: error.message })
        .where(eq(operations.id, operationId))
        .returning();
      return { status: "failed", operation, error: error.message };
    }
    // The command may have reached the host before its response was lost.
    const [operation] = await db
      .update(operations)
      .set({ detail: pendingDetail })
      .where(eq(operations.id, operationId))
      .returning();
    return {
      status: "pending",
      operation,
      error:
        "Resultado pendiente de verificar. No se ha repetido el comando.",
    };
  }
}

/**
 * Runs one named host command from the HTTP route. The body only carries the
 * command name; the agent owns the unit names and the fixed argv. Idempotency
 * is per host and a lost response stays pending, never retried automatically.
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
  const outcome = await executeHostCommand({
    host,
    userId: session.user.id,
    command: input.command,
    operationId,
  });
  if (outcome.replayed && outcome.operation) return response(outcome.operation);
  switch (outcome.status) {
    case "success":
      return response(outcome.operation!, outcome.result);
    case "failed":
      return json(
        { error: outcome.error, status: "failed", operation: outcome.operation },
        400,
      );
    case "pending":
      return json(
        {
          error: outcome.error,
          status: "pending",
          operation: outcome.operation,
        },
        502,
      );
    case "conflict":
      return json({ error: outcome.error }, 409);
    default:
      return json({ error: outcome.error }, 503);
  }
}
