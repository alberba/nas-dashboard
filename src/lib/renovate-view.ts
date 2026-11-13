import type {
  RenovateCi,
  RenovateContainer,
  RenovateOverview,
  RenovatePullRequest,
  RenovateUpdate,
  RenovateUpdateType,
} from "./types";

export type UpdatePill = { number: number; url: string };

/**
 * Update pills for the container rows, keyed by container id. Only the scoped
 * host's containers are included; a disabled or missing section yields none.
 */
export function containerUpdates(
  overview: RenovateOverview | null,
  hostId: string | null,
): Map<string, UpdatePill[]> {
  const pills = new Map<string, UpdatePill[]>();
  if (!overview?.enabled || !hostId) return pills;
  for (const pr of overview.prs)
    for (const container of pr.containers) {
      if (container.hostId !== hostId) continue;
      const list = pills.get(container.id) ?? [];
      if (!list.some((p) => p.number === pr.number))
        list.push({ number: pr.number, url: pr.url });
      pills.set(container.id, list);
    }
  return pills;
}

export type PrStatus = "draft" | "automerge" | "waiting";
export type PrRow = {
  number: number;
  title: string;
  url: string;
  type: RenovateUpdateType;
  ci: RenovateCi;
  status: PrStatus;
  requiresWorker: boolean;
  services: RenovateUpdate[];
  /** Containers of the scoped host this pull request updates. */
  containers: RenovateContainer[];
  /** Compose projects of those containers. */
  projects: string[];
};

export function prRows(
  overview: RenovateOverview | null,
  hostId: string | null,
): PrRow[] {
  if (!overview?.enabled) return [];
  return overview.prs.map((pr: RenovatePullRequest) => {
    const containers = pr.containers.filter((c) => c.hostId === hostId);
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      type: pr.type,
      ci: pr.ci,
      status: pr.draft ? "draft" : pr.automerge ? "automerge" : "waiting",
      requiresWorker: pr.requiresWorker,
      services: pr.updates,
      containers,
      projects: [...new Set(containers.map((c) => c.project))],
    };
  });
}
