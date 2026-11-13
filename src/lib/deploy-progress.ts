import { desc, eq } from "drizzle-orm";
import { containerHealth } from "./containers";
import { db } from "./db";
import {
  fetchDeployReleases,
  fetchMergedRenovatePullRequests,
  fetchPullRequestChecks,
  fetchRenovatePullRequests,
  relatedContainers,
  releaseContainsCommit,
  type GithubConfig,
} from "./github";
import type { HostConfig } from "./hosts";
import { maintenanceForHost, type MaintenanceSnapshot } from "./maintenance";
import { NasInvalidResponse, NasRejected, NasUnavailable } from "./nas";
import { samples } from "./schema";
import type {
  Container,
  DeployContainer,
  DeployProgressOverview,
  DeployProgressPullRequest,
  DeployProgressUpdate,
  DeployRelease,
  DeployStep,
  DeployStepId,
  DeployStepState,
  Metrics,
  RenovateCi,
  RenovateContainer,
} from "./types";

const MERGED_WINDOW_MS = 48 * 60 * 60_000;
const RELEASE_GRACE_MS = 5 * 60_000;
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export type DeployProgressInput = {
  pullRequest: DeployProgressPullRequest;
  mainCi: RenovateCi | null;
  release: DeployRelease | null;
  snapshot: MaintenanceSnapshot | null;
  containers: DeployContainer[];
};

function step(
  id: DeployStepId,
  state: DeployStepState,
  detail: string,
  at: string | null = null,
): DeployStep {
  return { id, state, detail, at };
}

function version(tag: string | null | undefined): [number, number, number] | null {
  const match = tag?.match(STABLE_TAG);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

/** Compares stable vX.Y.Z tags; unknown tags only match by equality. */
export function compareReleaseTags(left: string, right: string): number {
  if (left === right) return 0;
  const before = version(left);
  const after = version(right);
  if (!before || !after) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (before[index] === after[index]) continue;
    return before[index] > after[index] ? 1 : -1;
  }
  return 0;
}

/**
 * The six fixed steps of one update. GitHub owns PR, merge, CI on main and the
 * release with manifest; the agent snapshot owns the installed release, the
 * transaction in progress and the restored failure; container health decides
 * the last step. Every step is always present so the UI can render segments.
 */
export function deployProgressFor({
  pullRequest,
  mainCi,
  release,
  snapshot,
  containers,
}: DeployProgressInput): DeployProgressUpdate {
  const installed = snapshot?.follower.installed?.release ?? null;
  const installedAt = snapshot?.follower.installed?.installedAt ?? null;
  const pending = snapshot?.follower.pending?.release ?? null;
  const pendingAt = snapshot?.follower.pending?.since ?? null;
  const failedRelease = snapshot?.follower.failed?.release ?? null;
  const failedAt = snapshot?.follower.failed?.since ?? null;

  const ciGreen = pullRequest.merged && mainCi === "success";
  const deploymentFailed = Boolean(release && failedRelease === release.tag);
  const deploymentPending = Boolean(release && pending === release.tag);
  const installedCovers = Boolean(
    release && installed && compareReleaseTags(installed, release.tag) >= 0,
  );
  const restored = Boolean(
    deploymentFailed && !installedCovers && installed !== null,
  );
  const health = containers.map(containerHealth);
  const unhealthy = health.includes("unhealthy");
  const starting = health.includes("starting");

  const prStep = pullRequest.merged
    ? step(
        "pr",
        "done",
        `PR #${pullRequest.number} fusionada`,
        pullRequest.mergedAt,
      )
    : step("pr", "done", `PR #${pullRequest.number} abierta`);
  const mergeStep = pullRequest.merged
    ? step("merge", "done", "Fusionada", pullRequest.mergedAt)
    : step("merge", "current", "Esperando merge");

  let ciStep: DeployStep;
  if (!pullRequest.merged)
    ciStep = step("ci", "pending", "Esperando merge");
  else if (mainCi === "success")
    ciStep = step("ci", "done", "CI en main en verde");
  else if (mainCi === "failure")
    ciStep = step("ci", "failed", "CI en main falló");
  else ciStep = step("ci", "current", "CI en main en curso");

  let releaseStep: DeployStep;
  if (!ciGreen) releaseStep = step("release", "pending", "Esperando CI");
  else if (release)
    releaseStep = step(
      "release",
      "done",
      `${release.tag} publicada`,
      release.publishedAt,
    );
  else releaseStep = step("release", "current", "Esperando release");

  let deployStep: DeployStep;
  if (!ciGreen || !release)
    deployStep = step("deploy", "pending", "Esperando release");
  else if (deploymentFailed)
    deployStep = step(
      "deploy",
      "failed",
      restored ? "Despliegue fallido; release restaurada" : "Despliegue fallido",
      failedAt,
    );
  else if (deploymentPending)
    deployStep = step("deploy", "current", "Despliegue en curso", pendingAt);
  else if (installedCovers)
    deployStep = step(
      "deploy",
      "done",
      `${release.tag} instalada`,
      installedAt,
    );
  else deployStep = step("deploy", "current", "Esperando al seguidor");

  let healthStep: DeployStep;
  if (!ciGreen || !release)
    healthStep = step("health", "pending", "Esperando despliegue");
  else if (deploymentFailed)
    healthStep = step(
      "health",
      "failed",
      restored ? "Restaurada" : "Sin salud",
      failedAt,
    );
  else if (deploymentPending)
    healthStep = step("health", "pending", "Esperando despliegue");
  else if (!installedCovers)
    healthStep = step("health", "pending", "Esperando despliegue");
  else if (unhealthy)
    healthStep = step("health", "failed", "Contenedor sin salud", installedAt);
  else if (starting)
    healthStep = step("health", "current", "Arrancando", installedAt);
  else healthStep = step("health", "done", "Sano", installedAt);

  const steps = [
    prStep,
    mergeStep,
    ciStep,
    releaseStep,
    deployStep,
    healthStep,
  ];
  const current =
    steps.find(
      (entry) => entry.state === "current" || entry.state === "failed",
    ) ?? steps[steps.length - 1];

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    branch: pullRequest.branch,
    author: pullRequest.author,
    state: pullRequest.merged ? "merged" : "open",
    headSha: pullRequest.headSha,
    mergeCommitSha: pullRequest.mergeCommitSha,
    mergedAt: pullRequest.mergedAt,
    draft: pullRequest.draft,
    automerge: pullRequest.automerge,
    requiresWorker: pullRequest.requiresWorker,
    type: pullRequest.type,
    prCi: pullRequest.ci,
    mainCi: pullRequest.merged ? mainCi : null,
    release,
    steps,
    currentStep: current.id,
    failed: steps.some((entry) => entry.state === "failed"),
    restored,
    updates: pullRequest.updates,
    containers,
  };
}

function composeContainers(
  hostId: string,
  containers: Container[],
): RenovateContainer[] {
  const result: RenovateContainer[] = [];
  for (const container of containers) {
    const project = container.composeProject ?? container.compose?.project;
    const service = container.composeService ?? container.compose?.service;
    if (!project || !service) continue;
    result.push({
      hostId,
      id: container.id,
      name: container.name,
      image: container.image,
      project,
      service,
    });
  }
  return result;
}

async function latestContainers(hostId: string): Promise<Container[]> {
  const [latest] = await db
    .select({ data: samples.data })
    .from(samples)
    .where(eq(samples.hostId, hostId))
    .orderBy(desc(samples.at))
    .limit(1);
  return (latest?.data as Metrics | undefined)?.containers ?? [];
}

async function safeSnapshot(
  host: HostConfig,
): Promise<MaintenanceSnapshot | null> {
  try {
    return (await maintenanceForHost(host)).snapshot;
  } catch (error) {
    if (
      error instanceof NasUnavailable ||
      error instanceof NasRejected ||
      error instanceof NasInvalidResponse
    ) {
      console.error(
        "Deploy progress maintenance error",
        error instanceof Error ? error.name : "unknown",
      );
      return null;
    }
    throw error;
  }
}

async function releaseForMerge(
  config: GithubConfig,
  releases: DeployRelease[],
  mergeCommitSha: string,
  mergedAt: string,
): Promise<DeployRelease | null> {
  const cutoff = new Date(mergedAt).getTime() - RELEASE_GRACE_MS;
  const candidates = releases
    .filter(
      (release) =>
        release.publishedAt &&
        new Date(release.publishedAt).getTime() >= cutoff,
    )
    .sort((left, right) =>
      (left.publishedAt ?? "").localeCompare(right.publishedAt ?? ""),
    );
  for (const release of candidates) {
    if (await releaseContainsCommit(config, mergeCommitSha, release))
      return release;
  }
  return null;
}

/**
 * Loads the recent updates and combines GitHub with each host's agent snapshot.
 * Open pull requests always appear; merged ones appear for two days so a late
 * deployment (including a restored failure) is still visible.
 */
export async function deployProgressForHost({
  config,
  host,
  now = new Date(),
}: {
  config: GithubConfig;
  host: HostConfig;
  now?: Date;
}): Promise<DeployProgressOverview> {
  const open = await fetchRenovatePullRequests(config);
  const merged = await fetchMergedRenovatePullRequests(
    config,
    new Date(now.getTime() - MERGED_WINDOW_MS),
  );
  const containers = await latestContainers(host.id);
  const allRenovate = composeContainers(host.id, containers);
  const byId = new Map(containers.map((entry) => [entry.id, entry]));

  const related = (pr: {
    updates: { file: string; service: string }[];
  }): DeployContainer[] =>
    relatedContainers(pr.updates, allRenovate).map((entry) => {
      const current = byId.get(entry.id);
      return {
        ...entry,
        state: current?.state ?? "unknown",
        status: current?.status ?? "",
      };
    });

  const snapshot = merged.length ? await safeSnapshot(host) : null;
  const releases = merged.length ? await fetchDeployReleases(config) : [];

  const openUpdates: DeployProgressUpdate[] = open.map((pr) =>
    deployProgressFor({
      pullRequest: {
        ...pr,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      },
      mainCi: null,
      release: null,
      snapshot,
      containers: related(pr),
    }),
  );

  const mergedUpdates = await Promise.all(
    merged.map(async (pr) => {
      const [mainCi, release] = await Promise.all([
        fetchPullRequestChecks(config, pr.mergeCommitSha),
        releaseForMerge(
          config,
          releases,
          pr.mergeCommitSha,
          pr.mergedAt,
        ),
      ]);
      return deployProgressFor({
        pullRequest: pr,
        mainCi,
        release,
        snapshot,
        containers: related(pr),
      });
    }),
  );

  return {
    enabled: true,
    repository: config.repository,
    host: { id: host.id, name: host.name, role: host.role },
    snapshotAvailable: snapshot !== null,
    updates: [...openUpdates, ...mergedUpdates],
  };
}
