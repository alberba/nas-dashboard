export type HostRole = "instance" | "apps-server";
export type HostInfo = {
  id: string;
  name: string;
  role: HostRole;
};
export type HostStatus = HostInfo & {
  connected: boolean;
  lastAt: string | null;
};
export type ContainerCompose = {
  project: string;
  service: string;
};
export type CpuBreakdown = {
  user: number;
  system: number;
  iowait: number;
  steal: number;
  idle: number;
  irq: number;
  softirq: number;
  nice: number;
};
export type SystemDetails = {
  hostname: string | null;
  cpuModel: string | null;
  cores: number | null;
  threads: number | null;
  sockets: number | null;
  arch: string | null;
  kernel: string | null;
  osName: string | null;
  memoryTotal: number;
};
export type NetworkInterface = {
  name: string;
  /** Bytes per second; null until the agent has a previous counter. */
  rx: number | null;
  tx: number | null;
  /** Cumulative bytes since boot. */
  rxTotal: number;
  txTotal: number;
};
export type Filesystem = {
  name: string;
  total: number;
  used: number;
  free: number;
};
export type IoDeviceLatency = {
  name: string;
  readMs: number | null;
  writeMs: number | null;
  utilization: number | null;
  weightedMs: number | null;
};
export type IoLatency = {
  readMs: number | null;
  writeMs: number | null;
  utilization: number | null;
  weightedMs: number | null;
  devices: IoDeviceLatency[];
};
export type RaidArray = {
  name: string;
  level: string | null;
  state: string | null;
  disks: number | null;
  capacity: number | null;
  degraded: number | null;
  syncAction: string | null;
  syncCompleted: string | null;
  syncSpeed: string | null;
};
export type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  protected: boolean;
  composeProject: string | null;
  composeService: string | null;
  oneShot: boolean;
  exitCode: number | null;
  orphan: boolean;
  recreateOnCompose: boolean;
  cpu: number | null;
  memory: number | null;
  network?: { rx: number | null; tx: number | null } | null;
  compose: ContainerCompose | null;
  /** Earliest unhealthy sample observed by this agent, Unix seconds; resets on recovery. */
  healthObservedSince?: number | null;
};
export type Metrics = {
  timestamp: number;
  /** Docker list date (Unix seconds); absent on agents before the field existed. */
  containersObservedAt?: number;
  hostname: string;
  system?: SystemDetails | null;
  cpu: number | null;
  /** Per-thread busy percentages; null until the agent has a previous sample. */
  cpuCores?: (number | null)[] | null;
  cpuBreakdown?: CpuBreakdown | null;
  load?: [number, number, number] | null;
  memory: {
    total: number;
    used: number;
    cache?: number;
    swap?: { total: number; used: number };
  };
  network: {
    rx: number | null;
    tx: number | null;
    interfaces?: NetworkInterface[];
  };
  io: {
    read: number | null;
    write: number | null;
    latency?: IoLatency | null;
  };
  uptime: number;
  disks: {
    name: string;
    root: string;
    total: number;
    used: number;
    free: number;
  }[];
  filesystems?: Filesystem[];
  raid?: RaidArray[];
  temperatures: { name: string; value: number }[];
  containers: Container[];
};
/**
 * Docker identity confirmed for one watched name. The ID wins over the Compose
 * pair; both are stored so a later rename or recreation can be proven.
 */
export type ContainerIdentity = {
  containerId: string | null;
  composeProject: string | null;
  composeService: string | null;
};
/**
 * Durable absence window of one expected container. Wall-clock time is never
 * used: `accreditedMs` only grows across consecutive fresh, complete Docker
 * lists, and `observedAt` anchors that continuity.
 */
export type ContainerWatchEntry = {
  identity: ContainerIdentity;
  /** Unix seconds of the first absence observation. */
  absentSince: number;
  /** Unix seconds of the last inventory that accredited this absence. */
  observedAt: number;
  /** Accumulated absence proven by consecutive Docker lists. */
  accreditedMs: number;
};
/**
 * Durable inventory reconciliation state for one host. It lives in the
 * settings JSON so an API process and the collector never overwrite each
 * other's watching intention.
 */
export type ContainerWatch = {
  /** Bumped whenever the operator or the reconciliation changes watching. */
  revision: number;
  /** Collector instance that produced the last accepted list. */
  workerId: string | null;
  /** Last complete Docker list already evaluated (Unix seconds). */
  lastInventoryAt: number | null;
  /** Last list that continued the evidence chain (Unix seconds). */
  chainAt: number | null;
  entries: Record<string, ContainerWatchEntry>;
  /** Last confirmed Docker identity per watched name. */
  identities: Record<string, ContainerIdentity>;
};
/** Public projection of a name that is absent but still inside its window. */
export type ContainerWatchPending = {
  name: string;
  state: "pending";
  /** Unix seconds of the first absence. */
  absentSince: number;
  accreditedMs: number;
  thresholdMs: number;
};
export type Settings = {
  cpu: number;
  memory: number;
  disk: number;
  temperature: number;
  sustainedSeconds: number;
  expectedContainers: string[];
  initialized: boolean;
  /** Optional so older rows and the previous binary keep working. */
  watch?: ContainerWatch;
};
export type FileEntry = {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
  size: number;
  modified: number;
};
export type TrashEntry = {
  id: string;
  root: "media" | "torrents";
  name: string;
  path: string;
  deletedAt: number;
  expiresAt: number;
};
/**
 * Delivery information that the hub is allowed to publish. The channel is the
 * public route (never an endpoint), and the reason belongs to a finite set so
 * provider bodies, tokens and transport destinations can never leak.
 */
export type PublicDeliveryChannel = "telegram" | "push" | "digest" | "silent";
export type PublicDeliveryState =
  | "pending"
  | "sent"
  | "failed"
  | "suppressed"
  | "uncertain"
  | "none";
export type PublicDeliveryReason =
  | "legacy_open"
  | "digest_pending"
  | "policy_silent"
  | "telegram_disabled"
  | "push_disabled"
  | "permanent_rejection"
  | "uncertain";
export type PublicDelivery = {
  channel: PublicDeliveryChannel | null;
  state: PublicDeliveryState;
  reason: PublicDeliveryReason | null;
};
/**
 * Public state of one Europe/Madrid civil date of the daily digest. It is a
 * finite projection: the frozen payload, the chat destination and any provider
 * body stay out of it. `pending` covers both a prepared row and an active
 * claim, so the operator never mistakes a started attempt for a delivery.
 */
export type PublicDigestStatus =
  | "pending"
  | "sent"
  | "empty"
  | "unconfigured"
  | "expired"
  | "failed"
  | "uncertain";
/** The only reasons the hub publishes for a digest date. */
export type PublicDigestReason =
  | "telegram_disabled"
  | "digest_empty"
  | "window_closed"
  | "digest_missed"
  | "retry_budget_exhausted"
  | "lease_expired_after_attempt"
  | "rate_limited"
  | "telegram_400"
  | "telegram_401"
  | "telegram_403"
  | "telegram_404"
  | "telegram_server_error"
  | "message_missing"
  | "network"
  | "timeout"
  | "aborted"
  | "invalid_response"
  | "missing_message_id";
export type DigestState = {
  /** Civil date in Europe/Madrid, `YYYY-MM-DD`. */
  date: string;
  /** Instant the digest was scheduled for, as an ISO string. */
  targetAt: string;
  status: PublicDigestStatus;
  reason: PublicDigestReason | null;
};
/** Public shape of an episode: the outage group, a container or another key. */
export type IncidentKind = "services-down" | "container" | "condition";
export type IncidentInventoryEntry = {
  name: string;
  state: string;
};
/**
 * Last trustworthy inventory captured when a `services-down` group opened.
 * `observedAt` is Unix seconds. `observedFrom` separates a real Docker list
 * date from the general sample date an older agent can offer; `complete` is
 * false when no evidence existed, never because a genuine list was empty.
 */
export type IncidentInventoryContext = {
  kind: "services-down";
  observedAt: number | null;
  observedFrom: "inventory" | "sample" | "unknown";
  complete: boolean;
  entries: IncidentInventoryEntry[];
  omitted: number;
};
export type Alert = {
  id: number;
  hostId: string;
  key: string;
  kind: IncidentKind;
  title: string;
  detail: string;
  severity: string;
  at: string;
  resolvedAt: string | null;
  /** Monotonic episode revision, used by the local push refresh (D-05). */
  seq: number;
  /** Initial notice result. */
  delivery: PublicDelivery;
  /** Push fallback result, when the critical fallback was attempted. */
  fallback: PublicDelivery | null;
  /** Latest edit result for the confirmed Telegram message, if any. */
  lastUpdate: PublicDelivery | null;
  /** Captured inventory of a `services-down` group; null for other episodes. */
  inventory: IncidentInventoryContext | null;
  /** Outage episode that currently blocks this container observation. */
  inhibitedBy: number | null;
  inhibitedReason: string | null;
  /** True while the container state is still unverified after an outage. */
  observationPending: boolean;
  /** Open container episodes inhibited by this group, if it is one. */
  inhibited: Alert[] | null;
};

/** Pending absence rows of the selected host, never fabricated containers. */
export type ContainerWatchView = ContainerWatchPending[];
export type Operation = {
  id: string;
  hostId: string;
  action: string;
  target: string;
  status: string;
  detail: string | null;
  at: string;
};
export type RenovateUpdateType =
  | "major"
  | "minor"
  | "patch"
  | "digest"
  | "pin"
  | "unknown";
export type RenovateCi = "success" | "pending" | "failure" | "none";
export type RenovateContainer = {
  hostId: string;
  id: string;
  name: string;
  image: string;
  project: string;
  service: string;
};
export type RenovateUpdate = {
  file: string;
  service: string;
  image: string;
  from: string;
  to: string;
  type: RenovateUpdateType;
};
export type RenovatePullRequest = {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  headSha: string;
  draft: boolean;
  automerge: boolean;
  requiresWorker: boolean;
  ci: RenovateCi;
  type: RenovateUpdateType;
  updates: RenovateUpdate[];
  containers: RenovateContainer[];
};
export type RenovateOverview = {
  enabled: boolean;
  repository: string | null;
  prs: RenovatePullRequest[];
};
/** Fixed order of the six progress segments shown by the UI. */
export const deployStepIds = [
  "pr",
  "merge",
  "ci",
  "release",
  "deploy",
  "health",
] as const;
export type DeployStepId = (typeof deployStepIds)[number];
export type DeployStepState = "pending" | "current" | "done" | "failed";
export type DeployStep = {
  id: DeployStepId;
  state: DeployStepState;
  detail: string;
  at: string | null;
};
export type DeployRelease = {
  tag: string;
  url: string;
  publishedAt: string | null;
  sourceCommit: string;
  roles: HostRole[];
};
export type DeployContainer = RenovateContainer & {
  state: string;
  status: string;
};
export type DeployProgressPullRequest = RenovatePullRequest & {
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
};
export type DeployProgressUpdate = {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  state: "open" | "merged";
  headSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  draft: boolean;
  automerge: boolean;
  requiresWorker: boolean;
  type: RenovateUpdateType;
  prCi: RenovateCi;
  mainCi: RenovateCi | null;
  release: DeployRelease | null;
  steps: DeployStep[];
  currentStep: DeployStepId;
  failed: boolean;
  restored: boolean;
  updates: RenovateUpdate[];
  containers: DeployContainer[];
};
export type DeployProgressOverview = {
  enabled: boolean;
  repository: string | null;
  host: HostInfo | null;
  snapshotAvailable: boolean;
  updates: DeployProgressUpdate[];
};
export type ContainerHistoryPoint = {
  at: string;
  cpu: number | null;
  memory: number | null;
  rx: number | null;
  tx: number | null;
};

export type Overview = {
  host: HostInfo;
  hosts: HostStatus[];
  latest: Metrics | null;
  lastAt: string | null;
  connected: boolean;
  interval: number;
  alerts: Alert[];
  /** Open alerts for the selected host; matches the sidebar counter. */
  openAlerts: number;
  /**
   * Latest digest date, global to the hub. Absent while an older hub still
   * answers or before the first run, so the client never invents a result.
   */
  digest?: DigestState | null;
  /** Expected names absent from fresh inventory, still inside their window. */
  watchPending: ContainerWatchPending[];
  operations: Operation[];
  history: {
    at: string;
    cpu: number | null;
    memory: number | null;
    swap?: number | null;
    rx: number | null;
    tx: number | null;
    ioRead?: number | null;
    ioWrite?: number | null;
    load1?: number | null;
    load5?: number | null;
    load15?: number | null;
    readAwait?: number | null;
    writeAwait?: number | null;
    utilization?: number | null;
  }[];
  settings: Settings;
};
