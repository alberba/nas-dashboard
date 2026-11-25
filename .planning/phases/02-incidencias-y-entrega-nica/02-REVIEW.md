---
phase: 02-incidencias-y-entrega-nica
reviewed: "2026-11-25T11:14:43Z"
depth: standard
files_reviewed: 29
files_reviewed_list:
  - .env.example
  - drizzle/0004_incidents.sql
  - drizzle/meta/_journal.json
  - package.json
  - public/sw.js
  - scripts/check-runtime-config.ts
  - scripts/rollback/0004_incidents.sql
  - src/app/api/[...path]/route.ts
  - src/app/page.tsx
  - src/components/dashboard.tsx
  - src/components/login.tsx
  - src/components/settings.tsx
  - src/components/views/alerts.tsx
  - src/components/views/routes.ts
  - src/lib/agent-snapshots.ts
  - src/lib/collector.ts
  - src/lib/incident-push.ts
  - src/lib/incident-store.ts
  - src/lib/lifecycle.ts
  - src/lib/maintenance-alerts.ts
  - src/lib/nas.ts
  - src/lib/notification-dispatch.ts
  - src/lib/notification-policy.ts
  - src/lib/push.ts
  - src/lib/runtime-config.ts
  - src/lib/schema.ts
  - src/lib/telegram.ts
  - src/lib/types.ts
  - src/worker.ts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
  necessity: 0
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-11-25T11:14:43Z
**Depth:** standard
**Files Reviewed:** 29
**Status:** issues_found

## Summary

I reviewed the phase-02 production and startup surface introduced by plans 02-01…02-05: the `alerts`→`incidents` migration and rollback, the incident store and outbox projection, the snapshot decoders, the notification policy, runtime config/preflight, the worker outbox dispatcher, Telegram/push transports, the incident API/deep link, the alerts/dashboard/login/settings UI and the service worker. The phase's own tests and fixtures were read as evidence; per the skill, test files are only reported here when they affect test reliability.

No Critical findings and no security vulnerability were found in the reviewed surface. The fixed Telegram origin with `redirect: "error"` and no `parse_mode`, the owner-scoped push test, the authenticated host+ID incident lookup, the finite public delivery reasons and the service-worker route allow-list behave as `02-SECURITY.md` describes. The remaining findings are four Warnings (delivery-state projection, a lost-edit race, transient push errors recorded as permanent, and sustained timers spanning data gaps) and four Info items (dead compatibility wrapper, a mislabeled disabled-push reason, an out-of-range incident-ID path and duplicated protocol strings).

Checks/probes run:

- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test` → 41 files / 422 tests pass.
- `pnpm typecheck` → pass.
- `gsd_run check evaluation-scope --phase 02 --raw` → `status: resolved` (task-commit scope).
- Projection probe against the disposable database: a pending outbox row with `result = {state:"failed", reason:"rate_limited"}` projected as `{"channel":"telegram","state":"failed","reason":"permanent_rejection"}`.
- Two-session probe reproducing the send-confirmation/closure interleaving: dispatcher read incident `seq=1`; collector read the opening as `claimed` with `attemptStartedAt` set; after both committed, the incident had `seq=2` and there were 0 `incident-edit` rows.
- Push delivery probe with an injected transport: a 429 and a 500 both produced `{"state":"failed","reason":"endpoint_rejected"}`.
- `git diff --stat 11352daf78764610f1da488546b227757a0b63d0..HEAD` for the change surface.

I did not re-run `pnpm build` or `tests/e2e/incidents.spec.ts`; the orchestrator's context reports both pass. No structural pre-pass (fallow) was supplied.

## Narrative Findings (AI reviewer)

No structural pre-pass was provided, so every finding below comes from direct source review; none is a structural finding.

## Warnings

### WR-01: A pending rate-limited retry is published as a permanent Telegram failure

**File:** `src/lib/notification-dispatch.ts:382-396` (the retry result at `:390`), `src/lib/incident-store.ts:452-471`, `src/components/views/alerts.tsx:12-28`
**Issue:** `recordTelegramRetry` keeps the outbox row `status: "pending"` (it will retry after `retry_after`/backoff) but writes `result = outcome("failed", "rate_limited", …)`. `publicState` returns `result.state` before checking the row status (`incident-store.ts:456`), and `publicReason` maps every `failed` state to `permanent_rejection` (`:470`). The projection therefore publishes `failed`/`permanent_rejection` for a job that is still queued and will be retried, and the UI renders "No entregado · Rechazo permanente del proveedor". Verified with the projection probe above; the existing delivery-projection test only covers a terminal `failed` row, not a pending retry.
**Fix:** Derive the public state from the persisted `status` first: if `status` is `pending` or `claimed`, return `pending` (reason `null`) regardless of the previous attempt result. If the last attempt must stay visible, add a finite `rate_limited` public reason instead of overloading `failed`. Add a test that projects a pending row whose `result` is `{state:"failed", reason:"rate_limited"}`.

### WR-02: A send confirmation racing a closure or severity change can lose the final Telegram edit

**File:** `src/lib/notification-dispatch.ts:329-371` (incident read at `:350-355`), `src/lib/incident-store.ts:111-152` (opening read at `:117-129`) and `:160-246` (opening read at `:167-191`)
**Issue:** `closeEpisode` and `changeSeverity` read the opening outbox row without locking it; `recordTelegramSent` updates that row to `sent` and then reads the incident without locking it. Under READ COMMITTED, both transactions can miss each other: the closing transaction (the collector, or the authenticated stop/removal path in `src/lib/lifecycle.ts` / `src/app/api/[...path]/route.ts` — a different process from the worker) reads the opening as `claimed` with `attemptStartedAt` set (so it returns `none` and queues no edit), while the dispatcher reads the incident before the closure commits (so `incident.seq <= job.revision` and it queues no edit). After both commit, the opening is `sent`, the incident is resolved at a higher `seq`, and there is no `incident-edit` row — the confirmed Telegram message keeps showing the pre-resolution state. The two-session probe reproduced exactly this interleaving with 0 edit rows.
**Fix:** Serialize the two transactions on one row, but only on one side to avoid a lock-order inversion. Either select the incident with `.for("update")` in `recordTelegramSent` (it then waits for the collector's incident update and sees the new `seq`), or select the opening with `FOR UPDATE` in `closeEpisode`/`changeSeverity` (it then waits for the confirmation and sees `sent`). Do not add both. Add a two-connection test that forces this interleaving.

### WR-03: Push 429 and 5xx responses are recorded as permanent failures

**File:** `src/lib/push.ts:67-74`, `:128-147`; `src/lib/notification-dispatch.ts:941-957`
**Issue:** `statusCode` accepts every HTTP status `>= 400`; `deliverPush` counts every non-404/410 error as `rejected` and returns `{state:"failed", reason:"endpoint_rejected"}`; `dispatchPushJob` records `failed` and the job is never retried. That classifies transient push-service responses — notably 429 (rate limited) and 5xx — as permanent. A critical episode's single push fallback can therefore be lost after a transient provider response. The probe returned `failed`/`endpoint_rejected` for both 429 and 500. Telegram already distinguishes 429 (retry) and 5xx (uncertain), but push does not.
**Fix:** Treat 408/425/429 and 5xx as `uncertain` (which preserves D-01's no-duplicate rule) or add a bounded retry with backoff; keep other 4xx (and the existing 404/410 subscription cleanup) as `failed`. Add tests for 429 and 500, not only 410.

### WR-04: Sustained-duration timers keep counting across samples with no evidence

**File:** `src/lib/collector.ts:46-80` (timer at `:67-69`), `:124-130` (early return on `NasInvalidResponse`), `:182-192` (null CPU), `:203-214` (empty disks), `:215-228` (empty temperatures)
**Issue:** `condition` starts the sustained timer on the first failing sample and deletes it only on a not-failing call. The phase's "absence of evidence" policy skips the call entirely when `cpu` is `null`, `disks` is empty or `temperatures` is empty, and `collectHost` returns early on a malformed snapshot; the stored start time survives the gap. A later high sample can then satisfy `now - started >= duration` across a data gap and open a sustained incident on non-contiguous evidence — including the immediate-critical temperature/Telegram path. Scenario: high at t0; `cpu = null` at t0+10 after an agent restart; high at t0+90 with `sustainedSeconds = 60`; the incident opens at t0+90 even though only two high samples exist.
**Fix:** On every skipped evaluation (null CPU, empty disk/temperature list, invalid snapshot) delete the corresponding `started` entry, or track the last observed sample time and require contiguous observations, without calling `recordIncidentObservation` (so an open episode is left untouched). Add tests with a null/empty sample between two high samples.

## Info

### IN-01: `notify` is a dead compatibility wrapper

**File:** `src/lib/push.ts:150-164`
**Issue:** The comment says the wrapper is kept "until 02-05 moves it to the outbox"; 02-05 changed `/api/push/test` to enqueue a durable job (`src/app/api/[...path]/route.ts:701-715`), and no source or test imports `notify` anymore (only its definition remains). It also reads VAPID from the environment directly instead of the validated runtime config.
**Fix:** Remove `notify` or mark it deprecated with a test, so the phase does not ship a lapsed compatibility shim.

### IN-02: A disabled push channel is reported as "Telegram desactivado"

**File:** `src/lib/incident-store.ts:434-444` (`push_disabled` at `:439`), `src/components/views/alerts.tsx:21-28` (label at `:25`)
**Issue:** `finiteReasons` maps the internal `push_disabled` reason to `telegram_disabled`, so a push fallback suppressed because VAPID is off is rendered as "Suprimido · Telegram desactivado" with `channel: "push"`, even when Telegram is configured. The public reason set has no push-disabled (or generic channel-disabled) value, so the mapping is lossy; `no_subscriptions` and `owner_required` similarly collapse to `policy_silent`.
**Fix:** Add a finite `push_disabled` (or generic `channel_disabled`) value to `PublicDeliveryReason`, map it in `finiteReasons`, and label it in the alerts view; keep the finite-reason property.

### IN-03: The incident-id grammar admits values outside the PostgreSQL integer range

**File:** `src/app/api/[...path]/route.ts:230-244`
**Issue:** The route accepts `^[1-9]\d{0,9}$` (up to 9,999,999,999) and only checks `Number.isSafeInteger`, but `incidents.id` is a PostgreSQL `integer` (max 2,147,483,647). A syntactically valid deep link such as `/?view=alerts&host=nas-home&incident=3000000000` reaches `eq(alerts.id, 3000000000)` and PostgreSQL raises "value out of range for type integer"; the catch returns 503 and logs an API error. The dashboard only treats 404 as the missing state (`src/components/dashboard.tsx:335-341`), so the user gets neither the episode nor the not-found message. The same 10-digit grammar appears in `src/components/views/routes.ts:30` and `public/sw.js:7`.
**Fix:** Cap the id at 9 digits (or check `incidentId <= 2_147_483_647`) and keep `routes.ts`/`sw.js` in sync; return 404 for an out-of-range id. Add a route test at the boundary.

### IN-04: Outbox keys and notification tags are duplicated protocol strings

**File:** `src/lib/incident-store.ts:56-62`, `src/lib/notification-dispatch.ts:103-113`, `src/lib/incident-push.ts:20-25`
**Issue:** The outbox key formats (`incident:<id>:open`, `incident:<id>:edit:<seq>`) are defined independently in the store and the dispatcher, and the notification tag (`hub:incident:<host>:<id>`) is defined independently in the dispatcher and the browser refresh module. Each pair must match byte-for-byte for edits and local tray refreshes to work; a change in one module silently breaks the other without a type error or a cross-module test.
**Fix:** Export the key/tag builders from one shared module and import them everywhere; add a unit test that pins the format.

---

_Reviewed: 2026-11-25T11:14:43Z_
_Reviewer: GSD code reviewer (execute:post gate, phase 02)_
_Depth: standard_
