import type { MaintenanceResponse, MaintenanceSnapshot } from "./maintenance";

export const SNAPSHOT_INTERVAL_MS = 60_000;

export type SnapshotState = {
  /** `loading` until the first answer, `error` when none ever arrived. */
  phase: "loading" | "ready" | "error";
  snapshot: MaintenanceSnapshot | null;
  /** The last refresh failed: `snapshot` is older than the latest attempt. */
  stale: boolean;
};

export const initialSnapshotState: SnapshotState = {
  phase: "loading",
  snapshot: null,
  stale: false,
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
    try {
      const response = await fetcher(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as Partial<MaintenanceResponse>;
      if (!isSnapshot(data.snapshot)) throw new Error("invalid snapshot");
      publish({ phase: "ready", snapshot: data.snapshot, stale: false });
    } catch {
      if (stopped) return;
      publish(
        current.snapshot
          ? { phase: "ready", snapshot: current.snapshot, stale: true }
          : { phase: "error", snapshot: null, stale: false },
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
