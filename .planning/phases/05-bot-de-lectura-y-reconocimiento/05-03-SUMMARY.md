---
phase: 05-bot-de-lectura-y-reconocimiento
plan: "03"
subsystem: notifications
tags: [telegram, outbox, reply, incident-why, drizzle, keyboard]

# Dependency graph
requires:
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "01"
    provides: carril de updates, tokens de un solo uso, offset transaccional y teclado con tokens
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "02"
    provides: silencio por (hostId, key) y teclado con los controles de silencio
  - phase: 02-incidencias-y-entrega-nica
    provides: notification_outbox transaccional, clave única, reclamo con lease y edición por seq
provides:
  - Estado del aviso (apertura, severidad, cierre) con una respuesta por estado
  - Respuesta citada, sin sonido y sin teclado, generada en el servidor al enviar
  - Hechos y texto de la explicación por clave, con la última muestra del host
  - Rama incident-why del despacho con la pausa compartida y el intento incierto sin reenvío
affects: [05-04, 05-05, 05-06]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 16617
  tasks: 2
  commits: 6
  plan_head_before: dbf14b2de0a8140f6f85f7c7643abf1487fe7ae4
  plan_head_after: 1865f44078104af32f89e9fcf19ff87833b67a92

tech-stack:
  added: []
  patterns:
    - "Una respuesta por estado del aviso: clave única incident:<id>:why:<noticeSeq> y onConflictDoNothing"
    - "El estado del aviso son los eventos que cambian lo que afirma, nunca el reconocimiento ni el silencio"
    - "Contenido generado al enviar desde la incidencia, la política y la última muestra, no desde el callback"
    - "recordReplySent confirma sin reescribir el destino citado ni programar una edición"

key-files:
  created:
    - src/lib/incident-why.ts
    - tests/incident-why.test.ts
  modified:
    - src/lib/telegram.ts
    - src/lib/telegram-updates.ts
    - src/lib/telegram-keyboard.ts
    - src/lib/notification-dispatch.ts
    - src/lib/schema.ts
    - tests/telegram.test.ts
    - tests/telegram-updates.test.ts
    - tests/incident-snooze.test.ts

key-decisions:
  - "El estado del aviso es el mayor seq de los eventos opened, severity y closed; reconocer, silenciar y quitar silencio no lo mueven porque no cambian lo que el aviso explica"
  - "La respuesta es trabajo del outbox con clave única por estado: la base, no el código, impide dos respuestas del mismo estado bajo concurrencia"
  - "El texto se genera al enviar, con la incidencia y la última muestra del host, así una escalada o un cierre se reflejan sin reencolar nada"
  - "Una incidencia resuelta no muestra dato leído y conserva la explicación; el teclado de su última edición deja solo Por qué y Abrir en el hub"
  - "recordReplySent marca sent sin reescribir chatId ni messageId: siguen apuntando al mensaje citado y no se programa ninguna edición"
  - "El canal de la explicación es el de la fila de apertura; la política solo decide la etiqueta de la regla y el respaldo cuando no hay apertura"
  - "Un rechazo confirmado es terminal para ese estado y no crea respaldo de push, porque el tipo no es incident-open (T-05-12)"

patterns-established:
  - "Encolado idempotente por clave natural con .onConflictDoNothing().returning(): 'queued' o 'duplicate', nunca un error"
  - "Un lector de muestras que devuelve un hecho puro (valor y unidad) y nulo para claves sin medida"
  - "Respuesta de Telegram por el mismo post() del cliente: el token solo toca botRequest y el resultado nunca lo contiene"

requirements-completed: [BOT-05, BOT-06]

coverage:
  - id: D1
    description: "Pulsar Por qué deja una sola fila incident-why pendiente por estado del aviso, sin tocar la incidencia"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/incident-why.test.ts#queues one pending reply for the notice state without changing the incident"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#answers a fresh token of the same state after acknowledging without a second row"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#leaves one row when two presses of the same state run concurrently"
        status: pass
    human_judgment: false
  - id: D2
    description: "El estado del aviso avanza con una escalada y con un cierre, y no con reconocer, silenciar ni quitar silencio"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/incident-why.test.ts#opens a new reply after a severity escalation and after a close"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#moves the notice state only on an escalation or a closure"
        status: pass
    human_judgment: false
  - id: D3
    description: "El teclado ofrece Por qué en todos los estados y la incidencia resuelta conserva solo ese botón junto a Abrir en el hub"
    requirement: "BOT-05"
    verification:
      - kind: unit
        ref: "tests/incident-why.test.ts#offers why in every keyboard state and only why once resolved"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#renders a single why row on the resolved notice edit"
        status: pass
    human_judgment: true
    rationale: "Que la fila se vea bien en el cliente real de Telegram (etiqueta larga, orden, ancho) exige el móvil; queda en el human-check de fin de fase."
  - id: D4
    description: "La respuesta cita el aviso, sale sin sonido y sin teclado, y su contenido sale de la regla, el dato y el canal reales"
    requirement: "BOT-05"
    verification:
      - kind: unit
        ref: "tests/telegram.test.ts#replies quoting the notice without sound and without a keyboard"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#sends the reply quoting the notice, without sound and with the rule and the reading"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#reflects an escalation in the severity of the text, one message per state"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#does not change the delivery the hub publishes"
        status: pass
    human_judgment: false
  - id: D5
    description: "El dato leído sale de la última muestra por clave (temperatura máxima, CPU, memoria y disco) y falta en las claves sin medida y en una incidencia resuelta"
    requirement: "BOT-05"
    verification:
      - kind: unit
        ref: "tests/incident-why.test.ts#reads each measurement and nothing else"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#explains each key with its own reading and none without a measurement"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#explains a resolved notice without a reading"
        status: pass
    human_judgment: false
  - id: D6
    description: "La respuesta respeta la pausa del 429, no se reenvía tras una confirmación incierta, no crea respaldo de push y sale aunque haya un silencio activo"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/incident-why.test.ts#honours the shared pause after a 429 and sends the reply once"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#never resends an uncertain confirmation"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#leaves a confirmed rejection failed and never falls back to push"
        status: pass
      - kind: integration
        ref: "tests/incident-why.test.ts#sends the reply while a silence is active"
        status: pass
    human_judgment: false
  - id: D7
    description: "Un token de Por qué repetido, caducado o de otro mensaje no encola nada y solo cierra el spinner"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/incident-why.test.ts#ignores a repeated, expired or foreign why token"
        status: pass
    human_judgment: false

duration: 9 min
completed: 2026-11-26
status: complete
---

# Phase 05 Plan 03: Por qué me llegó esto Summary

**Respuesta citada y sin sonido desde el aviso de Telegram: una por estado del aviso, con la regla, el dato leído de la última muestra y el canal real, por el outbox y sin tocar la incidencia.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-11-26T14:33:47Z
- **Completed:** 2026-11-26T14:43:20Z
- **Tasks:** 2
- **Files modified:** 10 (2 creados, 8 modificados)

## Accomplishments

- `src/lib/incident-why.ts` define el estado del aviso: el mayor `seq` de los eventos `opened`, `severity` y `closed`. Reconocer, silenciar y quitar silencio no lo mueven porque no cambian lo que el aviso afirma (D-09).
- `enqueueWhyReply` encola una fila `incident-why` con `revision` igual a ese `seq`, el `chatId` y el `messageId` de la apertura confirmada y `.onConflictDoNothing()`: dos pulsaciones concurrentes del mismo estado dejan una sola fila (BOT-06).
- La rama `why` del carril usa la transacción del token: `queued` es `applied`, `duplicate` es `unchanged` ("Ya respondido" en el toast) y `unavailable` es `ignored`. Nada de la incidencia cambia.
- `keyboardActions` incluye `why` en las ocho combinaciones y devuelve solo `["why"]` en la resuelta; `renderActionRows` le da su propia fila, así el aviso resuelto conserva Abrir en el hub y Por qué (D-10).
- `sendTelegramReply` envía por el mismo `post()` del cliente con `reply_parameters` (`allow_sending_without_reply`), `disable_notification: true`, texto truncado a 4096 y sin `reply_markup`; un id no numérico se rechaza sin petición (D-06).
- `readingFor` devuelve el hecho puro por clave: máximo de temperaturas en °C, CPU en %, memoria `used/total` y el volumen más lleno, y nulo para contenedores, copias y despliegues.
- `whyFacts` y `renderWhyText` describen el estado actual al enviar: la resolución quita el dato leído y el silencio vivo cambia la pista (D-07, D-08).
- `dispatchWhy` reclama el tipo nuevo, marca el intento, compone el texto con la incidencia, la apertura, el silencio y la última muestra, y resuelve `sent`/`retry`/`rejected`/`uncertain` con las funciones existentes. `recordReplySent` no reescribe el destino citado ni programa una edición.

## Task Commits

Cada tarea se comprometió con el ciclo TDD en commits separados:

1. **Tarea 1 RED: pruebas que fallan de la respuesta por estado** - `50781ee` (test)
2. **Tarea 1 GREEN: una sola respuesta pendiente por estado del aviso** - `3fab753` (feat)
3. **Cobertura añadida: `noticeSeq` y concurrencia real** - `4ea0ebf` (test)
4. **Tarea 2 RED: pruebas que fallan de la respuesta citada y silenciosa** - `c96ff62` (test)
5. **Tarea 2 GREEN: respuesta citada, sin sonido y con los hechos vivos** - `f91abd0` (feat)
6. **Cobertura añadida: cliente de respuesta y hechos puros** - `1865f44` (test)

**Plan metadata:** `docs(05-03)` (este archivo, STATE, ROADMAP y WINDOWS)

_No hubo commit REFACTOR: las dos implementaciones GREEN ya eran mínimas._

## Files Created/Modified

- `src/lib/incident-why.ts` — `WHY_STATE_EVENT_KINDS`, `whyKey`, `noticeSeq`, `enqueueWhyReply`, `readingFor`, `whyFacts` y `renderWhyText`.
- `src/lib/telegram.ts` — `sendTelegramReply` con `reply_parameters`, `disable_notification` y sin teclado.
- `src/lib/telegram-updates.ts` — rama `why` de `applyTokenAction` y toast propio de "ya respondido".
- `src/lib/telegram-keyboard.ts` — `why` en todos los estados, etiqueta "Por qué me llegó esto" y su fila propia.
- `src/lib/notification-dispatch.ts` — `incident-why` en la lista reclamable, `dispatchWhy` y `recordReplySent`, y la rama en `runDispatchOnce`.
- `src/lib/schema.ts` — el JSDoc de `notificationOutbox.kind` lista `incident-why`; sin migración.
- `tests/incident-why.test.ts` — pulsación real por el carril, deduplicación por estado, escalada y cierre, concurrencia, tokens ajenos, matrices del teclado, envío citado, contenido por clave, resuelta, incierto, 429, rechazo y silencio.
- `tests/telegram.test.ts` — cuerpo de `sendTelegramReply` y el id no numérico sin petición.
- `tests/telegram-updates.test.ts` — la prueba de 05-01 cuenta la fila propia de Por qué en el teclado editado.
- `tests/incident-snooze.test.ts` — la matriz de 05-02 cuenta solo las acciones de estado, sin `why`.

## Decisions Made

- **El estado es el último evento que cambia lo que el aviso dice.** Usar `incidents.seq` habría dado una respuesta nueva por cada reconocimiento o silencio, justo lo que D-09 prohíbe.
- **La base impone la unicidad.** La clave `incident:<id>:why:<noticeSeq>` con `onConflictDoNothing` hace que dos pulsaciones concurrentes terminen una en `queued` y otra en `duplicate` sin bloqueo de aplicación.
- **La explicación se compone al enviar.** Guardar el texto en la fila lo habría congelado antes de una escalada o un cierre, y D-08 exige el estado actual.
- **El dato leído es la última muestra del host, no una columna del episodio.** Es el único hueco que dejaba la investigación entre D-07 y el código, y no requiere migración.
- **`recordReplySent` no reutiliza `recordTelegramSent`.** Reutilizarlo habría programado una edición del mensaje y sobrescrito `chatId`/`messageId`, que deben seguir apuntando al aviso citado.
- **Un rechazo confirmado no rearma ni crea push.** El tipo no es `incident-open` y T-05-12 lo acepta: la siguiente pulsación del mismo estado responde "ya respondido".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] La prueba de 05-01 contaba dos botones en la edición**
- **Found during:** Tarea 1 (GREEN)
- **Issue:** `tests/telegram-updates.test.ts` esperaba dos tokens en el teclado editado y dos filas; con `why` en todos los estados la edición emite tres acciones y tres filas.
- **Fix:** La prueba afirma ahora las dos acciones de silencio y la fila propia de la explicación.
- **Files modified:** `tests/telegram-updates.test.ts`
- **Verification:** `tests/telegram-updates.test.ts` en verde (9 pruebas).
- **Committed in:** `3fab753`

**2. [Rule 1 - Bug] Dos aserciones de mi propio RED describían mal el contrato**
- **Found during:** Tarea 2 (GREEN)
- **Issue:** El RED comprobaba el token en la URL capturada (que sí lo lleva por diseño, vive solo en `botRequest`) y pulsaba la clave `why` con el `message_id` de la primera apertura en un bucle con varias incidencias.
- **Fix:** Se afirma que el resultado y el cuerpo enviado no llevan el token, y cada pulsación usa el `messageId` de la apertura de su incidencia.
- **Files modified:** `tests/incident-why.test.ts`
- **Verification:** `tests/incident-why.test.ts` en verde (18 pruebas).
- **Committed in:** `f91abd0`

**Nota de contrato:** `noticeSeq` devuelve `number | null` en lugar de `number`; nulo solo es posible en una incidencia sin eventos de estado, que no existe en el flujo real (toda incidencia empieza con `opened`). `enqueueWhyReply` lo trata como `unavailable`.

---

**Total deviations:** 2 auto-fixed (2 bugs, ambos en pruebas), más una precisión de tipo.
**Impact on plan:** Ninguno cambia el alcance ni el producto; las dos correcciones mantienen las pruebas describiendo el comportamiento real.

## TDD Gate Compliance

| Gate | Commit | Evidence |
|------|--------|----------|
| RED (tarea 1) | `50781ee` `test(05-03): add failing tests for the why reply per notice state` | 7 de 7 pruebas nuevas fallan por aserción: `expected [] to have a length of 1`, `expected [ 'ack', 'snooze_1h', 'snooze_24h' ] to include 'why'`, `expected [ [ … ] ] to have a length of 2 but got 1`. La pulsación consumió el token y cerró el spinner, así que el carril corrió de extremo a extremo. Ninguna falla por carga o sintaxis. |
| GREEN (tarea 1) | `3fab753` `feat(05-03): queue one why reply per notice state` | 28/28 en las tres suites de la tarea y `pnpm typecheck` sin errores. |
| RED (tarea 2) | `c96ff62` `test(05-03): add failing tests for the quoted, silent why reply` | 9 de 9 pruebas nuevas fallan por aserción: el despacho devuelve `{ action: 'idle' }` frente a `sent`, y la fila nunca llega a `sent`; ninguna por carga o sintaxis. |
| GREEN (tarea 2) | `f91abd0` `feat(05-03): send the why reply quoted, silent and with the live facts` | 4 suites de la tarea → 101/101 y `pnpm typecheck` sin errores. |
| REFACTOR | — | No fue necesario: las implementaciones GREEN son mínimas. |
| Cobertura extra | `4ea0ebf`, `1865f44` | Pruebas añadidas para `noticeSeq`, la concurrencia real, el cuerpo del cliente y los hechos puros, cuya implementación ya estaba en los GREEN de este plan. |

El clasificador automático `tdd-red-evidence` devuelve `invalid_record` sobre el TAP de Vitest (`# time=` en el nombre de cada prueba); `workflow.tdd_mode` está desactivado en `.planning/config.json`, así que la compuerta no se aplica. La evidencia se guardó en `.gsd/tdd-evidence/05-03/red-task1.tap` y `.gsd/tdd-evidence/05-03/red-task2.log`, y la evaluación semántica queda arriba.

## Verification

- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-why.test.ts tests/incident-snooze.test.ts tests/telegram-updates.test.ts` → 3 archivos, 41 pruebas, todas en verde.
- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-why.test.ts tests/telegram.test.ts tests/notification-dispatch.test.ts tests/snooze-delivery.test.ts` → 4 archivos, 105 pruebas, todas en verde.
- `pnpm typecheck` → sin errores.
- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test` → 46 archivos, 612 pruebas, todas en verde (ninguna suite omitida).
- ESLint (adaptador TS 6 del proyecto) sobre los 10 archivos tocados → sin avisos.

## Issues Encountered

- El RED de la tarea 1 se escribió sin importar el módulo nuevo para no fallar por carga: cubre el comportamiento por el carril y el teclado. Las aserciones directas sobre `noticeSeq` y la concurrencia con dos transacciones se añadieron en `4ea0ebf`, en cuanto el símbolo existió.
- En la tarea 2, dos pruebas necesitaron el `messageId` real de cada apertura porque el fake incrementa el id en cada envío; se corrigió la prueba, no el producto.

## User Setup Required

None - no external service configuration required. Sin variables de entorno nuevas, dependencias ni migraciones (`drizzle/` intacto).

## Pending Human Verification (end-of-phase)

Aplazado al `human-check` de fin de fase por `workflow.human_verify_mode=end-of-phase`:

1. Con el bot real, provocar un aviso de temperatura con un valor por encima del umbral y pulsar "Por qué me llegó esto": el mensaje debe citar el aviso, llegar sin sonido y mostrar la regla con su umbral, el valor leído y el canal.
2. Reconocer el aviso y volver a pulsar Por qué en el teclado nuevo: no debe llegar otro mensaje y el toast debe decir que ya está respondido.
3. Escalar la incidencia a crítica: una pulsación nueva debe permitir otra respuesta que refleje la severidad actual.
4. Resolver la incidencia y comprobar que el teclado conserva solo "Por qué me llegó esto" y "Abrir en el hub", y que la respuesta ya no muestra el dato leído.
5. Con un silencio activo, pulsar Por qué: la respuesta debe salir igualmente.

## Next Phase Readiness

- `incident-why` queda como el cuarto tipo del outbox; 05-04 puede montar las acciones de Avisos sobre `applyIncidentAction` sin tocar este despacho.
- 05-05 hereda la batería de replays y la redacción del token en todos los métodos; aquí solo se cubre el resultado y el cuerpo de la respuesta.
- `keyboardActions` ya no tiene puntos de extensión pendientes; 05-04 y 05-06 pueden afirmar la matriz completa.
- BOT-05 y BOT-06 los declaran también planes hermanos; `requirements.ready-ids` los mantiene bloqueados hasta que el último plan de la fase publique su SUMMARY.

---
*Phase: 05-bot-de-lectura-y-reconocimiento*
*Completed: 2026-11-26*

## Self-Check: PASSED

- Los diez archivos creados y modificados existen en disco.
- Los commits `50781ee`, `3fab753`, `4ea0ebf`, `c96ff62`, `f91abd0` y `1865f44` son ancestros de HEAD.
- `pnpm typecheck` sin errores y la suite completa en verde (46 archivos, 612 pruebas).
