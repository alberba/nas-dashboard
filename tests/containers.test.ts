import { describe, expect, it } from "vitest";
import { containerFilters, containerHealth } from "../src/lib/containers";
import type { Container } from "../src/lib/types";

function container(overrides: Partial<Container>): Container {
  return {
    id: overrides.name ?? "id",
    name: "service",
    image: "image:1",
    state: "running",
    status: "Up 2 hours",
    protected: false,
    composeProject: "media-stack",
    composeService: overrides.name ?? "service",
    oneShot: false,
    exitCode: null,
    orphan: false,
    recreateOnCompose: false,
    cpu: 1,
    memory: 1,
    compose: null,
    ...overrides,
  };
}

const fleet = [
  container({ name: "jellyfin", status: "Up 2 hours (healthy)" }),
  container({ name: "bazarr", status: "Up 12 minutes (unhealthy)" }),
  container({ name: "radarr", status: "Up 3 seconds (health: starting)" }),
  container({
    name: "loop",
    state: "restarting",
    status: "Restarting (1) 5 seconds ago",
  }),
  container({ name: "wire", state: "exited", status: "Exited (0) 3 days ago" }),
  container({
    name: "sonarr",
    state: "exited",
    status: "Exited (137) 1 hour ago",
  }),
];

describe("container filters", () => {
  it("counts every container, the ones needing attention and the stopped ones", () => {
    const counts = Object.fromEntries(
      containerFilters(fleet, []).map((f) => [
        f.id,
        f.items.map((c) => c.name),
      ]),
    );
    expect(counts.all).toHaveLength(6);
    expect(counts.problems).toEqual(["bazarr", "loop"]);
    expect(counts.stopped).toEqual(["loop", "wire", "sonarr"]);
  });

  it("treats a stopped container the operator expects to run as a problem", () => {
    const problems = containerFilters(fleet, ["sonarr"]).find(
      (f) => f.id === "problems",
    )?.items;
    expect(problems?.map((c) => c.name)).toEqual(["bazarr", "loop", "sonarr"]);
  });
});

describe("container health", () => {
  it.each([
    ["Up 2 hours (healthy)", "running", "healthy"],
    ["Up 12 minutes (unhealthy)", "running", "unhealthy"],
    ["Up 3 seconds (health: starting)", "running", "starting"],
    ["Up 2 hours", "running", "none"],
    ["Exited (0) 3 days ago", "exited", "none"],
  ])("reads %s as %s", (status, state, health) => {
    expect(containerHealth(container({ status, state }))).toBe(health);
  });
});
