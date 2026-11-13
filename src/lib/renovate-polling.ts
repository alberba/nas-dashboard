import type { RenovateOverview } from "./types";

export const RENOVATE_INTERVAL_MS = 60_000;

export type RenovateState = {
  /** `loading` until the first answer, `error` when none ever arrived. */
  phase: "loading" | "ready" | "error";
  overview: RenovateOverview | null;
  /** The last refresh failed: `overview` is older than the latest attempt. */
  stale: boolean;
};

export const initialRenovateState: RenovateState = {
  phase: "loading",
  overview: null,
  stale: false,
};

function isOverview(value: unknown): value is RenovateOverview {
  const v = value as Partial<RenovateOverview> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.enabled === "boolean" &&
    Array.isArray(v.prs)
  );
}

/**
 * Polls GET /api/renovate. GitHub is queried on every load, so the interval is
 * never shorter than a minute; the next request starts one interval after the
 * previous one finished. `stop` aborts the request in flight and guarantees no
 * further `onChange`.
 */
export function startRenovatePolling({
  url,
  onChange,
  fetcher = fetch,
  intervalMs = RENOVATE_INTERVAL_MS,
}: {
  url: string;
  onChange: (state: RenovateState) => void;
  fetcher?: typeof fetch;
  intervalMs?: number;
}): () => void {
  const interval = Math.max(intervalMs, RENOVATE_INTERVAL_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let current = initialRenovateState;

  const publish = (next: RenovateState) => {
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
      const data: unknown = await response.json();
      if (!isOverview(data)) throw new Error("invalid overview");
      publish({ phase: "ready", overview: data, stale: false });
    } catch {
      if (stopped) return;
      publish(
        current.overview
          ? { phase: "ready", overview: current.overview, stale: true }
          : { phase: "error", overview: null, stale: false },
      );
    }
    if (!stopped) timer = setTimeout(load, interval);
  }

  void load();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
