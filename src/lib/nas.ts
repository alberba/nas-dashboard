import { Data, Effect, Result } from "effect";
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

export function nasEffect<T>(
  path: string,
  body?: unknown,
): Effect.Effect<T, NasUnavailable | NasRejected | NasInvalidResponse> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${process.env.NAS_AGENT_URL}${path}`, {
          method: body === undefined ? "GET" : "POST",
          cache: "no-store",
          signal,
          headers: {
            Authorization: `Bearer ${process.env.AGENT_TOKEN}`,
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

// Promise boundary for Next route handlers; typed failures remain distinguishable.
export async function nas<T>(path: string, body?: unknown): Promise<T> {
  const result = await Effect.runPromise(
    Effect.result(nasEffect<T>(path, body)),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}
