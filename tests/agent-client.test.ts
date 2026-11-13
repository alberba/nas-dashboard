import { afterEach, describe, expect, it, vi } from "vitest";
import { nasForHost } from "../src/lib/nas";

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

describe("agent client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends every request to the selected host with its own token", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
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
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
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
});
