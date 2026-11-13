import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startSnapshotPolling,
  type SnapshotState,
} from "@/lib/maintenance-polling";

const body = (timestamp: number) => ({
  host: { id: "nas", name: "NAS", role: "instance" },
  snapshot: { timestamp },
});

function ok(timestamp: number) {
  return Response.json(body(timestamp));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function run(fetcher: typeof fetch) {
  const states: SnapshotState[] = [];
  const stop = startSnapshotPolling({
    url: "/api/maintenance?host=nas",
    fetcher,
    intervalMs: 60_000,
    onChange: (state) => states.push(state),
  });
  return { states, stop, last: () => states[states.length - 1] };
}

describe("snapshot polling", () => {
  it("loads, then refreshes every interval without overlapping", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(1))
      .mockResolvedValueOnce(ok(2));
    const { last, stop } = run(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "ready", stale: false });
    expect(last().snapshot?.timestamp).toBe(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(last().snapshot?.timestamp).toBe(2);
    stop();
  });

  it("keeps the last snapshot as stale when a refresh fails, then recovers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(1))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(ok(3));
    const { last, stop } = run(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last()).toMatchObject({ phase: "ready", stale: true });
    expect(last().snapshot?.timestamp).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last()).toMatchObject({ stale: false });
    expect(last().snapshot?.timestamp).toBe(3);
    stop();
  });

  it("reports an error with no snapshot when the first load fails and keeps retrying", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(ok(5));
    const { last, stop } = run(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "error", snapshot: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last()).toMatchObject({ phase: "ready", stale: false });
    stop();
  });

  it("treats a malformed body as a failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ nothing: true }));
    const { last, stop } = run(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("error");
    stop();
  });

  it("aborts the request in flight and ignores its late answer once stopped", async () => {
    let signal: AbortSignal | undefined;
    let release: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => (release = resolve));
    });
    const { states, stop } = run(fetcher);
    stop();
    expect(signal?.aborted).toBe(true);
    release(ok(9));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(states).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
