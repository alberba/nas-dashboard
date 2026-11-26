---
phase: 04-resumen-diario
plan: "01"
subsystem: notifications
tags: [postgresql, drizzle, telegram, madrid-time, daylight-saving, advisory-lock, lease, rate-limit]

requires:
  - phase: 02-incidencias-y-entrega-nica
    provides: notification_outbox, claim tokens, durable attempt marks and the collection advisory lock
  - phase: 03-agrupaci-n-inventario-y-ayudantes
    provides: helper-cleanup and services-down episodes that the digest will fold in 04-02

provides:
  - digest_runs queue with one row per Europe/Madrid civil date
  - telegram_cooldown single-row durable pause shared by every Telegram delivery
  - madridTarget/madridDateOf/shiftCivilDate civil-time helpers with DST disambiguation
  - DIGEST_TIME validated startup setting, 08:00 default
  - runDigestOnce tick wired into the worker loop

affects: [04-02 digest content, 04-03 digest visibility and health]

actuals:
  tokens: 33940
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Durable daily queue keyed by civil date with a claim token and lease, separate from the per-delivery outbox"
    - "Attempt mark committed before HTTP, clock re-read immediately before the transport"
    - "One shared cooldown row gates both the claim and the durable attempt mark"

key-files:
  created:
    - drizzle/0006_digest_runs.sql
    - src/lib/digest-runs.ts
    - src/lib/digest-content.ts
  modified:
    - src/lib/madrid-day.ts
    - src/lib/runtime-config.ts
    - src/lib/notification-dispatch.ts
    - src/lib/schema.ts
    - src/worker.ts
    - .env.example

key-decisions:
  - "digest_runs is the only authority for a date; the aggregate never writes a delivery result on an episode"
  - "The recovery window is frozen at prepare time so a later DIGEST_TIME change cannot reopen or move a date"
  - "Only the live claim owner may record the certain expiry after the clock crossed dueAt"
  - "A started attempt without a confirmation becomes uncertain and is never resent"

patterns-established:
  - "Civil-time arithmetic: civil date + HH:mm resolved through candidate offsets, never midnight + milliseconds"
  - "Period start reuses the stored previous target to keep consecutive cuts contiguous"
  - "The worker gives the digest one opportunity per turn after at most one individual job"

requirements-completed: [DIG-01, DIG-02, DIG-05]

coverage:
  - id: D1
    description: "One daily digest per Europe/Madrid civil date, sent from the lock owner and deduplicated after a restart"
    requirement: DIG-01
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#sends one digest per Madrid date with frozen content and keeps it after a restart"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#does not let a competing session deliver the same date"
        status: pass
    human_judgment: false
  - id: D2
    description: "DIGEST_TIME validated as HH:mm with 08:00 default, resolved on the Madrid wall clock across both 2026 transitions"
    requirement: DIG-02
    verification:
      - kind: unit
        ref: "tests/madrid-day.test.ts#uses the first occurrence when the wall clock repeats"
        status: pass
      - kind: unit
        ref: "tests/madrid-day.test.ts#shifts a wall clock that does not exist by the jump"
        status: pass
      - kind: unit
        ref: "tests/runtime-config.test.ts#rejects an invalid DIGEST_TIME without echoing it"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#honours a configured civil time that crosses midnight"
        status: pass
    human_judgment: false
  - id: D3
    description: "Recovery inside [target, target + 2 h): reclaims an attempt-less lease, keeps a started attempt uncertain and never starts a request at the boundary"
    requirement: DIG-05
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#recovers a claim that expired before the attempt started"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#keeps an attempt-started lease uncertain without a resend"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#expires when the clock crosses the deadline during the start mark"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#never starts a request at the exact end of the window"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#records one omission after a long stop instead of replaying days"
        status: pass
    human_judgment: false
  - id: D4
    description: "A confirmed Telegram 429 pauses openings, edits and the digest through one durable row; push keeps its own path"
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#delays a new digest while a confirmed Telegram 429 is active"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#pauses new Telegram notices after a confirmed digest 429"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#shares the pause from a confirmed edit 429 with the digest"
        status: pass
    human_judgment: false
  - id: D5
    description: "Additive 0006 migration applied by the real pnpm db:migrate runner from scratch and from 0005, preserving delivery rows"
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#applies 0006 to a new database and on top of 0005 with pnpm db:migrate"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#adds the daily queue and the shared pause without rewriting delivery"
        status: pass
    human_judgment: false

duration: 24min
completed: 2026-11-26
status: complete
commits: 6
plan_head_before: 2774899bb543776dd751c0cac12e50e0e0042ef7
plan_head_after: abce771e8bdee63fc525d74163e45c5541de0046
---

# Phase 4 Plan 1: Resumen diario — hora de Madrid y entrega durable

**Cola diaria `digest_runs` por fecha civil de Madrid, con reclamo atómico, ventana de recuperación de dos horas, texto congelado y una única pausa de Telegram compartida con avisos y ediciones.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-11-26T07:36:28Z
- **Completed:** 2026-11-26T09:00:55Z
- **Tasks:** 3
- **Files modified:** 16

## Accomplishments

- Una fila por fecha civil de Madrid con objetivo, inicio de periodo y vencimiento como instantes; el `claim` es atómico con token y lease y el dueño del lock de recolección es el único que entrega.
- La instantánea y el texto se congelan dentro de la transacción de preparación: un 429 repite los mismos bytes y un cambio de `DIGEST_TIME` no mueve ni reabre la fecha.
- La marca de intento se confirma antes de HTTP y el reloj se relee justo antes del transporte: si el commit cruza el vencimiento, solo el dueño vivo registra el vencimiento y no hay POST.
- Un lease sin marca de intento se recupera dentro de la ventana; una marca sin acuse queda incierta y nunca se reenvía.
- `DIGEST_TIME` se valida como `HH:mm` (08:00 por defecto) y la hora civil se resuelve probando los desfases a ambos lados de la transición: primera ocurrencia en el solapamiento y desplazamiento por el salto en el hueco.
- Una sola fila `telegram_cooldown` pausa aperturas, ediciones y resumen desde el instante de recepción del 429; push no la lee.
- La migración `0006_digest_runs` se aplica con el runner real (`pnpm db:migrate`) desde cero y desde 0005, preservando claves, revisiones y resultados del outbox.

## Task Commits

Cada tarea se commitó de forma atómica. Las tareas TDD tienen dos commits (test → feat):

1. **Task 1: Entregar un resumen real y conservar su resultado al reiniciar** - `14a6efb` (feat)
2. **Task 2: Respetar la hora configurada y recuperar el objetivo correcto durante dos horas**
   - `4b97476` (test, RED)
   - `c74c688` (feat)
3. **Task 3: Coordinar el 429 confirmado con las demás entregas del bot**
   - `7718e06` (test, RED)
   - `e880e2a` (feat)
4. **Cierre de verificación del plan** - `abce771` (fix)

## TDD Evidence

| Task | RED (target test) | GREEN |
| --- | --- | --- |
| 2 | `configured target in Europe/Madrid > uses the first occurrence when the wall clock repeats` — devolvía `2026-10-25T01:30Z` (segunda ocurrencia) | offsets candidatos + validación de la hora civil resultante |
| 2 | `readRuntimeConfig > defaults the daily digest to 08:00 Europe/Madrid` y los `DIGEST_TIME` inválidos — `digestTime` no existía | validación en `readRuntimeConfig` |
| 3 | `delays a new digest while a confirmed Telegram 429 is active` — el resumen salía durante la pausa | `pauseTelegram` en aperturas y ediciones |
| 3 | `pauses new Telegram notices after a confirmed digest 429` — un aviso nuevo eludía la pausa | predicado de cooldown en `claimOutboxJob` y `beginOutboxAttempt` |

Los informes TAP y los registros RED están en `.gsd/tdd-evidence/04-01/` (ignorado por git). `gsd_run` no está instalado en este entorno, así que el clasificador `tdd-red-evidence` no pudo ejecutarse; la evaluación semántica (13 y 3 fallos de aserción reales, sin fallos de carga ni de fixture) quedó registrada a mano en `red-task2.json` y `red-task3.json`.

## Files Created/Modified

- `drizzle/0006_digest_runs.sql` — tablas aditivas `digest_runs` y `telegram_cooldown` con su índice único por fecha
- `drizzle/meta/0006_snapshot.json`, `drizzle/meta/_journal.json` — metadato generado por Drizzle Kit
- `src/lib/schema.ts` — modelos `digestRuns` y `telegramCooldown`
- `src/lib/madrid-day.ts` — `madridDateOf`, `parseCivilDate`, `shiftCivilDate`, `madridTarget` con desambiguación de transiciones
- `src/lib/digest-content.ts` — instantánea acotada de incidencias con disposición `digest_pending`, enlace autenticado a Avisos y truncado seguro
- `src/lib/digest-runs.ts` — calendario persistido, preparación, claim, marca de intento, resultado, vencimiento y recuperación
- `src/lib/notification-dispatch.ts` — `beginTelegramCooldown`, pausa compartida y predicados de cooldown en claim e intento
- `src/lib/runtime-config.ts` — `digestTime` validado, `DEFAULT_DIGEST_TIME`
- `src/worker.ts` — una oportunidad de resumen por vuelta del drenaje
- `.env.example` — documentación de `DIGEST_TIME`
- `tests/migrations.test.ts` — verificación de 0006 y del runner real
- `tests/notification-dispatch.test.ts` — 17 casos de resumen, recuperación, hora civil y pausa
- `tests/madrid-day.test.ts` — transiciones de 2026, fecha civil y errores de formato
- `tests/runtime-config.test.ts` — defecto, valor no estándar y rechazo de `DIGEST_TIME`
- `tests/collector-alerts.test.ts` — literal de `RuntimeConfig` actualizado

## Decisions Made

- **`digest_runs` como única autoridad de la fecha.** El agregado no escribe `sent` ni `messageId` en la apertura individual: eso rompería la escalada y permitiría que `incident-edit` editara el resumen.
- **Ventana congelada al preparar.** `dueAt = targetAt + 2 h` se guarda en la fila; cambiar `DIGEST_TIME` después no altera la fecha ya preparada y `periodStartAt` reutiliza el objetivo anterior persistido para mantener cortes contiguos.
- **La certeza del vencimiento es del dueño.** Si el reloj cruzó `dueAt` durante el commit de la marca de inicio, solo el proceso que aún posee el token y sabe que no invocó HTTP puede cerrar como `expired`.
- **Una pausa única por bot.** `telegram_cooldown` se comprueba al seleccionar y al marcar el intento, de modo que una fila insertada después del 429 tampoco empieza antes de tiempo.
- **Un marcador de omisión, no una ráfaga.** Tras varios días parado se registra solo la última omisión relevante y no se reproducen resúmenes atrasados.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `beginTelegramCooldown` adelantado a la tarea 1**
- **Found during:** Task 1 (el módulo de resumen importa el helper de pausa)
- **Issue:** `digest-runs.ts` no compilaba sin la función compartida que pertenece a la tarea 3
- **Fix:** Se añadió la función de escritura de la pausa en la tarea 1; los predicados de selección y de intento siguieron en la tarea 3
- **Files modified:** `src/lib/notification-dispatch.ts`
- **Verification:** `pnpm typecheck` y las suites de la tarea 1
- **Committed in:** `14a6efb`

**2. [Rule 1 - Bug] Enlace inválido al preparar con una configuración de prueba incompleta**
- **Found during:** Task 1 (primeras ejecuciones de las pruebas de resumen)
- **Issue:** El helper de pruebas construía la configuración antes de `beforeAll`, así que `betterAuthUrl` no existía y `digestAlertsUrl` lanzaba
- **Fix:** La configuración de pruebas del resumen se construye por llamada, con los hosts configurados
- **Files modified:** `tests/notification-dispatch.test.ts`
- **Verification:** 34 pruebas de la tarea en verde
- **Committed in:** `14a6efb`

**3. [Rule 1 - Bug] `nextAttemptAt` dependía del reloj real**
- **Found during:** Task 1 (claim nulo con reloj inyectado)
- **Issue:** La columna por defecto usa `now()` de PostgreSQL, posterior al instante inyectado, así que la fila recién preparada no era reclamable
- **Fix:** La preparación escribe `nextAttemptAt = targetAt`; la fila queda debida en su objetivo
- **Files modified:** `src/lib/digest-runs.ts`
- **Verification:** Casos de claim y de recuperación en verde
- **Committed in:** `14a6efb`

**4. [Rule 2 - Missing Critical] El reintento del resumen no se podía persistir**
- **Found during:** Task 3 (prueba del 429 del resumen)
- **Issue:** PostgreSQL resolvía el parámetro del instante como `text` en `jsonb_build_object` y fallaba al escribir `updatedAt`
- **Fix:** El instante ISO del resultado usa un parámetro propio (`$5`)
- **Files modified:** `src/lib/digest-runs.ts`
- **Verification:** `pauses new Telegram notices after a confirmed digest 429`
- **Committed in:** `e880e2a`

**5. [Rule 2 - Missing Critical] Corte de periodo no contiguo tras cambiar el horario**
- **Found during:** Verificación del plan (requisito de la tarea 2)
- **Issue:** `periodStartAt` se recalculaba con el horario actual en vez de reutilizar el objetivo persistido del día anterior
- **Fix:** La preparación lee el `targetAt` de la fecha anterior y lo usa como inicio de periodo
- **Files modified:** `src/lib/digest-runs.ts`
- **Verification:** `keeps contiguous periods across a schedule change`
- **Committed in:** `abce771`

**6. [Rule 2 - Missing Critical] La migración no se probaba con el runner real**
- **Found during:** Verificación del plan (la tarea 1 nombra `pnpm db:migrate`)
- **Issue:** La suite usaba el migrador de Drizzle directamente, no el punto de entrada desplegado
- **Fix:** Prueba nueva que ejecuta `scripts/migrate.ts` con `tsx` desde cero y desde 0005, y lo repite para comprobar idempotencia
- **Files modified:** `tests/migrations.test.ts`
- **Verification:** `applies 0006 to a new database and on top of 0005 with pnpm db:migrate`
- **Committed in:** `abce771`

---

**Total deviations:** 6 auto-fixed (1 blocking, 5 correctness)
**Impact on plan:** Todas las correcciones eran necesarias para que la cola fuese reclamable, para que el reintento del 429 persistiera y para acreditar la migración con el runner real. Sin ampliación de alcance.

## Issues Encountered

- **`gsd_run` no está instalado en este entorno.** El clasificador `tdd-red-evidence` no pudo ejecutarse; se conservaron los informes TAP sin modificar y la evaluación semántica manual en `.gsd/tdd-evidence/04-01/`.
- **`pnpm lint` recorre el árbol completo y falla en `.opencode/`.** Es preexistente (esos ficheros están sin seguimiento y no forman parte del plan): 5570 errores de `require()` en scripts de GSD. El lint focalizado de los 12 ficheros tocados pasa sin avisos.
- **Una ejecución completa de la suite falló por timeouts transitorios** tras un RED abortado (bases y sesiones de prueba residuales). La ejecución limpia posterior dio 41/41 archivos y 520/520 pruebas.
- **Node local es 24.22.3.** La resolución usa `Intl` sin dependencias ni flags; la comprobación en el Node 26 de CI queda para el cierre de fase, como ya preveía la validación.

## User Setup Required

None - no external service configuration required. `DIGEST_TIME` es opcional y su valor por defecto (08:00) no necesita configuración.

## Next Phase Readiness

- `digest_runs` ya guarda `periodStartAt`/`targetAt` para que 04-02 construya las cohortes sin recalcular el corte.
- `buildDigestSnapshot` recibe el cliente de la transacción, los hosts configurados y ambos objetivos: 04-02 extiende la selección y el render conservando el contrato.
- El estado y `reason` finitos de cada fecha están listos para que 04-03 los proyecte en Avisos sin exponer el contenido.
- La pausa compartida queda disponible para cualquier entrega futura del mismo bot.

---

## Self-Check: PASSED

- 16/16 files listed above exist on disk.
- 6/6 commits are ancestors of HEAD (`14a6efb`, `4b97476`, `c74c688`, `7718e06`, `e880e2a`, `abce771`).
- `HUB_REQUIRE_TEST_DB=1 pnpm test` → 41 files, 520 tests passed.

---

*Phase: 04-resumen-diario*
*Completed: 2026-11-26*
