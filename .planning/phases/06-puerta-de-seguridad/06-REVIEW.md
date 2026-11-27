---
phase: 06-puerta-de-seguridad
reviewed: 2026-11-27T00:00:00Z
depth: standard
files_reviewed: 44
files_reviewed_list:
  - README.md
  - next.config.ts
  - src/app/api/[...path]/route.ts
  - src/app/api/auth/[...all]/route.ts
  - src/app/layout.tsx
  - src/components/command-search.tsx
  - src/components/dashboard.tsx
  - src/components/file-browser.tsx
  - src/components/views/maintenance-extras.tsx
  - src/components/views/maintenance-status.tsx
  - src/components/views/use-host-read.ts
  - src/lib/auth-client.ts
  - src/lib/csp.ts
  - src/lib/deployment-settings.ts
  - src/lib/host-command-client.ts
  - src/lib/host-commands.ts
  - src/lib/lifecycle.ts
  - src/lib/maintenance-polling.ts
  - src/lib/nas.ts
  - src/lib/renovate-merge.ts
  - src/lib/request-body.ts
  - src/lib/sensitive-actions.ts
  - src/lib/verification-api.ts
  - src/proxy.ts
  - tests/agent-client.test.ts
  - tests/api-deployment-settings.test.ts
  - tests/api-deployments.test.ts
  - tests/api-host-commands.test.ts
  - tests/api-hosts.test.ts
  - tests/api-incidents.test.ts
  - tests/api-lifecycle.test.ts
  - tests/api-logs.test.ts
  - tests/auth-body-limit.test.ts
  - tests/collector-alerts.test.ts
  - tests/e2e/csp.spec.ts
  - tests/e2e/files-apps.spec.ts
  - tests/e2e/hosts.spec.ts
  - tests/e2e/maintenance-workflows.spec.ts
  - tests/maintenance-polling.test.ts
  - tests/request-body.test.ts
  - tests/security-headers.test.ts
  - tests/security-review.test.ts
  - tests/sensitive-actions.test.ts
  - tests/verified-session.ts
findings:
  critical: 1
  warning: 4
  info: 4
  total: 9
  necessity: 0
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-11-27
**Depth:** standard
**Files Reviewed:** 44
**Status:** issues_found

## Summary

Reviewed the Phase 06 changes: the route manifest and fail-closed dispatch in the catch-all, the recent-verification guard on actions, host commands, removal, deployment settings and Renovate merge, the bounded request and response readers, the Better Auth body wrapper, the nonce CSP and HSTS, the client sensitive-action wiring, and the tests. Framework claims (nonce flow, `proxy.ts`, `force-dynamic` in the layout) were checked against `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`.

The mechanical parts are sound: every manifest route has a handler and vice versa, the manifest is consulted before any handler runs, `BodyTooLarge` is the first branch of the catch and is always awaited inside the `try`, the streaming byte counters decode once over the whole buffer, and no caller of `nasForHost` can reach a protected agent verb without a guard. No necessity findings (`necessity: 0`); `necessity-review.md` was read.

The serious problem is in what the gate trusts: the verification factor (passkey vs password) is chosen from a client-supplied `Origin` header, which lets anyone holding the password skip the passkey requirement on the public domain when an alternative origin is configured. The `verification.ts` source is outside the changed-file list but is on the call path of the reviewed `verification-api.ts`.

## Critical Issues

### CR-01: Passkey gate can be downgraded to the password factor by forging the `Origin` header

**File:** `src/lib/verification-api.ts:51,105` (decision made in `src/lib/verification.ts:85-142`)
**Issue:** `handlePasswordVerification` and `guardSensitiveAction` both call `verificationMethodForRequest(request)`, which resolves to `requestOrigin(request)`. That function returns the request's `Origin` header first and only falls back to `Host` / `X-Forwarded-Host` when it is absent. `verificationMethodForOrigin` then answers `"password"` for any hostname other than `BETTER_AUTH_URL`'s. The method is therefore an attacker-controlled input, not a property of the network entry actually used.

README line 140 documents that the alternative (Tailscale) origin is added to `TRUSTED_ORIGINS`, which is also what `route.ts:155` checks for every mutation. With that configured, an attacker who knows only the account password (exactly the scenario a passkey gate exists to contain) can do the following against the public domain:

1. `POST /api/auth/sign-in/email` to obtain a session (password sign-in is enabled).
2. `POST /api/verification/password` with `Origin: https://<alt-origin>`. The origin check passes, the method resolves to `"password"`, `auth.api.verifyPassword` succeeds, and a `method: "password"` record is stored.
3. `POST /api/action` (reboot, purge, empty-trash), `/api/host-command`, `/api/containers/remove`, `/api/renovate/merge` or `/api/deployments/settings` with the same forged `Origin`. `requireRecentVerification` compares `record.method === "password"` and passes.

The passkey never enters the flow, so SEC-01's property ("password alone is not enough for destructive actions") does not hold whenever an alternative origin is trusted. Browsers set `Origin` honestly, which is why the e2e and unit tests do not catch it; a script does not.

**Fix:** Decide the method from something the client cannot choose, and pin it per session. For example, derive it from the proxy-set `Host` (NPM and Tailscale Serve overwrite it) and ignore `Origin` for this purpose:

```ts
// verification.ts
export function verificationMethodForRequest(request: Request) {
  const host = (request.headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  const primary = primaryOrigin();
  if (!host || !primary) return "passkey";
  return host === new URL(primary).host.toLowerCase() ? "passkey" : "password";
}
```

Also require the `Origin` host to equal the connection host before honouring a `password` method (a mismatch should fall back to `"passkey"`), and consider recording the sign-in host on the session so a session created on the primary domain can never be verified by password.

## Warnings

### WR-01: `/api/verification/password` has no attempt limit and the assumption that Better Auth covers it was never tested

**File:** `src/lib/verification-api.ts:73-84` (called from `src/app/api/[...path]/route.ts:218-226`)
**Issue:** The route calls `auth.api.verifyPassword` directly, not through Better Auth's HTTP handler, so the in-memory limiter enabled in `src/lib/auth.ts:68` is expected not to apply. `06-RESEARCH.md` (Pitfall 9) marks this `[ASSUMED]`, and `06-05-PLAN.md` leaves it out of scope as backlog. No test exercises repeated wrong passwords. A holder of a session cookie (stolen cookie, or the CR-01 path) can guess the password at network speed, and each success mints a 5-minute authorization for every protected action. Combined with CR-01 this is the weak link of the gate.
**Fix:** Add a per-session and per-user counter before `verifyPassword`, for example a small table or an in-memory `Map<sessionId, {count, resetAt}>` returning 429 after 5 failures in 10 minutes, and add a test that the sixth attempt is refused without calling `verifyPassword`.

### WR-02: An over-cap `/metrics` answer silently blinds monitoring and alerting for the host

**File:** `src/lib/nas.ts:27-41`, `src/lib/collector.ts:385-389`
**Issue:** `AGENT_RESPONSE_LIMITS.metrics = 2 MiB` is documented as an unmeasured guess (A1). When the agent exceeds it, `nasEffectForHost` fails with `NasInvalidResponse`, and `collectHost` handles that as a contract failure: it returns without writing a sample, opening a `connection` incident, notifying, or logging anything. The host then goes stale (75 s) in the UI, every threshold and container alert stops evaluating, and nothing tells the operator why. The README states this behaviour as intended, but a guessed number on the monitoring-critical path with a silent failure mode is the worst combination: a container count or label growth turns monitoring off without a trace. The same applies to the 1 MiB `maintenance` cap used by `collectSnapshotAlerts` (`Promise.allSettled` discards the rejection).
**Fix:** At minimum log the cap breach in the collector (`console.error("Agent response over its cap", host.id, limit)`, same content-free format as `route.ts:914`) so it is visible in the logs. Better, open a distinct `contract` incident for the host after N consecutive breaches. Raise the metrics cap or measure it first.

### WR-03: Idempotency replay is inconsistent across the protected routes and does not compare the action

**File:** `src/app/api/[...path]/route.ts:621-632`, `src/lib/lifecycle.ts:199-211`, `src/lib/deployment-settings.ts:111-123`, `src/lib/host-commands.ts:115-132,244-247`, `src/lib/renovate-merge.ts:150-198`
**Issue:** Two problems with the same root.

1. Ordering differs per route. `/api/action`, `containers/remove` and `deployments/settings` replay a stored operation before the verification guard (the test at `tests/sensitive-actions.test.ts:556` asserts this). `host-command` guards first and replays inside `executeHostCommand`, so the same retry after the 5-minute window gets 403 there and a stored result elsewhere. `renovate/merge` guards before even resolving the host and validating the key, contradicting the "validated first, so a bad request never looks like a verification failure" comment in `host-commands.ts:223-226`. `mergeRenovatePullRequest` also has no `store`/`now` parameters, unlike its siblings, so it cannot be tested with the same seam.
2. Only `renovate-merge.ts:171` checks `existing.action`. In the others a reused key returns the earlier operation as a success. The dialog reuses keys on purpose (`idempotencyKey` in `SensitiveActionRequest`), so a caller reusing a key for a different action would see "Operación completada" while nothing ran.

**Fix:** Pick one order (validate host and key, replay, then guard) and apply it in all five handlers; add the `existing.action !== expected` check to each replay and return 409. Give `mergeRenovatePullRequest` the same `store`/`now` injection.

### WR-04: Negative e2e assertions run before the thing they guard against can happen

**File:** `tests/e2e/maintenance-workflows.spec.ts:193-195,210`
**Issue:** After `page.keyboard.press("b")` the test immediately does `expect(calls).toBe(0)`, and again at line 210 after the dialog opens. A request that is dispatched asynchronously (the shortcut handler goes through `runRef`, then `sensitive.request`, then a fetch) would arrive after the assertion, so the test stays green even if the shortcut fires. The test name also promises "shortcuts ignore inputs", which this does not reliably prove. The `host-command` route is fulfilled with success, so a regression would not even surface as a visible dialog.
**Fix:** Wait on something observable before asserting the absence, for example `await expect.poll(() => calls, { timeout: 1000 }).toBe(0)` after a short settled state, or assert the positive control first (press `b` outside the input and wait for the sensitive dialog), then assert the in-input press produced nothing.

## Info

### IN-01: Documents under dotted paths get no CSP at all

**File:** `src/proxy.ts:29`
**Issue:** The matcher `/((?!api|_next/static|_next/image|.*\\..*).*)` skips every path containing a dot, not only asset files. A document request such as `/foo.php` renders the 404 page with no `Content-Security-Policy` header, because `next.config.ts` only sets a CSP for `/api/:path*`. The 404 page carries no user-controlled content today, so there is no exploit, but the "documents always get the policy" invariant in the README and the proxy doc comment is false for these paths, and `csp.spec.ts:139` only tests a dotless unknown route.
**Fix:** Either narrow the exclusion to real asset extensions (`.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|css|map|json|webmanifest|txt)$`) or add a document-level fallback policy, and extend the 404 e2e with a dotted path.

### IN-02: Keyboard shortcuts bypass the host-role filter the buttons apply

**File:** `src/components/command-search.tsx:11-16,98-102,107-112`
**Issue:** The command list hides `backup-now` and `reconnect-apps` for non-instance hosts (lines 107-112, same in `maintenance-extras.tsx:140-145`), but the `b` and `w` shortcuts call `runRef.current(command)` without that check. On a non-instance host, pressing `b` opens a passkey dialog for a command the card hides, and a successful verification sends it to the agent.
**Fix:** Share one `commandsForHost(host)` helper and have the keydown handler return early when the mapped command is not offered for `scope.host?.role`.

### IN-03: A malformed JSON body ends as a 503 with a logged "API error"

**File:** `src/lib/request-body.ts:82-87`, `src/app/api/[...path]/route.ts:947-954`
**Issue:** `readJsonBody` lets `JSON.parse` throw a `SyntaxError`, which no catch branch maps (only `ZodError` is a 400), so any authenticated request with a broken body answers 503 "Comprueba la conexión". The sensitive-action dialog treats 503 as "nothing was sent" and the log line is `API error SyntaxError`. The password route already maps it to 400 explicitly (`verification-api.ts:67-71`), which shows the inconsistency. The comment "exactly as `request.json()` did" documents it as pre-existing.
**Fix:** Throw a typed `InvalidJson` from `readJsonBody` and answer 400 in the catch-all (or convert `SyntaxError` to a `ZodError`-style 400).

### IN-04: `sendHostCommand` is documented for exempt commands but typed for all

**File:** `src/lib/host-command-client.ts:8-11`
**Issue:** The doc says it sends "a host command that needs no verification", yet the parameter is `HostCommand`. Passing a protected command compiles and returns 403 at runtime. The two callers branch on `requiresVerificationForCommand` correctly today, but nothing enforces it.
**Fix:** Type the parameter from the manifest, for example `Extract<HostCommand, { [K in HostCommand]: (typeof hostCommandPolicies)[K] extends { kind: "exempt" } ? K : never }[HostCommand]>`, or assert `!requiresVerificationForCommand(command)` at the top.

---

_Reviewed: 2026-11-27_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
