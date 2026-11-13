import type {
  MaintenanceFailedUnit,
  MaintenanceSnapshot,
  MaintenanceUnit,
} from "./maintenance";

/** Tones of `StatusDot`; kept here so the module has no UI import. */
export type StatusTone =
  "gain" | "loss" | "peach" | "lilac" | "accent" | "muted";

const degraded = (snapshot: MaintenanceSnapshot, ...sections: string[]) =>
  sections.some((section) => snapshot.degraded.includes(section));

export type ReleaseCell = {
  state: "installed" | "absent";
  tone: StatusTone;
  release: string | null;
  installedAt: string | null;
  bootstrap: boolean;
};
export type FollowerCell = {
  state: "active" | "paused" | "inactive" | "failed" | "deploying" | "absent";
  tone: StatusTone;
  lastRun: string | null;
  nextRun: string | null;
  /** Release being installed or that last failed, when there is one. */
  pending: string | null;
  failed: string | null;
};
export type SecurityCell = {
  state: "ok" | "pending" | "review" | "absent";
  tone: StatusTone;
  pins: number;
  review: number;
  pendingService: string | null;
};
export type BackupCell = {
  state: "ok" | "failed" | "unknown" | "absent";
  tone: StatusTone;
  at: string | null;
};
export type RebootCell = {
  state: "none" | "required" | "unavailable";
  tone: StatusTone;
};
export type DockerCell = {
  state: "ok" | "unavailable";
  tone: StatusTone;
  size: number;
  reclaimable: number;
};

export type StatusCells = {
  release: ReleaseCell;
  follower: FollowerCell;
  security: SecurityCell;
  backup: BackupCell;
  reboot: RebootCell;
  docker: DockerCell;
};

/**
 * Reduces a snapshot to the six cells of the Estado strip. A section that the
 * agent could not read (`degraded`) or that the host lacks yields the
 * `absent`/`unavailable` state, never its empty default read as good news.
 */
export function statusCells(snapshot: MaintenanceSnapshot): StatusCells {
  const { follower } = snapshot;
  const followerReadable =
    follower.available && !degraded(snapshot, "follower");
  const installed = followerReadable ? follower.installed : null;
  const release: ReleaseCell = installed
    ? {
        state: "installed",
        tone: "gain",
        release: installed.release,
        installedAt: installed.installedAt,
        bootstrap: installed.bootstrap,
      }
    : {
        state: "absent",
        tone: "muted",
        release: null,
        installedAt: null,
        bootstrap: false,
      };

  const unit = degraded(snapshot, "units")
    ? undefined
    : snapshot.units.find((u) => u.kind === "follower");
  const base = {
    lastRun: unit?.lastRun ?? null,
    nextRun: unit?.nextRun ?? null,
    pending: followerReadable ? (follower.pending?.release ?? null) : null,
    failed: followerReadable ? (follower.failed?.release ?? null) : null,
  };
  let followerCell: FollowerCell;
  if (
    unit?.state === "failed" ||
    (followerReadable && follower.state === "failed")
  )
    followerCell = { ...base, state: "failed", tone: "loss" };
  else if (followerReadable && follower.state === "deploying")
    followerCell = { ...base, state: "deploying", tone: "accent" };
  else if (unit)
    followerCell = {
      ...base,
      state: unit.state,
      tone:
        unit.state === "active"
          ? "gain"
          : unit.state === "paused"
            ? "peach"
            : "muted",
    };
  else if (followerReadable && follower.state === "idle")
    followerCell = { ...base, state: "active", tone: "gain" };
  else followerCell = { ...base, state: "absent", tone: "muted" };

  const securityReadable = !degraded(snapshot, "security");
  const { pins, pending, review } = snapshot.security;
  const security: SecurityCell = !securityReadable
    ? {
        state: "absent",
        tone: "muted",
        pins: 0,
        review: 0,
        pendingService: null,
      }
    : {
        state: pending ? "pending" : review.length ? "review" : "ok",
        tone: pending ? "accent" : review.length ? "peach" : "gain",
        pins: pins.length,
        review: review.length,
        pendingService: pending?.service ?? null,
      };

  const { status, at } = snapshot.backup;
  const backup: BackupCell = degraded(snapshot, "backup")
    ? { state: "absent", tone: "muted", at: null }
    : {
        state: status,
        tone: { ok: "gain", failed: "loss", unknown: "muted" }[
          status
        ] as StatusTone,
        at,
      };

  const { reboot: rebootInfo } = snapshot;
  const reboot: RebootCell =
    !rebootInfo.available || degraded(snapshot, "reboot")
      ? { state: "unavailable", tone: "muted" }
      : rebootInfo.required
        ? { state: "required", tone: "lilac" }
        : { state: "none", tone: "gain" };

  const { docker: usage } = snapshot;
  const docker: DockerCell =
    !usage.available || degraded(snapshot, "docker")
      ? { state: "unavailable", tone: "muted", size: 0, reclaimable: 0 }
      : {
          state: "ok",
          tone: "gain",
          size: usage.images.size,
          reclaimable: usage.reclaimable,
        };

  return { release, follower: followerCell, security, backup, reboot, docker };
}

export type AutomationRows = {
  /** False when the units could not be read: show "no data", not "none". */
  available: boolean;
  items: MaintenanceUnit[];
};

export function automationRows(snapshot: MaintenanceSnapshot): AutomationRows {
  return degraded(snapshot, "units")
    ? { available: false, items: [] }
    : { available: true, items: snapshot.units };
}

export type FailedUnitGroups = {
  available: boolean;
  stack: MaintenanceFailedUnit[];
  other: MaintenanceFailedUnit[];
};

/** Stack units and foreign units stay in separate lists. */
export function failedUnitGroups(
  snapshot: MaintenanceSnapshot,
): FailedUnitGroups {
  return degraded(snapshot, "failedUnits")
    ? { available: false, stack: [], other: [] }
    : { available: true, ...snapshot.failedUnits };
}
