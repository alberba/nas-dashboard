---
phase: 02-incidencias-y-entrega-nica
plan: "04"
subsystem: notifications
tags:
  - telegram
  - web-push
  - outbox
  - postgresql
  - advisory-lock
  - retries
  - service-worker

requires:
  - phase: 02-incidencias-y-entrega-nica
    plan: "01"
    provides: "notification_outbox con lease, token, revisión, chatId, messageId, result, fallbackResult y editResult"
  - phase: 02-incidencias-y-entrega-nica
    plan: "02"
    provides: "Política auditada, preempción D-04 y edición encolada al confirmar el mensaje"
  - phase: 02-incidencias-y-entrega-nica
    plan: "03"
    provides: "readRuntimeConfig con telegram, vapid, pushWarnings y betterAuthUrl validados"

provides:
  - "Despacho del outbox sobre la sesión dedicada del lock 734921, un trabajo por tick"
  - "Reclamación con token y lease, marca durable de intento antes de la red y recuperación D-01"
  - "Cliente Telegram saliente de origen fijo, sin redirects ni parse_mode, texto acotado y respuesta validada"
  - "Enlace de episodio sin tokens mediante incidentHref y BETTER_AUTH_URL"
  - "Reintento 429 durable con retry_after y cooldown compartido por bot/chat"
  - "Fallback push único para una crítica con rechazo 400/403/404 o presupuesto agotado"
  - "Edición del mensaje confirmado agrupada por seq, con resultado de edición independiente (D-06)"
  - "Canal push comprometido tras una aceptación y etiqueta hub:incident:<host>:<id> (D-05)"
  - "Prueba push acotada a las suscripciones de ownerUserId y limpieza 404/410"
  - "Retención que conserva episodios con trabajo vivo y borra terminales con su episodio"

affects: [02-05, phase-3, phase-4, phase-5]

actuals:
  tokens: 26474
  tasks: 2
  commits: 2
  plan_head_before: ce43a2654fc9f5a5ecfdbeba22e11e0ca1eed60d
  plan_head_after: c63153e0048a432b9bc0333f2f822dde7dc66dde

tech-stack:
  added: []
  patterns:
    - "Lock de sesión y reclamación en la misma conexión: ningún otro backend puede reclamar el mismo trabajo"
    - "Intento durable: attemptStartedAt se fija con token y lease antes de fetch; lease vencido sin inicio se recupera, con inicio queda incierto"
    - "Resultados por canal: result inicial, fallbackResult y editResult se guardan por separado"
    - "Cooldown durable: un 429 retrasa todos los trabajos Telegram pendientes del mismo bot/chat"
    - "Edición coalescente por seq: la revisión vigente actualiza el mensaje original y las anteriores quedan superseded"
    - "Push por episodio: etiqueta estable y seq en data para la actualización local de 02-05"

key-files:
  created:
    - src/lib/notification-dispatch.ts
    - src/lib/telegram.ts
    - tests/notification-dispatch.test.ts
    - tests/telegram.test.ts
  modified:
    - src/worker.ts
    - src/components/views/routes.ts
    - src/lib/push.ts
    - src/lib/incident-store.ts
    - public/sw.js

key-decisions:
  - "El dispatcher escribe con la conexión que posee el lock; las actualizaciones condicionadas por claimToken hacen que un dueño viejo no pueda confirmar ni editar"
  - "El lease de 30 s supera el timeout de 10 s de la solicitud; perder la sesión después de attemptStartedAt deja la fila incierta, nunca se reenvía"
  - "El fallback push de una crítica se inserta en la misma transacción que registra el fallo definitivo y su clave única evita duplicados"
  - "La edición usa siempre chatId y messageId persistidos; un cambio pendiente de mayor seq invalida la revisión anterior sin emitir otro mensaje"
  - "El push aceptado compromete el canal del episodio aunque otro endpoint falle; una escalada posterior no abre Telegram ni otro push remoto"
  - "Un 429 sin retry_after usa backoff acotado y un presupuesto de cinco intentos; el plazo remoto se persiste antes de volver a intentar"
  - "La retención solo elimina episodios resueltos sin filas pending/claimed y deja que el cascade borre eventos y resultados terminales"
  - "La prueba push del worker exige ownerUserId; sin propietario se suprime en vez de alcanzar todas las suscripciones"

patterns-established:
  - "Clasificación finita: sent, retry, rejected o uncertain; ningún cuerpo del proveedor se propaga al hub"
  - "Origen fijo https://api.telegram.org, redirect: error, sin parse_mode y texto truncado a 4096"
  - "URL de Avisos validada dos veces: incidentHref en el servidor y alertsPath en el service worker"
  - "Cierre o cambio de severidad durante un envío en curso: la confirmación posterior programa la última edición del mismo mensaje"

requirements-completed: [INCD-02, INCD-03, INCD-04, INCD-05, INCD-06, INCD-07, BOT-01]

coverage:
  - id: D1
    description: "Una apertura elegible llega una sola vez al chat configurado desde el worker bajo el lock de recolección; un competidor no puede reclamarla"
    requirement: INCD-06
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#delivers one opening with the configured chat and episode button"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#does not let a competing session send the same opening"
        status: pass
      - kind: unit
        ref: "tests/telegram.test.ts#sends plain text with a URL button to the fixed provider origin"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-01: un lease vencido antes del intento se recupera; una confirmación perdida tras el inicio queda incierta, sin reenvío ni push de respaldo"
    requirement: INCD-06
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#recovers a lease that expired before the attempt started"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#keeps an attempt-started lease uncertain without a resend or fallback"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#keeps an ambiguous attempt uncertain without a resend or fallback"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-02: el 429 respeta retry_after incluso al reiniciar y 400/403/404 quedan fallidos y visibles con un único push de respaldo para una crítica"
    requirement: INCD-07
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#honours retry_after across a restart and shares the cooldown"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#fails permanently on 400, 403 and 404 and creates one fallback per critical"
        status: pass
      - kind: unit
        ref: "tests/telegram.test.ts#treats 400, 403 and 404 as confirmed permanent rejections"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-06: resolver o cambiar la severidad edita el mensaje Telegram confirmado por seq, sin segundo sendMessage y con editResult independiente"
    requirement: INCD-03
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#edits the original Telegram message in seq order without a second send"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#records a deleted message as a permanent edit failure"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#never edits after an uncertain opening"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#cancels an opening closed before the attempt started"
        status: pass
      - kind: unit
        ref: "tests/telegram.test.ts#edits the original message and accepts already-applied content"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-05: una apertura push aceptada conserva su canal al escalar; la etiqueta y el seq del episodio quedan en el payload para 02-05"
    requirement: INCD-04
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#keeps the accepted push channel when the warning escalates"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#persists the fallback result separately from the initial failure"
        status: pass
    human_judgment: false
  - id: D6
    description: "Una prueba push usa solo las suscripciones de ownerUserId, limpia endpoints 404/410 y una aceptación parcial compromete el canal"
    requirement: BOT-01
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#scopes a push test to its owner and removes gone endpoints"
        status: pass
    human_judgment: false
  - id: D7
    description: "La retención conserva episodios con trabajo vivo y borra los terminales junto a su episodio"
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#keeps live work when retention removes a resolved episode"
        status: pass
    human_judgment: false
  - id: D8
    description: "El service worker solo abre la ruta interna de Avisos con host e incidencia validados y conserva tag/seq en data"
    verification: []
    human_judgment: true
    rationale: "No existe un harness de service worker en el repositorio; la validación de la bandeja real y del reemplazo silencioso es la prueba manual de PWA prevista en 02-VALIDATION.md."

duration: 16min
completed: 2026-11-25
status: complete
---

# Phase 02 Plan 04: Entrega desde el worker con Telegram, Web Push y reintentos

**Despacho del outbox bajo el lock de recolección con reclamación por token y lease, confirmación Telegram persistida, reintentos 429 durables, fallback push único y edición coalescente del mensaje original.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-11-25T10:08:49Z
- **Completed:** 2026-11-25T10:24:46Z
- **Tasks:** 2
- **Files modified:** 9 (4 creados, 5 modificados), contando `tests/telegram.test.ts` en ambos estados

## Accomplishments

- El worker reclama un trabajo del outbox sobre su propia conexión de lock, fija `attemptStartedAt` con una actualización condicionada por token y lease y no deja ninguna transacción abierta durante la red.
- Un lease vencido sin inicio vuelve a `pending`; uno vencido después del inicio queda `uncertain` con motivo `lease_expired_after_attempt` y ni se reenvía ni abre un push de respaldo.
- El cliente Telegram usa el origen fijo, `redirect: "error"`, sin `parse_mode`, trunca el texto a 4096 caracteres y valida `message_id` y chat antes de confirmar.
- El botón apunta al episodio con `incidentHref` y `BETTER_AUTH_URL`, sin tokens; la ruta interna queda validada otra vez en el service worker.
- Un 429 persiste `retry_after` en segundos y aplica el mismo plazo a los demás trabajos Telegram pendientes del bot/chat, incluso tras reiniciar.
- Los rechazos 400/403/404 quedan `failed` visibles y una crítica recibe exactamente una fila `incident:<id>:push` en la misma transacción.
- Los cambios de severidad y el cierre se agrupan por `seq`; la revisión vigente edita `chatId`/`messageId` persistidos y la anterior queda `superseded`, sin segundo `sendMessage`.
- Una aceptación push compromete el canal del episodio y una escalada posterior no envía Telegram ni otro push remoto (D-05).
- La prueba push exige `ownerUserId` y solo consulta sus suscripciones; los endpoints 404/410 se eliminan.
- La retención conserva episodios con trabajo `pending`/`claimed` y deja que el cascade elimine eventos y resultados terminales.

## Task Commits

Cada tarea se confirmó de forma atómica:

1. **Task 1: Entregar una apertura desde PostgreSQL hasta un mensaje Telegram confirmado** — `e854d2e` (feat)
2. **Task 2: Completar reintentos seguros, ediciones y el canal push** — `c63153e` (feat)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: la tarea 2 llevaba `tdd="true"`. El encargo exige un único commit atómico por tarea, así que los casos de comportamiento se ejecutaron contra la implementación en ese mismo commit, sin un commit RED separado._

## Files Created/Modified

- `src/lib/notification-dispatch.ts` — lock, reclamación, intento durable, clasificación, reintentos, fallback push, ediciones y retención.
- `src/lib/telegram.ts` — cliente de origen fijo para `sendMessage` y `editMessageText`, truncado, validación y resultados finitos.
- `src/worker.ts` — loop que valida configuración, posee el lock, escucha la pérdida de sesión, drena el outbox y aplica la nueva retención.
- `src/components/views/routes.ts` — `incident` en la ruta de Avisos y `incidentHref` absoluto sin tokens.
- `src/lib/push.ts` — `deliverPush` con resultado explícito, aceptación parcial comprometida, limpieza 404/410 y `notify` compatible.
- `src/lib/incident-store.ts` — `cleanupExpiredIncidents` conserva episodios con trabajo vivo.
- `public/sw.js` — valida la ruta interna de Avisos y conserva `tag` y `seq` en `data`.
- `tests/notification-dispatch.test.ts` — 16 casos de concurrencia, D-01, D-02, D-05, D-06, push y retención.
- `tests/telegram.test.ts` — 12 casos del contrato del cliente y del enlace canónico.

## Decisions Made

- El dispatcher usa la conexión del lock también para reclamar y actualizar: así la garantía de un solo dueño no depende de una segunda sesión del pool.
- `claimToken` es la única llave para confirmar, reintentar, fallar o editar; cualquier actualización que no alcance la fila devuelve `claim_lost` sin tocar el resultado.
- El lease de 30 s supera el timeout de 10 s de la solicitud. Si el proceso cae durante la red, el siguiente dueño solo puede clasificar el intento como incierto.
- El fallback de una crítica copia la revisión vigente del episodio y usa una clave única; un segundo fallo no puede crear otra fila.
- Las ediciones se agrupan por el `seq` más alto pendiente; la revisión anterior queda `superseded` para que un mensaje no reciba contenido obsoleto.
- Un 429 sin `retry_after` utilizable usa backoff exponencial acotado; el plazo remoto siempre se guarda antes de volver a reclamar.
- La prueba push del worker se suprime si no tiene `ownerUserId`: no existe un envío de prueba global desde el outbox.
- Los trabajos push también fijan `attemptStartedAt` antes de la red; una confirmación perdida queda incierta y no se reenvía.
- La retención considera trabajo vivo únicamente `pending`/`claimed`; `sent`, `failed`, `suppressed` y `uncertain` son terminales y se borran con su episodio al vencer la retención.

## Deviations from Plan

### Procesos ajustados al encargo

- La tarea 2 llevaba `tdd="true"`; el encargo exige un único commit atómico por tarea, así que no hay commit RED separado. Los tests de comportamiento se ejecutaron contra la implementación y son la puerta de la tarea.
- No se actualizaron `ROADMAP.md` ni `STATE.md`; el orquestador es su único escritor tras la ola, según el encargo.
- No se usaron credenciales reales de Telegram ni VAPID. Toda la verificación usa `fetch` y transporte push inyectados; la prueba manual con bot/chat queda para el despliegue posterior a 02-05.

**Total deviations:** 0 auto-fixed de código y 2 ajustes de proceso.
**Impact on plan:** Ninguno sobre el alcance. Los dos commits cubren exactamente las dos tareas del plan.

## Issues Encountered

- El reloj del test se inyecta por delante del reloj real porque `notification_outbox.nextAttemptAt` usa `now()` de PostgreSQL al insertar. Es un ajuste del arnés de pruebas, no de producción.
- El lint completo del repositorio incluye los directorios de entorno no versionados (`.agents/`, `.opencode/`, etc.); el lint acotado a los archivos del plan termina con exit 0.
- `pnpm build` imprime avisos preexistentes de `BetterAuthError` por el secreto de build ausente en local y termina con exit 0.

## Evidence · PostgreSQL 18 and simulated providers

Servidor desechable: PostgreSQL 18.7, `postgresql://hub:hub@127.0.0.1:55432/hub`, `HUB_REQUIRE_TEST_DB=1`.

| Command | Result |
|---|---|
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` (Task 1) | 2 files, 17 tests passed |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` (Task 2 final) | 2 files, 28 tests passed (16 dispatch + 12 telegram) |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 38 files, 400 tests passed |
| `pnpm typecheck` | `tsc --noEmit` exit 0 |
| `pnpm lint` over the 8 plan files | exit 0 |
| `pnpm build` | exit 0; Next.js 16.4.6; solo avisos locales de secreto de build |
| `node --check public/sw.js` | exit 0 |

La suite de despacho ejecuta dos conexiones PostgreSQL reales que compiten por `pg_try_advisory_lock(734921)`: el competidor lanza `CollectionLockLost` con cero peticiones y el dueño confirma un solo `sendMessage`. No se contactó `api.telegram.org` ni ningún endpoint push real.

## Threat Model Evidence

- **T-02-07 (Tampering):** reclamación y marca de intento condicionadas por token y lease, con escrituras que solo afectan al token vigente; pruebas con dos sesiones reales, lease sin inicio, lease iniciado e intento ambiguo.
- **T-02-08 (Information Disclosure):** origen Telegram fijo, `redirect: "error"`, sin `parse_mode`, respuesta validada y motivos finitos; el enlace no lleva tokens y la URL de Avisos se revalida en el service worker. La prueba push se limita al propietario.
- **T-02-10 (Denial of Service):** timeout de 10 s menor que el lease de 30 s, cooldown durable, presupuesto finito de cinco intentos y ediciones agrupadas por `seq` con prueba de reloj.

## User Setup Required

La prueba manual del bot en un chat dedicado y los valores `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` siguen siendo una comprobación de despliegue posterior a 02-05. No hay credenciales reales en este entorno y no bloquean la entrega del plan. `src/lib/push.ts` conserva `notify` para que 02-05 mueva `/api/push/test` al outbox con `ownerUserId`.

## Next Phase Readiness

- 02-05 puede leer `notification_outbox` para proyectar `result`, `fallbackResult`, `editResult`, `chatId`, `messageId` y `revision`, y usar la etiqueta `hub:incident:<host>:<id>` del payload push para la actualización local.
- El worker ya drena aperturas, fallbacks push, ediciones y pruebas push bajo el mismo lock; 02-05 solo necesita encolar la prueba con `ownerUserId` y cambiar el llamador de la ruta.
- No se modificó `drizzle/`: la forma del outbox es el contrato existente.
- La prueba manual de Telegram con el enlace del hub, la bandeja push real y el reemplazo silencioso siguen pendientes de dispositivo y despliegue, tal como fija `02-VALIDATION.md`.

## Self-Check: PASSED

- `src/lib/notification-dispatch.ts`, `src/lib/telegram.ts`, `src/lib/push.ts`, `public/sw.js`, `tests/notification-dispatch.test.ts` y `tests/telegram.test.ts` existen.
- `e854d2e` y `c63153e` son ancestros de `HEAD`.
- PostgreSQL 18 ejecutó las 38 suites (400 tests) sin omisiones.
- `pnpm typecheck`, el lint acotado, `pnpm build` y `node --check public/sw.js` terminaron con exit 0.
