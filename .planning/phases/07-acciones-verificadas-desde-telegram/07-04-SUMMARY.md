---
phase: 07-acciones-verificadas-desde-telegram
plan: "04"
subsystem: telegram-bot
tags: [telegram, intents, operation-runner, reboot, runtime-config, vitest, postgres]

requires:
  - phase: 07-acciones-verificadas-desde-telegram
    provides: "07-02: handleIntentExecute con guard, reclamo atómico y 501 para start, restart y reboot; executeHostCommand con channel y requestedBy"
  - phase: 06-puerta-de-seguridad
    provides: "manifiesto de acciones sensibles y guardSensitiveAction"
provides:
  - "src/lib/operation-runner.ts: runAgentAction y loadLatestSample, extraídos de /api/action"
  - "execute ejecuta start, restart y reboot desde el intent; ya ninguna acción responde 501"
  - "channel y requestedBy en toda operación nueva de /api/action, /api/host-command y de intents"
  - "TELEGRAM_DIRECT_ACTIONS: solo 0 o ausente; otro valor falla el arranque"
affects: [07-05]

actuals:
  tokens: 10700
  tasks: 3
  commits: 5
plan_head_before: f124b9c7ae02a58087ecce6c4739eaef8a7c82cc
plan_head_after: 663edf13e0b4882b29c54b1d4294c6db14267942

tech-stack:
  added: []
  patterns:
    - "El ejecutor devuelve un resultado neutro (unavailable, duplicate, success, requested, failed, uncertain) y cada llamador lo traduce a su HTTP"
    - "El id del contenedor se resuelve por nombre sobre la última muestra al ejecutar, nunca al crear el intent"
    - "Los prechequeos (403, 503, 409) responden antes del reclamo y no consumen el intent"

key-files:
  created:
    - src/lib/operation-runner.ts
  modified:
    - src/app/api/[...path]/route.ts
    - src/lib/telegram-intent-api.ts
    - src/lib/runtime-config.ts
    - .env.example
    - README.md
    - tests/api-lifecycle.test.ts
    - tests/api-telegram-intents.test.ts
    - tests/runtime-config.test.ts

key-decisions:
  - "P-16: runAgentAction devuelve un resultado neutro; el replay idempotente y el guard siguen en quien llama, antes del runner"
  - "P-17: start y restart resuelven el id de 64 hex por nombre al ejecutar; nombre ausente responde 409 container_gone sin reclamar y muestra obsoleta 503 sin reclamar"
  - "P-18: un reboot aceptado deja la operación pending con el detalle de reinicio solicitado y cierra el intent como executed; el colector confirma por bootAt"
  - "P-19: RuntimeConfig no gana campo para TELEGRAM_DIRECT_ACTIONS; se valida en una función aparte y no se lee en ningún otro sitio"

patterns-established:
  - "Un resultado failed o uncertain lleva settled cuando otro escritor ya había cerrado la operación, para que la ruta responda como antes (la fila tal cual)"

requirements-completed: [BOT-07, BOT-08, BOT-09]

coverage:
  - id: D1
    description: "/api/action conserva el código y el cuerpo de cada acción tras extraer el runner: las suites de acciones, comandos de host y manifiesto pasan sin cambiar una aserción"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/api-lifecycle.test.ts, tests/api-host-commands.test.ts, tests/sensitive-actions.test.ts (147 pruebas, antes y después del refactor)"
        status: pass
    human_judgment: false
  - id: D2
    description: "restart desde un intent envía una sola petición /action con el id de 64 hex resuelto por nombre; la operación guarda id igual al del intent, channel telegram y requestedBy; el intent queda executed y repetir el token no reenvía"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#restarts a container once from the chat handoff through the shared runner"
        status: pass
    human_judgment: false
  - id: D3
    description: "Toda operación nueva queda con canal y solicitante: /api/action y /api/host-command con hub y el usuario de la sesión, los intents con telegram"
    requirement: "BOT-09"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#records the channel and the requester of an operation by the surface that asked"
        status: pass
      - kind: integration
        ref: "tests/api-lifecycle.test.ts#records the hub channel and the session user on an operation from /api/action"
        status: pass
    human_judgment: false
  - id: D4
    description: "start se ejecuta con solo sesión; restart y reboot piden verificación reciente (403 sin consumir el intent)"
    requirement: "BOT-08"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#answers 403 to every protected stored action without verification, and runs start with the session alone"
        status: pass
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#asks for a recent verification before restart and reboot"
        status: pass
    human_judgment: false
  - id: D5
    description: "reboot envía la confirmación desde el servidor, deja la operación pending con bootAt de la muestra y el intent executed; un rechazo 4xx del agente (ALLOW_REBOOT=false) deja ambos failed con el motivo y no reenvía"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#requests the reboot with the server confirmation and leaves the operation pending"
        status: pass
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#closes operation and intent as failed with the agent reason when the reboot is refused"
        status: pass
    human_judgment: false
  - id: D6
    description: "Nombre de contenedor ausente responde 409 y muestra obsoleta 503 sin reclamar el intent; un contenedor recreado se resuelve por su id actual; una respuesta perdida deja uncertain sin reenvío"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#agent actions"
        status: pass
    human_judgment: false
  - id: D7
    description: "TELEGRAM_DIRECT_ACTIONS ausente, vacío o 0 no falla y no añade campo a RuntimeConfig; cualquier otro valor lanza RuntimeConfigError con incidencia invalid sin repetir el valor; .env.example y el README lo documentan"
    requirement: "BOT-08"
    verification:
      - kind: unit
        ref: "tests/runtime-config.test.ts#accepts TELEGRAM_DIRECT_ACTIONS / rejects TELEGRAM_DIRECT_ACTIONS"
        status: pass
      - kind: other
        ref: "grep -q 'TELEGRAM_DIRECT_ACTIONS=0' .env.example && grep -q TELEGRAM_DIRECT_ACTIONS README.md"
        status: pass
    human_judgment: false
  - id: D8
    description: "El carril de updates (telegram-updates, telegram-intents, telegram-keyboard) sigue sin importar operation-runner, host-commands, lifecycle ni nas"
    requirement: "BOT-08"
    verification:
      - kind: unit
        ref: "tests/sensitive-actions.test.ts#lane"
        status: pass
    human_judgment: false
  - id: D9
    description: "El reinicio real del host y la acción real de un contenedor desde el handoff, en el dispositivo del operador"
    requirement: "BOT-07"
    verification: []
    human_judgment: true
    rationale: "El reinicio físico del host y el contenedor real solo se comprueban en el UAT manual de 07-VALIDATION.md; las pruebas usan un agente falso."

duration: 10min
completed: 2026-11-27
status: complete
---

# Phase 7 Plan 04: start, restart y reboot desde el handoff Summary

**`restart`, `start` y `reboot` se ejecutan desde el intent por el mismo `runAgentAction` que `/api/action`, con el id del contenedor resuelto por nombre al ejecutar, canal y solicitante registrados en las dos superficies y `TELEGRAM_DIRECT_ACTIONS` limitado a `0`.**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-11-27T18:50Z
- **Tasks:** 3
- **Files modified:** 9 (1 creado)

## Accomplishments

- `src/lib/operation-runner.ts` contiene lo que la rama `action` de `/api/action` hacía tras el guard: muestra reciente, inserción con canal, solicitante y `bootAt`, llamada al agente y cierre. La ruta conserva replay, guard y validación, y traduce el resultado a los mismos cuerpos y códigos.
- `handleIntentExecute` ejecuta `start`, `restart` y `reboot`; el 501 `action_unavailable` desaparece. Orden: cuerpo, búsqueda por hash, estado, guard (403), host y muestra reciente (503), contenedor por nombre (409), reclamo, ejecución, cierre y edición `:done`.
- BOT-09 cerrado: `/api/action` y `/api/host-command` guardan `channel = hub` y `requestedBy` igual al usuario de la sesión; los intents, `telegram`. Las filas anteriores no se tocan.
- `TELEGRAM_DIRECT_ACTIONS` se valida en una función propia de `runtime-config.ts`; sin campo en `RuntimeConfig`.

## API de `operation-runner.ts`

`runAgentAction({ host, userId, body, operationId, channel, requestedBy })` con `body` del tipo de `actionSchema`; `loadLatestSample(hostId)`.

| Resultado | Cuándo | `/api/action` (igual que antes) |
| --- | --- | --- |
| `unavailable` | sin muestra o más vieja que `CONNECTION_STALE_MS` | 503 `{ error }` |
| `duplicate` | la inserción no escribió (carrera) | 200 `{ status: "pending" }` |
| `success` | cierre genérico o `finalizeContainerOperation` | 200 `{ ok, status: "success", result }` |
| `requested` | reboot aceptado; operación `pending` con el detalle de reinicio | 200 `{ ok, status: "pending", result }` |
| `failed` | `NasRejected` menor de 500 | 400 `{ error, status: "failed" }`; si la fila ya estaba cerrada, 200 con la fila |
| `uncertain` | timeout o error 5xx | 502 `{ error, status: "pending" }`; si la fila ya estaba cerrada, 200 con la fila |

`failed` y `uncertain` añaden `settled?` (la fila) para conservar el segundo caso, que la forma `{ status, error }` del plan no cubría.

## Equivalencia de `/api/action`

Las suites `api-lifecycle`, `api-host-commands` y `sensitive-actions` (147 pruebas) estaban en verde antes de tocar nada y siguen en verde tras la extracción sin cambiar una sola aserción de código HTTP ni de cuerpo (T-07-14). El único cambio funcional de la ruta es que ahora escribe `channel` y `requestedBy`.

## Tratamiento de `reboot` (P-18, D-12)

El handler construye el cuerpo con la confirmación que exige `actionSchema`, tipada contra el esquema, de modo que el hub no pide la frase: el handoff pide un toque y la passkey (el manifiesto exige verificación reciente). El agente puede rechazar con `ALLOW_REBOOT=false`: la operación y el intent quedan `failed` con el motivo del agente y no se reenvía. Si lo acepta, la operación queda `pending` con `bootAt` y el detalle «Reinicio solicitado»; el intent se cierra como `executed` y el colector confirma el arranque como hoy.

## Evidencia de `TELEGRAM_DIRECT_ACTIONS` (D-00a)

Ausente, vacía o `0`: la configuración es idéntica a la de siempre. Con `1`, `true`, `yes` o `00`: `RuntimeConfigError` con `{ variable: "TELEGRAM_DIRECT_ACTIONS", reason: "invalid" }` y el valor no aparece en el mensaje. `.env.example` la documenta como `# TELEGRAM_DIRECT_ACTIONS=0` y el README explica que el botón solo abre el handoff.

## Task Commits

1. **Tarea 1 (tracer): restart por el runner extraído** - `940def0` (feat)
2. **Tarea 2: start, reboot y bordes (TDD)** - `c2c9553` (test, RED) y `3add220` (feat, GREEN)
3. **Tarea 3: TELEGRAM_DIRECT_ACTIONS (TDD)** - `3071918` (test, RED) y `663edf1` (feat, GREEN)

**Plan metadata:** commit `docs(07-04)` posterior a este fichero.

## Files Created/Modified

- `src/lib/operation-runner.ts` - `runAgentAction`, `loadLatestSample` y el tipo del resultado.
- `src/app/api/[...path]/route.ts` - la rama `action` llama al runner con `channel: "hub"`; imports de `lifecycle` y `nas` recortados.
- `src/lib/telegram-intent-api.ts` - `agentBodyOf`, `runAgentIntent`, `runHostCommandIntent` y el cierre común por `Closing`.
- `src/lib/runtime-config.ts` - `telegramDirectActions`.
- `.env.example`, `README.md` - documentación de la variable.
- `tests/api-lifecycle.test.ts`, `tests/api-telegram-intents.test.ts`, `tests/runtime-config.test.ts` - pruebas de comportamiento (estados, filas y peticiones, nunca copy).

## Decisions Made

P-16 a P-19 como en el plan (ver `key-decisions`). Adicional: un `duplicate` tras el reclamo (no ocurre en el flujo normal, porque el id de la operación es el del intent) cierra el intent según el estado de la fila existente en lugar de dejarlo en `executing`.

## Deviations from Plan

None - plan executed exactly as written.

Detalle menor sin cambio de alcance: la prueba de la matriz por acción de 07-02 ahora ejecuta `start` dentro del bucle; como un intent ejecutado encola su edición `:done`, el bucle limpia el outbox para que el siguiente handoff encuentre su aviso como primera entrega. Es un ajuste del propio arnés de pruebas.

## TDD Gate Compliance

Tareas 2 y 3 (`tdd="true"`): RED `c2c9553` (7 fallos de aserción: 501 en lugar de 200, 400, 409 y 503) y GREEN `3add220`; RED `3071918` (4 fallos: «expected readRuntimeConfig to reject») y GREEN `663edf1`. El plan no es de tipo `tdd`, así que no se pasó `check tdd-red-evidence`; el RED de cada tarea se inspeccionó a mano y falla por la aserción prevista.

## Issues Encountered

- Suite completa con la base desechable `hub-phase7-01-pg`: 58 ficheros, 953 pruebas en verde; `pnpm typecheck` limpio; `pnpm lint src/lib tests src/app/api` limpio (el lint global sigue fallando por las carpetas de herramientas sin seguimiento, ya registrado en 07-01).

## Known Stubs

Ninguno.

## Threat Flags

Ninguno fuera del registro del plan. T-07-13 (accept, reboot sin frase tecleada), T-07-14, T-07-15 y T-07-16 quedan cubiertos como en el plan; T-07-SC sin paquetes nuevos.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 07-05 puede consumir `inspect` y `execute` para las cinco acciones, incluida la respuesta de `reboot` (`status: "pending"` con la operación `pending`).
- Queda para el UAT manual de la fase el reinicio real del host y la acción real de un contenedor (D9).

## Self-Check: PASSED

`src/lib/operation-runner.ts` existe; los cinco commits (`940def0`, `c2c9553`, `3add220`, `3071918`, `663edf1`) son ancestros de HEAD; `git rev-list --count` desde `plan_head_before` da 5.

---
*Phase: 07-acciones-verificadas-desde-telegram*
*Completed: 2026-11-27*
