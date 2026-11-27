# Phase 07 — UI Review

**Audited:** 2026-11-27
**Baseline:** abstract 6-pillar standards plus `DESIGN.md` (no UI-SPEC exists for this phase) and `CODING_STANDARD.md` for text
**Screenshots:** not captured (nothing listens on ports 3000, 5173 or 8080; code-level audit, no server was started)
**Interaction captures:** off (`workflow.ui_interaction_capture` is false)
**Method:** `git diff 242ab3c^..HEAD -- src` (`telegram-handoff.tsx`, `alerts.tsx`, `sensitive-action.tsx`, `login.tsx`, `telegram-handoff-client.ts`; no CSS file changed), read against DESIGN.md. The Telegram chat copy was read in `src/lib/telegram-keyboard.ts`, `src/lib/telegram-intents.ts`, `src/lib/telegram-updates.ts` and `src/lib/telegram.ts`. Interaction findings are code-derived, not observed.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 2/4 | Telegram verbs (`Arrancar`, `Reiniciar host`) differ from the hub's (`Iniciar`, `Reiniciar NAS`) for the same actions |
| 2. Visuals | 3/4 | One focal panel and the right hooks; it ignores the panel-head pattern and carries no status dot or icon |
| 3. Color | 3/4 | No colour added; the handoff outcome carries no semantic tone (success, pending and expiry all read as muted text) |
| 4. Typography | 3/4 | Only existing classes are reused; no new size or weight |
| 5. Spacing | 3/4 | `.panel stack` reuse is consistent; the panel pushes the digest down with no panel-head |
| 6. Experience Design | 3/4 | All 12 states handled, token cleared on end, no auto-retry; no `aria-busy`, no focus handoff, raw `operation.detail` shown |

**Overall: 17/24**

---

## Top 3 Priority Fixes

1. **The same action has two names across surfaces** — an Operator taps `Arrancar` or `Reiniciar host` in Telegram, then sees `Iniciar` or `Reiniciar NAS` in the dialog title (`telegram-handoff.tsx:94-98`) and in «Acciones recientes» (`alerts.tsx:26,29`). DESIGN.md says to "usar siempre estas palabras para que todas las páginas digan lo mismo". Align `INTENT_VERBS` (`src/lib/telegram-intents.ts:56-62`) with the hub: `start: "Iniciar"`, `reboot: "Reiniciar NAS"`. The button label, the dialog title and the Acciones recientes label then match. The `reboot` verb is the destructive one (`--loss`, "Reiniciar NAS" in `maintenance.tsx:282`), so the name matters.
2. **The handoff outcome has no semantic colour or status dot** — DESIGN.md principle 4 asks for "punto de color y texto". `succeeded`, `pending`, `expired`, `cancelled`, `consumed`, `invalid` and `dismissed` all render the same muted `p.subtle`, so a completed action, an uncertain one and a dead link look identical. Only `failed` has a tone (`.error`). Add a `data-tone` or a class per state: `--gain` for `succeeded`, `--peach` for `pending` and `dismissed`, `--muted` for the dead-link states. Keep the `role="status"` text.
3. **The panel does not follow the panel pattern and gives no focus cue** — it is a bare `.panel.stack` with an `h2`, not a `panel-head` (DESIGN.md "Panel": header of 56px minimum). It renders above «Resumen diario», but nothing moves focus or scrolls to it after the login redirect, and nothing sets `aria-busy` while `loading` or `executing`. Use the `panel-head` structure, set `aria-busy` on the section for those two states, and focus the `h2` (tabIndex -1) when the panel first appears.

---

## Additional recommendations

4. **WARNING.** `operation.detail` is printed verbatim (`telegram-handoff.tsx:289-293`). It is server text that may be technical or English. The UI has no fallback copy for an operation with no detail and no mapping by status.
5. **WARNING.** The `dismissed` copy says "El enlace sigue vivo hasta que caduque" (`telegram-handoff.tsx:68-69`). It names no time. The link lasts five minutes (`telegram-intents.ts:25`) and the dialog help text already says 5 minutes. Say "durante 5 minutos desde el aviso" or show the `expiresAt` the inspect call already returns.
6. **WARNING.** In `dismissed`, `Revisar y confirmar` is `primary` and `Descartar` is a `text-button`. `Descartar` clears the token without telling the Operator the Telegram button will still open a dead link. Add a short note or rename it `Cerrar y olvidar el enlace`.
7. **WARNING.** The «Acciones recientes» channel label is appended to the `<time>` element (`alerts.tsx:574`) as `· Desde Telegram`. It is part of the timestamp text and not a separate element, so it is not reachable by assistive tech as a channel. The `data-operation-channel` hook exists for tests only. Move it to its own `<span>`.
8. **NIT.** Every operation row uses the same `RefreshCw` icon, including the Telegram ones. A channel icon would distinguish them without more text.
9. **NIT.** `operationLabels` falls back to the raw identifier (`alerts.tsx:552`), so a future `backup-now` variant shows `deploy-now`-style text. The map covers the 11 current actions.
10. **NIT (unverified).** On a 401, `inspect` calls `window.location.reload()` (`telegram-handoff.tsx:201-205`). The code relies on `captureHandoff` having stored the token in `sessionStorage` before the reload; read it in `telegram-handoff-client.ts` before trusting it.

BLOCKER findings: 0. WARNING findings: 8 (fixes 1 to 3 hold the main ones; items 4 to 7 are the rest). NIT findings: 3.

---

## Detailed Findings

### Pillar 1: Copywriting (2/4)

Good:
- Dialog `confirmLabel: "Confirmar"` (`telegram-handoff.tsx:171`) matches the existing `Confirmar` of the phase 06 dialogs. The consequence `Se ejecutará una sola vez.` and the passkey help text are specific and say what to do (`:149,161-163`).
- Message map (`:56-70`) covers every state with a next step where one exists: `expired` says to go back to Telegram and press the button again; `pending` says it will not repeat by itself, which matches DESIGN.md principle 5.
- Telegram: `Reconocer`, `Silenciar 1 h`, `Quitar silencio`, `Por qué me llegó esto`, `Acciones…`, `Volver`, `Cancelar`, `Abrir en el hub` (`telegram.ts:353`) and the toast `Confirma en el hub` (`telegram-updates.ts:334`) are short and plain.

Deviations:
- `INTENT_VERBS` (`telegram-intents.ts:56-62`): `Arrancar` vs hub `Iniciar` (`maintenance.tsx:630`, `alerts.tsx:26`); `Reiniciar host` vs hub `Reiniciar NAS` (`maintenance.tsx:282,295`, `alerts.tsx:29`). `Reiniciar host` is also wrong for the Apps host, but the hub label is the shared vocabulary.
- `dismissed` uses the figure "vivo", which is technical (`:68-69`).
- `failed` shows the raw `outcome.error` or `body.error` with no prefix; the fallback `No se pudo comprobar el enlace.` has no next step beyond the `Reintentar` button.
- Tests are not coupled to copy: states are exposed as `data-handoff-state` (`:266`), per `CODING_STANDARD.md`.

### Pillar 2: Visuals (3/4)

- One panel, one `h2` (`Acción desde Telegram`), a context line `{verb} {target} · {host}` (`:274-278`) and at most one primary button per state. That is a clear focal point and respects "Uno por zona".
- Hooks are complete: `data-handoff`, `-state`, `-action`, `-target`, `-resolved`, `-retry`, `-reopen`, `-discard`, `-close`.
- Gaps: no `panel-head`, no icon, no status dot (DESIGN.md "Punto de estado"); the panel sits above «Resumen diario» (`alerts.tsx:432`), so a stale `expired` or `consumed` panel pushes the page's real content down until the Operator presses `Cerrar`. The dialog itself reuses the verified sensitive-action dialog and names the host through `description` (the phase 06 gap does not repeat).
- `alerts.tsx:548-580`: Acciones recientes rows keep the existing structure; the channel text is the only change.

### Pillar 3: Color (3/4)

- No colour token or hard-coded colour was added in the diff (`git diff` shows no `#`/`rgb(` additions in `src`; no CSS file changed).
- Only `.subtle` (`--muted`) and `.error` are used. `succeeded` is not `--gain`, `pending` is not `--peach`, and the dialog consequences use `tone: "warn"` for all three items, including `Se ejecutará una sola vez.`, which is information, not a warning. DESIGN.md's semantic table (`--gain` completed, `--peach` attention, `--lilac` Operator decision) is not applied.
- Accent usage: two `primary` buttons, never rendered together.

### Pillar 4: Typography (3/4)

- No new rule; `h2`, `p.subtle`, `p.error`, `button.primary` and `button.text-button` come from `globals.css`. No monospace is used for the target name, which DESIGN.md reserves for versions, paths and logs; the target is a container name, so that is correct.
- `h2` is the global size, not the `panel-head h2` (14px, 800) that DESIGN.md lists for panel titles (`globals.css:1387-1392`), so this panel's title is larger than its neighbours' once they are migrated.

### Pillar 5: Spacing (3/4)

- `.panel` uses `clamp(1rem, 0.7rem + 0.8vw, 1.6rem)` padding and `stack` gap, the same as the neighbouring panels; no arbitrary values in the diff.
- `.text-button` and `.primary` keep the 44px minimum (`globals.css:190`). Two separate `.toolbar` blocks can render (`shown === "dismissed"` and `over` are exclusive, so at most one appears).
- The first panel has no `panel-head` separator, so the text sits at panel padding rather than the 18px header alignment of DESIGN.md.

### Pillar 6: Experience Design (3/4)

State coverage (from `HandoffState`, `:16-28`):
- Loading: `Comprobando el enlace…` in `role="status"`; no `aria-busy`.
- Error: `failed` with `role="alert"` and `Reintentar`, which only re-inspects and never re-sends (`:300-304`).
- Terminal states clear the token (`end`, `:115-119`); `pending` never offers the link again, honouring "nunca se reintenta solo".
- Empty: `idle` renders nothing; an unexpected `state` falls through `failed`.
- The dialog closing without a confirmation becomes `dismissed` and offers `Revisar y confirmar` or `Descartar`.
- `requiresVerification: false` (`sensitive-action.tsx:114-118`) skips the verification lookup, and `data-verification-required` exposes the choice. The server still decides: a 403 reopens verification (per the type comment).
- Login keeps the token across the redirect (`login.tsx:27-32`); the 401 reload path depends on that.

Gaps: no `aria-busy` while `loading` or `executing`; no focus move or scroll to the panel; `Cerrar` is the only way out of a terminal state, and it does not clear `failure`; the `succeeded` panel does not link to «Acciones recientes» to confirm the result, although the operation row is on the same page.

---

## Files Audited

- `src/components/views/telegram-handoff.tsx`
- `src/components/views/alerts.tsx`
- `src/components/sensitive-action/sensitive-action.tsx`
- `src/components/login.tsx`
- `src/lib/telegram-handoff-client.ts` (referenced, not re-read in full)
- `src/lib/telegram-keyboard.ts`, `src/lib/telegram-intents.ts`, `src/lib/telegram-updates.ts`, `src/lib/telegram.ts` (Telegram copy)
- `src/components/views/maintenance.tsx` (hub vocabulary), `src/app/globals.css` (shared classes)
- `DESIGN.md`, `CODING_STANDARD.md`
