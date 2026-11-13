import { publicHost, type HostConfig } from "./hosts";
import { nasForHost } from "./nas";
import type { HostInfo, HostRole } from "./types";

export type MaintenanceFollowerState =
  | "idle"
  | "deploying"
  | "failed"
  | "unknown";

export type MaintenanceInstalledRelease = {
  release: string;
  commit: string | null;
  bootstrap: boolean;
  installedAt: string | null;
};

export type MaintenancePendingRelease = {
  release: string;
  status: string | null;
  previousRelease: string | null;
  changed: string[];
  since: string | null;
};

export type MaintenanceFailedRelease = {
  release: string;
  since: string | null;
};

export type MaintenancePin = {
  service: string;
  image: string;
  version: string | null;
  digest: string | null;
};

export type MaintenancePendingUpdate = {
  service: string;
  status: string | null;
  candidate: string | null;
  candidateRef: string | null;
  since: string | null;
};

export type MaintenanceReview = {
  names: string[];
  from: string | null;
  to: string | null;
  semver: string | null;
  cves: number;
  newSevere: number;
  verifiedAt: string | null;
  reason: string | null;
};

export type MaintenanceDiskKind = "sata" | "nvme" | "other";

export type MaintenanceDiskStatus = "ok" | "watch" | "fail" | "unknown";

export type MaintenanceDisk = {
  device: string;
  model: string | null;
  serial: string | null;
  kind: MaintenanceDiskKind;
  size: number | null;
  temperature: number | null;
  reallocatedSectors: number | null;
  wear: number | null;
  status: MaintenanceDiskStatus;
  /** Stable machine keys that explain a non-ok status, never user copy. */
  issues: string[];
};

export type MaintenanceDisks = {
  available: boolean;
  devices: MaintenanceDisk[];
};

export type MaintenanceUnitState =
  | "active"
  | "paused"
  | "inactive"
  | "failed";

export type MaintenanceUnit = {
  name: string;
  kind: "follower" | "security" | "backup" | "automation";
  service: string | null;
  timer: string | null;
  activeState: string | null;
  subState: string | null;
  unitFileState: string | null;
  result: string | null;
  state: MaintenanceUnitState;
  paused: boolean;
  lastRun: string | null;
  nextRun: string | null;
};

export type MaintenanceFailedUnit = {
  name: string;
  description: string | null;
};

export type MaintenanceDockerUsage = {
  available: boolean;
  images: { count: number; size: number; reclaimable: number };
  containers: { count: number; size: number };
  volumes: { count: number; size: number };
  buildCache: { count: number; size: number };
  total: number;
  reclaimable: number;
};

export type MaintenanceSnapshot = {
  /** Snapshot generation time, in seconds since the Unix epoch. */
  timestamp: number;
  role: HostRole;
  follower: {
    available: boolean;
    state: MaintenanceFollowerState;
    installed: MaintenanceInstalledRelease | null;
    pending: MaintenancePendingRelease | null;
    failed: MaintenanceFailedRelease | null;
  };
  security: {
    pins: MaintenancePin[];
    pending: MaintenancePendingUpdate | null;
    review: MaintenanceReview[];
  };
  backup: {
    status: "ok" | "failed" | "unknown";
    at: string | null;
  };
  disks: MaintenanceDisks;
  units: MaintenanceUnit[];
  failedUnits: {
    stack: MaintenanceFailedUnit[];
    other: MaintenanceFailedUnit[];
  };
  reboot: {
    available: boolean;
    required: boolean | null;
  };
  docker: MaintenanceDockerUsage;
  /** Sections that could not be read; they keep their empty defaults. */
  degraded: string[];
};

export type MaintenanceResponse = {
  host: HostInfo;
  snapshot: MaintenanceSnapshot;
};

/** Reads the cached maintenance snapshot from one agent. Never mutates the host. */
export async function maintenanceForHost(
  host: HostConfig,
): Promise<MaintenanceResponse> {
  const snapshot = await nasForHost<MaintenanceSnapshot>(host, "/maintenance");
  return { host: publicHost(host), snapshot };
}
