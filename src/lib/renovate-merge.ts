import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  fetchPullRequestChecks,
  fetchRenovatePullRequest,
  githubConfig,
  githubFetch,
  GithubUnavailable,
  type GithubPullRequestDetail,
} from "./github";
import {
  executeHostCommand,
  type HostCommandOutcome,
} from "./host-commands";
import { resolveHost, type HostConfig } from "./hosts";
import { operations } from "./schema";
import { guardSensitiveAction } from "./verification-api";
import { verificationStore } from "./verification";

const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: noStore });

export const mergeRequestSchema = z.strictObject({
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  deployNow: z.boolean().default(false),
});

type MergeDeploy = {
  status: "success" | "failed" | "pending" | "unavailable";
  operation: typeof operations.$inferSelect | null;
  error: string | null;
};

function storedStatus(value: string): "success" | "failed" | "pending" {
  return value === "success" || value === "failed" ? value : "pending";
}

/**
 * A stable UUID for the optional deploy-now command. Reusing the merge's
 * idempotency key would collide with the merge row, so it is derived instead:
 * the same merge can only ever create one deploy operation.
 */
export function deployOperationId(mergeOperationId: string, hostId: string) {
  const hex = createHash("sha256")
    .update(`${mergeOperationId}:deploy-now:${hostId}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function mergeDeploy(outcome: HostCommandOutcome): MergeDeploy {
  return {
    status: outcome.status === "conflict" ? "unavailable" : outcome.status,
    operation: outcome.operation,
    error: outcome.error ?? null,
  };
}

async function deployNow({
  host,
  userId,
  mergeOperationId,
}: {
  host: HostConfig;
  userId: string;
  mergeOperationId: string;
}): Promise<MergeDeploy> {
  try {
    const outcome = await executeHostCommand({
      host,
      userId,
      command: "deploy-now",
      operationId: deployOperationId(mergeOperationId, host.id),
    });
    return mergeDeploy(outcome);
  } catch {
    return {
      status: "unavailable",
      operation: null,
      error: "No se pudo registrar el despliegue.",
    };
  }
}

function rejection(error: string, code: string, status = 409) {
  return json({ code, error }, status);
}

async function markPending(operationId: string, detail: string) {
  const [operation] = await db
    .update(operations)
    .set({ detail })
    .where(eq(operations.id, operationId))
    .returning();
  return operation;
}

async function markFailed(operationId: string, detail: string) {
  const [operation] = await db
    .update(operations)
    .set({ status: "failed", detail: detail.slice(0, 500) })
    .where(eq(operations.id, operationId))
    .returning();
  return operation;
}

function validatePullRequest(
  pr: GithubPullRequestDetail,
  input: { headSha: string },
) {
  if (!pr.merged && pr.state !== "open")
    return rejection("La PR ya no está abierta.", "not_open");
  if (pr.merged) return rejection("La PR ya está fusionada.", "not_open");
  if (pr.draft) return rejection("La PR sigue en borrador.", "draft");
  if (pr.headSha !== input.headSha)
    return rejection(
      "La PR ha cambiado desde que la viste. Actualiza y revísala de nuevo.",
      "sha_changed",
    );
  return null;
}

/**
 * Merges one Renovate pull request with the repository's squash method, only
 * when the Operator's recent verification is valid, the head SHA is the one
 * they saw, CI is green on that exact SHA and GitHub reports it mergeable.
 * The operation is recorded exactly once; GitHub rejections fail it and an
 * uncertain response stays pending. Neither case is retried automatically.
 */
export async function mergeRenovatePullRequest({
  request,
  session,
  hosts,
}: {
  request: Request & { nextUrl?: URL };
  session: { user: { id: string }; session: { id: string } };
  hosts: HostConfig[];
}) {
  const input = mergeRequestSchema.parse(await request.json());
  const denied = await guardSensitiveAction({
    request,
    session,
    store: verificationStore,
  });
  if (denied) return denied;

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
    if (existing.action !== "merge")
      return json(
        { error: "La clave de idempotencia ya se usó en otra operación" },
        409,
      );
    let deploy: MergeDeploy | null = null;
    if (input.deployNow) {
      const [deployOperation] = await db
        .select()
        .from(operations)
        .where(eq(operations.id, deployOperationId(existing.id, host.id)))
        .limit(1);
      if (deployOperation)
        deploy = {
          status: storedStatus(deployOperation.status),
          operation: deployOperation,
          error: null,
        };
    }
    return json({
      ok: true,
      status: existing.status,
      operation: existing,
      merge: null,
      deploy,
      replayed: true,
    });
  }

  const config = githubConfig();
  if (!config)
    return json(
      { error: "GitHub no está configurado en el servidor." },
      503,
    );

  const pr = await fetchRenovatePullRequest(config, input.number);
  if (!pr)
    return json({ error: "La PR de Renovate no está disponible." }, 404);

  const invalid = validatePullRequest(pr, input);
  if (invalid) return invalid;

  const ci = await fetchPullRequestChecks(config, input.headSha);
  if (ci !== "success")
    return rejection(
      ci === "failure"
        ? "El CI ha fallado sobre este SHA. No se ha fusionado."
        : "El CI no está en verde sobre este SHA. No se ha fusionado.",
      "ci_not_green",
    );

  if (pr.mergeable !== true)
    return rejection(
      pr.mergeableState === "dirty"
        ? "La PR tiene conflictos y no es fusionable."
        : "GitHub todavía no confirma que la PR sea fusionable.",
      "not_mergeable",
    );

  const inserted = await db
    .insert(operations)
    .values({
      id: operationId,
      hostId: host.id,
      userId: session.user.id,
      action: "merge",
      target: `#${pr.number}`,
      status: "pending",
      detail: `Merge con squash sobre ${input.headSha}.`,
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
      ? json({
          ok: true,
          status: current.status,
          operation: current,
          merge: null,
          deploy: null,
          replayed: true,
        })
      : json({ error: "No se pudo registrar la operación" }, 503);
  }

  let response: Response;
  try {
    response = await githubFetch(
      config,
      `/repos/${config.repository}/pulls/${pr.number}/merge`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merge_method: "squash",
          sha: input.headSha,
        }),
      },
    );
  } catch (error) {
    if (!(error instanceof GithubUnavailable)) throw error;
    const operation = await markPending(
      operationId,
      "No se pudo confirmar el resultado; no se ha repetido el merge.",
    );
    return json(
      {
        error:
          "Resultado pendiente de verificar. No se ha repetido el merge.",
        status: "pending",
        operation,
      },
      502,
    );
  }

  if (response.status >= 500) {
    const operation = await markPending(
      operationId,
      "GitHub no confirmó el resultado; no se ha repetido el merge.",
    );
    return json(
      {
        error:
          "Resultado pendiente de verificar. No se ha repetido el merge.",
        status: "pending",
        operation,
      },
      502,
    );
  }

  if (!response.ok) {
    let message = "GitHub rechazó el merge.";
    try {
      const data = (await response.json()) as { message?: unknown };
      if (typeof data.message === "string" && data.message)
        message = `GitHub rechazó el merge: ${data.message}`;
    } catch {
      // The status is definitive even when the body is not readable.
    }
    const operation = await markFailed(operationId, message);
    return json(
      { error: message, status: "failed", code: "merge_rejected", operation },
      409,
    );
  }

  let merged = false;
  let mergeSha: string | null = null;
  let message: string | null = null;
  try {
    const data = (await response.json()) as Record<string, unknown>;
    merged = data.merged === true;
    if (typeof data.sha === "string") mergeSha = data.sha;
    if (typeof data.message === "string") message = data.message;
  } catch {
    // HTTP 200 with an unreadable body still comes from GitHub's merge route.
    merged = true;
  }

  if (!merged) {
    const operation = await markFailed(
      operationId,
      "GitHub no confirmó el merge.",
    );
    return json(
      {
        error: "GitHub no confirmó el merge.",
        status: "failed",
        code: "merge_rejected",
        operation,
      },
      409,
    );
  }

  const [operation] = await db
    .update(operations)
    .set({
      status: "success",
      detail: `PR #${pr.number} fusionada con squash.`,
    })
    .where(eq(operations.id, operationId))
    .returning();

  const deploy = input.deployNow
    ? await deployNow({
        host,
        userId: session.user.id,
        mergeOperationId: operation.id,
      })
    : null;

  return json({
    ok: true,
    status: "success",
    operation,
    merge: { sha: mergeSha, merged: true, message },
    deploy,
  });
}
