---
phase: 07-acciones-verificadas-desde-telegram
plan: "01"
subsystem: telegram-bot
tags: [telegram, drizzle, postgres, hmac, intents, outbox, vitest]

requires:
  - phase: 05-bot-de-reconocimiento
    provides: "carril de updates, tokens de botón de un solo uso, outbox de ediciones silenciosas"
  - phase: 06-seguridad-y-verificacion
    provides: "manifiesto de acciones sensibles (ActionId, HostCommand) y verificación reciente"
provides:
  - "migración 0008: telegram_action_intents con índice único parcial por aviso, operations.channel/requestedBy, notification_outbox.keyboardView"
  - "src/lib/telegram-intents.ts: autoridad del ciclo de vida del intent (hostActionsFor, token HMAC, createIntent, búsqueda, reclamo, cierre, liberación, caducidad)"
  - "queueKeyboardEdit: ediciones solo de teclado con clave propia incident:<id>:kb:<discriminador>"
  - "botón url del handoff en el aviso con el token en el fragmento #intent="
affects: [07-02, 07-03, 07-04, 07-05, 07-06]

actuals:
  tokens: 29800
  tasks: 3
  commits: 6
plan_head_before: 259d38bb846bc87a594f652e855a567655d48fc9
plan_head_after: c814187e09fbdb8c673d3f32f8f4e353130d1fab

tech-stack:
  added: []
  patterns:
    - "Token derivado, no almacenado: HMAC-SHA256 recomputable y solo su SHA-256 en la base"
    - "Un único UPDATE ... RETURNING como reclamo atómico; el índice único parcial como árbitro de unicidad"
    - "Ediciones solo de teclado en el outbox con clave propia, sin mover seq"

key-files:
  created:
    - drizzle/0008_acciones_telegram.sql
    - drizzle/meta/0008_snapshot.json
    - src/lib/telegram-intents.ts
    - tests/telegram-intents.test.ts
  modified:
    - drizzle/meta/_journal.json
    - src/lib/schema.ts
    - src/lib/telegram-keyboard.ts
    - src/lib/incident-actions.ts
    - src/lib/telegram-updates.ts
    - src/lib/incident-store.ts
    - src/lib/telegram.ts
    - src/lib/notification-dispatch.ts
    - tests/migrations.test.ts

key-decisions:
  - "P-01: token del handoff = base64url(HMAC-SHA256(subclave, intentId)) con subclave HMAC-SHA256(BETTER_AUTH_SECRET, 'hub:telegram-handoff:v1'); la base guarda solo sha256(token)"
  - "P-02: operations.channel text por defecto 'hub' y requestedBy nulo; las filas anteriores no se reescriben"
  - "P-03: las ediciones solo de teclado usan clave incident:<id>:kb:<discriminador> porque queueEdit deriva su clave de seq, que un cambio de teclado no mueve"
  - "P-04: el intent se liga al único usuario de la instancia; con cero o varios el carril no crea intent"
  - "P-05: CR-01 de la fase 6 se corrige en 07-06 (D-13); 07-01 no toca verificationMethodForRequest"
  - "P-06: TELEGRAM_ACTIONS recibe los ocho valores nuevos de una vez; menu_open, menu_close e intent_cancel quedan como ignored hasta 07-03"

patterns-established:
  - "Los módulos que importan db se cargan con import dinámico en las pruebas, después de fijar DATABASE_URL; telegram-intents ahora arrastra db a través de incident-store"
  - "El carril solo registra intenciones: no importa ejecutores ni toca operations"

requirements-completed: [BOT-07, BOT-08, BOT-09]

coverage:
  - id: D1
    description: "Pulsar act_backup_now crea un intent pending con TTL de 5 minutos y solo el SHA-256 del token, sin ejecutar nada (sin filas en operations ni peticiones fuera de Telegram)"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#turns a backup press into one pending intent without running anything"
        status: pass
    human_judgment: false
  - id: D2
    description: "hostActionsFor ofrece Arrancar y Reiniciar a container:<nombre>, backup-now, deploy-now y reboot a sus claves, y nada a connection u otras; update, stop y remove no existen como acción de intent"
    requirement: "BOT-07"
    verification:
      - kind: unit
        ref: "tests/telegram-intents.test.ts#hostActionsFor"
        status: pass
    human_judgment: false
  - id: D3
    description: "Una incidencia resuelta, una clave sin la acción o una instancia sin exactamente un usuario no crean intent"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#creates no intent on a key that does not offer the action"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#creates no intent from an old button once the episode is resolved"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#fails closed without exactly one user"
        status: pass
    human_judgment: false
  - id: D4
    description: "El aviso se edita en silencio sobre el mismo mensaje con un botón url cuyo fragmento lleva el token; la url es estable entre ediciones y desaparece al caducar el intent"
    requirement: "BOT-07"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#edits the notice silently with a url button that carries the handoff token"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#renders no handoff button once the intent has expired"
        status: pass
    human_judgment: false
  - id: D5
    description: "A lo sumo un intent pending por aviso (índice único parcial) y reclamo atómico de un solo uso bajo concurrencia"
    requirement: "BOT-08"
    verification:
      - kind: integration
        ref: "tests/telegram-intents.test.ts#keeps one live intent per notice and allows another once it lapsed"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#claims an intent once even when two claims race"
        status: pass
      - kind: integration
        ref: "tests/telegram-intents.test.ts#does not claim an expired, cancelled or already claimed intent"
        status: pass
    human_judgment: false
  - id: D6
    description: "La migración 0008 es aditiva: conserva incidencias, outbox y operaciones, deja channel=hub y requestedBy nulo, y repetirla no aplica nada, también con el ejecutor real"
    requirement: "BOT-09"
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#adds the intent table and the channel columns without rewriting history"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#applies 0008 to a new database and on top of 0007 with pnpm db:migrate"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-11-27
status: complete
---

# Phase 7 Plan 01: del callback al intent y al botón url Summary

**Un callback `act_*` del aviso de Telegram crea un intent `pending` de cinco minutos (solo el SHA-256 de un token HMAC recomputable) y edita el mismo aviso en silencio con un botón url hacia el hub, sin ejecutar nada; la migración 0008 deja listo el esquema de toda la fase.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-11-27T18:06:44Z
- **Completed:** 2026-11-27T18:14:00Z
- **Tasks:** 3
- **Files modified:** 13

## Accomplishments

- Migración 0008 aditiva con `telegram_action_intents` (índice único parcial `telegram_action_intents_live_idx` sobre `incidentId` con `WHERE status = 'pending'`, índice único del hash y índice por `expiresAt`), `operations.channel` (por defecto `hub`), `operations.requestedBy` (nulo) y `notification_outbox.keyboardView` (por defecto `normal`).
- `src/lib/telegram-intents.ts` como única autoridad del intent: `hostActionsFor`, token HMAC, `createIntent` (`created | live | ignored`), `liveIntentOf`, `findIntentByToken`, `expireDueIntents`, `claimIntent`, `finishIntent` y `releaseIntent`.
- Rama `act_*` del carril de updates: bloquea la incidencia, ignora las resueltas y las claves que no ofrecen la acción, y registra el intent en la misma transacción que consume el token y avanza el offset. El carril no importa ejecutores.
- `queueKeyboardEdit` y botón url: la creación del intent encola una edición solo de teclado y `dispatchEdit` añade «Confirmar en el hub: <verbo> <objetivo>» con la url `...#intent=<token>` recompuesta sin escribirla en ningún sitio.

## Formato del token del handoff

- Subclave: `HMAC-SHA256(BETTER_AUTH_SECRET, "hub:telegram-handoff:v1")`.
- Token: `base64url(HMAC-SHA256(subclave, intentId))`, 43 caracteres (256 bits).
- En la base solo `handoffHash = sha256(token)` en hexadecimal; la comparación final usa `timingSafeEqual`.
- La url del botón es `incidentHref(...)` más el fragmento `#intent=<token>`; el fragmento no viaja al servidor.

## Task Commits

1. **Tarea 1 (tracer): act_backup_now crea un intent pendiente** - `242ab3c` (feat)
2. **Tarea 2: botón url del handoff (TDD)** - `26269c1` (test, RED) y `9218f14` (feat, GREEN)
3. **Tarea 3: ciclo de vida del intent y migración (TDD)** - `6324156` (test, RED), `172b026` (feat, GREEN) y `c814187` (test de la migración 0008)

**Plan metadata:** commit `docs(07-01)` posterior a este fichero.

## Files Created/Modified

- `drizzle/0008_acciones_telegram.sql`, `drizzle/meta/0008_snapshot.json`, `drizzle/meta/_journal.json` - migración generada con `drizzle-kit`, sin edición a mano.
- `src/lib/schema.ts` - `telegramActionIntents`, `operations.channel/requestedBy`, `notificationOutbox.keyboardView`.
- `src/lib/telegram-intents.ts` - ciclo de vida completo del intent.
- `src/lib/telegram-keyboard.ts` - ocho valores nuevos en `TELEGRAM_ACTIONS` y sus etiquetas (los verbos salen de `INTENT_VERBS`).
- `src/lib/incident-actions.ts` - `KNOWN_ACTIONS` derivado de `TELEGRAM_ACTIONS`.
- `src/lib/telegram-updates.ts` - rama `act_*`, `secret` en el contexto, textos de respuesta del callback.
- `src/lib/incident-store.ts` - `queueKeyboardEdit`.
- `src/lib/telegram.ts` - `TelegramActionButton` admite `{ text, url }`.
- `src/lib/notification-dispatch.ts` - `dispatchEdit` añade la fila del botón url cuando hay intent vivo.
- `tests/telegram-intents.test.ts`, `tests/migrations.test.ts` - pruebas del tracer, la edición, el ciclo de vida y la migración.

## Decisions Made

Las decisiones P-01 a P-06 del plan se aplicaron tal cual (ver `key-decisions`). P-05: la corrección de CR-01 de la fase 6 (el método passkey o contraseña se elige por la cabecera `Origin`, que fija el cliente) la hace el plan 07-06 por D-13; este plan no cambia `verificationMethodForRequest`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pruebas con import dinámico de `telegram-intents`**
- **Found during:** Tarea 2 (GREEN)
- **Issue:** `telegram-intents` ahora importa `incident-store`, que importa `db` al cargarse. Un `import` estático en el fichero de pruebas creaba el pool con la base de mantenimiento antes de que `beforeAll` fijara `DATABASE_URL`, y todas las pruebas fallaban con `relation "notification_outbox" does not exist`.
- **Fix:** el módulo se carga con `await import(...)` dentro de `beforeAll`, como hacen las demás suites; las pruebas puras de `hostActionsFor` pasaron al bloque que depende de la base.
- **Files modified:** tests/telegram-intents.test.ts
- **Verification:** `pnpm test tests/telegram-intents.test.ts` con 22 pruebas verdes.
- **Committed in:** `9218f14`

**2. [Rule 1 - Bug] Aserción de la prueba de `connection` sobre la fila de token equivocada**
- **Found during:** Tarea 1
- **Issue:** la prueba leía la primera fila de `telegram_action_tokens`, que era uno de los tokens del propio aviso y no el pulsado.
- **Fix:** busca la fila por el hash del token pulsado.
- **Files modified:** tests/telegram-intents.test.ts
- **Committed in:** `242ab3c`

### Reubicación menor dentro del plan

`expireDueIntents` se implementó en la tarea 1 (la necesita `createIntent`) y no en la 3; la tarea 3 aportó el resto del ciclo de vida. No cambia el contrato de `<interfaces>`.

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug de prueba)
**Impact on plan:** sin cambios de alcance.

## TDD Gate Compliance

Las tareas 2 y 3 (`tdd="true"`) siguieron RED, GREEN: `26269c1` -> `9218f14` y `6324156` -> `172b026`. RED fue fallo real de aserción para el comportamiento nuevo (filas ausentes, `edited` frente a `idle`) y `TypeError: ... is not a function` para las funciones que aún no existían. La prueba de «un intent vivo por aviso» pasó ya en RED porque `createIntent` de las tareas 1 y 2 ya lo cumplía; se mantiene como guarda de regresión. El plan no es de tipo `tdd`, así que no se pasó el clasificador `check tdd-red-evidence`. Los commits RED no compilan bajo `tsc` hasta su GREEN (las pruebas llaman a símbolos aún inexistentes).

## Issues Encountered

- No había `DATABASE_URL` ni PostgreSQL local propio. Se levantó un contenedor desechable `postgres:18` en `127.0.0.1:55433` (`hub-phase7-01-pg`) solo para ejecutar las suites; no se abrió `.env.local`. El contenedor sigue en marcha y puede eliminarse con `docker rm -f hub-phase7-01-pg`.
- `pnpm lint` sobre todo el repositorio falla con miles de errores en `.opencode/`, `.claude/`, `.codex/` y `.agents/` (carpetas de herramientas sin seguimiento, ajenas a este plan). Se ejecutó `pnpm lint` sobre `src/lib` y los dos ficheros de pruebas tocados: limpio. Registrado como fuera de alcance.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Listo para 07-02 a 07-05: el esquema completo de la fase está migrado y `telegram-intents.ts` expone el ciclo de vida que consumirán el hub y el ejecutor (`findIntentByToken`, `claimIntent`, `finishIntent`, `releaseIntent`).
- 07-03 debe implementar `menu_open`, `menu_close` e `intent_cancel` (hoy `ignored`) y usar `notification_outbox.keyboardView`.
- 07-06 corrige CR-01 de la fase 6 antes de que el handoff dependa de `verificationMethodForRequest`.
- `telegram-intents` ya arrastra `db` por `incident-store`: cualquier prueba nueva que lo importe debe hacerlo de forma dinámica.

## Self-Check: PASSED

Ficheros creados comprobados en disco (`drizzle/0008_acciones_telegram.sql`, `drizzle/meta/0008_snapshot.json`, `src/lib/telegram-intents.ts`, `tests/telegram-intents.test.ts`) y los seis commits (`242ab3c`, `26269c1`, `9218f14`, `6324156`, `172b026`, `c814187`) son ancestros de HEAD. Suite completa: 56 ficheros, 848 pruebas en verde; `pnpm typecheck` limpio.

---
*Phase: 07-acciones-verificadas-desde-telegram*
*Completed: 2026-11-27*
