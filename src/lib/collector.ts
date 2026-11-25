import { and, asc, desc, eq, gt, inArray, isNull, like } from "drizzle-orm";
import { db } from "./db";
import { incidents, operations, samples } from "./schema";
import { nasForHost, NasInvalidResponse } from "./nas";
import { getSettings, saveSettings } from "./settings";
import { getHosts, type HostConfig } from "./hosts";
import {
  captureServiceInventory,
  HOST_UNREACHABLE_REASON,
  recordIncidentObservation,
  type IncidentDelivery,
  type IncidentObservationResult,
} from "./incident-store";
import {
  notificationPolicy,
  pushWarningsEnabled,
} from "./notification-policy";
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
): Promise<IncidentObservationResult | undefined> {
  if (!failing) {
    started.delete(scoped(host, key));
    return await recordIncidentObservation({
      hostId: host.id,
      key,
      failing: false,
      now,
      closedBy: "collector",
      ...(options.clearObservation ? { clearObservation: true } : {}),
    });
  }
  if (!started.has(scoped(host, key))) started.set(scoped(host, key), now);
  if (now - started.get(scoped(host, key))! < duration * 1000) return;
  return await recordIncidentObservation({
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
  const signals = [
    ...(maintenance.status === "fulfilled"
      ? maintenanceAlertSignals(maintenance.value, host.name)
      : []),
    ...(deployments.status === "fulfilled"
      ? deploymentAlertSignals(deployments.value, host.name)
      : []),
  ];
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
  if (marker !== null) return marker * 1000 >= group.at.getTime();
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
  now: number,
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
  const inhibitedKeys = new Set(
    open
      .filter((row) => row.inhibitedBy !== null)
      .map((row) => row.key),
  );

  for (const row of open) {
    if (row.inhibitedBy === null) continue;
    const group = groupById.get(row.inhibitedBy);
    if (!group || !connectionGroupIsFresh(metrics, group, now)) continue;
    const name = row.key.slice(CONTAINER_PREFIX.length);
    const container = metrics.containers.find((item) => item.name === name);
    // Absence is not evidence: keep the episode pending for 03-02.
    if (!container) continue;
    if (container.state === "running") {
      await condition(host, row.key, false, "", "", now, 0, "warning", {
        clearObservation: true,
      });
    } else {
      // Resume the same episode; its ID and delivery result are preserved.
      await condition(
        host,
        row.key,
        true,
        row.title,
        row.detail,
        now,
        0,
        row.severity,
        { clearObservation: true },
      );
    }
  }

  const [latestGroup] = await db
    .select()
    .from(incidents)
    .where(
      and(eq(incidents.hostId, host.id), eq(incidents.key, "connection")),
    )
    .orderBy(desc(incidents.at))
    .limit(1);
  if (latestGroup && !connectionGroupIsFresh(metrics, latestGroup, now)) return;

  for (const name of expected) {
    const key = CONTAINER_PREFIX + name;
    // A previous blocked episode is confirmed above; the normal 30-second
    // window only applies to names that were healthy before the outage.
    if (inhibitedKeys.has(key)) continue;
    await condition(
      host,
      key,
      !metrics.containers.some(
        (container) =>
          container.name === name && container.state === "running",
      ),
      `Servicio detenido en ${host.name}: ${name}`,
      "El servicio estaba previsto en ejecución y no está disponible.",
      now,
      30,
    );
  }
}

export async function collectHost(host: HostConfig, now = Date.now()) {
  const settings = await getSettings(host.id);
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
      return;
    }
    // A transport failure ends the container windows immediately, even before
    // the 60-second outage threshold is reached (D-03).
    forgetContainers(host);
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
  if (!settings.initialized) {
    settings.expectedContainers = metrics.containers
      .filter((container) => container.state === "running")
      .map((container) => container.name);
    settings.initialized = true;
    await saveSettings(host.id, settings);
  }
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
  await collectContainers(host, metrics, settings.expectedContainers, now);
  await collectSnapshotAlerts(host, now);
  const pending = await db
    .select()
    .from(operations)
    .where(
      and(eq(operations.hostId, host.id), eq(operations.status, "pending")),
    );
  for (const operation of pending) {
    if (
      operation.action === "reboot" &&
      operation.bootAt &&
      metrics.timestamp * 1000 - metrics.uptime * 1000 >
        operation.bootAt.getTime() + 5000
    ) {
      await db
        .update(operations)
        .set({
          status: "success",
          detail: "El host ha vuelto a responder después del reinicio.",
        })
        .where(eq(operations.id, operation.id));
    } else if (["start", "stop", "restart"].includes(operation.action)) {
      const container = metrics.containers.find(
        (item) => item.id === operation.target,
      );
      const expected =
        operation.action === "stop"
          ? container?.state !== "running"
          : container?.state === "running";
      if (container && expected && operation.action !== "restart") {
        await db
          .update(operations)
          .set({
            status: "success",
            detail: "Estado comprobado tras recuperar la conexión.",
          })
          .where(eq(operations.id, operation.id));
      }
    }
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
