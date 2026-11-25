import { Data, Effect, Result } from "effect";
import { getHosts, primaryHost, type HostConfig } from "./hosts";
import { agentSnapshotSchema } from "./agent-snapshots";

export class NasUnavailable extends Data.TaggedError("NasUnavailable")<{
  readonly cause: unknown;
}> {}
export class NasRejected extends Data.TaggedError("NasRejected")<{
  readonly status: number;
  readonly message: string;
}> {}
export class NasInvalidResponse extends Data.TaggedError("NasInvalidResponse")<{
  readonly cause: unknown;
}> {}

export type AgentHost = Pick<HostConfig, "url" | "token">;

/** A Compose pull and recreate can outlast the normal action timeout. */
export const CONTAINER_UPDATE_TIMEOUT_MS = 300_000;

function durationFor(body: unknown, timeoutMs?: number) {
  const fallback = body === undefined ? 25_000 : 45_000;
  return `${Math.ceil((timeoutMs ?? fallback) / 1000)} seconds` as const;
}

function rejectedMessage(data: unknown) {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error?: unknown }).error === "string"
  )
    return (data as { error: string }).error;
  // The status is the trustworthy part of a rejection; a broken or non-JSON
  // body must not turn it into a schema failure.
  return "El NAS rechazó la operación";
}

export function nasEffectForHost<T>(
  host: AgentHost,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Effect.Effect<T, NasUnavailable | NasRejected | NasInvalidResponse> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${host.url}${path}`, {
          method: body === undefined ? "GET" : "POST",
          cache: "no-store",
          signal,
          headers: {
            Authorization: `Bearer ${host.token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      catch: (cause) => new NasUnavailable({ cause }),
    });
    const raw = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new NasUnavailable({ cause }),
    });
    let data: unknown;
    let parseError: unknown;
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch (cause) {
        parseError = cause;
      }
    } else {
      parseError = new Error("Respuesta vacía");
    }
    if (!response.ok)
      return yield* Effect.fail(
        new NasRejected({
          status: response.status,
          message: rejectedMessage(data),
        }),
      );
    if (parseError)
      return yield* Effect.fail(new NasInvalidResponse({ cause: parseError }));
    // Decode the producer shape inside the Effect, before the Promise boundary,
    // so route handlers and the collector receive either typed data or a
    // distinct NasInvalidResponse.
    const schema = body === undefined ? agentSnapshotSchema(path) : undefined;
    if (schema) {
      const parsed = schema.safeParse(data);
      if (!parsed.success)
        return yield* Effect.fail(
          new NasInvalidResponse({ cause: parsed.error }),
        );
      return parsed.data as T;
    }
    return data as T;
  }).pipe(
    Effect.timeoutOrElse({
      duration: durationFor(body, timeoutMs),
      orElse: () => Effect.fail(new NasUnavailable({ cause: "timeout" })),
    }),
  );
}

export function nasEffect<T>(
  path: string,
  body?: unknown,
  host: AgentHost = primaryHost(getHosts()),
): Effect.Effect<T, NasUnavailable | NasRejected | NasInvalidResponse> {
  return nasEffectForHost(host, path, body);
}

// Promise boundary for Next route handlers; typed failures remain distinguishable.
export async function nasForHost<T>(
  host: AgentHost,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const result = await Effect.runPromise(
    Effect.result(nasEffectForHost<T>(host, path, body, timeoutMs)),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

export async function nas<T>(
  path: string,
  body?: unknown,
  host: AgentHost = primaryHost(getHosts()),
): Promise<T> {
  return nasForHost(host, path, body);
}
