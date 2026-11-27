---
phase: 07
review: 07-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: open
    title: "A claimed intent is stranded in `executing` if the run or the closing transaction throws"
  - id: WR-02
    severity: warning
    disposition: open
    title: "Keyboard-only edit rows pollute the Avisos \"last update\" projection"
  - id: WR-03
    severity: warning
    disposition: open
    title: "A failed run offers \"Reintentar\", which then claims the action \"ya se había ejecutado\""
  - id: WR-04
    severity: warning
    disposition: open
    title: "Losing the claim race can answer \"expired\" for a link that is still alive"
  - id: WR-05
    severity: warning
    disposition: open
    title: "`operations.requestedBy` always equals `operations.userId` (necessity: generality without instantiation)"
  - id: IN-01
    severity: info
    disposition: open
    title: "`TELEGRAM_DIRECT_ACTIONS` is a variable that exists only to be rejected (necessity: phantom requirement)"
  - id: IN-02
    severity: info
    disposition: open
    title: "Duplicated response helpers and a duplicated sample query"
open: 7
total: 7
recorded: 2026-11-27T19:30:37.137Z
---

# Phase 07: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | open | - |
| WR-02 | warning | open | - |
| WR-03 | warning | open | - |
| WR-04 | warning | open | - |
| WR-05 | warning | open | - |
| IN-01 | info | open | - |
| IN-02 | info | open | - |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
