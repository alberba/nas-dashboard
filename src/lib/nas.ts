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

/** An agent response went over the cap of its path. It is never partial data. */
export class ResponseTooLarge extends Error {
  constructor(readonly limit: number) {
    super("La respuesta del agente supera el tope de su camino");
    this.name = "ResponseTooLarge";
  }
}

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * Per-path caps on what the hub reads from an agent (D-10). They are
 * unmeasured guesses (A1): revisit them with the sizes seen in production.
 */
export const AGENT_RESPONSE_LIMITS = {
  metrics: 2 * MIB,
  maintenance: 1 * MIB,
  deployments: 2 * MIB,
  files: 8 * MIB,
  trash: 2 * MIB,
  logs: 8 * MIB,
  /** The answer to any POST: an action result or a command outcome. */
  post: 256 * KIB,
  other: 1 * MIB,
} as const;

/** A defined `body` marks a POST; the query string never changes the cap. */
export function responseLimitFor(path: string, body?: unknown): number {
  if (body !== undefined) return AGENT_RESPONSE_LIMITS.post;
  let pathname: string;
  try {
    pathname = new URL(path, "http://agent").pathname;
  } catch {
    return AGENT_RESPONSE_LIMITS.other;
  }
  switch (pathname) {
    case "/metrics":
      return AGENT_RESPONSE_LIMITS.metrics;
    case "/maintenance":
      return AGENT_RESPONSE_LIMITS.maintenance;
    case "/deployments":
      return AGENT_RESPONSE_LIMITS.deployments;
    case "/files":
      return AGENT_RESPONSE_LIMITS.files;
    case "/trash":
      return AGENT_RESPONSE_LIMITS.trash;
    case "/logs":
      return AGENT_RESPONSE_LIMITS.logs;
    default:
      return AGENT_RESPONSE_LIMITS.other;
  }
}

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

/**
 * The only way the hub reads an agent body. It never holds more than `limit`
 * bytes, and decodes once at the end, so `JSON.parse` only ever sees a body
 * that fit whole: a cut anywhere, even inside a multibyte character or a JSON
 * token, is a ResponseTooLarge and never partial data.
 */
async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLarge(limit);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const stop = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      received += value.byteLength;
      if (received > limit) throw new ResponseTooLarge(limit);
      chunks.push(value);
    }
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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
    const limit = responseLimitFor(path, body);
    const raw = yield* Effect.tryPromise({
      try: (signal) => readBounded(response, limit, signal),
      catch: (cause) => {
        if (!(cause instanceof ResponseTooLarge))
          return new NasUnavailable({ cause });
        // A correct answer that does not fit is a broken contract (pending for
        // a POST), never a rejection; an error answer keeps its status.
        return response.ok
          ? new NasInvalidResponse({ cause })
          : new NasRejected({
              status: response.status,
              message: rejectedMessage(undefined),
            });
      },
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
