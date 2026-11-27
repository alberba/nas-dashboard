import type { MaintenanceResponse, MaintenanceSnapshot } from "./maintenance";

export const SNAPSHOT_INTERVAL_MS = 60_000;

export type SnapshotState = {
  /** `loading` until the first answer, `error` when none ever arrived. */
  phase: "loading" | "ready" | "error";
  snapshot: MaintenanceSnapshot | null;
  /** The last refresh failed: `snapshot` is older than the latest attempt. */
  stale: boolean;
  /** The hub refused the last answer as too large; the snapshot is not partial. */
  tooLarge: boolean;
};

export const initialSnapshotState: SnapshotState = {
  phase: "loading",
  snapshot: null,
  stale: false,
  tooLarge: false,
};

function isSnapshot(value: unknown): value is MaintenanceSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { timestamp?: unknown }).timestamp === "number"
  );
}

/**
 * Polls one host's maintenance snapshot. The next request starts one interval
 * after the previous one finished, so requests never overlap. `onChange` only
 * reports results; the caller starts from `initialSnapshotState`. `stop` aborts
 * the request in flight and guarantees no further `onChange`.
 */
export function startSnapshotPolling({
  url,
  onChange,
  fetcher = fetch,
  intervalMs = SNAPSHOT_INTERVAL_MS,
}: {
  url: string;
  onChange: (state: SnapshotState) => void;
  fetcher?: typeof fetch;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let current: SnapshotState = initialSnapshotState;

  const publish = (next: SnapshotState) => {
    if (stopped) return;
    current = next;
    onChange(next);
  };

  async function load() {
    controller = new AbortController();
    let tooLarge = false;
    try {
      const response = await fetcher(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        // A refusal for size has a stable code; any other body is just a failure.
        const failure = (await response.json().catch(() => null)) as {
          code?: unknown;
        } | null;
        tooLarge = failure?.code === "agent_response_too_large";
        throw new Error(String(response.status));
      }
      const data = (await response.json()) as Partial<MaintenanceResponse>;
      if (!isSnapshot(data.snapshot)) throw new Error("invalid snapshot");
      publish({
        phase: "ready",
        snapshot: data.snapshot,
        stale: false,
        tooLarge: false,
      });
    } catch {
      if (stopped) return;
      publish(
        current.snapshot
          ? { phase: "ready", snapshot: current.snapshot, stale: true, tooLarge }
          : { phase: "error", snapshot: null, stale: false, tooLarge },
      );
    }
    if (!stopped) timer = setTimeout(load, intervalMs);
  }

  void load();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
