---
phase: 01-auditor-a-del-ruido
reviewed: "2026-11-24T19:26:02Z"
depth: standard
files_reviewed: 8
files_reviewed_list:
  - scripts/audit/telegram_export.py
  - scripts/audit/noise_audit.py
  - scripts/audit/test_telegram_export.py
  - scripts/audit/test_noise_audit.py
  - scripts/audit/fixtures/telegram_export_sample.html
  - scripts/audit/fixtures/alerts_sample.csv
  - package.json
  - README.md
findings:
  critical: 0
  warning: 6
  info: 3
  total: 9
  necessity: 0
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-11-24T19:26:02Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

I reviewed the phase's source changes relative to `8a52b2b` at standard depth: the HTML export parser, the aggregate/report model, both test modules, both synthetic fixtures, `package.json` and the README runbook. The published figures reproduce (148 rows, 146 bot / 2 operator, 45 separators, eras 8/105/20/15 over 156/36/10/12 inclusive days, 51 WUD passes, 11 repetition groups / 14 extras, 14/12/1/13 inter-system duplicates, 44/140/144 windows, 22 policy keys at 9/9/4, and 15 report sections). The committed `01-AUDIT.json` and `01-AUDIT.md` contain no message bodies, sender names or absolute operator paths, and the audit test suite passes.

No structural pre-pass was provided, so every finding below is a narrative finding (AI reviewer). No Critical findings were found. Six Warning findings remain: the predictable NDJSON temp file is world-readable and follows symlinks; `--check-report` does not rebuild the model from the aggregate, so aggregate/report drift is not detected; the report hardcodes the "no CSV" push narrative even when `--alerts-csv` measures push; the inventory's recovery/cutover flags contradict `RECOVERY_CAPABLE` and `shutdown_order`; the parser silently drops text-less messages and inherits a sender on non-joined rows; and the alerts adapter accepts `resolvedAt < at`, publishing a negative recovery latency. Three Info findings cover test assertions that do not pin the push/ack dash, inconsistent decimal separators in the Spanish report, and time-less rows being joined as if they were midnight.

Checks run:

- `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` -> 107 tests, `OK`.
- `python3 scripts/audit/noise_audit.py --check-report --out-json .planning/phases/01-auditor-a-del-ruido/01-AUDIT.json --out-md .planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` -> `{"report_matches": true}`, exit 0.
- `python3 scripts/audit/noise_audit.py --export "$HOME/Downloads/ChatExport_NAS Monitor/messages.html" --check-repro` -> `{"reproducible": true}`, exit 0.
- `python3 -m py_compile scripts/audit/telegram_export.py scripts/audit/noise_audit.py scripts/audit/test_telegram_export.py scripts/audit/test_noise_audit.py` -> OK.
- `git diff --name-only 8a52b2b..HEAD -- src agent` empty; `git diff --name-only 8a52b2b..HEAD -- pnpm-lock.yaml package-lock.json` empty; `package.json` adds only the two scripts; `git diff --check` clean.
- `grep -RInE 'requests|urllib|http://|https://|eval\(|exec\(' scripts/audit/*.py` -> no matches; `git ls-files '*.ndjson'` empty; the only tracked `scripts/audit` HTML is the synthetic fixture.
- Privacy grep over `01-AUDIT.json` / `01-AUDIT.md` for `/Users/`, operator names, `messages.html`/`ChatExport` and the `text` key -> only the harmless `path_hint: "messages.html"`.
- Probes: NDJSON directory/file modes `0o755`/`0o644`; a text-less message and a non-joined message without `from_name` parsed on a synthetic document; a copy of `01-AUDIT.json` with `dataset.messages=9999` still passed `--check-report`; a CLI run with `--alerts-csv scripts/audit/fixtures/alerts_sample.csv` rendered `measured` alongside "no CSV"; and an alerts row with `resolvedAt < at` produced `push_latency_s=-3600.0`.

## Warnings

### WR-01: The NDJSON with message bodies is world-readable and follows symlinks

**File:** `scripts/audit/telegram_export.py:220-227` (default path `scripts/audit/noise_audit.py:25`)
**Issue:** `write_ndjson` creates `/tmp/noise-audit` with the process umask and writes `messages.ndjson` with a default `open("w")`. Every row carries `sender` and the full `text` (`telegram_export.py:180-193`), so the file contains the operator's complete chat bodies and sender names. Verified on this machine: directory mode `0o755`, file mode `0o644`. Any local user or process can read the file, and because `--force` bypasses `_refuse_overwrite` (`noise_audit.py:2329-2336`), a pre-created symlink at the predictable path is followed by `open("w")`, truncating or creating whatever it points to. The default is outside the repository, but the file itself is neither private nor protected against a symlink pre-placement.
**Fix:** Write the intermediate under a private per-run directory and open it with `0o600` and `O_NOFOLLOW`, then remove it unless an explicit keep flag is passed. Reject an `--ndjson` target inside the repository. For example:
```python
import os

def write_ndjson(rows, path):
    target = Path(path)
    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    os.chmod(parent, 0o700)  # only when the directory is ours
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    return target
```
Prefer `tempfile.mkdtemp(prefix="noise-audit-")` for the default run directory so a pre-existing `/tmp/noise-audit` cannot be attacker-controlled.

### WR-02: `--check-report` verifies the embedded snapshot, not the aggregate

**File:** `scripts/audit/noise_audit.py:2203-2208`
**Issue:** `check_report` renders `data["report"]`, the snapshot embedded in the JSON at generation time, instead of rebuilding the model from the aggregate sections. A JSON whose top-level `dataset`, `eras`, `duplicates`, etc. have drifted from `report` is still reported as consistent. I copied `01-AUDIT.json`, changed `dataset.messages` from `148` to `9999`, left `report` untouched, and `--check-report` printed `{"report_matches": true}` with exit 0. This defeats the stated purpose of the check ("reconstruye el modelo") and lets a stale or hand-edited aggregate pass while the Markdown contradicts it.
**Fix:** Rebuild the model from the aggregate and compare both representations:
```python
def check_report(json_path, md_path):
    data = json.loads(Path(json_path).read_text(encoding="utf-8"))
    model = build_report_model(data)
    expected = render_report(model)
    actual = Path(md_path).read_text(encoding="utf-8")
    return data.get("report") == model and expected == actual
```
If `report` is meant to be a generated cache, overwrite it from the rebuilt model instead of trusting the stored copy.

### WR-03: The report hardcodes the "push unavailable" narrative when `--alerts-csv` is supplied

**File:** `scripts/audit/noise_audit.py:1864-1866`, `scripts/audit/noise_audit.py:1882-1887`, `scripts/audit/noise_audit.py:1975-1979`, `scripts/audit/noise_audit.py:1460-1466`
**Issue:** `_hub_push` publishes `measured` data with a CSV, but `build_report_model` still renders the no-CSV text and blanks. In a run with `--alerts-csv scripts/audit/fixtures/alerts_sample.csv` the JSON said `hub_push.status = "measured"`, `openings = 4`, `recovery_messages = 2`, `recovery_ratio = 0.5`, yet the Markdown said "La tabla alerts no está disponible: push queda measured", rendered the `hub_push` table row as `— / — / — / —`, and set the section source to `no medido`; the `push_coverage` footnote still said there was no CSV. This is a false statement and suppresses the measured push values that phase 8 is supposed to read.
**Fix:** Branch on `hub_push["status"]` and `push["status"]`. Use `hub_push["openings"]`, `hub_push["recovery_messages"]` and `hub_push["recovery_ratio"]` in the table (leaving the non-applicable "Informativos" cell as `None`), set the section source to `state` when measured, and make the `push_coverage` footnote describe the CSV path and `skipped_rows` when present. Keep the `—` branch only for `unavailable`.

### WR-04: Inventory recovery and cutover flags contradict the phase's own decisions

**File:** `scripts/audit/noise_audit.py:182`, `:191`, `:200`, `:209`, `:227`, `:228`, `:237`; contrast `scripts/audit/noise_audit.py:302-358` and `:1336-1349`
**Issue:** `EMITTERS` marks `security-monitor`, `upgrade-script`, `merged-updates` and `issue-automator` as `can_emit_recovery: True`, while `RECOVERY_CAPABLE` (the table actually used by `build_recoveries`) says only `security-update` and `hub` can recover. The committed JSON therefore publishes both claims: `inventory.emitters` shows `True` for those four, and `recoveries.telegram.by_family_capability` shows `False`. The same inventory puts `issue-automator` and `unknown-smart` at `in_cutover: True`, but `shutdown_order.out_of_scope` assigns both to phase 8. A phase 8 consumer that filters emitters by these flags gets a different cutover set than the one the report describes.
**Fix:** Use one source of truth. Build `can_emit_recovery` from `RECOVERY_CAPABLE` and `in_cutover` from `build_shutdown_order()` (or set the flags explicitly and assert equality in a test), so `inventory` and `recoveries`/`shutdown_order` cannot disagree.

### WR-05: The parser drops messages without a `.text` child and inherits senders on non-joined rows

**File:** `scripts/audit/telegram_export.py:122-127`, `:143-156`, `:170-177`
**Issue:** A row is only finalised when a `.text` div ends (`_close_row` is called from the `"text"` branch at line 155). A `div.message...` with no `.text` child (media-only, deleted message, sticker) is never emitted; the next message div overwrites `_row` at line 123, so the message disappears without a count or error. I fed a synthetic export with a joined message that had no `.text`: the parser returned only `message1` and `message3`, silently losing `message2`. Separately, `_close_row` inherits `self._sender` whenever the current row has no `.from_name`, without checking `row["joined"]`; a non-joined message with a missing sender is attributed to the previous sender instead of raising (also reproduced). This violates the measurement contract, which defines a message by its `div.message...` id, and can silently undercount or misattribute a sender.
**Fix:** Close the row when the message div itself ends (track the message element's depth separately from the `.text`/`.from_name` sub-modes, or close the previous open row with empty text when a new message div starts) and flush any open row at `close()`. In `_close_row`, only inherit when `row["joined"]` is true:
```python
if sender is None and not row["joined"]:
    raise ValueError("mensaje no joined sin remitente")
```
Add a regression test for a text-less message and for a non-joined message without `from_name`.

### WR-06: `resolvedAt < at` is accepted and published as a negative recovery latency

**File:** `scripts/audit/noise_audit.py:882-905`, `scripts/audit/noise_audit.py:805-819`
**Issue:** `load_alerts_csv` validates that `at` and `resolvedAt` parse, but not that the recovery follows the decision. A row with `at = 2026-11-20T03:00:00Z` and `resolvedAt = 2026-11-20T02:00:00Z` is kept, and `_hub_push` then publishes `push_latency_s = -3600.0` with `status = "measured"`. A negative recovery duration is impossible data, and the plan says malformed alert rows are counted in `skipped_rows` rather than published. `load_alerts_csv` is the only validation point, so nothing downstream can tell that the pair is inconsistent.
**Fix:** In `load_alerts_csv`, treat `resolved_at < at` as an invalid row (raise inside the existing `try` so it increments `skipped_rows`), or set `resolvedAt = None` and count it separately. Add a test that a recovery timestamp earlier than `at` is skipped and never reaches `_hub_push`.

## Info

### IN-01: The push/ack dash assertions do not pin the requirement, and one test asserts Spanish copy

**File:** `scripts/audit/test_noise_audit.py:1432-1452`, `:1494-1504`, `:944-958`
**Issue:** The dash requirement ("push and ack render as `—`, not 0") is not actually pinned. `test_missing_push_and_ack_values_render_as_a_dash` only asserts that some table row contains `None` and that `—` appears somewhere in the rendered report; `test_the_real_export_renders_all_sections_and_the_push_dash` also asserts only `"—" in rendered`, which is already satisfied by the `split_by_outcome` column in the policy table (`—` for rows without a split). The push cells have no cell-level assertion at all, so a regression that rendered `0` for the hub push openings/recoveries would still pass (only the ack row is partially protected by the negative `"Valor actual | 0"` check). Also, `test_the_denominator_note_explains_the_two_published_rates` asserts the Spanish word `"inclusivos"`, coupling the test to prose contrary to `CODING_STANDARD.md`.
**Fix:** Locate the specific rendered table rows/cells for `push` and `objetivo` and assert the exact `—` cells (and that the corresponding numeric fields are `None`). Replace the `"inclusivos"` assertion with a structural assertion on `denominator_note` (e.g., the two numeric rates and the denominator source).

### IN-02: The Spanish report mixes decimal separators

**File:** `scripts/audit/noise_audit.py:1689-1693`, `:2092-2093`, `:2170-2200`; helper at `:1437-1438`
**Issue:** The report is Spanish, and the footnotes use `0,05` / `1,25` via `_decimal`, but the summary and the tables render `1.0` and `1.25` (e.g., "El objetivo propuesto es 1.0 ... frente a 1.25 de E4"). The same number appears with a dot in one sentence and a comma in another, which is confusing in the document that the operator is expected to read and accept.
**Fix:** Format every rendered float with `_decimal` (or a single locale-aware formatter) in `build_report_model`/`render_report`, including `target["proactive_messages_per_day"]`, `target["baseline_messages_per_day"]` and the rate columns.

### IN-03: Time-less rows are joined as if their clock were midnight

**File:** `scripts/audit/noise_audit.py:931`, `:975-980`
**Issue:** The parser explicitly supports `time=None` / date-only `sent_at` (`telegram_export.py:186-190`), and the histogram excludes those rows, but `_inter_system` and `join_push_windows` still convert them with `datetime.fromisoformat` / `to_instant`, which yields midnight. I reproduced a time-less WUD row paired with a 12:00 security update and reported `latency_min = 720`, a delay the audit cannot know; the same midnight substitution applies in `join_push_windows`. The real export currently has `missing_time = 0`, so this does not change the published figures, but it fabricates latency for a supported input state.
**Fix:** Skip `row.get("time") is None` in all time-based joins (`_inter_system`, `join_push_windows`) or publish those rows as `not_measurable` instead of deriving a midnight instant.

---

_Reviewed: 2026-11-24T19:26:02Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
