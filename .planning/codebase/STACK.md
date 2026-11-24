---
last_mapped_commit: d44d511383881a695bfebf39a4752719e3588909
last_mapped_at: 2026-11-24
---
# Technology Stack

**Analysis Date:** 2026-11-24

## Languages

**Primary:**
- TypeScript 7.0.2 - All hub application code: Next.js pages and components (`src/app`, `src/components`), API routes (`src/app/api/[...path]/route.ts`), domain libraries (`src/lib`), and the background worker (`src/worker.ts`). Version pinned in `package.json`; lock entry `typescript@7.0.2` in `pnpm-lock.yaml`.
- Python 3.14 - Private host agent (`agent/server.py` and supporting modules), tests (`agent/test_*.py`), and the agent image base `python:3.14-slim` (`agent/Dockerfile`). Python 3.14 is also used by CI (`.github/workflows/ci.yml`).

**Secondary:**
- SQL (PostgreSQL dialect) - Drizzle schema and migrations (`src/lib/schema.ts`, `drizzle/*.sql`).
- CSS - Tailwind CSS 4 utility classes plus CSS Modules such as `src/components/views/container-logs.module.css`; global stylesheet `src/app/globals.css`.
- JavaScript (ESM) - Build and tooling scripts (`scripts/configure.mjs`, `scripts/eslint-typescript-api.mjs`, `eslint.config.mjs`).

## Runtime

**Environment:**
- Node.js 26 - Application runtime and build environment. `Dockerfile` uses `node:26-bookworm-slim`; CI uses `node-version: 26`; types come from `@types/node` 26.6.6. No `.nvmrc` or `engines` field is present, so 26 is enforced only by Docker and CI.
- Browser runtime - React 19.3.1 client components, PWA service worker (`public/sw.js`) and Web Push subscription flow.
- Python 3.14 - Agent process listening on port 9450 (`agent/server.py`).

**Package Manager:**
- pnpm 12.15.0 - Declared in `package.json` (`"packageManager"`), installed in `Dockerfile`, and used by CI (`pnpm/action-setup@v6`).
- Lockfile: `pnpm-lock.yaml` present (`lockfileVersion: '9.0'`).
- Workspace: `pnpm-workspace.yaml` exists but declares no `packages`; it only configures build-script approvals (`allowBuilds`) and `minimumReleaseAgeExclude` entries. This is a single-package repository.

## Frameworks

**Core:**
- Next.js 16.4.6 - App Router application, Route Handlers, server components, headers and Turbopack build (`next.config.ts`, `src/app`).
- React 19.3.1 / React DOM 19.3.1 - UI (`src/components`, `src/app/layout.tsx`, `src/app/page.tsx`).
- Effect 4.1.2 - Typed errors, cancellation and timeouts for all agent HTTP calls (`src/lib/nas.ts`).
- Drizzle ORM 0.45.4 - PostgreSQL access and typed schema (`src/lib/db.ts`, `src/lib/schema.ts`).
- Better Auth 1.7.20 plus `@better-auth/drizzle-adapter` 1.7.20 and `@better-auth/passkey` 1.7.20 - Authentication, sessions, passkeys and password verification (`src/lib/auth.ts`, `src/lib/auth-client.ts`).
- Zod 4.6.7 - Request, environment and agent-response validation (`src/lib/validation.ts`, `src/lib/hosts.ts`, `src/lib/logs.ts`).
- Tailwind CSS 4.3.5 with `@tailwindcss/turbopack` 4.3.5 - Styling, wired through Turbopack rules in `next.config.ts`.

**Testing:**
- Vitest 5.1.0 - Unit and API tests from `tests/**/*.test.ts` (`vitest.config.ts`).
- Playwright 1.65.0 - End-to-end Chromium tests from `tests/e2e` with base URL `http://localhost:3000` (`playwright.config.ts`).
- Python `unittest` - Agent tests discovered by `pnpm test:agent` (`python3 -m unittest discover -s agent -p 'test_*.py'`).

**Build/Dev:**
- TypeScript compiler `tsc --noEmit --incremental false` - Type checking (`package.json`).
- ESLint 10.14.0 with `eslint-config-next` 16.4.6 - Linting (`eslint.config.mjs`). The `lint` script routes ESLint's TypeScript compiler API to the `typescript-api` alias (`npm:typescript@^6.0.3`) because TypeScript 7 ships a native compiler (`scripts/eslint-typescript-api.mjs`).
- tsx 4.23.15 - Runs the migration script and worker without a separate build (`scripts/migrate.ts`, `src/worker.ts`).
- drizzle-kit 0.31.11 - Migration generation and Drizzle configuration (`drizzle.config.ts`).
- Turbopack - Next.js 16 build/dev bundler; custom `*.css` loader rule in `next.config.ts` excludes CSS Modules.

## Key Dependencies

**Critical:**
- `next` 16.4.6, `react` 19.3.1, `react-dom` 19.3.1 - Framework and UI runtime.
- `better-auth` 1.7.20, `@better-auth/drizzle-adapter` 1.7.20, `@better-auth/passkey` 1.7.20 - Login, session persistence, WebAuthn passkeys and re-verification.
- `drizzle-orm` 0.45.4 and `pg` 8.23.1 - PostgreSQL persistence through a `pg.Pool` with `max: 8` (`src/lib/db.ts`).
- `effect` 4.1.2 - Failure model for agent calls: `NasUnavailable`, `NasRejected`, `NasInvalidResponse` (`src/lib/nas.ts`).
- `zod` 4.6.7 - Boundary validation for hosts, actions, settings, logs, GitHub responses and environment-derived config.
- `web-push` 3.6.7 - VAPID Web Push delivery (`src/lib/push.ts`, `scripts/configure.mjs`).

**Infrastructure:**
- `pg` 8.23.1 - Connection pool to PostgreSQL; used by the app, worker and migration script.
- `tsx` 4.23.15 - Runtime for `pnpm db:migrate` and `pnpm worker` (`scripts/migrate.ts`, `src/worker.ts`).
- `lucide-react` 1.72.0 - Icon set used across dashboard views.
- `@fontsource-variable/manrope` 5.3.0 and `@fontsource-variable/unbounded` 5.3.0 - Self-hosted variable fonts imported in `src/app/layout.tsx`; no external font CDN.
- `typescript-api` (`npm:typescript@^6.0.3`) - Lint-only compiler API alias, not an application dependency.

## Configuration

**Environment:**
- Docker Compose passes server configuration through `env_file: .env` (`compose.yaml`); local scripts load `.env.local` with `--env-file-if-exists` (`package.json`).
- `scripts/configure.mjs` generates `.env`, `agent/.env` and optional `agent/.env.apps` with mode `0600`, including random Better Auth, setup, agent tokens and VAPID keys.
- Required hub variables are documented in `.env.example`: `DATABASE_URL`, `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET` (32+ chars), `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `SETUP_TOKEN` (32+ chars), `NAS_HOSTS`, `NEXT_PUBLIC_APP_DOMAIN`, `BIND_IP`, `PORT`. Legacy single-host fallback uses `NAS_AGENT_URL` + `AGENT_TOKEN` (`src/lib/hosts.ts`).
- Optional hub variables: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_API_URL` for the Renovate view, and `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` for Web Push.
- Agent variables are documented in `agent/.env.example` and `agent/.env.apps.example`; see `INTEGRATIONS.md` for the full list.

**Build:**
- `tsconfig.json` - `target: ES2017`, `strict: true`, `module: esnext`, `moduleResolution: bundler`, `jsx: react-jsx`, no emit, and `@/*` path alias to `./src/*`.
- `next.config.ts` - `poweredByHeader: false`, security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) and Turbopack CSS loader rule.
- `vitest.config.ts` - `@` alias to `./src`, test include `tests/**/*.test.ts`.
- `playwright.config.ts` - Chromium project, one worker, no parallelism, `pnpm start` web server, readiness probe `http://localhost:3000/api/setup`.
- `drizzle.config.ts` - Schema `./src/lib/schema.ts`, output `./drizzle`, PostgreSQL dialect, credentials from `DATABASE_URL`.
- `eslint.config.mjs` - `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`.
- `Dockerfile` - Multi-stage `node:26-bookworm-slim`; build runs `pnpm install --frozen-lockfile`, uses `NEXT_PUBLIC_APP_DOMAIN` build arg and a throwaway `BETTER_AUTH_SECRET`, then production image runs `pnpm start --hostname 0.0.0.0` as user `node`.
- `compose.yaml` - Services `db` (`postgres:18-bookworm`), `migrate`, `app` and `worker`; migrations gate app/worker startup; no database port is published.

## Platform Requirements

**Development:**
- Node.js 26 and pnpm 12.15.0.
- PostgreSQL 18 reachable through `DATABASE_URL` for the app, worker and `pnpm db:migrate` (CI uses the `postgres:18` service; local Compose uses `postgres:18-bookworm`).
- Python 3.14 and `PyYAML==6.0.3` (`agent/requirements.txt`) for agent tests.
- Chromium installed through Playwright for E2E tests.
- Docker with Compose for the full stack and for any host/agent integration work.
- macOS or Linux for the hub; the agent itself requires Linux (Docker socket, `/proc`, `/sys`, `nsenter`, `systemd`, `smartctl`).

**Production:**
- Docker Compose on Linux for the hub server (deployment workflow targets an Oracle server reachable over Tailscale): `db`, `migrate`, `app`, `worker` from `compose.yaml`.
- Private NAS and apps servers running the Python agent images from `agent/compose.yaml` and `agent/compose.apps.yaml`; the NAS agent runs with `network_mode: host` and host resource mounts.
- PostgreSQL 18 with a persistent `postgres` volume; exactly one web replica and one worker, enforced by a worker advisory lock.
- HTTPS reverse proxy (Nginx Proxy Manager documented in `README.md`) or a private Tailscale Serve entry; no database or agent port should be exposed publicly.

---

*Stack analysis: 2026-11-24*
*Update after major dependency changes*
