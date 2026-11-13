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
  compose: ContainerCompose | null;
};
export type Metrics = {
  timestamp: number;
  hostname: string;
  cpu: number | null;
  memory: { total: number; used: number };
  network: { rx: number | null; tx: number | null };
  io: { read: number | null; write: number | null };
  uptime: number;
  disks: {
    name: string;
    root: string;
    total: number;
    used: number;
    free: number;
  }[];
  temperatures: { name: string; value: number }[];
  containers: Container[];
};
export type Settings = {
  cpu: number;
  memory: number;
  disk: number;
  temperature: number;
  sustainedSeconds: number;
  expectedContainers: string[];
  initialized: boolean;
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
export type Alert = {
  id: number;
  hostId: string;
  key: string;
  title: string;
  detail: string;
  severity: string;
  at: string;
  resolvedAt: string | null;
};
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
export type Overview = {
  host: HostInfo;
  hosts: HostStatus[];
  latest: Metrics | null;
  lastAt: string | null;
  connected: boolean;
  interval: number;
  alerts: Alert[];
  operations: Operation[];
  history: {
    at: string;
    cpu: number | null;
    memory: number | null;
    rx: number | null;
    tx: number | null;
  }[];
  settings: Settings;
};
