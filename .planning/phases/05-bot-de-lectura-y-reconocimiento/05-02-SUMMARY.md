---
phase: 05-bot-de-lectura-y-reconocimiento
plan: "02"
subsystem: notifications
tags: [telegram, snooze, drizzle, outbox, keyboard, madrid-time]

# Dependency graph
requires:
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "01"
    provides: carril de updates, tokens de un solo uso, applyIncidentAction y queueEdit
  - phase: 02-incidencias-y-entrega-nica
    provides: notification_outbox transaccional, escalada a crítica y edición del aviso
provides:
  - Silencio por (hostId, key) con vencimiento obligatorio de 1 h o 24 h
  - Acciones snooze y unsnooze compartidas entre Telegram y el hub
  - Supresión en la apertura, la escalada, el envío ya encolado y el push de respaldo
  - Teclado con Quitar silencio mientras dura y edición con la hora de Madrid del vencimiento
affects: [05-03, 05-04, 05-05, 05-06]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 18077
  tasks: 2
  commits: 7
  plan_head_before: df41aa8fd00ef41281c7a4a1a77fc69b53b81f0e
  plan_head_after: b064d868864225af6d35b6e3b73c49a40d5af5c

tech-stack:
  added: []
  patterns:
    - "Silencio como estado de la condición (hostId, key), nunca del episodio"
    - "Dos puntos de consulta: la escritura de la incidencia y el despacho antes de la marca de intento"
    - "Fila de entrega suprimida con motivo finito y terminal: el vencimiento no reenvía"
    - "Comparación por duración, no por vencimiento absoluto, para la idempotencia del botón"

key-files:
  created:
    - src/lib/incident-snooze.ts
    - tests/incident-snooze.test.ts
    - tests/snooze-delivery.test.ts
  modified:
    - src/lib/incident-actions.ts
    - src/lib/incident-store.ts
    - src/lib/notification-dispatch.ts
    - src/lib/telegram-keyboard.ts
    - src/lib/telegram-updates.ts
    - tests/telegram-updates.test.ts
    - .planning/config.json

key-decisions:
  - "El teclado agrupa Reconocer en su fila y los controles de silencio en otra; con silencio vivo solo queda Quitar silencio"
  - "La idempotencia compara la duración pedida con la del silencio vivo (until - setAt), no el vencimiento absoluto: pulsar 1 h otra vez no crea un segundo evento"
  - "unclearSnooze recibe el instante de la acción para decidir el detalle cleared o expired del evento"
  - "El despacho consulta el silencio una vez, tras el reclamo y antes de la marca de intento, en la apertura y en el push"
  - "La edición no se suprime nunca: solo cambia su teclado y añade la hora de Madrid del vencimiento"

patterns-established:
  - "Guardia de duración en tiempo de ejecución (RangeError) además del tipo 1 | 24"
  - "Upsert condicional con setWhere para que un plazo anterior no retroceda"

requirements-completed: [BOT-04, BOT-06]

coverage:
  - id: D1
    description: "Silenciar 1 h o 24 h desde el aviso guarda el silencio por host y clave, registra el evento y encola una edición"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/incident-snooze.test.ts#stores a one-hour silence from the pressed button"
        status: pass
      - kind: integration
        ref: "tests/incident-snooze.test.ts#stores a twenty-four hour silence from the pressed button"
        status: pass
      - kind: integration
        ref: "tests/incident-snooze.test.ts#keeps a repeated silence and extends a longer one"
        status: pass
    human_judgment: false
  - id: D2
    description: "Quitar silencio revierte el silencio activo o vencido y registra el motivo"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/incident-snooze.test.ts#removes an active silence and records the removal"
        status: pass
      - kind: integration
        ref: "tests/incident-snooze.test.ts#clears an expired silence so an obsolete button still refreshes the notice"
        status: pass
      - kind: integration
        ref: "tests/incident-snooze.test.ts#answers without a change when there is no silence to remove"
        status: pass
    human_judgment: false
  - id: D3
    description: "El teclado ofrece Silenciar cuando no hay silencio y Quitar silencio mientras dura, sin deshacer Reconocer"
    requirement: "BOT-04"
    verification:
      - kind: unit
        ref: "tests/incident-snooze.test.ts#offers silence controls only while they make sense"
        status: pass
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#still edits a sent notice while silent and offers to remove the silence"
        status: pass
    human_judgment: true
    rationale: "Que la fila de botones se vea bien en el cliente real de Telegram (etiquetas, orden y ancho) exige el móvil; queda en el human-check de fin de fase."
  - id: D4
    description: "Durante el plazo no interrumpen la reapertura, la escalada pendiente, lo ya encolado ni el push de respaldo"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#suppresses the reopening of a silenced condition until the deadline"
        status: pass
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#withholds the escalation of a silenced first notice"
        status: pass
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#suppresses a queued opening and never resends it after the deadline"
        status: pass
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#suppresses the push fallback and a push opening without touching the transport"
        status: pass
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#holds back a request when the silence arrives between the claim and the attempt mark"
        status: pass
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#also holds back a push claimed before the silence arrives"
        status: pass
    human_judgment: false
  - id: D5
    description: "Al vencer el silencio no se reenvía nada y un evento posterior vuelve a interrumpir"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#suppresses a queued opening and never resends it after the deadline"
        status: pass
      - kind: integration
        ref: "tests/snooze-delivery.test.ts#suppresses the reopening of a silenced condition until the deadline"
        status: pass
    human_judgment: false
  - id: D6
    description: "Un token de silencio repetido, caducado o de otro mensaje no cambia el estado y recibe un aviso finito"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/incident-snooze.test.ts#ignores a repeated, expired or foreign silence token"
        status: pass
    human_judgment: false
  - id: D7
    description: "Reconocer y silenciar son independientes y el silencio tiene una duración del conjunto cerrado"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/incident-snooze.test.ts#keeps acknowledging and silencing independent"
        status: pass
      - kind: integration
        ref: "tests/incident-snooze.test.ts#refuses any silence duration outside the closed set"
        status: pass
      - kind: integration
        ref: "tests/incident-snooze.test.ts#silences nothing on a resolved episode"
        status: pass
    human_judgment: false

duration: 68 min
completed: 2026-11-26
status: complete
---

# Phase 05 Plan 02: Silenciar una condición desde su aviso Summary

**Silencio por host y clave de 1 h o 24 h desde el aviso de Telegram, con Quitar silencio mientras dura, y una supresión que calla la reapertura, la escalada pendiente, lo ya encolado y el push de respaldo sin ocultar ningún evento.**

## Performance

- **Duration:** 68 min
- **Started:** 2026-11-26T13:46:09Z
- **Completed:** 2026-11-26T14:54:00Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments

- `src/lib/incident-snooze.ts` guarda el silencio de `(hostId, key)` con un vencimiento obligatorio; `activeSnooze` ignora un plazo ya vencido, `upsertSnooze` solo reemplaza por una duración mayor y `clearSnooze` distingue `cleared` de `expired`.
- Pulsar `snooze_1h` o `snooze_24h` escribe la fila, sube `seq`, registra el evento `snoozed` con el vencimiento ISO y encola una única edición silenciosa; `unsnooze` borra la fila y registra `cleared` o `expired`.
- La apertura de una condición silenciada y la escalada de un primer aviso aún no enviado dejan su fila `incident-open` en `suppressed` con motivo `snoozed`, conservando el canal y el evento.
- El despacho relee el silencio justo antes de la marca de intento en la apertura de Telegram y en el push: una fila ya reclamada se suprime sin petición, y el respaldo de un rechazo permanente deja `fallbackResult.reason` en `snoozed`.
- La edición de un aviso ya enviado sigue saliendo con el silencio activo, muestra "Silenciada hasta HH:MM" (hora de Madrid) y su teclado ofrece `unsnooze` en lugar de los dos botones de silencio.
- Un silencio de dos horas, cero o cualquier valor fuera del conjunto se rechaza con `RangeError` también cuando el llamador saltó el tipo.

## Task Commits

Cada tarea se comprometió de forma atómica, con el ciclo TDD en commits separados:

1. **Preparación: permitir commits en la rama por defecto** - `7c29a75` (chore)
2. **Tarea 1 RED: pruebas que fallan del silencio desde el aviso** - `b9de76b` (test)
3. **Tarea 1 GREEN: silencio de 1 h y 24 h y Quitar silencio** - `10bbed5` (feat)
4. **Tarea 2 RED: pruebas que fallan de la supresión de entregas** - `384084a` (test)
5. **Tarea 2 GREEN: reapertura, escalada, envío encolado y push retenidos** - `5a2b592` (feat)
6. **REFACTOR: lockEpisode como resultado discriminado** - `198db13` (refactor)
7. **Cobertura añadida: conjunto cerrado de duraciones y carrera del push** - `b064d86` (test)

**Plan metadata:** `docs(05-02)` (este archivo, STATE y ROADMAP)

## Files Created/Modified

- `src/lib/incident-snooze.ts` — `SNOOZE_HOURS`, `SNOOZE_SUPPRESSION_REASON`, `snoozeDeadline`, `activeSnooze`, `upsertSnooze` y `clearSnooze`.
- `src/lib/incident-actions.ts` — `IncidentActionInput` como unión con `snooze` y `unsnooze`; `lockEpisode`, `recordAction`, `snooze` y `unsnooze`; `acknowledge` reutiliza el bloqueo.
- `src/lib/incident-store.ts` — la apertura inmediata y `changeSeverity` consultan el silencio y dejan la fila `suppressed` con motivo `snoozed`.
- `src/lib/notification-dispatch.ts` — consulta previa a la marca de intento en `dispatchTelegramOpening` y `dispatchPushJob`; teclado y línea de vencimiento en `dispatchEdit`.
- `src/lib/telegram-keyboard.ts` — matriz completa de `keyboardActions` y filas propias para Reconocer y el silencio en `renderActionRows`.
- `src/lib/telegram-updates.ts` — ramas `snooze_1h`, `snooze_24h` y `unsnooze` de `applyTokenAction` con traducción a `applied`/`unchanged`/`ignored`.
- `tests/incident-snooze.test.ts` — pulsación real por el carril, idempotencia, extensión, Quitar silencio, independencia con Reconocer, episodios resueltos o inexistentes, matriz del teclado, tokens inválidos y duraciones.
- `tests/snooze-delivery.test.ts` — reapertura y escalada dentro y fuera del plazo, envío encolado, respaldo de push, carrera entre reclamo y marca de intento, vencimiento sin reenvío y edición con silencio.
- `tests/telegram-updates.test.ts` — la batería de 05-01 ahora afirma la fila propia de Reconocer y la de los dos botones de silencio.
- `.planning/config.json` — `git.allow_default_branch_commits: true`, el override documentado del guardián de commits.

## Decisions Made

- **Silencio de la condición, no del episodio.** La clave es `(hostId, key)` con vencimiento; la escritura de la incidencia y el despacho consultan la misma fila (D-01).
- **Idempotencia por duración.** `upsertSnooze` compara `until - setAt` del silencio vivo con la duración pedida: repetir 1 h cinco segundos después no crea un segundo evento, y 24 h sobre 1 h sí lo extiende.
- **Supresión terminal.** Una fila suprimida por silencio no se reenvía al vencer; solo un evento posterior que vuelva a evaluar una entrega inmediata sin silencio crea un `pending` (D-03).
- **Una sola consulta en el despacho.** Se lee tras el reclamo y antes de la marca de intento, tanto en la apertura como en el push; la ventana de milisegundos entre esa lectura y la marca queda aceptada (T-05-09).
- **La edición nunca se suprime.** Cambia su teclado (`unsnooze` en lugar de Silenciar) y añade la hora de Madrid del vencimiento.
- **`clearSnooze` recibe el instante de la acción** para distinguir `cleared` de `expired` en el evento; la firma mantiene los tres primeros argumentos de `<interfaces>`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] La rama por defecto estaba protegida para el guardián de commits**
- **Found during:** Preparación, antes de la primera edición
- **Issue:** `git.base-branch --is-protected main` devolvía `true` y `git allow_default_branch_commits` no existía en `.planning/config.json`, así que el guardián previo a cada commit habría detenido la ejecución en una rama que el orquestador declaró esperada (`branching_strategy: none`).
- **Fix:** Se añadió `git.allow_default_branch_commits: true`, el override documentado en el propio guardián (#3819); la consulta pasa a devolver `false`.
- **Files modified:** `.planning/config.json`
- **Verification:** `gsd-tools query git.base-branch --is-protected main` → `false`.
- **Committed in:** `7c29a75`

**2. [Rule 1 - Bug] La idempotencia comparaba vencimientos absolutos y extendía el silencio unos segundos**
- **Found during:** Tarea 1 (GREEN)
- **Issue:** El `WHERE until < EXCLUDED.until` del plan hacía que una segunda pulsación del mismo botón, segundos después, moviera el plazo y escribiera un segundo evento, incumpliendo el criterio de aceptación "una segunda pulsación con la misma duración devuelve `unchanged`".
- **Fix:** `upsertSnooze` compara la duración pedida (`until - at`) con la del silencio vivo (`until - setAt`) y solo escribe si es estrictamente mayor; el `setWhere` por vencimiento se conserva como guarda de concurrencia.
- **Files modified:** `src/lib/incident-snooze.ts`
- **Verification:** `tests/incident-snooze.test.ts#keeps a repeated silence and extends a longer one`.
- **Committed in:** `10bbed5`

**3. [Rule 1 - Bug] Una prueba de 05-01 afirmaba el teclado de un solo botón**
- **Found during:** Tarea 1 (GREEN)
- **Issue:** `tests/telegram-updates.test.ts` esperaba `inline_keyboard[1]` con un único botón y un teclado vacío tras reconocer; la matriz nueva añade la fila de silencio, así que las dos afirmaciones dejaban de describir el comportamiento.
- **Fix:** La prueba afirma ahora la fila propia de Reconocer, la fila de los dos controles de silencio y que la edición conserva dos botones sin el token de Reconocer.
- **Files modified:** `tests/telegram-updates.test.ts`
- **Verification:** `tests/telegram-updates.test.ts` en verde (9 pruebas).
- **Committed in:** `10bbed5`

---

**Total deviations:** 1 auto-fix de bloqueo y 2 de bug (uno en producto, uno en una prueba de 05-01).
**Impact on plan:** Ninguno de los tres cambia el alcance; el override de rama es el que el propio guardián documenta y la corrección de idempotencia es la que exige el criterio de aceptación.

## TDD Gate Compliance

| Gate | Commit | Evidence |
|------|--------|----------|
| RED (tarea 1) | `b9de76b` `test(05-02): add failing tests for silencing a condition from its notice` | 10 de 11 pruebas fallan por aserción: `expected 'unchanged' to be 'applied'`, `expected [ 'ack' ] to deeply equal [ 'ack', 'snooze_1h', 'snooze_24h' ]`, `expected [] to have a length of 1`. Ninguna falla por carga o sintaxis. |
| GREEN (tarea 1) | `10bbed5` `feat(05-02): silence a condition from its notice for one or twenty-four hours` | `pnpm test tests/incident-snooze.test.ts tests/telegram-updates.test.ts` → 20/20 y `pnpm typecheck` sin errores. |
| RED (tarea 2) | `384084a` `test(05-02): add failing tests for withheld deliveries during a silence` | 6 de 6 pruebas fallan por aserción: la reapertura devuelve `delivery: 'queued'` frente a `'none'`. |
| GREEN (tarea 2) | `5a2b592` `feat(05-02): withhold reopens, escalations, queued sends and push during a silence` | 4 suites de la tarea → 79/79 y `pnpm typecheck` sin errores. |
| REFACTOR | `198db13` `refactor(05-02): read the episode lock as a discriminated result` | 3 suites → 26/26 sin cambios de comportamiento. |
| Cobertura extra | `b064d86` `test(05-02): cover the closed duration set and the push claim race` | Pruebas añadidas para dos `must_haves` cuya implementación ya estaba en los GREEN de este mismo plan: el conjunto cerrado de duraciones y la carrera del push. Se documenta como cobertura posterior al ciclo. |

## Verification

- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-snooze.test.ts tests/telegram-updates.test.ts && pnpm typecheck` → 2 archivos, 21 pruebas, todas en verde; typecheck sin errores.
- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/snooze-delivery.test.ts tests/incident-store.test.ts tests/notification-dispatch.test.ts tests/incident-push.test.ts && pnpm typecheck` → 4 archivos, 80 pruebas, todas en verde; typecheck sin errores.
- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test` → 44 archivos, 583 pruebas, todas en verde (ninguna suite omitida).
- ESLint (adaptador TS 6 del proyecto) sobre los 9 archivos tocados → sin avisos.

## Issues Encountered

- La primera ejecución de la supresión por despacho puso una prueba en rojo por una expectativa mía, no por producto: el tick puede enviar la edición silenciosa del cierre además de no reenviar la reapertura. La prueba pasó a afirmar que ninguna petición `sendMessage` sale, sin exigir `idle`.

## User Setup Required

None - no external service configuration required. Sin variables de entorno, dependencias ni migraciones nuevas.

## Pending Human Verification (end-of-phase)

Aplazado al `human-check` de fin de fase por `workflow.human_verify_mode=end-of-phase`:

1. Con el bot real, pulsar Silenciar 1 h y comprobar que el mismo mensaje se edita sin sonido, muestra "Silenciada hasta HH:MM" con la hora de Madrid y ofrece Quitar silencio.
2. Provocar una reapertura del mismo host y clave dentro del plazo (flapping) y confirmar que no llega ningún aviso y que la incidencia aparece en Avisos y en el resumen.
3. Pulsar Quitar silencio y confirmar que el teclado vuelve a ofrecer Silenciar 1 h y Silenciar 24 h.
4. Comprobar que tras vencer el plazo no llega ningún mensaje retenido.

## Next Phase Readiness

- El modelo de silencio, sus dos puntos de consulta y la matriz del teclado quedan fijados para 05-03 (Por qué), 05-04 (Avisos y resumen) y 05-05 (limpieza del silencio vencido).
- `applyIncidentAction` acepta ya `via: "hub"` con `by`, que es lo que la ruta del hub de 05-04 necesita; `keyboardActions` y `applyTokenAction` siguen teniendo `why` como único punto de extensión pendiente.
- La proyección pública de Avisos aún mapea un motivo desconocido a `policy_silent`: la etiqueta y el motivo `snoozed` son de 05-04.
- BOT-04 y BOT-06 los declaran también planes hermanos; `requirements.ready-ids` los mantiene bloqueados hasta que el último plan de la fase publique su SUMMARY.

---
*Phase: 05-bot-de-lectura-y-reconocimiento*
*Completed: 2026-11-26*

## Self-Check: PASSED

- Los ocho archivos creados o modificados de código y pruebas existen en disco.
- Los commits `7c29a75`, `b9de76b`, `10bbed5`, `384084a`, `5a2b592`, `198db13` y `b064d86` son ancestros de HEAD.
- `pnpm typecheck` sin errores y la suite completa en verde (44 archivos, 583 pruebas).
