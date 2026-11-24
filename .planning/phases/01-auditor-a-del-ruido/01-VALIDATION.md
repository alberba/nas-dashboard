---
phase: "01"
slug: "auditor-a-del-ruido"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-24"
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> The deliverable is a document; validation asserts the DATA and INVARIANTS that produce it, never prose.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Python stdlib `unittest` (3.13.x) for `scripts/audit/`; Vitest 5.x stays the app runner |
| **Config file** | none — `unittest` discovery by pattern |
| **Quick run command** | `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` |
| **Full suite command** | `python3 -m unittest discover -s scripts/audit -p 'test_*.py' && pnpm test` |
| **Estimated runtime** | ~2 s (audit) + existing app suite |

---

## Sampling Rate

- **After every task commit:** Run `python3 -m unittest discover -s scripts/audit -p 'test_*.py'`
- **After every plan wave:** Run `python3 -m unittest discover -s scripts/audit -p 'test_*.py' && pnpm test`
- **Before `/gsd-verify-work`:** Full suite must be green and `01-AUDIT.json` regenerated twice with the same data hash
- **Max feedback latency:** 10 seconds for the audit suite

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01-01 | 1 | AUDT-01 | T-01-01 / T-01-02 | Hash-pinned local export, no network, no copy into repo | integration | `python3 -m unittest discover -s scripts/audit -p 'test_telegram_export.py' -v` + JSON assertions | ❌ W0 | ⬜ pending |
| 01-01-02 | 01-01 | 1 | AUDT-01 | T-01-03 | Parser bounded, UTF-8, no eval; unmatched → `unknown`, never dropped | unit | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` + JSON assertions | ❌ W0 | ⬜ pending |
| 01-01-03 | 01-01 | 1 | AUDT-01 | — | Denominator declared in JSON; no hidden rounding | unit (invariant) | `python3 -m unittest discover -s scripts/audit -p 'test_*.py' -v` | ❌ W0 | ⬜ pending |
| 01-02-01 | 01-02 | 2 | AUDT-02 | — | Push block stays `unavailable`/`null` without Oracle; no invented figure | unit (invariant) | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ W0 | ⬜ pending |
| 01-02-02 | 01-02 | 2 | AUDT-02 | — | Two duplicate blocks, never one mixed number | unit | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ W0 | ⬜ pending |
| 01-02-03 | 01-02 | 2 | AUDT-03 | — | Wall-clock histogram (8 at 06:00 in E4), 11 WUD repetition groups and 14 extra messages | unit + integration | `python3 -m unittest discover -s scripts/audit -p 'test_*.py' -v` + `--check-repro` | ❌ W0 | ⬜ pending |
| 01-03-01 | 01-03 | 3 | AUDT-04, AUDT-05 | — | Policy map is a document, no runtime authority | unit (schema) | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ W0 | ⬜ pending |
| 01-03-02 | 01-03 | 3 | AUDT-04 | — | Shutdown order covers all Telegram emitters, with backup narrowed | unit | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ W0 | ⬜ pending |
| 01-03-03 | 01-03 | 3 | AUDT-04, AUDT-05 | — | Report renders from JSON; no full message bodies | integration | `--check-report` + `--check-repro` + JSON assertions | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/audit/telegram_export.py` — HTML export parser (date separators, `joined` carry-forward, `\n` literal, `tel:` autolinks)
- [ ] `scripts/audit/noise_audit.py` — classifier, era aggregates, histogram, duplicates, report render
- [ ] `scripts/audit/test_telegram_export.py` — AUDT-01 parser invariants
- [ ] `scripts/audit/test_noise_audit.py` — AUDT-01…05 aggregates and invariants
- [ ] `scripts/audit/fixtures/telegram_export_sample.html` — synthetic fixture (date separator, normal message, `joined` without `from_name`, literal `\n`, `tel:` link, one message per family, one unknown)
- [ ] `package.json` — optional `audit:noise` / `test:audit` scripts so CI covers the tool without changing runners

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Report prose is accurate, in Spanish, and free of leaked personal message bodies | AUDT-01…05 | Prose is not testable without coupling tests to copy (`CODING_STANDARD.md`) | Read `01-AUDIT.md` top to bottom. Confirm that tables match `01-AUDIT.json`, all eight Telegram emitters and the hub appear in the inventory, and sender names and personal message bodies are absent. |
| The final immediate/digest/silent map and the success target are acceptable to the operator | AUDT-04, AUDT-05 | Requires the user's judgment | Present the map and target in `/gsd-verify-work`; user approves or requests changes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
