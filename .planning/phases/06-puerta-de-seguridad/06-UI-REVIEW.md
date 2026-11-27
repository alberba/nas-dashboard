# Phase 06 — UI Review

**Audited:** 2026-11-27
**Baseline:** `06-UI-SPEC.md` (approved 2026-11-27); `DESIGN.md` overrides it where they differ
**Screenshots:** not captured (nothing listens on ports 3000, 5173 or 8080; code-level audit, no server was started)
**Interaction captures:** off (`workflow.ui_interaction_capture` is false)
**Method:** The phase's frontend diff (`git diff 99c14e3..HEAD -- src`: six component and hook files plus `host-command-client.ts` and `maintenance-polling.ts`; no CSS file changed) read against the UI-SPEC copy, interaction, state-hook and UI-considerations tables, plus the pre-existing sensitive-action dialog and CSS the contract still constrains. First pass by `gsd-ui-auditor`; a second pass re-opened every cited line and corrected line references and impact wording.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 2/4 | The `check-health` notices from Ctrl K, the retained-entries sentence and the 502 next step differ from the Copywriting Contract |
| 2. Visuals | 3/4 | One dialog, the right hooks and focal points; the host line is missing from the card and Ctrl K dialogs |
| 3. Color | 3/4 | No colour added and accent stays on its reserved list; the toast still shows a green check on failure notices (accepted) |
| 4. Typography | 3/4 | The phase edits no type rule and new text stays on 12 / 12.8px and 400 / 700; the reused `.retry` is weight 800 |
| 5. Spacing | 3/4 | No spacing added; the reused `.retry` has a 28px hit area against the 44px minimum |
| 6. Experience Design | 2/4 | Gate routing, too-large retention and card states hold; the Ctrl K `check-health` path has no re-entry guard and misreports a 5xx, and retained rows get no explanation |

**Overall: 16/24**

---

## Top 3 Priority Fixes

1. **The Ctrl K `check-health` path deviates from the contract in copy, outcome mapping and re-entry** — an unconfirmed result (5xx other than 503) reads as a plain failure, all three notices differ from the Copywriting Contract, and a second `H` while one is in flight is not ignored; `check-health` is read-only, so the cost is a misleading message and redundant requests, not a duplicated mutation — rewrite `src/components/command-search.tsx:41-63`: branch on `status` as `applyResult` does (`maintenance-extras.tsx:71-92`), use `Salud comprobada en {host}.`, `No se pudo comprobar la salud: {error}` and `No se pudo confirmar la comprobación de salud. Revisa el host antes de repetirla.`, and add a `sending` ref like `HostCommands` has (`maintenance-extras.tsx:62,102,123,134`).
2. **The card and Ctrl K dialogs never name the host** — the dialog fixes its endpoint when it opens but only says `La acción se ejecutará una sola vez en el host seleccionado.`, so with two hosts the Operator cannot confirm the target inside the dialog — add `description: scope.host?.name` to `sensitive.request` at `command-search.tsx:64` and `description: host?.name` at `maintenance-extras.tsx:105`, as `dashboard.tsx:494` already does.
3. **The too-large messaging is incomplete** — rows kept after a failed refresh carry no explanation, and the 502 text gives no next step — in `src/components/file-browser.tsx:393-401` append `Se muestran las entradas anteriores.` when `listed.current` matches the open folder and `entries.length > 0`, and extend the string at `src/app/api/[...path]/route.ts:917` with `Prueba con una carpeta o un filtro más pequeño, o inténtalo de nuevo más tarde.`

---

## Additional recommendations

4. **WARNING (pre-existing, reused by the too-large state).** `.retry` (`maintenance-status.module.css:28-37`) sets `min-block-size: 1.75rem` (28px), overriding the global 44px button minimum (`globals.css:105`; DESIGN.md Accesibilidad), and `font-weight: 800`, outside 400 / 700. "Reintentar" is the only recovery control in the too-large state. Drop the height override (or use the 36px visible / 44px target pattern of `.smallButton`, `files-apps.module.css:136-148`) and use 700.
5. **WARNING (accepted in the UI-SPEC, Open item 3).** `.toast > svg` is always `--gain` (`globals.css:1193-1195`), so the failure notices from Ctrl K show a success icon. The words carry the state; revisit when a tone variant is added.
6. **NIT.** With a snapshot, the too-large note is two sentences (`maintenance-status.tsx:340-345`, "...mostrarlo. Se muestran los datos de las {hora}.") where the contract has one with a colon. The no-snapshot variant and `Reintentar` match.
7. **NIT (pre-existing).** Dialog `.field label` is 13px (`sensitive-action.module.css:158-162`), neither on the new scale (12.8px) nor in the UI-SPEC's frozen list.
8. **NIT (informational).** `data-command-option` was added beside `data-search-command` (`command-search.tsx:163-164`) and only the new name is read (`tests/e2e/maintenance-workflows.spec.ts:341,353,376`). This is the "keep both" branch of Open item 1.

BLOCKER findings: 0. WARNING findings: 7 (fixes 1 to 3 hold five of them; items 4 and 5 are the other two). NIT findings: 3.

---

## Context

The UI-SPEC was committed (`b982f7f`) after plans 06-01 and 06-02 had executed and before 06-03 did, but plans 06-03 and 06-06 never reference it and still carry the pre-spec copy: `06-03-PLAN.md` line 108 asks for the host `description` in `dashboard.tsx` only, and `06-06-PLAN.md` line 98 fixes the single-sentence 502 text. The spec's Open items 1, 2 and 7 were addressed to the planner and were not fed back. `06-03-SUMMARY.md` (D5) and `06-VALIDATION.md:168` deferred the visual review of the passkey dialogs to this gate. Most findings above follow from that gap, not from a regression.

---

## Detailed Findings

### Pillar 1: Copywriting (2/4)

Matches the contract:
- `Confirmar` on all three entry points (`dashboard.tsx:496`, `maintenance-extras.tsx:108`, `command-search.tsx:67`). Host-command titles come from `commandLabels` (`maintenance-extras.tsx:17-26`) and equal the seven contract titles.
- Consequences are verbatim in the shared `commandConsequence` (`maintenance-extras.tsx:43-51`). `window.confirm` is gone from the protected flows; the only one left is `settings.tsx:183`, which Open item 6 says to leave.
- Destructive copy: `Eliminar definitivamente {nombre}` and `No se podrá recuperar.` (`file-browser.tsx:487-488`); `Vaciar la papelera`, its consequence and `Escribe VACIAR PAPELERA` (`file-browser.tsx:420-423`, `dashboard.tsx:505`).
- Card states `En curso`, `Pendiente de verificar` and `Operación rechazada` (`maintenance-extras.tsx:124,84,87`); the no-snapshot too-large note is verbatim (`maintenance-status.tsx:341`).

Deviations:
- `command-search.tsx:41-58`: success is `Comprobar salud: completada.` (contract `Salud comprobada en {host}.`); a rejection shows the bare server `error` or `Comprobar salud: no se pudo completar.` (contract `No se pudo comprobar la salud: {error}`); a network failure reads `Comprobar salud: pendiente de verificar. Comprueba el host antes de otra acción.` (contract `No se pudo confirmar la comprobación de salud. Revisa el host antes de repetirla.`).
- `file-browser.tsx:393-401`: `Se muestran las entradas anteriores.` appears nowhere in `src/` (grep).
- `route.ts:917`: single-sentence 502 text, without the next step of Open item 7. The file list and `useHostRead` views show this text verbatim.
- `maintenance-status.tsx:340-345`: punctuation of the with-snapshot note (NIT, item 6).
- The host-name line is missing from two of the three dialogs (Pillar 2).

### Pillar 2: Visuals (3/4)

- One dialog holds: `dashboard.tsx:487-518` routes by `requiresVerificationForAction` and keeps the simple dialog for the exempt actions; destructive tone only for `purge` and `empty-trash` (`:497-499`). The new hooks exist: `data-files-error` (`file-browser.tsx:397`), `data-snapshot-note="too-large"` (`maintenance-status.tsx:336-338`) and `data-toast` (`dashboard.tsx:944`).
- The dialog keeps its focal structure: Unbounded 21px title, one filled control (`[data-confirm]`, accent or `--loss`), `aria-label="Cerrar"` on the icon-only close button, `aria-labelledby`, `aria-describedby` and `aria-busy` (`sensitive-action.tsx:298-336`), and `data-initial-focus` on the typed field, the password field or Cancelar (`:364,397,445`).
- Gap: only `dashboard.tsx:494` passes the host name as `description`. The card (`maintenance-extras.tsx:105-120`) and Ctrl K (`command-search.tsx:64-71`) open a dialog with no host line, so the three entry points do not look alike (UI-SPEC Copywriting "Dialog description" row, Open item 2).

### Pillar 3: Color (3/4)

- No colour or CSS file was edited. The too-large note uses `--peach` through `.note` (`maintenance-status.module.css:22-27`), the file-list error uses the global `.error` (`--loss`, `globals.css:248-251`), destructive tone is limited to `purge` and `empty-trash`, and accent stays on its reserved list. No hard-coded colour appears in the diffs.
- Weakness (accepted): the green check on failure toasts (item 5). Colour and icon say success while the words say failure.

### Pillar 4: Typography (3/4)

- The phase edits no type rule. New or edited text sits on the contract scale: `.note` 12px / 700 (`maintenance-status.module.css:22-27`), the file-list state line 12.8px (`files-apps.module.css:128-133`), the toast 12.8px (`globals.css:1189`).
- Off-scale values reused on phase surfaces, all pre-existing: `.retry` weight 800 (`maintenance-status.module.css:34`, reused by the too-large note) and dialog `.field label` 13px (`sensitive-action.module.css:158-162`), neither on the new scale nor in the UI-SPEC's frozen list. The frozen 13.5px, 12.5px, 650 and 850 values are untouched.

### Pillar 5: Spacing (3/4)

- No spacing rule was added. The phase reuses `.note`, `.status` (0.75rem / 1.125rem, `files-apps.module.css:128-133`), `.toast` and the dialog's frozen internal values.
- `.retry` has a 28px hit area (`maintenance-status.module.css:29`) against the 44px minimum (item 4). It predates the phase (`fb0ccdc`, 2026-11-14), but the new too-large state relies on it.

### Pillar 6: Experience Design (2/4)

Holds:
- `useHostRead` keeps `old.data` for the same host key and relays the server text only for `agent_response_too_large` (`use-host-read.ts:23-35,41-45`). `maintenance-polling.ts` adds `tooLarge`, keeps the snapshot stale and clears it on the next good response (unit-tested, `tests/maintenance-polling.test.ts:109-160`). The file list keeps rows only for the same root and folder (`file-browser.tsx:91,97-100`) and error wins over busy (`:393-401`). The logs viewer shows the server `error` in a `role="alert"` line and leaves `lines` untouched on a failed poll (`container-logs.tsx:242-244`).
- The card disables itself while executing or pending, never retries on its own, and maps a 5xx other than 503 to `Pendiente de verificar` for both the direct and the dialog path (`maintenance-extras.tsx:71-100`); `sending` guards double clicks (`:102,123,134`). The dialog is inert while verifying or executing (`sensitive-action.tsx:308-310,332,443`).
- The new hooks are exercised by e2e tests that assert state, not copy (`tests/e2e/files-apps.spec.ts:232-250`, `tests/e2e/maintenance-status.spec.ts:310-329`).

Gaps:
- Ctrl K `check-health` (WARNING): there is no re-entry guard. I-3 says a second `H` in flight is ignored, but `runRef` has no flag and the keydown handler only filters `event.repeat` (`command-search.tsx:35-63,87-102`), so each press sends another request with a new Idempotency-Key. A network failure is reported as unconfirmed, but a 5xx other than 503 falls into the plain-failure branch (`:44-53`), so the I-4 mapping applies only on the card.
- Retained rows without explanation (WARNING): the Operator sees an error line over rows and nothing says they are stale (`file-browser.tsx:393-401`).
- Not a finding: purge is confirmed by passkey and destructive tone only, although DESIGN.md says "Eliminar exige escribir el nombre". Typing the name for `purge` is deferred in `06-CONTEXT.md:103` and the UI-SPEC.

---

## Open items resolution

1. Duplicate hook: both attributes kept (allowed branch; only `data-command-option` is read, by e2e).
2. Host line: `dashboard.tsx` only; not applied in the card or Ctrl K.
3. Toast tone: unchanged, per the contract.
4. Generic consequence: kept (default copy).
5. Logs on a 502: no change needed (`container-logs.tsx:242-244`).
6. `settings.tsx:183` native confirm: left, per the contract.
7. Second sentence of the 502 text: not applied.

---

## Needs human review

Not checkable from code; the code-level audit does not replace them (`needs_human_review: true`):
- The sensitive dialog from the card, Ctrl K and a container row at 360px with a 60-character container, file or host name (UI-SPEC E1 and E2 long-text backstops).
- A real passkey ceremony from the card and from Ctrl K: focus order, `Confirmar con passkey`, `Verificando…`, `Enviando…` (pending since `06-03-SUMMARY.md` D5 and `06-VALIDATION.md:168`).
- The file-list error line staying reachable below `Mostrar más` with 100+ retained rows (E5 overflow).
- Toast wrapping with a long server `error` at 360px (E8).

---

## Files Audited

- `src/components/command-search.tsx`, `dashboard.tsx`, `file-browser.tsx`, `settings.tsx` (line 183 only)
- `src/components/views/maintenance-extras.tsx`, `maintenance-status.tsx`, `use-host-read.ts`, `container-logs.tsx`, `deployment-details.tsx` (error rendering only)
- `src/components/sensitive-action/sensitive-action.tsx` and `sensitive-action.module.css`
- `src/components/views/maintenance-status.module.css`, `maintenance-extra.module.css`, `src/components/files-apps.module.css`, `src/app/globals.css` (`.toast`, `.error`, `.muted`, `.command`, global `button`)
- `src/lib/host-command-client.ts`, `src/lib/maintenance-polling.ts`, `src/app/api/[...path]/route.ts` (the 502 branch and the failed-action responses)
- `tests/e2e/maintenance-workflows.spec.ts`, `files-apps.spec.ts`, `maintenance-status.spec.ts` and `tests/maintenance-polling.test.ts` (hook coverage only)
- `06-UI-SPEC.md`, `06-CONTEXT.md`, `06-03-PLAN.md`, `06-06-PLAN.md`, `06-01` to `06-06` summaries, `06-VALIDATION.md`, `DESIGN.md`, `CODING_STANDARD.md`
