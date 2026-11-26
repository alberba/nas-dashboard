---
phase: 04-resumen-diario
fixed_at: 2026-11-26T10:23:40Z
review_path: .planning/phases/04-resumen-diario/04-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 4: Code Review Fix Report

**Fixed at:** 2026-11-26T10:23:40Z
**Source review:** `.planning/phases/04-resumen-diario/04-REVIEW.md`
**Iteration:** 1
**Scope:** `critical_warning` (WR-01 … WR-04; the eight Info findings were left untouched)

**Summary:**
- Findings in scope: 4
- Fixed: 4
- Skipped: 0

## Fixed Issues

### WR-01: Digest header date comes from the snapshot instant, not from the digest's civil date

**Files modified:** `src/lib/digest-content.ts`, `src/lib/digest-runs.ts`, `tests/notification-dispatch.test.ts`
**Commit:** `fd50690`
**Status:** fixed: requires human verification
**Applied fix:** `DigestSnapshotInput` now carries `date` and `buildDigestSnapshot` renders
`input.date` instead of `madridDateOf(input.snapshotAt)`. `prepareDigestRuns` selects the
row's `"date"` alongside the period bounds and passes it through, so a delivery after
midnight labels its own civil day. The unused `madrid-day` import was removed. The
midnight-crossing test now asserts the delivered text starts the title with
`Resumen diario · 2026-11-26`, never contains `2026-11-27`, and equals the frozen payload;
the `digestSnapshotInput` helper gained a `date` default for the direct snapshot tests.

### WR-02: Agent health probe accepts `NaN` as a fresh `progressAt`

**Files modified:** `agent/server.py`, `agent/test_metrics.py`
**Commit:** `e394386`
**Status:** fixed
**Applied fix:** `read_health_check` rejects any non-finite `progressAt`
(`math.isfinite`) before the future/stale comparisons, matching the Node worker probe.
A new test writes `NaN`, `Infinity` and `-Infinity` marks through `write_health_mark`
(which serialises them with Python's extended JSON) and asserts `(False, "malformed")`.

### WR-03: Provider `retry_after` is unclamped and can strand a digest as `uncertain`

**Files modified:** `src/lib/telegram.ts`, `tests/telegram.test.ts`, `tests/notification-dispatch.test.ts`
**Commit:** `4164474`
**Status:** fixed: requires human verification
**Applied fix:** `retryAfterMs` clamps the parsed wait to the new
`TELEGRAM_MAX_RETRY_AFTER_MS`, applied after the seconds→milliseconds multiplication so a
finite `seconds` that overflows to `Infinity` is capped too. The cap is the 2 h digest
recovery window rather than the reviewer's 15 min sample: any wait at or beyond that
window already makes the digest end as `window_closed`, so capping below it would
contradict the documented rule that the *next allowed hour* is respected, and a genuine
1 h flood-control pause would otherwise burn the whole attempt budget retrying early.
Tests: a unit case asserts `12`, `1e12` and `1e308` seconds clamp to the cap (with 12 s
still honoured by the existing case), and a new digest case proves `retry_after: 1e15`
ends the day as `failed/window_closed` with a finite stored cooldown instead of throwing
after the attempt mark. Reverting the clamp reproduces the reviewed
`invalid input syntax for type timestamp with time zone` failure.
**Human check:** confirm the 2 h ceiling is the desired policy (it is a product decision,
not a correctness one; the unrepresentable-instant defect is fixed at any finite cap).

### WR-04: The hourly trash purge holds the agent `LOCK` for an unbounded time and starves the progress mark

**Files modified:** `agent/server.py`, `agent/test_metrics.py`
**Commit:** `8343198`
**Status:** fixed: requires human verification
**Applied fix:** `cleanup_loop` now calls `purge_expired_trash()`. Each expired box is
claimed with an atomic rename to `<uuid>.purge` under `LOCK` (an instantaneous operation),
and the unbounded `shutil.rmtree` runs **outside** the lock, so
`HealthServer.service_actions` can keep publishing the mark while a large payload is
deleted. The rename is what keeps a concurrent restore/purge of the same record from
racing the delete, and `discard_orphaned_purges` finishes a delete interrupted between
the claim and the unlink on the next pass. Tests cover: only expired boxes are removed;
the lock is acquirable while the delete is blocked (fails when the delete is wrapped in
`LOCK`, verified); a leftover `.purge` claim is finished on the next pass.
**Human check:** this changes on-disk trash naming transiently (`.purge` suffix) — confirm
an operator-visible directory listing of `.hub-trash` is not relied upon anywhere.

## Verification

All gates ran in the **main checkout** (the orchestrator requested main-tree work, so no
isolated worktree was created; results are reproducible from the current tree).

- `pnpm typecheck` — clean, run after WR-01 and again after WR-03.
- `DATABASE_URL="postgresql://hub:hub@127.0.0.1:55432/hub" HUB_REQUIRE_TEST_DB=1 pnpm exec vitest run --maxWorkers=3 tests/api-incidents.test.ts tests/collector-alerts.test.ts tests/incident-store.test.ts tests/maintenance-alerts.test.ts tests/maintenance-status.test.ts tests/migrations.test.ts tests/runtime-config.test.ts tests/telegram.test.ts tests/notification-dispatch.test.ts` — 9 files, 274 tests passed.
- `pnpm test:agent` — 216 tests; the suite is intermittently red because of a
  **pre-existing** race in `test_env_settings.test_serializes_concurrent_writes_without_losing_updated_bytes`
  (`FileNotFoundError: '.env.lock'` on macOS). Measured on the pristine tree at commit
  `de38f29` during this session: 4 failures in 6 runs, so it is not caused by these fixes
  and was left untouched. `python3 -m unittest test_metrics` on its own is green (13 tests,
  including the four added cases).
- Each Python fix was also checked for regression by briefly reverting the guard/lock and
  observing the new test fail, then restoring it.

---

_Fixed: 2026-11-26T10:23:40Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 1_
