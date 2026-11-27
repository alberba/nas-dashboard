---
phase: 07-acciones-verificadas-desde-telegram
plan: "02"
subsystem: telegram-bot
tags: [telegram, intents, handoff, verification, manifest, vitest, postgres]

requires:
  - phase: 07-acciones-verificadas-desde-telegram
    provides: "07-01: ciclo de vida del intent (findIntentByToken, claimIntent, finishIntent, releaseIntent), queueKeyboardEdit, botón url con el token en el fragmento; 07-06: factor de verificación decidido por Host"
  - phase: 06-puerta-de-seguridad
    provides: "manifiesto de acciones sensibles y guardSensitiveAction"
provides:
  - "POST /api/telegram/intents/inspect y /execute en routeManifest, con su fila de 413"
  - "src/lib/telegram-intent-api.ts: handleIntentInspect y handleIntentExecute"
  - "guardIntentAction y requiresVerificationForIntent sobre las tablas de la fase 6"
  - "executeHostCommand con channel y requestedBy; hostCommandResponse compartido"
affects: [07-03, 07-04, 07-05]

actuals:
  tokens: 11200
  tasks: 3
  commits: 4
plan_head_before: 1444bf61c609d896f19dd21cd1ffdfacfe0275b3
plan_head_after: d833ca2d731b44301c28b1f0d0b9f709bff70ac9

tech-stack:
  added: []
  patterns:
    - "El hub decide lo protegido por la acción almacenada en el intent y el manifiesto, nunca por el cuerpo"
    - "Reclamo atómico antes de enviar nada al agente; operations.id igual al id del intent como segunda barrera"
    - "403, 503 y 501 responden antes del reclamo: no consumen el intent"

key-files:
  created:
    - src/lib/telegram-intent-api.ts
    - tests/api-telegram-intents.test.ts
  modified:
    - src/lib/sensitive-actions.ts
    - src/lib/verification-api.ts
    - src/lib/host-commands.ts
    - src/app/api/[...path]/route.ts
    - tests/sensitive-actions.test.ts

key-decisions:
  - "P-07: dos rutas con literal exacto, token de 43 caracteres solo en el cuerpo con z.strictObject; Idempotency-Key ignorada, el id de la operación es intent.id"
  - "P-08: guardIntentAction envuelve guardSensitiveAction; sesión ajena responde el mismo 404 intent_unknown que un token desconocido"
  - "P-09: orden de execute: cuerpo, búsqueda por hash, estado (410 o replay), guard (403), 501, host y muestra reciente (503), reclamo, ejecución, cierre y edición :done en una transacción"
  - "P-10: success a executed, rechazo a failed, pending a uncertain; unavailable tras el reclamo lo libera con releaseIntent"
  - "P-11: CR-01 lo corrige 07-06 (D-13); 07-02 solo lo prueba contra execute"
  - "El guard va antes del 501: restart y reboot sin verificación responden 403 aunque el hub aún no los ejecute"

patterns-established:
  - "Las pruebas que construyen varios handoffs seguidos liberan el candado de colección al terminar cada uno (client.end)"

requirements-completed: [BOT-07, BOT-08, BOT-09]

coverage:
  - id: D1
    description: "execute con sesión y verificación reciente ejecuta backup-now una sola vez; la operación queda con id igual al del intent, channel telegram y requestedBy igual al usuario del hub, y el intent queda executed"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#runs backup-now once from the chat handoff and records channel and requester"
        status: pass
    human_judgment: false
  - id: D2
    description: "Una acción protegida sin verificación reciente responde 403 recent_verification_required sin consumir el intent, sin operación y sin petición al agente; start no responde 403"
    requirement: "BOT-08"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#answers 403 to every protected stored action without verification, and not to start"
        status: pass
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#answers 403 without a recent verification and leaves the intent pending"
        status: pass
    human_judgment: false
  - id: D3
    description: "El cuerpo no puede bajar la protección (campo extra responde 400) y requiresVerificationForIntent coincide con el manifiesto de la fase 6 para cada acción de intent"
    requirement: "BOT-08"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#lets a body with an extra action neither lower nor raise the protection"
        status: pass
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#keeps the intent decision on the phase 6 manifest for every intent action"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-13: con un Origin alternativo falsificado sobre el host principal y una verificación password, execute responde 403 con método passkey sin consumir el intent; la entrada alternativa genuina sí ejecuta"
    requirement: "BOT-08"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#does not run a protected intent on the primary host with a forged Origin and a password verification"
        status: pass
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#lets the genuine alternate entry run it with a password verification"
        status: pass
    human_judgment: false
  - id: D5
    description: "Dos execute concurrentes envían una sola petición al agente; caducado o cancelado responde 410; ya ejecutado devuelve la operación existente; un host sin muestra reciente responde 503 sin reclamar; un reclamo sin envío se libera"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#execute states"
        status: pass
    human_judgment: false
  - id: D6
    description: "inspect distingue ready, expired, cancelled y consumed, informa requiresVerification e incident.resolved, no consume el intent y responde el mismo 404 para token desconocido y ajeno"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#inspect"
        status: pass
    human_judgment: false
  - id: D7
    description: "El carril (telegram-updates, telegram-intents, telegram-keyboard) no importa operation-runner, host-commands, lifecycle ni nas, y el escaneo falla ante una importación prohibida"
    requirement: "BOT-08"
    verification:
      - kind: unit
        ref: "tests/sensitive-actions.test.ts#lane"
        status: pass
    human_judgment: false
  - id: D8
    description: "Un rechazo 4xx del agente deja operación e intent failed; una respuesta perdida deja la operación pending y el intent uncertain, sin reenviar"
    requirement: "BOT-09"
    verification:
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#closes the intent as failed when the agent rejects the command"
        status: pass
      - kind: integration
        ref: "tests/api-telegram-intents.test.ts#leaves a lost reply pending and the intent uncertain without resending"
        status: pass
    human_judgment: false
  - id: D9
    description: "La passkey dentro del navegador interno de Telegram (A1 de la research) abre y completa el handoff de punta a punta"
    requirement: "BOT-07"
    verification: []
    human_judgment: true
    rationale: "Comportamiento del navegador interno de Telegram y de WebAuthn en un dispositivo real; ninguna prueba automática lo reproduce. Va al UAT manual de la fase."

duration: 10min
completed: 2026-11-27
status: complete
---

# Phase 7 Plan 02: completar en el hub la acción del chat Summary

**`POST /api/telegram/intents/execute` ejecuta una sola vez, con sesión y verificación reciente cuando el manifiesto de la fase 6 la exige, el `backup-now` o el `deploy-now` registrados por el chat, dejando la operación con `channel = telegram` y el usuario del hub; `inspect` explica el estado del intent sin consumirlo.**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-11-27T18:27Z
- **Tasks:** 3
- **Files modified:** 7 (2 creados)

## Accomplishments

- Rutas `telegram/intents/inspect` (exenta) y `telegram/intents/execute` (por elemento sobre la unión de `actionPolicies` y `hostCommandPolicies`) en `routeManifest`, con literales exactos en el catch-all y sus filas de 413.
- `guardIntentAction` decide por la acción almacenada y delega en `guardSensitiveAction`; el 403 no consume el intent, no registra operación y no toca al agente. D-13 queda probado contra `execute` con un `Origin` falsificado.
- `executeHostCommand` acepta `channel` y `requestedBy`; `hostCommandResponse` es ahora el mapeo compartido de resultado a HTTP.
- Estados del intent: 410 caducado o cancelado, replay si ya se reclamó, 503 sin muestra reciente antes del reclamo, `releaseIntent` si el ejecutor no envió nada, cierre más edición `:done` en una transacción.
- Escaneo estático que falla si el carril importa un ejecutor.

## Contratos

`inspect` (200): `{ state: "ready" | "expired" | "cancelled" | "consumed", action, verb, target, host: { id, name }, incident: { id, resolved }, requiresVerification, expiresAt, operation? }`. `host.name` cae al id si el host ya no está configurado.

`execute`: misma forma que `/api/action` (`{ ok: true, status, operation }` con 200 para éxito y replay; 400, 502, 409 y 503 como `runHostCommand`); un reclamo perdido en carrera devuelve 200 con la operación o `{ ok: true, status: "pending" }` si aún no existe.

| Código | Cuándo |
| --- | --- |
| 200 | éxito, replay de un intent ya reclamado, o carrera perdida |
| 400 | cuerpo con campos de más o token mal formado; agente que rechaza (4xx) |
| 401 | sin sesión (catch-all) |
| 403 `recent_verification_required` | acción protegida sin verificación reciente |
| 404 `intent_unknown` | token desconocido, de otro usuario o acción fuera del conjunto |
| 410 `intent_expired` / `intent_cancelled` | caducado o cancelado |
| 413 | cuerpo sobre el límite |
| 501 `action_unavailable` | `start`, `restart`, `reboot` hasta que 07-04 cablee el runner |
| 502 | respuesta del agente perdida: operación `pending`, intent `uncertain` |
| 503 | host sin muestra reciente (sin reclamar) o agente no disponible (reclamo liberado) |

Orden de `execute`: sesión y Origin (catch-all), cuerpo, búsqueda por hash, estado, guard, 501, host y muestra reciente, reclamo atómico, ejecución con `operationId = intent.id`, cierre y edición `:done`.

## Task Commits

1. **Tarea 1 (tracer): del aviso a la operación** - `ef72128` (feat)
2. **Tarea 2: inspect y estados del intent (TDD)** - `e162fe3` (test, RED) y `da21aa8` (feat, GREEN)
3. **Tarea 3: el manifiesto manda** - `d833ca2` (test)

**Plan metadata:** commit `docs(07-02)` posterior a este fichero.

## Files Created/Modified

- `src/lib/telegram-intent-api.ts` - `handleIntentInspect` y `handleIntentExecute`.
- `src/lib/sensitive-actions.ts` - rutas de intents y `requiresVerificationForIntent` (falla cerrado si el id no está en ninguna tabla).
- `src/lib/verification-api.ts` - `guardIntentAction`.
- `src/lib/host-commands.ts` - `channel`, `requestedBy`, `OperationChannel`, `hostCommandResponse`.
- `src/app/api/[...path]/route.ts` - dos literales que delegan en los handlers.
- `tests/api-telegram-intents.test.ts` - del callback a la operación, estados, concurrencia, matriz por acción y D-13.
- `tests/sensitive-actions.test.ts` - filas de 413, coherencia del manifiesto y escaneo del carril.

## Decisions Made

P-07 a P-11 como en el plan (ver `key-decisions`). Adicional: el guard precede al 501, de modo que `restart` y `reboot` sin verificación responden 403 (la matriz de la tarea 3 lo exige) y `start` responde 501 sin pedir passkey. T-07-06 queda mitigado por 07-06 (D-13): este plan no toca `verificationMethodForRequest` y solo prueba que el handoff no lo rodea.

## Deviations from Plan

None - plan executed exactly as written.

Detalles menores sin cambio de alcance: la prueba «gives the claim back when the executor sent nothing» llama a `handleIntentExecute` directamente con `now` inyectado (la ruta no admite reloj), y `handoffFor` libera el candado de colección al terminar para poder encadenar varios handoffs en una prueba. En la tarea 2 los casos de token ajeno y de 501 ya pasaban en RED porque el tracer los cubría; se mantienen como guardas de regresión.

## TDD Gate Compliance

Tarea 2 (`tdd="true"`): RED `e162fe3` (18 fallos de aserción: 404 en lugar de 200/410/400 y estados ausentes) y GREEN `da21aa8`. La tarea 3 es solo de pruebas y no tiene GREEN de producción: el comportamiento que prueba ya existía por las tareas 1 y 2. El plan no es de tipo `tdd`, así que no se pasó `check tdd-red-evidence`.

## Issues Encountered

- `pnpm lint` global falla por las carpetas de herramientas sin seguimiento (`.opencode/`, `.claude/`, `.codex/`, `.agents/`), ya registrado en 07-01; se ejecutó sobre `src/lib` y `tests`: limpio.
- Suite completa con la base desechable `hub-phase7-01-pg`: 57 ficheros, 905 pruebas en verde; `pnpm typecheck` limpio.

## Known Stubs

Ninguno. `start`, `restart` y `reboot` responden 501 `action_unavailable` de forma intencionada hasta 07-04 (falla cerrado, intent sin reclamar).

## Threat Flags

Ninguno fuera del registro del plan: las dos rutas son las declaradas en T-07-05 a T-07-09.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 07-04 sustituye el 501 por el runner de `start`, `restart` y `reboot`: el punto de enganche es el `if (!isHostCommandIntent(action))` de `handleIntentExecute`.
- 07-03 lee el estado terminal del intent para la línea de resultado; la edición `:done` ya se encola con clave `i<id>:done`.
- 07-05 consume `inspect` y `execute` desde la UI del hub; la passkey en el navegador interno de Telegram (D9) va al UAT manual.

## Self-Check: PASSED

`src/lib/telegram-intent-api.ts` y `tests/api-telegram-intents.test.ts` existen; los cuatro commits (`ef72128`, `e162fe3`, `da21aa8`, `d833ca2`) son ancestros de HEAD; `git rev-list --count` desde `plan_head_before` da 4.

---
*Phase: 07-acciones-verificadas-desde-telegram*
*Completed: 2026-11-27*
