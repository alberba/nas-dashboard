---
phase: 04
review: 04-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "Digest header date comes from the snapshot instant, not from the digest's civil date"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "Agent health probe accepts `NaN` as a fresh `progressAt`"
  - id: WR-03
    severity: warning
    disposition: fixed
    title: "Provider `retry_after` is unclamped and can strand a digest as `uncertain`"
  - id: WR-04
    severity: warning
    disposition: fixed
    title: "The hourly trash purge holds the agent `LOCK` for an unbounded time and starves the progress mark"
  - id: IN-01
    severity: info
    disposition: open
    title: "Bidi overrides are not stripped, and the test that claims to prove it cannot fail"
  - id: IN-02
    severity: info
    disposition: open
    title: "Two identical public digest types (`DigestOverview` vs `DigestState`)"
  - id: IN-03
    severity: info
    disposition: open
    title: "`digestAlertsUrl` duplicates `incidentHref`'s URL validation and passes a parameter that is discarded"
  - id: IN-04
    severity: info
    disposition: open
    title: "`WorkerHealth.close()` and `WorkerHealth.invalidate()` are unreachable"
  - id: IN-05
    severity: info
    disposition: open
    title: "`WORKER_HEALTH_FILE` is honoured by the probe but ignored by the writer"
  - id: IN-06
    severity: info
    disposition: open
    title: "A failed digest read is presented as \"no digest has ever been registered\""
  - id: IN-07
    severity: info
    disposition: open
    title: "Tests assert probe copy, contrary to `CODING_STANDARD.md`"
  - id: IN-08
    severity: info
    disposition: open
    title: "A refused attempt mark is reported as `claim_lost` when the cause is the cooldown or a closed window"
open: 8
total: 12
recorded: 2026-11-26T11:30:00.000Z
---

# Phase 04: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | REVIEW-FIX.md |
| WR-02 | warning | fixed | REVIEW-FIX.md |
| WR-03 | warning | fixed | REVIEW-FIX.md |
| WR-04 | warning | fixed | REVIEW-FIX.md |
| IN-01 | info | open | - |
| IN-02 | info | open | - |
| IN-03 | info | open | - |
| IN-04 | info | open | - |
| IN-05 | info | open | - |
| IN-06 | info | open | - |
| IN-07 | info | open | - |
| IN-08 | info | open | - |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently.
