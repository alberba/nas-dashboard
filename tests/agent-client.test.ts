import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RESPONSE_LIMITS,
  NasInvalidResponse,
  NasRejected,
  ResponseTooLarge,
  nasForHost,
  responseLimitFor,
} from "../src/lib/nas";
import { metricsSnapshot } from "./host-fixtures";

const nas = {
  id: "nas-home",
  name: "NAS-HOME",
  role: "instance" as const,
  url: "http://nas.invalid:9450",
  token: "a".repeat(32),
};
const apps = {
  id: "apps",
  name: "Apps",
  role: "apps-server" as const,
  url: "http://apps.invalid:9450",
  token: "b".repeat(32),
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("agent client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends every request to the selected host with its own token", async () => {
    const fetch = vi.fn(async () => jsonResponse(metricsSnapshot()));
    vi.stubGlobal("fetch", fetch);
    await nasForHost(apps, "/metrics");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://apps.invalid:9450/metrics");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${apps.token}`,
    );
  });

  it("keeps one host isolated from another host's credentials", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await nasForHost(nas, "/action", { action: "stop" });
    const [url, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://nas.invalid:9450/action");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${nas.token}`,
    );
  });

  it("decodes a valid metrics snapshot and preserves optional views", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          metricsSnapshot({
            cpu: null,
            cpuCores: [12, null],
            system: {
              hostname: "nas",
              cpuModel: "Test CPU",
              cores: 2,
              threads: 4,
              sockets: 1,
              arch: "x86_64",
              kernel: "6.1",
              osName: "Linux",
              memoryTotal: 1000,
            },
            filesystems: [
              { name: "Volumen", total: 100, used: 10, free: 90 },
            ],
            raid: [
              {
                name: "md0",
                level: "raid1",
                state: "active",
                disks: 2,
                capacity: 1000,
                degraded: 0,
                syncAction: "idle",
                syncCompleted: null,
                syncSpeed: null,
              },
            ],
            temperatures: [{ name: "CPU", value: 45 }],
          }),
        ),
      ),
    );
    const metrics = await nasForHost<Record<string, unknown>>(nas, "/metrics");
    expect(metrics).toMatchObject({
      cpu: null,
      cpuCores: [12, null],
      temperatures: [{ name: "CPU", value: 45 }],
      containers: [expect.objectContaining({ name: "nas-service" })],
    });
    expect(metrics.system).toMatchObject({ cpuModel: "Test CPU" });
    expect(metrics.filesystems).toEqual([
      { name: "Volumen", total: 100, used: 10, free: 90 },
    ]);
    expect(metrics.raid).toEqual([
      expect.objectContaining({ name: "md0", state: "active" }),
    ]);
  });

  it("rejects broken JSON or a wrong shape in a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"timestamp":', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(nasForHost(nas, "/metrics")).rejects.toBeInstanceOf(
      NasInvalidResponse,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          metricsSnapshot({
            memory: { total: 0, used: 0 },
          }),
        ),
      ),
    );
    await expect(nasForHost(nas, "/metrics")).rejects.toBeInstanceOf(
      NasInvalidResponse,
    );
  });

  it("keeps an HTTP rejection distinct even when its body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("upstream unavailable", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    const error = await nasForHost(nas, "/metrics").catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(NasRejected);
    if (!(error instanceof NasRejected)) throw new Error("expected NasRejected");
    expect(error.status).toBe(503);
    expect(error.message).toBe("El NAS rechazó la operación");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "El host no responde" }, 503),
      ),
    );
    const withJson = await nasForHost(nas, "/metrics").catch(
      (reason: unknown) => reason,
    );
    expect(withJson).toBeInstanceOf(NasRejected);
    if (!(withJson instanceof NasRejected))
      throw new Error("expected NasRejected");
    expect(withJson.message).toBe("El host no responde");
  });

  describe("bounded reads", () => {
    const post = AGENT_RESPONSE_LIMITS.post;
    const encoder = new TextEncoder();

    /** A body that reports whether it was pulled and whether it was cancelled. */
    function probeBody(chunks: Uint8Array[]) {
      const probe = { pulls: 0, cancelled: false };
      let next = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            probe.pulls += 1;
            if (next >= chunks.length) controller.close();
            else controller.enqueue(chunks[next++]);
          },
          cancel() {
            probe.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { probe, stream };
    }

    function chunked(bytes: Uint8Array, size: number) {
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < bytes.length; at += size)
        chunks.push(bytes.subarray(at, at + size));
      return chunks;
    }

    /** A JSON object padded to exactly `size` bytes. */
    function jsonOfSize(size: number) {
      const frame = '{"pad":""}'.length;
      return encoder.encode(`{"pad":"${"a".repeat(size - frame)}"}`);
    }

    async function failure(promise: Promise<unknown>) {
      return promise.catch((reason: unknown) => reason);
    }

    function stubBody(
      stream: ReadableStream<Uint8Array>,
      init: ResponseInit = {},
    ) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream, { status: 200, ...init })),
      );
    }

    it("picks the cap from the pathname and ignores the query", () => {
      expect(responseLimitFor("/files?root=a&path=%2Flogs")).toBe(
        AGENT_RESPONSE_LIMITS.files,
      );
      expect(responseLimitFor("/deployments?lines=100")).toBe(
        AGENT_RESPONSE_LIMITS.deployments,
      );
      expect(responseLimitFor("/anything-else")).toBe(
        AGENT_RESPONSE_LIMITS.other,
      );
      expect(responseLimitFor("/files", { a: 1 })).toBe(post);
    });

    it("refuses a declared oversize without reading the stream", async () => {
      const limit = AGENT_RESPONSE_LIMITS.trash;
      const { probe, stream } = probeBody([new Uint8Array(8)]);
      stubBody(stream, {
        headers: { "Content-Length": String(limit + 1) },
      });
      const error = await failure(nasForHost(nas, "/trash"));
      expect(error).toBeInstanceOf(NasInvalidResponse);
      if (!(error instanceof NasInvalidResponse))
        throw new Error("expected NasInvalidResponse");
      expect(error.cause).toBeInstanceOf(ResponseTooLarge);
      expect(probe.pulls).toBe(0);
      expect(probe.cancelled).toBe(true);
    });

    it("cuts an undeclared oversize while streaming and cancels the reader", async () => {
      const limit = AGENT_RESPONSE_LIMITS.trash;
      const size = 64 * 1024;
      const chunks = Array.from({ length: limit / size + 40 }, () =>
        new Uint8Array(size).fill(97),
      );
      const { probe, stream } = probeBody(chunks);
      stubBody(stream);
      const error = await failure(nasForHost(nas, "/trash"));
      expect(error).toBeInstanceOf(NasInvalidResponse);
      if (!(error instanceof NasInvalidResponse))
        throw new Error("expected NasInvalidResponse");
      expect(error.cause).toBeInstanceOf(ResponseTooLarge);
      expect(probe.cancelled).toBe(true);
      expect(probe.pulls).toBeLessThanOrEqual(limit / size + 2);
    });

    it("reads exactly the cap and parses it whole, never a partial body", async () => {
      const parse = vi.spyOn(JSON, "parse");
      try {
        stubBody(probeBody(chunked(jsonOfSize(post), 4099)).stream);
        const data = await nasForHost<{ pad: string }>(nas, "/action", {
          action: "stop",
        });
        expect(data.pad).toHaveLength(post - '{"pad":""}'.length);

        parse.mockClear();
        stubBody(probeBody(chunked(jsonOfSize(post + 1), 4099)).stream);
        const error = await failure(
          nasForHost(nas, "/action", { action: "stop" }),
        );
        expect(error).toBeInstanceOf(NasInvalidResponse);
        const bodies = parse.mock.calls.filter(
          ([arg]) => typeof arg === "string" && arg.startsWith('{"pad"'),
        );
        expect(bodies).toEqual([]);
      } finally {
        parse.mockRestore();
      }
    });

    it("turns every cut point into ResponseTooLarge, even inside a multibyte character", async () => {
      const text = encoder.encode(`{"note":"${"€".repeat(post)}`);
      for (const extra of [0, 1, 2, 3, 4]) {
        for (const size of [1021, 4096, 65537]) {
          const bytes = text.subarray(0, post + 1 + extra);
          stubBody(probeBody(chunked(bytes, size)).stream);
          const error = await failure(
            nasForHost(nas, "/action", { action: "stop" }),
          );
          expect(error, `${extra}/${size}`).toBeInstanceOf(NasInvalidResponse);
          if (!(error instanceof NasInvalidResponse))
            throw new Error("expected NasInvalidResponse");
          expect(error.cause, `${extra}/${size}`).toBeInstanceOf(
            ResponseTooLarge,
          );
        }
      }
    });

    it("leaves an oversized POST answer as an unverified result, not a rejection", async () => {
      stubBody(probeBody(chunked(jsonOfSize(post + 1), 8192)).stream);
      const error = await failure(
        nasForHost(nas, "/action", { action: "stop" }),
      );
      expect(error).toBeInstanceOf(NasInvalidResponse);
      expect(error).not.toBeInstanceOf(NasRejected);
    });

    it("keeps the status of an oversized error answer as a rejection", async () => {
      const limit = AGENT_RESPONSE_LIMITS.trash;
      stubBody(probeBody([new Uint8Array(8)]).stream, {
        status: 502,
        headers: { "Content-Length": String(limit + 1) },
      });
      const error = await failure(nasForHost(nas, "/trash"));
      expect(error).toBeInstanceOf(NasRejected);
      if (!(error instanceof NasRejected))
        throw new Error("expected NasRejected");
      expect(error.status).toBe(502);

      const size = 64 * 1024;
      stubBody(
        probeBody(
          Array.from({ length: limit / size + 2 }, () => new Uint8Array(size)),
        ).stream,
        { status: 500 },
      );
      const streamed = await failure(nasForHost(nas, "/trash"));
      expect(streamed).toBeInstanceOf(NasRejected);
      if (!(streamed instanceof NasRejected))
        throw new Error("expected NasRejected");
      expect(streamed.status).toBe(500);
    });
  });
});
