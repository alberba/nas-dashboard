import { z } from "zod";

/**
 * Runtime contracts for the read-only GET snapshots produced by the Python
 * agent. The hub used to trust `data as T`; these schemas decode the
 * producer's shape before the Effect/Promise boundary, so a malformed HTTP 200
 * is a contract failure instead of an empty, healthy observation.
 *
 * Validation is structural only. A `null` measurement, a missing optional
 * section or a degraded section stays absent for the evaluator to interpret;
 * nothing here coerces a defect into health.
 */

const finite = z.number().finite();
const nonNegative = finite.min(0);
const positive = finite.positive();
const nullableFinite = finite.nullable();
const nullableNonNegative = nonNegative.nullable();
const nullableText = z.string().nullable();
const role = z.enum(["instance", "apps-server"]);
const degraded = z.array(z.string());
const epoch = finite.positive();

const cpuBreakdown = z.looseObject({
  user: nonNegative,
  system: nonNegative,
  iowait: nonNegative,
  steal: nonNegative,
  idle: nonNegative,
  irq: nonNegative,
  softirq: nonNegative,
  nice: nonNegative,
});

const systemDetails = z.looseObject({
  hostname: nullableText,
  cpuModel: nullableText,
  cores: z.number().int().nullable(),
  threads: z.number().int().nullable(),
  sockets: z.number().int().nullable(),
  arch: nullableText,
  kernel: nullableText,
  osName: nullableText,
  memoryTotal: nonNegative,
});

const networkInterface = z.looseObject({
  name: z.string(),
  rx: nullableFinite,
  tx: nullableFinite,
  rxTotal: nonNegative,
  txTotal: nonNegative,
});

const ioDeviceLatency = z.looseObject({
  name: z.string(),
  readMs: nullableFinite,
  writeMs: nullableFinite,
  utilization: nullableFinite,
  weightedMs: nullableFinite,
});

const ioLatency = z.looseObject({
  readMs: nullableFinite,
  writeMs: nullableFinite,
  utilization: nullableFinite,
  weightedMs: nullableFinite,
  devices: z.array(ioDeviceLatency),
});

const disk = z.looseObject({
  name: z.string(),
  root: z.string(),
  // The collector divides used/total: a zero denominator is invalid data.
  total: positive,
  used: nonNegative,
  free: nonNegative,
});

const filesystem = z.looseObject({
  name: z.string(),
  total: positive,
  used: nonNegative,
  free: nonNegative,
});

const raidArray = z.looseObject({
  name: z.string(),
  level: nullableText,
  state: nullableText,
  disks: z.number().int().nullable(),
  capacity: nullableNonNegative,
  degraded: z.number().int().nullable(),
  syncAction: nullableText,
  syncCompleted: nullableText,
  syncSpeed: nullableText,
});

const temperature = z.looseObject({
  name: z.string(),
  value: finite,
});

const containerCompose = z.looseObject({
  project: z.string(),
  service: z.string(),
});

const containerNetwork = z.looseObject({
  rx: nullableFinite,
  tx: nullableFinite,
});

const container = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  image: z.string(),
  state: z.string().min(1),
  status: z.string(),
  protected: z.boolean(),
  composeProject: nullableText,
  composeService: nullableText,
  oneShot: z.boolean(),
  exitCode: z.number().int().nullable(),
  orphan: z.boolean(),
  recreateOnCompose: z.boolean(),
  cpu: nullableFinite,
  memory: nullableFinite,
  network: containerNetwork.nullable().optional(),
  compose: containerCompose.nullable(),
  healthObservedSince: nullableFinite.optional(),
});

/** `GET /metrics`: native host metrics plus the Docker container inventory. */
export const metricsSnapshotSchema = z.looseObject({
  timestamp: epoch,
  /** Docker list date; absent on agents that predate the field. */
  containersObservedAt: epoch.optional(),
  hostname: z.string(),
  system: systemDetails.nullable().optional(),
  cpu: nullableFinite,
  cpuCores: z.array(nullableFinite).nullable().optional(),
  cpuBreakdown: cpuBreakdown.nullable().optional(),
  load: z.tuple([finite, finite, finite]).nullable().optional(),
  memory: z.looseObject({
    total: positive,
    used: nonNegative,
    cache: nonNegative.optional(),
    swap: z
      .looseObject({ total: nonNegative, used: nonNegative })
      .optional(),
  }),
  network: z.looseObject({
    rx: nullableFinite,
    tx: nullableFinite,
    interfaces: z.array(networkInterface).optional(),
  }),
  io: z.looseObject({
    read: nullableFinite,
    write: nullableFinite,
    latency: ioLatency.nullable().optional(),
  }),
  uptime: nonNegative,
  disks: z.array(disk),
  filesystems: z.array(filesystem).optional(),
  raid: z.array(raidArray).optional(),
  temperatures: z.array(temperature),
  containers: z.array(container),
});

const followerState = z.enum(["idle", "deploying", "failed", "unknown"]);

const installedRelease = z.looseObject({
  release: z.string().min(1),
  commit: nullableText,
  bootstrap: z.boolean(),
  installedAt: nullableText,
});

const pendingRelease = z.looseObject({
  release: z.string().min(1),
  status: nullableText,
  previousRelease: nullableText,
  changed: z.array(z.string()),
  since: nullableText,
});

const failedRelease = z.looseObject({
  release: z.string().min(1),
  since: nullableText,
});

const follower = z.looseObject({
  available: z.boolean(),
  state: followerState,
  installed: installedRelease.nullable(),
  pending: pendingRelease.nullable(),
  failed: failedRelease.nullable(),
});

const maintenancePin = z.looseObject({
  service: z.string(),
  image: z.string(),
  version: nullableText,
  digest: nullableText,
});

const maintenancePendingUpdate = z.looseObject({
  service: z.string(),
  status: nullableText,
  candidate: nullableText,
  candidateRef: nullableText,
  since: nullableText,
});

const maintenanceReview = z.looseObject({
  names: z.array(z.string()),
  from: nullableText,
  to: nullableText,
  semver: nullableText,
  cves: z.number().int().nonnegative(),
  newSevere: z.number().int().nonnegative(),
  verifiedAt: nullableText,
  reason: nullableText,
});

const maintenanceDisk = z.looseObject({
  device: z.string(),
  model: nullableText,
  serial: nullableText,
  kind: z.enum(["sata", "nvme", "other"]),
  size: nullableNonNegative,
  temperature: nullableFinite,
  reallocatedSectors: z.number().int().nullable(),
  wear: z.number().int().nullable(),
  status: z.enum(["ok", "watch", "fail", "unknown"]),
  issues: z.array(z.string()),
});

const helperCleanupStatus = z.enum([
  "clean",
  "failing",
  "persistent",
  "indeterminate",
]);

const helperCleanup = z
  .looseObject({
    available: z.boolean(),
    status: helperCleanupStatus,
    checkedAt: nullableText,
    pending: z.number().int().nonnegative(),
    persistent: z.number().int().nonnegative(),
  })
  .superRefine((value, ctx) => {
    // Counts are independent: two different helpers with one failure each do
    // not make either of them persistent.
    if (value.persistent > value.pending)
      ctx.addIssue({
        code: "custom",
        message: "persistent cannot exceed pending",
      });
    if (value.status === "clean") {
      if (value.pending !== 0 || value.persistent !== 0)
        ctx.addIssue({
          code: "custom",
          message: "clean requires no pending helpers",
        });
      if (!value.checkedAt)
        ctx.addIssue({
          code: "custom",
          message: "clean requires a positive check date",
        });
    }
    if (value.status === "failing" && value.pending < 1)
      ctx.addIssue({
        code: "custom",
        message: "failing requires a pending helper",
      });
    if (value.status === "persistent" && value.persistent < 1)
      ctx.addIssue({
        code: "custom",
        message: "persistent requires a persistent helper",
      });
    if (value.status !== "indeterminate" && !value.checkedAt)
      ctx.addIssue({
        code: "custom",
        message: "a proven state requires a check date",
      });
  });

const maintenanceContainer = z.looseObject({
  id: z.string(),
  name: z.string(),
  image: nullableText,
  version: nullableText,
  tag: nullableText,
  url: nullableText,
  canUpdate: z.boolean(),
  updateAvailable: z.boolean().nullable(),
  checkedAt: nullableNonNegative,
});

const maintenanceUnit = z.looseObject({
  name: z.string(),
  kind: z.enum(["follower", "security", "backup", "automation"]),
  service: nullableText,
  timer: nullableText,
  activeState: nullableText,
  subState: nullableText,
  unitFileState: nullableText,
  result: nullableText,
  state: z.enum(["active", "paused", "inactive", "failed"]),
  paused: z.boolean(),
  lastRun: nullableText,
  nextRun: nullableText,
});

const failedUnit = z.looseObject({
  name: z.string(),
  description: nullableText,
});

const dockerUsage = z.looseObject({
  available: z.boolean(),
  images: z.looseObject({
    count: z.number().int().nonnegative(),
    size: nonNegative,
    reclaimable: nonNegative,
  }),
  containers: z.looseObject({
    count: z.number().int().nonnegative(),
    size: nonNegative,
  }),
  volumes: z.looseObject({
    count: z.number().int().nonnegative(),
    size: nonNegative,
  }),
  buildCache: z.looseObject({
    count: z.number().int().nonnegative(),
    size: nonNegative,
  }),
  total: nonNegative,
  reclaimable: nonNegative,
});

/** `GET /maintenance`: the read-only host maintenance snapshot. */
export const maintenanceSnapshotSchema = z.looseObject({
  timestamp: epoch,
  role,
  follower,
  security: z.looseObject({
    pins: z.array(maintenancePin),
    pending: maintenancePendingUpdate.nullable(),
    review: z.array(maintenanceReview),
  }),
  backup: z.looseObject({
    status: z.enum(["ok", "failed", "unknown"]),
    at: nullableText,
  }),
  disks: z.looseObject({
    available: z.boolean(),
    devices: z.array(maintenanceDisk),
  }),
  /** Optional: agents before this section leave it undefined. */
  containers: z
    .looseObject({
      available: z.boolean(),
      items: z.array(maintenanceContainer),
    })
    .optional(),
  /** Optional: agents before helper cleanup leave it undefined. */
  helperCleanup: helperCleanup.optional(),
  units: z.array(maintenanceUnit),
  failedUnits: z.looseObject({
    stack: z.array(failedUnit),
    other: z.array(failedUnit),
  }),
  reboot: z.looseObject({
    available: z.boolean(),
    required: z.boolean().nullable(),
  }),
  docker: dockerUsage,
  degraded,
});

const blockerFile = z.looseObject({
  status: z.string(),
  path: z.string(),
  from: nullableText,
});

const blocker = z.looseObject({
  code: z.enum([
    "release-recovery-pending",
    "security-recovery-pending",
    "checkout-unavailable",
    "dirty-checkout",
    "missing-configuration",
  ]),
  release: nullableText,
  files: z.array(blockerFile),
  missingSettings: z.array(z.string()),
});

const historyEntry = z.looseObject({
  release: z.string().min(1),
  outcome: z.enum(["success", "rolled-back"]),
  at: nullableText,
  previousRelease: nullableText,
  services: z.array(z.string()),
});

const retainedEntry = z.looseObject({
  release: z.string().min(1),
  reason: z.enum([
    "release-recovery-pending",
    "security-recovery-pending",
    "checkout-unavailable",
    "dirty-checkout",
    "missing-manifest",
    "invalid-manifest",
    "missing-configuration",
    "previously-failed",
    "blocked-by-previous-release",
  ]),
  blockedBy: nullableText,
  breaking: z.boolean(),
  manualSteps: z.array(z.string()),
  missingSettings: z.array(z.string()),
  // Agent versions before #24 did not emit this list. Defaulting it preserves
  // the older shape without turning any observation into a healthy signal.
  secretSettings: z.array(z.string()).default([]),
  services: z.array(z.string()),
  sourceCommit: nullableText,
  at: nullableText,
});

const journalEntry = z.looseObject({
  at: z.string(),
  unit: z.string(),
  priority: z.number().int(),
  level: z.enum(["error", "warning", "info", "debug"]),
  message: z.string(),
});

/** `GET /deployments?lines=…`: the read-only deployment snapshot. */
export const deploymentsSnapshotSchema = z.looseObject({
  timestamp: epoch,
  role,
  available: z.boolean(),
  follower,
  blocker: blocker.nullable(),
  history: z.array(historyEntry),
  retained: z.array(retainedEntry),
  journal: z.looseObject({ entries: z.array(journalEntry) }),
  degraded,
});

/**
 * Selects the decoder from the GET method and pathname. Unknown paths keep the
 * previous untyped behaviour; only the snapshots the hub evaluates are
 * decoded here.
 */
export function agentSnapshotSchema(path: string): z.ZodType | undefined {
  let pathname: string;
  try {
    pathname = new URL(path, "http://agent").pathname;
  } catch {
    return undefined;
  }
  if (pathname === "/metrics") return metricsSnapshotSchema;
  if (pathname === "/maintenance") return maintenanceSnapshotSchema;
  if (pathname === "/deployments") return deploymentsSnapshotSchema;
  return undefined;
}
