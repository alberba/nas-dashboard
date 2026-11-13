import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RENOVATE_INTERVAL_MS,
  startRenovatePolling,
  type RenovateState,
} from "@/lib/renovate-polling";

const data = { enabled: true, repository: "o/r", prs: [] };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function run(fetcher: typeof fetch, intervalMs?: number) {
  const states: RenovateState[] = [];
  const stop = startRenovatePolling({
    url: "/api/renovate?host=nas-home",
    fetcher,
    intervalMs,
    onChange: (s) => states.push(s),
  });
  return { states, stop, last: () => states[states.length - 1] };
}

describe("renovate polling", () => {
  it("never polls faster than once a minute", async () => {
    expect(RENOVATE_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
    run(fetcher, 1_000); // a faster request is clamped
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the last data as stale when a refresh fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(data))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const { last } = run(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "ready", stale: false });
    await vi.advanceTimersByTimeAsync(RENOVATE_INTERVAL_MS);
    expect(last()).toMatchObject({ phase: "ready", stale: true });
    expect(last().overview).toEqual(data);
  });

  it("reports an error when nothing ever arrived", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("x"));
    const { last } = run(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "error", overview: null });
  });

  it("aborts the request in flight and stays silent after stop", async () => {
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_u, init) =>
        new Promise((_, reject) => {
          signal = init?.signal;
          signal?.addEventListener("abort", () => reject(new Error("abort")));
        }),
    );
    const { states, stop } = run(fetcher);
    stop();
    await vi.advanceTimersByTimeAsync(RENOVATE_INTERVAL_MS * 2);
    expect(signal?.aborted).toBe(true);
    expect(states).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a disabled section as ready data, not an error", async () => {
    const off = { enabled: false, repository: null, prs: [] };
    const { last } = run(vi.fn<typeof fetch>().mockResolvedValue(Response.json(off)));
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "ready", overview: off });
  });
});
