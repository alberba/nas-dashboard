import { MAX_LOG_LINES, type LogLine } from "./logs";

export type LogLevel = "error" | "warn";

/** `/api/logs` path for one read; `cursor` is the opaque mark of the last one. */
export function logsRequestPath({
  id,
  lines,
  cursor,
}: {
  id: string;
  lines: number;
  cursor: string | null;
}) {
  const params = new URLSearchParams({ id, lines: String(lines) });
  if (cursor) params.set("since", cursor);
  return `/api/logs?${params}`;
}

/** Appends new lines and keeps the newest `limit`, never above the agent's cap. */
export function appendLines(
  buffer: LogLine[],
  incoming: LogLine[],
  limit: number,
) {
  const keep = Math.min(limit, MAX_LOG_LINES);
  return [...buffer, ...incoming].slice(-keep);
}

const errorPattern = /\b(error|fatal|critical|panic)\b/i;
const warnPattern = /\b(warn|warning)\b/i;

export function logLevel(message: string): LogLevel | null {
  if (errorPattern.test(message)) return "error";
  if (warnPattern.test(message)) return "warn";
  return null;
}

export function filterLines(lines: LogLine[], text: string) {
  const needle = text.trim().toLowerCase();
  if (!needle) return lines;
  return lines.filter((line) => line.message.toLowerCase().includes(needle));
}

/** Plain-text export: one line per entry, prefixed by its time when known. */
export function logsText(lines: LogLine[]) {
  if (!lines.length) return "";
  return lines
    .map((line) => (line.at ? `${line.at} ${line.message}` : line.message))
    .join("\n")
    .concat("\n");
}
