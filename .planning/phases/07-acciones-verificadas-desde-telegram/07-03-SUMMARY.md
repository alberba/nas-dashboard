---
phase: 07-acciones-verificadas-desde-telegram
plan: "03"
subsystem: telegram-bot
tags: [telegram, keyboard, outbox, intents, vitest, postgres]

requires:
  - phase: 07-acciones-verificadas-desde-telegram
    provides: "plan 01: estados del intent, queueKeyboardEdit, keyboardView en el outbox, botón url del handoff"
provides:
  - "menú «Acciones…» / «Volver» que edita el aviso en silencio por el outbox (vista del teclado en la fila :open)"
  - "cancelLiveIntent e intent_cancel: un solo intent vivo por aviso y restauración del teclado"
  - "fila de outbox :expire con nextAttemptAt = expiresAt y caducidad perezosa en cada render"
  - "línea de resultado con la hora de Madrid del último intent terminal"
  - "retención de intents de 24 h tras caducar, contada como intents en la limpieza"
affects: [07-02, 07-04, 07-05]

actuals:
  tokens: 45000
  tasks: 3
  commits: 5
plan_head_before: ede311c5fb54a093eb3b6456d93d93044325b6b3
plan_head_after: 6f26f54f22caa6336d41a3967784df66eeae1846

tech-stack:
  added: []
  patterns:
    - "El teclado es función del estado de la base: composeActionRows recompone vista, intent vivo y episodio en cada render"
    - "Una edición por pulsación: discriminador m<16 hex del tokenHash consumido, idempotente si la transacción se repite"
    - "La caducidad visible se descubre con una fila de outbox con nextAttemptAt, sin barrido ni temporizador nuevo"

key-files:
  created:
    - tests/telegram-keyboard.test.ts
  modified:
    - src/lib/telegram-keyboard.ts
    - src/lib/incident-actions.ts
    - src/lib/telegram-updates.ts
    - src/lib/telegram-intents.ts
    - src/lib/notification-dispatch.ts
    - src/lib/telegram-cleanup.ts
    - src/lib/schema.ts
    - tests/telegram-intents.test.ts
    - tests/telegram-lane-hardening.test.ts

key-decisions:
  - "P-12: la vista del teclado (normal o actions) vive en notification_outbox.keyboardView de la fila :open; consumeActionToken devuelve tokenHash y cada edición de menú usa m<hash16>"
  - "P-13: createIntent encola la fila :expire con notBefore = expiresAt y dispatchEdit cierra los intents vencidos antes de renderizar; el render restaura el teclado aunque el intent ya se hubiera ejecutado o cancelado"
  - "P-14: la línea de resultado usa un Record<IntentActionId, string> privado y redacta reboot como reinicio solicitado; actuar no reconoce la incidencia"
  - "P-15: los intents se retienen 24 h tras expiresAt y la limpieza los cuenta como intents"

requirements-completed: [BOT-07]

coverage:
  - id: D1
    description: "El aviso ofrece «Acciones…» solo si la incidencia está abierta, ofrece acciones y no hay intent vivo; pulsarlo y «Volver» alternan el teclado con ediciones silenciosas del mismo mensaje, sin mensajes nuevos"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#opens and closes the menu with silent edits of the same message"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#offers the menu on a notice with actions and not on one without"
        status: pass
    human_judgment: false
  - id: D2
    description: "Un token de menú repetido o pulsado con la incidencia resuelta, sin acciones o con un intent vivo no edita el aviso"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#does not repeat the effect of a token that was already used"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#ignores a menu press once the episode is resolved"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#does not open the menu while an intent is live"
        status: pass
    human_judgment: false
  - id: D3
    description: "Con un intent vivo el teclado muestra el botón url y «Cancelar»; cancelar invalida el intent y restaura el menú sin enlace; un segundo cancelar o una acción nueva no crean otro enlace"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#cancels the intent and restores the normal keyboard in silence"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#keeps a single link when an action is pressed while an intent is live"
        status: pass
    human_judgment: false
  - id: D4
    description: "La fila :expire no se entrega antes de expiresAt y después restaura el teclado en silencio sin botón url y deja el intent expired; tras caducar, una acción nueva crea otro intent"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#queues the expiry row at expiresAt and delivers it only then"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#lets a new action create another intent after the previous one expired"
        status: pass
    human_judgment: false
  - id: D5
    description: "Reglas de resolución D-05 y D-06 y matriz pura de teclados por estado; callback_data v1 más 22 caracteres y 25 bytes; actualizar, detener y eliminar nunca se ofrecen"
    requirement: "BOT-07"
    verification:
      - kind: unit
        ref: "tests/telegram-keyboard.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Tras executed, failed o uncertain el aviso muestra la hora de Madrid del cierre, el teclado vuelve al estado normal y la incidencia no queda reconocida"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#result of the action"
        status: pass
    human_judgment: false
  - id: D7
    description: "La limpieza horaria elimina los intents con más de 24 h desde su caducidad, conserva los recientes y los cuenta aparte"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#prunes expired tokens and silences without touching live state"
        status: pass
    human_judgment: false
  - id: D8
    description: "Comportamiento de «Acciones…» en un dispositivo real de Telegram y avisos de contenedor y reboot-pending sin superficie real hoy en Telegram"
    requirement: "BOT-07"
    human_judgment: true
    rationale: "Backstop del plan: se revisa en el UAT manual de 07-VALIDATION.md con backup-failed y deploy-failed (D-11)"

duration: 5min
completed: 2026-11-27
status: complete
---

# Phase 7 Plan 03: menú de acciones, cancelación y caducidad en el chat Summary

**El aviso de Telegram ofrece las acciones detrás de «Acciones…» / «Volver», muestra un único enlace de confirmación con «Cancelar», se restaura en silencio al cancelar o caducar mediante una fila de outbox con `nextAttemptAt`, y muestra el resultado con la hora de Madrid; todo con ediciones silenciosas del mismo mensaje y un teclado que es función del estado de la base.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-11-27T18:31:00Z
- **Completed:** 2026-11-27T18:37:00Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Teclado por vista (`normal`, `actions`, intent vivo): `keyboardActions` y `renderActionRows` cubren abierto con y sin acciones, menú, intent vivo, resuelto con y sin intent vivo, silenciado y reconocido; sin acciones ofrecidas el teclado es idéntico al de antes.
- Carril: `menu_open` y `menu_close` cambian `keyboardView` de la fila `:open` y encolan una edición `m<hash16>` por pulsación; `intent_cancel` invalida el intent con un único `UPDATE` condicional y restaura el menú. Los botones viejos o repetidos son `unchanged` o `ignored` sin editar.
- Caducidad (D-09): `createIntent` encola `incident:<id>:kb:i<intentId>:expire` con `nextAttemptAt = expiresAt` y `dispatchEdit` marca `expired` los intents vencidos antes de renderizar, de modo que ningún render deja un enlace muerto a la vista.
- Resultado (BOT-07): línea con verbo en pasado, objetivo y hora de Madrid del último intent terminal; no reconoce la incidencia.
- Limpieza: `INTENT_RETENTION_AFTER_EXPIRY_MS` y contador `intents` en `cleanupTelegramState`.

## Task Commits

1. **Task 1: Acciones… y Volver editan el aviso en silencio** (tracer) - `7473669` (feat)
2. **Task 2: cancelar y caducar** (TDD) - RED `6cce321` (test), GREEN `3f26c15` (feat)
3. **Task 3: resolución, resultado y limpieza** (TDD) - RED `d8641c3` (test), GREEN `6f26f54` (feat)

Tracer feedback gate: tras la tarea 1 se volvió a ejecutar el `<verify>` completo (5 suites, 75 pruebas, `tsc`) antes de expandir. Verde.

## Decisions Made

P-12 a P-15 tal y como los fija el plan (ver `key-decisions`). Además:

- El teclado de la apertura y el de las ediciones se componen con un único `composeActionRows`, de modo que la apertura y las ediciones no pueden diverger.
- Un `intent_cancel` pulsado con la incidencia ya resuelta sigue funcionando (D-05): `cancelLiveIntent` no mira la resolución.
- `answerText` responde «No se pudo aplicar» a una pulsación de menú que el estado ya no permite, en lugar de «Sin cambios».

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Prueba de 07-01 acoplada al número de ediciones de teclado al crear un intent**
- **Found during:** Task 2
- **Issue:** `queues a keyboard-only edit in the transaction that creates the intent` esperaba exactamente una fila `:kb:` y ahora `createIntent` encola además la fila `:expire` que exige este plan.
- **Fix:** la prueba comprueba las dos filas (`:open` y `:expire`, con su revisión).
- **Files modified:** tests/telegram-intents.test.ts
- **Commit:** 3f26c15

**2. [Rule 3 - Interface] `renderActionRows` sin `options.view`**
- **Found during:** Task 1
- **Issue:** el contrato del plan menciona `options.view`, pero los tokens emitidos ya determinan la vista (las `act_*` y `menu_close` solo existen en la vista de acciones), así que la opción sería un parámetro sin efecto.
- **Fix:** `renderActionRows(issued, { confirm? })`; la vista entra por `keyboardActions`, que decide qué tokens se emiten.
- **Files modified:** src/lib/telegram-keyboard.ts
- **Commit:** 7473669

**Total deviations:** 2 auto-fixed (1 bug de prueba, 1 interfaz). **Impact:** ninguno en el comportamiento pedido.

## Issues Encountered

- `tests/migrations.test.ts` agotó su tiempo (5 s de la prueba, o 10 s del hook) en una de las ejecuciones completas por carga de la base compartida; en aislamiento pasa 12 de 12. Es ajeno a este plan (no toca migraciones) y no se tocó.
- `pnpm lint` sin argumentos recorre los directorios de herramientas sin seguimiento (`.opencode/`, `.codex/`, etc.) y falla por ellos; se ejecutó `pnpm lint src tests`, limpio.

## Known Stubs

None.

## Threat Flags

None. No hay superficie de red, de autenticación ni de esquema nueva: los botones nuevos usan el mismo token de un solo uso y el mismo carril autorizado que Reconocer y Silenciar (T-07-10 y T-07-11 mitigados con la fila `:expire`, la caducidad perezosa y el `UPDATE` condicional).

## Next Phase Readiness

Listo para el resto de la fase. El worker ya consume `finishIntent` + edición `:done` (07-02); la línea de resultado se pinta en cualquier edición posterior al cierre.

## Self-Check: PASSED

- Archivos: `tests/telegram-keyboard.test.ts` y `07-03-SUMMARY.md` existen.
- Commits `7473669`, `6cce321`, `3f26c15`, `d8641c3`, `6f26f54` presentes en la rama.
- `pnpm test` (934 pruebas, 933 en verde y 1 de migraciones con timeout de carga que pasa en aislamiento), `pnpm typecheck` y `pnpm lint src tests` en verde.
