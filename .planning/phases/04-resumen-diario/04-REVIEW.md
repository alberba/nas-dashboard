---
phase: 04-resumen-diario
reviewed: 2026-11-26T09:37:41Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - .env.example
  - agent/Dockerfile
  - agent/server.py
  - agent/test_metrics.py
  - compose.yaml
  - drizzle/0006_digest_runs.sql
  - drizzle/meta/0006_snapshot.json
  - drizzle/meta/_journal.json
  - scripts/check-worker-health.ts
  - src/app/api/[...path]/route.ts
  - src/app/globals.css
  - src/components/views/alerts.tsx
  - src/lib/digest-content.ts
  - src/lib/digest-runs.ts
  - src/lib/madrid-day.ts
  - src/lib/notification-dispatch.ts
  - src/lib/runtime-config.ts
  - src/lib/schema.ts
  - src/lib/types.ts
  - src/lib/worker-health.ts
  - src/lib/worker-loop.ts
  - src/worker.ts
  - tests/api-incidents.test.ts
  - tests/collector-alerts.test.ts
  - tests/e2e/incidents.spec.ts
  - tests/madrid-day.test.ts
  - tests/migrations.test.ts
  - tests/notification-dispatch.test.ts
  - tests/runtime-config.test.ts
  - tests/telegram.test.ts
findings:
  critical: 0
  warning: 4
  info: 8
  total: 12
  necessity: 0
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-11-26T09:37:41Z
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Summary

I read all 30 changed files end to end and traced the digest queue (`prepare` → `claim` → attempt mark → transport → result), the shared Telegram cooldown, the Madrid civil-time helpers, both health probes, and their tests.

The core of the phase is sound. `digest_runs` really is the single authority for a date: the claim is a single `UPDATE … FROM candidate … FOR UPDATE SKIP LOCKED`, the attempt mark is committed before HTTP, the clock is re-read immediately before the transport (`digest-runs.ts:806-816`), and every terminal write is conditional on the live token. The 429 path writes the shared cooldown before rescheduling, and every claim/attempt re-checks it, so a pause inserted after a response can never be raced. `renderDigestSnapshot` keeps the invariant `entries + omitted === openNow`, drops whole lines, and never splits a surrogate pair. The public projection is a closed list (`publicDigestReason`), the payload never reaches the client, and the agent/worker probes are genuinely local and read-only. Migration metadata (`_journal.json`, `0006_snapshot.json`) matches the SQL and the schema.

The defects are at the edges rather than in the queue:

- The digest **header date is derived from the snapshot instant**, not from the row's civil date, so a delivery that lands after midnight (the supported 22:00–23:59 schedules, and the recovery window they depend on) prints the *next* day in the message while the panel prints the right one.
- The agent probe accepts `NaN` as a fresh `progressAt` — the Node probe correctly rejects non-finite values, so the two probes do not enforce the same contract.
- `retry_after` from the provider is used unbounded. A value large enough to leave the representable `Date` range serialises as `NaN-NaN-NaNTNaN…`, PostgreSQL rejects it, and the day's digest is stranded as `uncertain` with no retry.
- The hourly trash purge holds the very `LOCK` that gates the agent's progress mark, and its recursive delete is unbounded, so a large purge can mark a healthy agent unhealthy.

I did not find a Critical issue, and I found no necessity findings: the guards I examined (the `!run.payload` branch, the `isFile()`/`STAT` re-checks, the `kept === 0` render fallback) all sit across a real trust or durability boundary (DB row written by another process/version, filesystem entry, provider-controlled text) or are the last barrier of a documented invariant, so none of them is an impossible-state guard (necessity: 0).

## Warnings

### WR-01: Digest header date comes from the snapshot instant, not from the digest's civil date

**File:** `src/lib/digest-content.ts:378` (input built at `src/lib/digest-runs.ts:414-422`)

**Issue:** `buildDigestSnapshot` derives the title date from the *prepare* instant:

```ts
const rendered = renderDigestSnapshot({
  date: madridDateOf(input.snapshotAt),
  ...
```

`prepareDigestRuns` passes `snapshotAt: at` (the tick instant) and never passes the candidate's civil date, although it has it in `candidate.date`. For a schedule in the last two hours of the day, the prepare legitimately happens on the **next** civil date — that is exactly the case the recovery window exists for, and the repo's own tests prove the two dates differ:

- `tests/notification-dispatch.test.ts:2195-2201` runs at `2026-11-26T23:00:00Z` (= 00:00 Madrid on 2026-11-27) with `DIGEST_TIME=23:30` and asserts `date: "2026-11-26"` — the row is for the 26th while `madridDateOf(2026-11-26T23:00Z)` is `"2026-11-27"` (`tests/madrid-day.test.ts:79`).
- The same test never asserts the payload text, so the mismatch is invisible to the suite.

Result: the Telegram message reads `Resumen diario · 2026-11-27` for the 2026-11-26 digest, and `projectDigestOverview`/the Avisos panel reports `2026-11-26` for the same message. The operator sees two different dates for one delivery. Period boundaries, dedup and the counters are unaffected; only the label the operator reads is wrong.

**Fix:** pass the row's civil date through instead of re-deriving it from the clock.

```ts
// digest-runs.ts: select the civil date with the period bounds (line 388-393)
`SELECT id, "date", "targetAt", "periodStartAt"
   FROM digest_runs
  WHERE "date" = ANY($1) AND status = 'prepared' AND payload IS NULL
  ORDER BY "targetAt" ASC, id ASC`

// …and pass it through (line 414-422)
const snapshot = await buildDigestSnapshot({
  client: options.client,
  hostIds,
  hostNames,
  date: row.date,                 // new field on DigestSnapshotInput
  periodStart: row.periodStartAt,
  periodEnd: row.targetAt,
  snapshotAt: at,
  alertsUrl,
});

// digest-content.ts: DigestSnapshotInput gains `date: string`, and
const rendered = renderDigestSnapshot({ date: input.date, /* … */ });
```

(`live` holds at most one candidate — the two targets are 24 h apart and the window is 2 h — so `candidate.date` is an equivalent source if you prefer not to widen the `SELECT`.)

Add to the midnight-crossing test: `expect(provider.calls[0].text).toContain("2026-11-26")` (or assert on `run.payload`).

### WR-02: Agent health probe accepts `NaN` as a fresh `progressAt`

**File:** `agent/server.py:258-261` (validation at `agent/server.py:245-257`)

**Issue:** `json.loads` accepts the non-standard `NaN` token and returns `float('nan')`. `progress` is then accepted by the type check (`isinstance(progress, float)`, and it is neither `bool` nor a string), and both freshness comparisons are false for NaN:

```
>>> p = json.loads('{"progressAt": NaN, …}')["progressAt"]
>>> p > now + 5        # False
>>> now - p > 90       # False
```

So a mark whose `progressAt` is `NaN` passes the `future` and `stale` gates and is reported healthy for as long as the PID and boot identity survive. The Node implementation of the same probe explicitly rejects this (`src/lib/worker-health.ts:125-127`: `typeof progressAt !== "number" || !Number.isFinite(progressAt)`), so the two probes that `04-03-SUMMARY.md` documents as enforcing the same rule ("Both probes reject missing, malformed, future, stale, unsafe, dead-PID and reused-PID marks" — the contract `test_missing_malformed_future_unsafe_dead_and_unreadable_marks_fail` is named after) disagree, and a `NaN` mark is silently accepted as malformed-free. Reaching it requires write access to the mark (0600, container tmpfs, same user), so it is not a privilege boundary — but it is precisely the spoofing property `T-04-06` claims to establish, and a corrupted mark silently pins health.

**Fix:** reject non-finite values, matching the Node probe.

```python
import math
...
    if (
        isinstance(progress, bool)
        or not isinstance(progress, (int, float))
        or not math.isfinite(progress)      # add
        ...
```

Add a case to `test_missing_malformed_future_unsafe_dead_and_unreadable_marks_fail` that writes `{"progressAt": float("nan"), …}` and expects `(False, "malformed")`.

### WR-03: Provider `retry_after` is unclamped and can strand a digest as `uncertain`

**File:** `src/lib/notification-dispatch.ts:159-180`, `src/lib/digest-runs.ts:683-686`, parser at `src/lib/telegram.ts:76-81`

**Issue:** `retryAfterMs` accepts any positive finite number of seconds:

```ts
if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
return Math.ceil(seconds * 1000);
```

`boundedBackoffMs` caps the fallback at 300 s, but the `retryAfterMs` branch bypasses that cap in both call sites (`telegramDelayMs`, `recordDigestRetry`). Two consequences, both reachable from a provider response:

1. A legitimate but large flood-control value pauses **every** Telegram delivery (openings, edits, the digest) for that long, because the pause is a single shared row. That is arguably the intended semantics of a 429, but the duration is entirely provider-chosen with no ceiling.
2. A value above the `Date` range (`now + seconds*1000 > 8.64e15`) makes `new Date(until)` invalid. `pg` serialises it as `NaN-NaN-NaNTNaN:NaN:NaN.NaN-NaN:NaN` (verified against `node_modules/pg/lib/utils.js:63-71`, which only emits a deprecation notice and formats the value), and PostgreSQL rejects the statement with `invalid input syntax for type timestamp with time zone`. The throw happens **after** `beginDigestAttempt` committed and **before** the retry row is rescheduled (`digest-runs.ts:686` runs before every `recordDigestFailure`/`recordDigestRetry` write), so the row stays `claimed` with `attemptStartedAt` set. The next tick recovers it as `uncertain` (`recoverDigestRuns`) and it is never resent: that day's digest is lost with only an `incierto` log line.

**Fix:** clamp the provider value once, at the boundary, and reuse it.

```ts
// telegram.ts
export const TELEGRAM_MAX_RETRY_AFTER_MS = 15 * 60_000;
return Math.min(Math.ceil(seconds * 1000), TELEGRAM_MAX_RETRY_AFTER_MS);

// and/or in pauseTelegram / recordDigestRetry
const delay = Math.min(retryAfterMs ?? boundedBackoffMs(attempts), TELEGRAM_MAX_RETRY_AFTER_MS);
```

Then `beginTelegramCooldown` can never receive an unrepresentable instant.

### WR-04: The hourly trash purge holds the agent `LOCK` for an unbounded time and starves the progress mark

**File:** `agent/server.py:763-772` (lock consumer at `agent/server.py:202-213`, threshold at `agent/server.py:97`)

**Issue:** The only publisher of the health mark is `HealthServer.service_actions`, and it publishes **only** when `LOCK.acquire(blocking=False)` succeeds:

```python
def service_actions(self):
    if not LOCK.acquire(blocking=False):
        return
```

`cleanup_loop` takes the same lock for the whole sweep and performs a recursive delete inside it:

```python
with LOCK:
    for record in trash_records():
        if record["expiresAt"] <= time.time():
            trash_action(record["root"], record["id"], False)   # → shutil.rmtree(box)
```

`trash_action` ends in `shutil.rmtree(box)` (line 450), where `box/data` is whatever the operator moved to the trash — media and torrent payloads, i.e. potentially hundreds of GB on spinning disks. While that runs (up to an hour apart, but unbounded in duration), `service_actions` cannot refresh the mark; after `HEALTH_STALE_SECONDS = 90` the probe reports `stale` and Docker marks a perfectly healthy agent `unhealthy`. `files()` (line 453-467) is a second, cheaper instance of the same pattern (an `os.listdir` + `stat` of a very large directory under `LOCK`). The module comment claims the tolerance "covers… ordinary protected operations (15 s host commands, bounded metrics and logs)", which does not include the purge.

**Fix:** keep the purge off the request lock, or publish progress before/while holding it.

```python
def cleanup_loop():
    while True:
        try:
            for record in trash_records():
                if record["expiresAt"] > time.time():
                    continue
                # One bounded unit of work per lock acquisition, so the probe
                # and the HTTP handlers interleave with the purge.
                with LOCK:
                    trash_action(record["root"], record["id"], False)
                HEALTH.refresh()
        except Exception:
            ...
```

(Alternatively, give the reaper its own lock and keep `LOCK` for request work only.)

## Info

### IN-01: Bidi overrides are not stripped, and the test that claims to prove it cannot fail

**File:** `src/lib/digest-content.ts:106-112`, test at `tests/telegram.test.ts:188-204`

**Issue:** The sanitiser documents "Control, line-separator and bidi characters could impersonate another row", and the phase summary states that titles are "stripped of controls, line separators and bidi overrides". The regex does not include the bidi embedding/override block:

```ts
const UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\u200c\u200e\u200f\u2060-\u2069\ufeff]/g;
```

Verified with Node: `\u202a`, `\u202b`, `\u202c`, `\u202d`, `\u202e` and `\u061c` all survive `clean()`. The test payload ends in `\u202e`, but its assertions only cover the newline (`not.toMatch(/\n· forged/)`) and `\u0000`, so removing the whole bidi portion of the regex would keep it green. Reachability today is limited: digest titles are hub-authored text plus `NAS_HOSTS[].name` (operator config, `src/lib/maintenance-alerts.ts:72-308`), and container names are ASCII by Docker's own rules — so this is latent rather than exploitable. It becomes a real spoofing vector the moment a title embeds any remote free text (a release tag, a branch, a label).

**Fix:**
```ts
const UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff]/g;
```
and assert it: `expect(rendered.text).not.toMatch(/[\u202a-\u202e\u061c]/)`.

### IN-02: Two identical public digest types (`DigestOverview` vs `DigestState`)

**File:** `src/lib/digest-runs.ts:104-109`, `src/lib/types.ts:273-281`

**Issue:** `DigestOverview` and `DigestState` are structurally identical (`date`, `targetAt`, `status: PublicDigestStatus`, `reason: PublicDigestReason | null`). The route serialises one and the client reads the other, so the compiler cannot catch a divergence between the producer and the consumer — exactly the boundary it should protect.

**Fix:** define `DigestState` once in `types.ts` and use it as the return type of `projectDigestOverview` (delete `DigestOverview`, or alias it: `export type DigestOverview = DigestState`).

### IN-03: `digestAlertsUrl` duplicates `incidentHref`'s URL validation and passes a parameter that is discarded

**File:** `src/lib/digest-content.ts:392-407`, duplicated from `src/components/views/routes.ts:100-129`

**Issue:** `digestAlertsUrl` re-implements the same 15 lines of `BETTER_AUTH_URL` validation (parse, reject credentials/query/hash, require http(s)) that `incidentHref` already owns, so a future tightening of the URL policy has to be applied in two places. It also passes `tab: "status"`, which the `view === "alerts"` branch of `routeHref` never reads.

**Fix:** extract the validation into one helper (e.g. `alertsOrigin(betterAuthUrl): URL` in `routes.ts`) and call it from both; drop the unused `tab`.

### IN-04: `WorkerHealth.close()` and `WorkerHealth.invalidate()` are unreachable

**File:** `src/lib/worker-health.ts:257-270`

**Issue:** `close()` is the only caller of the async `invalidate()`, and nothing calls `close()`. `src/worker.ts` uses `closeSync()`/`invalidateSync()` only, and no test references the async pair. Dead code that suggests an awaiting shutdown path exists when it does not.

**Fix:** delete both async methods, or use `await health.close()` in `worker.ts`'s `finally` and keep the sync variants only for the signal handler.

### IN-05: `WORKER_HEALTH_FILE` is honoured by the probe but ignored by the writer

**File:** `scripts/check-worker-health.ts:10`, writer created at `src/worker.ts:110-113`

**Issue:** The probe reads `process.env.WORKER_HEALTH_FILE?.trim() || WORKER_HEALTH_FILE`, but `worker.ts` constructs `new WorkerHealth({ holdsLock, log })` without `file`, so the writer always uses the compiled-in constant. An operator who sets `WORKER_HEALTH_FILE` in `.env` (loaded by `env_file: .env`) gets a probe that looks at a file nobody writes and a permanently unhealthy worker, with no diagnostic beyond `missing`. The env override exists only as a test seam for `tests/notification-dispatch.test.ts:3068-3085`.

**Fix:** pass the same override to the writer, or remove the env read from the probe and give the test an explicit argument (`checkWorkerHealth({ file })` is already parameterised, so the env read is unnecessary for the test).

### IN-06: A failed digest read is presented as "no digest has ever been registered"

**File:** `src/app/api/[...path]/route.ts:386-396`, `src/components/views/alerts.tsx:288-297`

**Issue:** On a read error the route swallows the exception and leaves `digest` as `null`, which is serialised as `"digest": null`. The client cannot distinguish that from "zero rows" (also `null`) and renders *"Todavía no hay ningún resumen registrado."* — a factual claim that is false when the query merely failed. The `Overview` type already models the distinction (`digest?: DigestState | null`, documented as "Absent while an older hub still answers"), but the route does not use it.

**Fix:** in the catch, leave the key out instead of setting `null` (e.g. build the payload object first and only assign `digest` on success), and render a third state ("estado no disponible") for `undefined` vs `null`.

### IN-07: Tests assert probe copy, contrary to `CODING_STANDARD.md`

**File:** `tests/notification-dispatch.test.ts:3083`, `agent/test_metrics.py:206`

**Issue:** Both assertions match a substring of the operator-facing message rather than the outcome:

```ts
expect(result.stderr).toContain("missing");
self.assertIn("missing", result.stderr)
```

The exit code is already asserted (`toBe(1)` / `returncode == 1`), which is the behaviour. Per `CODING_STANDARD.md:5` ("a test never depends on it [copy]… assert on state, outcome or structure"), rewording the probe message (`Marca de salud del worker no válida (missing)`) would turn these red with no product change. The reason token itself is already asserted as state elsewhere (`checkWorkerHealth(...)` / `read_health_check(...)` return values).

**Fix:** drop the stderr assertions in both tests, or expose the reason through a machine-readable channel and assert that.

### IN-08: A refused attempt mark is reported as `claim_lost` when the cause is the cooldown or a closed window

**File:** `src/lib/digest-runs.ts:806-808`

**Issue:** `beginDigestAttempt` returns `null` for four distinct conditions — token mismatch, expired lease, `dueAt` reached, **or an active `telegram_cooldown`** (lines 582-591). All four are reported as `{ action: "idle", reason: "claim_lost" }`, so the one diagnostic field the tick returns is wrong for the most likely cause during a 429 pause. The row is also left `claimed` with a live lease for up to 30 s, during which neither `recoverDigestRuns` nor `claimDigestRun` can touch it, so the digest silently waits a full lease for a condition that is already known.

**Fix:** return the observed cause (e.g. re-check the cooldown in the same statement and surface `reason: "cooldown"`), and clear the claim (`claimToken = NULL`, `leaseUntil = NULL`, `status = 'prepared'`) when the attempt is refused for a reason the row can be retried from.

---

_Reviewed: 2026-11-26T09:37:41Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
