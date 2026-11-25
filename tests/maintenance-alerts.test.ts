import { describe, expect, it } from "vitest";
import {
  deploymentAlertSignals,
  maintenanceAlertSignals,
  type AlertSignal,
} from "@/lib/maintenance-alerts";
import {
  notificationPolicy,
  pushWarningsEnabled,
} from "@/lib/notification-policy";
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

  it("keeps the disk condition when a carrier reports an unknown status", () => {
    const base = maintenance().disks.devices[0];
    const mixed = maintenanceAlertSignals(
      maintenance({
        disks: {
          available: true,
          devices: [
            { ...base, status: "ok" },
            { ...base, device: "sdb", status: "unknown", issues: ["smart_unavailable"] },
          ],
        },
      }),
      "NAS-HOME",
    );
    expect(signal(mixed, "disk-health")).toBeUndefined();

    const allUnknown = maintenanceAlertSignals(
      maintenance({
        disks: {
          available: true,
          devices: [
            { ...base, status: "unknown", issues: ["smart_unavailable"] },
          ],
        },
      }),
      "NAS-HOME",
    );
    expect(signal(allUnknown, "disk-health")).toBeUndefined();

    const failing = maintenanceAlertSignals(
      maintenance({
        disks: {
          available: true,
          devices: [
            { ...base, status: "ok" },
            { ...base, device: "sdb", status: "watch", issues: ["wear"] },
          ],
        },
      }),
      "NAS-HOME",
    );
    expect(signal(failing, "disk-health")).toMatchObject({
      failing: true,
      severity: "warning",
    });
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
              secretSettings: [],
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

  it("does not claim retention from a missing or malformed retained list", () => {
    const missing = deploymentAlertSignals(
      deployments({
        retained: undefined as unknown as DeploymentsSnapshot["retained"],
      }),
      "NAS-HOME",
    );
    expect(signal(missing, "release-retained")).toBeUndefined();

    const malformed = deploymentAlertSignals(
      deployments({
        retained: [
          { release: 42 } as unknown as DeploymentsSnapshot["retained"][number],
        ],
      }),
      "NAS-HOME",
    );
    expect(signal(malformed, "release-retained")).toBeUndefined();
  });

  it("does not claim health from an empty or missing deployment history", () => {
    const empty = deploymentAlertSignals(
      deployments({ history: [] }),
      "NAS-HOME",
    );
    expect(signal(empty, "deploy-failed")).toBeUndefined();

    const missing = deploymentAlertSignals(
      deployments({
        history: undefined as unknown as DeploymentsSnapshot["history"],
      }),
      "NAS-HOME",
    );
    expect(signal(missing, "deploy-failed")).toBeUndefined();
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

describe("notification policy", () => {
  it("keeps the audited immediate keys and the disk escalation", () => {
    for (const key of [
      "connection",
      "temperature",
      "backup-failed",
      "stack-unit-failed",
      "deploy-failed",
    ]) {
      expect(notificationPolicy(key, "critical", { pushWarnings: false })).toMatchObject({
        channel: "telegram",
        reason: "policy_immediate",
        digest: false,
        immediate: true,
      });
    }
    expect(
      notificationPolicy("disk-health", "warning", { pushWarnings: false }),
    ).toMatchObject({
      channel: "digest",
      reason: "digest_pending",
      digest: true,
      immediate: false,
    });
    expect(
      notificationPolicy("disk-health", "critical", { pushWarnings: false }),
    ).toMatchObject({
      channel: "telegram",
      reason: "policy_immediate",
      digest: false,
      immediate: true,
    });
  });

  it("sends the audited digest keys to the digest", () => {
    for (const key of [
      "cpu",
      "memory",
      "disk",
      "reboot-pending",
      "release-retained",
    ]) {
      expect(
        notificationPolicy(key, "warning", { pushWarnings: false }),
      ).toMatchObject({
        channel: "digest",
        reason: "digest_pending",
        digest: true,
        immediate: false,
      });
    }
  });

  it("keeps the container family silent at any severity", () => {
    expect(
      notificationPolicy("container:radarr", "critical", {
        pushWarnings: true,
      }),
    ).toMatchObject({
      channel: "silent",
      reason: "policy_silent",
      digest: false,
      immediate: false,
    });
  });

  it("replaces only eligible warnings with push when PUSH_WARNINGS is enabled", () => {
    expect(
      notificationPolicy("cpu", "warning", { pushWarnings: false }),
    ).toMatchObject({ channel: "digest" });
    expect(
      notificationPolicy("cpu", "warning", { pushWarnings: true }),
    ).toMatchObject({
      channel: "push",
      reason: "policy_immediate",
      digest: true,
      immediate: true,
    });
    expect(
      notificationPolicy("disk-health", "warning", { pushWarnings: true }),
    ).toMatchObject({ channel: "push" });
    expect(
      notificationPolicy("connection", "critical", { pushWarnings: true }),
    ).toMatchObject({ channel: "telegram" });
    expect(
      notificationPolicy("container:radarr", "warning", {
        pushWarnings: true,
      }),
    ).toMatchObject({ channel: "silent" });
  });

  it("reads the opt-in from PUSH_WARNINGS with a false default", () => {
    expect(pushWarningsEnabled(undefined)).toBe(false);
    expect(pushWarningsEnabled("")).toBe(false);
    expect(pushWarningsEnabled("false")).toBe(false);
    expect(pushWarningsEnabled("0")).toBe(false);
    expect(pushWarningsEnabled("true")).toBe(true);
    expect(pushWarningsEnabled("1")).toBe(true);

    const previous = process.env.PUSH_WARNINGS;
    delete process.env.PUSH_WARNINGS;
    try {
      expect(notificationPolicy("cpu", "warning")).toMatchObject({
        channel: "digest",
      });
    } finally {
      if (previous === undefined) delete process.env.PUSH_WARNINGS;
      else process.env.PUSH_WARNINGS = previous;
    }
  });
});

describe("helper cleanup alerts", () => {
  function cleanup(
    overrides: Partial<
      NonNullable<MaintenanceSnapshot["helperCleanup"]>
    > = {},
  ) {
    return maintenance({
      helperCleanup: {
        available: true,
        status: "persistent",
        checkedAt: "2026-11-13T10:05:00Z",
        pending: 2,
        persistent: 1,
        ...overrides,
      },
    });
  }

  it("opens a single digest episode only for a persistent failure", () => {
    const persistent = signal(
      maintenanceAlertSignals(cleanup(), "NAS-HOME"),
      "helper-cleanup",
    );
    expect(persistent).toMatchObject({
      key: "helper-cleanup",
      failing: true,
      severity: "warning",
    });
    expect(persistent?.detail).toContain("2 ayudantes pendientes");
    expect(persistent?.detail).toContain("1 con varios intentos");

    const first = signal(
      maintenanceAlertSignals(
        cleanup({ status: "failing", persistent: 0, pending: 1 }),
        "NAS-HOME",
      ),
      "helper-cleanup",
    );
    expect(first).toBeUndefined();

    const indeterminate = signal(
      maintenanceAlertSignals(
        cleanup({
          status: "indeterminate",
          checkedAt: null,
          persistent: 0,
          pending: 0,
        }),
        "NAS-HOME",
      ),
      "helper-cleanup",
    );
    expect(indeterminate).toBeUndefined();
  });

  it("keeps a known persistent failure while the inventory is indeterminate", () => {
    const known = signal(
      maintenanceAlertSignals(
        cleanup({
          status: "indeterminate",
          pending: 1,
          persistent: 1,
        }),
        "NAS-HOME",
      ),
      "helper-cleanup",
    );
    expect(known).toMatchObject({ failing: true });

    const first = signal(
      maintenanceAlertSignals(
        cleanup({
          status: "indeterminate",
          pending: 1,
          persistent: 0,
        }),
        "NAS-HOME",
      ),
      "helper-cleanup",
    );
    expect(first).toBeUndefined();
  });

  it("keeps a first failure and an incomplete inventory out of the incident", () => {
    const scattered = signal(
      maintenanceAlertSignals(
        cleanup({ status: "failing", persistent: 0, pending: 2 }),
        "NAS-HOME",
      ),
      "helper-cleanup",
    );
    expect(scattered).toBeUndefined();

    const degraded = signal(
      maintenanceAlertSignals(
        maintenance({
          helperCleanup: {
            available: true,
            status: "persistent",
            checkedAt: "2026-11-13T10:05:00Z",
            pending: 1,
            persistent: 1,
          },
          degraded: ["helperCleanup"],
        }),
        "NAS-HOME",
      ),
      "helper-cleanup",
    );
    expect(degraded).toBeUndefined();

    expect(
      signal(
        maintenanceAlertSignals(maintenance(), "NAS-HOME"),
        "helper-cleanup",
      ),
    ).toBeUndefined();
  });

  it("only closes on a clean state backed by a complete inventory", () => {
    const recovered = signal(
      maintenanceAlertSignals(
        cleanup({ status: "clean", pending: 0, persistent: 0 }),
        "NAS-HOME",
      ),
      "helper-cleanup",
    );
    expect(recovered).toMatchObject({ failing: false });
  });

  it("ignores a cleanup check older than the last accredited one", () => {
    const stale = maintenanceAlertSignals(
      cleanup(),
      "NAS-HOME",
      { helperCleanupAfter: Date.parse("2026-11-13T10:06:00Z") },
    );
    expect(signal(stale, "helper-cleanup")).toBeUndefined();

    const fresh = maintenanceAlertSignals(
      cleanup({ checkedAt: "2026-11-13T10:07:00Z" }),
      "NAS-HOME",
      { helperCleanupAfter: Date.parse("2026-11-13T10:06:00Z") },
    );
    expect(signal(fresh, "helper-cleanup")).toMatchObject({ failing: true });
  });

  it("keeps helper cleanup in the digest even with PUSH_WARNINGS", () => {
    expect(
      notificationPolicy("helper-cleanup", "warning", {
        pushWarnings: true,
      }),
    ).toEqual({
      channel: "digest",
      reason: "digest_pending",
      digest: true,
      immediate: false,
    });
  });
});
