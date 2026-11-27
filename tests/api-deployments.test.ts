import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RESPONSE_LIMITS } from "../src/lib/nas";

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
  /** Answer /deployments over its cap, declared up front or streamed. */
  oversize: "declared" | "streamed" | null;
  close(): Promise<void>;
};

function snapshot() {
  return {
    timestamp: 1_763_000_000,
    role: "instance",
    available: true,
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
    blocker: {
      code: "dirty-checkout",
      release: null,
      files: [{ status: "M", path: "stacks/wire/compose.yaml", from: null }],
      missingSettings: [],
    },
    history: [
      {
        release: "v2.4.0",
        outcome: "success",
        at: "2026-11-13T09:00:00Z",
        previousRelease: "v2.3.0",
        services: ["radarr", "sonarr"],
      },
    ],
    retained: [
      {
        release: "v2.5.0",
        reason: "missing-configuration",
        blockedBy: null,
        breaking: false,
        manualSteps: ["Fill NEW_SETTING in .env."],
        missingSettings: ["NEW_SETTING"],
        services: ["radarr"],
        sourceCommit: "c".repeat(40),
        at: "2026-11-13T08:00:00Z",
      },
    ],
    journal: {
      entries: [
        {
          at: "2026-11-13T10:00:00Z",
          unit: "media-stack-merged-updates.service",
          priority: 6,
          level: "info",
          message: "v2.5.0 aplicada",
        },
      ],
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
    oversize: null,
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
    if (new URL(request.url ?? "/", "http://agent").pathname === "/deployments") {
      if (agent.oversize) {
        // Padded past the cap, carrying a marker that must never reach the browser.
        const pad = `{"marker":"agent-secret-marker","pad":"${"a".repeat(
          AGENT_RESPONSE_LIMITS.deployments,
        )}"}`;
        if (agent.oversize === "declared") {
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(pad),
          });
          return response.end(pad);
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        for (let at = 0; at < pad.length; at += 65_536)
          response.write(pad.slice(at, at + 65_536));
        return response.end();
      }
      return send(200, snapshot());
    }
    return send(404, { error: "No encontrado" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

describe("deployments API", () => {
  let nas: FakeAgent;
  let apps: FakeAgent;
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(path: string) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    return routes.GET(new NextRequest(url, { method: "GET" }), {
      params: Promise.resolve({ path: route }),
    });
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
    nas.oversize = null;
    apps.oversize = null;
  });

  it("returns the deployment snapshot of the selected host without credentials", async () => {
    const response = await api("/api/deployments?host=apps&lines=50");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.host).toEqual({ id: "apps", name: "Apps", role: "apps-server" });
    expect(body.deployments.blocker.code).toBe("dirty-checkout");
    expect(body.deployments.blocker.files[0].path).toBe(
      "stacks/wire/compose.yaml",
    );
    expect(body.deployments.retained[0].missingSettings).toEqual([
      "NEW_SETTING",
    ]);
    expect(body.deployments.history[0].services).toEqual(["radarr", "sonarr"]);
    expect(body.deployments.journal.entries[0].unit).toBe(
      "media-stack-merged-updates.service",
    );
    expect(apps.requests).toEqual([
      {
        path: "/deployments?lines=50",
        authorization: `Bearer ${apps.token}`,
      },
    ]);
    expect(nas.requests).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(apps.token);
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });

  it("asks for the default journal tail and uses the primary host", async () => {
    const response = await api("/api/deployments");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.host.id).toBe("nas-home");
    expect(nas.requests).toHaveLength(1);
    expect(nas.requests[0].path).toBe("/deployments?lines=100");
    expect(apps.requests).toEqual([]);
  });

  it("rejects an invalid journal tail without calling the agent", async () => {
    for (const value of ["many", "0", "501"]) {
      const response = await api(`/api/deployments?lines=${value}`);

      expect(response.status, value).toBe(400);
    }
    expect(nas.requests).toEqual([]);
    expect(apps.requests).toEqual([]);
  });

  it("rejects an unknown host without calling any agent", async () => {
    const response = await api("/api/deployments?host=ghost");

    expect(response.status).toBe(404);
    expect(nas.requests).toEqual([]);
    expect(apps.requests).toEqual([]);
  });

  it("does not retry a host read that fails", async () => {
    apps.fail = true;

    const response = await api("/api/deployments?host=apps");

    expect(response.status).toBe(503);
    expect(apps.requests).toHaveLength(1);
  });

  it("answers 502 with a stable code when the agent response is over its cap", async () => {
    for (const mode of ["declared", "streamed"] as const) {
      apps.oversize = mode;
      const response = await api("/api/deployments?host=apps");

      expect(response.status, mode).toBe(502);
      const text = await response.text();
      expect(JSON.parse(text).code, mode).toBe("agent_response_too_large");
      expect(text, mode).not.toContain("agent-secret-marker");
      expect(text, mode).not.toContain("deployments\":");

      apps.oversize = null;
      const next = await api("/api/deployments?host=apps");
      expect(next.status, mode).toBe(200);
    }
  });
});
