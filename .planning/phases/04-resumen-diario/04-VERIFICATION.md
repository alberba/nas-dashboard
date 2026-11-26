---
phase: 04-resumen-diario
verified: 2026-11-26T10:40:00Z
status: passed
score: 21/21 must-haves verified
covered_files: [
    ".env.example",
    ".planning/phases/04-resumen-diario/04-01-PLAN.md",
    ".planning/phases/04-resumen-diario/04-01-SUMMARY.md",
    ".planning/phases/04-resumen-diario/04-02-PLAN.md",
    ".planning/phases/04-resumen-diario/04-02-SUMMARY.md",
    ".planning/phases/04-resumen-diario/04-03-PLAN.md",
    ".planning/phases/04-resumen-diario/04-03-SUMMARY.md",
    ".planning/phases/04-resumen-diario/04-PATTERNS.md",
    ".planning/phases/04-resumen-diario/04-RESEARCH.md",
    ".planning/phases/04-resumen-diario/04-REVIEW-DISPOSITION.md",
    ".planning/phases/04-resumen-diario/04-REVIEW-FIX.md",
    ".planning/phases/04-resumen-diario/04-REVIEW.md",
    ".planning/phases/04-resumen-diario/04-SECURITY.md",
    ".planning/phases/04-resumen-diario/04-VALIDATION.md",
    "agent/Dockerfile",
    "agent/server.py",
    "agent/test_metrics.py",
    "compose.yaml",
    "drizzle/0006_digest_runs.sql",
    "drizzle/meta/0006_snapshot.json",
    "drizzle/meta/_journal.json",
    "scripts/check-worker-health.ts",
    "src/app/api/[...path]/route.ts",
    "src/app/globals.css",
    "src/components/views/alerts.tsx",
    "src/lib/digest-content.ts",
    "src/lib/digest-runs.ts",
    "src/lib/madrid-day.ts",
    "src/lib/notification-dispatch.ts",
    "src/lib/runtime-config.ts",
    "src/lib/schema.ts",
    "src/lib/telegram.ts",
    "src/lib/types.ts",
    "src/lib/worker-health.ts",
    "src/lib/worker-loop.ts",
    "src/worker.ts",
    "tests/api-incidents.test.ts",
    "tests/collector-alerts.test.ts",
    "tests/e2e/incidents.spec.ts",
    "tests/madrid-day.test.ts",
    "tests/migrations.test.ts",
    "tests/notification-dispatch.test.ts",
    "tests/runtime-config.test.ts",
    "tests/telegram.test.ts"
  ]
covered_digest: "v4:sha256:1455293c4bf09dabe36c2ffdf7840d0d904a900d51bbe12acabd9fa442699351"
behavior_unverified: 0
overrides_applied: 0
decision_coverage:
  honored: null
  total: null
  not_honored: []
human_verification:
  - test: "Con un bot y un chat de Telegram reales, sembrar actividad no urgente y dejar que el worker alcance el objetivo diario (o fijar DIGEST_TIME unos minutos por delante)."
    expected: "Llega un único mensaje «Resumen diario · <fecha>» con abiertas ahora, nuevas en el periodo, el pie de críticas y resueltas y el botón que abre Avisos con sesión. Un reinicio del worker dentro de la ventana no produce un segundo mensaje."
    why_human: "Toda la suite usa un fetch inyectado contra la API de Telegram. La recepción real, el render del cliente y el botón dependen de un servicio externo."
  - test: "Construir nas-dashboard:local, levantar el worker con compose.yaml en un entorno desechable, esperar healthy, congelar el proceso con SIGSTOP y reanudarlo con SIGCONT."
    expected: "Docker marca el worker unhealthy mientras el proceso vive sin progresar y vuelve a healthy al reanudarse."
    why_human: "Los tests ejercitan la marca y el probe con /proc y reloj inyectados. La transición del estado de Docker requiere un contenedor real (entorno de 04-VALIDATION.md)."
  - test: "Construir hub-agent desde agent/compose.yaml y agent/compose.apps.yaml en entorno desechable, ocupar el LOCK o congelar el proceso y después liberarlo."
    expected: "Ambos servicios heredan el HEALTHCHECK, pasan a unhealthy con el proceso vivo y bloqueado, y recuperan healthy. La purga de la papelera no los vuelve unhealthy."
    why_human: "WR-04 (8343198) cambió agent/server.py después de la evidencia Docker registrada en 04-03-SUMMARY. La transición real de Docker no la cubre la suite unitaria."
  - test: "Abrir Avisos con un resumen sembrado como fallido y otro como incierto, y cambiar de host."
    expected: "El panel «Último resumen diario» es global, se mantiene al cambiar de host y distingue con claridad fallo, vencimiento e incertidumbre."
    why_human: "Playwright (INC-E2E-04) afirma estado estructural por data-*. La claridad del texto queda para revisión manual, como fija 04-VALIDATION.md."
---

# Phase 4: Resumen diario — Verification Report

**Phase Goal:** Entregar lo no urgente en un único resumen diario a las 08:00 de Madrid, sin duplicados ni pérdidas en los cambios de hora, y hacer visible cuando no sale.
**Verified:** 2026-11-26T10:40:00Z
**Status:** human_needed
**Re-verification:** No. Es la verificación inicial.

## Nota sobre el modo MVP

ROADMAP marca la fase como `**Mode:** mvp`, pero el objetivo no sigue el formato de historia de usuario (`user-story.validate` → `valid: false`). Las fases 01 a 03 tienen la misma discrepancia y se verificaron con el método goal-backward estándar contra los criterios de éxito del roadmap. Este informe hace lo mismo. Queda como ℹ️ Info y no afecta al estado. Si se quiere el formato MVP estricto, hay que reformular el objetivo con `/gsd-mvp-phase 4`.

## Goal Achievement

### Observable Truths

Los criterios de éxito del roadmap (SC1–SC5) son el contrato. Las verdades de los planes los detallan.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | Un único resumen diario a la hora configurada (08:00 `Europe/Madrid` por defecto) con abiertas ahora, nuevas en el periodo, contador de críticas y de resueltas | ✓ VERIFIED | `runtime-config.ts:63` (`DEFAULT_DIGEST_TIME = "08:00"`), `digest-runs.ts:233-245` (`digestSchedule` → `madridTarget`), índice único `digest_runs_date_idx` en `0006_digest_runs.sql`. Secciones en `digest-content.ts:186-200`. Tests: `notification-dispatch.test.ts` «sends one digest per Madrid date…», «builds the daily cohorts and counters from the durable disposition», «does not send before the configured time and sends once it arrives» |
| SC2 | Un cambio de hora o un reinicio alrededor de las 08:00 no produce dos envíos ni lo pierde dentro de una ventana de 2 h | ✓ VERIFIED | `madrid-day.ts:158-189` (primera ocurrencia y salto). `DIGEST_WINDOW_MS = 2h` (`digest-runs.ts:36`). Hay recuperación de lease con `uncertain` tras `attemptStartedAt` (`:256-302`) y `beginDigestAttempt` exige `dueAt > now` (`:572-597`). Tests: `madrid-day.test.ts` (5 casos de transición y zona), «recovers a claim that expired…», «keeps an attempt-started lease uncertain without a resend», «never starts a request at the exact end of the window», «honours a configured civil time that crosses midnight» |
| SC3 | Sin contenido no se envía nada. Con mucho contenido se trunca con «+N» y se respeta el límite de 4096 | ✓ VERIFIED | `buildDigestSnapshot` devuelve null con contadores a cero (`digest-content.ts:365-372`) y la fila pasa a `empty` sin petición (`digest-runs.ts:420-433`). `renderDigestSnapshot` recorta líneas hasta que cabe el `+N` exacto (`:209-244`). Tests: «stays silent when the day has no details and no countable activity», «closes an empty cut without a request», «delivers a bounded digest with exact omissions…», `telegram.test.ts` «keeps the footer and the exact omitted count inside the provider limit» |
| SC4 | Si el resumen no sale, el operador lo ve en el hub y el worker lo reporta | ✓ VERIFIED | `projectDigestOverview` (`digest-runs.ts:182-210`) → overview autenticado (`route.ts:385-407`) → `DigestStatus` en `alerts.tsx:100-120, 287-297`. Hay log acotado por transición en `worker.ts:35-40`. Tests: `api-incidents.test.ts` «projects the latest digest target globally with a finite reason», «keeps the digest projection behind a session», «reports one bounded failure transition…», e2e INC-E2E-04 |
| SC5 | Agente y worker exponen healthcheck; un proceso vivo pero bloqueado no se declara sano | ✓ VERIFIED | Worker: `worker-health.ts:142-183` y `WorkerHealth.renew` exige el lock (`:221-243`). `compose.yaml:60-66` ejecuta `scripts/check-worker-health.ts`. Agente: `HEALTHCHECK` en `agent/Dockerfile:13-14`, compartido por `agent/compose.yaml` y `agent/compose.apps.yaml` (`build: .`), y `HealthServer.service_actions` publica solo con `LOCK` libre (`server.py:203-214`). Tests: «marks a stopped loop unhealthy while the process is still alive and recovers», «does not extend health when a delivery turn throws», `test_metrics.py` `test_a_lock_held_by_another_thread_blocks_progress_and_recovery`, `test_the_purge_does_not_hold_the_request_lock` |
| P1-1 | DIG-01: un solo resumen global por fecha civil, horario configurable, 08:00 por defecto | ✓ VERIFIED | Como SC1. `DIGEST_TIME` se valida con patrón `HH:mm` (`runtime-config.ts:345-349`). Test «keeps the frozen target when the configured time changes» |
| P1-2 | DIG-02: hora repetida → primera ocurrencia. Hora inexistente → desplazada. La zona del proceso no influye | ✓ VERIFIED | `madrid-day.ts:174-189`. Tests: `madrid-day.test.ts` «shifts a wall clock that does not exist by the jump», «uses the first occurrence when the wall clock repeats», «keeps the calendar date independent of the process time zone» |
| P1-3 | DIG-05: recuperación dentro de 2 h incluso cruzando medianoche y sin POST en el límite exacto | ✓ VERIFIED | `prepareDigestRuns` evalúa hoy y ayer (`digest-runs.ts:312-318`). Re-lectura del reloj antes del POST (`:819-822`). Tests «honours a configured civil time that crosses midnight», «never starts a request at the exact end of the window», «expires when the clock crosses the deadline during the start mark» |
| P1-4 | Conexiones en competencia, lease caduco, reloj repetido o cambio de configuración no crean dos entregas | ✓ VERIFIED | `FOR UPDATE SKIP LOCKED` y token de claim (`:525-566`), `ON CONFLICT ("date") DO NOTHING`, objetivo congelado. Tests «does not let a competing session deliver the same date», «keeps contiguous periods across a schedule change» |
| P1-5 | Confirmación perdida → incierta sin repetir. 429 confirmado → mismo texto antes del vencimiento | ✓ VERIFIED | `recordDigestUncertain` (`:652-670`) y `recordDigestRetry` vuelve a `prepared` con el payload intacto (`:676-741`). Tests «keeps an attempt-started lease uncertain without a resend», «repeats the frozen digest after an authorized retry even when the episodes change», «ends the date when the confirmed retry passes the window» |
| P1-6 | Cooldown de Telegram persistente y compartido. El push sigue su vía | ✓ VERIFIED | Tabla `telegram_cooldown`, `beginTelegramCooldown` con `GREATEST` (`notification-dispatch.ts:117-120`), comprobación en claim y en inicio. Tests «pauses new Telegram notices after a confirmed digest 429» (el push se envía durante la pausa), «shares the pause from a confirmed edit 429 with the digest», «delays a new digest while a confirmed Telegram 429 is active» |
| P2-1 | DIG-03: abiertas, nuevas, críticas y resueltas exactas | ✓ VERIFIED | CTE única en `digest-content.ts:271-352`. Test «builds the daily cohorts and counters from the durable disposition» |
| P2-2 | DIG-04: sin detalle ni actividad no hay contacto con Telegram. Un pie con actividad sí es contenido | ✓ VERIFIED | `digest-content.ts:365-372`. Tests «stays silent when…», «sends a footer-only digest when there is activity but no eligible row» |
| P2-3 | DIG-06: ≤ 4096 unidades UTF-16 con totales y +N exactos | ✓ VERIFIED | `TELEGRAM_TEXT_LIMIT`, recorte por punto de código (`clip`). Tests en `telegram.test.ts` (líneas 110-251) y «caps the materialised details and reports the rest as omitted» |
| P2-4 | La selección usa la disposición durable e incluye helper-cleanup, aperturas resueltas y cambios de severidad | ✓ VERIFIED | Join lateral a la primera `incident-open` del outbox (`digest-content.ts:285-293`), `critical` por `incident_events` `opened`/`severity`. `notification-policy.ts` envía helper-cleanup a `digest_pending`. Test `collector-alerts.test.ts` «opens one digest episode for a persistent helper cleanup failure» |
| P2-5 | Los reintentos reutilizan el texto congelado. El outbox individual conserva su historial | ✓ VERIFIED | Payload congelado en la transacción de preparación (`digest-runs.ts:434-442`). Test «leaves the individual queue and the timeline untouched» |
| P3-1 | CONT-03: Avisos muestra el último objetivo relevante, su estado y el motivo. Proyección global y con sesión | ✓ VERIFIED | Como SC4. Lista cerrada de motivos `publicDigestReasons` (`digest-runs.ts:131-162`) |
| P3-2 | El worker registra fallo, vencimiento e incertidumbre con razones finitas, sin texto, secreto ni destino | ✓ VERIFIED | `logDigestTransition` imprime fecha y motivo filtrado (`worker.ts:35-40`). Test «reports one bounded failure transition…» |
| P3-3 | Worker vivo con bucle detenido o sin lock deja de estar sano. Trabajo normal lo mantiene sano | ✓ VERIFIED | `worker-loop.ts` renueva solo tras hitos, y `stop()`/pérdida de lock llaman a `closeSync`. Tests «renews only after real milestones…», «does not renew after losing the lock…», «renews after every completed delivery lane…» |
| P3-4 | Ambas imágenes del agente con healthcheck ligado al servidor y al lock, que pasa a unhealthy y luego se recupera | ✓ VERIFIED | Como SC5 (lógica y cableado). La transición real de Docker queda como verificación humana (#3) |
| P3-5 | Marcas faltantes, inválidas, futuras, obsoletas o de otro proceso no dan señal sana | ✓ VERIFIED | `checkWorkerHealth` (`worker-health.ts:142-183`), `read_health_check` con `math.isfinite` (WR-02). Tests «rejects missing, malformed, future, unsafe, dead and unreadable marks», «rejects a fresh mark from a reused PID…», `test_a_non_finite_progress_mark_is_malformed` |

**Score:** 21/21 truths verified (0 present, behavior-unverified)

### Prohibitions (verification: test)

| Prohibición | Plan | Estado | Evidencia |
|-------------|------|--------|-----------|
| El reloj o una entrega incierta no duplican el resumen ni generan push de respaldo | 04-01 | ✓ enforced | «keeps an attempt-started lease uncertain without a resend», «reports an ambiguous attempt as uncertain without claiming a delivery» |
| Un regreso tras la ventana no produce ráfaga de resúmenes antiguos | 04-01 | ✓ enforced | `recordMissedRun` (`digest-runs.ts:469-517`). Tests «records one omission after a long stop instead of replaying days», «reports the last lost window once…» |
| El resumen no convierte alertas silenciosas, históricas o individuales en avisos detallados | 04-02 | ✓ enforced | Filtro `digestOpen` y `visible` excluye `legacy`. Test «builds the daily cohorts…» |
| Una inclusión agregada no se registra como entrega individual | 04-02 | ✓ enforced | «leaves the individual queue and the timeline untouched» |
| La visibilidad del fallo no genera aviso proactivo ni presenta lo incierto como rechazado | 04-03 | ✓ enforced | Estados `failed`/`uncertain` separados en `digestStatuses`. Test «reports an ambiguous attempt as uncertain…» |
| La sonda no declara sano un proceso detenido ni abre acceso nuevo al agente | 04-03 | ✓ enforced | El probe solo lee el fichero y `/proc` (`--health-check` sale antes del token). Test `test_health_mode_exits_before_the_token_check` |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `drizzle/0006_digest_runs.sql` | Tablas aditivas `digest_runs` y `telegram_cooldown` | ✓ VERIFIED | 29 líneas, índice único por fecha. `tests/migrations.test.ts` verde |
| `src/lib/digest-runs.ts` | Cola diaria persistente | ✓ VERIFIED | 907 líneas, sustancial y cableado desde worker y route |
| `src/lib/madrid-day.ts` | Fecha civil y horario → instante Madrid | ✓ VERIFIED | 211 líneas, usado por `digestSchedule` |
| `src/lib/digest-content.ts` | Selección, contadores y formato acotado | ✓ VERIFIED | 412 líneas, importado por `digest-runs.ts:16` |
| `tests/notification-dispatch.test.ts` | Contenido real vía persistencia | ✓ VERIFIED | Ejecutado contra PostgreSQL 18 |
| `src/components/views/alerts.tsx` | Estado global del resumen | ✓ VERIFIED | `DigestStatus` y estado vacío con `data-digest-*` |
| `src/lib/worker-health.ts` | Marca de progreso validable | ✓ VERIFIED | 271 líneas, importado por `worker.ts:17` y el script |
| `compose.yaml` | Sonda local del worker | ✓ VERIFIED | `healthcheck.test` → `scripts/check-worker-health.ts`, `tmpfs: /tmp` |
| `agent/Dockerfile` | Sonda compartida por ambas configuraciones | ✓ VERIFIED | `HEALTHCHECK … python server.py --health-check`, ambos compose con `build: .` |

`verify.artifacts`: 9/9 superan existencia y sustancia en los tres planes.

### Key Link Verification

`verify.key-links` devolvió `verified: false` en 8 de 9 enlaces con «Target not referenced in source». Es un falso negativo de la herramienta: busca la ruta literal (`src/lib/digest-runs.ts`) y el código importa `./lib/digest-runs` o `@/lib/digest-runs`. Comprobación manual:

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/worker.ts` | `digest-runs.ts` | Tick desde el dueño del lock | ✓ WIRED | `worker.ts:15` import. `drain` → `runDigestOnce`, que comprueba `holdsCollectionLock` (`digest-runs.ts:891`) |
| `digest-runs.ts` | `digest-content.ts` | Instantánea congelada antes de la petición | ✓ WIRED | `digest-runs.ts:16` y `buildDigestSnapshot` dentro de la transacción (`:411-442`) |
| `notification-dispatch.ts` | `schema.ts` | Cooldown persistente compartido | ✓ WIRED | `notification-dispatch.ts:7-8`, `telegram_cooldown` en `:117, :262, :313` |
| `digest-content.ts` | `schema.ts` | Política de apertura persistida | ✓ WIRED | SQL directo sobre `incidents`, `notification_outbox` e `incident_events` (`:285-345`) |
| `digest-runs.ts` | `digest-content.ts` | Corte, fecha y hosts | ✓ WIRED | `periodStartAt`/`targetAt`/`row.date`/`hostIds` pasados en `:411-420` |
| `route.ts` | `digest-runs.ts` | Overview autenticado | ✓ WIRED | `route.ts:59` import, `:389` llamada |
| `src/worker.ts` | `worker-health.ts` | Solo hitos renuevan | ✓ WIRED | `worker.ts:17, 110-113`. `worker-loop.ts` llama a `renew()` tras cada hito |
| `compose.yaml` | `check-worker-health.ts` | Docker evalúa sin red | ✓ WIRED | `compose.yaml:61` |
| `agent/Dockerfile` | `agent/server.py` | Probe interno lee la marca | ✓ WIRED | `Dockerfile:14` → `server.py:840-841` `run_health_check` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `alerts.tsx` `DigestStatus` | `data.digest` | `projectDigestOverview` → `SELECT … FROM digest_runs` | Sí | ✓ FLOWING |
| Mensaje de Telegram | `run.payload` | `buildDigestSnapshot` → CTE sobre `incidents`/`notification_outbox`/`incident_events` | Sí | ✓ FLOWING |
| Probe del worker | marca en `/tmp` | `WorkerHealth.renew` tras hitos con lock | Sí | ✓ FLOWING |

### Behavioral Spot-Checks

Ejecutados por este verificador sobre el árbol final (`fb042e2`), con PostgreSQL 18 desechable en `127.0.0.1:55432`:

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Calendario, cola, contenido, truncado y salud del worker | `HUB_REQUIRE_TEST_DB=1 pnpm exec vitest run tests/madrid-day.test.ts tests/notification-dispatch.test.ts tests/telegram.test.ts tests/migrations.test.ts --maxWorkers=1` | 4 files, 94 passed, 0 skipped | ✓ PASS |
| Proyección global del resumen y sesión | `HUB_REQUIRE_TEST_DB=1 pnpm exec vitest run tests/api-incidents.test.ts -t digest` | 3 passed | ✓ PASS |
| Probe del agente (NaN, lock, purga, PID reutilizado) | `cd agent && python3 -m unittest test_metrics` | 13 tests OK | ✓ PASS |
| Suite completa, build, e2e, typecheck | Evidencia del orquestador: vitest 552/552, `test:agent` 216 OK, Playwright 64/64, build y typecheck con exit 0 | No reejecutado (regla de una sola suite completa; Playwright arranca servidor) | ? SKIP |

### Probe Execution

Step 7c: no aplica. La fase no declara `scripts/*/tests/probe-*.sh`.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DIG-01 | 04-01 | Un único resumen diario a la hora configurada | ✓ SATISFIED | SC1, P1-1 |
| DIG-02 | 04-01 | Cálculo por instante de Madrid sin duplicar ni saltar | ✓ SATISFIED | SC2, P1-2 |
| DIG-03 | 04-02 | Abiertas, nuevas, críticas y resueltas | ✓ SATISFIED | P2-1 |
| DIG-04 | 04-02 | Sin contenido no se envía nada | ✓ SATISFIED | P2-2 |
| DIG-05 | 04-01 | Reinicio sin doble envío ni pérdida en 2 h | ✓ SATISFIED | P1-3, P1-4, P1-5 |
| DIG-06 | 04-02 | 4096 con truncado y «+N» | ✓ SATISFIED | P2-3 |
| CONT-03 | 04-03 | Healthcheck de agente y worker, y el worker reporta el resumen fallido | ✓ SATISFIED (lógica). Falta la transición Docker real (humano) | SC4, SC5, P3-1…P3-5 |

**Cobertura:** 7/7 IDs. `REQUIREMENTS.md:126-132` asigna exactamente estos siete a la fase 4. No hay IDs huérfanos.

### Decision Coverage

No hay CONTEXT.md, así que no se comprueba nada (`check.decision-coverage-verify` → `skipped: true`, «CONTEXT.md missing»).

### Test Quality Audit

| Test File | Linked Req | Active | Skipped | Circular | Assertion Level | Verdict |
|-----------|-----------|--------|---------|----------|-----------------|---------|
| `tests/madrid-day.test.ts` | DIG-02 | todos | 0 | No | Value (instantes exactos) | ✓ |
| `tests/notification-dispatch.test.ts` | DIG-01..06, CONT-03 | todos (con BD) | 0 con `HUB_REQUIRE_TEST_DB=1` | No | Behavioral (persistencia + transporte inyectado) | ✓ |
| `tests/telegram.test.ts` | DIG-06 | todos | 0 | No | Value (longitud, `+N` exacto) | ✓ (ver IN-01) |
| `tests/api-incidents.test.ts` | CONT-03 | 3 de resumen | 0 relevantes | No | Value/Status | ✓ |
| `agent/test_metrics.py` | CONT-03 | 13 | 0 | No | Behavioral | ✓ (ver IN-07) |

`describe.skipIf(!baseUrl)` en las suites de BD: se fuerza con `HUB_REQUIRE_TEST_DB=1` y en esta ejecución corrieron todos los casos.
**Disabled tests on requirements:** 0. **Circular patterns:** 0. **Insufficient assertions:** 1 informativo (IN-01: el test de bidi no puede fallar).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (todos los ficheros de la fase) | — | `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` | — | Ninguno encontrado |
| `src/lib/digest-content.ts` | 106-107 | `UNSAFE_CHARACTERS` no incluye U+202A–U+202E ni U+061C (IN-01, abierto) | ℹ️ Info | Latente: los títulos los escribe el hub o vienen de la configuración del operador. No forja líneas porque los saltos sí se eliminan |
| `src/app/api/[...path]/route.ts` / `alerts.tsx` | 386-396 / 288-297 | Un fallo de lectura del resumen se muestra como «Todavía no hay ningún resumen registrado» (IN-06, abierto) | ⚠️ Warning | Solo ocurre si falla la consulta a la BD. No afecta a la visibilidad de un resumen que no salió, que está persistido y se proyecta |
| `src/lib/worker-health.ts` / `scripts/check-worker-health.ts` | — | `WORKER_HEALTH_FILE` lo respeta el probe y lo ignora el escritor (IN-05, abierto) | ℹ️ Info | Sin efecto con la configuración entregada (`compose.yaml` no define la variable) |
| `tests/notification-dispatch.test.ts` / `agent/test_metrics.py` | 3083 / 206 | Aserción sobre texto del stderr, contra `CODING_STANDARD.md` (IN-07, abierto) | ℹ️ Info | El exit code ya se afirma. Es acoplamiento a copy, no un hueco de comportamiento |

IN-02, IN-03, IN-04 y IN-08 de `04-REVIEW-DISPOSITION.md` siguen abiertos con severidad info (duplicación de tipos, validación de URL duplicada, métodos sin uso y motivo `claim_lost` impreciso durante el cooldown). Ninguno contradice una must-have. WR-01…WR-04 están corregidos y verificados: fecha civil en el título (`digest-content.ts` usa `input.date`), `math.isfinite` en el probe, `retry_after` acotado en `telegram.ts` y purga fuera del `LOCK` con su test.

## Human Verification Required

Este verificador no puede reproducir cuatro comprobaciones porque dependen de servicios externos o de Docker real. Las tres primeras corresponden a las «Comprobaciones de entorno» de `04-VALIDATION.md`.

### 1. Recepción real del resumen en Telegram

**Test:** Con un bot y un chat reales, sembrar actividad no urgente y dejar que el worker alcance el objetivo (o fijar `DIGEST_TIME` unos minutos por delante). Reiniciar el worker dentro de la ventana.
**Expected:** Llega un único «Resumen diario · <fecha>» con las secciones, el pie de críticas y resueltas y el botón a Avisos. No llega un segundo mensaje tras el reinicio.
**Why human:** Toda la suite usa un `fetch` inyectado. La recepción y el render del cliente de Telegram son externos.

### 2. Transición Docker del worker

**Test:** Construir `nas-dashboard:local`, levantar el worker con `compose.yaml` en un entorno desechable, esperar `healthy`, aplicar `SIGSTOP` y después `SIGCONT`.
**Expected:** `unhealthy` con el proceso vivo y congelado, y `healthy` al reanudar.
**Why human:** Los tests inyectan `/proc` y el reloj. El estado de Docker requiere un contenedor real.

### 3. Transición Docker de ambos servicios del agente

**Test:** Construir desde `agent/compose.yaml` y `agent/compose.apps.yaml`, bloquear el progreso (LOCK ocupado o `SIGSTOP`) y liberarlo. Dejar correr una purga de la papelera.
**Expected:** Ambos heredan el `HEALTHCHECK`, pasan a `unhealthy` y se recuperan. La purga no provoca `unhealthy`.
**Why human:** La evidencia Docker de 04-03-SUMMARY es anterior a WR-04 (8343198), que cambió `agent/server.py`.

### 4. Legibilidad del panel «Último resumen diario»

**Test:** Abrir Avisos con un resumen sembrado como fallido y otro como incierto, y cambiar de host.
**Expected:** El panel es global y distingue con claridad fallo, vencimiento e incertidumbre.
**Why human:** Playwright afirma el estado estructural por `data-*`. La claridad del texto es juicio humano.

## Gaps Summary

No hay huecos bloqueantes. Las 21 verdades (5 criterios del roadmap y 16 de los planes), las 6 prohibiciones de nivel test, los 9 artefactos y los 9 enlaces clave están verificados contra el código y contra tests nombrados que este verificador ejecutó en el árbol final. Los 7 requisitos están satisfechos y no hay IDs huérfanos.

El estado es `human_needed` porque la entrega real por Telegram, las transiciones de Docker (worker y los dos servicios del agente, este último cambiado por WR-04 después de la evidencia registrada) y la claridad del panel dependen de servicios externos o de juicio humano. Siguen abiertos un warning no bloqueante (IN-06) y varios hallazgos informativos de la revisión.

---

_Verified: 2026-11-26T10:40:00Z_
_Verifier: the agent (gsd-verifier)_
