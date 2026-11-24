---
last_mapped_commit: d44d511383881a695bfebf39a4752719e3588909
last_mapped_at: 2026-11-24
---
# Codebase Structure

**Analysis Date:** 2026-11-24

## Directory Layout

```text
nas-dashboard/
├── src/
│   ├── app/                  # Next.js App Router: page, layout, CSS, API routes
│   │   ├── api/[...path]/    # The single hub API dispatcher
│   │   ├── api/auth/[...all]/# Better Auth handler
│   │   ├── e2e/              # Test-only harness, 404 unless HUB_E2E_HARNESS=1
│   │   ├── globals.css       # Global sheet and design tokens
│   │   ├── layout.tsx        # Root layout, fonts, PWA metadata
│   │   └── page.tsx          # Session gate: Dashboard or Login
│   ├── components/           # Client UI
│   │   ├── views/            # One file per dashboard view + hooks + pure helpers
│   │   ├── sensitive-action/ # Confirmation dialog for destructive actions
│   │   ├── dashboard.tsx     # App shell, navigation, polling, host directory
│   │   ├── host-context.tsx  # HostScopeContext and host switcher/sidebar
│   │   ├── ui.tsx            # Panel, StatusStrip, StatusDot, Segmented, FilterChips
│   │   └── *.module.css      # Colocated styles
│   ├── lib/                  # Shared server/client logic (domain, contracts, adapters)
│   └── worker.ts             # Background collector entry point
├── agent/                    # Private Python agent deployed on each host
├── tests/                    # Vitest suites + Playwright e2e
│   └── e2e/                  # Playwright specs
├── drizzle/                  # SQL migrations and generated metadata
│   └── meta/                 # Drizzle snapshots and journal (generated)
├── scripts/                  # migrate, configure, reset-password, eslint adapter
├── public/                   # Icons, web manifest, service worker
├── .github/                  # CI and production deploy workflows, Dependabot
├── .planning/                # GSD planning artifacts (this directory)
├── compose.yaml              # db, migrate, app, worker
├── Dockerfile                # Next.js image (build + runtime)
├── README.md                 # Spanish operator manual and deployment guide
├── DESIGN.md                 # Visual and interaction contract
└── CODING_STANDARD.md        # Behaviour-based test rules
```

## Directory Purposes

**`src/app/`:**
- Purpose: Next.js App Router entry points and HTTP surface.
- Contains: one page (`page.tsx`), the root layout, the global stylesheet, the catch-all API route, the Better Auth route and the test-only e2e page.
- Key files: `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/api/[...path]/route.ts`, `src/app/api/auth/[...all]/route.ts`, `src/app/globals.css`.

**`src/app/api/[...path]/`:**
- Purpose: every hub endpoint lives in one dispatcher.
- Contains: `route.ts` with `handle()`, the `ranges` table, `requestHost()` and `renovateContainers()`, and the `GET`/`POST`/`DELETE` exports.
- Key files: `src/app/api/[...path]/route.ts`.

**`src/components/`:**
- Purpose: client-rendered UI only. No direct database or agent access.
- Contains: the app shell, feature views, reusable primitives, the sensitive-action dialog, formatting helpers that are view-specific (`views/series.ts`, `views/routes.ts`) and CSS Modules.
- Key files: `src/components/dashboard.tsx`, `src/components/host-context.tsx`, `src/components/ui.tsx`, `src/components/views/routes.ts`.

**`src/components/views/`:**
- Purpose: one module per view or panel, plus the hooks that fetch host-scoped data.
- Contains: `summary.tsx`, `resources.tsx`, `resource-panels.tsx`, `maintenance.tsx`, `maintenance-status.tsx`, `maintenance-extras.tsx`, `deployments.tsx`, `deployment-details.tsx`, `renovate-panel.tsx`, `apps.tsx`, `alerts.tsx`, `container-history.tsx`, `container-logs.tsx`, `update-container.tsx`, `remove-container.tsx`, `shared.tsx`, `series.ts`, `routes.ts`, `use-host-read.ts`, `use-maintenance-snapshot.tsx`, `use-renovate.ts`.
- Key files: `src/components/views/routes.ts` (view ids and URL contract), `src/components/views/use-host-read.ts`, `src/components/views/use-maintenance-snapshot.tsx`.

**`src/components/sensitive-action/`:**
- Purpose: the modal that gates destructive actions behind consequences, typed confirmation and recent verification.
- Contains: `sensitive-action.tsx`, `sensitive-action.module.css`, and the `useSensitiveAction()` hook.
- Key files: `src/components/sensitive-action/sensitive-action.tsx`.

**`src/lib/`:**
- Purpose: all shared logic. This is the layer new features normally extend.
- Contains: host registry, agent client, DB/schema, auth, domain services, view models, Zod contracts, types, integrations.
- Key files: `src/lib/hosts.ts`, `src/lib/nas.ts`, `src/lib/db.ts`, `src/lib/schema.ts`, `src/lib/types.ts`, `src/lib/collector.ts`, `src/lib/validation.ts`, `src/lib/host-command-contract.ts`.

**`agent/`:**
- Purpose: the privileged per-host service. It is shipped and run separately from the Next.js app.
- Contains: `server.py` (HTTP entry), one module per capability, `test_*.py` unit tests, its own `Dockerfile`, `compose.yaml`, `compose.apps.yaml`, requirements and contract docs.
- Key files: `agent/server.py`, `agent/maintenance.py`, `agent/deployments.py`, `agent/host_metrics.py`, `agent/lifecycle.py`, `agent/MAINTENANCE.md`, `agent/METRICS.md`.

**`tests/`:**
- Purpose: hub unit/integration tests and browser tests.
- Contains: Vitest suites for lib modules and API routes, shared fixtures and a disposable-database helper, and Playwright specs under `tests/e2e/`.
- Key files: `tests/database.ts`, `tests/host-fixtures.ts`, `tests/e2e/login.ts`, `tests/migrations.test.ts`.

**`drizzle/`:**
- Purpose: migration history.
- Contains: ordered SQL files (`0000_known_madame_hydra.sql` … `0003_multi_host.sql`) and generated metadata in `drizzle/meta/`.
- Key files: `drizzle/0003_multi_host.sql`, `drizzle/meta/_journal.json`.

**`scripts/`:**
- Purpose: operator and build-time commands.
- Contains: `migrate.ts` (Drizzle migrator), `configure.mjs` (generates env files), `reset-password.ts` (recovery), `eslint-typescript-api.mjs` (TypeScript 6 API shim for ESLint).
- Key files: `scripts/migrate.ts`, `scripts/configure.mjs`.

**`public/`:**
- Purpose: static PWA assets.
- Contains: `manifest.webmanifest`, `sw.js`, icons.
- Key files: `public/manifest.webmanifest`, `public/sw.js`.

**`.github/`:**
- Purpose: automation.
- Contains: `workflows/ci.yml` (typecheck, lint, tests, agent tests, migrate, build, Playwright) and `workflows/deploy.yml` (Tailscale + SSH deploy on a successful `main` run), plus `dependabot.yml`.
- Key files: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`.

**`.planning/`:**
- Purpose: GSD planning artifacts.
- Contains: this `codebase/` map, phase plans and state added by other GSD commands.
- Key files: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`.

**`.agents/`, `.claude/`, `.codex/`, `.opencode/`:**
- Purpose: GSD tooling, agent definitions and skills. Not application code.
- Contains: agent personas, workflows, templates and skills.
- Key files: `.agents/agents/gsd-codebase-mapper.md`.

## Key File Locations

**Entry Points:**
- `src/app/page.tsx`: server session gate; renders `Login` or `Dashboard`.
- `src/app/api/[...path]/route.ts`: all hub API routes.
- `src/app/api/auth/[...all]/route.ts`: Better Auth handler.
- `src/worker.ts`: background collector (`pnpm worker`).
- `agent/server.py`: agent HTTP server (`python -u server.py`, port 9450).
- `src/app/e2e/sensitive-action/page.tsx`: Playwright-only harness.

**Configuration:**
- `next.config.ts`: security headers and the Turbopack CSS/Tailwind rule.
- `tsconfig.json`: `@/*` → `./src/*` path alias, strict mode.
- `drizzle.config.ts`: schema at `./src/lib/schema.ts`, output `./drizzle`, PostgreSQL.
- `vitest.config.ts`: alias `@` → `./src`, tests `tests/**/*.test.ts`.
- `playwright.config.ts`: `tests/e2e`, one worker, base URL `http://localhost:3000`.
- `compose.yaml`: production topology (`db`, `migrate`, `app`, `worker`).
- `agent/compose.yaml` / `agent/compose.apps.yaml`: instance vs apps-server agent mounts and networks.
- `.env.example`, `agent/.env.example`, `agent/.env.apps.example`: templates only; real env files are gitignored.

**Core Logic:**
- `src/lib/hosts.ts`: host parsing, validation, resolution.
- `src/lib/nas.ts`: agent HTTP client with typed errors.
- `src/lib/collector.ts`: sampling, alerts, operation reconciliation.
- `src/lib/lifecycle.ts`: container removal.
- `src/lib/host-commands.ts`: whitelisted host commands.
- `src/lib/renovate-merge.ts`: merge + optional deploy.
- `src/lib/deploy-progress.ts`: six-step deploy timeline.
- `src/lib/github.ts`: GitHub reads and caches.
- `src/lib/schema.ts`: all tables.
- `agent/maintenance.py`: maintenance snapshot.
- `agent/deployments.py`: deployment snapshot.
- `agent/host_metrics.py`: native metrics.
- `agent/lifecycle.py`: container policy.

**Testing:**
- `tests/*.test.ts`: Vitest unit/integration suites.
- `tests/e2e/*.spec.ts`: Playwright flows.
- `agent/test_*.py`: Python `unittest` suites.
- `tests/database.ts`: creates/drops a disposable PostgreSQL database; refuses non-local hosts.
- `tests/host-fixtures.ts`: healthy maintenance/deployments snapshots for overrides.

## Naming Conventions

**Files:**
- TypeScript modules in `src/lib` and `src/components/views` use **kebab-case**: `host-command-contract.ts`, `container-access.ts`, `use-host-read.ts`, `deployment-details.tsx`.
- Top-level shell components keep single-word lowercase names: `dashboard.tsx`, `settings.tsx`, `login.tsx`, `chart.tsx`, `ui.tsx`.
- React components are exported in **PascalCase** regardless of file case: `Dashboard`, `FileBrowser`, `MaintenanceStatus`, `SensitiveAction`.
- Hooks live in `use-*.ts`/`use-*.tsx` and export `useX`: `use-host-read.ts` → `useHostRead`, `use-maintenance-snapshot.tsx` → `useMaintenanceSnapshot`.
- CSS Modules are colocated and named `<component>.module.css`: `src/components/views/maintenance-status.module.css`, `src/components/sensitive-action/sensitive-action.module.css`.
- Python modules use **snake_case**; their tests are `test_<module>.py` in the same `agent/` directory: `test_maintenance.py`, `test_host_commands.py`.
- Vitest suites are `tests/<topic>.test.ts`; Playwright specs are `tests/e2e/<flow>.spec.ts`.
- Migrations are `NNNN_<generated_name>.sql` under `drizzle/`.

**Directories:**
- `src/app` follows App Router conventions (`api/[segment]`, `[...catchAll]`); other directories are kebab-case or single lowercase words.
- Feature views are flat files in `src/components/views/`; they are not grouped into per-feature folders.
- The agent is flat: no package or subdirectory layout.

**Symbols and data:**
- Server functions are verb-first: `collectHost`, `resolveHost`, `removeContainer`, `mergeRenovatePullRequest`, `deployProgressForHost`.
- Types are PascalCase; string unions are lowercase (`"instance" | "apps-server"`, `"pending" | "success" | "failed"`).
- API route strings are kebab-case and may nest one level: `host-command`, `container-history`, `renovate/progress`, `deployments/settings`.
- DB columns mix conventions: auth tables use camelCase quoted columns (`"userId"`, `"expiresAt"`) and the verification table uses snake_case (`sessionId` is camelCase, but the table is `recent_verification`); follow the surrounding table, not a global rule.
- Tests are named after the behaviour, not the copy (`api-maintenance.test.ts`, `maintenance-polling.test.ts`).

## Where to Add New Code

**New API endpoint:**
- Add a branch in `handle()` in `src/app/api/[...path]/route.ts` next to the related routes; the catch-all already exports `GET`/`POST`/`DELETE`.
- Put the logic in a new or existing `src/lib/<domain>.ts` module. Keep the handler to: parse (`z`), resolve host, delegate, return `json(...)`.
- If the endpoint mutates, follow the `executeHostCommand` pattern (`src/lib/host-commands.ts:96`): `Idempotency-Key`, `operations` row, stale-sample check, no automatic retry.
- Add a schema to `src/lib/validation.ts` or a dedicated contract module if the body has more than one field.
- Test it in `tests/api-<domain>.test.ts` using the disposable database from `tests/database.ts`.

**New dashboard view:**
- Create `src/components/views/<name>.tsx` exporting a PascalCase component.
- Register the id in `views` and `maintenanceTabs` (if it is a Maintenance tab) in `src/components/views/routes.ts`, then add it to `navigation` and `headings` in `src/components/dashboard.tsx:46` and render it in the `page-content` switch (`dashboard.tsx:588`).
- Fetch host-scoped data with `useHostRead` or a dedicated hook; never call `fetch` on mount without aborting and comparing the host key.
- Put pure formatting/filtering in `src/lib/<name>-view.ts` (or `status.ts`) so it is testable in Vitest without React.
- Add `data-*` hooks for state you need in Playwright rather than asserting on Spanish copy.

**New domain module:**
- Implementation: `src/lib/<domain>.ts`. Import `db`/schema only on the server; export pure helpers separately if a client component needs them.
- Types: add shared shapes to `src/lib/types.ts` when both server and client consume them; keep agent-response shapes in `src/lib/maintenance.ts` or `src/lib/deployments.ts`.
- If it calls an agent, take a `HostConfig` argument and use `nasForHost`, not `nas`.

**New agent capability:**
- Add the module under `agent/`, keep it read-only unless it is an explicitly fixed action, and validate every request value with a regex or allowlist.
- Register the route in `handle_request()` in `agent/server.py` (inside `LOCK` for Docker/file work, outside for slow snapshots) and mirror the type in `src/lib`.
- Add `agent/test_<module>.py` using `unittest`; the CI runs `pnpm test:agent`.
- Update `agent/MAINTENANCE.md` or `agent/METRICS.md` when the payload changes.

**New host command:**
- Add the id to `hostCommandIds` in `src/lib/host-command-contract.ts` and to `COMMAND_NAMES` in the matching agent module (`agent/host_commands.py` or `agent/maintenance_actions.py`), with a fixed argv and a unit test.
- The request body must stay `{ command }` only; never pass an argument through.

**New database table:**
- Add the `pgTable` to `src/lib/schema.ts`, generate the SQL into `drizzle/` with `drizzle-kit` (there is no `db:generate` npm script), and apply with `pnpm db:migrate`.
- Add indexes for the query patterns used by `overview`, `events` and the collector (host + time).
- Extend `tests/migrations.test.ts` if the migration changes existing rows.

**Shared helpers:**
- Formatting (`bytes`, `percent`, `uptime`): `src/lib/format.ts`.
- Dates/calendar: `src/lib/madrid-day.ts`.
- Container classification: `src/lib/containers.ts`.
- App catalog: `src/lib/apps.ts`.
- Do not add a `utils/` or `helpers/` folder; the existing convention is one domain file per concern in `src/lib`.

**Tests:**
- Vitest: `tests/<topic>.test.ts`, importing from `@/lib/...` (alias configured in `vitest.config.ts`).
- Playwright: `tests/e2e/<flow>.spec.ts`, using `tests/e2e/login.ts` for authentication.
- Python: `agent/test_<module>.py`, discoverable with `pnpm test:agent`.

## Special Directories

**`.next/`:**
- Purpose: Next.js build output and dev cache.
- Generated: Yes.
- Committed: No (`.gitignore`).

**`node_modules/`:**
- Purpose: pnpm dependencies.
- Generated: Yes.
- Committed: No.

**`drizzle/meta/`:**
- Purpose: Drizzle snapshots and journal used to compute diffs.
- Generated: Yes (by drizzle-kit).
- Committed: Yes, together with the SQL migrations.

**`agent/__pycache__/`:**
- Purpose: Python bytecode.
- Generated: Yes.
- Committed: No.

**`.planning/`:**
- Purpose: GSD planning state and this codebase map.
- Generated: No (written by commands).
- Committed: Yes, normally.

**`public/sw.js`:**
- Purpose: service worker. It deliberately does not cache authenticated pages or API responses (`README.md`).
- Generated: No.
- Committed: Yes.

**`test-results/`, `playwright-report/`:**
- Purpose: Playwright artifacts on failure.
- Generated: Yes.
- Committed: No.

---

*Structure analysis: 2026-11-24*
