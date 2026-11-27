---
phase: "05"
slug: "bot-de-lectura-y-reconocimiento"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-27"
---

# Phase 05 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Telegram → worker | Updates from the public network; content, identity and `callback_data` token untrusted until allowlist and atomic consumption | Callback updates (untrusted) |
| Worker → PostgreSQL | Effect, token and offset committed in one transaction; only the token hash is stored | Incident state, token hashes |
| Worker → Telegram | Every URL carries the bot token; only `botRequest` builds it and results leave as finite values | Bot credential (secret) |
| Operator → delivery state | A snooze decides which interruptions are held; only the allowlisted operator or a hub session can set it | Snooze duration |
| Server → private chat | Why-text goes only to the allowlisted chat and contains only the alert's own data | Alert detail, metric value |
| Browser → hub API | Cookie-authenticated mutation across a possible cross-site Origin; host, id and duration untrusted | Incident actions |
| Worker → logs | Anything the worker emits may reach a shared log and must not contain the credential | Logs, outbox rows |
| Migration → existing data | Migration 0007 runs over production rows and must not rewrite or lose them | Incident rows |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-05-01 | Spoofing | `isAuthorizedCallback`, updates lane | high | mitigate | Double allowlist of `from.id`/`chat.id`, private chat, bot's own message — `src/lib/telegram-updates.ts`, `tests/telegram-updates.test.ts`, `tests/telegram-contract.test.ts` | closed |
| T-05-02 | Tampering | `callback_data`, `consumeActionToken` | high | mitigate | Opaque server-resolved token bound to incident, action, chat and message — `src/lib/incident-actions.ts`, `src/lib/telegram-keyboard.ts` | closed |
| T-05-03 | Tampering | Update/button replay | high | mitigate | `usedAt IS NULL` conditional consume in the effect transaction — `src/lib/incident-actions.ts`; observed in production UAT (repeated Why consumed without a new message) | closed |
| T-05-04 | Information disclosure | API URL and lane logs | high | mitigate | URL built only in `botRequest`, finite results, `redactToken` — `src/lib/telegram.ts`, `src/lib/telegram-updates.ts` | closed |
| T-05-05 | Denial of service | Polling lane | medium | mitigate | Lock-owner only, bounded poll, 30 s backoff, 429 cooldown — `src/lib/telegram-updates.ts` | closed |
| T-05-06 | Elevation of privilege | Snooze hiding a critical outage | high | mitigate | Closed set 1 h/24 h, mandatory expiry, events always recorded, visible in Avisos — `src/lib/incident-snooze.ts`, `src/lib/telegram-keyboard.ts`; observed in UAT test 3 | closed |
| T-05-07 | Repudiation | Lost trail of silenced alerts | medium | mitigate | Delivery row suppressed with finite reason `snoozed`, incident event keeps when/channel — `src/lib/incident-snooze.ts`; observed (outbox 11 `suppressed`) | closed |
| T-05-08 | Tampering | Repeated snooze button | medium | mitigate | One-use token, idempotent per state, shorter duration does not shorten an active snooze — `src/lib/incident-actions.ts` | closed |
| T-05-09 | Tampering | Window between snooze check and attempt mark | low | accept | See Accepted Risks Log AR-05-01 | closed |
| T-05-10 | Information disclosure | Why-text | medium | mitigate | Composed only from incident detail, one metric value and channel; `sendTelegramReply` result tested token-free — `src/lib/telegram.ts`, `tests/telegram.test.ts` | closed |
| T-05-11 | Denial of service | Repeated Why presses | medium | mitigate | Unique key per alert state, one-use token, `disable_notification` — `src/lib/telegram.ts`, `tests/incident-why.test.ts` | closed |
| T-05-12 | Repudiation | Rejected reply not re-armed | low | accept | See Accepted Risks Log AR-05-02 | closed |
| T-05-13 | Tampering | `POST /api/incidents/:id/:action` (CSRF) | high | mitigate | Common handler guards require authorized Origin and session before the new branch — `src/app/api/[...path]/route.ts` | closed |
| T-05-14 | Elevation of privilege | Incident id from another host | high | mitigate | Row loaded by `id` and `hostId`, host resolved against configured hosts, strict body — `src/app/api/[...path]/route.ts` | closed |
| T-05-15 | Elevation of privilege | Snooze without recent verification | medium | accept | See Accepted Risks Log AR-05-03 | closed |
| T-05-16 | Information disclosure | Bot token in results, logs and rows | high | mitigate | `botRequest`-only URL, `redactToken` on every line, full capture test — `src/lib/telegram.ts`; production UAT: token absent from worker and app logs | closed |
| T-05-17 | Denial of service | Poison update, 409 conflict, week gap | high | mitigate | 3-attempt cap, `deleteWebhook` + 30 s backoff on 409, offset skip after 6 days — `tests/telegram-lane-hardening.test.ts` | closed |
| T-05-18 | Denial of service | Unbounded tokens and snoozes | medium | mitigate | Hourly cleanup — `src/lib/telegram-cleanup.ts`, `src/worker.ts`, `tests/telegram-lane-hardening.test.ts` | closed |
| T-05-19 | Denial of service | Poison counters reset with the process | low | accept | See Accepted Risks Log AR-05-04 | closed |
| T-05-20 | Elevation of privilege | Ack hiding an escalation to critical | high | mitigate | D-02 test: after hub ack and immediate-channel escalation the first notice stays `pending` — `src/lib/incident-actions.ts` and suite | closed |
| T-05-21 | Tampering | Repeated ack or ack from another channel | medium | mitigate | Idempotency test: one event, one `seq` bump, one edit from `telegram` and `hub` | closed |
| T-05-22 | Tampering | Token burned by a failed validation | medium | mitigate | `consumeActionToken` returns each reason without setting `usedAt` — `src/lib/incident-actions.ts`, `tests/incident-actions.test.ts` | closed |
| T-05-23 | Repudiation | Unmeasurable acknowledgement | low | mitigate | `acknowledgedAt` timestamptz — `src/lib/schema.ts`; observed in production (incident 144) | closed |
| T-05-24 | Tampering | Migration 0007 rewriting/losing rows | medium | mitigate | Migration test over 0006 — `tests/migrations.test.ts`; production deploy: alerts→incidents counts identical (131/2/143) | closed |
| T-05-SC | Tampering | Dependencies | high | mitigate | No new packages in phase 5 (last `package.json` change is d619576, phase 02-03) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-05-01 | T-05-09 | Closing the window would need a lock across the network; a send in those milliseconds is an alert the operator was going to receive, and the snooze applies from the next job | Plan 05-02 | 2026-11-27 |
| AR-05-02 | T-05-12 | A confirmed rejection is terminal for that state; the next press says "already answered" and the hub is one tap away | Plan 05-03 | 2026-11-27 |
| AR-05-03 | T-05-15 | Low-impact, non-destructive; max 24 h, recorded as an event and visible in Avisos and the digest; phase 6 fixes the protected-action list | Plan 05-04 | 2026-11-27 |
| AR-05-04 | T-05-19 | Limit is 3 attempts per process life; a restart also resets the lock and lane, worst case one extra attempt per restart | Plan 05-05 | 2026-11-27 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-27 | 25 | 25 | 0 | /gsd-secure-phase (L1 grep verification, short-circuit: plan-time register, ASVS 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-27
