import { z } from "zod";
import type { HostInfo } from "./types";

/** Docker's tail limit for one read; the UI must not ask for more. */
export const MAX_LOG_LINES = 5000;
export const DEFAULT_LOG_LINES = 200;

const timestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const unixTimestamp = /^\d{10}(?:\.\d{1,9})?$/;

export const containerIdSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Contenedor no válido");

export function validSince(value: string): boolean {
  const [at, skip, ...rest] = value.split("#");
  if (!at || rest.length > 0) return false;
  if (skip !== undefined && !/^\d{1,9}$/.test(skip)) return false;
  return timestamp.test(at) || unixTimestamp.test(at);
}

const sinceSchema = z
  .string()
  .max(64)
  .refine(validSince, "Marca de tiempo no válida");

export const logLineSchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  at: z.string().nullable(),
  message: z.string(),
});

export const logsResponseSchema = z.object({
  id: containerIdSchema,
  lines: z.array(logLineSchema).max(MAX_LOG_LINES),
  cursor: z.string().nullable(),
  truncated: z.boolean(),
});

export type LogLine = z.infer<typeof logLineSchema>;
export type LogsResponse = z.infer<typeof logsResponseSchema>;
export type ContainerLogs = LogsResponse & { host: HostInfo };

export function parseLogsQuery(params: URLSearchParams) {
  return {
    id: containerIdSchema.parse(params.get("id") ?? ""),
    lines: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LOG_LINES)
      .default(DEFAULT_LOG_LINES)
      .parse(params.get("lines") || undefined),
    since: z
      .preprocess(
        (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
        sinceSchema.optional(),
      )
      .parse(params.get("since")),
  };
}
