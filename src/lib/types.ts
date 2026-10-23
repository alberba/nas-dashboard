export type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  protected: boolean;
  cpu: number | null;
  memory: number | null;
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
  key: string;
  title: string;
  detail: string;
  severity: string;
  at: string;
  resolvedAt: string | null;
};
export type Operation = {
  id: string;
  action: string;
  target: string;
  status: string;
  detail: string | null;
  at: string;
};
export type Overview = {
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
