---
last_mapped_commit: d44d511383881a695bfebf39a4752719e3588909
last_mapped_at: 2026-11-24
---
<!-- refreshed: 2026-11-24 -->
# Architecture

**Analysis Date:** 2026-11-24

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser / installable PWA                                                    │
│ `src/app/layout.tsx` · `src/app/page.tsx` · `src/components/**` · `public/sw.js` │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTPS, session cookie
                                │ same-origin mutations only (`origins` check)
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Next.js 16 App Router — a single web replica                                 │
│  Server gate `src/app/page.tsx`                                              │
│  HTTP boundary `src/app/api/[...path]/route.ts` + `src/app/api/auth/[...all]` │
│  Domain modules `src/lib/*.ts`                                               │
└──────┬──────────────────────┬──────────────────────────┬─────────────────────┘
       │ pg Pool (SQL)        │ HTTP + Bearer token      │ HTTPS + fine-grained PAT
       ▼                      ▼                          ▼
┌──────────────┐   ┌──────────────────────────┐   ┌──────────────────────────┐
│ PostgreSQL   │   │ Python agent (per host)  │   │ GitHub API               │
│ `src/lib/schema.ts` │ `agent/server.py`  │   │ `src/lib/github.ts`      │
│ `drizzle/*.sql`     │ :9450 behind Tailscale │ │ Renovate PRs, CI, releases│
└──────┬───────┘   └────────────┬─────────────┘   └──────────────────────────┘
       │                        │ Docker socket, /proc, /sys, read-only mounts
       │                        ▼
       │              ┌──────────────────────────┐
       │              │ Docker, filesystems,     │
       │              │ SMART, systemd units     │
       │              └──────────────────────────┘
       ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Worker `src/worker.ts`   │───────▶│ Python agent `/metrics`, │
│ `src/lib/collector.ts`   │        │ `/maintenance`, `/...`   │
└──────────┬───────────────┘        └──────────────────────────┘
           │ web-push
           ▼
┌──────────────────────────┐
│ Push services            │
└──────────────────────────┘
```

**Intent (from `README.md` and `DESIGN.md`):** a personal Spanish-language dashboard to supervise and administer a NAS from a second server. The browser only ever talks to Next.js; the NAS and the apps server expose a private, token-authenticated agent that the hub and its worker call. The UI is a dense operational panel: status strip first, then tables, no console, no free-form shell (`DESIGN.md`).

**Deployment shape (from `compose.yaml`):** one Compose project `nas-dashboard` with four services — `db` (PostgreSQL 18, no published port), `migrate` (one-shot `pnpm db:migrate`), `app` (Next.js on 4323 and a private 4324 loopback entry), and `worker` (the collector). Both `app` and `worker` wait for `migrate` to complete successfully.

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Root layout | HTML shell, fonts, PWA manifest/viewport metadata, security headers from config | `src/app/layout.tsx`, `next.config.ts` |
| Session gate | Server component: renders `Dashboard` or `Login`, decides whether setup is still open | `src/app/page.tsx` |
| App shell | Client-side navigation, host directory, polling, action dialog, toasts | `src/components/dashboard.tsx` |
| API dispatcher | All hub endpoints over one catch-all route (GET/POST/DELETE) | `src/app/api/[...path]/route.ts` |
| Auth route | Better Auth handler (session, sign-in/out, passkeys) | `src/app/api/auth/[...all]/route.ts` |
| Auth config | Better Auth instance, origins, passkey plugin, verification hook | `src/lib/auth.ts`, `src/lib/auth-client.ts` |
| Host registry | Parses `NAS_HOSTS` / legacy `NAS_AGENT_URL`, resolves and validates hosts | `src/lib/hosts.ts` |
| Agent client | Typed Effect HTTP client with tagged errors; Promise boundary for routes | `src/lib/nas.ts` |
| Persistence | `pg` pool + Drizzle schema and instance | `src/lib/db.ts`, `src/lib/schema.ts` |
| Collector | Worker-side sampling, threshold alerts, snapshot alerts, operation reconciliation | `src/lib/collector.ts` |
| Worker entry | Advisory-lock singleton loop, 5 s/30 s cadence, 30-day retention | `src/worker.ts` |
| Agent server | Threaded private HTTP API for metrics, files, logs, actions, maintenance, deployments | `agent/server.py` |
| Agent metrics | Native `/proc` + `/sys` sampling and Docker container stats | `agent/host_metrics.py` |
| Agent maintenance | Read-only media-stack snapshot (follower, security, backup, disks, units, Docker usage) | `agent/maintenance.py` |
| Agent deployments | Read-only releases, blockers, retained releases and journal | `agent/deployments.py` |
| Agent lifecycle | Container classification, removability, one-shot and orphan policy | `agent/lifecycle.py` |
| Agent updates | Compose image update plan/execution and registry digest checks | `agent/updates.py` |
| Agent SMART | `smartctl` parsing and disk health classification | `agent/smart.py` |
| Agent commands | Closed whitelist of `systemctl` commands with fixed argv | `agent/host_commands.py` |
| Agent maintenance actions | Fixed Docker/host actions (backup, clean images, health, reconnect apps) | `agent/maintenance_actions.py` |
| Agent env settings | Writes missing `.env` keys for a retained release, atomically | `agent/env_settings.py` |
| Agent logs | Docker multiplex decoding, tail and stable cursors | `agent/logs.py` |

## Pattern Overview

**Overall:** Layered monolith + remote agent (a "hub-and-agent" topology). The hub is a single Next.js deployment (one web replica, one worker) that owns all state in PostgreSQL; each monitored machine runs a stateless-by-design Python agent that owns privileged host access. There is no message queue and no RPC framework: the boundary is plain JSON over HTTP with a bearer token.

**Key Characteristics:**

- **One HTTP boundary, many domains.** Every hub endpoint is a branch inside `src/app/api/[...path]/route.ts` (`handle`, line 106). Adding a feature means adding a route string and a `src/lib` module, not a new Next.js route file.
- **Host-scoped, not global.** `HostConfig` flows down from `src/lib/hosts.ts` into every domain function. The client mirrors this with `HostScopeContext` (`src/components/host-context.tsx:21`) and `withHost()` (line 47) so a view never silently mixes two hosts' data.
- **Typed failure at the network edge.** `src/lib/nas.ts` models agent calls as an Effect with `NasUnavailable | NasRejected | NasInvalidResponse` and exposes `nasForHost()` as a Promise boundary (`src/lib/nas.ts:75`). Route handlers translate those into HTTP statuses.
- **Optimistic-safe mutations.** Every mutating request carries an `Idempotency-Key` UUID; the `operations` table both records the audit trail and deduplicates retries per host. A lost response becomes `pending`, never an automatic retry.
- **Reads are cached remotely, written centrally.** The agent caches maintenance (60 s) and deployments (30 s) and rebuilds metrics snapshots on a 10 s container cache (`agent/server.py`); the hub stores time series as JSONB samples and aggregates in SQL.
- **Server-only secrets.** `AGENT_TOKEN`, `GITHUB_TOKEN` and VAPID keys live only in the server/agent environment. The browser receives neither agent URLs nor tokens.

## Layers

**Presentation Layer:**
- Purpose: render the dashboard, hold client-side route and host scope, run polling.
- Location: `src/app/` and `src/components/`
- Contains: one server component (`src/app/page.tsx`), one client shell (`src/components/dashboard.tsx`), feature views (`src/components/views/*.tsx`), reusable primitives (`src/components/ui.tsx`), the sensitive-action dialog (`src/components/sensitive-action/sensitive-action.tsx`), CSS Modules colocated with their component, and the global sheet `src/app/globals.css`.
- Depends on: `src/lib` pure helpers and types, `authClient`, `fetch` to `/api/*`.
- Used by: the browser only.

**HTTP / Route Layer:**
- Purpose: authenticate, validate, scope to a host, dispatch, translate errors to Spanish JSON.
- Location: `src/app/api/[...path]/route.ts` and `src/app/api/auth/[...all]/route.ts`
- Contains: origin guard for mutations (line 112), setup flow with `SETUP_TOKEN` and advisory lock 734922 (line 138), session lookup (line 155), the route table (lines 115–675), and the error mapper (lines 676–709).
- Depends on: `src/lib` domain modules, `db`, Zod schemas.
- Used by: the client dashboard and Playwright tests.

**Domain / Service Layer:**
- Purpose: implement each feature's rules independent of HTTP and React.
- Location: `src/lib/*.ts`
- Contains: pure view models (`containers.ts`, `apps.ts`, `format.ts`, `renovate-view.ts`, `maintenance-status.ts`, `maintenance-ui.ts`, `log-viewer.ts`, `container-access.ts`, `container-removal.ts`), stateful services (`lifecycle.ts`, `host-commands.ts`, `deployment-settings.ts`, `renovate-merge.ts`, `deploy-progress.ts`, `collector.ts`, `events.ts`, `maintenance-alerts.ts`, `settings.ts`), contracts (`validation.ts`, `host-command-contract.ts`, `types.ts`), and integrations (`nas.ts`, `github.ts`, `push.ts`).
- Depends on: `db`, `schema`, `hosts`, `nas`, and each other through explicit imports.
- Used by: the route layer, the worker, and (for pure modules only) client components.

**Integration Layer:**
- Purpose: talk to the outside world.
- Location: `src/lib/nas.ts`, `src/lib/github.ts`, `src/lib/push.ts`
- Contains: the Effect-based agent client with timeouts (25 s GET, 45 s POST, 300 s container update), the GitHub REST client with in-memory caches, and the `web-push` sender.
- Depends on: `fetch`, `effect`, `web-push`, Node crypto.
- Used by: domain services and the worker.

**Persistence Layer:**
- Purpose: durable state.
- Location: `src/lib/db.ts`, `src/lib/schema.ts`, `drizzle/`, `scripts/migrate.ts`
- Contains: Better Auth tables (`user`, `session`, `account`, `verification`, `passkey`), hub tables (`samples`, `alerts`, `operations`, `configuration`, `presence`, `subscriptions`) and `recent_verification`.
- Depends on: PostgreSQL and `drizzle-orm/node-postgres`.
- Used by: every server-side module.

**Background Worker:**
- Purpose: continuous collection and retention without a request.
- Location: `src/worker.ts`, `src/lib/collector.ts`
- Contains: the advisory-lock singleton, the poll loop, per-host collection, alert conditions, snapshot alerts, pending-operation reconciliation, and hourly cleanup.
- Depends on: `db`, `collector`, `hosts`, `settings`, `push`, `maintenance-alerts`.
- Used by: the Compose `worker` service only.

**Remote Agent Layer:**
- Purpose: privileged, read-mostly access to one machine.
- Location: `agent/`
- Contains: `server.py` (HTTP + Docker/file/action dispatch), `host_metrics.py`, `maintenance.py`, `deployments.py`, `lifecycle.py`, `updates.py`, `smart.py`, `logs.py`, `host_commands.py`, `maintenance_actions.py`, `env_settings.py`.
- Depends on: Docker socket, `/proc`, `/sys`, read-only media-stack mounts, `smartctl`, `systemctl` via a privileged helper.
- Used by: the hub API and the worker, never by the browser.

## Data Flow

### Primary Request Path (dashboard refresh)

1. Browser loads `/`; the server component checks the Better Auth session and either renders `Login` or `Dashboard` (`src/app/page.tsx:9`).
2. `Dashboard` reads `?view=`, `?tab=` and `?host=` from the URL (`src/components/dashboard.tsx:176`, `readRoute` in `src/components/views/routes.ts:25`) and starts three independent loops: `/api/hosts` once, `/api/presence` every 15 s (line 203), and `/api/overview?range=…` at 5 s when visible / 30 s when hidden (lines 225–249).
3. `/api/overview` verifies origin for mutations, loads the session, resolves the host (`resolveHost`, `src/lib/hosts.ts:119`), then reads the latest `samples` row, recent `alerts`, open-alert count, recent `operations`, an active `presence` row, per-host `settings`, host statuses and a bucketed history query (`src/app/api/[...path]/route.ts:265`).
4. The history query uses PostgreSQL `generate_series` + `date_bin` over `samples.data` JSONB (`route.ts:305`), with bucket sizes from the `ranges` table (`route.ts:62`): 1 h→30 s, 6 h→60 s, 24 h→120 s, 7 d→900 s, 30 d→3600 s.
5. The response is `no-store` JSON; the client stores it with the scope it belongs to and discards answers for a host/range that is no longer current (`dashboard.tsx:130`).
6. Each view renders from the latest snapshot: `SummaryView`, `ResourcesView`, `MaintenanceStatus`, `Deployments`, `FileBrowser`, `AppsView`, `Settings`, `AlertsView` (lines 588–637).

### Metrics Collection (worker)

1. `src/worker.ts` takes `pg_try_advisory_lock(734921)` and exits if another collector holds it (`src/worker.ts:15`).
2. Every second it checks whether a visible tab exists (`presence.expiresAt > now`); if so it collects every 5 s, otherwise every 30 s (`sampleInterval` in `src/lib/validation.ts:42`, used at `worker.ts:28`).
3. `collectAll` fans out over hosts with `Promise.all` and isolates failures per host (`src/lib/collector.ts:266`).
4. `collectHost` calls the agent `GET /metrics` through `nasForHost` (`collector.ts:110`), validates the sample shape inline, and inserts one `samples` row whose `data` is the whole `Metrics` JSON (`collector.ts:154`).
5. Thresholds (`cpu`, `memory`, `disk`, `temperature`, expected containers) run through `condition()` (`collector.ts:25`), which tracks a per-host start time, opens an `alerts` row only after the sustained duration, resolves it when the condition clears, and calls `notify()` on both transitions.
6. At most once per minute per host, `collectSnapshotAlerts` reads `GET /maintenance` and `GET /deployments?lines=1` and feeds `maintenanceAlertSignals` / `deploymentAlertSignals` (`collector.ts:75`). A failed read contributes no signals, so it cannot churn alerts.
7. Pending operations are reconciled from the fresh sample: a reboot is complete when uptime shows a later boot than `bootAt`; start/stop/restart are confirmed from the container state (`collector.ts:224`).
8. Hourly, the worker deletes samples, resolved alerts, operations older than 30 days and expired presence rows (`src/worker.ts:32`).

### Mutating Action Path (start/stop/restart/reboot/update/remove)

1. The client opens the confirmation dialog (or the sensitive-action dialog for destructive work) and posts to `/api/action?host=…` with a fresh `Idempotency-Key` (`dashboard.tsx:340`).
2. The dispatcher rejects a non-allowlisted `Origin` before anything else (`route.ts:112`), requires a session, resolves the host, and parses the body with `actionSchema` (`src/lib/validation.ts:14`).
3. It looks up the operation id; a replay from the same host returns the stored row, a replay from another host returns 409 (`route.ts:426`).
4. `reboot` additionally requires recent verification (`guardSensitiveAction`, `src/lib/verification-api.ts:91`).
5. It refuses the action when the newest sample is older than 75 s (`CONNECTION_STALE_MS`, `src/lib/hosts.ts:5`), then inserts an `operations` row with status `pending`.
6. It calls the agent `POST /action` through `nasForHost`; a 3xx/4xx rejection marks the operation `failed` and returns 400, while a timeout/network failure leaves it `pending` with a Spanish "no se ha repetido" message and returns 502 (`route.ts:529`).
7. Later worker samples settle `pending` reboot/start/stop/restart operations without the user repeating them.

### Agent Boundary

1. Every agent request must match an IP in `ALLOWED_IPS` and carry `Authorization: Bearer <AGENT_TOKEN>` compared with `hmac.compare_digest` (`agent/server.py:453`).
2. The agent is a `ThreadingHTTPServer`; a global `LOCK` serializes Docker/file/host actions (`server.py:83`), while `/maintenance` and `/deployments` snapshots run outside it so slow host reads do not block metrics (`server.py:458`, `agent/MAINTENANCE.md`).
3. `POST /action` with `action=update-container` runs outside the global lock but under a single non-blocking `UPDATE_LOCK`, because a Compose pull can take minutes (`server.py:364`).
4. Error mapping: `ValueError`/`KeyError` → 400 with the message; `OSError`/`HTTPException` → 502 for POST (the action may have run) and 503 for GET (`server.py:529`).
5. A background thread prunes expired trash items hourly and on startup (`server.py:538`).

### Maintenance and Deployments Path

1. `/api/maintenance?host=…` resolves the host and returns `maintenanceForHost(host)` (`src/lib/maintenance.ts:182`), a thin pass-through to agent `GET /maintenance`.
2. The agent builds the snapshot from independent section readers in a thread pool and reports failed sections in `degraded` rather than failing the whole response (`agent/maintenance.py:801`). The 60 s cache is invalidated after a host command or container update.
3. `/api/deployments?lines=…` calls agent `GET /deployments`; the agent reads media-stack app data, the Git checkout and the host journal with `GitReader` / `JournalReader` and caches for 30 s (`agent/deployments.py:747`).
4. `/api/deployments/settings` writes missing `.env` keys through `saveDeploymentSettings` (`src/lib/deployment-settings.ts:85`) and agent `POST /deployments/settings`, which delegates to `EnvSettings.save` (`agent/env_settings.py:110`) for an atomic rename inside the dedicated env directory.

### Renovate / Deploy Progress Path

1. `GET /api/renovate` builds the container list from each host's latest sample (compose project/service labels), fetches Renovate PRs from GitHub, and joins them in `relatePullRequests` (`route.ts:227`, `src/lib/github.ts:521`).
2. `POST /api/renovate/merge` requires recent verification, an unchanged head SHA, green CI on that SHA and `mergeable` from GitHub; it merges with the repo's squash method, records one operation, and optionally runs `deploy-now` with a derived UUID (`src/lib/renovate-merge.ts:139`, `deployOperationId` line 47).
3. `GET /api/renovate/progress` combines open and recently merged PRs, CI checks, releases and the maintenance snapshot into six fixed steps (PR · Merge · CI en main · Release · Desplegando · Salud) (`src/lib/deploy-progress.ts:306`; step ids in `src/lib/types.ts:223`).

### Notifications

1. A browser subscribes with `PushManager`, posts the endpoint and keys to `/api/push`, which validates the endpoint host allowlist and stores a `subscriptions` row (`route.ts:626`).
2. `notify()` calls `web-push` for every subscription with `TTL: 3600` and prunes endpoints that respond 404/410 (`src/lib/push.ts:6`).
3. The worker calls `notify()` on alert open and recovery; `/api/push/test` sends a test notification.

### State Management

- **Server:** PostgreSQL is the only durable state. There is no Redis, no in-process cache for authorization, and no session store outside the database.
- **Worker:** in-memory maps only for alert debounce (`started`, `alertSnapshotAt` in `src/lib/collector.ts:16`), reset by a restart.
- **Agent:** in-memory caches with TTLs (`Maintenance`, `Deployments`, container stats, registry digests), plus `container_previous`/`unhealthy_observed_since` for rate and health-duration calculations (`agent/server.py:268`).
- **Client:** React state keyed by host (`snapshot.scope`, `wanted.current` in `dashboard.tsx:103`); the URL is the only navigation state, updated with `history.replaceState` (`dashboard.tsx:110`).

## Key Abstractions

**HostConfig / HostScope:**
- Purpose: make every read and write explicitly belong to one configured host.
- Examples: `src/lib/hosts.ts:43` (`HostConfig`), `src/lib/hosts.ts:119` (`resolveHost`), `src/components/host-context.tsx:21` (`HostScope`), `src/components/host-context.tsx:47` (`withHost`).
- Pattern: dependency injection by argument on the server; React context on the client. `primaryHost()` is the fallback only when no host is given.

**Operation (idempotency + audit record):**
- Purpose: one row per attempted action, keyed by a client UUID, with per-host uniqueness semantics and a status lifecycle (`pending` → `success`/`failed`, or left `pending`).
- Examples: `src/lib/schema.ts:152`, `src/app/api/[...path]/route.ts:459`, `src/lib/lifecycle.ts:133`, `src/lib/host-commands.ts:139`.
- Pattern: write-ahead record before the external call; the external call never retries itself.

**Effect-based agent client:**
- Purpose: distinguish unreachable, rejected and malformed agent answers instead of collapsing them into one error.
- Examples: `src/lib/nas.ts:4` (tagged errors), `src/lib/nas.ts:25` (`nasEffectForHost`), `src/lib/nas.ts:75` (`nasForHost`).
- Pattern: Effect generator with `Effect.timeoutOrElse`; the Promise wrapper uses `Effect.result` and rethrows the tagged failure.

**Snapshot contract (agent → hub):**
- Purpose: a stable JSON shape with a `degraded: string[]` list so partial failures are visible without failing the page.
- Examples: `src/lib/maintenance.ts:139` (`MaintenanceSnapshot`), `src/lib/deployments.ts:74` (`DeploymentsSnapshot`), `agent/maintenance.py:801`, `agent/deployments.py:980`.
- Pattern: read-only builder with per-section isolation; the TypeScript type is the consumer contract, the Python dict is the producer. See "Architectural Constraints" for the missing runtime validation.

**Closed command whitelist:**
- Purpose: let the hub trigger privileged host work without ever sending an argv.
- Examples: `src/lib/host-command-contract.ts:4` (`hostCommandIds`), `agent/host_commands.py:22` (`COMMAND_NAMES`), `agent/maintenance_actions.py:15`.
- Pattern: shared enum + fixed argv construction on the agent. The two lists must be kept in sync manually (a comment says so in `agent/host_commands.py`).

**Recent verification:**
- Purpose: gate destructive actions on a passkey or password proof within 5 minutes.
- Examples: `src/lib/verification.ts:5` (`RECENT_VERIFICATION_TTL_MS`), `src/lib/verification.ts:45` (`verificationStore`), `src/lib/verification-api.ts:91` (`guardSensitiveAction`), `src/lib/schema.ts:90` (`recent_verification`).
- Pattern: DB-backed per-session record; the Better Auth `after` hook records passkey logins (`src/lib/auth.ts:41`). A missing record fails closed.

**Server/client view-model split:**
- Purpose: keep formatting, filtering and step derivation testable without React or HTTP.
- Examples: `src/lib/containers.ts`, `src/lib/apps.ts`, `src/lib/maintenance-status.ts`, `src/lib/renovate-view.ts`, `src/lib/log-viewer.ts`, `src/components/views/series.ts`.
- Pattern: pure functions imported by both views and Vitest tests; components only render their output.

## Entry Points

**Web page:**
- Location: `src/app/page.tsx`
- Triggers: any authenticated or unauthenticated `GET /`.
- Responsibilities: read the session, count users to decide `setup`, render `Dashboard` or `Login`. `export const dynamic = "force-dynamic"` disables static rendering.

**API dispatcher:**
- Location: `src/app/api/[...path]/route.ts`
- Triggers: `GET`, `POST`, `DELETE` on `/api/*` (exports at lines 711–713).
- Responsibilities: origin guard, setup flow, session, host resolution, route dispatch, error mapping. Route strings in use: `setup`, `verification`, `verification/password`, `containers/remove`, `hosts`, `maintenance`, `host-command`, `deployments`, `events`, `deployments/settings`, `renovate`, `renovate/merge`, `renovate/progress`, `overview`, `container-history`, `presence`, `action`, `files`, `trash`, `logs`, `settings`, `push`, `push/test`.

**Auth handler:**
- Location: `src/app/api/auth/[...all]/route.ts`
- Triggers: Better Auth client calls (`sign-in`, `sign-out`, passkey endpoints).
- Responsibilities: `toNextJsHandler(auth)`.

**Worker process:**
- Location: `src/worker.ts` (script `pnpm worker`)
- Triggers: the `worker` Compose service; SIGTERM/SIGINT set `stopping`.
- Responsibilities: acquire the collector lock, loop, collect, clean up, release the lock.

**Agent process:**
- Location: `agent/server.py:550`
- Triggers: `python -u server.py` in the agent container; binds `BIND_IP:9450`.
- Responsibilities: refuse to start with a token shorter than 32 characters, start the trash cleanup thread, serve the private API.

**Test-only harness:**
- Location: `src/app/e2e/sensitive-action/page.tsx`
- Triggers: `GET /e2e/sensitive-action` only when `HUB_E2E_HARNESS=1`; otherwise `notFound()`.
- Responsibilities: mount the sensitive-action dialog for Playwright without touching production flows.

**CLI scripts:**
- `scripts/migrate.ts` — Drizzle migrator against `DATABASE_URL`.
- `scripts/configure.mjs` — generates `.env`, `agent/.env` and `agent/.env.apps` with 0600 permissions and VAPID keys; refuses to overwrite.
- `scripts/reset-password.ts` — administrative password reset for recovery.
- `scripts/eslint-typescript-api.mjs` — loads the TypeScript 6 JS API that ESLint still needs.

## Architectural Constraints

- **Threading:** the hub is single-threaded Node (Next.js request handlers and one worker loop). The agent is a `ThreadingHTTPServer`; shared mutable state is guarded by `LOCK`, `UPDATE_LOCK` and per-cache locks (`agent/server.py:83`, `agent/maintenance.py:779`).
- **Single replica assumptions:** the README and code assume one web replica and one collector. The collector is enforced by `pg_try_advisory_lock(734921)` (`src/worker.ts:15`); Better Auth rate limiting is explicitly in-memory and single-replica (`src/lib/auth.ts:67`). Scaling the web tier requires moving rate limiting and verification to shared storage.
- **Global state:** module-level singletons are the `pg` pool (`src/lib/db.ts:5`), the Better Auth instances (`src/lib/auth.ts:68`), the GitHub caches (`src/lib/github.ts:686` `resetGithubCaches` exists because of this), the verification store (`src/lib/verification.ts:45`), the collector debounce maps (`src/lib/collector.ts:16`), and the agent caches (`agent/server.py:267`). All are process-local and lost on restart.
- **Runtime:** the API needs the Node.js runtime (`pg`, `node:crypto`, `web-push`); there is no Edge deployment path. `force-dynamic` and `Cache-Control: no-store` are required because responses are per-session and per-host.
- **Advisory-lock numbers are global:** 734921 is the collector, 734922 is the setup bootstrap (`route.ts:138`). Reusing either number elsewhere would couple unrelated processes.
- **API fan-out:** each overview request issues several sequential queries plus one `db.execute` aggregate (`route.ts:271`–`325`). There is no request-level cache between polls; the browser polls at 5 s.
- **Contract drift:** the maintenance/deployments snapshot types in `src/lib/maintenance.ts` and `src/lib/deployments.ts` are not validated at runtime. Only `logsResponseSchema` is parsed (`route.ts:592`) and metrics are checked with ad-hoc predicates (`collector.ts:111`). A Python shape change reaches the UI unchecked.
- **No shell, by design:** there is no arbitrary command endpoint. The agent exposes only fixed actions and a closed command list (`agent/server.py:506`).
- **Filesystem boundary:** file operations are confined to two roots and reject absolute paths, `..`, `.hub-trash`, symlinks and zero bytes (`agent/server.py:134`); moves use `renameat2` with no-replace semantics (`server.py:165`).

## Anti-Patterns

### Ad-hoc operation bookkeeping per feature

**What happens:** the same sequence — parse idempotency key, look up `operations`, check host, refuse when the sample is stale, insert `pending`, call the agent, branch on `NasRejected`, mark `failed`/`pending` — is reimplemented in `src/app/api/[...path]/route.ts:416`, `src/lib/lifecycle.ts:83`, `src/lib/host-commands.ts:96` and parts of `src/lib/deployment-settings.ts` and `src/lib/renovate-merge.ts`.
**Why it's wrong:** a fix to the idempotency or pending semantics must be applied in five places; they already differ in small ways (for example the stale-sample check is inline in `route.ts` but uses `CONNECTION_STALE_MS` in `lifecycle.ts`).
**Do this instead:** extend the existing `executeHostCommand` pattern (`src/lib/host-commands.ts:96`) into a shared operation runner that takes `{host, userId, action, operationId, call}` and owns the record lifecycle.

### Default-host agent calls

**What happens:** `nas()` and `nasEffect()` default their host argument to `primaryHost(getHosts())` (`src/lib/nas.ts:66`–`92`). Any new call site that forgets the host silently targets the NAS.
**Why it's wrong:** in a multi-host deployment this reads or acts on the wrong machine, and nothing in the type system catches it.
**Do this instead:** call `nasForHost(host, …)` with an explicit `HostConfig`, as every current route does. Keep the defaulting helpers only for legacy single-agent code.

### Client fetches without host-key discipline

**What happens:** a view fetches on mount and writes the answer into state. The shared hook `useHostRead` (`src/components/views/use-host-read.ts:5`) implements the correct pattern, but ad-hoc `useEffect` fetches elsewhere must remember to abort and to compare `scope` before accepting an answer.
**Why it's wrong:** a slow answer from the previous host can overwrite the newly selected host's data; the README's multi-host promise breaks intermittently.
**Do this instead:** use `useHostRead` or `useMaintenanceSnapshot` / `useRenovate`, which carry the host key and abort on change (`src/components/views/use-maintenance-snapshot.tsx:16`, `src/components/views/use-renovate.ts:15`). If a new read needs custom logic, include `useHostScope().key` in the effect dependencies and drop mismatched answers.

### Copy-coupled tests

**What happens:** user-facing strings are inline Spanish literals across components, and it is tempting to assert on them in Playwright.
**Why it's wrong:** `CODING_STANDARD.md` forbids tests that go red when copy changes; they freeze the wording and slow every UI edit.
**Do this instead:** assert on state, outcome or structure (`data-view`, `aria-current`, roles). When a component lacks a hook, add a `data-*` attribute rather than reading text.

## Error Handling

**Strategy:** explicit, typed failures at each boundary; never silently retry a mutation; degrade reads section by section.

**Patterns:**

- **Hub route mapper** (`src/app/api/[...path]/route.ts:676`): `HostNotFound` → 404, `HostConfigError` → 503, `GithubConfigError` → 503, `GithubUnavailable` → 503, `ZodError` → 400 with the first issue, anything else → 503 with a generic Spanish message. Only the error class name is logged, never the payload.
- **Agent result mapping** (`src/lib/nas.ts:50`): HTTP error → `NasRejected` with the agent's `error` string; malformed JSON → `NasInvalidResponse`; fetch rejection or timeout → `NasUnavailable`.
- **Uncertain mutations stay pending.** A timeout after the agent may have executed the action marks the operation `pending` and returns 502 with "no se ha repetido" (`route.ts:537`, `src/lib/lifecycle.ts:189`, `src/lib/host-commands.ts:195`).
- **Agent-side mapping** (`agent/server.py:529`): `ValueError`/`KeyError` → 400; `OSError`/`HTTPException` → 502 on POST and 503 on GET, because a POST may have changed state.
- **Snapshot degradation:** `Maintenance` and `Deployments` collect failed section names into `degraded` and return the rest (`agent/maintenance.py:801`). The hub's `maintenanceAlertSignals` skips signals from degraded sections (`src/lib/maintenance-alerts.ts:49`), and `events.ts` reports `degraded` instead of inventing events.
- **Client resilience:** a failed refresh sets the banner but keeps the last snapshot with a `stale` flag (`src/lib/maintenance-polling.ts:5`, `src/lib/renovate-polling.ts:5`); a 401 redirects to `/` (`dashboard.tsx:139`); a 404 for a host that left the config falls back to the primary host (`dashboard.tsx:146`).

## Cross-Cutting Concerns

**Logging:**
- Hub: `console.log` / `console.error` only; no structured logger, no Sentry. The API logs `error.name` and GitHub status codes, never user data (`route.ts:690`, `route.ts:701`).
- Worker: one line per start and a generic message per collection failure (`src/worker.ts:18`, `src/worker.ts:43`).
- Agent: `Handler.log_message` is a no-op specifically so query strings with filenames and bearer credentials never reach the log (`agent/server.py:440`). Failures print a short Spanish message.

**Validation:**
- Hub: Zod at every boundary — `actionSchema` and `settingsSchema` (`src/lib/validation.ts:14`, `:35`), `hostCommandRequestSchema` (`src/lib/host-command-contract.ts:17`), `mergeRequestSchema` (`src/lib/renovate-merge.ts:26`), `removalRequestSchema` (`src/lib/lifecycle.ts:26`), `deploymentSettingsSchema` (`src/lib/deployment-settings.ts:27`), `logsResponseSchema` (`src/lib/logs.ts:34`), and `parseHosts` for `NAS_HOSTS` (`src/lib/hosts.ts:81`).
- Agent: regex/allowlist validation for container ids, roots, relative paths, unit names, image references and env keys (`agent/server.py:124`, `agent/maintenance.py:31`, `agent/env_settings.py:36`).
- Gap: snapshot payloads from the agent are trusted structurally (see Architectural Constraints).

**Authentication:**
- Browser: Better Auth session cookie (`src/lib/auth.ts`), 7-day session, 1-hour `updateAge`. Email+password has sign-up disabled at runtime; the one-time `bootstrapAuth` variant is used only by `/api/setup` after the `SETUP_TOKEN` check.
- Passkeys: `@better-auth/passkey` with `rpID` from `BETTER_AUTH_URL`; the origin list comes from `TRUSTED_ORIGINS`.
- Mutations: origin allowlist check before any work (`route.ts:112`), then session, then (for reboot/remove/merge/deployment settings) recent verification.
- Hub → agent: bearer token compared in constant time; source IP must belong to `ALLOWED_IPS`.
- Hub → GitHub: fine-grained PAT read-only for Renovate, used only server-side.

---

*Architecture analysis: 2026-11-24*
*Update when major patterns change*
