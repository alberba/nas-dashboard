import { describe, expect, it } from "vitest";
import {
  deploymentAlertSignals,
  maintenanceAlertSignals,
  type AlertSignal,
} from "@/lib/maintenance-alerts";
import type { DeploymentsSnapshot } from "@/lib/deployments";
import type { MaintenanceSnapshot } from "@/lib/maintenance";

function maintenance(
  overrides: Partial<MaintenanceSnapshot> = {},
): MaintenanceSnapshot {
  return {
    timestamp: 1_763_040_000,
    role: "instance",
    follower: {
      available: true,
      state: "idle",
      installed: {
        release: "v2.4.1",
        commit: "a".repeat(40),
        bootstrap: false,
        installedAt: "2026-11-13T03:04:49Z",
      },
      pending: null,
      failed: null,
    },
    security: { pins: [], pending: null, review: [] },
    backup: { status: "ok", at: "2026-11-13T03:04:49Z" },
    disks: {
      available: true,
      devices: [
        {
          device: "sda",
          model: "WDC WD40EFRX",
          serial: "WD-1",
          kind: "sata",
          size: 4_000_000_000_000,
          temperature: 34,
          reallocatedSectors: 0,
          wear: null,
          status: "ok",
          issues: [],
        },
      ],
    },
    units: [],
    failedUnits: { stack: [], other: [] },
    reboot: { available: true, required: false },
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
    ...overrides,
  };
}

function deployments(
  overrides: Partial<DeploymentsSnapshot> = {},
): DeploymentsSnapshot {
  return {
    timestamp: 1_763_040_000,
    role: "instance",
    available: true,
    follower: {
      available: true,
      state: "idle",
      installed: {
        release: "v2.4.1",
        commit: "a".repeat(40),
        bootstrap: false,
        installedAt: "2026-11-13T03:04:49Z",
      },
      pending: null,
      failed: null,
    },
    blocker: null,
    history: [],
    retained: [],
    journal: { entries: [] },
    degraded: [],
    ...overrides,
  };
}

function signal(signals: AlertSignal[], key: string) {
  return signals.find((entry) => entry.key === key);
}

describe("maintenance alert signals", () => {
  it("opens a backup alert only when the last copy failed", () => {
    const failed = signal(
      maintenanceAlertSignals(
        maintenance({ backup: { status: "failed", at: "2026-11-13T03:00:00Z" } }),
        "NAS-HOME",
      ),
      "backup-failed",
    );
    expect(failed).toMatchObject({ failing: true, severity: "critical" });

    const ok = signal(
      maintenanceAlertSignals(maintenance(), "NAS-HOME"),
      "backup-failed",
    );
    expect(ok).toMatchObject({ failing: false });
  });

  it("does not change the backup alert when the status is unknown or degraded", () => {
    const unknown = maintenanceAlertSignals(
      maintenance({ backup: { status: "unknown", at: null } }),
      "NAS-HOME",
    );
    expect(signal(unknown, "backup-failed")).toBeUndefined();

    const degraded = maintenanceAlertSignals(
      maintenance({
        backup: { status: "failed", at: "2026-11-13T03:00:00Z" },
        degraded: ["backup"],
      }),
      "NAS-HOME",
    );
    expect(signal(degraded, "backup-failed")).toBeUndefined();
  });

  it("reports a disk to watch or a failing disk with its severity", () => {
    const base = maintenance().disks.devices[0];
    const watch = signal(
      maintenanceAlertSignals(
        maintenance({
          disks: {
            available: true,
            devices: [{ ...base, status: "watch", issues: ["wear"] }],
          },
        }),
        "NAS-HOME",
      ),
      "disk-health",
    );
    expect(watch).toMatchObject({ failing: true, severity: "warning" });

    const fail = signal(
      maintenanceAlertSignals(
        maintenance({
          disks: {
            available: true,
            devices: [{ ...base, status: "fail", issues: ["smart_failed"] }],
          },
        }),
        "NAS-HOME",
      ),
      "disk-health",
    );
    expect(fail).toMatchObject({ failing: true, severity: "critical" });

    const healthy = signal(
      maintenanceAlertSignals(maintenance(), "NAS-HOME"),
      "disk-health",
    );
    expect(healthy).toMatchObject({ failing: false });
  });

  it("does not touch disk alerts when the SMART section is absent", () => {
    const signals = maintenanceAlertSignals(
      maintenance({ disks: { available: false, devices: [] }, degraded: ["disks"] }),
      "NAS-HOME",
    );
    expect(signal(signals, "disk-health")).toBeUndefined();
  });

  it("opens a reboot alert only while the host reports it is pending", () => {
    const pending = signal(
      maintenanceAlertSignals(
        maintenance({ reboot: { available: true, required: true } }),
        "NAS-HOME",
      ),
      "reboot-pending",
    );
    expect(pending).toMatchObject({ failing: true });

    const recovered = signal(
      maintenanceAlertSignals(
        maintenance({ reboot: { available: true, required: false } }),
        "NAS-HOME",
      ),
      "reboot-pending",
    );
    expect(recovered).toMatchObject({ failing: false });

    const unavailable = maintenanceAlertSignals(
      maintenance({ reboot: { available: false, required: null } }),
      "NAS-HOME",
    );
    expect(signal(unavailable, "reboot-pending")).toBeUndefined();
  });

  it("only counts failed units that belong to the stack", () => {
    const foreign = maintenance({
      failedUnits: {
        stack: [],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });
    const foreignSignals = maintenanceAlertSignals(foreign, "NAS-HOME");
    expect(signal(foreignSignals, "stack-unit-failed")).toMatchObject({
      failing: false,
    });
    expect(JSON.stringify(foreignSignals)).not.toContain("logrotate.service");

    const stack = maintenance({
      failedUnits: {
        stack: [{ name: "media-stack-upgrade.service", description: "Upgrade" }],
        other: [{ name: "logrotate.service", description: "Rotate logs" }],
      },
    });
    const stackSignals = maintenanceAlertSignals(stack, "NAS-HOME");
    const stackSignal = signal(stackSignals, "stack-unit-failed");
    expect(stackSignal).toMatchObject({ failing: true, severity: "critical" });
    expect(stackSignal?.detail).toContain("media-stack-upgrade.service");
    expect(stackSignal?.detail).not.toContain("logrotate.service");
  });

  it("ignores malformed or degraded snapshots instead of resolving alerts", () => {
    expect(maintenanceAlertSignals(null, "NAS-HOME")).toEqual([]);
    expect(maintenanceAlertSignals(undefined, "NAS-HOME")).toEqual([]);

    const degraded = maintenance({
      failedUnits: {
        stack: [{ name: "media-stack-upgrade.service", description: null }],
        other: [],
      },
      degraded: ["failedUnits"],
    });
    expect(
      signal(maintenanceAlertSignals(degraded, "NAS-HOME"), "stack-unit-failed"),
    ).toBeUndefined();
  });
});

describe("deployment alert signals", () => {
  it("opens a retained-release alert while a release is retained", () => {
    const retained = signal(
      deploymentAlertSignals(
        deployments({
          retained: [
            {
              release: "v2.5.0",
              reason: "missing-configuration",
              blockedBy: null,
              breaking: false,
              manualSteps: [],
              missingSettings: ["NEW_SETTING"],
              services: [],
              sourceCommit: null,
              at: "2026-11-13T02:00:00Z",
            },
          ],
        }),
        "NAS-HOME",
      ),
      "release-retained",
    );
    expect(retained).toMatchObject({ failing: true, severity: "warning" });
    expect(retained?.detail).toContain("v2.5.0");

    const clean = signal(
      deploymentAlertSignals(deployments(), "NAS-HOME"),
      "release-retained",
    );
    expect(clean).toMatchObject({ failing: false });
  });

  it("does not claim retention or failure when the checkout cannot be read", () => {
    const signals = deploymentAlertSignals(
      deployments({
        available: false,
        degraded: ["checkout"],
        retained: [],
      }),
      "NAS-HOME",
    );
    expect(signal(signals, "release-retained")).toBeUndefined();
  });

  it("keeps a failed deployment open until a later successful one", () => {
    const failed = deployments({
      history: [
        {
          release: "v2.5.0",
          outcome: "rolled-back",
          at: "2026-11-13T02:00:00Z",
          previousRelease: "v2.4.1",
          services: ["radarr"],
        },
      ],
    });
    expect(signal(deploymentAlertSignals(failed, "NAS-HOME"), "deploy-failed")).toMatchObject({
      failing: true,
      severity: "critical",
    });

    const recovered = deployments({
      history: [
        {
          release: "v2.5.1",
          outcome: "success",
          at: "2026-11-13T04:00:00Z",
          previousRelease: "v2.4.1",
          services: ["radarr"],
        },
        failed.history[0],
      ],
    });
    expect(
      signal(deploymentAlertSignals(recovered, "NAS-HOME"), "deploy-failed"),
    ).toMatchObject({ failing: false });
  });

  it("does not keep an old failed-release marker after a successful deploy", () => {
    const marker = deploymentAlertSignals(
      deployments({
        follower: {
          ...deployments().follower,
          state: "failed",
          failed: { release: "v2.5.0", since: "2026-11-13T02:00:00Z" },
        },
        history: [
          {
            release: "v2.5.1",
            outcome: "success",
            at: "2026-11-13T04:00:00Z",
            previousRelease: "v2.4.1",
            services: [],
          },
        ],
      }),
      "NAS-HOME",
    );
    expect(signal(marker, "deploy-failed")).toMatchObject({ failing: false });
  });

  it("reports a failed marker that has no recorded history yet", () => {
    const signals = deploymentAlertSignals(
      deployments({
        follower: {
          ...deployments().follower,
          state: "failed",
          failed: { release: "v2.5.0", since: "2026-11-13T02:00:00Z" },
        },
      }),
      "NAS-HOME",
    );
    expect(signal(signals, "deploy-failed")).toMatchObject({ failing: true });
  });

  it("resolves a failed attempt once a strictly newer release is installed", () => {
    const base = deployments();
    const signals = deploymentAlertSignals(
      deployments({
        follower: {
          ...base.follower,
          installed: { ...base.follower.installed!, release: "v2.5.1" },
          failed: { release: "v2.5.0", since: "2026-11-13T02:00:00Z" },
        },
        history: [],
      }),
      "NAS-HOME",
    );
    expect(signal(signals, "deploy-failed")).toMatchObject({ failing: false });
  });

  it("ignores a degraded follower section", () => {
    const signals = deploymentAlertSignals(
      deployments({
        degraded: ["follower"],
        follower: {
          ...deployments().follower,
          state: "unknown",
          available: false,
        },
      }),
      "NAS-HOME",
    );
    expect(signal(signals, "deploy-failed")).toBeUndefined();
    expect(signal(signals, "release-retained")).toBeUndefined();
  });
});
