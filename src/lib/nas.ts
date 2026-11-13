import { Data, Effect, Result } from "effect";
import { getHosts, primaryHost, type HostConfig } from "./hosts";

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

export function nasEffectForHost<T>(
  host: AgentHost,
  path: string,
  body?: unknown,
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
    const data = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new NasInvalidResponse({ cause }),
    });
    if (!response.ok)
      return yield* Effect.fail(
        new NasRejected({
          status: response.status,
          message: data.error ?? "El NAS rechazó la operación",
        }),
      );
    return data as T;
  }).pipe(
    Effect.timeoutOrElse({
      duration: body === undefined ? "25 seconds" : "45 seconds",
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
): Promise<T> {
  const result = await Effect.runPromise(
    Effect.result(nasEffectForHost<T>(host, path, body)),
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
