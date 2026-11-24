---
last_mapped_commit: d44d511383881a695bfebf39a4752719e3588909
last_mapped_at: 2026-11-24
---
# Coding Conventions

**Analysis Date:** 2026-11-24

## Authority Documents

Read these before writing code, in this order:

1. `AGENTS.md` — the repository-level agent instructions. It requires reading the bundled Next.js 16 guides under `node_modules/next/dist/docs/` before touching framework code, because this Next.js version differs from older conventions.
2. `CODING_STANDARD.md` — the only hard rule about tests: they assert **behaviour** (state, outcome, structure), never copy.
3. `DESIGN.md` — UI direction: rows over cards, colour never alone, no shell, and the product vocabulary used across the interface.

`AGENTS.md` is partially generated: the `<!-- BEGIN:nextjs-agent-rules -->` block is re-added by `next dev`. Do not remove it from a diff; committing it with the change keeps the tree clean.

## Stack and Toolchain

- **Runtime/package manager:** Node 26 in CI, pnpm 12.15.0 (`packageManager` in `package.json`). Install with `pnpm install --frozen-lockfile`; build-script approvals live in `pnpm-workspace.yaml` (`allowBuilds`).
- **Language:** TypeScript 7 (`typescript@^7.0.2`) with React 19.3 and Next.js 16.4 App Router.
- **Linting:** ESLint 10 flat config in `eslint.config.mjs`, composed from `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`.
- **Formatting:** no Prettier dependency and no Prettier config. Formatting is manual and consistent: 2-space indent, double quotes, semicolons, trailing commas in multiline literals, roughly 80-column wrapping.
- **Python:** Python 3.14 (`agent/Dockerfile`, `.github/workflows/ci.yml`), standard library plus `PyYAML==6.0.3` (`agent/requirements.txt`). No formatter or linter is configured for Python.

Commands that define the quality gate:

```bash
pnpm typecheck   # tsc --noEmit --incremental false
pnpm lint        # ESLint through the TypeScript 6 API adapter
pnpm test        # Vitest, tests/**/*.test.ts
pnpm test:agent  # python3 -m unittest discover -s agent -p 'test_*.py'
pnpm test:e2e    # Playwright, tests/e2e
```

## File Organization

- `src/app/` — App Router pages, layouts, and route handlers. The whole JSON API is one catch-all at `src/app/api/[...path]/route.ts`; Better Auth has its own handler at `src/app/api/auth/[...all]/route.ts`.
- `src/components/` — client UI. Shared primitives live in `src/components/ui.tsx`; views live in `src/components/views/`; the reusable confirmation lives in `src/components/sensitive-action/`.
- `src/lib/` — framework-free domain logic, API clients, validation, database access, and data mappers. A module is named after one concern (`src/lib/maintenance-status.ts`, `src/lib/renovate-view.ts`, `src/lib/log-viewer.ts`).
- `src/worker.ts` — the long-running collector process, started with `pnpm worker`.
- `agent/` — the Python NAS agent: one module per domain (`agent/lifecycle.py`, `agent/deployments.py`, `agent/env_settings.py`) plus `agent/server.py`, the HTTP boundary.
- `tests/` — all TypeScript tests, separate from source. Browser tests live in `tests/e2e/`.
- `scripts/` — operator scripts (`scripts/migrate.ts`, `scripts/configure.mjs`, `scripts/reset-password.ts`).
- `drizzle/` — generated SQL migrations and snapshots. Do not hand-edit generated migration files.

Place a new file next to the concern it belongs to. Do not create a new top-level directory for a single module.

## Naming Patterns

**Files:**
- TypeScript modules and components use **kebab-case**: `src/lib/maintenance-status.ts`, `src/lib/deploy-progress.ts`, `src/components/views/container-logs.tsx`, `src/components/sensitive-action/sensitive-action.tsx`.
- React hooks in their own file use a `use-` prefix: `src/components/views/use-host-read.ts`, `src/components/views/use-renovate.ts`, `src/components/views/use-maintenance-snapshot.tsx`.
- CSS Modules mirror the component they style: `src/components/views/maintenance-status.module.css`, `src/components/chart.module.css`.
- Python modules in `agent/` are lowercase snake_case words: `agent/host_metrics.py`, `agent/maintenance_actions.py`, `agent/env_settings.py`.

**Functions:**
- camelCase. Actions are verb-first; pure selectors are noun-first: `statusCells`, `failedUnitGroups`, `parseHosts`, `resolveHost`, `publicHost` (`src/lib/hosts.ts`), `deploymentsForHost` (`src/lib/deployments.ts`), `startSnapshotPolling` (`src/lib/maintenance-polling.ts`).
- React components are PascalCase and exported from kebab-case files: `export function MaintenanceSnapshotStatus(...)` in `src/components/views/maintenance-status.tsx`, `export function StatusStrip(...)` in `src/components/ui.tsx`.
- Hooks are `useXxx` and return an object or tuple: `useHostRead<T>(path, revision)` in `src/components/views/use-host-read.ts`, `useHostScope()` in `src/components/host-context.tsx`.
- Python functions are snake_case: `configured_roots`, `allowed_networks`, `container_logs`, `parse_line_count` (`agent/server.py`, `agent/logs.py`, `agent/deployments.py`).

**Variables:**
- camelCase in TypeScript, snake_case in Python.
- Booleans read as predicates: `mutation`, `connected`, `stale`, `followerReadable`, `securityReadable`.
- Short local abbreviations are acceptable when obvious: `snap`/`snapshot`, `pr`, `id`, `url`, `db`, `ctx`. Do not invent new ones.
- Numeric literals use `_` separators: `75_000` (`src/lib/hosts.ts:5`), `300_000` (`src/lib/nas.ts:18`), `1_763_040_000` (`tests/host-fixtures.ts`).

**Types:**
- PascalCase type aliases; `type` is preferred over `interface` throughout. The single `interface` is `VerificationStore` in `src/lib/verification.ts:40`.
- Finite states are unions of literals, never free strings:
  ```ts
  export type StatusTone =
    "gain" | "loss" | "peach" | "lilac" | "accent" | "muted";

  export type FollowerCell = {
    state: "active" | "paused" | "inactive" | "failed" | "deploying" | "absent";
    tone: StatusTone;
    ...
  };
  ```
  (`src/lib/maintenance-status.ts:4-25`)
- Request variants use discriminated unions: `actionSchema` in `src/lib/validation.ts:14`, `DeployStep`/`DeployStepId` in `src/lib/types.ts:223-238`.
- Derive literal unions from `as const` arrays: `deployStepIds` plus `(typeof deployStepIds)[number]` (`src/lib/types.ts:223-231`).
- Type-only imports are explicit: `import type { MaintenanceSnapshot } from "./maintenance";`, `import { getHosts, type HostConfig } from "./hosts";`.

**Constants:**
- SCREAMING_SNAKE_CASE for true module constants: `CONNECTION_STALE_MS` (`src/lib/hosts.ts:5`), `CONTAINER_UPDATE_TIMEOUT_MS` (`src/lib/nas.ts:18`), `MAX_PAYLOAD`/`DEFAULT_LINES` (`agent/logs.py`), `MAX_REQUEST_BYTES` (`agent/env_settings.py`).
- Short local lookup tables stay camelCase: `const ranges = {...} as const;` (`src/app/api/[...path]/route.ts:62`).

**Database:**
- Tables are plural where the domain allows it: `samples`, `alerts`, `operations`, `presence`, `subscriptions`, `configuration` (`src/lib/schema.ts`). Auth tables keep Better Auth's singular names (`user`, `session`, `account`, `verification`, `passkey`).
- Per-host tables carry a `hostId` column; settings are keyed by `(hostId, id)`.

## Code Style

**Formatting:**
- No Prettier config and no Prettier dependency. Match the surrounding file rather than running a formatter.
- Arrow functions for local helpers; `export function` for the public surface. `src/lib/` currently contains 61 `export function` and 45 `export const` declarations.
- Implicit return for small expressions:
  ```ts
  const degraded = (snapshot: MaintenanceSnapshot, ...sections: string[]) =>
    sections.some((section) => snapshot.degraded.includes(section));
  ```
  (`src/lib/maintenance-status.ts:7-8`)
- Guard clauses and early returns keep nesting shallow; see `parseHosts` and `resolveHost` in `src/lib/hosts.ts`.
- Nested ternaries are used for exhaustive state mapping, indented one level per branch: the tone mapping in `src/lib/maintenance-status.ts:101-111`, the relative-time ladder in `src/components/views/maintenance-status.tsx:26-34`.
- `??` and `?.` are preferred for optional data; `||` is reserved for intentional falsy defaults.

**Linting:**
- Flat config, no custom rules and no stylistic rules. TypeScript and Next.js rules are the contract.
  ```js
  // eslint.config.mjs
  const eslintConfig = defineConfig([
    ...nextVitals,
    ...nextTs,
    globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  ]);
  ```
- `pnpm lint` runs through `scripts/eslint-typescript-api.mjs`, which aliases the `typescript` specifier to `typescript-api` (the TypeScript 6 JS API) because ESLint cannot load the native TypeScript 7 compiler. Keep that adapter until typescript-eslint supports TS 7:
  ```js
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === "typescript" ? api : specifier, context);
    },
  });
  ```
  (`scripts/eslint-typescript-api.mjs`)

**TypeScript configuration (`tsconfig.json`):**
- `strict: true`, `noEmit: true`, `isolatedModules: true`, `module: "esnext"`, `moduleResolution: "bundler"`, `jsx: "react-jsx"`, `target: "ES2017"`.
- Path alias `@/*` → `./src/*`.
- `pnpm typecheck` runs `tsc --noEmit --incremental false`.

## Import Organization

**Order:**
1. Node builtins with the `node:` protocol: `import { createServer } from "node:http";`, `import { randomBytes } from "node:crypto";`.
2. Framework/runtime packages: `next/server`, `next/headers`, `react`.
3. Third-party libraries: `drizzle-orm`, `zod`, `effect`, `lucide-react`, `pg`.
4. Absolute project imports via `@/`: `@/lib/auth`, `@/lib/db`, `@/lib/schema`, `@/components/...`.
5. Relative imports for siblings and children: `./maintenance`, `./db`, `../ui`, `./maintenance-status.module.css`.

Observed in `src/app/api/[...path]/route.ts:1-54` and `src/lib/events.ts:1-9`. There is no automatic import sorter; preserve the existing group order.

**Path Aliases:**
- `@/*` → `src/*` in `tsconfig.json`, mirrored in `vitest.config.ts`.
- Both styles are legitimate: `@/lib/...` in route handlers, tests, and cross-tree components; relative `./...` inside `src/lib` so a module does not import through its own alias.

**Type-only imports:** use `import type` or an inline `type` modifier. Do not import a type as a value.

## Error Handling

**TypeScript strategies:**

1. **Tagged Effect errors at the NAS agent boundary.** `src/lib/nas.ts` defines `NasUnavailable`, `NasRejected`, and `NasInvalidResponse` with `Data.TaggedError`, models the failure channel in `Effect.Effect<T, ...>`, and converts to a promise at the Next.js boundary with `Effect.result`:
   ```ts
   export class NasRejected extends Data.TaggedError("NasRejected")<{
     readonly status: number;
     readonly message: string;
   }> {}

   export async function nasForHost<T>(host, path, body?, timeoutMs?): Promise<T> {
     const result = await Effect.runPromise(Effect.result(nasEffectForHost<T>(...)));
     if (Result.isFailure(result)) throw result.failure;
     return result.success;
   }
   ```
   (`src/lib/nas.ts:4-86`)
2. **Custom `Error` subclasses with a stable `name`** for configuration and lookup failures: `HostConfigError`, `HostNotFound` (`src/lib/hosts.ts:7-19`), `GithubConfigError`, `GithubUnavailable` (`src/lib/github.ts`). `HostNotFound` and `GithubUnavailable` carry their detail as readonly constructor parameter properties.
3. **Central translation to HTTP in the catch-all route.** `src/app/api/[...path]/route.ts:676-709` maps each class to a status and a Spanish message, then falls back to a generic 503:
   ```ts
   if (error instanceof HostNotFound)
     return json({ error: "Host no configurado" }, 404);
   if (error instanceof HostConfigError)
     return json({ error: "La configuración de hosts del servidor no es válida" }, 503);
   if (error instanceof z.ZodError)
     return json({ error: error.issues[0]?.message ?? "Datos no válidos" }, 400);
   ```
   Route modules never leak stack traces, tokens, or agent URLs.
4. **Zod at every external boundary.** Request bodies, query params, agent responses, and environment configuration are parsed:
   - `actionSchema` / `settingsSchema` in `src/lib/validation.ts`.
   - `host`/`hostId` schemas in `src/lib/hosts.ts:21-41`.
   - `logsResponseSchema.safeParse(...)` before returning agent logs (`src/app/api/[...path]/route.ts`).
   - Use `.safeParse` when the caller needs a branch; `.parse` when invalid input should throw into the central handler.
5. **Never retry a mutation automatically.** A timeout after a mutating agent call is reported as pending, with an explicit instruction to verify before repeating (`src/app/api/[...path]/route.ts:536-553`):
   ```ts
   // A timeout may occur after the NAS executed the action. Never retry it automatically.
   ```
   Idempotency is enforced with an `Idempotency-Key` UUID and an `operations` row (`:423-479`).

**Python strategies (`agent/`):**
- Invalid input raises `ValueError` with a Spanish message; the request handler maps it to HTTP 400:
  ```python
  except (ValueError, KeyError) as exc:
      self.respond(400, {"error": str(exc) if isinstance(exc, ValueError) else "Solicitud no válida"})
  except (OSError, http.client.HTTPException):
      status = 502 if self.command == "POST" else 503
      self.respond(status, {"error": "No se pudo confirmar el resultado; comprueba el estado antes de repetir la operación"})
  ```
  (`agent/server.py:529-533`)
- Validators are standalone functions that raise early: `parse_line_count` (`agent/logs.py:40-49`), `checked_path` (`agent/server.py`), `parse_since` (`agent/logs.py`).
- Domain errors are small `RuntimeError`/`OSError`/`ValueError` subclasses with a docstring: `GitError` (`agent/deployments.py:59`), `EnvSettingsError` (`agent/env_settings.py:44`), `CommandFailed` (`agent/host_commands.py:33`, `agent/maintenance_actions.py:29`).
- Broad `except Exception` is allowed only at process boundaries where degradation is the product behaviour: the trash cleanup loop logs and continues (`agent/server.py:538-547`), and per-container metric failures do not abort the snapshot.

## Logging

**TypeScript:**
- Framework: bare `console`; no logger package.
- `console.error` is used for unexpected server-side failures only, with a stable prefix and minimal detail: `console.error("API error", error instanceof Error ? error.name : "unknown")` (`src/app/api/[...path]/route.ts:701`), `console.error("GitHub error", error.status)`, `console.error(\`Error de recogida en ${host.id}\`)` (`src/lib/collector.ts`).
- Never log tokens, request bodies, agent URLs, or full errors.
- `console.log` is reserved for operator scripts and the worker banner: `scripts/migrate.ts`, `scripts/configure.mjs`, `src/worker.ts:18`.

**Python:**
- `print(..., flush=True)` only in the trash cleanup loop (`agent/server.py:546`).
- The HTTP handler overrides `log_message` to discard request logs, so query strings containing file names or bearer credentials are never logged:
  ```python
  def log_message(self, fmt, *args):
      # Never log query strings containing file names or bearer credentials.
      pass
  ```
  (`agent/server.py:440-442`)
- API responses carry user-facing Spanish text; observability is the hub's job.

## Comments

**When to Comment:**
- Comments explain **why**, not what, and are written in English even though UI copy is Spanish:
  ```ts
  // A timeout may occur after the NAS executed the action. Never retry it automatically.
  ```
  (`src/app/api/[...path]/route.ts:537`)
- Security invariants are called out: `// Never pass v=1: named and anonymous volumes stay on the host.` (`agent/server.py:412`).
- Non-obvious numeric choices get a one-line rationale: `/** A Compose pull and recreate can outlast the normal action timeout. */` (`src/lib/nas.ts:17`), `/** A sample older than this marks the host as disconnected in the hub. */` (`src/lib/hosts.ts:4`).

**JSDoc/TSDoc:**
- Single-line `/** ... */` above exported helpers whose contract is not obvious: `statusCells`, `failedUnitGroups` (`src/lib/maintenance-status.ts`), `githubConfig` (`src/lib/github.ts`), `parent_fd` (`agent/server.py`).
- Multi-paragraph Python module docstrings state the read-only/security contract at the top of each module: `agent/deployments.py:1-5`, `agent/logs.py:1-18`, `agent/maintenance.py:1`, `agent/host_metrics.py:1-7`, `agent/env_settings.py:1-12`.
- Do not add JSDoc that merely restates the signature. There is no doc-comment lint.

## Function Design

**Size:**
- Pure logic is extracted into small functions in `src/lib/*` and unit-tested. Components stay presentational where possible; heavy mapping (`statusCells`, `failedUnitGroups`) lives outside the `.tsx`.
- Large orchestration files are accepted at the boundaries: `src/app/api/[...path]/route.ts` (713 lines) is one `handle()` router with early-return blocks. Add a new `if (route === "...") return ...` branch rather than a second catch-all.
- No enforced maximum function length; prefer guard clauses and extraction when a branch exceeds roughly 20 lines.

**Parameters:**
- Prefer a single options object when a function has more than two meaningful arguments, and destructure at the call site:
  ```ts
  export function startSnapshotPolling({
    url, fetcher, intervalMs, onChange,
  }: { url: string; fetcher: typeof fetch; intervalMs: number; onChange: (state: SnapshotState) => void }) { ... }
  ```
  (shape used in `src/lib/maintenance-polling.ts`, exercised by `tests/maintenance-polling.test.ts`)
- Inline prop types are common for components: `{ tone }: { tone: Tone }` (`src/components/ui.tsx:5`), `{ id, name }: { id: string; name: string }` (`src/components/views/container-logs.tsx`). Define a named type only when it is reused or exported.
- Dependency injection is by optional parameter with a production default: `parseHosts(env = process.env)`, `getHosts(env = process.env)` (`src/lib/hosts.ts:81,109`), `nasForHost(host, path, body?, timeoutMs?)` (`src/lib/nas.ts`).
- Python constructors take explicit keyword arguments for test seams (`journal_reader`, `clock`, `cache_seconds` in `agent/deployments.py`, exercised by `agent/test_deployments.py`).

**Return Values:**
- Return plain typed objects, never tuples, except where a tuple is the domain (`ranges["1h"] → [seconds, bucket]`, `src/app/api/[...path]/route.ts:62-68`).
- Optional data is `T | null`, not `undefined`, in domain types; `undefined` is used for absent object properties. Examples: `MaintenanceSnapshot` fields in `src/lib/maintenance.ts`, `NetworkInterface.rx: number | null` (`src/lib/types.ts`).
- Formatting helpers return an em dash when data is missing:
  ```ts
  export function bytes(value: number | null | undefined, rate = false) {
    if (value === null || value === undefined || !Number.isFinite(value))
      return "—";
    ...
  }
  ```
  (`src/lib/format.ts:1-4`)

## Module Design

**Exports:**
- Named exports only. The only default exports are Next.js file conventions: `src/app/layout.tsx:24`, `src/app/page.tsx:9`, and the E2E harness page `src/app/e2e/sensitive-action/page.tsx:11`.
- Route handlers export the HTTP verbs, all bound to one `handle`: `export const GET = handle; export const POST = handle; export const DELETE = handle;` (`src/app/api/[...path]/route.ts:711-713`).
- Public helper modules export their types alongside the functions (`StatusCells`, `StatusTone`, `HostConfig`, `TestDatabase`), so consumers do not reach into internals.

**Barrel Files:**
- None. Import from the concrete module (`@/lib/maintenance-status`, not `@/lib`). There is no `index.ts` in `src/lib` or `src/components`.

**Client/server split:**
- Every interactive component starts with `"use client";` on line 1 (`src/components/dashboard.tsx:1`, `src/components/views/maintenance-status.tsx:1`, `src/components/host-context.tsx:1`). Server components (`src/app/page.tsx`, `src/app/e2e/sensitive-action/page.tsx`) do not.
- Data fetching in client components goes through a host-scoped hook, never a bare `fetch` in a component body: `useHostRead` (`src/components/views/use-host-read.ts`) or a dedicated polling hook (`src/lib/maintenance-polling.ts`, `src/lib/renovate-polling.ts`).
- The host scope comes from `useHostScope()` in `src/components/host-context.tsx`; build URLs with `withHost(path)` / `routeHref(...)` (`src/components/views/routes.ts`) so the `host` query parameter is preserved.

## React / Next.js Conventions

- **App Router only.** Routes live under `src/app`; the JSON API is one catch-all at `src/app/api/[...path]/route.ts` plus the Better Auth handler at `src/app/api/auth/[...all]/route.ts`.
- **Dynamic rendering for data routes:** `export const dynamic = "force-dynamic";` and `Cache-Control: no-store` on every JSON response (`src/app/api/[...path]/route.ts:56-61`).
- **State attributes are the test contract.** Components expose `data-*` attributes for state instead of relying on class names or copy: `data-view`, `data-host`, `data-state`, `data-tone`, `data-segment`, `data-table`, `data-harness-outcome`. When state has no hook, add a `data-*` attribute — this is explicit in `CODING_STANDARD.md`.
- **Accessibility is part of the convention:** `aria-labelledby` on panels, `aria-pressed` on segmented controls and chips, `aria-current` on navigation, `role="group"` + `aria-label` on strips (`src/components/ui.tsx:25,62,87,92,114,120`; `src/components/dashboard.tsx:405`).
- **Copy is Spanish and informal-technical**, using the product vocabulary from `DESIGN.md` (`sana`, `falla`, `retenida`, `desplegando`, `Seguidor`, `Copia`). Do not translate state names; map them in a lookup table (`src/components/views/maintenance-status.tsx`).
- **Colour never travels alone.** Pair a `StatusDot` tone with text (`<StatusDot tone={tone} />` + label), per `DESIGN.md` and `src/components/ui.tsx:5-7`.
- **Browser globals are touched inside `useEffect` only** (`src/components/views/use-host-read.ts`), so server rendering and hydration stay clean.
- **React 19 idioms:** `use(Context)` instead of `useContext` (`src/components/host-context.tsx`), and refs/state typed explicitly when they hold DOM nodes or unions (`useRef<HTMLDialogElement>(null)` in `src/components/dashboard.tsx`).

## Data, Validation, and Security Conventions

- **Schema first:** tables and columns are declared in `src/lib/schema.ts` with Drizzle's `pgTable`; migrations are generated into `drizzle/` and never hand-edited. `drizzle.config.ts` points at `./src/lib/schema.ts` and `./drizzle`.
- **Host scoping:** every per-host read takes a host resolved with `resolveHost(getHosts(), request.nextUrl.searchParams.get("host"))`; writes persist `hostId`. Settings are read/written through `getSettings(host.id)` / `saveSettings(host.id, ...)` (`src/lib/settings.ts`).
- **Validate before acting:** Zod schemas in `src/lib/validation.ts` and `src/lib/hosts.ts` are the only accepted shape for external input. A validation failure must happen before any agent call or database write.
- **Origin checks on mutations:** non-GET requests require an `Origin` in `origins` (`src/app/api/[...path]/route.ts:110-113`); tests assert the 403 (`tests/e2e/dashboard.spec.ts`).
- **Constant-time secret comparison:** setup tokens use `timingSafeEqual` with a length check (`src/app/api/[...path]/route.ts:127-134`); the agent compares bearer tokens with `hmac.compare_digest` (`agent/server.py:452`).
- **Destructive actions need a typed confirmation** validated by the schema: `REINICIAR NAS`, `VACIAR PAPELERA`, or the exact container name (`src/lib/validation.ts:14-33`, `agent/lifecycle.py:135`).
- **No secrets in responses or logs.** Agent tokens and URLs stay server-side; tests assert their absence from JSON bodies.

## CSS Conventions

- Global tokens and base styles live in `src/app/globals.css`: OKLCH custom properties on `:root` (`--bg`, `--side`, `--panel`, `--panel2`, `--line`, `--ctrl-line`, `--row-line`, `--row-hover`, `--code-bg`, `--text`, `--soft`, `--muted`, `--accent`, `--gain`, `--loss`, `--lilac`, `--peach`), fluid type/spacing via `clamp()`, and font variables for Manrope/Unbounded.
- Component styles are **CSS Modules** (12 `*.module.css` files under `src/components/`), imported as `styles` or a named alias when a file composes two:
  ```ts
  import styles from "./maintenance-status.module.css";
  import extraStyles from "./maintenance-extra.module.css"; // src/components/views/maintenance.tsx
  ```
- Do not introduce new colour values. Modules consume `:root` tokens (`src/components/views/maintenance-status.module.css:1-2`).
- Tailwind CSS 4 is imported (`@import "tailwindcss";`), but the UI is written with semantic global classes plus modules. `next.config.ts` excludes `*.module.css` from the Tailwind Turbopack loader so modules keep scoped names — preserve that condition:
  ```ts
  condition: { not: { path: /\.module\.css$/ } },
  ```
- Shared table/row classes live in `globals.css` and are extended by modules (`src/components/files-apps.module.css`).

## Python Conventions (`agent/`)

- **Runtime:** Python 3.14, standard library only plus `PyYAML==6.0.3`. No Flask/FastAPI: the API is `ThreadingHTTPServer` + `BaseHTTPRequestHandler` (`agent/server.py:16,439`).
- **No type annotations in function signatures.** Contracts are documented in docstrings and enforced with runtime validation. The only annotations are a `NamedTuple` in `agent/logs.py:33-38` and local field declarations; modules that benefit from forward references declare `from __future__ import annotations` (`agent/deployments.py:6`, `agent/env_settings.py:14`).
- **Module-level configuration from environment**, read once at import and exposed as UPPER_SNAKE constants:
  ```python
  ROOTS = configured_roots(os.getenv("FILES_ENABLED", "true"), ...)
  TOKEN = os.getenv("AGENT_TOKEN", "")
  ALLOWED_NETWORKS = allowed_networks(os.getenv("ALLOWED_IPS", "127.0.0.1"))
  ```
  (`agent/server.py:57-86`). Tests set `server.TOKEN` / `server.ALLOWED_NETWORKS` and restore them in `tearDown`.
- **Imports are top-level module imports**, not packages: `import deployments`, `import env_settings`, `import maintenance` (`agent/server.py:19-27`). Tests do the same (`import server`, `import deployments`).
- **Security invariants are explicit and commented:** path traversal checks with `Path.parts`, `is_symlink()`, `is_relative_to`, `O_NOFOLLOW`, and `renameat2` no-replace (`agent/server.py`, `agent/env_settings.py`); constant-time bearer comparison (`agent/server.py:452`); token length checked at startup (`agent/server.py:551-552`).
- **Locks:** a global `threading.RLock` guards the short request path; long Compose updates use a non-blocking `threading.Lock` and bypass the global lock (`agent/server.py:83-86`). Slow read-only endpoints (`/maintenance`, `/deployments`) run outside the lock.
- **String formatting:** `%` formatting in error strings (`"Docker no pudo completar la operación (%s)" % response.status`), f-strings in tests. Follow the surrounding module.
- **Response shape:** always JSON via `respond(status, data)`; never return HTML. Unknown routes return `404 {"error": "No encontrado"}`.
- **Read-only modules stay read-only.** `agent/deployments.py`, `agent/maintenance.py`, and `agent/host_metrics.py` document that they never write; mutations live in `agent/maintenance_actions.py`, `agent/env_settings.py`, `agent/updates.py`, and `agent/lifecycle.py`.

## Where to Add New Code

- **New domain logic:** a new kebab-case module in `src/lib/`, e.g. `src/lib/renovate-view.ts`. Export pure functions and types; keep it free of React and of `next/*` unless it is a boundary adapter.
- **New API endpoint:** add an early-return branch in `handle()` in `src/app/api/[...path]/route.ts`, validate with Zod, resolve the host with `resolveHost(getHosts(), ...)`, and map domain errors in the single `catch`.
- **New agent call:** add an Effect wrapper near `src/lib/nas.ts` or call `nasForHost<T>(host, path, body?, timeoutMs?)`; never `fetch` the agent directly from a route.
- **New view:** `src/components/views/<name>.tsx` with `"use client"`, a matching `<name>.module.css` if it needs local styles, and `data-*` hooks for every state a test must observe.
- **New shared UI primitive:** `src/components/ui.tsx` (`StatusDot`, `StatusStrip`, `Panel`, `Segmented`, `FilterChips`).
- **New database table/column:** `src/lib/schema.ts` plus a generated migration in `drizzle/`; include `hostId` on per-host data.
- **New agent endpoint:** a branch in `Handler.handle_request` in `agent/server.py`, a pure function in a new or existing `agent/<domain>.py`, and a matching `agent/test_<domain>.py`.
- **New test:** follow `TESTING.md`; TypeScript tests go in `tests/` (API suites named `api-<endpoint>.test.ts`), browser tests in `tests/e2e/*.spec.ts`, Python tests in `agent/test_<module>.py`.

## Tests and User-Facing Text

- `CODING_STANDARD.md` is normative: a test may go red only when the product stops working. Assert on **state** (`data-view`, `aria-current`, `aria-expanded`), **outcome** (URL, status, stored row, request sent, file moved), or **structure** (`getByRole`, `getByLabel`). Never assert on headings, slogans, messages, or labels that are free to change.
- Before finishing a change to user-facing text, grep `tests/` for the old string. A match is copy coupling and the test must be rewritten to assert behaviour.
- Tests live outside `src/` in `tests/` and `agent/test_*.py`; see `TESTING.md` for the full taxonomy and commands.

---

*Convention analysis: 2026-11-24*
