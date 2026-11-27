---
phase: 07-acciones-verificadas-desde-telegram
plan: "05"
subsystem: ui
tags: [telegram, handoff, react, sessionstorage, passkey, playwright, vitest]

requires:
  - phase: 07-acciones-verificadas-desde-telegram
    provides: "07-02: POST /api/telegram/intents/inspect y /execute; 07-04: start, restart y reboot ejecutables por el intent"
  - phase: 06-puerta-de-seguridad
    provides: "useSensitiveAction y el diálogo de confirmación con passkey"
provides:
  - "src/lib/telegram-handoff-client.ts: parseHandoffFragment, captureHandoff idempotente, readStoredHandoff, clearHandoff y handoffStorage"
  - "TelegramHandoff: panel y diálogo del handoff en Avisos con data-handoff-state"
  - "useSensitiveAction con requiresVerification opcional y data-verification-required"
  - "Acciones recientes con data-operation-channel y etiquetas de backup-now y deploy-now"
affects: [07-validation, uat-manual]

actuals:
  tokens: 11900
  tasks: 3
  commits: 5
plan_head_before: 92e9070e3eeb18b5523d8a4d9b8a5b196c7c8f56
plan_head_after: fa4729a8b3ae881384c33af54a3839ae5679bf71

tech-stack:
  added: []
  patterns:
    - "Capturar el token del fragmento en el cliente, guardarlo en sessionStorage y borrarlo de la URL conservando el search"
    - "El estado derivado (dismissed, executing) sale de la fase del hook y del estado propio, sin efectos"
    - "Las pruebas e2e siembran la fila del intent con el SHA-256 de un token que genera la prueba"

key-files:
  created:
    - src/lib/telegram-handoff-client.ts
    - src/components/views/telegram-handoff.tsx
    - tests/telegram-handoff-client.test.ts
    - tests/e2e/telegram-handoff.spec.ts
  modified:
    - src/components/sensitive-action/sensitive-action.tsx
    - src/components/views/alerts.tsx
    - src/components/login.tsx
    - src/lib/types.ts

key-decisions:
  - "P-20: confirmar y verificar es un solo paso; al llegar a ready el panel abre el diálogo y su botón verifica con passkey (si hace falta) y envía en un único submit"
  - "P-21: el token se captura una vez, vive en sessionStorage bajo hub.handoff hasta un estado terminal y captureHandoff es idempotente y conserva el search"
  - "P-22: un 401 de inspect recarga la página; el servidor rinde el login con next reconstruido y el token sigue en sessionStorage"
  - "P-23: cerrar el diálogo sin confirmar deja dismissed con botones para reabrir y descartar; el intent sigue vivo en Telegram"
  - "P-24: requiresVerification false no consulta /api/verification, parte de recent true y expone data-verification-required=false"
  - "pending (respuesta incierta) borra el token y no ofrece reintento; failed lo conserva y reintenta solo con inspect"

patterns-established:
  - "El panel nunca llama a execute por su cuenta: el reintento solo vuelve a inspect y reabre el diálogo"
  - "Un código 410 o 404 de execute (intent_expired, intent_cancelled, intent_unknown) termina el handoff como el estado equivalente de inspect"

requirements-completed: [BOT-07, BOT-08, BOT-09]

coverage:
  - id: D1
    description: "Con sesión, el enlace #intent=<token> de una acción exenta captura el token, borra el fragmento conservando view, host e incident, abre el diálogo con data-verification-required=false y confirma con un solo envío cuyo cuerpo es { token } hasta succeeded"
    requirement: "BOT-07"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-01 opens the dialog from the link, confirms with one tap and reaches succeeded"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sin fragmento el panel queda idle y no llama a inspect; un fragmento mal formado no abre nada ni rompe Avisos"
    requirement: "BOT-07"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-02 stays idle and calls nothing when the URL has no fragment"
        status: pass
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-11 ignores a malformed fragment and leaves Avisos working"
        status: pass
    human_judgment: false
  - id: D3
    description: "Sin sesión el enlace pasa por el login, el fragmento se captura antes de iniciar sesión, el panel llega a ready y una recarga conserva el token; un 401 de inspect recarga y reanuda"
    requirement: "BOT-07"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-03 survives the login and a reload without losing the intent"
        status: pass
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-12 keeps the token when inspect answers 401 and resumes after the reload"
        status: pass
    human_judgment: false
  - id: D4
    description: "parseHandoffFragment, captureHandoff (idempotente, almacenamiento que falla) y clearHandoff cumplen su contrato con location, history y storage inyectados"
    requirement: "BOT-07"
    verification:
      - kind: unit
        ref: "tests/telegram-handoff-client.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "Caducado, cancelado, desconocido y consumido se explican en el panel sin abrir el diálogo ni llamar a execute; consumido muestra la operación existente"
    requirement: "BOT-07"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-04, HANDOFF-05 y HANDOFF-06"
        status: pass
    human_judgment: false
  - id: D6
    description: "backup-now abre el diálogo con data-verification-required=true, reboot lo abre sin campo de frase tecleada y start no pide passkey; la UI toma requiresVerification de inspect"
    requirement: "BOT-08"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-07, HANDOFF-08 y HANDOFF-16"
        status: pass
    human_judgment: false
  - id: D7
    description: "Una incidencia resuelta marca data-handoff-resolved=true y el intent sigue siendo confirmable; cerrar el diálogo deja dismissed con reabrir y descartar"
    requirement: "BOT-07"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-09 y HANDOFF-10"
        status: pass
    human_judgment: false
  - id: D8
    description: "Acciones recientes expone data-operation-channel en cada fila y etiqueta propia para backup-now y deploy-now"
    requirement: "BOT-09"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-13 shows the channel of every recent operation and a label for backup-now and deploy-now"
        status: pass
    human_judgment: false
  - id: D9
    description: "Un 503 deja failed con reintento que vuelve a inspect y reabre el diálogo sin reenviar; un 502 deja pending sin reintento"
    requirement: "BOT-09"
    verification:
      - kind: e2e
        ref: "tests/e2e/telegram-handoff.spec.ts#HANDOFF-14 y HANDOFF-15"
        status: pass
    human_judgment: false
  - id: D10
    description: "La passkey dentro del navegador interno de Telegram (A1) y el aspecto del panel y del diálogo en un móvil real"
    requirement: "BOT-07"
    verification: []
    human_judgment: true
    rationale: "Comportamiento del navegador interno de Telegram, de WebAuthn y del diseño táctil en un dispositivo real; ninguna prueba automática lo reproduce. Va al UAT manual de 07-VALIDATION.md."

duration: 25min
completed: 2026-11-27
status: complete
---

# Phase 7 Plan 05: pantalla del handoff en Avisos Summary

**El enlace del aviso de Telegram captura `#intent=<token>` en el navegador, sobrevive al login y a la recarga con `sessionStorage`, abre en Avisos un diálogo con verbo y objetivo que confirma y verifica la passkey (solo si `inspect` la exige) en un único paso, y deja cada estado del intent en `data-handoff-state`.**

## Performance

- **Duration:** ~25 min (estimada: no se registró la hora de inicio)
- **Completed:** 2026-11-27T19:04Z
- **Tasks:** 3
- **Files modified:** 8 (4 creados)

## Accomplishments

- `telegram-handoff-client.ts`: cuatro funciones puras más `handoffStorage()` con `location`, `history` y `storage` inyectados; `captureHandoff` conserva `search` al borrar el fragmento y es idempotente.
- `TelegramHandoff` montado al principio de `AlertsView`, con su propia instancia de `useSensitiveAction`. No hay lista propia de acciones protegidas: `requiresVerification` sale de `inspect`.
- `Login` captura el fragmento antes del inicio de sesión, de modo que `router.replace(next)` no lo pierde.
- «Acciones recientes» muestra el canal de cada operación y etiqueta `backup-now` y `deploy-now`.
- El reintento de `failed` solo vuelve a `inspect`: nada se envía sin una confirmación nueva en el diálogo.

## API de `telegram-handoff-client.ts`

| Símbolo | Contrato |
| --- | --- |
| `HANDOFF_STORAGE_KEY` | `"hub.handoff"` |
| `parseHandoffFragment(hash)` | token de `#intent=` más 43 caracteres base64url, o `null` (vacío, longitud o caracteres distintos, parámetros de más, repetido u otro tipo como `#setup=`) |
| `captureHandoff(location, history, storage)` | con fragmento válido guarda el token, llama una vez a `replaceState(null, "", pathname + search)` y lo devuelve; sin fragmento válido devuelve el guardado y no toca la URL; un almacenamiento que lanza no impide devolver el token |
| `readStoredHandoff(storage)` | el token guardado si tiene la forma válida, si no `null` |
| `clearHandoff(storage)` | borra la clave sin lanzar |
| `handoffStorage()` | `window.sessionStorage` o un sustituto vacío si el navegador bloquea el acceso |

## Estados de `data-handoff-state`

| Estado | Cuándo | Token |
| --- | --- | --- |
| `idle` | no hay token ni guardado; no se pinta nada | — |
| `loading` | `inspect` en vuelo | guardado |
| `ready` | `inspect` devolvió `ready` y el diálogo está abierto | guardado |
| `executing` | el hook está en `verifying` o `executing` (derivado) | guardado |
| `dismissed` | el diálogo se cerró sin confirmar (derivado); botones reabrir y descartar | guardado |
| `succeeded` | `onSettled` `succeeded` | borrado |
| `pending` | respuesta incierta (502, red o `pending` del servidor); sin reintento | borrado |
| `failed` | 4xx/503 sin consumir, o `inspect` falló; botón de reintento | guardado |
| `expired`, `cancelled` | `inspect` o `execute` (410) lo informan | borrado |
| `consumed` | `inspect` informa un intent ya ejecutado; muestra la operación existente | borrado |
| `invalid` | token desconocido, ajeno o mal formado (404, 400) | borrado |

Un 401 de `inspect` recarga la página sin cambiar de estado visible.

## Cambio de `useSensitiveAction`

`SensitiveActionRequest.requiresVerification?: boolean` (por defecto `true`). Con `false`, `request()` fija `verification` en `{ method: "passkey", recent: true, reason: null }` y el efecto de apertura no consulta `/api/verification`. El `<dialog>` expone `data-verification-required` (`"true"` o `"false"`). El resto no cambia: un 403 `recent_verification_required` sigue reabriendo la verificación y un 5xx distinto de 503 sigue siendo incierto. `tests/e2e/sensitive-action.spec.ts` pasa sin cambios (9 de 9).

## Task Commits

1. **Tarea 1 (tracer): enlace con sesión de una acción exenta hasta `succeeded`** - `f767d92` (feat)
2. **Tarea 2: login sin perder el intent y todos los estados (TDD)** - `3bc0bef` (test, RED) y `cdcb93a` (feat, GREEN)
3. **Tarea 3: canal en «Acciones recientes», etiquetas y reintento (TDD)** - `13bab92` (test, RED) y `fa4729a` (feat, GREEN)

**Plan metadata:** commit `docs(07-05)` posterior a este fichero.

## Files Created/Modified

- `src/lib/telegram-handoff-client.ts` - captura, lectura y borrado del token del handoff.
- `src/components/views/telegram-handoff.tsx` - panel, diálogo y máquina de estados.
- `src/components/sensitive-action/sensitive-action.tsx` - `requiresVerification` y `data-verification-required`.
- `src/components/views/alerts.tsx` - monta el panel; `data-operation*`, etiquetas nuevas y marca «Desde Telegram».
- `src/components/login.tsx` - `captureHandoff` en un efecto de montaje.
- `src/lib/types.ts` - `Operation.channel` y `Operation.requestedBy` opcionales.
- `tests/telegram-handoff-client.test.ts` - 21 pruebas puras.
- `tests/e2e/telegram-handoff.spec.ts` - 16 casos contra la API real con `execute` simulado.

## Decisions Made

P-20 a P-24 como en el plan (ver `key-decisions`). Adicionales:

- `pending` borra el token: el hub pudo ejecutar la acción y no se ofrece de nuevo; una recarga no repetiría nada.
- Los códigos `intent_expired`, `intent_cancelled` e `intent_unknown` que devuelve `execute` terminan el handoff como el estado equivalente de `inspect`, en lugar de quedar como `failed`.
- El título nombra el contenedor solo para `start` y `restart`; en `reboot`, `backup-now` y `deploy-now` el objetivo es el host, que ya va en la descripción.
- El aviso de ayuda de la passkey en el navegador de Telegram es un elemento con `data-handoff-passkey-help` dentro de las consecuencias, presente solo con `requiresVerification`.

## Deviations from Plan

None - plan executed exactly as written.

Detalles sin cambio de alcance:

- La primera inspección arranca con `queueMicrotask` porque `react-hooks/set-state-in-effect` rechaza llamar a `setState` de forma síncrona en un efecto (el `Dashboard` ya usa el mismo patrón).
- `handoffStorage()` se añadió al módulo cliente para que el acceso a `window.sessionStorage` bloqueado no rompa el panel ni el login; el contrato de `<interfaces>` no cambia.
- Se añadieron `data-operation` y `data-operation-action` (además de `data-operation-channel`) para que las pruebas localicen la fila sin depender del copy.

## TDD Gate Compliance

El plan es de tipo `execute`, no `tdd`, así que no se pasó `check tdd-red-evidence`. Las tareas 2 y 3 llevan `tdd="true"`:

- **Tarea 2.** RED `3bc0bef`: HANDOFF-03 falla en `expect(url.hash).toBe("")` (el login no capturaba) y HANDOFF-04, 05, 06 y 10 fallan con `Expected: "expired" | "invalid" | "consumed" | "dismissed"`, `Received: "failed" | "ready"`. GREEN `cdcb93a`. Evaluación semántica: cada fallo es la aserción prevista sobre `data-handoff-state` o la URL, no un error de carga. Las 21 pruebas puras de `telegram-handoff-client.test.ts` pasaron ya en RED porque el módulo se creó con el tracer según el plan: son pruebas de caracterización, y los casos HANDOFF-07, 08 y 09 (diálogo de `backup-now`, `reboot` e incidencia resuelta) también pasaron en RED por el mismo motivo.
- **Tarea 3.** RED `13bab92`: HANDOFF-13 falla porque `[data-operation]` no existe y HANDOFF-14 porque `[data-handoff-retry]` no existe. GREEN `fa4729a`. HANDOFF-15 (502 sin reintento) y HANDOFF-16 (ayuda de passkey) pasaron en RED como guardas de regresión, porque el tracer ya los cubría.

No hubo REFACTOR.

## Evidencia

- `pnpm typecheck`: limpio.
- `pnpm lint src tests`: limpio. `pnpm lint` global falla por las carpetas de herramientas sin seguimiento (`.opencode/`, `.claude/`, `.codex/`, `.agents/`), ya registrado en 07-01 y 07-02.
- `pnpm build`: correcto.
- `pnpm test` con la base `hub-phase7-01-pg`: 59 ficheros, 974 pruebas en verde.
- `pnpm test:e2e` completo con las variables de CI y `HUB_E2E_HARNESS=1`: 96 pasan, ninguna omitida. `telegram-handoff.spec.ts` (16), `sensitive-action.spec.ts` (9), `incidents.spec.ts` y `overview.spec.ts` incluidos.

## Issues Encountered

- El modo `serial` del spec detiene el fichero en el primer fallo, así que la evidencia RED de cada caso se obtuvo ejecutándolo con `-g`.
- Riesgo residual sin cubrir: si `Dashboard.go()` reescribe la URL antes de que `AlertsView` monte el panel (por ejemplo, un host que desaparece de la configuración), el fragmento se pierde sin haberse capturado. El intent sigue vivo en Telegram y reabrir el botón funciona. No se tocó `dashboard.tsx` porque el plan lo excluye.

## Known Stubs

Ninguno.

## Threat Flags

Ninguno fuera del registro del plan: no hay rutas, paquetes ni variables de entorno nuevos. T-07-17 queda cubierto por HANDOFF-01 (URL sin fragmento, token solo en cuerpos POST, ninguna línea de consola lo contiene) y T-07-18 por HANDOFF-07 y HANDOFF-08 (`requiresVerification` sale de `inspect`).

## User Setup Required

None - no external service configuration required.

## UAT manual pendiente (07-VALIDATION.md)

Provocar un `backup-failed` o `deploy-failed`, pulsar «Acciones…» y la acción, abrir el enlace en Telegram, completar la passkey y comprobar la fila de `operations` y la edición del aviso. Incluye la suposición A1 (passkey dentro del navegador interno de Telegram) y el aspecto en un móvil real.

## Next Phase Readiness

Es el último plan de la fase 7: falta la verificación de fase y el UAT manual. BOT-07, BOT-08 y BOT-09 tienen todos sus planes con SUMMARY.

## Self-Check: PASSED

`src/lib/telegram-handoff-client.ts`, `src/components/views/telegram-handoff.tsx`, `tests/telegram-handoff-client.test.ts` y `tests/e2e/telegram-handoff.spec.ts` existen; los cinco commits (`f767d92`, `3bc0bef`, `cdcb93a`, `13bab92`, `fa4729a`) son ancestros de HEAD; `git rev-list --count` desde `plan_head_before` da 5.

---
*Phase: 07-acciones-verificadas-desde-telegram*
*Completed: 2026-11-27*
