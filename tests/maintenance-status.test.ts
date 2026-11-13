import { describe, expect, it } from "vitest";
import type { MaintenanceSnapshot, MaintenanceUnit } from "@/lib/maintenance";
import {
  automationRows,
  failedUnitGroups,
  statusCells,
} from "@/lib/maintenance-status";

function unit(overrides: Partial<MaintenanceUnit> = {}): MaintenanceUnit {
  return {
    name: "media-stack-merged-updates",
    kind: "follower",
    service: "media-stack-merged-updates.service",
    timer: "media-stack-merged-updates.timer",
    activeState: "inactive",
    subState: "dead",
    unitFileState: "enabled",
    result: "success",
    state: "active",
    paused: false,
    lastRun: "2026-11-13T09:00:00Z",
    nextRun: "2026-11-13T10:00:00Z",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<MaintenanceSnapshot> = {},
): MaintenanceSnapshot {
  return {
    timestamp: 1_800_000_000,
    role: "instance",
    follower: {
      available: true,
      state: "idle",
      installed: {
        release: "v2.4.1",
        commit: "abc",
        bootstrap: false,
        installedAt: "2026-11-12T08:00:00Z",
      },
      pending: null,
      failed: null,
    },
    security: { pins: [], pending: null, review: [] },
    backup: { status: "ok", at: "2026-11-13T03:00:00Z" },
    disks: { available: true, devices: [] },
    units: [unit()],
    failedUnits: { stack: [], other: [] },
    reboot: { available: true, required: false },
    docker: {
      available: true,
      images: { count: 4, size: 8e9, reclaimable: 2e9 },
      containers: { count: 2, size: 1e6 },
      volumes: { count: 1, size: 1e6 },
      buildCache: { count: 0, size: 0 },
      total: 9e9,
      reclaimable: 2e9,
    },
    degraded: [],
    ...overrides,
  };
}

describe("status cells", () => {
  it("reports a healthy host", () => {
    const cells = statusCells(snapshot());
    expect(cells.release).toMatchObject({
      state: "installed",
      release: "v2.4.1",
      tone: "gain",
    });
    expect(cells.follower).toMatchObject({ state: "active", tone: "gain" });
    expect(cells.security).toMatchObject({ state: "ok", tone: "gain" });
    expect(cells.backup).toMatchObject({ state: "ok", tone: "gain" });
    expect(cells.reboot).toMatchObject({ state: "none", tone: "gain" });
    expect(cells.docker).toMatchObject({ state: "ok", reclaimable: 2e9 });
  });

  it("degrades to absent cells when the follower files are missing", () => {
    const cells = statusCells(
      snapshot({
        follower: {
          available: false,
          state: "unknown",
          installed: null,
          pending: null,
          failed: null,
        },
        units: [],
      }),
    );
    expect(cells.release.state).toBe("absent");
    expect(cells.follower.state).toBe("absent");
    expect(cells.release.tone).toBe("muted");
  });

  it("treats every degraded section as absent instead of its empty default", () => {
    const cells = statusCells(
      snapshot({
        degraded: [
          "follower",
          "security",
          "backup",
          "units",
          "reboot",
          "docker",
        ],
        backup: { status: "unknown", at: null },
        reboot: { available: true, required: false },
      }),
    );
    for (const id of [
      "release",
      "follower",
      "security",
      "backup",
      "reboot",
      "docker",
    ] as const)
      expect(cells[id].state, id).toMatch(/absent|unavailable/);
  });

  it("flags a failed follower and a deploying follower", () => {
    expect(
      statusCells(snapshot({ units: [unit({ state: "failed" })] })).follower,
    ).toMatchObject({ state: "failed", tone: "loss" });
    const deploying = snapshot();
    deploying.follower.state = "deploying";
    deploying.follower.pending = {
      release: "v2.5.0",
      status: "applying",
      previousRelease: "v2.4.1",
      changed: [],
      since: null,
    };
    expect(statusCells(deploying).follower).toMatchObject({
      state: "deploying",
      tone: "accent",
      pending: "v2.5.0",
    });
  });

  it("shows a paused follower as needing attention", () => {
    expect(
      statusCells(
        snapshot({ units: [unit({ state: "paused", paused: true })] }),
      ).follower,
    ).toMatchObject({ state: "paused", tone: "peach" });
  });

  it("prioritises a pending security update over reviews", () => {
    const s = snapshot();
    s.security = {
      pins: [{ service: "radarr", image: "r", version: "1", digest: "sha" }],
      pending: {
        service: "radarr",
        status: "applying",
        candidate: "2",
        candidateRef: null,
        since: null,
      },
      review: [
        {
          names: ["sonarr"],
          from: "1",
          to: "2",
          semver: "major",
          cves: 3,
          newSevere: 0,
          verifiedAt: null,
          reason: "manual",
        },
      ],
    };
    expect(statusCells(s).security).toMatchObject({
      state: "pending",
      tone: "accent",
      pins: 1,
      review: 1,
    });
    s.security.pending = null;
    expect(statusCells(s).security).toMatchObject({
      state: "review",
      tone: "peach",
    });
  });

  it("maps backup and reboot states", () => {
    expect(
      statusCells(snapshot({ backup: { status: "failed", at: null } })).backup,
    ).toMatchObject({ state: "failed", tone: "loss" });
    expect(
      statusCells(snapshot({ backup: { status: "unknown", at: null } })).backup,
    ).toMatchObject({ state: "unknown", tone: "muted" });
    expect(
      statusCells(snapshot({ reboot: { available: false, required: null } }))
        .reboot,
    ).toMatchObject({ state: "unavailable", tone: "muted" });
    expect(
      statusCells(snapshot({ reboot: { available: true, required: true } }))
        .reboot,
    ).toMatchObject({ state: "required", tone: "lilac" });
  });
});

describe("automations and failed units", () => {
  it("lists every unit with its state and marks an absent list", () => {
    const rows = automationRows(
      snapshot({
        units: [
          unit(),
          unit({
            name: "media-stack-evidence",
            kind: "automation",
            state: "paused",
            paused: true,
          }),
        ],
      }),
    );
    expect(rows.available).toBe(true);
    expect(rows.items.map((i) => [i.name, i.state])).toEqual([
      ["media-stack-merged-updates", "active"],
      ["media-stack-evidence", "paused"],
    ]);
    expect(
      automationRows(snapshot({ degraded: ["units"], units: [] })).available,
    ).toBe(false);
  });

  it("keeps stack and foreign failed units apart", () => {
    const groups = failedUnitGroups(
      snapshot({
        failedUnits: {
          stack: [{ name: "media-stack-backup.service", description: null }],
          other: [{ name: "snapd.service", description: "Snap" }],
        },
      }),
    );
    expect(groups.available).toBe(true);
    expect(groups.stack.map((u) => u.name)).toEqual([
      "media-stack-backup.service",
    ]);
    expect(groups.other.map((u) => u.name)).toEqual(["snapd.service"]);
    expect(
      failedUnitGroups(snapshot({ degraded: ["failedUnits"] })).available,
    ).toBe(false);
  });
});
