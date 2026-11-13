import { describe, expect, it } from "vitest";
import {
  HostConfigError,
  HostNotFound,
  parseHosts,
  primaryHost,
  publicHost,
  resolveHost,
} from "../src/lib/hosts";

const nasToken = "a".repeat(32);
const appsToken = "b".repeat(32);
const hosts = [
  {
    id: "nas-home",
    name: "NAS-HOME",
    role: "instance",
    url: "http://192.168.1.10:9450",
    token: nasToken,
  },
  {
    id: "apps",
    name: "Apps",
    role: "apps-server",
    url: "http://hub-agent-apps:9450",
    token: appsToken,
  },
];

describe("host configuration", () => {
  it("reads every host from the server environment", () => {
    const parsed = parseHosts({ NAS_HOSTS: JSON.stringify(hosts) });
    expect(parsed.map((host) => [host.id, host.role])).toEqual([
      ["nas-home", "instance"],
      ["apps", "apps-server"],
    ]);
  });

  it("uses the instance host as the default regardless of list order", () => {
    const parsed = parseHosts({ NAS_HOSTS: JSON.stringify(hosts) });
    expect(primaryHost([...parsed].reverse()).id).toBe("nas-home");
    expect(resolveHost(parsed, undefined).id).toBe("nas-home");
    expect(resolveHost(parsed, "apps").id).toBe("apps");
  });

  it("keeps the legacy single-agent environment working", () => {
    const parsed = parseHosts({
      NAS_AGENT_URL: "http://100.64.0.1:9450",
      AGENT_TOKEN: nasToken,
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "nas-home",
      name: "NAS-HOME",
      role: "instance",
      url: "http://100.64.0.1:9450",
      token: nasToken,
    });
    expect(primaryHost(parsed).id).toBe("nas-home");
  });

  it("prefers the explicit host list when both configurations exist", () => {
    const parsed = parseHosts({
      NAS_HOSTS: JSON.stringify(hosts),
      NAS_AGENT_URL: "http://legacy.invalid:9450",
      AGENT_TOKEN: nasToken,
    });
    expect(parsed.map((host) => host.id)).toEqual(["nas-home", "apps"]);
  });

  it.each([
    ["duplicate identifiers", [hosts[0], { ...hosts[1], id: "nas-home" }]],
    [
      "no instance host",
      [{ ...hosts[0], role: "apps-server" }, hosts[1]],
    ],
    ["an invalid role", [{ ...hosts[0], role: "nas" }]],
    ["an invalid url", [{ ...hosts[0], url: "not-a-url" }]],
    ["a short token", [{ ...hosts[0], token: "short" }]],
    ["an unsafe identifier", [{ ...hosts[0], id: "../nas" }]],
  ])("rejects %s", (_name, value) => {
    expect(() => parseHosts({ NAS_HOSTS: JSON.stringify(value) })).toThrow(
      HostConfigError,
    );
  });

  it("rejects malformed and missing configuration", () => {
    expect(() => parseHosts({ NAS_HOSTS: "{" })).toThrow(HostConfigError);
    expect(() => parseHosts({})).toThrow(HostConfigError);
    expect(() =>
      parseHosts({ NAS_AGENT_URL: "http://100.64.0.1:9450" }),
    ).toThrow(HostConfigError);
  });

  it("never resolves an unknown host", () => {
    const parsed = parseHosts({ NAS_HOSTS: JSON.stringify(hosts) });
    expect(() => resolveHost(parsed, "unknown")).toThrow(HostNotFound);
  });

  it("publishes identity without credentials", () => {
    const parsed = parseHosts({ NAS_HOSTS: JSON.stringify(hosts) });
    expect(publicHost(parsed[1])).toEqual({
      id: "apps",
      name: "Apps",
      role: "apps-server",
    });
  });
});
