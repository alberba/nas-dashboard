import { and, asc, desc, eq, gt, inArray, isNull, like } from "drizzle-orm";
import { db } from "./db";
import { incidents, operations, samples } from "./schema";
import { nasForHost, NasInvalidResponse } from "./nas";
import { getSettings, mutateSettings, type SettingsTransaction } from "./settings";
import {
  breakWatchContinuity,
  pendingWatch,
  reconcileContainers,
  watchOf,
  watchRevision,
} from "./container-watch";
import { getHosts, type HostConfig } from "./hosts";
import {
  captureServiceInventory,
  HOST_UNREACHABLE_REASON,
  recordIncidentObservation,
  recordIncidentObservationIn,
  type IncidentObservation,
  type IncidentDelivery,
  type IncidentObservationResult,
} from "./incident-store";
import {
  notificationPolicy,
  pushWarningsEnabled,
} from "./notification-policy";
import {
  finalizeContainerOperation,
  removalTarget,
  type ContainerOperationAction,
} from "./lifecycle";
import {
  deploymentAlertSignals,
  maintenanceAlertSignals,
} from "./maintenance-alerts";
import type { DeploymentsSnapshot } from "./deployments";
import type { MaintenanceSnapshot } from "./maintenance";
import type { IncidentInventoryContext, Metrics } from "./types";

const started = new Map<string, number>();
/** Snapshot-backed alerts are refreshed at most once a minute per host. */
const ALERT_SNAPSHOT_INTERVAL_MS = 60_000;
const alertSnapshotAt = new Map<string, number>();
/** Last accredited cleanup check per host: an older answer cannot replace it. */
const helperCleanupAt = new Map<string, number>();
/** Docker list cadence in the agent; used for agents without a list mark. */
const CONTAINER_CACHE_INTERVAL_MS = 10_000;
const CONTAINER_PREFIX = "container:";
/** Last Docker list mark already evaluated, per host (Unix seconds). */
const lastInventorySeen = new Map<string, number>();

function scoped(host: HostConfig, key: string) {
  return `${host.id}:${key}`;
}

/** Drops one sustained timer without touching an already-open episode. */
function forget(host: HostConfig, key: string) {
  started.delete(scoped(host, key));
}

/** A snapshot with no usable evidence cannot extend any sustained window. */
function forgetHost(host: HostConfig) {
  const prefix = `${host.id}:`;
  for (const key of started.keys()) {
    if (key.startsWith(prefix)) started.delete(key);
  }
}

/**
 * A transport failure ends every container window: the previous samples and
 * the time the host was down are not contiguous evidence (D-03).
 */
function forgetContainers(host: HostConfig) {
  const prefix = `${host.id}:${CONTAINER_PREFIX}`;
  for (const key of started.keys()) {
    if (key.startsWith(prefix)) started.delete(key);
  }
}

/**
 * A list evaluated before the outage is not a candidate for fresh evidence
 * after recovery. Dropping the mark forces the next Docker read to prove
 * itself against the outage date instead of the pre-outage cache.
 */
function forgetInventoryMark(host: HostConfig) {
  lastInventorySeen.delete(host.id);
}

/**
 * Audited disposition for the collection path. Severity alone is not enough:
 * `disk-health` escalates from digest to immediate and `container:<name>` is
 * silent at every severity.
 */
function deliveryFor(key: string, severity: string): IncidentDelivery {
  const decision = notificationPolicy(
    key,
    severity === "critical" ? "critical" : "warning",
    { pushWarnings: pushWarningsEnabled() },
  );
  return { channel: decision.channel, reason: decision.reason };
}

type ConditionOptions = {
  /** Captured only when the sustained window actually records the episode. */
  context?: () => Promise<IncidentInventoryContext | null>;
  /** Blocks the open container episodes in the same store transaction. */
  inhibitContainers?: { reason: string };
  /** Removes a container observation block after valid evidence. */
  clearObservation?: boolean;
  /** Evidence time of a recovery; keeps a stale snapshot from closing an ingest episode. */
  evidenceAt?: number;
};

async function condition(
  host: HostConfig,
  key: string,
  failing: boolean,
  title: string,
  detail: string,
  now: number,
  duration = 0,
  severity = "warning",
  options: ConditionOptions = {},
  tx?: SettingsTransaction,
): Promise<IncidentObservationResult | undefined> {
  const record = (input: IncidentObservation) =>
    tx ? recordIncidentObservationIn(tx, input) : recordIncidentObservation(input);
  if (!failing) {
    started.delete(scoped(host, key));
    return await record({
      hostId: host.id,
      key,
      failing: false,
      now,
      closedBy: "collector",
      ...(options.clearObservation ? { clearObservation: true } : {}),
      ...(options.evidenceAt !== undefined
        ? { evidenceAt: options.evidenceAt }
        : {}),
    });
  }
  if (!started.has(scoped(host, key))) started.set(scoped(host, key), now);
  if (now - started.get(scoped(host, key))! < duration * 1000) return;
  return await record({
    hostId: host.id,
    key,
    failing: true,
    severity,
    title,
    detail,
    now,
    delivery: deliveryFor(key, severity),
    closedBy: "collector",
    ...(options.context ? { context: await options.context() } : {}),
    ...(options.inhibitContainers
      ? { inhibitContainers: options.inhibitContainers }
      : {}),
    ...(options.clearObservation ? { clearObservation: true } : {}),
  });
}

/**
 * Extends the existing thresholds with the new maintenance conditions. Both
 * snapshots are read-only and cached by the agent; the hub does not retry and
 * a failed or degraded read leaves open alerts exactly as they were.
 */
async function collectSnapshotAlerts(host: HostConfig, now: number) {
  const previous = alertSnapshotAt.get(host.id);
  if (previous !== undefined && now - previous < ALERT_SNAPSHOT_INTERVAL_MS)
    return;
  alertSnapshotAt.set(host.id, now);
  const [maintenance, deployments] = await Promise.allSettled([
    nasForHost<MaintenanceSnapshot>(host, "/maintenance"),
    nasForHost<DeploymentsSnapshot>(host, "/deployments?lines=1"),
  ]);
  const previousCleanupAt = helperCleanupAt.get(host.id);
  const signals = [
    ...(maintenance.status === "fulfilled"
      ? maintenanceAlertSignals(maintenance.value, host.name, {
          helperCleanupAfter: previousCleanupAt,
        })
      : []),
    ...(deployments.status === "fulfilled"
      ? deploymentAlertSignals(deployments.value, host.name)
      : []),
  ];
  if (maintenance.status === "fulfilled") {
    const checkedAt = maintenance.value.helperCleanup?.checkedAt;
    const checked = checkedAt ? Date.parse(checkedAt) : NaN;
    if (
      Number.isFinite(checked) &&
      (previousCleanupAt === undefined || checked > previousCleanupAt)
    )
      helperCleanupAt.set(host.id, checked);
  }
  for (const signal of signals) {
    await condition(
      host,
      signal.key,
      signal.failing,
      signal.title,
      signal.detail,
      now,
      0,
      signal.severity,
      signal.evidenceAt !== undefined ? { evidenceAt: signal.evidenceAt } : {},
    );
  }
}

function inventoryMarker(metrics: Metrics): number | null {
  const value = metrics.containersObservedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * A Docker list is post-outage when it was captured after the outage was
 * confirmed. Older agents have no list mark: they must wait one cache
 * interval after the confirmed recovery before their list counts as evidence.
 */
function connectionGroupIsFresh(
  metrics: Metrics,
  group: typeof incidents.$inferSelect,
  now: number,
) {
  const marker = inventoryMarker(metrics);
  if (marker !== null) return marker * 1000 > group.at.getTime();
  return (
    group.resolvedAt !== null &&
    now >= group.resolvedAt.getTime() + CONTAINER_CACHE_INTERVAL_MS
  );
}

/**
 * Reconciles the Docker inventory with the open container episodes. A group
 * that just recovered releases each previous episode only after fresh
 * evidence: running closes it, stopped resumes the same episode and absence
 * keeps it pending for the inventory reconciliation of the next plan. A new
 * failure still needs its own 30-second window; repeated copies of one Docker
 * reading never count as new evidence.
 */
async function collectContainers(
  host: HostConfig,
  metrics: Metrics,
  expected: string[],
  pending: Set<string>,
  now: number,
  revision: number,
  latestGroup: typeof incidents.$inferSelect | undefined,
) {
  const marker = inventoryMarker(metrics);
  if (marker !== null) {
    const seen = lastInventorySeen.get(host.id);
    if (seen !== undefined && marker <= seen) return;
    lastInventorySeen.set(host.id, marker);
  }

  const open = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.hostId, host.id),
        like(incidents.key, `${CONTAINER_PREFIX}%`),
        isNull(incidents.resolvedAt),
      ),
    )
    .orderBy(asc(incidents.id));
  const groupIds = [
    ...new Set(
      open
        .map((row) => row.inhibitedBy)
        .filter((id): id is number => id !== null),
    ),
  ];
  const groups = groupIds.length
    ? await db
        .select()
        .from(incidents)
        .where(inArray(incidents.id, groupIds))
    : [];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const openByKey = new Map(open.map((row) => [row.key, row]));
  const inhibitedKeys = new Set(
    open
      .filter((row) => row.inhibitedBy !== null)
      .map((row) => row.key),
  );

  await mutateSettings(host.id, async (current, tx) => {
    if (watchRevision(current) !== revision) {
      forgetContainers(host);
      return current;
    }
    const watched = new Set(current.expectedContainers);
    async function observe(
      name: string,
      failing: boolean,
      title: string,
      detail: string,
      duration: number,
      severity: string,
      options: ConditionOptions,
    ) {
      if (!watched.has(name)) return;
      await condition(
        host, CONTAINER_PREFIX + name, failing, title, detail,
        now, duration, severity, options, tx,
      );
    }

    for (const row of open) {
      if (row.inhibitedBy === null) continue;
      // Older retention runs could delete the original group. If so, use
      // the latest outage as the freshness bound when one is still present.
      const group = groupById.get(row.inhibitedBy) ?? latestGroup;
      if (group && !connectionGroupIsFresh(metrics, group, now)) continue;
      const name = row.key.slice(CONTAINER_PREFIX.length);
      const container = metrics.containers.find((item) => item.name === name);
      // Absence keeps the episode pending; the watch reconciliation owns it.
      if (!container) continue;
      if (container.state === "running") {
        await observe(name, false, "", "", 0, "warning", {
          clearObservation: true,
        });
      } else {
        // Resume the same episode; its ID and delivery result are preserved.
        await observe(
          name,
          true,
          row.title,
          row.detail,
          0,
          row.severity,
          { clearObservation: true },
        );
      }
    }

    for (const name of expected) {
      const key = CONTAINER_PREFIX + name;
      // A previous blocked episode is confirmed above; the normal 30-second
      // window only applies to names that were healthy before the outage.
      if (inhibitedKeys.has(key)) continue;
      // An absent name ends any partial failure window: a later reappearance
      // must accredit its own 30 seconds instead of inheriting old evidence.
      if (pending.has(name)) {
        forget(host, key);
        continue;
      }
      const container = metrics.containers.find((item) => item.name === name);
      // A name missing from the list never opens an episode (D-06): absence is
      // only evidence for the durable watch window. A present but stopped
      // container keeps the existing 30-second failure threshold (D-05), but an
      // episode that was already open resumes on this first valid reading (D-04).
      if (!container) {
        forget(host, key);
        continue;
      }
      const existing = openByKey.get(key);
      await observe(
        name,
        container.state !== "running",
        `Servicio detenido en ${host.name}: ${name}`,
        "El servicio estaba previsto en ejecución y no está disponible.",
        existing ? 0 : 30,
        "warning",
        existing ? { clearObservation: true } : {},
      );
    }
    return current;
  });
}

export async function collectHost(host: HostConfig, now = Date.now()) {
  const settingsBefore = await getSettings(host.id);
  // Read the intention before the Docker call: a stop, removal or threshold
  // edit that lands meanwhile wins over this stale reading (T-03-05).
  const revision = watchRevision(settingsBefore);
  let metrics: Metrics;
  try {
    metrics = await nasForHost<Metrics>(host, "/metrics");
  } catch (error) {
    // A malformed successful response is a contract failure, not a
    // disconnection: it must not write a sample, open `connection` or touch
    // any episode. It also breaks every sustained window: non-contiguous
    // evidence must never satisfy a duration threshold.
    if (error instanceof NasInvalidResponse) {
      forgetHost(host);
      await breakWatchContinuity(host.id).catch(() => {});
      return;
    }
    // A transport failure ends the container windows immediately, even before
    // the 60-second outage threshold is reached (D-03).
    forgetContainers(host);
    forgetInventoryMark(host);
    await breakWatchContinuity(host.id).catch(() => {});
    const [planned] = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.hostId, host.id),
          eq(operations.action, "reboot"),
          eq(operations.status, "pending"),
          gt(operations.at, new Date(now - 300000)),
        ),
      )
      .limit(1);
    if (planned) {
      started.delete(scoped(host, "connection"));
      return;
    }
    await condition(
      host,
      "connection",
      true,
      `${host.name} no responde`,
      "No se reciben métricas. Revisa la conexión y el estado del host.",
      now,
      60,
      "critical",
      {
        context: () => captureServiceInventory(host.id, new Date(now)),
        inhibitContainers: { reason: HOST_UNREACHABLE_REASON },
      },
    );
    return;
  }
  await condition(
    host,
    "connection",
    false,
    `${host.name} vuelve a responder`,
    "",
    now,
  );
  await db
    .insert(samples)
    .values({
      hostId: host.id,
      at: new Date(metrics.timestamp * 1000),
      data: metrics,
    });
  if (!settingsBefore.initialized)
    await mutateSettings(host.id, (current) => {
      if (current.initialized) return current;
      const watch = watchOf(current);
      watch.revision += 1;
      return {
        ...current,
        expectedContainers: metrics.containers
          .filter((container) => container.state === "running")
          .map((container) => container.name),
        initialized: true,
        watch,
      };
    });
  // Only a fresh, complete list can accredit absence or move a watch. The
  // revision captured before the fetch prevents a stale list overwriting the
  // operator's most recent intention.
  const [latestGroup] = await db
    .select()
    .from(incidents)
    .where(
      and(eq(incidents.hostId, host.id), eq(incidents.key, "connection")),
    )
    .orderBy(desc(incidents.at))
    .limit(1);
  const inventoryRevision =
    latestGroup && !connectionGroupIsFresh(metrics, latestGroup, now)
      ? null
      : await reconcileContainers({ host, metrics, now, revision });
  const settings = await getSettings(host.id);
  // A null CPU measurement or an empty temperature list is absence of
  // evidence, not a recovery. Leave those episodes exactly as they were.
  if (metrics.cpu !== null) {
    await condition(
      host,
      "cpu",
      metrics.cpu >= settings.cpu,
      `CPU elevada en ${host.name}`,
      `Uso sostenido superior al ${settings.cpu} %.`,
      now,
      settings.sustainedSeconds,
    );
  } else {
    forget(host, "cpu");
  }
  const memory = (metrics.memory.used / metrics.memory.total) * 100;
  await condition(
    host,
    "memory",
    memory >= settings.memory,
    `Memoria elevada en ${host.name}`,
    `Uso sostenido superior al ${settings.memory} %.`,
    now,
    settings.sustainedSeconds,
  );
  if (metrics.disks.length > 0) {
    await condition(
      host,
      "disk",
      metrics.disks.some(
        (disk) => (disk.used / disk.total) * 100 >= settings.disk,
      ),
      `Queda poco espacio en ${host.name}`,
      `Algún volumen supera el ${settings.disk} % de ocupación.`,
      now,
    );
  } else {
    forget(host, "disk");
  }
  if (metrics.temperatures.length > 0) {
    await condition(
      host,
      "temperature",
      metrics.temperatures.some(
        (temperature) => temperature.value >= settings.temperature,
      ),
      `Temperatura elevada en ${host.name}`,
      `Algún sensor supera ${settings.temperature} °C.`,
      now,
      30,
      "critical",
    );
  } else {
    forget(host, "temperature");
  }
  const pendingNames = new Set(
    pendingWatch(settings).map((pending) => pending.name),
  );
  if (inventoryRevision !== null)
    await collectContainers(
      host,
      metrics,
      settings.expectedContainers,
      pendingNames,
      now,
      inventoryRevision,
      latestGroup,
    );
  await collectSnapshotAlerts(host, now);
  const pending = await db
    .select()
    .from(operations)
    .where(
      and(eq(operations.hostId, host.id), eq(operations.status, "pending")),
    );
  const marker = inventoryMarker(metrics);
  const watch = watchOf(settings);
  for (const operation of pending) {
    if (operation.action === "reboot") {
      if (
        operation.bootAt &&
        metrics.timestamp * 1000 - metrics.uptime * 1000 >
          operation.bootAt.getTime() + 5000
      )
        await db
          .update(operations)
          .set({
            status: "success",
            detail: "El host ha vuelto a responder después del reinicio.",
          })
          .where(eq(operations.id, operation.id));
      continue;
    }
    if (
      !["start", "stop", "remove-container"].includes(
        operation.action,
      )
    )
      continue;
    // The inventory has no execution generation for restarts. Only a
    // confirmed agent response can settle them.
    const operationAt = operation.at.getTime();
    const afterCache = operationAt + CONTAINER_CACHE_INTERVAL_MS;
    const fresh = marker !== null
      ? marker * 1000 > operationAt
      : (operation.action === "start" || operation.action === "stop") &&
        now > afterCache &&
        metrics.timestamp * 1000 > afterCache;
    if (!fresh) continue;
    const removing = operation.action === "remove-container";
    const target = removing ? removalTarget(operation.target) : null;
    const knownId = target
      ? target.id ?? watch.identities[target.name]?.containerId
      : operation.target;
    const container = metrics.containers.find((item) =>
      item.id === (knownId ?? operation.target) ||
      Boolean(target && !target.id && item.name === target.name),
    );
    const confirmed = removing
      ? !container
      : operation.action === "stop"
        ? Boolean(container && container.state !== "running")
        : container?.state === "running";
    if (!confirmed) continue;
    const name = container?.name ?? target?.name;
    if (!name) continue;
    await finalizeContainerOperation({
      hostId: host.id,
      hostName: host.name,
      operationId: operation.id,
      action: operation.action as ContainerOperationAction,
      name,
      containerId: knownId,
      container: container ?? null,
      detail:
        operation.action === "remove-container"
          ? "El inventario posterior confirma que el contenedor ya no existe."
          : "Estado comprobado en el inventario posterior.",
      now,
    });
  }
}

/** Collects every configured host independently; one failure never hides the rest. */
export async function collectAll(
  hosts: HostConfig[] = getHosts(),
  now = Date.now(),
) {
  await Promise.all(
    hosts.map(async (host) => {
      try {
        await collectHost(host, now);
      } catch {
        console.error(`Error de recogida en ${host.id}`);
      }
    }),
  );
}
