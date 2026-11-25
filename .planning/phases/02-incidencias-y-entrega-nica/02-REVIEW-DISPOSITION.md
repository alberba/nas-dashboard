---
phase: 02
review: 02-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "A pending rate-limited retry is published as a permanent Telegram failure"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "A send confirmation racing a closure or severity change can lose the final Telegram edit"
  - id: WR-03
    severity: warning
    disposition: fixed
    title: "Push 429 and 5xx responses are recorded as permanent failures"
  - id: WR-04
    severity: warning
    disposition: fixed
    title: "Sustained-duration timers keep counting across samples with no evidence"
  - id: IN-01
    severity: info
    disposition: fixed
    title: "`notify` is a dead compatibility wrapper"
  - id: IN-02
    severity: info
    disposition: fixed
    title: "A disabled push channel is reported as \"Telegram desactivado\""
  - id: IN-03
    severity: info
    disposition: fixed
    title: "The incident-id grammar admits values outside the PostgreSQL integer range"
  - id: IN-04
    severity: info
    disposition: deferred
    title: "Outbox keys and notification tags are duplicated protocol strings"
open: 0
total: 8
recorded: 2026-11-25T11:14:43Z
---

# Phase 02: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | Persisted outbox status is projected before the last attempt result; pending rate-limited retry test. `4d15f3f` |
| WR-02 | warning | fixed | `recordTelegramSent` locks the incident with `FOR UPDATE`; two-connection interleaving test queues exactly one edit. `4d15f3f` |
| WR-03 | warning | fixed | 408/425/429 and 5xx are recorded as `uncertain`; 429/500 tests, other 4xx still `failed`. `4d15f3f` |
| WR-04 | warning | fixed | Skipped CPU/disk/temperature evidence and malformed snapshots clear the sustained timer; data-gap tests. `4d15f3f` |
| IN-01 | info | fixed | Removed the dead `notify` wrapper; no imports remain. `4d15f3f` |
| IN-02 | info | fixed | Added the finite `push_disabled` public reason and Avisos label; projection test. `4d15f3f` |
| IN-03 | info | fixed | Incident ids capped at 2,147,483,647 in route, routes and sw; boundary 404 test. `4d15f3f` |
| IN-04 | info | deferred | The duplicated key/tag protocol strings need one shared builder module and a separate refactor; not required for this remediation. |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved.
