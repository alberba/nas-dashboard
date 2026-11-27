---
phase: 06
review: 06-REVIEW.md
titles: json
findings:
  - id: CR-01
    severity: critical
    disposition: open
    title: "Passkey gate can be downgraded to the password factor by forging the `Origin` header"
  - id: WR-01
    severity: warning
    disposition: open
    title: "`/api/verification/password` has no attempt limit and the assumption that Better Auth covers it was never tested"
  - id: WR-02
    severity: warning
    disposition: open
    title: "An over-cap `/metrics` answer silently blinds monitoring and alerting for the host"
  - id: WR-03
    severity: warning
    disposition: open
    title: "Idempotency replay is inconsistent across the protected routes and does not compare the action"
  - id: WR-04
    severity: warning
    disposition: open
    title: "Negative e2e assertions run before the thing they guard against can happen"
  - id: IN-01
    severity: info
    disposition: open
    title: "Documents under dotted paths get no CSP at all"
  - id: IN-02
    severity: info
    disposition: open
    title: "Keyboard shortcuts bypass the host-role filter the buttons apply"
  - id: IN-03
    severity: info
    disposition: open
    title: "A malformed JSON body ends as a 503 with a logged \"API error\""
  - id: IN-04
    severity: info
    disposition: open
    title: "`sendHostCommand` is documented for exempt commands but typed for all"
open: 9
total: 9
recorded: 2026-11-27T13:55:20.686Z
---

# Phase 06: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| CR-01 | critical | open | - |
| WR-01 | warning | open | - |
| WR-02 | warning | open | - |
| WR-03 | warning | open | - |
| WR-04 | warning | open | - |
| IN-01 | info | open | - |
| IN-02 | info | open | - |
| IN-03 | info | open | - |
| IN-04 | info | open | - |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
