---
phase: "07"
slug: "acciones-verificadas-desde-telegram"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-27"
---

# Phase 07 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Telegram → updates lane | A callback is untrusted input: only a single-use token, from the right chat and message and from an allowlisted sender, has any effect | `callback_data`, chat and message ids |
| Lane → PostgreSQL | The lane's only outputs are an intent row and an outbox row, never a call to the agent | Intent row, outbox row |
| PostgreSQL → worker | The handoff token is recomputed when the keyboard is rendered; the database holds only its SHA-256 digest | Handoff token digest |
| Chat → hub | The chat never executes: the intent is the only unit of intention and it expires after five minutes | Intent id, `expiresAt` |
| URL fragment → handoff screen | The token arrives in `#intent=`, is moved into `sessionStorage` and erased from the URL before any request | Handoff token |
| Browser → catch-all (`telegram/intents/inspect`, `telegram/intents/execute`) | Token and session are client data: only the intent owner's session, with a recent verification when the manifest demands one, executes | Token in the POST body, session cookie |
| Catch-all → host agent | Only the shared runner talks to the agent, and only after the atomic claim of the intent | Action payload |
| Client → proxy → app | `Origin` and forwarded headers are chosen by the client; `Host` is set by the proxy when it routes. Only `Host` decides the verification factor | `Host`, `Origin` |
| Proxy → app | The forwarded `Host` can be trusted only while the app port is unreachable without a proxy | `Host` |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-07-01 | Elevation of privilege | `act_*` callback running an action from the chat | high | mitigate | D-00a: the lane only inserts an intent and queues an edit. `telegram-updates.ts`, `telegram-intents.ts` and `telegram-keyboard.ts` import no executor; the static scan in `tests/sensitive-actions.test.ts:384` fails on `operation-runner`, `host-commands`, `lifecycle` or `nas`; `tests/telegram-intents.test.ts:219` asserts zero `operations` rows and no outbound fetch | closed |
| T-07-02 | Information disclosure | Handoff token in the database, logs or the lane | high | mitigate | Token derived with HMAC (`src/lib/telegram-intents.ts:108-120`), only `sha256(token)` stored in `handoffHash` (`:293`); `tests/telegram-intents.test.ts:245-252` asserts the stored row does not contain the token; `tests/telegram-redaction.test.ts` keeps it out of results and logs | closed |
| T-07-03 | Tampering | Two live intents for one notice, or a double claim | high | mitigate | Partial unique index `telegram_action_intents_live_idx` on `status = 'pending'` (`drizzle/0008_acciones_telegram.sql:22`); `claimIntent` is a single `UPDATE … RETURNING` (`src/lib/telegram-intents.ts:342-357`); `tests/telegram-intents.test.ts:550` and `:578` (two claims race) | closed |
| T-07-04 | Spoofing | Guessable handoff token or another user's intent | medium | mitigate | 256-bit HMAC, `HANDOFF_TTL_MS = 5 * 60_000` (`src/lib/telegram-intents.ts:26`), `sameHash` with `timingSafeEqual` (`:124-127`), intent bound to the single operator; `tests/telegram-intents.test.ts:668` (altered token) and `:1080` (fails closed without exactly one user) | closed |
| T-07-05 | Elevation of privilege | `execute` without a recent verification for a protected action | high | mitigate | `guardIntentAction` (`src/lib/verification-api.ts:126`) decides by the stored action and delegates to `guardSensitiveAction`, called before the claim (`src/lib/telegram-intent-api.ts:195`); `tests/api-telegram-intents.test.ts:501` (403, intent stays pending, no operation, no agent request) and `:1074` (per-action matrix) | closed |
| T-07-06 | Elevation of privilege | Phase 6 CR-01: factor chosen by `Origin`, which would put the handoff below success criterion 1 | high | mitigate | Fixed by D-13 in plan 07-06 (see T-07-21); `tests/api-telegram-intents.test.ts:1144` proves a forged alternate `Origin` on the primary host does not run `execute` with a password verification | closed |
| T-07-07 | Tampering | Double execution from a double tap, two tabs or a hook retry | high | mitigate | Atomic `claimIntent` (`src/lib/telegram-intent-api.ts:227`), `operations.id` equal to the intent id as a second barrier, replay returns the existing operation; `tests/api-telegram-intents.test.ts:725`, `:761` and `:1051` (one agent request for two concurrent executes) | closed |
| T-07-08 | Information disclosure | Intent enumeration, or the token in logs or the request URL | medium | mitigate | Token only in the POST body, strict body `z.string().regex(/^[A-Za-z0-9_-]{43}$/)` (`src/lib/telegram-intent-api.ts:47`), `Cache-Control: no-store` (`:41`), the same 404 for an unknown token and another user's intent; `tests/api-telegram-intents.test.ts:516`, `:650` and `:677` | closed |
| T-07-09 | Repudiation | Operation started from the chat without channel or requester | medium | mitigate | `channel` and `requestedBy` recorded by the shared runner (`src/lib/operation-runner.ts:46-78`): `telegram` and the hub user, never the Telegram numeric id; `tests/api-telegram-intents.test.ts:392` and `:466` | closed |
| T-07-10 | Spoofing | Expired or cancelled handoff link still visible in the chat | medium | mitigate | `:expire` outbox row due at `expiresAt` (`src/lib/telegram-intents.ts:309`) plus lazy expiry on every render; the hub answers `expired` even if the edit is late; `tests/telegram-intents.test.ts:494` and `:944`, `tests/api-telegram-intents.test.ts:603` and `:690` | closed |
| T-07-11 | Tampering | Old menu, "Volver" or "Cancelar" token repeating its effect | medium | mitigate | Single-use `consumeActionToken` (`src/lib/telegram-updates.ts:559`) and conditional `UPDATE` in `cancelLiveIntent` (`src/lib/telegram-intents.ts:239`); `tests/telegram-intents.test.ts:794` and `:915` | closed |
| T-07-12 | Denial of service | One outbox row per menu press | low | accept | See Accepted Risks Log AR-07-01 | closed |
| T-07-13 | Elevation of privilege | `reboot` from the handoff without the typed Maintenance phrase (D-12) | medium | accept | See Accepted Risks Log AR-07-02 | closed |
| T-07-14 | Tampering | Regression of `/api/action` when the runner was extracted | high | mitigate | Behaviour-neutral extraction into `src/lib/operation-runner.ts`; action, command and manifest suites green before and after (`tests/api-lifecycle.test.ts`, `tests/api-hosts.test.ts`, `tests/api-incidents.test.ts`, `tests/sensitive-actions.test.ts`) | closed |
| T-07-15 | Elevation of privilege | `TELEGRAM_DIRECT_ACTIONS` switched on by mistake or read by a future change | high | mitigate | Only `0` or absent is accepted; any other value fails startup (`src/lib/runtime-config.ts:330-335`, SEC-03), and there is no field for it in `RuntimeConfig`; `tests/runtime-config.test.ts` | closed |
| T-07-16 | Tampering | Action on a different container than the one in the notice (recreated) | medium | mitigate | Id resolved by name from the latest sample at execution time (`src/lib/telegram-intent-api.ts:83`), 409 without consuming when the name is missing (`:222`); `tests/api-telegram-intents.test.ts:984` | closed |
| T-07-17 | Information disclosure | Handoff token in the URL, history or console | high | mitigate | Fragment erased with `history.replaceState` after capture (`src/lib/telegram-handoff-client.ts:96`), token in `sessionStorage` only until a terminal state (`:70`), sent only in POST bodies; `tests/e2e/telegram-handoff.spec.ts:209-210` and `:265-266` assert an empty `hash` | closed |
| T-07-18 | Tampering | The UI deciding by its own list what needs a passkey | high | mitigate | `requiresVerification` comes from `inspect`, computed server-side by `requiresVerificationForIntent` (`src/lib/telegram-intent-api.ts:393`, `src/lib/sensitive-actions.ts:81`); `execute` checks again with `guardIntentAction` and a 403 reopens the verification | closed |
| T-07-19 | Information disclosure | Token readable in `sessionStorage` by an injected script | medium | accept | See Accepted Risks Log AR-07-03 | closed |
| T-07-20 | Denial of service | Passkey blocked in Telegram's in-app browser (assumption A1) | medium | accept | See Accepted Risks Log AR-07-04 | closed |
| T-07-21 | Elevation of privilege | CR-01: factor chosen by a forged `Origin`, letting the password replace the passkey on the primary domain | critical | mitigate | `verificationMethodForRequest` decides by the connection `Host` and a mismatching `Origin` falls back to passkey (`src/lib/verification.ts:99-124`, D-13); `tests/verification.test.ts:259` and `:289`, through the real routes; `tests/api-telegram-intents.test.ts:1144` repeats it against `execute` | closed |
| T-07-22 | Spoofing | Forwarded-host header, list or unreadable `Host`, or `Origin: null` used to pick the factor | high | mitigate | No forwarded-host header is read (`src/lib/verification.ts:107`); anything ambiguous or unreadable fails closed to passkey; matrix rows in `tests/verification.test.ts` | closed |
| T-07-23 | Spoofing | Client reaching the app port without the proxy and choosing `Host` | medium | accept | See Accepted Risks Log AR-07-05 | closed |
| T-07-24 | Denial of service | Alternate entry loses the password if the proxy does not forward the original `Host` | medium | mitigate | The regression falls back to passkey, with no loss of security; `tests/verification.test.ts:314` pins the genuine alternate entry end to end; the real-proxy `curl` check in the README is a manual UAT item | closed |
| T-07-SC | Tampering | Dependencies | high | mitigate | No new packages: `package.json` and `pnpm-lock.yaml` unchanged since the first phase 7 commit (`git diff 242ab3c^ HEAD`) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-07-01 | T-07-12 | One row per authorized press from the single allowlisted chat, each with a single-use token; the outbox cooldown and lease already bound what is sent | Plan 07-03 | 2026-11-27 |
| AR-07-02 | T-07-13 | User decision D-12: the handoff asks for a tap and the passkey (the manifest requires a recent verification for `reboot`), and the agent can still refuse with `ALLOW_REBOOT=false` (`agent/server.py:688`). From the chat, only the typed phrase is dropped compared with Maintenance | User (D-12), Plan 07-04 | 2026-11-27 |
| AR-07-03 | T-07-19 | The phase 6 nonce CSP (`src/lib/csp.ts`, `src/proxy.ts`) limits which scripts run; the token is valid for at most five minutes, is single use, is removed on a terminal state, and acting with it still needs the session and, where required, the passkey | Plan 07-05 | 2026-11-27 |
| AR-07-04 | T-07-20 | The dialog tells the operator to open the button in the system browser (`src/components/views/telegram-handoff.tsx:161-162`); `inspect` does not consume the intent, so reopening within five minutes works. Checked in the manual UAT | Plan 07-05 | 2026-11-27 |
| AR-07-05 | T-07-23 | `compose.yaml` publishes the app port on loopback by default (`${BIND_IP:-127.0.0.1}`) and the README forbids exposing it without a proxy; whoever reaches the port directly is already inside the alternate entry's perimeter (password) and gains no new capability | Plan 07-06 | 2026-11-27 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-27 | 25 | 25 | 0 | /gsd-secure-phase (L1, plan-time register, ASVS 1, short-circuit without spawning the auditor; each mitigation read in code and its tests re-run: 449 Vitest tests over 15 files against PostgreSQL and, in the same session, 38 Playwright tests over 4 specs on the production build, all green; 20 mitigated, 5 accepted at plan time) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-27
