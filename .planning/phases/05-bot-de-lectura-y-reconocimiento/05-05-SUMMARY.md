---
phase: 05-bot-de-lectura-y-reconocimiento
plan: "05"
subsystem: notifications
tags: [telegram, long-polling, poisoning, offset, cleanup, vitest, redaction, contract-testing]

# Dependency graph
requires:
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "01"
    provides: carril de updates, allowlist, tokens de un solo uso, redactToken y el fake de la Bot API
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "02"
    provides: silencios por (hostId, key) y sus acciones
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "03"
    provides: respuesta de Por qué y su fila de outbox
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "04"
    provides: acciones del hub y etiquetas del resumen
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "06"
    provides: pruebas del token y de la migración 0007
provides:
  - Un update veneno se descarta tras 3 intentos sin frenar el carril
  - Un 409 vuelve a borrar el webhook antes del siguiente poll con retroceso acotado
  - La limpieza horaria borra tokens vencidos desde hace más de un día y silencios vencidos desde hace más de 7 días
  - El contrato del Update fijado con fixtures reales y la matriz completa de la allowlist
  - La matriz de replays de las cinco acciones en seis escenarios
  - La captura total de resultados, logs y filas para cada método y modo de fallo del cliente
affects: [verify-work, fase-6, fase-7]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 19446
  tasks: 3
  commits: 4
  plan_head_before: 067ef8433d85fb28cf164ea4a3ca19e233db22c6
  plan_head_after: c250841a4a4483655baef67e807cdb38268bdb09

tech-stack:
  added: []
  patterns:
    - "Cota del update veneno por vida del proceso: contador en memoria por update_id, salto del offset al tercer fallo"
    - "Un 409 re-arma el borrado del webhook en lugar de reintentar el poll sobre un conflicto"
    - "Limpieza de estado del bot como dos borrados parametrizados que devuelven su recuento exacto"
    - "Prueba de redacción por matriz método × modo de fallo, con un cuerpo que repite /bot<token>/método"
    - "Prueba estructural del árbol real: una sola formación de la URL con el token"

key-files:
  created:
    - src/lib/telegram-cleanup.ts
    - tests/telegram-lane-hardening.test.ts
    - tests/telegram-contract.test.ts
    - tests/telegram-replays.test.ts
    - tests/telegram-redaction.test.ts
  modified:
    - src/lib/telegram-updates.ts
    - src/worker.ts

key-decisions:
  - "El 409 no se reintenta sobre el mismo poll: marca el webhook para borrarlo otra vez en el siguiente run y deja que el retroceso de 1 a 30 s gobierne la espera"
  - "POISON_MAX_ATTEMPTS y OFFSET_RESET_AFTER_MS sustituyen a los nombres internos de 05-01; el valor no cambia (3 y 6 días)"
  - "La línea del update descartado deja de llevar el update_id, como pide el plan, y sigue sin llevar contenido"
  - "La limpieza no toca telegram_poll_state: el offset es la posición durable del carril y solo él la mueve"
  - "Los conteos de la limpieza son las filas borradas que devuelve el propio delete, no una consulta previa"
  - "El contrato y los replays son pruebas de caracterización sobre el carril de 05-01 a 05-03: no hizo falta tocar producto"
  - "La suite de redacción comprueba el árbol real con node:fs en lugar de fijar una lista de archivos"

patterns-established:
  - "Un fallo de infraestructura cuenta para la cota del veneno; un resultado de usuario (used, expired, mismatch, missing) nunca cuenta"
  - "El fake de la Bot API se envuelve en la prueba cuando hace falta un 409, sin ampliar el arnés compartido"
  - "Cada acción se mide por filas y eventos durables, nunca por el texto del toast"
  - "La apertura incierta se prueba como una fila incident-open en uncertain sin messageId: el token no se quema y el toast es genérico"

requirements-completed: [BOT-02, BOT-06, BOT-10]

coverage:
  - id: D1
    description: "Un update veneno deja el offset quieto en los dos primeros intentos, salta en el tercero y el siguiente poll pide el id posterior, sin efecto y sin contenido en el log"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#drops a poisoned update after three attempts and keeps the queue moving"
        status: pass
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#treats a user failure as a result, never as a poisoned update"
        status: pass
    human_judgment: false
  - id: D2
    description: "Tras 6 días sin updates el offset se omite y un id menor se procesa y se guarda; con 5 días el offset es el guardado más uno"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#omits a stale offset so a random id after a week is still processed"
        status: pass
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#keeps the offset while the stored id is fresh"
        status: pass
    human_judgment: false
  - id: D3
    description: "Un 409 provoca un deleteWebhook antes del siguiente getUpdates y respeta el retroceso de 1 s, sin bucle caliente"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#removes the webhook again before polling after a conflict"
        status: pass
    human_judgment: false
  - id: D4
    description: "La limpieza horaria borra los tokens vencidos desde hace más de un día y los silencios vencidos desde hace más de 7 días, con recuentos exactos, sin tocar lo vigente ni el estado del polling, y está conectada al worker"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#prunes expired tokens and silences without touching live state"
        status: pass
      - kind: integration
        ref: "tests/telegram-lane-hardening.test.ts#keeps the retention windows of the cleanup at a day and a week"
        status: pass
      - kind: other
        ref: "grep -v '^ *//' src/worker.ts | grep -c cleanupTelegramState == 2"
        status: pass
    human_judgment: false
  - id: D5
    description: "El contrato del Update queda fijado con fixtures reales (campos adicionales, mensaje inaccesible, sin message) y cada condición de la allowlist deniega por sí sola"
    requirement: "BOT-02"
    verification:
      - kind: unit
        ref: "tests/telegram-contract.test.ts#classifies every real-shaped fixture without throwing"
        status: pass
      - kind: unit
        ref: "tests/telegram-contract.test.ts#denies on each allowlist condition on its own"
        status: pass
      - kind: unit
        ref: "tests/telegram-contract.test.ts#returns a result for every degenerate input"
        status: pass
      - kind: integration
        ref: "tests/telegram-contract.test.ts#advances the offset for every foreign update kind without answering"
        status: pass
    human_judgment: false
  - id: D6
    description: "Cada una de las cinco acciones soporta token repetido, offset sin confirmar, caducidad, mensaje ajeno, incidencia borrada y reinicio del carril con como mucho un efecto, sin excepción y con una respuesta por update tratado"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/telegram-replays.test.ts#ack / snooze_1h / snooze_24h / unsnooze / why × six scenarios (30 casos)"
        status: pass
      - kind: integration
        ref: "tests/telegram-replays.test.ts#answers generically when the opening delivery stayed uncertain"
        status: pass
      - kind: integration
        ref: "tests/telegram-replays.test.ts#keeps the second button of an unedited keyboard independent"
        status: pass
    human_judgment: false
  - id: D7
    description: "El token del bot no aparece en el resultado de ningún método ni modo de fallo, ni en un log del carril, ni en una fila de outbox o de resumen, y la URL con el token se forma una sola vez en botRequest"
    requirement: "BOT-10"
    verification:
      - kind: unit
        ref: "tests/telegram-redaction.test.ts#six client methods × thirteen failure modes"
        status: pass
      - kind: integration
        ref: "tests/telegram-redaction.test.ts#keeps the token and the update content out of every log line"
        status: pass
      - kind: integration
        ref: "tests/telegram-redaction.test.ts#keeps the token out of the opening and the edit rows / the reply row / the digest row"
        status: pass
      - kind: unit
        ref: "tests/telegram-redaction.test.ts#builds the URL with the token in a single place"
        status: pass
    human_judgment: false
  - id: D8
    description: "La comprobación con el bot real (los cuatro botones, la sonoridad, el log del worker), la de media-stack y la suite con Node 26"
    requirement: "BOT-10"
    verification: []
    human_judgment: true
    rationale: "Requiere el bot real, el cliente de Telegram y su sonoridad, el contenedor del worker, el repositorio hermano media-stack y la versión 26 de Node del CI; el fake y el runner local (v24.22.3) no los prueban."

duration: 11 min
completed: 2026-11-26
status: complete
---

# Phase 05 Plan 05: El bot resiste y no filtra Summary

**El carril sobrevive a un update veneno, a una semana de silencio y a un 409, la limpieza horaria acota los tokens y los silencios, y las matrices de contrato, replays y redacción fijan BOT-02, BOT-06 y BOT-10 sobre todo lo construido en 05-01 a 05-04.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-11-26T15:16:57Z
- **Completed:** 2026-11-26T15:27:23Z
- **Tasks:** 3
- **Files modified:** 7 (5 creados, 2 modificados)

## Accomplishments

- Un 409 de `getUpdates` ya no se reintenta sobre el mismo carril: se re-arma el borrado del webhook para el `run` siguiente y se aplica el retroceso de 1 s a 30 s, verificado por el orden exacto `deleteWebhook → getUpdates(409) → deleteWebhook → getUpdates(200)`.
- `POISON_MAX_ATTEMPTS` (3) y `OFFSET_RESET_AFTER_MS` (6 días) dan nombre a las dos cotas del carril; el descarte del veneno ya no imprime el `update_id` y sigue sin imprimir contenido.
- `src/lib/telegram-cleanup.ts` borra los tokens vencidos desde hace más de un día y los silencios vencidos desde hace más de 7 días, devuelve los recuentos exactos y no toca `telegram_poll_state`; la limpieza horaria de `src/worker.ts` la llama con el pool y `new Date()`.
- El contrato del `Update` queda fijado con veinte fixtures de forma real (`chat_instance`, `language_code`, `entities`, `reply_markup`, mensaje inaccesible `date: 0`, sin `message`) y con 24 entradas degeneradas que devuelven un resultado sin lanzar.
- La allowlist se prueba por unicidad: cada una de las seis condiciones deniega por sí sola, y el mensaje inaccesible con un token válido de su mensaje se autoriza.
- Las cinco acciones (`ack`, `snooze_1h`, `snooze_24h`, `unsnooze`, `why`) recorren seis escenarios de replay cada una con como mucho un efecto, `ok: true` y una respuesta por update tratado.
- La apertura incierta sin `messageId` no escribe nada, no quema el token y recibe el aviso genérico; el segundo botón de un teclado aún sin editar funciona con su propio token.
- La redacción cubre seis métodos del cliente por trece modos de fallo (200 válido, 400, 401, 403, 404, 409, 429, 500, 200 con JSON inválido, rechazo del transporte con `cause`, aborto, tiempo agotado y redirección), además de logs y filas, y una prueba estructural mide el árbol real.

## Task Commits

1. **Tarea 1 RED: pruebas que fallan del endurecimiento y la limpieza** — `b62ec9c` (test)
2. **Tarea 1 GREEN: veneno, hueco de una semana, 409 y limpieza** — `5423b2e` (feat)
3. **Tarea 2: contrato del Update y replays de cada acción** — `e7f54df` (test)
4. **Tarea 3: el token fuera de resultados, logs y filas** — `c250841` (test)

**Plan metadata:** `docs(05-05)` (este archivo, STATE y ROADMAP)

No hubo commit REFACTOR: la implementación de la tarea 1 ya era mínima y las tareas 2 y 3 no tocaron producto.

## Files Created/Modified

- `src/lib/telegram-cleanup.ts` — `TOKEN_RETENTION_AFTER_EXPIRY_MS`, `SNOOZE_RETENTION_MS` y `cleanupTelegramState(executor, now)` con los dos borrados y sus recuentos.
- `src/lib/telegram-updates.ts` — `POISON_MAX_ATTEMPTS` y `OFFSET_RESET_AFTER_MS` en lugar de los nombres internos de 05-01, re-arme del `deleteWebhook` tras un `conflict` y línea del descarte sin `update_id`.
- `src/worker.ts` — `cleanupTelegramState(db, new Date())` al final de la limpieza horaria, sin cambiar el intervalo ni el resto de la limpieza.
- `tests/telegram-lane-hardening.test.ts` — veneno con fallo inyectado sobre `applyIncidentAction`, caso de usuario, hueco de 7 frente a 5 días, 409 y limpieza con filas vencidas, recientes, vigentes y usadas.
- `tests/telegram-contract.test.ts` — fixtures reales, matriz de la allowlist, entradas degeneradas, tipos ajenos por el carril real y cero filas dejadas.
- `tests/telegram-replays.test.ts` — cinco acciones × seis escenarios, apertura incierta y segundo botón del teclado sin editar.
- `tests/telegram-redaction.test.ts` — matriz método × fallo, captura de `console.*` y del `log` del carril, filas de outbox y de resumen, y prueba estructural del árbol.

## Decisions Made

- **El conflicto se resuelve borrando el webhook otra vez, no reintentando el poll.** Un 409 significa que hay un webhook o un segundo consumidor; reintentar sobre el mismo estado solo repite el error. El retroceso acotado evita el bucle caliente (T-05-17).
- **Los nombres de las cotas son los del contrato del plan.** `POISON_MAX_ATTEMPTS` y `OFFSET_RESET_AFTER_MS` sustituyen a `TELEGRAM_UPDATE_MAX_ATTEMPTS` y `TELEGRAM_POLL_STALE_MS`; los valores y el comportamiento no cambian.
- **La línea del descarte no lleva el `update_id`.** El plan pide una línea "sin id, sin contenido"; 05-01 imprimía el id. Se ajusta al plan y la prueba exige que ni el canario ni el token aparezcan.
- **La limpieza devuelve lo que borra.** Los recuentos salen de las filas que devuelve el propio `delete`, así el número no puede discrepar del efecto.
- **La limpieza no toca el polling.** `telegram_poll_state` es la posición durable del carril: borrarla reabriría una semana de updates.
- **Las tareas 2 y 3 son caracterización, no corrección.** El carril de 05-01 a 05-03 ya cumplía el contrato y ya redactaba el token; las suites se escribieron para fijarlo y quedaron verdes en la primera ejecución, sin cambio de producto.
- **La prueba de la URL se mide sobre el árbol real.** Recorre `src/` con `node:fs` y exige una única coincidencia en `src/lib/telegram.ts`, en lugar de fijar una lista de archivos que envejece.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Alineación con el plan] La línea del update descartado llevaba el `update_id`**
- **Found during:** Tarea 1 (GREEN)
- **Issue:** 05-01 dejó `Update <id> descartado tras N intentos`; el plan de 05-05 pide una línea "sin id, sin contenido". Publicar el id de un update veneno no es contenido, pero el plan lo excluye expresamente.
- **Fix:** la línea pasa a `Update descartado tras N intentos`; la prueba afirma que ni el canario del update ni el token aparecen y que la línea es finita.
- **Files modified:** `src/lib/telegram-updates.ts`, `tests/telegram-lane-hardening.test.ts`
- **Verification:** `tests/telegram-lane-hardening.test.ts` en verde (7 pruebas).
- **Committed in:** `5423b2e`

---

**Total deviations:** 1 auto-fixed (1 alineación con el plan).
**Impact on plan:** Ninguno sobre el alcance: el comportamiento observable del carril es el mismo y el log conserva la única información operativa (que un update se descartó y tras cuántos intentos).

## TDD Gate Compliance

| Gate | Commit | Evidence |
|------|--------|----------|
| RED (tarea 1) | `b62ec9c` `test(05-05): add failing tests for the lane hardening and the state cleanup` | 3 de 7 pruebas en rojo: `expected ['deleteWebhook','getUpdates'] to deeply equal [...4]` en el 409 y `Cannot find package '@/lib/telegram-cleanup'` en las dos de limpieza. Las otras 4 (veneno, caso de usuario, hueco de 7 días y offset fresco) ya pasaban: 05-01 implementó esa cota y esa omisión. |
| GREEN (tarea 1) | `5423b2e` `feat(05-05): survive a poison update, a stale offset and a conflict` | `tests/telegram-lane-hardening.test.ts` + `tests/telegram-updates.test.ts` → 16/16 y `pnpm typecheck` sin errores. |
| RED/GREEN (tarea 2) | `e7f54df` `test(05-05): fix the update contract and the replays of every action` | Caracterización: las 32 pruebas nacieron verdes contra el carril existente. `.planning/config.json` tiene `workflow.tdd_mode` sin activar, así que la compuerta es informativa y no hay GREEN que registrar. |
| RED/GREEN (tarea 3) | `c250841` `test(05-05): keep the bot token out of every result, log and row` | Caracterización: las 11 pruebas nacieron verdes; no hubo fuga que corregir en `src/lib/telegram.ts` ni en el `log` del carril. |
| REFACTOR | — | No fue necesario: la implementación añadida es mínima. |

## Verification

- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-lane-hardening.test.ts tests/telegram-updates.test.ts` → 2 archivos, 16 pruebas en verde.
- `pnpm typecheck` → sin errores.
- `grep -v '^ *//' src/worker.ts | grep -c cleanupTelegramState` → `2` (importación y llamada).
- `DATABASE_URL=… HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-contract.test.ts tests/telegram-replays.test.ts tests/telegram-updates.test.ts tests/incident-actions.test.ts` → 4 archivos, 50 pruebas en verde.
- `DATABASE_URL=… HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-redaction.test.ts tests/telegram.test.ts` → 2 archivos, 33 pruebas en verde.
- `pnpm lint src tests` → exit 0 sin avisos. El `pnpm lint` sin rutas del plan recorre `.agents/`, `.claude/`, `.codex/` y `.opencode/`, que no están versionados, y acumula avisos ajenos al proyecto (misma observación que en 05-04).
- `DATABASE_URL=… HUB_REQUIRE_TEST_DB=1 pnpm test` completo → 51 archivos, 679 pruebas en verde; ninguna suite de PostgreSQL omitida.
- `pnpm build` → Next.js 16.4.6 compila, ejecuta el typecheck y genera las rutas.
- **Node 26 no se pudo ejecutar en local:** la versión instalada es v24.22.3 y no hay `nvm`, `fnm`, `mise` ni `volta`. `ci.yml` ejecuta `pnpm test` con Node 26, así que esta suite corre allí con esa versión; la repetición local con 26 queda en la verificación manual de cierre.

## Issues Encountered

- El `sendOpening` de la suite de replays comparte el arnés de los planes anteriores, pero el fake confirma por offset y no consume la cola: una prueba que reenviaba el mismo `update_id` dos veces recibía dos respuestas en un solo poll. Se corrigió la prueba (se vuelve a ejecutar el carril sin encolar otra vez), no el producto.
- En la suite de redacción, las filas de un episodio crítico rechazado crean un respaldo de `incident-push`, que gana el siguiente reclamo y devuelve `suppressed`; la prueba del episodio rechazado usa `warning` para no introducir ese segundo trabajo.
- El primer test del contrato se escribió en un `describe` sin base de datos y el pool se inicializaba antes de que `DATABASE_URL` apuntara a la base desechable. Se unificó en un único `describe` que crea la base e importa los módulos en `beforeAll`, como el resto de suites.

## Threat Flags

None. El plan no añade superficie: la limpieza solo borra filas propias, el 409 solo repite un `deleteWebhook` que ya existía en el arranque del carril y las pruebas nuevas no abren red, ficheros ni dependencias (T-05-SC: sin paquetes nuevos).

## User Setup Required

None - no external service configuration required. Sin migraciones (`drizzle/` intacto), variables de entorno ni dependencias nuevas.

## Pending Human Verification (end-of-phase)

Aplazado al `human-check` de fin de fase por `workflow.human_verify_mode=end-of-phase`:

1. Con el bot real y el hub de pruebas, provocar un aviso crítico inmediato y pulsar los cuatro botones (Reconocer, Silenciar 1 h, Por qué me llegó esto, Quitar silencio): cada edición debe ser silenciosa, la respuesta de Por qué debe citar el aviso sin sonido, Avisos debe mostrar el estado y el resumen del día siguiente debe etiquetar el episodio.
2. Revisar `docker compose logs worker` durante esa sesión: ninguna línea debe contener el token del bot.
3. Ejecutar la suite completa con Node 26 (`pnpm test` con la versión del CI) y confirmar que ninguna suite de PostgreSQL se omite.
4. En el repositorio `media-stack`, buscar `getUpdates` o `setWebhook` con el mismo token (Open Question 3 de 05-RESEARCH). Si existiera un segundo consumidor, el carril no debe activarse en producción hasta resolverlo; el 409 ya no detiene el bot, pero la pulsación se perdería.
5. El efecto de la omisión del offset tras seis días sobre el servidor de Telegram (Assumption A1) no es verificable sin el bot real.

## Next Phase Readiness

- El carril queda acotado por los cuatro lados: veneno, hueco de una semana, conflicto y crecimiento de tablas. La fase 6 puede apoyarse en que un update raro no detiene el worker.
- `tests/telegram-redaction.test.ts` es el punto donde la fase 7 añade cualquier método nuevo del cliente: la matriz método × fallo y la prueba estructural fallan solas si aparece una segunda URL con token.
- BOT-02, BOT-06 y BOT-10 los declaran también planes hermanos; `requirements.ready-ids` los marcará completos cuando el último plan de la fase publique su SUMMARY (05-06 ya lo hizo, así que este plan debería desbloquearlos).

---

*Phase: 05-bot-de-lectura-y-reconocimiento*
*Completed: 2026-11-26*

## Self-Check: PASSED

- Existen en disco `src/lib/telegram-cleanup.ts`, `tests/telegram-lane-hardening.test.ts`, `tests/telegram-contract.test.ts`, `tests/telegram-replays.test.ts` y `tests/telegram-redaction.test.ts`.
- Los commits `b62ec9c`, `5423b2e`, `e7f54df` y `c250841` son ancestros de HEAD.
- `git rev-list --count 067ef84..HEAD` = 4, el mismo número que declara `actuals.commits`.
- `pnpm typecheck` sin errores, `pnpm lint src tests` sin avisos, la suite completa en verde (679 pruebas) y `pnpm build` correcto.
