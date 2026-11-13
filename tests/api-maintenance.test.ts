import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
      })),
    },
  },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));

type RecordedRequest = {
  path: string;
  authorization: string | undefined;
};

type FakeAgent = {
  url: string;
  token: string;
  requests: RecordedRequest[];
  fail: boolean;
  close(): Promise<void>;
};

function snapshot() {
  return {
    timestamp: 1_763_000_000,
    role: "instance",
    follower: {
      available: true,
      state: "idle",
      installed: {
        release: "v2.4.1",
        commit: "a".repeat(40),
        bootstrap: false,
        installedAt: "2026-11-13T10:00:00Z",
      },
      pending: null,
      failed: null,
    },
    security: {
      pins: [
        {
          service: "radarr",
          image: "radarr:5.27@sha256:" + "c".repeat(64),
          version: "5.27",
          digest: "sha256:" + "c".repeat(64),
        },
      ],
      pending: null,
      review: [],
    },
    backup: { status: "ok", at: "2026-11-13T03:04:49Z" },
    disks: {
      available: true,
      devices: [
        {
          device: "sda",
          model: "WDC WD40EFRX-68N32N0",
          serial: "WD-WCC7K0AAAAAA",
          kind: "sata",
          size: 4_000_787_030_016,
          temperature: 34,
          reallocatedSectors: 0,
          wear: null,
          status: "ok",
          issues: [],
        },
        {
          device: "nvme0n1",
          model: "Samsung SSD 970 EVO Plus 2TB",
          serial: "S4EWNX0R000001",
          kind: "nvme",
          size: 2_000_398_934_016,
          temperature: 41,
          reallocatedSectors: null,
          wear: 3,
          status: "ok",
          issues: [],
        },
      ],
    },
    units: [
      {
        name: "media-stack-merged-updates",
        kind: "follower",
        service: "media-stack-merged-updates.service",
        timer: "media-stack-merged-updates.timer",
        activeState: "active",
        subState: "waiting",
        unitFileState: "enabled",
        result: "success",
        state: "active",
        paused: false,
        lastRun: "2026-11-13T10:00:00Z",
        nextRun: "2026-11-13T10:05:00Z",
      },
      {
        name: "media-stack-evidence",
        kind: "automation",
        service: "media-stack-evidence.service",
        timer: "media-stack-evidence.timer",
        activeState: "inactive",
        subState: "dead",
        unitFileState: "disabled",
        result: "success",
        state: "paused",
        paused: true,
        lastRun: null,
        nextRun: null,
      },
    ],
    failedUnits: { stack: [], other: [] },
    reboot: { available: false, required: null },
    docker: {
      available: true,
      images: { count: 12, size: 42_000, reclaimable: 30_000 },
      containers: { count: 3, size: 500 },
      volumes: { count: 2, size: 1_500 },
      buildCache: { count: 4, size: 2_000 },
      total: 46_000,
      reclaimable: 31_000,
    },
    degraded: [],
  };
}

async function fakeAgent(token: string): Promise<FakeAgent> {
  const agent: FakeAgent = {
    token,
    url: "",
    requests: [],
    fail: false,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const server: Server = createServer((request, response) => {
    agent.requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: "No autorizado" });
    if (agent.fail) return send(503, { error: "El host no responde" });
    if (new URL(request.url ?? "/", "http://agent").pathname === "/maintenance")
      return send(200, snapshot());
    return send(404, { error: "No encontrado" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

describe("maintenance snapshot API", () => {
  let nas: FakeAgent;
  let apps: FakeAgent;
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(path: string) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    return routes.GET(
      new NextRequest(url, { method: "GET" }),
      { params: Promise.resolve({ path: route }) },
    );
  }

  beforeAll(async () => {
    nas = await fakeAgent("a".repeat(32));
    apps = await fakeAgent("b".repeat(32));
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: nas.url,
        token: nas.token,
      },
      {
        id: "apps",
        name: "Apps",
        role: "apps-server",
        url: apps.url,
        token: apps.token,
      },
    ]);
    routes = await import("../src/app/api/[...path]/route");
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.end();
    await nas.close();
    await apps.close();
    delete process.env.NAS_HOSTS;
  });

  beforeEach(() => {
    nas.requests = [];
    apps.requests = [];
    nas.fail = false;
    apps.fail = false;
  });

  it("returns the snapshot of the selected host without exposing its credentials", async () => {
    const response = await api("/api/maintenance?host=apps");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.host).toEqual({ id: "apps", name: "Apps", role: "apps-server" });
    expect(body.snapshot.follower.installed.release).toBe("v2.4.1");
    expect(body.snapshot.backup.status).toBe("ok");
    expect(body.snapshot.disks.available).toBe(true);
    expect(
      body.snapshot.disks.devices.map(
        (device: { device: string; status: string }) => [
          device.device,
          device.status,
        ],
      ),
    ).toEqual([
      ["sda", "ok"],
      ["nvme0n1", "ok"],
    ]);
    expect(
      body.snapshot.units.map((unit: { name: string }) => unit.name),
    ).toContain("media-stack-evidence");
    expect(body.snapshot.docker.reclaimable).toBe(31_000);
    expect(apps.requests).toEqual([
      {
        path: "/maintenance",
        authorization: `Bearer ${apps.token}`,
      },
    ]);
    expect(nas.requests).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(apps.token);
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });

  it("uses the primary host when no host is requested", async () => {
    const response = await api("/api/maintenance");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.host.id).toBe("nas-home");
    expect(nas.requests).toHaveLength(1);
    expect(apps.requests).toEqual([]);
  });

  it("rejects an unknown host without calling any agent", async () => {
    const response = await api("/api/maintenance?host=ghost");

    expect(response.status).toBe(404);
    expect(nas.requests).toEqual([]);
    expect(apps.requests).toEqual([]);
  });

  it("does not retry a host read that fails", async () => {
    apps.fail = true;

    const response = await api("/api/maintenance?host=apps");

    expect(response.status).toBe(503);
    expect(apps.requests).toHaveLength(1);
  });
});
