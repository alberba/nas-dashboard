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
  return undefined;
}
