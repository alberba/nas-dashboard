---
phase: 07-acciones-verificadas-desde-telegram
reviewed: 2026-11-27T00:00:00Z
depth: standard
files_reviewed: 39
files_reviewed_list:
  - .env.example
  - README.md
  - drizzle/0008_acciones_telegram.sql
  - drizzle/meta/0008_snapshot.json
  - drizzle/meta/_journal.json
  - src/app/api/[...path]/route.ts
  - src/components/login.tsx
  - src/components/sensitive-action/sensitive-action.tsx
  - src/components/views/alerts.tsx
  - src/components/views/telegram-handoff.tsx
  - src/lib/host-commands.ts
  - src/lib/incident-actions.ts
  - src/lib/incident-store.ts
  - src/lib/notification-dispatch.ts
  - src/lib/operation-runner.ts
  - src/lib/runtime-config.ts
  - src/lib/schema.ts
  - src/lib/sensitive-actions.ts
  - src/lib/telegram-cleanup.ts
  - src/lib/telegram-handoff-client.ts
  - src/lib/telegram-intent-api.ts
  - src/lib/telegram-intents.ts
  - src/lib/telegram-keyboard.ts
  - src/lib/telegram-updates.ts
  - src/lib/telegram.ts
  - src/lib/types.ts
  - src/lib/verification-api.ts
  - src/lib/verification.ts
  - tests/api-lifecycle.test.ts
  - tests/api-telegram-intents.test.ts
  - tests/e2e/telegram-handoff.spec.ts
  - tests/migrations.test.ts
  - tests/runtime-config.test.ts
  - tests/sensitive-actions.test.ts
  - tests/telegram-handoff-client.test.ts
  - tests/telegram-intents.test.ts
  - tests/telegram-keyboard.test.ts
  - tests/telegram-lane-hardening.test.ts
  - tests/verification.test.ts
findings:
  critical: 0
  warning: 5
  info: 2
  total: 7
  necessity: 2
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-11-27
**Depth:** standard
**Files Reviewed:** 39

## Summary

The phase adds the Telegram intent lifecycle (create, claim, finish, cancel, expire), the hub handoff endpoints and UI, and a rewrite of the verification method decision (Host header instead of Origin). The security-critical paths held up under tracing:

- The action comes from the stored intent, not from the request body.
- The recent-verification guard runs before the claim.
- A foreign user's token gets the same 404 as an unknown one.
- The claim is a single conditional `UPDATE`.
- Both new routes sit behind the Origin check, the session check and the route manifest.
- The migration, snapshot and journal are consistent.

No Critical issues found. The defects are in failure-path handling of the execute flow, in how the new keyboard-only outbox rows interact with an existing projection, and in the handoff UI's reaction to a closed-as-failed intent. Two findings are necessity findings.

`ponytail` and the other skills were not needed. `CLAUDE.md` is absent; `AGENTS.md` and `CODING_STANDARD.md` were applied. The new tests do not assert on copy.

## Warnings

### WR-01: A claimed intent is stranded in `executing` if the run or the closing transaction throws

**File:** `src/lib/telegram-intent-api.ts:227-248`
**Issue:** After `claimIntent` succeeds, `run()` and the closing transaction (`finishIntent` plus `queueKeyboardEdit`) are not guarded.

- **Throw in `run()`.** `executeHostCommand` and `runAgentAction` can throw on database errors, for example the initial `select` or `insert`. The exception reaches the catch-all in `route.ts`, which answers 503. The intent stays `executing` with `usedAt` set.
- **Throw in the closing transaction.** The agent already ran, but the caller gets a 503. The row is never finished and no `:done` edit is queued.

Consequences:

- The link can never be used again.
- `inspect` reports the intent as `consumed`, which the UI renders as "ya se había ejecutado" even when nothing ran.
- Nothing reconciles `executing` rows. The cleanup only deletes them a day after expiry.

A related race exists in the `released` branch (`:238-241`). `releaseIntent` flips `executing` back to `pending`. Meanwhile `createIntent` may have inserted a new `pending` row for the same incident, because an `executing` row does not hold the partial unique index. This is reachable when execution outlives the 5-minute window and the `:expire` edit re-renders the menu. The release then raises a unique violation (23505) and the intent is again stuck in `executing`.

**Fix:** Wrap the section after the claim. If it throws, decide from the operation row:

```ts
let closing: Closing;
try {
  closing = await run();
} catch (error) {
  // No operation row means nothing reached the agent: give the link back.
  if (!(await operationOf(intent))) {
    await releaseIntent(db, intent.id).catch(() => undefined);
  } else {
    await db.transaction(async (tx) => {
      await finishIntent(tx, intent.id, "uncertain", clock());
      await queueKeyboardEdit(tx, intent.incidentId, `i${intent.id}:done`);
    });
  }
  throw error;
}
```

Make `releaseIntent` tolerate a unique violation, either by expiring the intent instead or by catching `23505`. Add a reconciler for `executing` rows older than the agent timeout, which close as `uncertain`.

### WR-02: Keyboard-only edit rows pollute the Avisos "last update" projection

**File:** `src/lib/incident-store.ts:1026-1029` (consumer), `src/lib/incident-store.ts:228-243` (producer)
**Issue:** `queueKeyboardEdit` inserts `kind: "incident-edit"` rows with `revision = incident.seq`. `projectRow` builds `latestEdit` from every `incident-edit` job of the incident, sorted by `revision desc, id desc`. A keyboard row therefore ties with the real state edit on `revision` and wins on the larger `id`.

Effects:

- Every intent creates an `:expire` row that stays `pending` with `nextAttemptAt` five minutes ahead. For those five minutes `lastUpdate` shows "En cola".
- It also covers the menu `:open`, `:done`, `m…` rows and the keyboard edit that restores the buttons.
- A permanently rejected keyboard edit reports the episode's last update as failed, although the state edit was delivered.

No filtering by key was added to the projection (`grep ":kb:"` finds it only in tests).

**Fix:** Exclude the keyboard rows from the projection, or from `latestEdit`:

```ts
const edits = jobs
  .filter((job) => job.kind === "incident-edit" && !job.key.includes(":kb:"))
  .sort((a, b) => b.revision - a.revision || b.id - a.id);
```

Add a test that creates an intent and asserts `lastUpdate` is unchanged.

### WR-03: A failed run offers "Reintentar", which then claims the action "ya se había ejecutado"

**File:** `src/components/views/telegram-handoff.tsx:56-67, 140-142, 294-309` with `src/lib/telegram-intent-api.ts:314-321`
**Issue:** When the agent rejects the action (HTTP 400, `status: "failed"`), the server closes the intent as `failed` and it is no longer usable. The UI takes the `failed` branch in `settled`, shows the agent's error and a "Reintentar" button. That button calls `inspect`, which now returns `state: "consumed"`. The panel then says "Esta acción ya se había ejecutado y no se repetirá." That is false for a rejected action, and the retry offered can never work.

The retry is only valid for failures that leave the intent alive: 503, `container_gone` 409 and a verification 403.

**Fix:** Branch on the server outcome rather than the generic `failed`:

- In `settled`, when `outcome.data.status === "failed"` and the response carries an `operation`, end in a distinct terminal state, for example `rejected`, with no retry button and a message such as "El host rechazó la acción".
- In `inspect`, when `state === "consumed"` and `operation.status === "failed"`, show that same state instead of the "ya se ejecutó" copy.
- Alternatively, make `Closing.response` for `failed` carry a code the UI can recognise.

### WR-04: Losing the claim race can answer "expired" for a link that is still alive

**File:** `src/lib/telegram-intent-api.ts:227-235`
**Issue:** When `claimIntent` returns null, the code reloads the intent. If it is `ready`, it fabricates `{ ...fresh, status: "expired" }` and answers 410 `intent_expired`. A reload that finds the intent `ready` is reachable. For example, A claims, the agent is unavailable, and A calls `releaseIntent`, which sets the intent back to `pending`. B's claim ran in that window and found `executing`. B then reloads, sees `pending` and is told the link expired.

The UI treats `intent_expired` as terminal. It clears the token from `sessionStorage` and tells the operator to go back to Telegram, although the link works.

The comment says "or the intent lapsed in between", but `loadIntent` already marks a lapsed pending row `expired` in the same call, so that case does not need the override.

**Fix:** Do not rewrite the status. If the reloaded intent is still `ready`, answer a retryable conflict:

```ts
const fresh = await loadIntent(token, session.user.id, clock());
if (!fresh) return unknownIntent();
if (stateOf(fresh) === "ready")
  return json(
    { error: "La acción está en curso. Inténtalo de nuevo.", code: "intent_busy" },
    409,
  );
return settledResponse(fresh);
```

### WR-05: `operations.requestedBy` always equals `operations.userId` (necessity: generality without instantiation)

**File:** `src/lib/schema.ts:458-459`, `src/lib/host-commands.ts:113-114, 166`, `src/lib/operation-runner.ts:51-52, 69-84`
**Category:** necessity
**Issue:** The new column is meant to hold "the hub user accountable for the operation, never a Telegram id". Every caller passes the same value for both columns:

- `route.ts:645-649` passes `current.user.id` for both.
- `telegram-intent-api.ts:262-268` and `:287-293` pass `intent.userId` for both.
- `executeHostCommand` defaults `requestedBy = userId`.

An operation's requester and its owner therefore cannot differ anywhere in the repository. The extra column, parameter and `Operation.requestedBy` type field carry no information beyond `userId`. The value also reaches the browser through `publicOperation` and `/api/overview`, although the UI only reads `channel`.

**Fix:** Drop `requestedBy` from the signature, the insert, the schema and the type, and keep `channel`. If a distinct requester is expected later, add it then. Otherwise record the invariant in a comment on `userId`.

## Info

### IN-01: `TELEGRAM_DIRECT_ACTIONS` is a variable that exists only to be rejected (necessity: phantom requirement)

**File:** `src/lib/runtime-config.ts:324-336, 455`
**Category:** necessity
**Issue:** The variable is never read anywhere. It rejects any value other than empty or `0` at startup, to stop someone enabling a capability that has no code behind it. Nothing in the repository implements direct execution from the chat, and `telegram-updates.ts` only registers intents. The guard defends against a feature that does not exist.

It also adds a startup failure mode: an operator who sets `TELEGRAM_DIRECT_ACTIONS=true` by analogy with `PUSH_WARNINGS` gets a hard stop for a variable nobody documented as supported. This rests on judgment, because the guard is a deliberate decision recorded as D-00a.

**Fix:** Remove the variable and the two documentation passages, or keep it deliberately and say so in the decision log. Mark it for removal when direct execution is formally ruled out.

### IN-02: Duplicated response helpers and a duplicated sample query

**File:** `src/lib/host-commands.ts:143-148`, `src/lib/telegram-intent-api.ts:41-57`, `src/lib/verification-api.ts:16-18, 139-143`
**Issue:**
- `executeHostCommand` re-implements the "newest sample" query that `loadLatestSample` in `operation-runner.ts` now exposes.
- The `noStore` / `json` helper exists in three modules.
- The uniform "intent unknown" 404 body is written twice: in `unknownIntent` and in `guardIntentAction`. A change to the copy or the code in one place silently breaks the uniform-answer property.

**Fix:** Reuse `loadLatestSample` in `executeHostCommand`. Export one `intentUnknownResponse()` and use it in both places.

---

_Reviewed: 2026-11-27_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
