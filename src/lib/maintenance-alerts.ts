import type { DeploymentsSnapshot } from "./deployments";
import type { MaintenanceSnapshot } from "./maintenance";

export type AlertSeverity = "warning" | "critical";

/**
 * One switchable condition, already scoped by the caller to a host. A signal is
 * only emitted when the source section was readable: a missing or degraded
 * snapshot must leave the existing alert untouched to avoid churn.
 */
export type AlertSignal = {
  key: string;
  failing: boolean;
  title: string;
  detail: string;
  severity: AlertSeverity;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function names(values: string[], limit = 5) {
  const unique = [...new Set(values)];
  const shown = unique.slice(0, limit).join(", ");
  return unique.length > limit ? `${shown} (+${unique.length - limit})` : shown;
}

const stableRelease = /^v(\d+)\.(\d+)\.(\d+)$/;

/** True only when both are stable vX.Y.Z tags and `left` is strictly newer. */
function newerRelease(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const before = stableRelease.exec(left);
  const after = stableRelease.exec(right);
  if (!before || !after) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(before[index]) - Number(after[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Alerts derived from the read-only maintenance snapshot (#17/#18). */
export function maintenanceAlertSignals(
  snapshot: MaintenanceSnapshot | null | undefined,
  hostName: string,
): AlertSignal[] {
  if (!record(snapshot)) return [];
  const degraded = new Set(
    Array.isArray(snapshot.degraded)
      ? snapshot.degraded.filter((name): name is string => typeof name === "string")
      : [],
  );
  const signals: AlertSignal[] = [];

  const backup = snapshot.backup;
  if (
    !degraded.has("backup") &&
    record(backup) &&
    (backup.status === "ok" || backup.status === "failed")
  ) {
    const failed = backup.status === "failed";
    signals.push({
      key: "backup-failed",
      failing: failed,
      title: failed ? `Copia fallida en ${hostName}` : "Copia recuperada",
      detail: failed ? "La última copia registrada ha fallado." : "",
      severity: "critical",
    });
  }

  const disks = snapshot.disks;
  if (!degraded.has("disks") && record(disks) && disks.available === true) {
    const devices = Array.isArray(disks.devices) ? disks.devices : [];
    if (devices.length) {
      const unhealthy = devices.filter(
        (disk) => record(disk) && (disk.status === "watch" || disk.status === "fail"),
      );
      const failing = unhealthy.length > 0;
      const critical = unhealthy.some(
        (disk) => record(disk) && disk.status === "fail",
      );
      signals.push({
        key: "disk-health",
        failing,
        title: failing
          ? `Disco ${critical ? "con fallo" : "a vigilar"} en ${hostName}`
          : "Discos recuperados",
        detail: failing
          ? names(
              unhealthy.map(
                (disk) =>
                  `${text(record(disk) ? disk.device : null) ?? "disco"}: ${record(disk) ? String(disk.status) : "unknown"}`,
              ),
            )
          : "",
        severity: critical ? "critical" : "warning",
      });
    }
  }

  const reboot = snapshot.reboot;
  if (!degraded.has("reboot") && record(reboot) && reboot.available === true) {
    if (reboot.required === true || reboot.required === false) {
      const failing = reboot.required === true;
      signals.push({
        key: "reboot-pending",
        failing,
        title: failing
          ? `Reinicio pendiente en ${hostName}`
          : "Reinicio resuelto",
        detail: failing
          ? "El host pide un reinicio para completar una actualización."
          : "",
        severity: "warning",
      });
    }
  }

  const failedUnits = snapshot.failedUnits;
  if (
    !degraded.has("failedUnits") &&
    record(failedUnits) &&
    Array.isArray(failedUnits.stack)
  ) {
    // Only the stack list is an alert source. Foreign units never leak here.
    const stack = failedUnits.stack
      .map((unit) => (record(unit) ? text(unit.name) : null))
      .filter((name): name is string => Boolean(name));
    const failing = stack.length > 0;
    signals.push({
      key: "stack-unit-failed",
      failing,
      title: failing
        ? `Unidades del stack fallidas en ${hostName}`
        : "Unidades del stack recuperadas",
      detail: failing ? names(stack) : "",
      severity: "critical",
    });
  }

  return signals;
}

/**
 * Alerts derived from the deployments snapshot (#23). Follower failures are
 * resolved by a later successful deployment, never by the stale marker file
 * that media-stack keeps after a recovery.
 */
export function deploymentAlertSignals(
  snapshot: DeploymentsSnapshot | null | undefined,
  hostName: string,
): AlertSignal[] {
  if (!record(snapshot)) return [];
  const degraded = new Set(
    Array.isArray(snapshot.degraded)
      ? snapshot.degraded.filter((name): name is string => typeof name === "string")
      : [],
  );
  const signals: AlertSignal[] = [];
  const follower = snapshot.follower;

  const followerReadable =
    record(follower) &&
    follower.available !== false &&
    !degraded.has("follower");

  if (followerReadable && snapshot.available !== false && !degraded.has("checkout") && !degraded.has("git")) {
    const retained = Array.isArray(snapshot.retained)
      ? snapshot.retained.filter((entry) => record(entry) && text(entry.release))
      : [];
    const failing = retained.length > 0;
    signals.push({
      key: "release-retained",
      failing,
      title: failing
        ? `Release retenida en ${hostName}`
        : "Releases retenidas resueltas",
      detail: failing
        ? names(
            retained.map(
              (entry) =>
                `${text(record(entry) ? entry.release : null) ?? "?"} (${text(record(entry) ? entry.reason : null) ?? "retenida"})`,
            ),
          )
        : "",
      severity: "warning",
    });
  }

  if (followerReadable) {
    const history = Array.isArray(snapshot.history)
      ? snapshot.history.filter(record)
      : [];
    const latest = history[0];
    const marker = record(follower) && record(follower.failed) ? follower.failed : null;
    const installedRelease =
      record(follower) && record(follower.installed)
        ? text(follower.installed.release)
        : null;
    let failing = false;
    let release: string | null = null;
    if (latest && latest.outcome === "rolled-back") {
      failing = true;
      release = text(latest.release);
    } else if (marker) {
      const failedAt = text(marker.since) ? Date.parse(text(marker.since)!) : NaN;
      const recovered = history.some((entry) => {
        if (entry.outcome !== "success") return false;
        if (!Number.isFinite(failedAt)) return true;
        const at = text(entry.at) ? Date.parse(text(entry.at)!) : NaN;
        return Number.isFinite(at) && at >= failedAt;
      });
      failing = !recovered;
      release = text(marker.release);
    }
    // media-stack keeps failed-release.json after moving on. A strictly newer
    // installed release supersedes that attempt, even if history was pruned.
    if (release && newerRelease(installedRelease, release)) failing = false;
    signals.push({
      key: "deploy-failed",
      failing,
      title: failing
        ? `Despliegue fallido en ${hostName}`
        : "Despliegue recuperado",
      detail: failing && release ? `Release ${release}.` : "",
      severity: "critical",
    });
  }

  return signals;
}
