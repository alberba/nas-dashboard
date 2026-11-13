import type { DeploymentsSnapshot } from "@/lib/deployments";
import type { MaintenanceSnapshot } from "@/lib/maintenance";

/** A healthy instance maintenance snapshot, overridable per test. */
export function maintenanceSnapshot(
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

/** A healthy deployments snapshot, overridable per test. */
export function deploymentsSnapshot(
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

/** Healthy metrics with one running container, overridable per test. */
export function metricsSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: 1_763_040_000,
    hostname: "nas",
    cpu: 11,
    memory: { total: 1000, used: 250 },
    network: { rx: 10, tx: 20 },
    io: { read: 30, write: 40 },
    uptime: 1000,
    disks: [
      { name: "Volumen", root: "media", total: 100, used: 10, free: 90 },
    ],
    temperatures: [],
    containers: [
      {
        id: "c".repeat(64),
        name: "nas-service",
        image: "image:1",
        state: "running",
        status: "Up 1 hour",
        protected: false,
        cpu: 1,
        memory: 2,
      },
    ],
    ...overrides,
  };
}
