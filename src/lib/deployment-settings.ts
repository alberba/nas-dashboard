import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  CONNECTION_STALE_MS,
  resolveHost,
  type HostConfig,
} from "./hosts";
import { nasForHost, NasRejected } from "./nas";
import { operations, samples } from "./schema";
import { guardSensitiveAction } from "./verification-api";
import {
  verificationStore,
  type VerificationSession,
  type VerificationStore,
} from "./verification";

const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: noStore });

const KEY = /^[A-Z_][A-Z0-9_]{0,79}$/;
const RELEASE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The form always carries one closed map; values never leave the request. */
export const deploymentSettingsSchema = z.strictObject({
  release: z.string().max(80).regex(RELEASE, "Release no válida"),
  values: z
    .record(
      z.string().max(80).regex(KEY, "Nombre de ajuste no válido"),
      z
        .string()
        .max(4096)
        .refine((value) => !CONTROL.test(value), "Valor de ajuste no válido"),
    )
    .refine(
      (values) =>
        Object.keys(values).length >= 1 && Object.keys(values).length <= 64,
      "Solicitud no válida",
    ),
  acknowledgedManualSteps: z.boolean().optional(),
});

export type DeploymentSettingsInput = z.infer<
  typeof deploymentSettingsSchema
>;

export type DeploymentSettingsResult = {
  release: string;
  saved: string[];
  missingSettings: string[];
};

const resultSchema = z.strictObject({
  release: z.string().max(80),
  saved: z.array(z.string().max(80)).max(64),
  missingSettings: z.array(z.string().max(80)).max(500),
});

const pendingDetail =
  "No se pudo confirmar el resultado. Comprueba el fichero .env antes de repetir la operación.";
const failedDetail =
  "El host rechazó los ajustes. No se ha escrito ningún valor.";

function response(
  operation: typeof operations.$inferSelect,
  result?: DeploymentSettingsResult,
) {
  return json({
    ok: true,
    status: operation.status,
    operation,
    ...(result ? { result } : {}),
  });
}

/**
 * Applies the missing settings of one retained release. The agent is the
 * authority on the catalog, the release and the current .env; the hub adds
 * origin, recent verification, per-host idempotency and the operations record.
 * Values are never copied into the response, the operation or the logs, and a
 * lost response stays pending without an automatic retry.
 */
export async function saveDeploymentSettings({
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
  const input = deploymentSettingsSchema.parse(await request.json());
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

  if (host.role !== "instance")
    return json(
      { error: "Los ajustes de una release solo se escriben en la Instancia" },
      400,
    );

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
        error: `${host.name} no está conectado. No se ha escrito ningún ajuste.`,
      },
      503,
    );

  const inserted = await db
    .insert(operations)
    .values({
      id: operationId,
      hostId: host.id,
      userId: session.user.id,
      action: "deployment-settings",
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

  const expected = Object.keys(input.values).sort();
  try {
    const raw = await nasForHost<unknown>(host, "/deployments/settings", {
      release: input.release,
      values: input.values,
      acknowledgedManualSteps: input.acknowledgedManualSteps ?? false,
    });
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.release !== input.release)
      throw new Error("Respuesta del agente no válida");
    const saved = [
      ...new Set(parsed.data.saved.filter((name) => name in input.values)),
    ].sort();
    if (
      saved.length !== expected.length ||
      saved.some((name, index) => name !== expected[index])
    )
      throw new Error("Respuesta del agente no válida");
    const missingSettings = [
      ...new Set(
        parsed.data.missingSettings.filter((name) => KEY.test(name)),
      ),
    ];
    const result: DeploymentSettingsResult = {
      release: input.release,
      saved,
      missingSettings,
    };
    const [operation] = await db
      .update(operations)
      .set({
        status: "success",
        detail: `Ajustes guardados: ${saved.join(", ")}.`,
      })
      .where(eq(operations.id, operationId))
      .returning();
    return response(operation, result);
  } catch (error) {
    if (error instanceof NasRejected && error.status < 500) {
      // The agent message is not forwarded: it must never be a channel for a
      // value, even if a future agent version includes one by mistake.
      const [operation] = await db
        .update(operations)
        .set({ status: "failed", detail: failedDetail })
        .where(eq(operations.id, operationId))
        .returning();
      return json(
        { error: failedDetail, status: "failed", operation },
        400,
      );
    }
    // The write may have succeeded before the response was lost.
    const [operation] = await db
      .update(operations)
      .set({ detail: pendingDetail })
      .where(eq(operations.id, operationId))
      .returning();
    return json(
      {
        error:
          "Resultado pendiente de verificar. No se ha repetido la escritura.",
        status: "pending",
        operation,
      },
      502,
    );
  }
}
