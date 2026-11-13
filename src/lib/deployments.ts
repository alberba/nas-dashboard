import { publicHost, type HostConfig } from "./hosts";
import { nasForHost } from "./nas";
import type { MaintenanceSnapshot } from "./maintenance";
import type { HostInfo, HostRole } from "./types";

/** Why the follower cannot deploy any release right now. */
export type DeploymentsBlockerCode =
  | "release-recovery-pending"
  | "security-recovery-pending"
  | "checkout-unavailable"
  | "dirty-checkout"
  | "missing-configuration";

export type DeploymentsFile = {
  status: string;
  path: string;
  /** Original path of a rename or copy. */
  from: string | null;
};

export type DeploymentsBlocker = {
  code: DeploymentsBlockerCode;
  release: string | null;
  /** Exact changed files of a dirty checkout, already bounded by the agent. */
  files: DeploymentsFile[];
  /** Release settings that must be filled before that release can deploy. */
  missingSettings: string[];
};

export type DeploymentsHistoryEntry = {
  release: string;
  outcome: "success" | "rolled-back";
  at: string | null;
  previousRelease: string | null;
  /** Services the follower recreated, as recorded in its transaction. */
  services: string[];
};

export type DeploymentsRetainedReason =
  | "release-recovery-pending"
  | "security-recovery-pending"
  | "checkout-unavailable"
  | "dirty-checkout"
  | "missing-manifest"
  | "invalid-manifest"
  | "missing-configuration"
  | "previously-failed"
  | "blocked-by-previous-release";

export type DeploymentsRetained = {
  release: string;
  reason: DeploymentsRetainedReason;
  /** Release whose blocker prevents this later candidate, when ordered. */
  blockedBy: string | null;
  breaking: boolean;
  manualSteps: string[];
  missingSettings: string[];
  /** Services the release is expected to recreate. */
  services: string[];
  sourceCommit: string | null;
  at: string | null;
};

export type DeploymentsJournalEntry = {
  at: string;
  unit: string;
  priority: number;
  level: "error" | "warning" | "info" | "debug";
  message: string;
};

export type DeploymentsSnapshot = {
  timestamp: number;
  role: HostRole;
  /** Whether the media-stack checkout can be read. */
  available: boolean;
  follower: MaintenanceSnapshot["follower"];
  blocker: DeploymentsBlocker | null;
  history: DeploymentsHistoryEntry[];
  retained: DeploymentsRetained[];
  journal: { entries: DeploymentsJournalEntry[] };
  /** Sections that could not be read; they keep their empty defaults. */
  degraded: string[];
};

export type DeploymentsResponse = {
  host: HostInfo;
  deployments: DeploymentsSnapshot;
};

/**
 * Reads the read-only deployments snapshot from one agent. It never retries.
 * `lines` is the bounded journal tail requested by the viewer.
 */
export async function deploymentsForHost(
  host: HostConfig,
  lines = 100,
): Promise<DeploymentsResponse> {
  const snapshot = await nasForHost<DeploymentsSnapshot>(
    host,
    `/deployments?lines=${lines}`,
  );
  return { host: publicHost(host), deployments: snapshot };
}
