import type { Container } from "./types";

export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";
export type ContainerFilterId = "all" | "problems" | "stopped";

export function containerHealth(container: Container): ContainerHealth {
  if (container.state !== "running") return "none";
  if (/\(unhealthy\)/.test(container.status)) return "unhealthy";
  if (/\(health: starting\)/.test(container.status)) return "starting";
  if (/\(healthy\)/.test(container.status)) return "healthy";
  return "none";
}

export function needsAttention(container: Container, expected: string[]) {
  if (container.state === "running")
    return containerHealth(container) === "unhealthy";
  return (
    ["restarting", "dead"].includes(container.state) ||
    expected.includes(container.name)
  );
}

export function containerFilters(containers: Container[], expected: string[]) {
  const filters: { id: ContainerFilterId; test: (c: Container) => boolean }[] =
    [
      { id: "all", test: () => true },
      { id: "problems", test: (c) => needsAttention(c, expected) },
      { id: "stopped", test: (c) => c.state !== "running" },
    ];
  return filters.map(({ id, test }) => ({
    id,
    items: containers.filter(test),
  }));
}
