import type { Container } from "./types";

export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";
export type ContainerFilterId = "all" | "problems" | "stopped";

/**
 * Docker states without a live process. Paused containers still have a frozen
 * process, and transient states such as `restarting` or `removing` are still
 * in flight, so all of them stay visible in the main listing.
 */
const stoppedStates = ["created", "exited", "dead"];

export function isStoppedContainer(container: Pick<Container, "state">) {
  return stoppedStates.includes(container.state);
}

/** Splits the fleet into the main listing and the stopped section. */
export function containerSections(containers: Container[]) {
  const main: Container[] = [];
  const stopped: Container[] = [];
  for (const container of containers)
    (isStoppedContainer(container) ? stopped : main).push(container);
  return { main, stopped };
}

export function containerHealth(
  container: Pick<Container, "state" | "status">,
): ContainerHealth {
  if (container.state !== "running") return "none";
  if (/\(unhealthy\)/.test(container.status)) return "unhealthy";
  if (/\(health: starting\)/.test(container.status)) return "starting";
  if (/\(healthy\)/.test(container.status)) return "healthy";
  return "none";
}

export function needsAttention(container: Container, expected: string[]) {
  if (
    container.oneShot &&
    container.state !== "running" &&
    container.exitCode === 0
  )
    return false;
  if (
    container.oneShot &&
    container.state !== "running" &&
    (container.exitCode ?? 0) > 0
  )
    return true;
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
      { id: "stopped", test: isStoppedContainer },
    ];
  return filters.map(({ id, test }) => ({
    id,
    items: containers.filter(test),
  }));
}
