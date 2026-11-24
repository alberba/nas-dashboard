---
last_mapped_commit: d44d511383881a695bfebf39a4752719e3588909
last_mapped_at: 2026-11-24
---
# Testing Patterns

**Analysis Date:** 2026-11-24

## Test Framework

**Runner:**
- **Vitest** `^5.1.0` for unit and API-integration tests. Config: `vitest.config.ts`.
  - `include: ["tests/**/*.test.ts"]` — only `.test.ts` under `tests/`; `tests/e2e/` is excluded by the pattern.
  - Alias `@` → `./src`, mirroring `tsconfig.json`.
  - No `globals: true`, no `setupFiles`, no `globalSetup`, no environment override (default `node`). Every test imports `describe`/`it`/`expect` from `vitest`.
- **Playwright** `^1.65.0` for browser E2E. Config: `playwright.config.ts`.
  - `testDir: "tests/e2e"`, one `chromium` project, `workers: 1`, `fullyParallel: false`, `trace: "retain-on-failure"`.
  - `baseURL: "http://localhost:3000"`; `webServer.command: "pnpm start"` waits on `/api/setup` and reuses an existing server outside CI.
  - Loads `.env.local` into `process.env` when present:
    ```ts
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    ```
    (`playwright.config.ts:3`)
- **Python `unittest`** for the NAS agent. No pytest, no `conftest.py`, no extra dependency beyond `PyYAML==6.0.3` (`agent/requirements.txt`).
  - Discovery: `python3 -m unittest discover -s agent -p 'test_*.py'`.

**Assertion Library:**
- Vitest `expect` (`toBe`, `toEqual`, `toMatchObject`, `toHaveLength`, `rejects.toBeInstanceOf`).
- Playwright `expect` with web-first assertions (`toBeVisible`, `toHaveAttribute`, `toHaveURL`, `toHaveCount`).
- Python `unittest.TestCase` assertions (`assertEqual`, `assertIsNone`, `assertRaises`, `assertIn`, `assertTrue`, `assertFalse`).

**Run Commands:**
```bash
pnpm test                  # Vitest run, all tests/**/*.test.ts
pnpm test:agent            # python3 -m unittest discover -s agent -p 'test_*.py'
pnpm test:e2e              # Playwright; needs a build and a running/reusable server
pnpm exec vitest watch     # watch mode (no dedicated script)
pnpm exec vitest run tests/maintenance-status.test.ts   # one file
pnpm exec vitest run -t "reports a healthy host"        # one test name
pnpm typecheck             # tsc --noEmit --incremental false
pnpm lint                  # ESLint via the TypeScript-6 API adapter
```

There is **no coverage script** and no watch script in `package.json`; use the `pnpm exec` forms above. `pnpm test` silently skips database-backed suites when no local `DATABASE_URL` is configured (see `tests/database.ts`).

## Test File Organization

**Location:**
- Tests are **separate from source**, never co-located. All TypeScript tests live in `tests/`; agent tests live next to the agent modules in `agent/test_*.py` because those modules are imported as top-level scripts.
- Counts at analysis time: 34 Vitest files (`tests/*.test.ts`), 2 Vitest helpers (`tests/database.ts`, `tests/host-fixtures.ts`), 9 Playwright specs (`tests/e2e/*.spec.ts`), 1 Playwright helper (`tests/e2e/login.ts`), 13 Python test modules (`agent/test_*.py`).
- 11 Vitest files are database-backed (`testDatabaseUrl()` + `describe.skipIf`): 8 `tests/api-*.test.ts` plus `tests/collector-alerts.test.ts`, `tests/events.test.ts`, `tests/migrations.test.ts`.

**Naming:**
- kebab-case, domain-first. API route tests are prefixed `api-` and name the endpoint: `tests/api-deployments.test.ts`, `tests/api-maintenance.test.ts`, `tests/api-host-commands.test.ts`, `tests/api-merge-progress.test.ts`.
- Pure module tests use the module name: `tests/maintenance-status.test.ts`, `tests/deploy-progress.test.ts`, `tests/renovate-view.test.ts`, `tests/madrid-day.test.ts`.
- One-off behaviour regressions may use a descriptive scenario name: `tests/one-shot.test.ts`.
- Python: `agent/test_<module>.py` — `agent/test_logs.py` for `agent/logs.py`, `agent/test_deployments.py` for `agent/deployments.py`. There is no `test_server.py`; endpoint behaviour is tested inside the module suites (`agent/test_logs.py::LogsEndpoint`).

**Structure:**
```text
tests/
├── database.ts              # disposable PostgreSQL helper (skip gate)
├── host-fixtures.ts         # snapshot factories with overrides
├── api-*.test.ts            # route-handler tests (fake agent; 8 also use real PG)
├── <module>.test.ts         # pure unit tests
└── e2e/
    ├── login.ts             # Playwright login helper (429 retry)
    └── *.spec.ts            # browser E2E, mostly serial
agent/
└── test_*.py                # unittest, imports `server` / domain modules
```

## Test Structure

**Suite Organization (Vitest unit):**
```ts
import { describe, expect, it } from "vitest";
import type { MaintenanceSnapshot, MaintenanceUnit } from "@/lib/maintenance";
import { failedUnitGroups, statusCells } from "@/lib/maintenance-status";

function unit(overrides: Partial<MaintenanceUnit> = {}): MaintenanceUnit { ... }
function snapshot(overrides: Partial<MaintenanceSnapshot> = {}): MaintenanceSnapshot { ... }

describe("status cells", () => {
  it("reports a healthy host", () => {
    const cells = statusCells(snapshot());
    expect(cells.release).toMatchObject({ state: "installed", tone: "gain" });
  });
});
```
(`tests/maintenance-status.test.ts:1-74`)

- `describe` groups a function or behaviour cluster; `it` names describe observable behaviour: `"rejects an invalid journal tail without calling the agent"`, `"keeps the last snapshot as stale when a refresh fails, then recovers"` (`tests/api-deployments.test.ts`, `tests/maintenance-polling.test.ts`).
- Multiple related `expect`s per test are normal. Loops over invalid inputs use `it.each` (`tests/security.test.ts:11-22`) or a `for` loop with a message argument: `expect(response.status, value).toBe(400)` (`tests/api-deployments.test.ts`).
- Top-level `it` without a `describe` is acceptable for a single regression (`tests/one-shot.test.ts`).

**API suites that need no database** (`tests/api-deployments.test.ts`, `tests/api-maintenance.test.ts`):
1. `vi.mock("@/lib/auth", ...)` at module top for a fixed session.
2. `beforeAll`: start a fake agent HTTP server, set `process.env.NAS_HOSTS`, then **dynamically import** the route module.
3. `beforeEach`: reset fake-agent request logs and failure flags.
4. `afterAll`: `pool.end()` (the route imports `@/lib/db`), close the fake servers, delete `process.env.NAS_HOSTS`.

```ts
beforeAll(async () => {
  nas = await fakeAgent("a".repeat(32));
  apps = await fakeAgent("b".repeat(32));
  process.env.NAS_HOSTS = JSON.stringify([
    { id: "nas-home", name: "NAS-HOME", role: "instance", url: nas.url, token: nas.token },
    { id: "apps", name: "Apps", role: "apps-server", url: apps.url, token: apps.token },
  ]);
  routes = await import("../src/app/api/[...path]/route");
});
```
(`tests/api-deployments.test.ts:137-157`)

**Database-backed API suites** add the disposable PostgreSQL lifecycle:
1. `const baseUrl = testDatabaseUrl();` then `describe.skipIf(!baseUrl)(...)`.
2. `beforeAll`: start the fake agent, set `NAS_HOSTS`, `createTestDatabase(baseUrl)`, set `process.env.DATABASE_URL = context.url`, dynamically import `@/lib/db` and `drizzle-orm/node-postgres/migrator`, run `migrate(db, { migrationsFolder: "./drizzle" })`, then dynamically import the route.
3. `beforeEach`: delete rows in dependency order (`alerts`, `operations`, `samples`, `configuration`).
4. `afterAll`: `pool.end()`, `dropTestDatabase(context)`, close servers, `delete process.env.NAS_HOSTS`.

```ts
context = await createTestDatabase(baseUrl!);
process.env.DATABASE_URL = context.url;
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
const database = await import("@/lib/db");
db = database.db;
pool = database.pool;
await migrate(db, { migrationsFolder: "./drizzle" });
tables = await import("@/lib/schema");
routes = await import("../src/app/api/[...path]/route");
```
(`tests/api-events.test.ts:52-95`)

Why the dynamic imports matter: `src/lib/hosts.ts` and `src/lib/db.ts` read `process.env` at module scope, so env vars must be set before the import graph is evaluated.

**Invoking a route handler directly** (no HTTP server for the hub):
```ts
async function api(path: string) {
  const url = new URL(`http://localhost${path}`);
  const route = url.pathname.replace(/^\/api\//, "").split("/");
  return routes.GET(new NextRequest(url, { method: "GET" }), {
    params: Promise.resolve({ path: route }),
  });
}
```
(`tests/api-deployments.test.ts:129-135`; `tests/api-events.test.ts:43-50`)

**Suite Organization (Playwright):**
```ts
import { submitLogin } from "./login";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  const state = await (await request.get("/api/setup")).json();
  if (state.required) {
    const response = await request.post("/api/setup", {
      headers: { Origin: "http://localhost:3000" },
      data: { token: process.env.SETUP_TOKEN, name: "Test", email, password },
    });
    expect(response.status()).toBe(200);
  }
});
```
(`tests/e2e/dashboard.spec.ts:1-15`)

- 8 of 9 specs call `test.describe.configure({ mode: "serial" })`; the whole run is serial anyway (`workers: 1`). `tests/e2e/maintenance-workflows.spec.ts` is the exception.
- Shared login is a helper, not a fixture: `submitLogin(page)` retries only on HTTP 429 using `x-retry-after`, up to 4 attempts with a 90 s test timeout (`tests/e2e/login.ts:1-23`).
- Cross-spec sessions are captured once and replayed as cookies:
  ```ts
  session = await context.cookies();
  async function open(page: Page, path: string, all: HostFixture[]) {
    await page.context().addCookies(session);
    await serveHosts(page, all);
    await page.goto(path);
  }
  ```
  (`tests/e2e/hosts.spec.ts:112-140`)
- Every spec bootstraps the account idempotently through `GET /api/setup` + `POST /api/setup`, so a fresh database and a reused one both work.

**Suite Organization (Python):**
```python
class LogsEndpoint(unittest.TestCase):
    def setUp(self):
        self.docker = FakeDocker(frame(1, line(T1, "hello")))
        self.previous_docker = server.docker_logs
        self.previous_token = server.TOKEN
        self.previous_networks = server.ALLOWED_NETWORKS
        server.docker_logs = self.docker
        server.TOKEN = "t" * 32
        server.ALLOWED_NETWORKS = server.allowed_networks("127.0.0.1")
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
```
(`agent/test_logs.py:199-215`)

## Mocking

**Framework:** Vitest `vi` (`vi.mock`, `vi.hoisted`, `vi.fn`, `vi.stubGlobal`, `vi.useFakeTimers`), Playwright `page.route`, Python `unittest.mock.patch`.

**Patterns:**
- **Auth is always mocked in route tests**, with a static session:
  ```ts
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
  ```
  (`tests/api-deployments.test.ts:6-16`; same shape in `tests/api-host-commands.test.ts`, `tests/api-events.test.ts`, `tests/api-logs.test.ts`, and the other `tests/api-*.test.ts`.)
- **Mutable mocks need `vi.hoisted`** because `vi.mock` factories are hoisted above imports:
  ```ts
  const session = vi.hoisted(() => ({
    value: { user: { id: "test-user", name: "Test", email: "test@hub.invalid" } } as
      | { user: { id: string; name: string; email: string } }
      | null,
  }));
  vi.mock("@/lib/auth", () => ({
    auth: { api: { getSession: vi.fn(async () => session.value) } },
    ...
  }));
  ```
  (`tests/api-host-commands.test.ts:18-31`). Same trick for the push spy in `tests/collector-alerts.test.ts:12-17`.
- **Outbound HTTP is a real local server, not a mock library.** Each API suite starts a `node:http` server on port 0, checks the bearer token exactly like the agent, records requests, and exposes a failure switch:
  ```ts
  if (request.headers.authorization !== `Bearer ${token}`)
    return send(401, { error: "No autorizado" });
  if (agent.fail) return send(503, { error: "El host no responde" });
  ```
  (`tests/api-deployments.test.ts:103-118`; `tests/collector-alerts.test.ts:58-78`; `tests/events.test.ts:29-60`.)
  This asserts the wire format, host routing, and credential handling at once — a plain `vi.fn` would not catch a wrong URL or a leaked token.
- **Global fetch stubbing for pure network units:** `vi.stubGlobal("fetch", ...)` + `vi.unstubAllGlobals()` in `afterEach` (`tests/security.test.ts:50-77`, `tests/agent-client.test.ts:20-40`).
- **Fake timers for polling logic:** `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`, drive with `await vi.advanceTimersByTimeAsync(60_000)` (`tests/maintenance-polling.test.ts:16-21, 34-50`, `tests/renovate-polling.test.ts`).
- **Typed fetch spies:** `vi.fn<typeof fetch>()` with `.mockResolvedValueOnce(Response.json(body))` keeps the polling hook signature intact (`tests/maintenance-polling.test.ts:35-39`).
- **Browser HTTP is intercepted at the network boundary** in E2E with `page.route`:
  ```ts
  await page.route("**/api/overview?*", async (route) => {
    const requested = new URL(route.request().url()).searchParams.get("host");
    const host = requested ? all.find((entry) => entry.id === requested) : all[0];
    if (!host)
      return route.fulfill({ status: 404, json: { error: "Host no configurado" } });
    await route.fulfill({ json: overviewFor(host, all) }).catch(() => {});
  });
  ```
  (`tests/e2e/hosts.spec.ts:93-110`; also `tests/e2e/maintenance.spec.ts`, `tests/e2e/logs.spec.ts`, `tests/e2e/sensitive-action.spec.ts`.)
- **Python agent tests monkeypatch module attributes** and restore them, instead of using a DI container:
  ```python
  def setUp(self):
      self.docker = FakeDocker()
      self.previous = server.docker_logs
      server.docker_logs = self.docker

  def tearDown(self):
      server.docker_logs = self.previous
  ```
  (`agent/test_logs.py:34-41`; same for `server.TOKEN` and `server.ALLOWED_NETWORKS` at `:199-219`.)
- **Python uses `unittest.mock.patch` for call sequencing:** `patch("server.docker", side_effect=[first, second])` and `patch("server.time.time", return_value=1000)` (`agent/test_containers.py:71-78`).

**What to Mock:**
- The auth session (`@/lib/auth`) in every route test.
- The remote agent / GitHub / push side effects — via a local HTTP server for wire-level tests and `vi.fn`/`page.route` when the shape is irrelevant.
- Clocks and timers in polling/caching logic.
- Docker, subprocess, and host filesystem reads in the agent tests (`server.docker`, `server.docker_logs`, `server.UnixHTTP`).

**What NOT to Mock:**
- The module under test, its Zod validation, or its database. Database-backed API tests exercise the real route handler against a real PostgreSQL instance and real Drizzle migrations.
- Git in `agent/test_deployments.py`: it creates a real temporary repository with `git init`, commits, and tags via a `git()` helper that injects `user.name`, `user.email`, and `commit.gpgsign=false` (`agent/test_deployments.py:20-38, 88-114`).
- The Next.js `NextRequest`/`NextResponse` classes — construct real ones.

## Fixtures and Factories

**Test Data:**
- Shared snapshot factories with a `Partial<T>` override argument live in `tests/host-fixtures.ts`:
  ```ts
  export function maintenanceSnapshot(
    overrides: Partial<MaintenanceSnapshot> = {},
  ): MaintenanceSnapshot {
    return {
      timestamp: 1_763_040_000,
      role: "instance",
      follower: { available: true, state: "idle", ... },
      ...
      ...overrides,
    };
  }
  ```
  Exports: `maintenanceSnapshot`, `deploymentsSnapshot`, `metricsSnapshot` (`tests/host-fixtures.ts:5,60,89`). Use these instead of re-declaring a healthy snapshot.
- Test-local builders follow the same override pattern when the shape is only used by one suite: `snapshot()` in `tests/api-deployments.test.ts:31`, `snapshot()` + `unit()` in `tests/maintenance-status.test.ts:5-59`, `metrics(hostId)` in `tests/api-host-commands.test.ts:50`.
- Fixed epochs and `"a".repeat(40)` / `"a".repeat(64)` IDs keep fixtures deterministic and readable (`tests/host-fixtures.ts`, `agent/test_logs.py:10-13`).
- E2E fixtures are per-spec host objects plus response builders: `HostFixture` + `status()` + `overviewFor()` in `tests/e2e/hosts.spec.ts:6-81`.

**Location:**
- Shared TypeScript: `tests/host-fixtures.ts`, `tests/database.ts`.
- Shared browser: `tests/e2e/login.ts`.
- Per-suite: local functions at the top of the test file (preferred over a global fixture file).
- Python: local `summary()`, `frame()`, `line()`, `COMPOSE` constants and `FakeX` classes inside each `agent/test_*.py` (`agent/test_containers.py:7-15`, `agent/test_logs.py:16-31`, `agent/test_deployments.py:67-83`).

**Database fixture (`tests/database.ts`):**
```ts
export function testDatabaseUrl(): string | null {
  const value = process.env.DATABASE_URL;
  if (!value) return null;
  try {
    const host = new URL(value).hostname;
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return null;
    return value;
  } catch {
    return null;
  }
}

export async function createTestDatabase(baseUrl: string): Promise<TestDatabase> {
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  const database = `hub_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  ...
}
```
- `testDatabaseUrl()` is a deliberate safety gate: a non-local `DATABASE_URL` yields `null`, and `describe.skipIf(!baseUrl)` skips the suite rather than touching production.
- Setup/teardown contract: `createTestDatabase(baseUrl)` → `process.env.DATABASE_URL = context.url` → dynamic `import("@/lib/db")` → `migrate(db, { migrationsFolder: "./drizzle" })` → in `afterAll` `pool.end()` then `dropTestDatabase(context)` (`tests/api-events.test.ts:52-95`).
- Migration tests replay the real `drizzle/*.sql` files split on `--> statement-breakpoint` (`tests/migrations.test.ts:13-18`), applying all but the latest, seeding legacy rows, then applying the latest and asserting the backfill.

## Coverage

**Requirements:** None enforced. There is no coverage provider installed, no `coverage` block in `vitest.config.ts`, no `test:coverage` script, and CI does not collect coverage. `/coverage` is only present in `.gitignore`.

**View Coverage:** Not applicable — running `pnpm exec vitest run --coverage` would require adding `@vitest/coverage-v8` first; that is not a configured workflow.

Coverage is substituted by breadth: every `src/lib` domain module that carries branching has a matching `tests/<module>.test.ts`, the catch-all API has ten endpoint suites, and every mutating agent path has a Python suite. Gaps are tracked in `CONCERNS.md` when relevant.

## Test Types

**Unit Tests (`tests/<module>.test.ts`):**
- Pure functions and reducers with no I/O: `tests/maintenance-status.test.ts` (`statusCells`, `failedUnitGroups`), `tests/renovate-view.test.ts`, `tests/log-viewer.test.ts`, `tests/madrid-day.test.ts`, `tests/series.test.ts`, `tests/apps.test.ts`, `tests/hosts.test.ts`, `tests/deploy-progress.test.ts`.
- Also HTTP-shape logic that does not need a database: `tests/security.test.ts` (Zod schemas + Effect NAS errors), `tests/agent-client.test.ts`, `tests/container-access.test.ts`, `tests/container-removal.test.ts`, `tests/containers.test.ts`, `tests/lifecycle.test.ts`, `tests/verification.test.ts`, `tests/security-review.test.ts`.
- Polling/timers: `tests/maintenance-polling.test.ts`, `tests/renovate-polling.test.ts`, `tests/maintenance-alerts.test.ts`, `tests/maintenance-ui.test.ts`.

**API Integration Tests (`tests/api-*.test.ts`):**
- Invoke the real catch-all handler (`src/app/api/[...path]/route.ts`) with `NextRequest`, a mocked session, and a local fake agent server.
- Eight suites also use a real disposable PostgreSQL database and real migrations (`tests/api-deployment-settings.test.ts`, `tests/api-events.test.ts`, `tests/api-host-commands.test.ts`, `tests/api-hosts.test.ts`, `tests/api-lifecycle.test.ts`, `tests/api-logs.test.ts`, `tests/api-merge-progress.test.ts`, `tests/api-renovate.test.ts`).
- `tests/api-deployments.test.ts` and `tests/api-maintenance.test.ts` need only the fake agent; they assert routing, snapshots, and failure handling without persistence.
- Assert status codes, JSON shape, host routing, absence of credentials/URLs in the body, database rows, and that no agent was called when validation fails:
  ```ts
  expect(response.status).toBe(404);
  expect(nas.requests).toEqual([]);
  expect(apps.requests).toEqual([]);
  ```
  (`tests/api-deployments.test.ts:223-229`)

**E2E Tests (`tests/e2e/*.spec.ts`, Playwright):**
- `tests/e2e/dashboard.spec.ts` — auth gate, closed signup, origin checks, navigation, mobile overflow, passkey registration/sign-in via CDP virtual authenticator.
- `tests/e2e/overview.spec.ts` — summary strip, charts, host state, container history.
- `tests/e2e/maintenance.spec.ts` / `maintenance-status.spec.ts` / `maintenance-workflows.spec.ts` — status strip, deploy/rollback flows, security and command panels.
- `tests/e2e/hosts.spec.ts` — host switching, URL persistence, sidebar connection state, disabled mutations for offline hosts.
- `tests/e2e/logs.spec.ts` — log viewer pagination, cursor, filtering.
- `tests/e2e/files-apps.spec.ts` — file browser/trash and apps launch links.
- `tests/e2e/sensitive-action.spec.ts` — confirmation dialog against the **test-only harness** mounted at `/e2e/sensitive-action`, enabled only when `HUB_E2E_HARNESS=1` (`src/app/e2e/sensitive-action/page.tsx:6-16`; the spec drives the real `useSensitiveAction` hook through `src/app/e2e/sensitive-action/harness.tsx`).
- Assertions use `getByRole`/`getByLabel` and `data-*` hooks, per `CODING_STANDARD.md`: `[data-view="summary"]`, `[data-host-option="apps"]`, `[data-host="apps"]`, `[data-container="seerr"]` (`tests/e2e/hosts.spec.ts:142-169`).

**Agent Tests (`agent/test_*.py`, `unittest`):**
- `agent/test_logs.py` — Docker multiplex framing, cursor stability, endpoint auth and read-only method.
- `agent/test_maintenance.py` (836 lines) / `agent/test_deployments.py` (633 lines) — snapshot assembly, release retention, journal redaction, Git state; real temp repos and real `git`.
- `agent/test_files.py` — path traversal, symlinks, trash/restore; `@unittest.skipUnless(hasattr(ctypes.CDLL(None), "renameat2"), "Linux NAS operation")` for the no-replace rename (`agent/test_files.py:44,56`).
- `agent/test_env_settings.py`, `agent/test_maintenance_actions.py`, `agent/test_host_commands.py`, `agent/test_lifecycle.py`, `agent/test_host_metrics.py`, `agent/test_metrics.py`, `agent/test_smart.py`, `agent/test_updates.py`, `agent/test_containers.py`.
- Endpoint suites start a real `ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)` in `setUp`, request it with `http.client`, and shut it down in `tearDown` (`agent/test_logs.py:199-228`).

## Common Patterns

**Async Testing:**
```ts
const { last, stop } = run(fetcher);
await vi.advanceTimersByTimeAsync(60_000);
expect(last()).toMatchObject({ phase: "ready", stale: true });
stop();
```
(`tests/maintenance-polling.test.ts:52-67`)

- Always `await` the route handler promise and `await response.json()`; never assert on an unresolved promise.
- Abort/lifecycle tests resolve a captured promise after `stop()` and then advance timers to prove no late callback fires (`tests/maintenance-polling.test.ts:92-106`).

**Error Testing:**
```ts
await expect(nas("/action", { action: "stop" })).rejects.toBeInstanceOf(NasRejected);
expect(fetch).toHaveBeenCalledTimes(1); // no retry
```
(`tests/security.test.ts:57-68`)

```python
with self.assertRaises(ValueError):
    server.container_logs("bad;id", "200", "")
```
(`agent/test_logs.py:124-129`)

- HTTP failures are asserted by status plus the absence of side effects, not by message text that may change:
  `expect(response.status).toBe(503); expect(apps.requests).toHaveLength(1);` (`tests/api-deployments.test.ts:231-238`).

**Parametrised invalid input:**
```ts
it.each(["../secret", "/etc/passwd", "a/../../secret", ".hub-trash/data", "a/../b", "a\0b"])(
  "rejects unsafe file path %s",
  (path) => {
    expect(actionSchema.safeParse({ action: "trash", root: "media", path }).success).toBe(false);
  },
);
```
(`tests/security.test.ts:11-22`)

**Python subtests:** `with self.subTest(value=value), self.assertRaises(ValueError):` (`agent/test_logs.py:80`, `agent/test_deployments.py:561`).

**Temporary filesystem fixtures:** `tempfile.TemporaryDirectory()` in `setUp` and `self.temp.cleanup()` in `tearDown` (`agent/test_deployments.py:86-119`, `agent/test_env_settings.py:100`, `agent/test_files.py:11`, `agent/test_maintenance.py:88`).

**Serial E2E with shared server state:** specs bootstrap the account once in `beforeAll`, reuse cookies, and never run in parallel (`workers: 1`).

## Environment and CI

**Local requirements for DB-backed tests:** a reachable PostgreSQL via `DATABASE_URL` on `localhost`/`127.0.0.1`/`::1`. Anything else silently skips 11 suites. Migrations are applied into a fresh `hub_test_*` database per suite, so the role needs `CREATEDB`.

**E2E requirements:** a built app (`pnpm build`), a non-production database, `SETUP_TOKEN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:3000`, `TRUSTED_ORIGINS=http://localhost:3000`, a reachable agent (`NAS_AGENT_URL` + `AGENT_TOKEN` or `NAS_HOSTS`), and `HUB_E2E_HARNESS=1` for `tests/e2e/sensitive-action.spec.ts`. `README.md` explicitly warns not to point these at production.

**CI (`.github/workflows/ci.yml`, job `check`):**
- Triggers on every push and pull request.
- Services: `postgres:18` (`hub`/`hub`), health-checked.
- Node 26 + pnpm, Python 3.14 + `pip install -r agent/requirements.txt`, `pnpm install --frozen-lockfile`.
- Order: `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm test:agent` → `pnpm db:migrate` → `pnpm build` → `playwright install --with-deps chromium` → `pnpm test:e2e`.
- On failure, uploads `test-results/` as the `playwright-results` artifact (7-day retention).
- `deploy.yml` runs only after `Checks` succeeds on `main`; it does not run tests again.

**Determinism rules that keep the suite green:**
- Use fixed epochs (`1_763_040_000`, `1_800_000_000`) and snapshot-relative clocks, not `Date.now()`, in unit fixtures.
- Reset fake-agent request logs and failure flags in `beforeEach` (`tests/api-deployments.test.ts:167-172`).
- Truncate DB tables in `beforeEach` in dependency order: alerts, operations, samples, configuration (`tests/api-events.test.ts:97-102`).
- Restore monkeypatched module globals in `tearDown`; never leave `server.TOKEN` or `server.docker_logs` modified across tests.
- Keep tests behaviour-based: copy changes must not turn a test red (`CODING_STANDARD.md`).

## Test File Taxonomy (quick reference)

| Pattern | Runner | Scope | Example |
|---------|--------|-------|---------|
| `tests/*.test.ts` (module name) | Vitest | Pure unit, no DB | `tests/maintenance-status.test.ts` |
| `tests/api-*.test.ts` (no DB) | Vitest + fake agent | Route handler, no persistence | `tests/api-deployments.test.ts` |
| `tests/api-*.test.ts` (DB) | Vitest + real PG + fake agent | Route handler, persistence | `tests/api-events.test.ts` |
| `tests/*-polling.test.ts` | Vitest + fake timers | Timer-driven client logic | `tests/maintenance-polling.test.ts` |
| `tests/migrations.test.ts` | Vitest + real PG | SQL migration replay | `tests/migrations.test.ts` |
| `tests/*.test.ts` with `describe.skipIf` | Vitest | Integration, skipped without local DB | `tests/events.test.ts` |
| `tests/e2e/*.spec.ts` | Playwright | Browser, serial, route-intercepted | `tests/e2e/hosts.spec.ts` |
| `tests/e2e/login.ts` | Playwright helper | Shared login with 429 retry | `tests/e2e/login.ts` |
| `agent/test_*.py` | unittest | Agent domain + HTTP endpoint | `agent/test_deployments.py` |
| `src/app/e2e/sensitive-action/` | Playwright fixture app | Test-only harness gated by env | `src/app/e2e/sensitive-action/page.tsx` |

---

*Testing analysis: 2026-11-24*
