import type { HostCommand } from "./host-command-contract";

/**
 * Sends a host command that needs no verification (`check-health`, D-03) with
 * a fresh Idempotency-Key. A network error propagates: the caller treats it as
 * pending, since the request may have reached the hub.
 */
export async function sendHostCommand(
  endpoint: string,
  command: HostCommand,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ command }),
  });
  let data: unknown = {};
  try {
    data = await response.json();
  } catch {
    // A non-JSON body leaves `data` empty.
  }
  return { ok: response.ok, status: response.status, data };
}
