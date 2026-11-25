import { randomUUID } from "node:crypto";
import { CONNECTION_STALE_MS, type HostConfig } from "./hosts";
import {
  markContainerObservationPendingIn,
  recordIncidentObservationIn,
  transferContainerWatchIn,
  type Transaction,
} from "./incident-store";
import { mutateSettings } from "./settings";
import { sampleInterval } from "./validation";
import type {
  Container,
  ContainerIdentity,
  ContainerWatch,
  ContainerWatchEntry,
  ContainerWatchPending,
  Metrics,
  Settings,
} from "./types";

/** A name is retired after this much absence accredited by fresh inventories. */
export const WATCH_THRESHOLD_MS = 30 * 60_000;
/** Finite observation reason for an absent name inside its window (D-06). */
export const CONTAINER_ABSENT_REASON = "container-absent";
/**
 * An interval longer than the connection staleness bound cannot be evidence:
 * it covers every valid worker cadence (`sampleInterval`) and the gap that
 * already marks the host as disconnected. Longer gaps only break continuity.
 */
const MAX_WATCH_STEP_MS = Math.max(
  CONNECTION_STALE_MS,
  sampleInterval(false),
  sampleInterval(true),
);
/**
 * Identifies this worker process so a restart never accredits blind time.
 * It lives on the global object, not the module: re-importing the module in
 * one process must not look like a worker restart, while a real new process
 * gets a new identifier.
 */
const WORKER_GLOBAL = "__hubContainerWatchWorker";
const WORKER_ID: string =
  (globalThis as unknown as Record<string, string | undefined>)[WORKER_GLOBAL] ??
  ((globalThis as unknown as Record<string, string>)[WORKER_GLOBAL] =
    randomUUID());

const EMPTY_IDENTITY: ContainerIdentity = {
  containerId: null,
  composeProject: null,
  composeService: null,
};

export const containerPrefix = "container:";

export function emptyContainerWatch(): ContainerWatch {
  return {
    revision: 0,
    workerId: null,
    lastInventoryAt: null,
    chainAt: null,
    entries: {},
    identities: {},
  };
}

export function watchOf(settings: Settings): ContainerWatch {
  const watch = settings.watch;
  if (!watch) return emptyContainerWatch();
  return {
    revision: Number.isSafeInteger(watch.revision) ? watch.revision : 0,
    workerId: watch.workerId ?? null,
    lastInventoryAt: watch.lastInventoryAt ?? null,
    chainAt: watch.chainAt ?? null,
    entries: watch.entries ?? {},
    identities: watch.identities ?? {},
  };
}

/** Revision read before a Docker fetch; a concurrent intention change wins. */
export function watchRevision(settings: Settings): number {
  return settings.watch?.revision ?? 0;
}

/** Public projection for the selected host only, sorted by first absence. */
export function pendingWatch(settings: Settings): ContainerWatchPending[] {
  const watch = settings.watch;
  if (!watch?.entries) return [];
  return Object.entries(watch.entries)
    .filter(([name]) => settings.expectedContainers.includes(name))
    .map(([name, entry]) => ({
      name,
      state: "pending" as const,
      absentSince: entry.absentSince,
      accreditedMs: Math.max(0, entry.accreditedMs),
      thresholdMs: WATCH_THRESHOLD_MS,
    }))
    .sort(
      (a, b) => a.absentSince - b.absentSince || a.name.localeCompare(b.name),
    );
}

export function inventoryMark(metrics: Metrics): number | null {
  const value = metrics.containersObservedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function composeOf(container: Container) {
  const project = container.compose?.project ?? container.composeProject;
  const service = container.compose?.service ?? container.composeService;
  return project && service ? { project, service } : null;
}

export function identityOf(container: Container): ContainerIdentity {
  const compose = composeOf(container);
  return {
    containerId: container.id || null,
    composeProject: compose?.project ?? null,
    composeService: compose?.service ?? null,
  };
}

/**
 * A transport or contract failure ends the evidence chain. Time already
 * accredited survives; the next list can only start a new chain.
 */
export async function breakWatchContinuity(hostId: string): Promise<void> {
  await mutateSettings(hostId, (current) => {
    const watch = watchOf(current);
    if (watch.chainAt === null) return current;
    watch.chainAt = null;
    return { ...current, watch };
  });
}

type Candidate = Container | "ambiguous";

function findCandidate(
  identity: ContainerIdentity,
  fromName: string,
  expected: string[],
  containers: Container[],
): Candidate | null {
  const eligible = containers.filter(
    (container) => container.name !== fromName,
  );
  if (identity.containerId) {
    const byId = eligible.filter(
      (container) => container.id === identity.containerId,
    );
    if (byId.length > 1) return "ambiguous";
    if (byId.length === 1)
      return expected.includes(byId[0].name) ? "ambiguous" : byId[0];
  }
  if (identity.composeProject && identity.composeService) {
    const byCompose = eligible.filter((container) => {
      const compose = composeOf(container);
      return (
        compose?.project === identity.composeProject &&
        compose.service === identity.composeService
      );
    });
    if (byCompose.length > 1) return "ambiguous";
    if (byCompose.length === 1)
      return expected.includes(byCompose[0].name)
        ? "ambiguous"
        : byCompose[0];
  }
  return null;
}

type Transfer = { from: string; to: string; container: Container };

/**
 * Plans identity moves for one inventory. ID equality wins over the Compose
 * pair, a name already inside the expected list is never stolen and two
 * sources pointing at the same candidate are both left pending (D-07).
 */
function planTransfers(
  expected: string[],
  entries: Record<string, ContainerWatchEntry>,
  previousIdentities: Record<string, ContainerIdentity>,
  containers: Container[],
): Transfer[] {
  const present = new Map(containers.map((item) => [item.name, item]));
  const sources: { name: string; identity: ContainerIdentity }[] = [];
  for (const name of expected) {
    const container = present.get(name);
    if (!container) {
      const entry = entries[name];
      const identity = entry?.identity ?? previousIdentities[name];
      if (identity) sources.push({ name, identity });
      continue;
    }
    const identity = previousIdentities[name];
    if (!identity) continue;
    if (identity.containerId && identity.containerId !== container.id) {
      const elsewhere = containers.find(
        (item) => item.id === identity.containerId && item.name !== name,
      );
      if (elsewhere) sources.push({ name, identity });
      continue;
    }
    if (!identity.containerId && !composeOf(container)) continue;
    const currentCompose = composeOf(container);
    if (
      identity.composeProject &&
      identity.composeService &&
      (currentCompose?.project !== identity.composeProject ||
        currentCompose?.service !== identity.composeService)
    ) {
      const elsewhere = containers.find((item) => {
        const compose = composeOf(item);
        return (
          item.name !== name &&
          compose?.project === identity.composeProject &&
          compose?.service === identity.composeService
        );
      });
      if (elsewhere) sources.push({ name, identity });
    }
  }

  const claimed = new Map<string, string>();
  const plans: Transfer[] = [];
  for (const source of sources) {
    const candidate = findCandidate(
      source.identity,
      source.name,
      expected,
      containers,
    );
    if (!candidate || candidate === "ambiguous") continue;
    if (claimed.has(candidate.name)) {
      // Two watched names claiming the same replacement: neither moves.
      const competing = claimed.get(candidate.name)!;
      for (let index = plans.length - 1; index >= 0; index -= 1)
        if (plans[index].from === competing) plans.splice(index, 1);
      continue;
    }
    claimed.set(candidate.name, source.name);
    plans.push({
      from: source.name,
      to: candidate.name,
      container: candidate,
    });
  }
  return plans;
}

/**
 * Reconciles `expectedContainers` with one complete Docker list. Only a fresh
 * list never seen before can accredit absence; the wall clock is never used.
 * Inside one settings transaction it updates the durable window, expires the
 * names that reached the threshold, transfers proven identities and marks the
 * episodes that are still waiting. `revision` was read before the Docker call:
 * if an operator changed the intention meanwhile, the stale list is ignored.
 */
export async function reconcileContainers(input: {
  host: HostConfig;
  metrics: Metrics;
  now: number;
  revision: number;
}): Promise<void> {
  const mark = inventoryMark(input.metrics);
  // An older agent has no list date: presence is still evaluated, but absence
  // is never evidence and no watch state is written.
  if (mark === null) return;
  await mutateSettings(input.host.id, async (current, tx) => {
    const watch = watchOf(current);
    if (watch.revision !== input.revision) return current;
    if (watch.lastInventoryAt !== null && mark <= watch.lastInventoryAt)
      return current;

    const previous = watch.lastInventoryAt;
    const gapMs = previous === null ? null : (mark - previous) * 1000;
    const continuous =
      previous !== null &&
      watch.chainAt === previous &&
      watch.workerId === WORKER_ID &&
      gapMs !== null &&
      gapMs > 0 &&
      gapMs <= MAX_WATCH_STEP_MS;

    const containers = input.metrics.containers;
    const present = new Map(containers.map((item) => [item.name, item]));
    const previousIdentities = { ...watch.identities };
    const expected = [...current.expectedContainers];
    let changed = false;

    for (const name of expected) {
      if (present.has(name)) continue;
      const entry = watch.entries[name];
      if (entry) {
        const gained =
          continuous && entry.observedAt === previous
            ? Math.min(gapMs!, MAX_WATCH_STEP_MS)
            : 0;
        watch.entries[name] = {
          ...entry,
          identity: entry.identity ?? previousIdentities[name] ?? EMPTY_IDENTITY,
          observedAt: mark,
          accreditedMs: Math.max(0, entry.accreditedMs) + gained,
        };
      } else {
        watch.entries[name] = {
          identity: previousIdentities[name] ?? EMPTY_IDENTITY,
          absentSince: mark,
          observedAt: mark,
          accreditedMs: 0,
        };
      }
    }

    for (const [name, entry] of Object.entries(watch.entries)) {
      if (!expected.includes(name) || entry.accreditedMs < WATCH_THRESHOLD_MS)
        continue;
      expected.splice(expected.indexOf(name), 1);
      delete watch.entries[name];
      delete watch.identities[name];
      changed = true;
      await recordIncidentObservationIn(tx, {
        hostId: input.host.id,
        key: containerPrefix + name,
        failing: false,
        now: input.now,
        closedBy: "reconciliation",
      });
    }

    for (const transfer of planTransfers(
      expected,
      watch.entries,
      previousIdentities,
      containers,
    )) {
      const index = expected.indexOf(transfer.from);
      if (index < 0 || expected.includes(transfer.to)) continue;
      expected[index] = transfer.to;
      delete watch.entries[transfer.from];
      delete watch.entries[transfer.to];
      delete watch.identities[transfer.from];
      watch.identities[transfer.to] = identityOf(transfer.container);
      changed = true;
      await transferContainerWatchIn(tx, {
        hostId: input.host.id,
        fromName: transfer.from,
        toName: transfer.to,
        title: `Servicio detenido en ${input.host.name}: ${transfer.to}`,
        now: input.now,
        running: transfer.container.state === "running",
        mergeDestination: true,
      });
    }

    for (const name of expected) {
      const container = present.get(name);
      if (!container) continue;
      watch.identities[name] = identityOf(container);
      delete watch.entries[name];
    }

    for (const [name] of Object.entries(watch.entries))
      if (expected.includes(name))
        await markContainerObservationPendingIn(tx, {
          hostId: input.host.id,
          key: containerPrefix + name,
          reason: CONTAINER_ABSENT_REASON,
          now: input.now,
        });

    if (changed) watch.revision += 1;
    watch.lastInventoryAt = mark;
    watch.chainAt = mark;
    watch.workerId = WORKER_ID;
    return { ...current, expectedContainers: expected, watch };
  });
}

/** Exposed for tests that simulate a worker restart without reloading DB. */
export function currentWatchWorkerId() {
  return WORKER_ID;
}

export type { Transaction };
