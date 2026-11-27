---
phase: "06"
slug: "puerta-de-seguridad"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-27"
---

# Phase 06 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Browser → catch-all (`/api/action`, `/api/host-command`) | A cookie-authenticated request does not prove the operator is present; the server decides with the manifest | Session cookie, mutation body |
| Catch-all → PostgreSQL | Recent verification is read only from the session's `recent_verification` record, never from a body field | Verification record |
| UI → server | The UI explains and retries; it is not a control. The server rejects protected work with 403 even if the UI skips the dialog | Passkey/password dialog, 403 `recent_verification_required` |
| Search and card → `/api/host-command` | Two UI entry points reach the same endpoint and must agree on what needs verification | Host command name |
| Browser → document | HTML runs scripts with the operator's session; an injected script would reach the API with it | Rendered documents, nonce |
| App → TLS proxy | HSTS is honoured only over HTTPS; the app emits, Nginx Proxy Manager or Tailscale Serve transport | Response headers |
| Browser → API | JSON responses are not documents and need to load nothing | API responses |
| Client → catch-all (body) | A mutation body from an authenticated session is untrusted in size and shape | JSON mutation bodies |
| Client → catch-all (method and route) | Only routes and verbs declared in the manifest reach a handler; a future route must pass through it | Method, path |
| Client → Better Auth | The most exposed surface without a session (sign-in) receives bodies that must be bounded | Credential and passkey exchanges |
| Catch-all → agent | An accepted body is forwarded bounded by schema; the agent keeps its own 64 KiB limit | Action and command payloads |
| Agent → hub | An agent response can be huge (logs up to 64 MiB, unpaginated listings); its size is untrusted | Metrics, logs, listings, results |
| Hub → browser | The view must show the error and the last good data, never partial data | Read-endpoint responses |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-06-01 | Elevation of privilege | `/api/action` (stop, restart, update-container, purge, empty-trash) | high | mitigate | Guard decided by `actionPolicies`, after the idempotent replay and before the sample check and the insert — `src/app/api/[...path]/route.ts`, `src/lib/sensitive-actions.ts`; per-action matrix asserting 403, zero agent requests and zero operations — `tests/sensitive-actions.test.ts` | closed |
| T-06-02 | Elevation of privilege | `runHostCommand` (seven state-changing commands) | high | mitigate | `requiresVerificationForCommand` then `guardSensitiveAction` before `executeHostCommand`; `check-health` exempt — `src/lib/host-commands.ts`; per-command matrix — `tests/sensitive-actions.test.ts`, `tests/api-host-commands.test.ts` | closed |
| T-06-03 | Tampering | Protected list duplicated in the UI drifts from the server | medium | mitigate | One manifest, `satisfies Record<ActionId, Policy>` and `satisfies Record<HostCommand, Policy>`; the UI imports `requiresVerificationForAction/Command` (`src/components/dashboard.tsx`, `command-search.tsx`, `views/maintenance-extras.tsx`); coverage test compares with `actionSchema` and `hostCommandIds` — `tests/sensitive-actions.test.ts` | closed |
| T-06-04 | Information disclosure | Replay of an already registered key answers without a new verification | low | accept | See Accepted Risks Log AR-06-01 | closed |
| T-06-05 | Elevation of privilege | Injected script (XSS) running with the operator's session | high | mitigate | Per-request nonce plus `'strict-dynamic'`, no `'unsafe-inline'` in `script-src`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` — `src/proxy.ts`, `src/lib/csp.ts`; per-directive structural test — `tests/security-headers.test.ts`; `tests/e2e/csp.spec.ts` 5/5 on the production build (nonce differs per request, zero violations) | closed |
| T-06-06 | Information disclosure | Downgrade to HTTP on the main or alternative domain | medium | mitigate | `Strict-Transport-Security: max-age=15552000` emitted by the app on every path — `next.config.ts`; `tests/security-headers.test.ts`, `tests/e2e/csp.spec.ts`. Per-domain `curl -sI` check is an environment step carried to UAT (06-VALIDATION.md) | closed |
| T-06-07 | Spoofing | Clickjacking of the panel | low | mitigate | `frame-ancestors 'none'` in the document CSP (`src/lib/csp.ts`) and in the API CSP (`next.config.ts`), on top of the existing `X-Frame-Options: DENY` | closed |
| T-06-08 | Tampering | Double HSTS header if Nginx Proxy Manager also emits it | low | accept | See Accepted Risks Log AR-06-02 | closed |
| T-06-09 | Denial of service | A CSP that is too strict breaks hydration, service worker, passkeys or push | medium | mitigate | `tests/e2e/csp.spec.ts` fails on any `securitypolicyviolation` in login, panel, 404 and `sw.js` registration (5/5 on the production build); rollback by deleting `src/proxy.ts` is documented in `README.md`; zod runs `jitless` in the browser so the CSP stays strict — `src/lib/auth-client.ts`. Safari and Firefox check is an environment step carried to UAT (06-VALIDATION.md) | closed |
| T-06-10 | Elevation of privilege | UI/server divergence: a protected button sent without dialog ends in a raw 403, or a read-only one asks for a passkey | medium | mitigate | The UI decides with `requiresVerificationForCommand/Action` — `src/components/command-search.tsx`, `views/maintenance-extras.tsx`, `dashboard.tsx`; e2e iterate `hostCommandPolicies` on the card and on the Ctrl K search and cover the container row actions — `tests/e2e/maintenance-workflows.spec.ts`, `tests/e2e/maintenance.spec.ts`; the server stays the authority (T-06-01, T-06-02) | closed |
| T-06-11 | Tampering | `check-health` sent without dialog or presence | low | accept | See Accepted Risks Log AR-06-03 | closed |
| T-06-12 | Denial of service | Oversized body to force memory allocation in the hub | high | mitigate | `readBodyText` rejects by `Content-Length` without reading, cuts while streaming and cancels the reader, before parsing and before any guard — `src/lib/request-body.ts`; every mutation reads through it (no direct `request.json()` left in `src/`, enforced by a scan test); 413 matrix per route — `tests/sensitive-actions.test.ts`, `tests/request-body.test.ts` | closed |
| T-06-13 | Information disclosure | The 413 logs or echoes the rejected body | low | mitigate | Fixed Spanish message, no `console.error`, no echo — `src/app/api/[...path]/route.ts`, `src/app/api/auth/[...all]/route.ts`; a `console.error` spy is asserted not called across the 413 matrix — `tests/sensitive-actions.test.ts` | closed |
| T-06-14 | Tampering | An intermediate `catch` turns the 413 into a 400 or 503 | medium | mitigate | `BodyTooLarge` is the first branch of the catch-all `catch`; `handlePasswordVerification` rethrows it and the call is awaited — `src/app/api/[...path]/route.ts`, `src/lib/verification-api.ts`; password-route 413 test plus malformed-body 400 test — `tests/sensitive-actions.test.ts` | closed |
| T-06-15 | Denial of service | A global 16 KiB cap breaks legitimate `.env` settings of up to 64 KiB | low | mitigate | `DEPLOYMENT_SETTINGS_BODY_LIMIT` of 64 KiB — `src/lib/deployment-settings.ts`; accepts bodies between 16 and 64 KiB, 413 above, and a drift test against `MAX_REQUEST_BYTES` in `agent/env_settings.py` — `tests/api-deployment-settings.test.ts` | closed |
| T-06-16 | Elevation of privilege | A new route or action forgotten in the protected list | high | mitigate | `routeManifest` with `satisfies`, scans of `route ===` literals, regular expressions and `route.ts` files, typed fixtures for whole-route protected POSTs, undeclared route answers 404 — `src/lib/sensitive-actions.ts`, `tests/sensitive-actions.test.ts` ("route declarations", "whole-route protection") | closed |
| T-06-17 | Tampering | Unplanned verb (`DELETE /api/action`) reaches a mutation handler | medium | mitigate | `routeVerdict` answers 405 with `Allow` before dispatch; exported verbs compared with the manifest — `src/app/api/[...path]/route.ts`, `tests/sensitive-actions.test.ts` ("route manifest dispatch") | closed |
| T-06-18 | Denial of service | Unbounded body on `/api/auth/*` | medium | mitigate | POST wrapper with `readBodyText` and `AUTH_BODY_LIMIT` of 32 KiB, 413 without invoking Better Auth, faithful passthrough otherwise — `src/app/api/auth/[...all]/route.ts`, `tests/auth-body-limit.test.ts`; sign-in through it passes in `tests/e2e/csp.spec.ts` | closed |
| T-06-19 | Elevation of privilege | A new dispatch style (for example a `switch`) escapes the literal scan | medium | mitigate | The manifest verdict is evaluated before the whole `if` chain, so a route absent from it never reaches a handler (fails closed); the scan also forbids `switch (route)` and `startsWith`/`includes` dispatch — `src/app/api/[...path]/route.ts`, `tests/sensitive-actions.test.ts` | closed |
| T-06-20 | Denial of service | A huge agent response exhausts the hub's memory | high | mitigate | Single bounded reader `readBounded` in `nasEffectForHost` (rejects by `Content-Length`, cuts while streaming, cancels the reader) with per-path `AGENT_RESPONSE_LIMITS`; it is the only server-side agent `fetch` — `src/lib/nas.ts`; declared and streamed excess tests — `tests/agent-client.test.ts` | closed |
| T-06-21 | Tampering | A truncated response is interpreted as valid | medium | mitigate | `JSON.parse` only sees a body that fit whole; any cut is `ResponseTooLarge`, never partial data; the collector treats it as a contract failure (no sample, incidents unchanged) — `src/lib/nas.ts`; spy on `JSON.parse` and several cut points including multibyte — `tests/agent-client.test.ts`, `tests/collector-alerts.test.ts`; views keep the last good data — `tests/e2e/files-apps.spec.ts`, `tests/maintenance-polling.test.ts` | closed |
| T-06-22 | Information disclosure | The 502 message leaks agent content or detail | low | mitigate | Fixed Spanish message with stable `code: "agent_response_too_large"`; the log line carries only the cap — `src/app/api/[...path]/route.ts`; POST paths fall to the fixed "pending" text — `src/lib/host-commands.ts`; body asserted free of agent content — `tests/api-logs.test.ts`, `tests/api-deployments.test.ts` | closed |
| T-06-23 | Denial of service | A legitimately very large listing can no longer be viewed | low | accept | See Accepted Risks Log AR-06-04 | closed |
| T-06-SC | Tampering | Dependencies | high | mitigate | No new packages in phase 6: `package.json`, `pnpm-lock.yaml` and `agent/requirements.txt` are unchanged from 3b543b0 (parent of the first phase commit) to HEAD (last `package.json` change is d619576, phase 02-03); `agent/` is untouched | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-06-01 | T-06-04 | On `/api/action` a replay answers before the guard and before any insert or agent call, so nothing new executes (host commands guard first, which is stricter); it returns the same operation projection that `/api/overview` already serves, to an authenticated, Origin-checked request that must know a UUID key. The plan's wording "same session" is not enforced (only the host is compared), but on a single-owner hub (sign-up is disabled; only the SETUP_TOKEN-guarded setup creates the first account) the exposure is unchanged | Plan 06-01 | 2026-11-27 |
| AR-06-02 | T-06-08 | A duplicated `Strict-Transport-Security` header is harmless: the browser processes only the first and both are equivalent; the README tells the operator to leave Nginx Proxy Manager's "HSTS Enabled" switch off | Plan 06-02 | 2026-11-27 |
| AR-06-03 | T-06-11 | `check-health` only issues Docker `GET` calls on the agent and changes nothing (D-03); the server declares it exempt and still requires an `Idempotency-Key`, so a repeat is deduplicated | Plan 06-03 | 2026-11-27 |
| AR-06-04 | T-06-23 | With the 8 MiB `/files` cap a directory that large cannot be listed; the view shows the error and keeps the last listing (e2e-covered); the limitation is documented in the README and the caps are to be measured against real sizes in production | Plan 06-06 | 2026-11-27 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-27 | 24 | 24 | 0 | /gsd-secure-phase (L1, plan-time register, ASVS 1, short-circuit without auditor spawn; each mitigation read in code and its tests re-run: 315 vitest tests over 15 files against PostgreSQL and 30 Playwright tests over 4 specs on the production build, all green; 20 mitigated, 4 plan-time accepts) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-27
