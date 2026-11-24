---
last_mapped_commit: d44d511383881a695bfebf39a4752719e3588909
last_mapped_at: 2026-11-24
---
# External Integrations

**Analysis Date:** 2026-11-24

## APIs & External Services

**GitHub REST API:**
- Used for Renovate pull requests, CI checks, releases, release manifests, commit comparison and squash merges.
  - SDK/Client: native `fetch` wrapper in `src/lib/github.ts` (`githubFetch`, `githubJson`); no Octokit dependency.
  - Auth: fine-grained bearer token in `GITHUB_TOKEN`; optional `GITHUB_REPOSITORY` (default `alberba/media-stack`) and `GITHUB_API_URL` (default `https://api.github.com`). Without `GITHUB_TOKEN`, `githubConfig()` returns `null` and `/api/renovate` answers `{ enabled: false }` (`src/app/api/[...path]/route.ts`).
  - Pin: `X-GitHub-Api-Version: 2022-11-28`, `Accept: application/vnd.github+json`, `User-Agent: nas-dashboard`.
  - Endpoints used: `GET /repos/{repo}/pulls`, `GET /repos/{repo}/pulls/{number}`, `GET /repos/{repo}/pulls/{number}/files`, `GET /repos/{repo}/commits/{sha}/check-runs`, `GET /repos/{repo}/releases`, `GET /repos/{repo}/contents/docs/releases/{tag}.deploy.json`, `GET /repos/{repo}/compare/{base}...{head}`, and `PUT /repos/{repo}/pulls/{number}/merge` with `merge_method: "squash"` (`src/lib/renovate-merge.ts`).
  - Timeout: 15 seconds per request (`CHECK_TIMEOUT_MS`); GitHub failure maps to HTTP 503 in the hub API.
  - Caching: in-process release cache for 30 seconds and a `compare` result map, reset by `resetGithubCaches()` (`src/lib/github.ts`).

**Private host agent HTTP API:**
- The hub calls one agent per configured host for metrics, maintenance, deployments, logs, files, container actions and host commands.
  - SDK/Client: Effect-based `nasEffectForHost` / `nasForHost` using native `fetch` (`src/lib/nas.ts`).
  - Auth: `Authorization: Bearer <host token>`; token comes from `NAS_HOSTS[].token` or `AGENT_TOKEN` (`src/lib/hosts.ts`).
  - Default timeouts: 25 seconds for GET, 45 seconds for POST; container updates use 300 seconds (`CONTAINER_UPDATE_TIMEOUT_MS`).
  - Endpoints: `GET /metrics`, `GET /maintenance`, `GET /deployments`, `POST /deployments/settings`, `POST /action`, `GET /files`, `GET /trash`, `GET /logs`, `POST /command` (`agent/server.py`, `src/lib/nas.ts`).
  - Response validation: `deployments`/`maintenance` parsed by `src/lib/deployments.ts` and `src/lib/maintenance.ts`, logs by `logsResponseSchema` (`src/lib/logs.ts`), host command results by `hostCommandResultSchema` (`src/lib/host-command-contract.ts`).

**Web Push:**
- Delivers alert notifications to installed PWA clients.
  - SDK/Client: `web-push` 3.6.7 (`src/lib/push.ts`), browser `ServiceWorkerRegistration.pushManager` client flow and `public/sw.js`.
  - Auth: VAPID keys `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, subject `VAPID_SUBJECT` (default `mailto:admin@example.com`).
  - Endpoint allow-list: HTTPS push endpoints on `googleapis.com`, `mozilla.com`, `mozilla.org`, `apple.com`, `windows.com` or `microsoft.com` (`src/app/api/[...path]/route.ts`).
  - Payload: `{ title, body, tag, url: "/?view=alerts" }`; TTL 3600 seconds; 404/410 responses delete the subscription.
  - If either VAPID key is absent, `notify()` returns without sending anything.

**Other external services:**
- None detected. No payment, email, SMS, analytics, AI or cloud storage SDK is imported in `src/` or `agent/`.

## Data Storage

**Databases:**
- PostgreSQL 18 (`postgres:18-bookworm` in `compose.yaml`, `postgres:18` in CI).
  - Connection: `DATABASE_URL`; `pg.Pool` with `max: 8` and a process-global pool in non-production (`src/lib/db.ts`).
  - Client: Drizzle ORM 0.45.4 with `drizzle-orm/node-postgres`; schema in `src/lib/schema.ts`; migrations in `drizzle/0000_known_madame_hydra.sql` through `drizzle/0003_multi_host.sql`, applied by `scripts/migrate.ts`.
  - No SSL or connection-string options are configured explicitly; TLS depends on the `DATABASE_URL` supplied by the deployment.

**Schema (`src/lib/schema.ts`):**

| Table | Purpose | Notable columns/indexes |
|---|---|---|
| `user` | Better Auth account | `id`, unique `email`, `name`, timestamps |
| `session` | Better Auth session | unique `token`, `expiresAt`, `userId` FK, `session_user_idx` |
| `account` | Credential/provider record | `providerId`, `accountId`, password hash, `account_user_idx` |
| `verification` | Better Auth verification tokens | `identifier`, `verification_identifier_idx` |
| `passkey` | WebAuthn credentials | unique `credentialID`, `publicKey`, `counter`, `passkey_user_idx` |
| `recent_verification` | Recent passkey/password proof for sensitive actions | `sessionId` PK, `method`, `verifiedAt`, `expiresAt`, `recent_verification_expires_idx` |
| `samples` | Host metrics history | identity `id`, `hostId`, `at`, `data jsonb` (`Metrics`), `samples_at_idx`, `samples_host_at_idx` |
| `presence` | Visible dashboard tab heartbeat | `id` (client UUID), `userId`, `expiresAt` |
| `configuration` | Per-host settings JSON | composite PK `(hostId, id)`, `value jsonb` (`Settings`), logical id `settings` |
| `alerts` | Open/resolved alert history | `hostId`, `key`, `severity`, `at`, `resolvedAt`, `alerts_key_idx`, `alerts_at_idx`, `alerts_host_key_idx` |
| `operations` | Audit/action ledger | `id` (idempotency UUID), `hostId`, `userId`, `action`, `target`, `status`, `bootAt`, `operations_host_at_idx` |
| `subscriptions` | Web Push subscriptions | `endpoint` PK, `userId`, `keys jsonb` (`p256dh`, `auth`) |

- PostgreSQL-specific SQL: overview and container history use `generate_series`, `date_bin` and `make_interval`, plus `jsonb` extraction (`src/app/api/[...path]/route.ts`). These require PostgreSQL 14+; the repo targets 18.
- Advisory locks: worker singleton uses key `734921` (`src/worker.ts`); first-account setup uses key `734922` (`src/app/api/[...path]/route.ts`).

**File Storage:**
- Local filesystem only. The NAS agent exposes two roots, `MEDIA_ROOT` (`/nas/media`) and `TORRENTS_ROOT` (`/nas/torrents`), mounted from `NAS_MEDIA_PATH` and `NAS_TORRENTS_PATH`.
- Trash is a `.hub-trash` directory inside each root, with a per-item UUID folder containing `record.json` and `data`; items expire after 7 days and are purged hourly (`agent/server.py`).
- The agent also mounts the media-stack checkout and appdata read-only (`MEDIA_STACK_CHECKOUT_PATH`, `MEDIA_STACK_APPDATA_PATH`); only the dedicated `MEDIA_STACK_ENV_PATH` directory is writable for atomic `.env` replacement.
- No S3, object storage or CDN integration.

**Caching:**
- None external. In-process caches only: GitHub release/compare caches (`src/lib/github.ts`), agent maintenance cache (default 60 seconds, `MAINTENANCE_CACHE_SECONDS`), deployments cache (default 30 seconds, `DEPLOYMENTS_CACHE_SECONDS`), Docker container stats cache (10 seconds), registry/image caches (3 hours), and UI polling intervals of 60 seconds (`src/lib/maintenance-polling.ts`, `src/lib/renovate-polling.ts`).

## Authentication & Identity

**Auth Provider:**
- Custom Better Auth deployment backed by PostgreSQL; no external identity provider.
  - Implementation: `betterAuth` with `drizzleAdapter(db, { provider: "pg", schema })` in `src/lib/auth.ts`.
  - Email/password enabled with `disableSignUp: true` and minimum password length 12.
  - Passkey plugin (`@better-auth/passkey`) with `rpName: "hub."` and RP ID from `BETTER_AUTH_URL`; client plugin in `src/lib/auth-client.ts`.
  - Sessions: 7-day expiry, refreshed at most hourly; in-memory rate limiting enabled; single web replica assumed.
  - Trusted origins: comma-separated `TRUSTED_ORIGINS`, falling back to `BETTER_AUTH_URL`; all mutating API requests must send an allowed `Origin` (`src/app/api/[...path]/route.ts`).
  - Bootstrap: first account requires `SETUP_TOKEN` (32+ chars) plus a PostgreSQL advisory lock; `bootstrapAuth` is a separate instance that temporarily allows signup (`src/lib/auth.ts`).
  - Sensitive actions (reboot, container removal, release settings, Renovate merge) require a passkey or password verification no older than 5 minutes (`src/lib/verification.ts`, `src/lib/verification-api.ts`).
  - Agent authentication is separate: bearer token plus client-IP allow-list (`ALLOWED_IPS`), compared with `hmac.compare_digest`; startup refuses a token shorter than 32 characters (`agent/server.py`).
  - No OAuth, social login, SSO, magic links or external user directory.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry, OpenTelemetry or hosted error tracker is configured.

**Logs:**
- Hub: `console.log` / `console.error` in the worker and API handlers; errors are intentionally reduced to names/status codes before logging (`src/app/api/[...path]/route.ts`, `src/worker.ts`).
- Agent: request logging is disabled to avoid logging query strings with file names or bearer credentials (`agent/server.py`). Maintenance and deployments read `journalctl` output for the allowed media-stack units through the privileged host helper (`agent/deployments.py`).
- Alerts: the collector writes to the `alerts` table, resolves them when conditions recover, and sends Web Push (`src/lib/collector.ts`, `src/lib/push.ts`).
- Health checks: Compose app health check polls `http://127.0.0.1:3000/api/setup`; Playwright uses the same endpoint for readiness.
- No metrics backend; all host metrics are self-collected from `/proc`, `/sys`, `statvfs` and Docker (`agent/host_metrics.py`, `agent/METRICS.md`).

## CI/CD & Deployment

**Hosting:**
- Docker Compose on a Linux application server (documented as Oracle in `.github/workflows/deploy.yml` and `README.md`), with PostgreSQL in the same Compose project.
- Two separate agents: NAS (`agent/compose.yaml`, host networking) and apps server (`agent/compose.apps.yaml`, attached to external network `nas-dashboard_default` with alias `hub-agent-apps`).
- Private connectivity via Tailscale; public HTTPS through Nginx Proxy Manager or an optional Tailscale Serve endpoint on `127.0.0.1:4324`.

**CI Pipeline:**
- `.github/workflows/ci.yml` (`Checks`): push and pull request; PostgreSQL 18 service; Node 26; Python 3.14; steps run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:agent`, `pnpm db:migrate`, `pnpm build`, Playwright Chromium install and `pnpm test:e2e`; Playwright results uploaded on failure.
- `.github/workflows/deploy.yml` (`Deploy`): triggers after a successful `Checks` run on `main` or manual dispatch; uses `tailscale/github-action@v4` and SSH to ship `git archive` output, replace `/opt/nas-dashboard` while keeping `.env`, run `docker compose up -d --build`, then poll the app container health for up to 150 seconds.
- `.github/dependabot.yml`: weekly npm, Docker (`/` and `/agent`) and GitHub Actions updates, grouped for React, Next, Better Auth and development dependencies.

## Environment Configuration

**Required env vars:**
- Hub: `DATABASE_URL`, `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `SETUP_TOKEN`, `NAS_HOSTS` (JSON array of `{id,name,role,url,token}`; `role` is `instance` or `apps-server`) or the legacy pair `NAS_AGENT_URL` + `AGENT_TOKEN`, `NEXT_PUBLIC_APP_DOMAIN`, `BIND_IP`, `PORT`.
- Optional hub: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_API_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- Agent: `AGENT_TOKEN`, `BIND_IP`, `ALLOWED_IPS`, `NAS_NAME`, `FILES_ENABLED`, `ALLOW_REBOOT`, optional `PROTECTED_CONTAINERS`, `NAS_MEDIA_PATH`, `NAS_TORRENTS_PATH`, `MEDIA_STACK_CHECKOUT_PATH`, `MEDIA_STACK_APPDATA_PATH`, `MEDIA_STACK_ENV_PATH`, `MEDIA_STACK_ENV_FILE`, `HOST_ROLE`, `MAINTENANCE_UNITS`, `MAINTENANCE_CACHE_SECONDS`, `MAINTENANCE_STACK_PREFIX`, `DEPLOYMENTS_CACHE_SECONDS`, `EXTRA_FILESYSTEMS`, `HOST_PROC`, `HOST_SYS`, `HOST_ROOT`, `HOST_HELPER_IMAGE`, `APPDATA_ROOT`.
- Templates: `.env.example`, `agent/.env.example`, `agent/.env.apps.example`. `scripts/configure.mjs` writes the real files with mode `0600` and refuses to overwrite them.

**Secrets location:**
- Server: `.env` in the Compose project directory, intentionally preserved across deployments by `.github/workflows/deploy.yml`; ignored by Git through `.env*` in `.gitignore` and excluded from images by `.dockerignore`.
- NAS and apps servers: `agent/.env` and `agent/.env.apps`, also ignored by Git and excluded from the agent build context.
- GitHub Actions: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`, `DEPLOY_USER` in the `production` environment.
- No secret manager or vault integration; tokens live only on the servers.

## Webhooks & Callbacks

**Incoming:**
- None. No public webhook receiver exists. The only inbound server API is the Next.js `/api/*` route for the browser, plus `/api/auth/*` for Better Auth, both session/origin protected.
- The agent's port 9450 accepts inbound calls only from `ALLOWED_IPS` with a valid bearer token; it should not be exposed publicly.

**Outgoing:**
- GitHub REST calls from the hub (Renovate, releases, merges, checks).
- Agent HTTP calls from the hub and worker to each configured host.
- Web Push delivery to browser push-service endpoints.
- No outbound webhooks, callbacks, queues or event buses.

## Docker & Host Integrations (Python Agent)

**Docker Engine API:**
- Socket: `/var/run/docker.sock` mounted into both agent containers; the NAS agent runs with `network_mode: host` and the apps agent joins the hub network.
- Client: custom `UnixHTTP` over `AF_UNIX` and Docker API prefix `/v1.45` (`agent/server.py`, `agent/maintenance.py`).
- Reads: `/containers/json?all=true`, `/containers/{id}/json`, `/containers/{id}/stats?stream=false&one-shot=true`, `/containers/{id}/logs`, `/images/{id}/json`, `/system/df`, Docker Compose labels.
- Writes: start/stop/restart containers, remove stopped containers with `DELETE /containers/{id}?v=0` (never removes volumes), create/start/wait/delete privileged `nsenter` helper containers, and run `docker compose -p <project> [--project-directory] [-f ...] [--env-file ...] pull/up` for validated Compose services (`agent/updates.py`).
- Protection: `hub-agent`, `hub-agent-apps`, `npm` and `tailscale` are protected by default; `PROTECTED_CONTAINERS` adds more. One-shot services `wire` and `wire-seed` are never updated.

**Host reads:**
- `/proc` mounted at `/host/proc`, `/sys` at `/host/sys`, host root at `/host/root` (read-only), configured by `HOST_PROC`, `HOST_SYS`, `HOST_ROOT` (`agent/server.py`, `agent/compose.yaml`).
- Metrics sources: `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev`, `/proc/diskstats`, `/proc/mdstat`, `/sys/block/md*/md/*`, hwmon, `statvfs`, and extra filesystems from `EXTRA_FILESYSTEMS` (`agent/host_metrics.py`, `agent/METRICS.md`).
- Disk health: `smartctl --scan-open --json` and `smartctl --json --all` run inside a privileged helper container with `/dev` and `/sys` mounted read-only and `NetworkMode: none` (`agent/smart.py`, `agent/maintenance.py`).

**Host actions:**
- Privileged commands run through a `nsenter -t 1 -m -u -i -n -p -- <argv>` helper container using image `hub-agent:1` (`host_commands.HostExecutor`).
- Systemd reads: `systemctl show` for configured units and `systemctl list-units --state=failed`; journal reads through `journalctl --output=json` (`agent/maintenance.py`, `agent/deployments.py`).
- Fixed command whitelist: `deploy-now`, `pause-follower`, `resume-follower`, `run-security` (`agent/host_commands.py`) plus `backup-now`, `clean-images`, `check-health`, `reconnect-apps` (`agent/maintenance_actions.py`). The request carries only a command name; argv is fixed server-side.
- Reboot: creates a privileged `nsenter` helper that runs `/sbin/reboot`; disabled with `ALLOW_REBOOT=false` (`agent/server.py`).
- File mutations: move, trash, restore, purge and empty-trash are restricted to the two roots, reject `..`, absolute paths, NUL bytes and symlinks, and use `renameat2` with `RENAME_NOREPLACE` (`agent/server.py`).

**Media-stack integration:**
- Read-only checkout and appdata mounts provide releases, retained versions, rollback state, Compose files and `.env.example` names (`agent/deployments.py`, `agent/env_settings.py`).
- Git is invoked only with a closed list of read-only commands (`tag`, `status`, `rev-parse`, `show`, `merge-base`, etc.) under a scrubbed environment (`agent/deployments.py`).
- Release manifests are read from `docs/releases/<tag>.deploy.json`; a release is deployable only with `schema: 1`, `approved_merge: true`, a 40-hex `source_commit` and the host role present.
- The only write is `POST /deployments/settings`: missing `.env` values are applied atomically in `MEDIA_STACK_ENV_PATH`, with a backup, file lock, symlink refusal and no values returned; the apps-server role rejects this operation.

## Background Worker

- Process: `src/worker.ts`, started by `pnpm worker` (Compose service `worker`, `node --env-file-if-exists=.env.local --import tsx src/worker.ts`).
- Singleton: `pg_try_advisory_lock(734921)`; a second worker exits with `Ya hay un recolector activo`.
- Loop: wakes every second; collects all hosts when the sample interval elapsed. Interval is 5 seconds while an unexpired `presence` row exists and 30 seconds otherwise (`src/lib/validation.ts`, `src/worker.ts`).
- Collection: `collectAll` / `collectHost` calls `GET /metrics` per host, inserts `samples`, initializes expected containers, evaluates CPU/memory/disk/temperature/container thresholds, fetches maintenance and deployment snapshots for alerts, resolves recovered alerts, and checks pending operations (`src/lib/collector.ts`).
- Retention: hourly cleanup deletes samples, alerts and operations older than 30 days, plus expired presence rows (`src/worker.ts`).
- Shutdown: `SIGTERM`/`SIGINT` set a stop flag, then the advisory lock is released and the pool closed.

---

*Integration audit: 2026-11-24*
