import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetGithubCaches } from "@/lib/github";
import type { Container } from "@/lib/types";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

const session = vi.hoisted(() => ({
  value: {
    user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
    session: { id: "session-1" },
  } as {
    user: { id: string; name: string; email: string };
    session: { id: string };
  } | null,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => session.value) } },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));

const token = "github_pat_test_only";
const repository = "alberba/media-stack";
const headSha = "1".repeat(40);
const mergedHead = "9".repeat(40);
const mergeCommit = "e".repeat(40);

type RecordedGithubRequest = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
};

type CheckRun = { status: string; conclusion: string | null; name: string };

type GithubFixture = {
  openPulls: unknown[];
  closedPulls: unknown[];
  pullDetails: Record<number, unknown>;
  files: Record<number, unknown[]>;
  checks: Record<string, CheckRun[]>;
  releases: unknown[];
  manifests: Record<string, unknown>;
  compares: Record<string, string>;
  mergeMode: "ok" | "reject" | "uncertain";
  failStatus: number | null;
};

type FakeGithub = {
  url: string;
  token: string;
  requests: RecordedGithubRequest[];
  fixture: GithubFixture;
  reset(): void;
  close(): Promise<void>;
};

type RecordedAgentRequest = {
  method: string;
  path: string;
  body: unknown;
};

type FakeAgent = {
  url: string;
  token: string;
  requests: RecordedAgentRequest[];
  snapshot: unknown;
  maintenanceBehaviour: "ok" | "fail";
  commandBehaviour: "ok" | "reject" | "uncertain";
  reset(): void;
  close(): Promise<void>;
};

function renovateBody(automerge: boolean) {
  return [
    "This PR contains the following updates:",
    "",
    "| Package | Update | Change |",
    "|---|---|---|",
    "| lscr.io/linuxserver/radarr | patch | `6.4.4.10685-ls320` → `6.4.4.10685-ls325` |",
    "",
    `🚦 **Automerge**: ${automerge ? "Enabled" : "Disabled by config."}`,
  ].join("\n");
}

function pull(
  number: number,
  options: {
    sha: string;
    title: string;
    branch: string;
    body: string;
    mergedAt?: string | null;
    mergeCommitSha?: string | null;
    headRef?: string;
  },
) {
  return {
    number,
    title: options.title,
    html_url: `https://github.com/${repository}/pull/${number}`,
    state: options.mergedAt ? "closed" : "open",
    draft: false,
    user: { login: "renovate[bot]" },
    head: { ref: options.branch, sha: options.sha },
    base: { ref: "main", sha: "b".repeat(40) },
    body: options.body,
    merged: Boolean(options.mergedAt),
    merged_at: options.mergedAt ?? null,
    merge_commit_sha: options.mergeCommitSha ?? null,
  };
}

const radarrPatch = [
  "@@ -3,7 +3,7 @@",
  " services:",
  "   radarr:",
  "-    image: lscr.io/linuxserver/radarr:6.4.4.10685-ls320",
  "+    image: lscr.io/linuxserver/radarr:6.4.4.10685-ls325",
  "     container_name: radarr",
].join("\n");

const seerrPatch = [
  "@@ -2,7 +2,7 @@",
  " services:",
  "   seerr:",
  "-    image: ghcr.io/seerr-team/seerr:v3.5.1",
  "+    image: ghcr.io/seerr-team/seerr:v3.5.2",
  "     container_name: seerr",
].join("\n");

function file(filename: string, patch: string) {
  return { filename, status: "modified", additions: 1, deletions: 1, patch };
}

function fixture(): GithubFixture {
  const mergedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const oldMergedAt = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
  return {
    openPulls: [
      pull(88, {
        sha: "8".repeat(40),
        title: "chore(deps): update radarr",
        branch: "renovate/lscr.io-linuxserver-radarr-6.x",
        body: renovateBody(true),
      }),
    ],
    closedPulls: [
      pull(90, {
        sha: mergedHead,
        title: "chore(deps): update seerr",
        branch: "renovate/ghcr.io-seerr-team-seerr-3.x",
        body: renovateBody(true),
        mergedAt,
        mergeCommitSha: mergeCommit,
      }),
      pull(91, {
        sha: "7".repeat(40),
        title: "chore(deps): closed without merge",
        branch: "renovate/closed",
        body: renovateBody(true),
      }),
      pull(92, {
        sha: "6".repeat(40),
        title: "chore(deps): old merge",
        branch: "renovate/old",
        body: renovateBody(true),
        mergedAt: oldMergedAt,
        mergeCommitSha: "5".repeat(40),
      }),
    ],
    pullDetails: {
      100: {
        number: 100,
        title: "chore(deps): update radarr",
        html_url: `https://github.com/${repository}/pull/100`,
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        merged_at: null,
        merge_commit_sha: null,
        user: { login: "renovate[bot]" },
        head: {
          ref: "renovate/lscr.io-linuxserver-radarr-6.x",
          sha: headSha,
        },
        base: { ref: "main", sha: "b".repeat(40) },
        body: renovateBody(false),
      },
    },
    files: {
      88: [
        file("stacks/arr/compose.yaml", radarrPatch),
      ],
      90: [
        file("stacks/seerr/compose.yaml", seerrPatch),
      ],
    },
    checks: {
      ["8".repeat(40)]: [
        { status: "completed", conclusion: "success", name: "validate" },
      ],
      [mergedHead]: [
        { status: "completed", conclusion: "success", name: "validate" },
      ],
      [mergeCommit]: [
        { status: "completed", conclusion: "success", name: "validate" },
      ],
      [headSha]: [
        { status: "completed", conclusion: "success", name: "validate" },
      ],
    },
    releases: [
      {
        tag_name: "v2.5.0",
        html_url: `https://github.com/${repository}/releases/tag/v2.5.0`,
        draft: false,
        prerelease: false,
        published_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ],
    manifests: {
      "v2.5.0": {
        schema: 1,
        approved_merge: true,
        source_commit: mergeCommit,
        roles: ["instance", "apps-server"],
      },
    },
    compares: {},
    mergeMode: "ok",
    failStatus: null,
  };
}

async function fakeGithub(): Promise<FakeGithub> {
  const github: FakeGithub = {
    url: "",
    token,
    requests: [],
    fixture: fixture(),
    reset() {
      github.requests = [];
      github.fixture = fixture();
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    github.requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      body: raw ? JSON.parse(raw) : undefined,
      authorization: request.headers.authorization,
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (github.fixture.failStatus)
      return send(github.fixture.failStatus, { message: "Unavailable" });
    if (request.headers.authorization !== `Bearer ${github.token}`)
      return send(401, { message: "Bad credentials" });
    const url = new URL(request.url ?? "/", "http://github");
    const prefix = `/repos/${repository}`;

    if (url.pathname === `${prefix}/pulls`) {
      const state = url.searchParams.get("state");
      return send(
        200,
        state === "closed"
          ? github.fixture.closedPulls
          : github.fixture.openPulls,
      );
    }
    const merge = url.pathname.match(
      new RegExp(`^${prefix}/pulls/(\\d+)/merge$`),
    );
    if (merge && request.method === "PUT") {
      if (github.fixture.mergeMode === "uncertain") {
        response.destroy();
        return;
      }
      if (github.fixture.mergeMode === "reject")
        return send(405, { message: "Pull Request is not mergeable" });
      return send(200, {
        sha: "4".repeat(40),
        merged: true,
        message: "Pull Request successfully merged",
      });
    }
    const files = url.pathname.match(
      new RegExp(`^${prefix}/pulls/(\\d+)/files$`),
    );
    if (files)
      return send(200, github.fixture.files[Number(files[1])] ?? []);
    const detail = url.pathname.match(new RegExp(`^${prefix}/pulls/(\\d+)$`));
    if (detail) {
      const value = github.fixture.pullDetails[Number(detail[1])];
      return value ? send(200, value) : send(404, { message: "Not Found" });
    }
    const checks = url.pathname.match(
      new RegExp(`^${prefix}/commits/([a-f0-9]+)/check-runs$`),
    );
    if (checks)
      return send(200, {
        total_count: (github.fixture.checks[checks[1]] ?? []).length,
        check_runs: github.fixture.checks[checks[1]] ?? [],
      });
    if (url.pathname === `${prefix}/releases`)
      return send(200, github.fixture.releases);
    const contents = url.pathname.match(
      new RegExp(`^${prefix}/contents/docs/releases/([^/]+)\\.deploy\\.json$`),
    );
    if (contents) {
      const tag = decodeURIComponent(contents[1]);
      const manifest = github.fixture.manifests[tag];
      if (!manifest) return send(404, { message: "Not Found" });
      return send(200, {
        encoding: "base64",
        content: Buffer.from(JSON.stringify(manifest)).toString("base64"),
      });
    }
    const compare = url.pathname.match(
      new RegExp(`^${prefix}/compare/([a-f0-9]+)\\.\\.\\.([a-f0-9]+)$`),
    );
    if (compare)
      return send(200, {
        status:
          github.fixture.compares[`${compare[1]}...${compare[2]}`] ??
          "ahead",
      });
    return send(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  github.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return github;
}

function snapshot({
  installed = "v2.5.0",
  pending = null,
  failed = null,
}: {
  installed?: string | null;
  pending?: string | null;
  failed?: string | null;
} = {}) {
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
            changed: ["seerr"],
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

async function fakeAgent(agentToken: string): Promise<FakeAgent> {
  const agent: FakeAgent = {
    url: "",
    token: agentToken,
    requests: [],
    snapshot: snapshot(),
    maintenanceBehaviour: "ok",
    commandBehaviour: "ok",
    reset() {
      agent.requests = [];
      agent.snapshot = snapshot();
      agent.maintenanceBehaviour = "ok";
      agent.commandBehaviour = "ok";
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    if (request.headers.authorization !== `Bearer ${agentToken}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "No autorizado" }));
      return;
    }
    const path = new URL(request.url ?? "/", "http://agent").pathname;
    agent.requests.push({ method: request.method ?? "", path, body });
    if (path === "/maintenance") {
      if (agent.maintenanceBehaviour === "fail") {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "No disponible" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(agent.snapshot));
      return;
    }
    if (path === "/command") {
      if (agent.commandBehaviour === "uncertain") {
        response.destroy();
        return;
      }
      if (agent.commandBehaviour === "reject") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "La unidad no está configurada" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          command: (body as { command: string }).command,
          status: "success",
        }),
      );
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "No encontrado" }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}

function metrics(containers: Container[]) {
  return {
    timestamp: Date.now() / 1000,
    hostname: "nas",
    cpu: 10,
    memory: { total: 1000, used: 250 },
    network: { rx: 1, tx: 1 },
    io: { read: 1, write: 1 },
    uptime: 1000,
    disks: [],
    temperatures: [],
    containers,
  };
}

function container(
  name: string,
  image: string,
  service: string,
  status = "Up 1 hour (healthy)",
): Container {
  return {
    id: name.padEnd(64, "0").slice(0, 64),
    name,
    image,
    state: "running",
    status,
    protected: false,
    composeProject: "media-stack",
    composeService: service,
    oneShot: false,
    exitCode: null,
    orphan: false,
    recreateOnCompose: false,
    cpu: 1,
    memory: 2,
    compose: { project: "media-stack", service },
  };
}

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)("merge and deploy progress API", () => {
  let context: TestDatabase;
  let github: FakeGithub;
  let agent: FakeAgent;
  let db: typeof import("@/lib/db").db;
  let pool: typeof import("@/lib/db").pool;
  let tables: typeof import("@/lib/schema");
  let routes: typeof import("../src/app/api/[...path]/route");

  async function api(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const url = new URL(`http://localhost${path}`);
    const route = url.pathname.replace(/^\/api\//, "").split("/");
    const method = options.method ?? "GET";
    const request = new NextRequest(url, {
      method,
      headers: {
        Origin: "http://localhost:3000",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return (method === "GET" ? routes.GET : routes.POST)(request, {
      params: Promise.resolve({ path: route }),
    });
  }

  function merge(
    body: Record<string, unknown> = {
      number: 100,
      headSha,
      deployNow: false,
    },
    key: string | null = crypto.randomUUID(),
    headers: Record<string, string> = {},
  ) {
    return api("/api/renovate/merge?host=nas-home", {
      method: "POST",
      body,
      headers: {
        ...(key ? { "Idempotency-Key": key } : {}),
        ...headers,
      },
    });
  }

  async function seedSample(status = "Up 1 hour (healthy)") {
    await db.delete(tables.samples);
    await db.insert(tables.samples).values({
      hostId: "nas-home",
      at: new Date(),
      data: metrics([
        container(
          "seerr",
          "ghcr.io/seerr-team/seerr:v3.5.2",
          "seerr",
          status,
        ),
        container(
          "radarr",
          "lscr.io/linuxserver/radarr:6.4.4.10685-ls325",
          "radarr",
        ),
      ]) as never,
    });
  }

  beforeAll(async () => {
    github = await fakeGithub();
    agent = await fakeAgent("a".repeat(32));
    process.env.NAS_HOSTS = JSON.stringify([
      {
        id: "nas-home",
        name: "NAS-HOME",
        role: "instance",
        url: agent.url,
        token: agent.token,
      },
    ]);
    process.env.GITHUB_TOKEN = token;
    process.env.GITHUB_REPOSITORY = repository;
    process.env.GITHUB_API_URL = github.url;
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    context = await createTestDatabase(baseUrl!);
    process.env.DATABASE_URL = context.url;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const database = await import("@/lib/db");
    db = database.db;
    pool = database.pool;
    await migrate(db, { migrationsFolder: "./drizzle" });
    tables = await import("@/lib/schema");
    routes = await import("../src/app/api/[...path]/route");
  });

  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(context);
    await github.close();
    await agent.close();
    delete process.env.NAS_HOSTS;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_API_URL;
    delete process.env.BETTER_AUTH_URL;
  });

  beforeEach(async () => {
    session.value = {
      user: { id: "test-user", name: "Test", email: "test@hub.invalid" },
      session: { id: "session-1" },
    };
    github.reset();
    agent.reset();
    resetGithubCaches();
    await db.delete(tables.operations);
    await db.delete(tables.recentVerification);
    await db.delete(tables.session);
    await db.delete(tables.samples);
    await db
      .insert(tables.user)
      .values({
        id: "test-user",
        name: "Test",
        email: "test@hub.invalid",
      })
      .onConflictDoNothing();
    await db.insert(tables.session).values({
      id: "session-1",
      token: "session-token-1",
      userId: "test-user",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await db.insert(tables.recentVerification).values({
      sessionId: "session-1",
      userId: "test-user",
      method: "passkey",
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    await seedSample();
  });

  describe("merge", () => {
    it("requires a recent verification before touching GitHub", async () => {
      await db.delete(tables.recentVerification);

      const response = await merge();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "recent_verification_required",
        reason: "missing",
        method: "passkey",
      });
      expect(
        github.requests.some((entry) => entry.method === "PUT"),
      ).toBe(false);
      expect(agent.requests).toEqual([]);
      expect(await db.select().from(tables.operations)).toEqual([]);
    });

    it("rejects the merge when the head SHA changed since the Operator saw it", async () => {
      const response = await merge({
        number: 100,
        headSha: "2".repeat(40),
        deployNow: false,
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "sha_changed" });
      expect(
        github.requests.some((entry) => entry.method === "PUT"),
      ).toBe(false);
      expect(await db.select().from(tables.operations)).toEqual([]);
    });

    it("rejects the merge when CI is not green on that SHA", async () => {
      github.fixture.checks[headSha] = [
        { status: "completed", conclusion: "failure", name: "validate" },
      ];

      const response = await merge();

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "ci_not_green" });
      expect(
        github.requests.some((entry) => entry.method === "PUT"),
      ).toBe(false);
      expect(await db.select().from(tables.operations)).toEqual([]);
    });

    it("rejects the merge when the pull request is not mergeable", async () => {
      const detail = github.fixture.pullDetails[100] as {
        mergeable: boolean;
      };
      detail.mergeable = false;

      const response = await merge();

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "not_mergeable" });
      expect(
        github.requests.some((entry) => entry.method === "PUT"),
      ).toBe(false);
    });

    it("merges with squash using the exact SHA and records the operation", async () => {
      const response = await merge();

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: true,
        status: "success",
        merge: { merged: true },
        deploy: null,
      });
      const put = github.requests.find((entry) => entry.method === "PUT");
      expect(put?.body).toEqual({ merge_method: "squash", sha: headSha });
      expect(JSON.stringify(body)).not.toContain(token);
      const [operation] = await db.select().from(tables.operations);
      expect(operation).toMatchObject({
        hostId: "nas-home",
        action: "merge",
        target: "#100",
        status: "success",
      });
      expect(agent.requests).toEqual([]);
    });

    it("launches deploy-now once after a successful merge", async () => {
      const response = await merge({
        number: 100,
        headSha,
        deployNow: true,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: "success",
        deploy: { status: "success" },
      });
      expect(
        agent.requests.filter((entry) => entry.path === "/command"),
      ).toEqual([
        {
          method: "POST",
          path: "/command",
          body: { command: "deploy-now" },
        },
      ]);
      const rows = await db.select().from(tables.operations);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.action).sort()).toEqual([
        "deploy-now",
        "merge",
      ]);
      expect(rows.every((row) => row.status === "success")).toBe(true);
    });

    it("records a GitHub rejection as failed and never retries it", async () => {
      github.fixture.mergeMode = "reject";

      const response = await merge();

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        status: "failed",
        code: "merge_rejected",
      });
      expect(
        github.requests.filter((entry) => entry.method === "PUT"),
      ).toHaveLength(1);
      const [operation] = await db.select().from(tables.operations);
      expect(operation.status).toBe("failed");
      expect(agent.requests).toEqual([]);
    });

    it("leaves an uncertain merge pending and never sends it twice", async () => {
      github.fixture.mergeMode = "uncertain";
      const key = crypto.randomUUID();

      const response = await merge(
        { number: 100, headSha, deployNow: true },
        key,
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ status: "pending" });
      expect(
        github.requests.filter((entry) => entry.method === "PUT"),
      ).toHaveLength(1);
      expect(agent.requests).toEqual([]);

      github.fixture.mergeMode = "ok";
      const replay = await merge(
        { number: 100, headSha, deployNow: true },
        key,
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        status: "pending",
        replayed: true,
      });
      expect(
        github.requests.filter((entry) => entry.method === "PUT"),
      ).toHaveLength(1);
      expect(agent.requests).toEqual([]);
      expect(await db.select().from(tables.operations)).toHaveLength(1);
    });

    it("replays a successful merge without merging or deploying again", async () => {
      const key = crypto.randomUUID();
      const first = await merge(
        { number: 100, headSha, deployNow: true },
        key,
      );
      expect(first.status).toBe(200);

      const replay = await merge(
        { number: 100, headSha, deployNow: true },
        key,
      );

      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        status: "success",
        replayed: true,
      });
      expect(
        github.requests.filter((entry) => entry.method === "PUT"),
      ).toHaveLength(1);
      expect(
        agent.requests.filter((entry) => entry.path === "/command"),
      ).toHaveLength(1);
      expect(await db.select().from(tables.operations)).toHaveLength(2);
    });

    it("keeps the merge successful when the host is disconnected for deploy-now", async () => {
      await db.delete(tables.samples);

      const response = await merge({
        number: 100,
        headSha,
        deployNow: true,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: "success",
        deploy: { status: "unavailable" },
      });
      expect(agent.requests).toEqual([]);
      const rows = await db.select().from(tables.operations);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "merge", status: "success" });
    });

    it("keeps the merge successful when the optional deploy result is uncertain", async () => {
      agent.commandBehaviour = "uncertain";

      const response = await merge({
        number: 100,
        headSha,
        deployNow: true,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: "success",
        deploy: { status: "pending" },
      });
      const rows = await db.select().from(tables.operations);
      const deploy = rows.find((row) => row.action === "deploy-now");
      expect(deploy?.status).toBe("pending");
      expect(
        agent.requests.filter((entry) => entry.path === "/command"),
      ).toHaveLength(1);
    });

    it("requires an allowed origin and an idempotency key", async () => {
      const wrongOrigin = await merge(
        { number: 100, headSha, deployNow: false },
        crypto.randomUUID(),
        { Origin: "https://evil.invalid" },
      );
      expect(wrongOrigin.status).toBe(403);
      expect(github.requests).toEqual([]);

      const noKey = await merge(
        { number: 100, headSha, deployNow: false },
        null,
      );
      expect(noKey.status).toBe(400);
      expect(
        github.requests.some((entry) => entry.method === "PUT"),
      ).toBe(false);
      expect(await db.select().from(tables.operations)).toEqual([]);
    });

    it("fails closed when GitHub is not configured", async () => {
      delete process.env.GITHUB_TOKEN;
      try {
        const response = await merge();
        expect(response.status).toBe(503);
        expect(github.requests).toEqual([]);
      } finally {
        process.env.GITHUB_TOKEN = token;
      }
    });
  });

  describe("progress", () => {
    function stepStates(update: { steps: { id: string; state: string }[] }) {
      return Object.fromEntries(
        update.steps.map((step) => [step.id, step.state]),
      );
    }

    it("shows open and recently merged pull requests with all six steps", async () => {
      const response = await api("/api/renovate/progress?host=nas-home");

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        enabled: true,
        repository,
        host: { id: "nas-home", role: "instance" },
        snapshotAvailable: true,
      });
      expect(JSON.stringify(body)).not.toContain(token);
      expect(body.updates.map((update: { number: number }) => update.number)).toEqual([
        88, 90,
      ]);
      const open = body.updates.find(
        (update: { number: number }) => update.number === 88,
      );
      expect(open).toMatchObject({
        state: "open",
        automerge: true,
        currentStep: "merge",
        prCi: "success",
        mainCi: null,
        release: null,
        updates: [
          {
            service: "radarr",
            from: "6.4.4.10685-ls320",
            to: "6.4.4.10685-ls325",
          },
        ],
      });
      expect(stepStates(open)).toEqual({
        pr: "done",
        merge: "current",
        ci: "pending",
        release: "pending",
        deploy: "pending",
        health: "pending",
      });
      const merged = body.updates.find(
        (update: { number: number }) => update.number === 90,
      );
      expect(merged).toMatchObject({
        state: "merged",
        currentStep: "health",
        mainCi: "success",
        release: { tag: "v2.5.0", roles: ["instance", "apps-server"] },
        containers: [
          { name: "seerr", project: "media-stack", service: "seerr" },
        ],
      });
      expect(stepStates(merged)).toEqual({
        pr: "done",
        merge: "done",
        ci: "done",
        release: "done",
        deploy: "done",
        health: "done",
      });
      expect(
        github.requests.every((entry) => entry.method === "GET"),
      ).toBe(true);
    });

    it("shows an automerge pull request while the follower deploys it", async () => {
      agent.snapshot = snapshot({ installed: "v2.4.1", pending: "v2.5.0" });

      const body = await (
        await api("/api/renovate/progress?host=nas-home")
      ).json();
      const merged = body.updates.find(
        (update: { number: number }) => update.number === 90,
      );

      expect(merged.state).toBe("merged");
      expect(merged.automerge).toBe(true);
      expect(merged.currentStep).toBe("deploy");
      expect(stepStates(merged)).toMatchObject({
        release: "done",
        deploy: "current",
        health: "pending",
      });
    });

    it("reports a failed deployment that was restored", async () => {
      agent.snapshot = snapshot({ installed: "v2.4.1", failed: "v2.5.0" });

      const body = await (
        await api("/api/renovate/progress?host=nas-home")
      ).json();
      const merged = body.updates.find(
        (update: { number: number }) => update.number === 90,
      );

      expect(merged.failed).toBe(true);
      expect(merged.restored).toBe(true);
      expect(stepStates(merged)).toMatchObject({
        deploy: "failed",
        health: "failed",
      });
    });

    it("fails the health step when an affected container is unhealthy", async () => {
      await seedSample("Up 1 hour (unhealthy)");

      const body = await (
        await api("/api/renovate/progress?host=nas-home")
      ).json();
      const merged = body.updates.find(
        (update: { number: number }) => update.number === 90,
      );

      expect(merged.currentStep).toBe("health");
      expect(merged.failed).toBe(true);
      expect(stepStates(merged)).toMatchObject({
        deploy: "done",
        health: "failed",
      });
    });

    it("keeps GitHub progress when the agent is unavailable", async () => {
      agent.maintenanceBehaviour = "fail";

      const response = await api("/api/renovate/progress?host=nas-home");

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snapshotAvailable).toBe(false);
      const merged = body.updates.find(
        (update: { number: number }) => update.number === 90,
      );
      expect(merged.release.tag).toBe("v2.5.0");
      expect(merged.currentStep).toBe("deploy");
      expect(stepStates(merged)).toMatchObject({
        release: "done",
        deploy: "current",
        health: "pending",
      });
    });

    it("matches a release whose manifest source is a later main commit", async () => {
      const source = "c".repeat(40);
      github.fixture.manifests["v2.5.0"] = {
        schema: 1,
        approved_merge: true,
        source_commit: source,
        roles: ["instance"],
      };
      github.fixture.compares[`${mergeCommit}...${source}`] = "ahead";
      resetGithubCaches();

      const body = await (
        await api("/api/renovate/progress?host=nas-home")
      ).json();
      const merged = body.updates.find(
        (update: { number: number }) => update.number === 90,
      );

      expect(merged.release.tag).toBe("v2.5.0");
      expect(stepStates(merged).release).toBe("done");
      expect(
        github.requests.some((entry) =>
          entry.path.includes(
            `/compare/${mergeCommit}...${source}`,
          ),
        ),
      ).toBe(true);
    });

    it("recognizes a merged list entry that only carries merged_at", async () => {
      // The real GitHub pull list omits the `merged` boolean; the detail
      // endpoint has it. This locks the list format.
      delete (github.fixture.closedPulls[0] as { merged?: unknown }).merged;

      const body = await (
        await api("/api/renovate/progress?host=nas-home")
      ).json();

      expect(
        body.updates.some((update: { number: number }) => update.number === 90),
      ).toBe(true);
    });

    it("ignores closed pull requests that were not merged and merges older than the window", async () => {
      const body = await (
        await api("/api/renovate/progress?host=nas-home")
      ).json();

      expect(body.updates.map((update: { number: number }) => update.number)).toEqual([
        88, 90,
      ]);
      expect(
        github.requests.some((entry) => entry.path.includes("/pulls/91/files")),
      ).toBe(false);
      expect(
        github.requests.some((entry) => entry.path.includes("/pulls/92/files")),
      ).toBe(false);
    });

    it("hides the progress without errors when no token is configured", async () => {
      delete process.env.GITHUB_TOKEN;
      try {
        const response = await api("/api/renovate/progress?host=nas-home");
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          enabled: false,
          repository: null,
          host: { id: "nas-home" },
          updates: [],
        });
        expect(github.requests).toEqual([]);
        expect(agent.requests).toEqual([]);
      } finally {
        process.env.GITHUB_TOKEN = token;
      }
    });
  });
});
