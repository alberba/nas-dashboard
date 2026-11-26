---
phase: 05-bot-de-lectura-y-reconocimiento
reviewed: 2026-11-26T15:47:38Z
depth: standard
files_reviewed: 37
files_reviewed_list:
  - drizzle/0007_bot_reconocimiento.sql
  - drizzle/meta/0007_snapshot.json
  - drizzle/meta/_journal.json
  - src/app/api/[...path]/route.ts
  - src/components/dashboard.tsx
  - src/components/views/alerts.tsx
  - src/lib/digest-content.ts
  - src/lib/incident-actions.ts
  - src/lib/incident-snooze.ts
  - src/lib/incident-store.ts
  - src/lib/incident-why.ts
  - src/lib/madrid-day.ts
  - src/lib/notification-dispatch.ts
  - src/lib/schema.ts
  - src/lib/telegram-cleanup.ts
  - src/lib/telegram-keyboard.ts
  - src/lib/telegram-updates.ts
  - src/lib/telegram.ts
  - src/lib/types.ts
  - src/lib/worker-loop.ts
  - src/worker.ts
  - tests/api-incidents.test.ts
  - tests/digest-ack-labels.test.ts
  - tests/e2e/incidents.spec.ts
  - tests/incident-actions.test.ts
  - tests/incident-snooze.test.ts
  - tests/incident-why.test.ts
  - tests/madrid-day.test.ts
  - tests/migrations.test.ts
  - tests/snooze-delivery.test.ts
  - tests/telegram-contract.test.ts
  - tests/telegram-fake.ts
  - tests/telegram-lane-hardening.test.ts
  - tests/telegram-redaction.test.ts
  - tests/telegram-replays.test.ts
  - tests/telegram-updates.test.ts
  - tests/telegram.test.ts
findings:
  critical: 0
  warning: 1
  info: 3
  total: 4
  necessity: 0
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-11-26T15:47:38Z
**Depth:** standard
**Files Reviewed:** 37
**Status:** issues_found

## Summary

The scope is the union of the six plan SUMMARYs (Tier 2), cross-checked with `check evaluation-scope --phase 05`: the union of parsed task commits omits `src/lib/incident-snooze.ts`, `tests/incident-snooze.test.ts` and `tests/snooze-delivery.test.ts` (four SUMMARYs report no parsable Task Commits rows), but those three are phase-05 work in the phase diff and in the SUMMARYs, so they were added and reviewed. I read the 21 non-test files end to end (the 1902-line `drizzle/meta/0007_snapshot.json` was validated by `tests/migrations.test.ts`, not line by line) and reviewed the 16 test files at contract level after running them: **191 tests pass**; `pnpm typecheck` is clean; ESLint is clean on every phase source file.

The security core holds, and I verified each claim against the code rather than the tests:

- **Token secrecy.** The bot token is interpolated only in `botRequest`'s URL (`src/lib/telegram.ts:227`). Every method returns a finite result, provider bodies are parsed as an envelope and never kept as text, and no `result`/`reason` column can hold one (`httpReason`/`retryAfterMs` are closed mappings). The only lane logger (`say`) passes every line through `redactToken`, and all its call sites pass fixed strings. `RuntimeConfigError` names variables and reasons, never values. I found no path from the token to a row, a log or an API response.
- **Allowlist.** `isAuthorizedCallback` requires `from.id === chat.id === TELEGRAM_CHAT_ID`, `chat.type === "private"`, a bot-authored message (unless it is inaccessible, where the token binding is the proof) and a well-formed `v1:` token. The lane refuses to start at all with a negative (group) chat id; runtime config already constrains the id to a positive integer, so the comparison is textual equality of the same canonical form. Every foreign update only advances the offset: no action, no answer, no content in the log.
- **One-use tokens and replays.** Only `sha256(token)` is stored. Consumption is `SELECT … FOR UPDATE`, then all shape/expiry/chat/opening-message checks, then a conditional `UPDATE … SET usedAt` in the same transaction as the effect and the offset advance (`src/lib/incident-actions.ts:233-292`). A replay after a crash re-delivers the update, finds the token used, moves the offset and answers "Ya usado" without a second effect; a death before commit rolls back the effect, the use and the offset together. Expiry, chat and message mismatches leave the token untouched and produce no effect. The offset reset after six quiet days cannot replay an effect because effect and offset are atomic.
- **Hub actions.** Session + allowed Origin, an exact host/id pair, a strict body with the closed duration set (required for `snooze`, forbidden otherwise), and the shared action inside one transaction. Acknowledgement and silence never touch the delivery policy.

The single defect is in the "why" dispatcher: it takes the durable attempt mark before the reads that compose the answer, so a transient read error turns a reply that provably never left into a permanently lost `uncertain` row. The rest is quality: duplicated logical keys, one clock rendered inconsistently, and three statements/comments glued by edits.

I found no necessity findings: the guards I examined (the inaccessible-message branch, the `job.revision` re-checks, the "not modified" mapping, the poison cap) each sit on a real provider or durability boundary.

## Warnings

### WR-01: A failed read after the attempt mark silently loses a requested "why" reply

**File:** `src/lib/notification-dispatch.ts:754` (mark), reads at `:763-790`

**Issue:** `dispatchWhy` calls `beginOutboxAttempt` and only then reads the opening row, the live silence, the policy and the latest sample to build the reply text:

```ts
const attempts = await beginOutboxAttempt(context.client, job.id, context.token, context.now);
...
const [opening] = await db.select(...);           // may throw
const snoozed = await activeSnooze(...);          // may throw
const [latest] = await db.select(...);            // may throw
const text = renderWhyText(whyFacts({ ... }));
```

If any of those reads fails (connection reset, statement timeout, pool exhaustion), the error escapes `dispatchWhy`; `runDispatchOnce` rethrows it and the row stays `claimed` with `attemptStartedAt` set. The next tick's `recoverOutbox` (`src/lib/notification-dispatch.ts:210-226`) matches exactly that shape for every kind except `incident-edit` and sets it to `uncertain` — and `uncertain` is never retried. So the operator pressed "Por qué me llegó esto", got "Hecho", and the explanation is discarded even though no HTTP request was ever made. The opening path does not have this hole (it performs no DB read after its mark) and edits are recovered as pending, which makes `dispatchWhy` the outlier rather than the intended D-01 contract ("uncertain" means "may have reached the provider").

**Fix:** Compose the text before taking the durable mark, exactly as `dispatchTelegramOpening` already does — the send happens milliseconds later, so the facts are still current:

```ts
const at = new Date(context.now);
const [opening] = await db.select({ channel: notificationOutbox.channel })...;
const snoozed = await activeSnooze(db, incident.hostId, incident.key, at);
const [latest] = await db.select({ data: samples.data })...;
const text = renderWhyText(whyFacts({ incident, opening: opening ?? null, policy, snoozed, metrics: latest?.data ?? null }));

const attempts = await beginOutboxAttempt(context.client, job.id, context.token, context.now);
if (attempts === null) return { action: "idle", jobId: job.id, reason: "claim_lost" };
```

(If keeping the reads after the mark is preferred for freshness, wrap them and clear `attemptStartedAt`/`status` on failure; otherwise the row must be requeued rather than marked uncertain.)

## Info

### IN-01: The same acknowledgement clock is shown in two different time zones

**File:** `src/components/views/alerts.tsx:301`

**Issue:** The hub renders the acknowledgement instant with the browser's zone (`new Date(acknowledged.at).toLocaleString("es")`) while the line directly below renders the silence deadline in Europe/Madrid (`madridTime(snooze.until)`), and the Telegram notice itself prints `Reconocida HH:mm` in Madrid (`src/lib/notification-dispatch.ts:994`). An operator whose browser is not on Madrid time therefore reads a different clock for the same fact on the hub and in the notice. The episode timestamps elsewhere in the component use local time, so this is specifically the two "state" lines disagreeing with each other.

**Fix:** Use the existing helper for the state line: `Reconocida{actor} · {madridTime(acknowledged.at)}` (or `madridClock`-style formatting with an explicit `timeZone: "Europe/Madrid"`).

### IN-02: The `incident:<id>:open` key is spelled in three modules

**File:** `src/lib/incident-why.ts:81` (also `src/lib/incident-store.ts:152-154`, `src/lib/notification-dispatch.ts:153-155`)

**Issue:** `openKey`/`editKey` exist as private helpers in `incident-store.ts` and `notification-dispatch.ts`, and `incident-why.ts` builds the same opening key inline. That string is load-bearing for token binding (`consumeActionToken` requires the pressed message to be the confirmed opening), for `queueEdit`, and for the digest's opening join. A change to the format in one module would not fail any type check; it would silently make buttons report "No se pudo aplicar" and stop all edits, or drop digest episodes. Duplication here is not cosmetic.

**Fix:** Export one key factory from a single module (e.g. `incident-store.ts`) and import it in the dispatcher and the why queue:

```ts
export const incidentOpenKey = (incidentId: number) => `incident:${incidentId}:open`;
export const incidentEditKey = (incidentId: number, seq: number) => `incident:${incidentId}:edit:${seq}`;
```

### IN-03: Edit-glued statements remain in three files

**File:** `src/lib/incident-actions.ts:20`

**Issue:** An import was appended to the end of the previous one (`} from "./incident-snooze";import {`), and the same artifact appears at `src/lib/telegram-updates.ts:100` (`/** The pieces of the update the pure allowlist needs. */export type CallbackUpdate = {`) and at `src/components/dashboard.tsx:416` (the `data` doc comment is glued to the end of `sameHost`'s declaration). None of these changes behaviour, but they defeat formatter/diff readability in the three files a reviewer reads most.

**Fix:** Put the import, the type declaration and the doc comment on their own lines; `pnpm lint` does not flag it, so it needs a manual edit.

---

_Reviewed: 2026-11-26T15:47:38Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
