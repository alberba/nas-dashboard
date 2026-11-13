import { describe, expect, it } from "vitest";
import {
  containerUpdates,
  prRows,
} from "@/lib/renovate-view";
import type { RenovateOverview, RenovatePullRequest } from "@/lib/types";

const pr = (
  number: number,
  overrides: Partial<RenovatePullRequest> = {},
): RenovatePullRequest => ({
  number,
  title: `chore(deps): update #${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  branch: `renovate/x-${number}`,
  author: "renovate[bot]",
  headSha: "abc",
  draft: false,
  automerge: false,
  requiresWorker: false,
  ci: "success",
  type: "minor",
  updates: [
    {
      file: "stacks/media/compose.yaml",
      service: "radarr",
      image: "lscr.io/linuxserver/radarr",
      from: "5.0",
      to: "5.1",
      type: "minor",
    },
  ],
  containers: [
    {
      hostId: "nas-home",
      id: "c1",
      name: "radarr",
      image: "lscr.io/linuxserver/radarr:5.0",
      project: "media-stack",
      service: "radarr",
    },
  ],
  ...overrides,
});
const overview = (prs: RenovatePullRequest[]): RenovateOverview => ({
  enabled: true,
  repository: "o/r",
  prs,
});

describe("container update pills", () => {
  it("links each container to its pull requests", () => {
    const pills = containerUpdates(overview([pr(94), pr(95)]), "nas-home");
    expect(pills.get("c1")?.map((p) => p.number)).toEqual([94, 95]);
    expect(pills.get("c1")?.[0].url).toBe("https://github.com/o/r/pull/94");
  });

  it("ignores containers of another host", () => {
    const pills = containerUpdates(overview([pr(94)]), "apps");
    expect(pills.size).toBe(0);
  });

  it("gives no pills when the section is disabled", () => {
    const off: RenovateOverview = { enabled: false, repository: null, prs: [] };
    expect(containerUpdates(off, "nas-home").size).toBe(0);
    expect(containerUpdates(null, "nas-home").size).toBe(0);
  });
});

describe("pull request rows", () => {
  const rows = (prs: RenovatePullRequest[], host = "nas-home") =>
    prRows(overview(prs), host);

  it("reports type, ci and merge state as machine-readable states", () => {
    const [a] = rows([pr(1, { type: "major", ci: "failure" })]);
    expect(a).toMatchObject({ type: "major", ci: "failure", status: "waiting" });
    const [b] = rows([pr(2, { automerge: true, ci: "none" })]);
    expect(b).toMatchObject({ ci: "none", status: "automerge" });
    const [c] = rows([pr(3, { draft: true })]);
    expect(c.status).toBe("draft");
  });

  it("marks a grouped Tdarr pull request as needing the Worker", () => {
    const [row] = rows([
      pr(88, {
        requiresWorker: true,
        updates: [
          { file: "stacks/transcode/compose.yaml", service: "tdarr", image: "t", from: "1", to: "2", type: "minor" },
          { file: "worker/compose.yaml", service: "tdarr-node", image: "n", from: "1", to: "2", type: "minor" },
        ],
        containers: [],
      }),
    ]);
    expect(row.requiresWorker).toBe(true);
    expect(row.services.map((s) => s.service)).toEqual(["tdarr", "tdarr-node"]);
    expect(row.containers).toEqual([]);
  });

  it("keeps only the scoped host's containers, grouped by Compose project", () => {
    const [row] = rows([
      pr(5, {
        containers: [
          { hostId: "nas-home", id: "a", name: "radarr", image: "i", project: "media-stack", service: "radarr" },
          { hostId: "apps", id: "b", name: "radarr", image: "i", project: "media-stack-apps", service: "radarr" },
        ],
      }),
    ]);
    expect(row.containers.map((c) => c.id)).toEqual(["a"]);
    expect(row.projects).toEqual(["media-stack"]);
  });
});

