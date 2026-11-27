import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "./db";
import { CONNECTION_STALE_MS, type HostConfig } from "./hosts";
import type { OperationChannel } from "./host-commands";
import {
  finalizeContainerOperation,
  updatePendingOperation,
} from "./lifecycle";
import { CONTAINER_UPDATE_TIMEOUT_MS, nasForHost, NasRejected } from "./nas";
import { operations, samples } from "./schema";
import type { Metrics } from "./types";
import type { actionSchema } from "./validation";

export type AgentActionBody = z.infer<typeof actionSchema>;
type Operation = typeof operations.$inferSelect;

/** What happened, neutral of HTTP: each caller translates it to its own answer. */
export type AgentActionOutcome =
  | { status: "unavailable"; error: string }
  | { status: "duplicate" }
  | { status: "success"; result: { state?: string } }
  /** The host accepted a reboot; the collector confirms it by `bootAt`. */
  | { status: "requested"; result: { state?: string } }
  /** `settled` is the row when another writer had already closed it. */
  | { status: "failed"; error: string; settled?: Operation }
  | { status: "uncertain"; settled?: Operation };

/** The newest sample of a host, which proves the agent answers right now. */
export async function loadLatestSample(hostId: string) {
  const [latest] = await db
    .select()
    .from(samples)
    .where(eq(samples.hostId, hostId))
    .orderBy(desc(samples.at))
    .limit(1);
  return latest;
}

/**
 * Sends one action to the agent of a host and records it in `operations`. The
 * guard and the idempotent replay stay with the caller: they run before this,
 * so a refused request records nothing and sends nothing. A lost response
 * stays pending and is never sent again.
 */
export async function runAgentAction({
  host,
  userId,
  body,
  operationId,
  channel,
  requestedBy,
}: {
  host: HostConfig;
  userId: string;
  body: AgentActionBody;
  operationId: string;
  channel: OperationChannel;
  requestedBy: string;
}): Promise<AgentActionOutcome> {
  const latest = await loadLatestSample(host.id);
  if (!latest || Date.now() - latest.at.getTime() > CONNECTION_STALE_MS)
    return {
      status: "unavailable",
      error: `${host.name} no está conectado. No se ha enviado la acción.`,
    };
  const target =
    "id" in body ? body.id : "path" in body ? body.path : host.name;
  const inserted = await db
    .insert(operations)
    .values({
      id: operationId,
      hostId: host.id,
      userId,
      action: body.action,
      target,
      status: "pending",
      channel,
      requestedBy,
      bootAt:
        body.action === "reboot"
          ? new Date((latest.data.timestamp - latest.data.uptime) * 1000)
          : null,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return { status: "duplicate" };
  try {
    const result = await nasForHost<{ state?: string }>(
      host,
      "/action",
      body,
      body.action === "update-container"
        ? CONTAINER_UPDATE_TIMEOUT_MS
        : undefined,
    );
    if (body.action === "reboot") {
      await db
        .update(operations)
        .set({
          status: "pending",
          detail:
            "Reinicio solicitado; esperando que el host vuelva a responder.",
        })
        .where(eq(operations.id, operationId));
      return { status: "requested", result };
    }
    if (
      (body.action === "start" ||
        body.action === "stop" ||
        body.action === "restart") &&
      "id" in body
    ) {
      const metrics = latest.data as Metrics;
      const container = metrics.containers.find((c) => c.id === body.id);
      if (container) {
        // The shared close-out locks the operation and the settings row,
        // applies the watching intention and closes the episode once.
        await finalizeContainerOperation({
          hostId: host.id,
          hostName: host.name,
          operationId,
          action: body.action,
          name: container.name,
          containerId: body.id,
          container,
          detail: "Operación completada y comprobada.",
        });
        return { status: "success", result };
      }
      await db
        .update(operations)
        .set({
          status: "success",
          detail: "Operación completada y comprobada.",
        })
        .where(eq(operations.id, operationId));
      return { status: "success", result };
    }
    await db
      .update(operations)
      .set({
        status: "success",
        detail:
          body.action === "update-container"
            ? "Contenedor actualizado: imagen descargada y servicio recreado."
            : "Operación completada y comprobada.",
      })
      .where(eq(operations.id, operationId));
    return { status: "success", result };
  } catch (error) {
    if (error instanceof NasRejected && error.status < 500) {
      const { updated, operation } = await updatePendingOperation(operationId, {
        status: "failed",
        detail: error.message,
      });
      return {
        status: "failed",
        error: error.message,
        ...(!updated && operation ? { settled: operation } : {}),
      };
    }
    // A timeout may occur after the NAS executed the action. Never retry it automatically.
    const { updated, operation } = await updatePendingOperation(operationId, {
      detail:
        "No se pudo confirmar el resultado. Comprueba el estado antes de repetir.",
    });
    return {
      status: "uncertain",
      ...(!updated && operation ? { settled: operation } : {}),
    };
  }
}
