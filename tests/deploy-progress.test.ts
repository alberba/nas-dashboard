import { describe, expect, it } from "vitest";
import { deployProgressFor } from "@/lib/deploy-progress";
import type { MaintenanceSnapshot } from "@/lib/maintenance";
import type {
  DeployContainer,
  DeployProgressPullRequest,
  DeployRelease,
} from "@/lib/types";

const release: DeployRelease = {
  tag: "v2.5.0",
  url: "https://github.com/alberba/media-stack/releases/tag/v2.5.0",
  publishedAt: "2026-11-13T10:00:00.000Z",
  sourceCommit: "b".repeat(40),
  roles: ["instance", "apps-server"],
};

function container(
  status = "Up 1 hour (healthy)",
  state = "running",
): DeployContainer {
  return {
    hostId: "nas-home",
    id: "c".repeat(64),
    name: "radarr",
    image: "lscr.io/linuxserver/radarr:6.4.4.10685-ls325",
    project: "media-stack",
    service: "radarr",
    state,
    status,
  };
}

function pullRequest(
  overrides: Partial<DeployProgressPullRequest> = {},
): DeployProgressPullRequest {
  return {
    number: 100,
    title: "chore(deps): update radarr",
    url: "https://github.com/alberba/media-stack/pull/100",
    branch: "renovate/lscr.io-linuxserver-radarr-6.x",
    author: "renovate[bot]",
    headSha: "a".repeat(40),
    draft: false,
    automerge: true,
    requiresWorker: false,
    ci: "success",
    type: "patch",
    updates: [
      {
        file: "stacks/arr/compose.yaml",
        service: "radarr",
        image: "lscr.io/linuxserver/radarr",
        from: "6.4.4.10685-ls320",
        to: "6.4.4.10685-ls325",
        type: "patch",
      },
    ],
    containers: [],
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

function snapshot({
  installed = "v2.4.1",
  pending = null,
  failed = null,
}: {
  installed?: string | null;
  pending?: string | null;
  failed?: string | null;
} = {}): MaintenanceSnapshot {
  return {
    timestamp: 1_763_000_000,
    role: "instance",
    follower: {
      available: true,
      state: pending ? "deploying" : failed ? "failed" : "idle",
      installed: installed
        ? {
            release: installed,
            commit: "d".repeat(40),
            bootstrap: false,
            installedAt: "2026-11-13T09:00:00.000Z",
          }
        : null,
      pending: pending
        ? {
            release: pending,
            status: "deploying",
            previousRelease: installed,
            changed: ["radarr"],
            since: "2026-11-13T10:05:00.000Z",
          }
        : null,
      failed: failed
        ? { release: failed, since: "2026-11-13T10:10:00.000Z" }
        : null,
    },
    security: { pins: [], pending: null, review: [] },
    backup: { status: "ok", at: null },
    disks: { available: true, devices: [] },
    units: [],
    failedUnits: { stack: [], other: [] },
    reboot: { available: false, required: null },
    docker: {
      available: true,
      images: { count: 0, size: 0, reclaimable: 0 },
      containers: { count: 0, size: 0 },
      volumes: { count: 0, size: 0 },
      buildCache: { count: 0, size: 0 },
      total: 0,
      reclaimable: 0,
    },
    degraded: [],
  };
}

function states(progress: ReturnType<typeof deployProgressFor>) {
  return Object.fromEntries(
    progress.steps.map((step) => [step.id, step.state]),
  );
}

function merged(overrides: Partial<DeployProgressPullRequest> = {}) {
  return pullRequest({
    merged: true,
    mergedAt: "2026-11-13T10:00:00.000Z",
    mergeCommitSha: "e".repeat(40),
    ...overrides,
  });
}

describe("deploy progress in six steps", () => {
  it("stops an open pull request at the merge step", () => {
    const progress = deployProgressFor({
      pullRequest: pullRequest(),
      mainCi: null,
      release: null,
      snapshot: null,
      containers: [],
    });

    expect(progress.steps.map((step) => step.id)).toEqual([
      "pr",
      "merge",
      "ci",
      "release",
      "deploy",
      "health",
    ]);
    expect(states(progress)).toEqual({
      pr: "done",
      merge: "current",
      ci: "pending",
      release: "pending",
      deploy: "pending",
      health: "pending",
    });
    expect(progress.currentStep).toBe("merge");
    expect(progress.state).toBe("open");
    expect(progress.failed).toBe(false);
  });

  it("waits for CI on main after the merge", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "pending",
      release: null,
      snapshot: null,
      containers: [],
    });

    expect(states(progress)).toMatchObject({
      merge: "done",
      ci: "current",
      release: "pending",
    });
    expect(progress.currentStep).toBe("ci");
  });

  it("stops the pipeline when CI on main fails", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "failure",
      release,
      snapshot: snapshot({ installed: "v2.5.0" }),
      containers: [container()],
    });

    expect(states(progress)).toMatchObject({
      ci: "failed",
      release: "pending",
      deploy: "pending",
      health: "pending",
    });
    expect(progress.failed).toBe(true);
    expect(progress.currentStep).toBe("ci");
  });

  it("waits for a release with a deployment manifest", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release: null,
      snapshot: snapshot(),
      containers: [container()],
    });

    expect(states(progress)).toMatchObject({
      ci: "done",
      release: "current",
      deploy: "pending",
      health: "pending",
    });
    expect(progress.currentStep).toBe("release");
  });

  it("marks the release done and waits for the follower to pick it up", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.4.1" }),
      containers: [container()],
    });

    expect(states(progress)).toMatchObject({
      release: "done",
      deploy: "current",
      health: "pending",
    });
    expect(progress.currentStep).toBe("deploy");
  });

  it("reports an in-flight transaction as deploying", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.4.1", pending: "v2.5.0" }),
      containers: [container()],
    });

    expect(states(progress)).toMatchObject({
      release: "done",
      deploy: "current",
      health: "pending",
    });
    expect(
      progress.steps.find((step) => step.id === "deploy")?.at,
    ).toBe("2026-11-13T10:05:00.000Z");
  });

  it("finishes all six steps when the installed release is healthy", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.5.0" }),
      containers: [container()],
    });

    expect(states(progress)).toEqual({
      pr: "done",
      merge: "done",
      ci: "done",
      release: "done",
      deploy: "done",
      health: "done",
    });
    expect(progress.currentStep).toBe("health");
    expect(progress.failed).toBe(false);
    expect(progress.restored).toBe(false);
  });

  it("marks a failed deployment that restored the previous release", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.4.1", failed: "v2.5.0" }),
      containers: [container()],
    });

    expect(states(progress)).toMatchObject({
      deploy: "failed",
      health: "failed",
    });
    expect(progress.failed).toBe(true);
    expect(progress.restored).toBe(true);
    expect(progress.currentStep).toBe("deploy");
  });

  it("fails the health step when an affected container is unhealthy", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.5.0" }),
      containers: [container("Up 1 hour (unhealthy)")],
    });

    expect(states(progress)).toMatchObject({
      deploy: "done",
      health: "failed",
    });
    expect(progress.failed).toBe(true);
    expect(progress.restored).toBe(false);
  });

  it("keeps health current while an affected container starts", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.5.0" }),
      containers: [container("Up 3 seconds (health: starting)")],
    });

    expect(states(progress)).toMatchObject({
      deploy: "done",
      health: "current",
    });
    expect(progress.currentStep).toBe("health");
    expect(progress.failed).toBe(false);
  });

  it("does not keep a failed attempt current after a newer release was installed", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.5.1", failed: "v2.5.0" }),
      containers: [container()],
    });

    expect(states(progress)).toMatchObject({
      deploy: "done",
      health: "done",
    });
    expect(progress.failed).toBe(false);
    expect(progress.restored).toBe(false);
  });

  it("treats a newer installed release as covering the update", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: snapshot({ installed: "v2.5.1" }),
      containers: [container()],
    });

    expect(states(progress)).toMatchObject({
      deploy: "done",
      health: "done",
    });
  });

  it("keeps GitHub progress visible when the agent snapshot is unavailable", () => {
    const progress = deployProgressFor({
      pullRequest: merged(),
      mainCi: "success",
      release,
      snapshot: null,
      containers: [],
    });

    expect(states(progress)).toMatchObject({
      release: "done",
      deploy: "current",
      health: "pending",
    });
    expect(progress.currentStep).toBe("deploy");
  });
});
