---
last_mapped_commit: d44d511383881a695bfebf39a4752719e3588909
last_mapped_at: 2026-11-24
---
<!-- refreshed: 2026-11-24 -->
# Codebase Concerns

**Analysis Date:** 2026-11-24

## At a Glance

- **High:** the NAS/apps agents mount the Docker socket read-write and create privileged `nsenter` helpers; agent code execution is host-root equivalent.
- **High:** the example env files contain non-empty placeholder credentials that satisfy the current length checks, so copying them verbatim creates a known admin token and known agent token.
- **High:** recent passkey/password verification is enforced server-side only for reboot, container removal, retained-release settings and Renovate merges. Updates, image cleanup, Wiring reconnect and permanent trash purge are session-only on the server even though the UI asks for verification.
- **High:** 5-second sampling keeps full metrics JSON for 30 days and `/api/overview` re-aggregates the raw rows on every poll; this is the main database and query load path.
- **Medium:** agent helper-container churn, a global agent request lock around `/metrics`, `/files` and `/logs`, deployment snapshot cache thrashing and GitHub N+1 polling.
- **Medium:** stale `expectedContainers`, unvalidated persisted settings, malformed state JSON being reported as "no data", and destructive trash cleanup that stops after one bad record.
- **Low:** full-tree lint picks up untracked agent-tooling directories, Dockerfile test-copy drift, origin-list whitespace and a few alert/clock edge cases.

Commands run while mapping: `pnpm typecheck` (pass), `pnpm test` (167 passed, 108 skipped because no local database), `pnpm lint` (fails only on untracked `.opencode`/`.claude`/`.codex` tooling, project sources lint clean), and `python3 -m unittest discover -s agent -p 'test_*.py'` (182 passed, 2 skipped on macOS `renameat2`).

## Tech Debt

**TypeScript 7 compiled by a TypeScript 6 ESLint adapter:**
- **Severity:** medium
- Issue: the application is on `typescript@^7.0.2`, but ESLint is still fed the JavaScript compiler API through the `typescript-api` alias and a module-resolution hook.
- Files: `package.json`, `scripts/eslint-typescript-api.mjs`, `README.md`
- Impact: the lint path is a custom loader, not a supported typescript-eslint configuration. A TypeScript, ESLint or `typescript-api` upgrade can break `pnpm lint` independently of application code; the hook also makes lint behavior differ from the editor.
- Fix approach: track typescript-eslint's TypeScript 7 support and remove the alias/hook as soon as it lands. Add a CI assertion that the loader resolves exactly one compiler instance.

**Agent image contains test modules but not all of them:**
- **Severity:** low
- Issue: `agent/Dockerfile` explicitly copies test modules into the runtime image, yet omits `agent/test_lifecycle.py` and `agent/test_containers.py`.
- Files: `agent/Dockerfile`, `agent/test_lifecycle.py`, `agent/test_containers.py`
- Impact: the image carries unused test code (larger attack surface and image) while anyone running the suite inside the image gets incomplete coverage. It is easy to read the copy list as "all tests" when it is not.
- Fix approach: do not copy `test_*.py` into the production image. If an in-image test target is wanted, copy all tests in a separate `test` stage and document the command.

**No boot-time configuration validation in the hub:**
- **Severity:** medium
- Issue: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SETUP_TOKEN` and `VAPID_*` are consumed lazily; only `NAS_HOSTS`/agent URL validation and `SETUP_TOKEN` length at request time exist.
- Files: `src/lib/auth.ts`, `src/lib/db.ts`, `src/app/api/[...path]/route.ts`, `compose.yaml`
- Impact: a missing or placeholder auth secret can start the container successfully and fail later as invalid sessions, broken passkeys or a setup endpoint that can never succeed. The worker can start with an undefined `DATABASE_URL` and fail every collection cycle with a generic message.
- Fix approach: validate required server configuration in one startup module (or in `instrumentation`), reject known example placeholders, and fail the container before it reports healthy.

## Known Bugs

**`expectedContainers` becomes permanently stale after a rename or Compose service change:**
- **Severity:** medium
- Issue: the expected list is captured once on the first valid sample and is only mutated by the hub's start/stop/restart/remove paths. It is never refreshed from the current inventory and is not editable from Settings.
- Files: `src/lib/collector.ts`, `src/app/api/[...path]/route.ts`, `src/lib/lifecycle.ts`, `src/lib/settings.ts`, `src/lib/validation.ts`
- Impact: renaming a Compose service or deleting/recreating a container outside the hub leaves the old name in `expectedContainers`. `condition()` then raises `container:<old-name>` forever, with no UI to remove it; the row stays open and the alert remains in the sidebar. A container that legitimately moves to another host has the same problem.
- Fix approach: derive expectations from a declared inventory or refresh them when the container set changes, and expose an explicit "expected services" editor. At minimum, prune names that have been absent for a grace period and surface the change in the UI.

**Malformed persisted settings can stop alert evaluation for a host:**
- **Severity:** medium
- Issue: `getSettings()` returns the raw `configuration.value` JSONB cast to `Settings`; `collectHost()` then iterates `settings.expectedContainers` and compares numeric thresholds without validating the shape.
- Files: `src/lib/settings.ts`, `src/lib/collector.ts`
- Impact: if `expectedContainers` is missing or not an array (manual DB edit, partial restore, future schema change), the `for...of` throws after the sample insert. `collectAll` catches and logs only the host id, so samples continue but CPU/memory/disk/container alerts silently stop.
- Fix approach: parse stored settings with a schema that supplies defaults (`settingsSchema` plus list/initialized fields) before use; if parsing fails, log a structured error and fall back to defaults rather than aborting the host.

**Malformed state JSON is treated as "no data" and can resolve a real failure alert:**
- **Severity:** medium
- Issue: `_read_json()` in the agent swallows `OSError`/`ValueError` and returns `None`, and `follower_section()` still reports `available: true`. The deployment snapshot does the same for history entries. None of these paths add a section to `degraded`.
- Files: `agent/maintenance.py`, `agent/deployments.py`, `src/lib/maintenance-alerts.ts`
- Impact: a corrupt `failed-release.json` produces `follower.failed = null`; with no readable history, `deploymentAlertSignals()` emits `deploy-failed` with `failing: false`, which resolves an alert that is still real. Corrupt installed/pending files similarly appear as "Sin datos" rather than degraded. This contradicts the documented rule that an unreadable snapshot must leave existing alerts untouched.
- Fix approach: distinguish "file absent" from "file invalid" in `_read_json`, add the section name to `degraded`, and make the alert signal absent (not false) whenever its source section is degraded.

**One corrupt trash record stalls cleanup and `empty-trash`:**
- **Severity:** medium
- Issue: `cleanup_loop()` wraps the whole `for record in trash_records()` loop in a single `try/except`; `trash_action()` trusts `record.json` and calls `json.loads`/`renameat2` without a per-record guard. `empty-trash` has the same all-or-nothing loop.
- Files: `agent/server.py`, `agent/test_files.py`
- Impact: a truncated or hand-edited `record.json` makes cleanup raise on every hourly run, so later expired items are never removed. An `empty-trash` request also aborts partway, leaving a partially emptied trash and a 502/503 response even though some items were purged.
- Fix approach: catch per record, log the trash id (never the path contents), and continue; skip invalid records and optionally quarantine them. Return per-item counts from `empty-trash` so a partial result is observable.

**`.env` rewrites can change ownership without warning:**
- **Severity:** medium
- Issue: `_write_temp()` preserves mode with `fchmod` and attempts `fchown` to the original uid/gid, but swallows any `OSError`. The agent container runs as root; if user namespaces or a restricted mount block the chown, the replacement stays root-owned.
- Files: `agent/env_settings.py`
- Impact: media-stack services that run as a non-root host user can lose read access to the `.env` after a settings save. The write otherwise looks successful, and the next deploy fails with an unrelated configuration error. The saved backup is also always created as mode `0600`, independently of the original ownership.
- Fix approach: treat failure to preserve uid/gid as a hard error before `os.replace`, or run the agent with the host `.env` owner's uid/gid. Add a test for a chown failure path that asserts the original file is untouched.

**Full-tree lint fails in this GSD checkout because agent-tooling directories are not ignored:**
- **Severity:** low
- Issue: `pnpm lint` invokes ESLint over the repository; `.opencode/`, `.claude/` and `.codex/` are untracked agent-tooling trees containing CommonJS scripts. ESLint reports 5,570 errors and 988 warnings there (mostly `@typescript-eslint/no-require-imports`), so the documented command exits 1.
- Files: `eslint.config.mjs`, `package.json`
- Impact: local `pnpm lint` is unusable in exactly the GSD working copy described in this map. CI is unaffected because those directories are not tracked/checked out, which makes the failure easy to misdiagnose as a code problem.
- Fix approach: add `.agents/**`, `.claude/**`, `.codex/**`, `.opencode/**` and `.planning/**` to `globalIgnores`; keep `.next`, `out` and `build` as they are. Project sources already lint clean.

## Security Considerations

**Docker socket plus privileged host-PID helper containers:**
- **Risk:** the agent can create containers with `Privileged: true` and `PidMode: host`, then run `nsenter` into the host namespaces. It can also create/delete containers and start a host reboot helper. A bug or auth bypass in the agent is therefore equivalent to root on the NAS or apps server.
- Files: `agent/compose.yaml`, `agent/compose.apps.yaml`, `agent/Dockerfile`, `agent/maintenance.py`, `agent/server.py`, `agent/updates.py`
- Current mitigation: `AGENT_TOKEN` (≥32 chars), per-request `hmac.compare_digest`, source-IP allowlist (`ALLOWED_IPS`), `read_only` root filesystem, `no-new-privileges`, token-to-host binding, and fixed command/argv construction. The agent container has no `USER`, so the process itself is root inside the container and can use the socket.
- Recommendations: put a filtering Docker socket proxy in front of the agent and allow only the API methods it needs; add `cap_drop: [ALL]` and a non-root user; consider a separate short-lived helper image/daemon for host commands. Document explicitly that agent compromise is host compromise. This is a deliberate architectural trade-off, not an accidental one, but it remains the largest blast radius in the repository.
- Severity: high

**Placeholder credentials in the committed examples pass the runtime checks:**
- **Risk:** `.env.example`, `agent/.env.example` and `agent/.env.apps.example` ship non-empty `BETTER_AUTH_SECRET`, `SETUP_TOKEN` and `AGENT_TOKEN` placeholders (54 characters each, containing replacement/example wording). `agent/server.py` only checks `len(TOKEN) >= 32`; `/api/setup` only checks the token length and `timingSafeEqual`. Copying an example file to the real path therefore produces a publicly known auth secret, setup token and agent token.
- Files: `.env.example`, `agent/.env.example`, `agent/.env.apps.example`, `agent/server.py`, `src/lib/auth.ts`, `src/app/api/[...path]/route.ts`, `scripts/configure.mjs`
- Current mitigation: `scripts/configure.mjs` generates random 32-byte hex values and README tells operators to use it; the examples are clearly marked.
- Recommendations: reject known placeholder substrings at startup, require secrets to be generated (no default), and add a `configure` check that refuses to start with example values. Rotating an exposed token should be a documented one-command operation.
- Severity: high

**Recent verification is UI-only for several destructive endpoints:**
- **Risk:** `/api/host-command` calls `runHostCommand()` without `guardSensitiveAction()`. `/api/action` calls the guard only for `reboot`; `update-container`, `purge`, `empty-trash` and `move` are not gated. The dialogs in `src/components/command-search.tsx`, `src/components/views/update-container.tsx` and `src/components/sensitive-action/sensitive-action.tsx` do ask for a passkey, so the server and the UI disagree about what is authoritative.
- Files: `src/app/api/[...path]/route.ts`, `src/lib/host-commands.ts`, `src/components/command-search.tsx`, `src/components/views/update-container.tsx`, `src/components/sensitive-action/sensitive-action.tsx`
- Impact: a stolen session cookie (for example through an XSS or a shared browser) can delete all trash, purge an item permanently, clean Docker images or recreate a service without the five-minute recent-verification step. The passkey dialog provides no server-side protection for these routes.
- Recommendations: centralize the protected-action list in the route (or in a wrapper) and call `guardSensitiveAction` for every destructive action, including `clean-images`, `reconnect-apps`, `update-container`, `purge` and `empty-trash`. Keep the UI prompt as an explanation, never as the only control.
- Severity: high

**Permanent trash purge has no typed confirmation:**
- **Risk:** `purge` is irreversible, but the generic file dialog only shows "No se podrá recuperar" and accepts one click. `empty-trash` does require the phrase `VACIAR PAPELERA`, but a single-item purge does not. The server accepts `purge` with a session and origin check only.
- Files: `src/components/file-browser.tsx`, `src/components/dashboard.tsx`, `src/lib/validation.ts`
- Current mitigation: the item still has to be in `.hub-trash`, and the action is scoped to a configured root.
- Recommendations: require the item name (or a destructive confirmation) for `purge`, and pair it with the recent-verification rule above. This is a design consistency issue more than an exploit primitive.
- Severity: medium

**No Content-Security-Policy or HSTS from the app:**
- **Risk:** the response headers cover `nosniff`, frame denial, referrer and permissions, but not CSP or `Strict-Transport-Security`. This is an admin dashboard that can remove containers, edit `.env` settings and merge PRs; an injected script would have the session and the same-origin API.
- Files: `next.config.ts`, `README.md`
- Current mitigation: React escaping, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, reverse-proxy TLS.
- Recommendations: add a conservative CSP (self, inline styles/scripts only where Next requires it, `connect-src 'self'`), add HSTS at the reverse proxy, and document the policy in the deployment guide.
- Severity: medium

**The agent URL is allowed to be plain HTTP:**
- **Risk:** `NAS_HOSTS[].url` accepts `http:` and `https:`. `scripts/configure.mjs` generates `http://<tailscale-ip>:9450` for the NAS agent and the applications agent. If the address is reachable outside the private network, the bearer token and all command responses travel in clear text.
- Files: `src/lib/hosts.ts`, `scripts/configure.mjs`, `README.md`
- Current mitigation: Tailscale/WireGuard is the documented transport, the agent binds a private address and the app agents share a Docker network.
- Recommendations: enforce `https:` for non-loopback agent URLs, or add an explicit `ALLOW_INSECURE_AGENT_URL` opt-in with a startup warning. At minimum, document that the token is only protected by the private network.
- Severity: medium

**`.env` backups accumulate copies of secrets indefinitely:**
- **Risk:** every settings save creates `.env.backup-<timestamp>-<random>` in the mounted directory with the full previous `.env`, including credentials. The file is mode `0600`, but it is never pruned. The dedicated directory is mounted read-write into the agent.
- Files: `agent/env_settings.py`, `agent/compose.yaml`, `agent/MAINTENANCE.md`
- Impact: long-lived deployments accumulate unbounded secret copies; a backup restore or disk inspection exposes old tokens. Disk growth is small per save but unbounded over years.
- Recommendations: keep a bounded set (for example the last 20 or 30 days), delete older backups after a successful replacement, and document the retention. Add a test that asserts old backups are removed.
- Severity: medium

**Container protection is name-based:**
- **Risk:** `PROTECTED_CONTAINERS` and the agent defaults protect names (`hub-agent`, `npm`, `tailscale`, etc.). A container recreated under a different `container_name`, or a Compose service rename, loses protection. The hub's update/start/stop checks also use the display name.
- Files: `agent/updates.py`, `agent/lifecycle.py`, `agent/compose.apps.yaml`, `scripts/configure.mjs`
- Current mitigation: the agent re-checks state and one-shot/Compose labels; the protected list is operator-controlled.
- Recommendations: allow protection by Compose project/service label or image prefix as well as name, and surface the effective protected set in the UI.
- Severity: medium

**No request-body size limit at the Next.js boundary:**
- **Risk:** route handlers call `request.json()` on `/api/action`, `/api/settings`, `/api/push`, `/api/setup` and the host/deployment commands before schema validation. A logged-in client can send a large body and force a large allocation; the agent has explicit caps, but the hub does not.
- Files: `src/app/api/[...path]/route.ts`
- Current mitigation: authentication and origin checks; schemas bound the accepted fields after parsing.
- Recommendations: reject bodies above a small per-route limit before parsing, or use a shared JSON body helper.
- Severity: low

## Performance Bottlenecks

**Raw 5-second samples retained for 30 days drive the overview query:**
- **Problem:** while any tab is visible the worker inserts a sample every 5 seconds (17,280/day, about 518k per host over 30 days). Each sample contains the full metrics document: per-core CPU, network interfaces, filesystems, RAID, temperatures and every container. `/api/overview` then runs a `date_bin` aggregation over all raw rows for the selected range, including 30 days, on every 5-second poll.
- Files: `src/worker.ts`, `src/lib/collector.ts`, `src/lib/validation.ts`, `src/app/api/[...path]/route.ts`, `src/components/dashboard.tsx`
- Impact: storage grows into multiple gigabytes per host, autovacuum and index maintenance grow with it, and each open dashboard repeatedly scans hundreds of thousands of JSONB rows. The same query is executed even when the result is nearly identical to the previous poll.
- Improvement path: keep raw samples for hours/days, add hourly and daily rollup tables (or materialized views) for history, and have `/api/overview` read rollups for `7d`/`30d`. Cache the aggregated series per host/range for a few seconds, or use an ETag/If-None-Match flow. Measure with `EXPLAIN (ANALYZE, BUFFERS)` on a production-sized table.
- Severity: high

**Dashboard polling multiplies the same heavy overview request:**
- **Problem:** every visible tab polls `/api/overview?range=...` every 5 seconds; each request performs the history SQL plus latest sample, 100 alerts, 30 operations, settings, host-status queries and an open-alert count. Multiple tabs or devices do not share the work.
- Files: `src/components/dashboard.tsx`, `src/app/api/[...path]/route.ts`, `src/lib/host-status.ts`
- Impact: four tabs on a 30-day range produce roughly 48 overview queries per minute, each scanning the full 30-day sample range. Combined with the sampling volume above, this is the dominant database load.
- Improvement path: server-side short-TTL cache keyed by host/range, conditional requests, and a smaller default payload (the history series does not need the full alert/operation lists on every refresh). Consider a single consolidated overview query.
- Severity: high

**Agent global lock serializes metrics, file listing, logs and actions:**
- **Problem:** `server.py` wraps `/metrics`, `/files`, `/trash`, `/logs` and `/action` in one `threading.RLock`. `metrics()` performs one Docker stats request per running container through a 6-worker pool, so a large container set can hold the lock for seconds. `files()` returns a whole directory under the same lock; `container_logs()` reads up to 64 MiB.
- Files: `agent/server.py`, `agent/logs.py`
- Impact: a slow or large `/metrics` or `/files` request blocks file browsing, log tailing and administrative actions for every other caller, despite the `ThreadingHTTPServer`. On a busy NAS the UI can appear hung.
- Improvement path: take the lock only around state that truly needs serialization (container cache mutation and actions), move read-only metrics/file/log work outside it as `/maintenance` already does, and cache the Docker stats list for longer than 10 seconds.
- Severity: medium

**Every maintenance snapshot creates several privileged helper containers:**
- **Problem:** one snapshot starts readers for units, failed units, reboot, Docker usage, containers, SMART and the state files. `HostReader` creates a helper per `units_for`, `failed_units` and `reboot`; `SmartMonitor` creates one container for `smartctl --scan-open` plus one per disk; `JournalReader` creates another. Helpers use `AutoRemove: false` and deletion failures are swallowed.
- Files: `agent/maintenance.py`, `agent/deployments.py`, `agent/smart.py`, `agent/MAINTENANCE.md`
- Impact: with five disks, a single snapshot creates about nine privileged containers. The maintenance cache is 60 seconds and the UI polls at 60 seconds, so a cache miss can occur on nearly every poll. Over a day this is thousands of container create/start/wait/delete cycles, plus leaked containers whenever cleanup fails. There is no orphan sweep.
- Improvement path: increase the maintenance TTL above the UI interval, read multiple systemd properties in one helper (already done for units), batch SMART reads where the fixed-argv rule allows it, add an orphan-helper reaper, and emit a metric for helper failures. Consider a single long-lived read-only helper with a fixed command protocol.
- Severity: medium

**`/files` returns an unbounded directory listing:**
- **Problem:** `server.py` lists every entry with `os.listdir(fd)` and serializes all of them; the UI only slices the first 100 client-side. The call runs under the global lock.
- Files: `agent/server.py`, `src/components/file-browser.tsx`
- Impact: a directory with tens of thousands of files produces a large JSON response, holds the lock and allocates the full list. The browser then throws most of it away. It is a realistic NAS failure mode with download folders.
- Improvement path: add server-side pagination/limit (with a stable cursor), return counts separately, and enforce a maximum response size. The UI already has a "show more" pattern that can drive pagination.
- Severity: medium

**Log reads can allocate 64 MiB per request:**
- **Problem:** `docker_logs()` reads up to `logs.MAX_PAYLOAD` (64 MiB) plus one byte into memory, and `logs.decode()` buffers the payload again while splitting streams. `MAX_LINES` is 5,000, but a single line can be very large.
- Files: `agent/logs.py`, `agent/server.py`, `src/components/views/container-logs.tsx`
- Impact: concurrent log requests from an authenticated session can cause multi-hundred-megabyte spikes on the agent, which is also running the maintenance and metrics reads. The cap is high for a dashboard log viewer.
- Improvement path: lower the byte cap, cap individual line length, stream frames instead of reading the whole body, and return a clear "too large, use download" response. The UI only needs a bounded tail.
- Severity: medium

**Deployment snapshot cache thrashes between `lines=1` and `lines=100`:**
- **Problem:** `Deployments.snapshot(lines)` caches one value keyed by `lines`. The collector's alert pass requests `/deployments?lines=1` every minute, while the UI requests the default 100 (or another value). Each switch invalidates the other cache, so Git status/tag reads, retained-release analysis and the journal run again.
- Files: `agent/deployments.py`, `src/lib/collector.ts`, `src/app/api/[...path]/route.ts`
- Impact: the expensive part of the snapshot (Git and retained releases) is recomputed even though only the journal tail differs. On a large media-stack checkout this is repeated Git subprocess work every minute.
- Improvement path: cache the snapshot without the journal (or an internal full journal) and slice the requested tail per request; or keep a small per-`lines` cache with the expensive sections shared.
- Severity: medium

**GitHub polling is N+1 and uncached for open PRs:**
- **Problem:** `fetchRenovatePullRequests()` lists open PRs and then calls two endpoints per candidate (files and check-runs). `deployProgressForHost()` also lists merged PRs, calls files for up to 20 of them, then check-runs and possibly compare calls per merged PR. The client polls `/api/renovate` and `/api/renovate/progress` every 60 seconds per open view.
- Files: `src/lib/github.ts`, `src/lib/deploy-progress.ts`, `src/lib/renovate-polling.ts`, `src/components/views/deployment-details.tsx`
- Impact: with 10 open PRs a single poll is 21 GitHub requests; multiple tabs or the progress view can approach the 5,000/hour fine-grained token limit, and a slow GitHub response delays the whole progress endpoint. Only releases and compare results have short caches; open PR details do not.
- Improvement path: cache the open/merged PR payload for 60 seconds server-side with ETags/conditional requests, fetch files/checks concurrently with a small bounded pool, and avoid loading the progress view until the user opens it. Handle `403` rate-limit responses explicitly and show a degraded state instead of a generic error.
- Severity: medium

**Worker queries presence every second:**
- **Problem:** the collection loop always runs `SELECT ... FROM presence WHERE expiresAt > now()` once per second, even when the next collection is 30 seconds away. That is about 86,400 queries/day per worker for a boolean.
- Files: `src/worker.ts`
- Impact: low but unnecessary database chatter and connection use on a small PostgreSQL instance.
- Improvement path: query presence only when a collection is due, or replace polling with `LISTEN/NOTIFY`/an in-memory heartbeat. A 5-second presence check would be sufficient.
- Severity: low

**`hostStatuses()` makes one query per host:**
- **Problem:** every `/api/hosts` and `/api/overview` call runs a separate latest-sample query for each configured host.
- Files: `src/lib/host-status.ts`, `src/app/api/[...path]/route.ts`
- Impact: at the 20-host maximum this is 20 extra queries per 5-second overview poll. It is small at the current two-host scale but scales linearly.
- Improvement path: one `DISTINCT ON ("hostId") ... ORDER BY "hostId", at DESC` query, or include status in the overview query.
- Severity: low

## Fragile Areas

**The metrics/settings contract is implicit and unversioned:**
- Files: `src/lib/types.ts`, `src/lib/schema.ts`, `src/lib/collector.ts`, `agent/host_metrics.py`
- Why fragile: `samples.data` is JSONB typed only at compile time; the worker accepts any object with a finite timestamp, an array of containers and a non-zero memory total. A future agent that renames or drops a field can pass the initial check and fail later in the collector or UI (for example `metrics.disks.some`, `metrics.temperatures.some`, `metrics.uptime`).
- Safe modification: add a runtime schema for the metrics sample at the worker boundary, version the agent response, and treat incompatible samples as invalid rather than storing them.
- Test coverage: the TS tests use hand-written metrics fixtures; there is no cross-language contract test with the Python serializer.
- Severity: medium

**Deployment retention analysis can drop all retained releases on one Git error:**
- Files: `agent/deployments.py`
- Why fragile: `_retained()` calls `self.git.commit_date(release)` outside a local try. A transient Git error for one candidate bubbles to `_build()`, which catches it as `git` and sets `retained = []`. The UI then shows no retained releases, and `deploymentAlertSignals` may resolve `release-retained`.
- Safe modification: guard per candidate; keep the entries already computed and add `git` to `degraded` rather than discarding the list.
- Test coverage: `agent/test_deployments.py` covers many Git failures but not a failure mid-way through `_retained` after some entries were built.
- Severity: medium

**`env_settings` checks the retained release before taking the file lock:**
- Files: `agent/env_settings.py`
- Why fragile: `save()` calls `_entry(release)` before `_locked()`. A concurrent deploy could move the release out of `retained` between that check and the write; the agent would still append keys to `.env` for a release that is no longer waiting.
- Safe modification: recompute the entry and the missing-name set inside the lock immediately before writing, and abort if the release is no longer retained.
- Test coverage: concurrency tests cover two writers, not a deploy changing the retained set during a save.
- Severity: low

**The `.env` backup is not directory-fsynced:**
- Files: `agent/env_settings.py`
- Why fragile: the temp file and backup file are fsynced, and the directory is fsynced after `os.replace`, but the backup directory entry is not fsynced before replacement. A crash immediately after replacement could leave the new `.env` durable and the backup missing.
- Safe modification: fsync the directory after creating the backup, before replacing `.env`. The backup is the recovery path for a bad settings write.
- Test coverage: no crash/durability test.
- Severity: low

**Trash bookkeeping has crash windows:**
- Files: `agent/server.py`
- Why fragile: `trash_item()` writes `record.json` before renaming data; a crash between the two leaves an orphan box that `trash_records()` ignores forever. Restore moves data with `renameat2` and then `rmtree`s the box; a crash between those leaves a record without data, which is also ignored. The cleanup loop never removes orphan boxes.
- Safe modification: reconcile orphan boxes at startup (age them out after a grace period), and make the record/data pair a single recoverable transaction.
- Test coverage: `agent/test_files.py` covers the happy path and no-replace semantics, not interrupted operations.
- Severity: low

**Alert severity is fixed at creation and disk alerts can stick:**
- Files: `src/lib/collector.ts`, `src/lib/maintenance-alerts.ts`
- Why fragile: `condition()` inserts a row once and never updates `title`, `detail` or `severity` while it remains open. A disk that goes from `watch` to `fail` keeps the original warning severity. If `disks.available` becomes true with an empty device list, no `disk-health` signal is emitted and an existing alert is not resolved.
- Safe modification: update the open row on each evaluation, and emit an explicit `failing: false` for an available-but-empty disk list (or keep the alert open and mark it stale).
- Test coverage: alert transitions are tested, but not severity escalation or an empty device list after a previous alert.
- Severity: low

**Agent helpers can leak and there is no agent healthcheck:**
- Files: `agent/maintenance.py`, `agent/compose.yaml`, `agent/compose.apps.yaml`, `compose.yaml`
- Why fragile: helper deletion failures are swallowed, `AutoRemove` is false, and there is no reaper. Neither agent nor worker declares a healthcheck, so a process that is alive but deadlocked (for example a stuck Docker call) stays "running" and receives no restart.
- Safe modification: reap `hub-agent`/helper containers older than a short TTL, add a lightweight `/health` route (token-protected or loopback-only) and a Compose healthcheck for the agent and worker.
- Test coverage: helper lifecycle tests assert create/delete calls but not cleanup failure or abandoned containers.
- Severity: medium

**Timestamp trust and clock skew:**
- Files: `src/lib/collector.ts`, `src/lib/host-status.ts`, `src/app/api/[...path]/route.ts`
- Why fragile: the worker accepts any finite `metrics.timestamp` and uses it as `samples.at`; the host connection state compares the server clock with the agent clock. A NAS clock jump forward makes a sample look current indefinitely; a jump backward can make a fresh sample look stale. Reboot detection also depends on `timestamp - uptime`.
- Safe modification: clamp timestamps to a plausible window around server time (for example ±5 minutes), store both agent and server receive times, and use the receive time for freshness decisions.
- Test coverage: no clock-skew tests.
- Severity: low

**`move_file` and `trash_action` depend on Linux `renameat2`:**
- Files: `agent/server.py`, `agent/test_files.py`
- Why fragile: `ctypes.CDLL(None).renameat2` is looked up at call time. On a non-Linux agent (or a libc without the symbol) the lookup raises `AttributeError`, which is not caught by the handler's `ValueError`/`OSError` branches; the request dies without a structured error. The tests skip these paths on macOS, so local runs do not exercise them.
- Safe modification: detect the symbol at startup and expose a clear "unsupported platform" failure; keep the Linux/non-Linux test split explicit in CI.
- Test coverage: two tests skip on macOS; CI runs them on Linux.
- Severity: low

## Scaling Limits

**One web replica and one worker are hard assumptions:**
- Current capacity: Compose runs one `app` and one `worker`; the worker is protected by a PostgreSQL advisory lock (`734921`) and the auth rate limiter is in-memory.
- Limit: a second web replica would have a separate rate-limit bucket and a second worker exits at startup while the first holds the lock (restart loop). The README documents this, but Compose exposes no `deploy.replicas` guard.
- Scaling path: if horizontal scaling is ever needed, move rate limiting to PostgreSQL/Redis, add a leader-election loop for the worker, and make the collector safe to run concurrently (or keep the single-writer design explicit).
- Files: `compose.yaml`, `src/worker.ts`, `src/lib/auth.ts`, `README.md`
- Severity: low

**The connection pool is fixed at eight and only memoized outside production:**
- Current capacity: `new Pool({ max: 8 })` per module instance; `globalThis.hubPool` is set only when `NODE_ENV !== "production"`.
- Limit: in production, separate route bundles can each create a pool of eight, multiplying connections; under the 5-second overview polling this can exhaust PostgreSQL's default `max_connections`. In development the global cache hides duplicate pools.
- Scaling path: always memoize on `globalThis` (or use a dedicated server-only singleton), and make `max` configurable. Add a connection-count check to `/api/setup` or a health endpoint.
- Files: `src/lib/db.ts`, `compose.yaml`
- Severity: medium

**The agent uses a thread per request behind a global lock:**
- Current capacity: `ThreadingHTTPServer` has no request cap or queue bound; each request holds a Python thread and, for the locked routes, waits on one `RLock`.
- Limit: a burst of authenticated log/file requests can create many threads and 64 MiB buffers while one slow metrics call blocks them all. There is no backpressure or per-client rate limit.
- Scaling path: put a small reverse proxy in front of the agent with concurrency limits, cap request/response sizes, and separate the read paths from the action lock.
- Files: `agent/server.py`, `agent/logs.py`
- Severity: medium

**The maximum host count is 20 and every host multiplies the work:**
- Current capacity: `NAS_HOSTS` is validated to 1–20 entries.
- Limit: `collectAll` fetches every host in parallel, `hostStatuses` adds one query per host per overview, and the UI's host switcher assumes small counts. At 20 hosts the 5-second overview path does 20 status queries plus the history scan; the agent-side caches are per process, so each agent needs its own capacity.
- Scaling path: batch status queries, cap concurrent agent fetches, and make sample intervals/retention per host configurable.
- Files: `src/lib/hosts.ts`, `src/lib/collector.ts`, `src/lib/host-status.ts`, `src/app/api/[...path]/route.ts`
- Severity: low

## Dependencies at Risk

**Bleeding-edge runtime and framework stack:**
- Risk: Node 26, Next 16.4.6, React 19.3.1, TypeScript 7.0.2, ESLint 10.14.0, Effect 4.1.2, Python 3.14 and PostgreSQL 18 are all recent major/next releases. The TypeScript/ESLint split is already bridged by a custom loader.
- Impact: an upstream breaking change can block lint/build or change runtime behavior with little warning; the custom `typescript-api` alias is the first likely casualty.
- Migration plan: keep the adapter isolated, add a dependency-upgrade CI job that runs typecheck/lint/build, and prefer LTS Node/Python for the production images once the app no longer needs the newer APIs.
- Files: `package.json`, `Dockerfile`, `agent/Dockerfile`, `scripts/eslint-typescript-api.mjs`, `README.md`
- Severity: medium

**Base images and apt packages are unpinned:**
- Risk: `node:26-bookworm-slim`, `python:3.14-slim`, `postgres:18-bookworm`, and `apt-get install` packages (including `smartmontools`, `git`, `systemd`) resolve to whatever is current at build time. `pnpm-lock.yaml` pins JavaScript, but there is no digest or version pin for the OS layer.
- Impact: a rebuild can silently change the agent's `smartctl` output, Git behavior or Python runtime; reproducible builds and rollback are harder.
- Migration plan: pin image digests and apt versions (or use a snapshot/apt pin), and rebuild on a schedule with a dependency update PR. Document the upgrade path for PostgreSQL 18 (the volume is `/var/lib/postgresql`, which is major-version-specific).
- Files: `Dockerfile`, `agent/Dockerfile`, `compose.yaml`, `agent/compose.yaml`
- Severity: medium

**Python dependency set has no hashes or transitive lock:**
- Risk: `agent/requirements.txt` pins only `PyYAML==6.0.3`; pip resolves any future transitive/OS package state, and there are no hashes. The agent image also installs system packages at build time.
- Impact: an agent rebuild is not byte-reproducible, and a compromised index/package can enter the host-management path.
- Migration plan: use a hashed lock (`pip-compile --generate-hashes` or `uv lock`) and install with `--require-hashes`. Keep the runtime image minimal.
- Files: `agent/requirements.txt`, `agent/Dockerfile`, `.github/workflows/ci.yml`
- Severity: medium

**`web-push` and `better-auth` are security-sensitive and upgraded by range:**
- Risk: `web-push` handles VAPID keys and external endpoints; `better-auth` owns sessions/passkeys. Both are declared with caret ranges. A minor update can change cookie/rate-limit/passkey behavior.
- Impact: an unexpected auth or push regression after `pnpm update`; the in-memory rate limiter and passkey hook are tightly coupled to Better Auth internals.
- Migration plan: pin exact versions for auth/push, read release notes before upgrading, and keep the passkey/verification tests in CI (they currently require the mocked auth module for API tests and Playwright for the real flow).
- Files: `package.json`, `src/lib/auth.ts`, `src/lib/push.ts`, `tests/verification.test.ts`, `tests/e2e/sensitive-action.spec.ts`
- Severity: low

## Missing Critical Features

**No history rollups or downsampling:**
- Problem: history is served by aggregating raw samples; there is no hourly/daily retention tier.
- Blocks: keeping 30 days of 5-second data without large storage and query cost; reliable long-range charts on a small PostgreSQL instance.
- Files: `src/app/api/[...path]/route.ts`, `src/worker.ts`, `src/lib/schema.ts`
- Severity: high

**No server-side enforcement of the "sensitive action" policy:**
- Problem: the protected-action list is implicit in the UI and duplicated partially in route handlers; there is no single contract that says which actions need recent verification.
- Blocks: adding a new destructive action safely; auditing that every destructive route is gated.
- Files: `src/app/api/[...path]/route.ts`, `src/lib/verification-api.ts`, `src/lib/host-command-contract.ts`
- Severity: high

**No file-listing pagination or response-size limit:**
- Problem: the agent returns a complete directory and the UI slices it client-side.
- Blocks: reliable browsing of large download folders; bounded agent memory under concurrent requests.
- Files: `agent/server.py`, `src/components/file-browser.tsx`
- Severity: medium

**No agent/worker healthchecks or orphan-helper reaper:**
- Problem: Compose only healthchecks `app` (via `/api/setup`) and `db`; the agent and worker can be alive but stuck, and helper containers can accumulate.
- Blocks: automatic recovery from deadlocks and clean Docker state after failed reads.
- Files: `compose.yaml`, `agent/compose.yaml`, `agent/compose.apps.yaml`, `agent/maintenance.py`
- Severity: medium

**No server configuration validation / secret rotation workflow:**
- Problem: startup accepts missing or example credentials; rotating `AGENT_TOKEN` or `BETTER_AUTH_SECRET` requires manually editing multiple files and restarting both sides.
- Blocks: safe first boot and routine credential rotation.
- Files: `src/lib/auth.ts`, `src/lib/hosts.ts`, `scripts/configure.mjs`, `.env.example`, `agent/.env.example`
- Severity: medium

## Test Coverage Gaps

**108 API tests skip silently without a local database:**
- What's not tested: every `describe.skipIf(!baseUrl)` suite, including host commands, deployment settings, merge/progress, lifecycle removal, events and migrations. Running `pnpm test` in a checkout without `DATABASE_URL` reports success while these high-risk routes are not exercised.
- Files: `tests/database.ts`, `tests/api-*.test.ts`, `tests/migrations.test.ts`
- Risk: a developer can merge a change that breaks host commands or destructive actions and see a green local suite. CI sets `DATABASE_URL`, so the gap is local only, but it is silent.
- **Severity:** medium
- Fix approach: make the absence of a test database a visible skip summary (or a failing prerequisite for the `test` script), and document the exact local database command.

**No cross-language agent/hub contract test:**
- What's not tested: the TypeScript schemas (`MaintenanceSnapshot`, `DeploymentsSnapshot`, `HostCommandResult`) against the actual JSON emitted by `agent/server.py`. TS tests use hand-written fake agents and Python tests use Python fixtures; neither side compiles the other's contract.
- Files: `tests/api-maintenance.test.ts`, `tests/api-deployments.test.ts`, `tests/api-host-commands.test.ts`, `agent/test_maintenance.py`, `agent/test_host_commands.py`
- Risk: a field rename or nullability change on one side passes both test suites and breaks production. The `disks`/`containers` optional sections already show how the contract evolves.
- **Severity:** medium
- Fix approach: add a fixture generated from the Python serializers and validate it with the TypeScript schemas in CI (or run the Python agent against a null/missing-field-heavy fixture).

**`POST /action` HTTP status mapping is not covered end-to-end:**
- What's not tested: the `Handler` branches that turn `ValueError`/`KeyError`/`OSError` into 400/502/503 for `/action`, including malformed `Content-Length`, missing body fields, `root`/`path` `KeyError`, and the reboot helper path. The underlying `execute()` functions are tested directly in `agent/test_lifecycle.py` and `agent/test_files.py`, but the HTTP envelope is not.
- Files: `agent/server.py`, `agent/test_files.py`, `agent/test_lifecycle.py`
- Risk: a routing mistake could return 200 with an error body or leak a traceback for a privileged action.
- **Severity:** medium
- Fix approach: table-driven HTTP tests for each action family and each error class, mirroring the existing `/command` and `/logs` route tests.

**Malformed persisted state and settings are untested:**
- What's not tested: `getSettings()` with a non-array `expectedContainers`, `_read_json()` with truncated JSON, `trash_records()` with a malformed `record.json`, and `_retained()` with a mid-loop Git failure.
- Files: `src/lib/settings.ts`, `src/lib/collector.ts`, `agent/maintenance.py`, `agent/server.py`, `agent/deployments.py`
- Risk: the failure modes described above are silent in production and would be caught by a single fixture each.
- **Severity:** medium
- Fix approach: add focused regression tests for each malformed-input path, asserting no alert is resolved and no collection cycle aborts.

**`scripts/configure.mjs` and `scripts/reset-password.ts` have no tests:**
- What's not tested: env-file generation/quoting, the refusal to overwrite existing files, secret lengths, derived `NEXT_PUBLIC_APP_DOMAIN`, password length/`stdin` guard, single-user assumption and session revocation.
- Files: `scripts/configure.mjs`, `scripts/reset-password.ts`
- Risk: setup and account recovery are the two operations most likely to be run once, under pressure, and least likely to be re-tested. A quoting bug in `NAS_HOSTS` or a wrong database helper invalidates a deployment.
- **Severity:** medium
- Fix approach: unit-test the pure builders (env content, host JSON, validation) and run `configure.mjs` against a temporary directory; test `reset-password` against the disposable test database.

**No load or query-plan tests for the overview/history path:**
- What's not tested: 30-day aggregation latency, sample-table growth, index usage, concurrent dashboard polls, and the agent under many simultaneous log/file requests.
- Files: `src/app/api/[...path]/route.ts`, `tests/series.test.ts`, `tests/api-maintenance.test.ts`
- Risk: performance regressions are invisible until the NAS has months of history. The current tests assert correctness on small fixtures.
- **Severity:** low
- Fix approach: add a seeded performance test (or a benchmark script) with 500k samples, assert a query budget, and run it manually before changing the history SQL.

**Origin/trusted-host edge cases are not tested:**
- What's not tested: `TRUSTED_ORIGINS` with spaces or trailing slashes, multiple origins, a missing `Origin` on a mutation, and `x-forwarded-host` with a comma-separated chain.
- Files: `src/lib/auth.ts`, `src/lib/verification.ts`, `tests/api-*.test.ts`
- Risk: a valid deployment configuration can make every mutation return 403, or a non-canonical origin can select the wrong verification method. The current tests use a single exact `http://localhost:3000`.
- **Severity:** low
- Fix approach: normalize origins once (trim, strip trailing slash, drop empty entries) and add tests for the normalization plus the same-origin/alternate-domain verification decision.

## Verified Non-Issues

The following were inspected because they are common failure points and are **not** current problems:

- **No TODO/FIXME/HACK debt markers** in `src/` or `agent/`; the only `XXX` match is an obviously fake serial in `agent/test_smart.py:55`.
- **No `any` usage** in `src/` or `tests/` (0 matches for `as any`, `: any`, `<any>` and `any[]`). `strict: true` is enabled in `tsconfig.json`; `pnpm typecheck` passes.
- **Token comparison is constant-time** in the agent (`hmac.compare_digest` at `agent/server.py:453`) and setup uses `node:crypto.timingSafeEqual` at `src/app/api/[...path]/route.ts:130-135`; empty agent tokens are rejected before routing.
- **No request value reaches a shell.** `agent/host_commands.py` builds fixed `systemctl` argv, `agent/maintenance.py` passes fixed `nsenter` argv to the Docker API, `agent/updates.py` builds a fixed Compose argv, and `GitReader` uses `subprocess.run` with a list and the default `shell=False`. The reboot helper's `/bin/sh -c` script is a constant, not request data.
- **Path traversal and symlink defenses are real:** `checked_path()`, `parent_fd()` with `O_NOFOLLOW`, and `renameat2(..., RENAME_NOREPLACE)` prevent the obvious escapes and no-replace races; `agent/test_files.py` covers traversal, symlinks, root escape and destination overwrite.
- **The `.env` writer fails closed on symlinks, non-regular files, size limits and concurrent edits,** and never returns values. Tests cover concurrent writers, mode preservation, quoting and the symlink refusal.
- **`clean-images` fails closed** when any rollback file is unreadable and preserves images used by any container (including stopped ones) plus pinned/rollback references; it never calls `docker image prune`.
- **The test suites pass where they can run:** 182 agent tests pass (2 macOS skips), 167 Vitest tests pass with the database suites skipped, and project sources lint clean. The remaining skips are the environment gap described above, not failing assertions.
- **The database is not published and the app defaults to loopback:** `compose.yaml` publishes `127.0.0.1:${PRIVATE_PORT}` by default and `BIND_IP` defaults to `127.0.0.1`; PostgreSQL has no published port. The agent exposure is the Docker socket/privileged helper issue above, not a stray published database.

---

*Concerns audit: 2026-11-24*
