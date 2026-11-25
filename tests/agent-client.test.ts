import { afterEach, describe, expect, it, vi } from "vitest";
import { NasInvalidResponse, NasRejected, nasForHost } from "../src/lib/nas";
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
});
