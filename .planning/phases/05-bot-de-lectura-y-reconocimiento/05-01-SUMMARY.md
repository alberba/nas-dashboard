---
phase: 05-bot-de-lectura-y-reconocimiento
plan: "01"
subsystem: notifications
tags: [telegram, long-polling, callback-tokens, drizzle, worker-loop, madrid-time]

# Dependency graph
requires:
  - phase: 02-incidencias-y-entrega-nica
    provides: notification_outbox transaccional, lock de recolección y edición del aviso
  - phase: 04-resumen-diario
    provides: bucle del worker dueño del lock y marca de salud por hitos
provides:
  - Carril de updates por long polling con offset transaccional y allowlist doble
  - Tokens opacos de un solo uso ligados a incidencia, acción, chat y mensaje
  - Acción de reconocer compartida por Telegram y el hub, con edición silenciosa
  - Migración 0007 aditiva con tokens, silencios y estado del polling
  - Reloj de Madrid independiente de la zona del proceso
affects: [05-02, 05-03, 05-04, 05-05, 05-06]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 34627
  tasks: 2
  commits: 4
  plan_head_before: 91fecb4664d6da14ddc3591258e6ba8e9fab9169
  plan_head_after: b117d7aa775f4e9ca3d5e9b3353873212f860a72

tech-stack:
  added: []
  patterns:
    - "Carril de polling como último hito del bucle que posee el lock: solo el dueño consume"
    - "Token opaco hasheado con consumo atómico y avance del offset en la misma transacción"
    - "Allowlist como función pura sobre un Update tolerante, sin red ni base de datos"

key-files:
  created:
    - drizzle/0007_bot_reconocimiento.sql
    - drizzle/meta/0007_snapshot.json
    - src/lib/telegram-keyboard.ts
    - src/lib/telegram-updates.ts
    - src/lib/incident-actions.ts
    - tests/telegram-fake.ts
    - tests/telegram-updates.test.ts
  modified:
    - src/lib/schema.ts
    - src/lib/telegram.ts
    - src/lib/incident-store.ts
    - src/lib/notification-dispatch.ts
    - src/lib/madrid-day.ts
    - src/lib/worker-loop.ts
    - src/worker.ts
    - tests/madrid-day.test.ts
    - tests/migrations.test.ts

key-decisions:
  - "El token se consume, el efecto se aplica y el offset avanza en una sola transacción del pool: un replay no repite el efecto y una muerte antes del commit reentrega el update con el token intacto"
  - "En la base vive solo sha256(token); el mensaje se valida contra la fila confirmada incident:<id>:open para no guardar message_id en el token"
  - "La allowlist exige from.id y chat.id iguales al chat configurado, chat privado, mensaje del bot y token bien formado; todo lo demás solo avanza el offset"
  - "El carril no arranca con un chatId negativo y deja una única línea de log finita"
  - "Un 429 abre el cooldown compartido; un fallo reinicia un retroceso de 1 s a 30 s y no renueva la marca de salud"
  - "queueEdit es el único escritor de incident-edit y lo usan cierre, escalada y reconocimiento"
  - "madridClock usa Intl con Europe/Madrid; ninguna etiqueta depende de la zona del proceso"

patterns-established:
  - "Render-time tokens: los botones se emiten justo antes del envío; un envío fallido deja filas inocuas"
  - "Actualización del offset para updates no autorizados con un UPSERT mínimo, sin acción, respuesta ni log de su contenido"
  - "Cota del update veneno: tras 3 intentos fallidos se avanza el offset con una línea que solo lleva update_id"

requirements-completed: [BOT-02, BOT-04, BOT-06, BOT-10]

coverage:
  - id: D1
    description: "Carril de long polling dentro del bucle que posee el lock, con allowlist doble y offset transaccional"
    requirement: "BOT-02"
    verification:
      - kind: integration
        ref: "tests/telegram-updates.test.ts#ignores every unauthorised update, only advancing the offset"
        status: pass
      - kind: integration
        ref: "tests/telegram-updates.test.ts#repeats no effect when the same update or button arrives again"
        status: pass
      - kind: unit
        ref: "tests/telegram-updates.test.ts#authorises only the operator pressing a button in the private chat"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reconocer desde Telegram guarda quién, cuándo y canal, y edita el aviso en silencio sin el botón"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/telegram-updates.test.ts#acknowledges a real notice once and edits the same message"
        status: pass
    human_judgment: true
    rationale: "Que el reconocimiento sobreviva a un reinicio con el bot real y que media-stack no consuma el mismo token exige el teléfono y otro repositorio; queda en el human-check de fin de fase."
  - id: D3
    description: "Token opaco de 128 bits y 25 bytes, hash en la base, consumo único ligado a chat y mensaje"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/telegram-updates.test.ts#acknowledges a real notice once and edits the same message"
        status: pass
      - kind: integration
        ref: "tests/telegram-updates.test.ts#repeats no effect when the same update or button arrives again"
        status: pass
    human_judgment: false
  - id: D4
    description: "La URL con el token se forma solo en botRequest y toda línea del carril pasa por redactToken"
    requirement: "BOT-10"
    verification: []
    human_judgment: true
    rationale: "La batería completa de captura y redacción en todos los métodos es de 05-05; este plan solo deja el punto único y la redacción aplicada."
  - id: D5
    description: "El aviso reconocido muestra la hora de Madrid del reconocimiento con independencia de la zona del proceso"
    requirement: "BOT-04"
    verification:
      - kind: unit
        ref: "tests/madrid-day.test.ts#acknowledgement clock in Europe/Madrid"
        status: pass
      - kind: integration
        ref: "tests/telegram-updates.test.ts#acknowledges a real notice once and edits the same message"
        status: pass
      - kind: integration
        ref: "tests/telegram-updates.test.ts#leaves the acknowledgement clock out of an unacknowledged notice"
        status: pass
    human_judgment: false
  - id: D6
    description: "El poll es un hito más del worker: no renueva la marca de salud al fallar y sustituye el reposo de 1 s"
    requirement: "BOT-02"
    verification:
      - kind: unit
        ref: "tests/telegram-updates.test.ts#does not renew the health mark when the poll fails"
        status: pass
      - kind: unit
        ref: "tests/telegram-updates.test.ts#bounds the poll wait to the next collection"
        status: pass
    human_judgment: false
  - id: D7
    description: "Migración 0007 aditiva: tokens, silencios, estado del polling y columnas de reconocimiento"
    verification:
      - kind: integration
        ref: "tests/telegram-updates.test.ts#beforeAll migrates a disposable database to head"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#keeps SQL, snapshot and journal aligned"
        status: pass
    human_judgment: false

duration: 48 min
completed: 2026-11-26
status: complete
---

# Phase 05 Plan 01: Reconocer un aviso real desde Telegram Summary

**Botón Reconocer en el aviso real: long polling dentro del bucle que posee el lock, token de un solo uso consumido en la misma transacción que la edición silenciosa, y la hora de Madrid en el mensaje editado.**

## Performance

- **Duration:** 48 min
- **Started:** 2026-11-26T12:52:00Z
- **Completed:** 2026-11-26T13:40:00Z
- **Tasks:** 2
- **Files modified:** 17

## Accomplishments

- Un aviso real sale con la fila del botón "Abrir en el hub" y una segunda fila con un botón Reconocer cuyo `callback_data` es `v1:<22 base64url>` (25 bytes).
- Solo el hash del token se persiste; el consumo es un `UPDATE ... WHERE usedAt IS NULL AND expiresAt > now RETURNING` dentro de la transacción que aplica el efecto y avanza `telegram_poll_state`.
- El reconocimiento guarda `acknowledgedAt` con zona, `acknowledgedVia = telegram` y `acknowledgedBy` nulo, sube `seq`, escribe un único evento `acknowledged` y encola una edición por `queueEdit`.
- La edición silenciosa quita Reconocer del teclado y añade la hora de Madrid del reconocimiento, calculada con `Intl` sobre Europe/Madrid.
- Un update ajeno, de otro chat, de grupo, de texto o de comando (incluido del operador) solo avanza el offset: ninguna acción, ninguna respuesta y ningún log de su contenido.
- El carril respeta el lock y el cooldown compartido, elimina cualquier webhook antes del primer poll, envía siempre `allowed_updates: ["callback_query"]` y no renueva la marca de salud cuando falla.

## Task Commits

1. **Task 1: Pulsar Reconocer deja la incidencia reconocida y edita el mensaje** — `e6e7147` (feat)
2. **Task 2 RED: prueba que falla del reloj de Madrid** — `6620e45` (test)
3. **Task 2 GREEN: reloj de Madrid en el aviso editado** — `24dddd8` (feat)
4. **Regresión de la suite de migraciones** — `b117d7a` (fix)

**Plan metadata:** `docs(05-01)` (este archivo, STATE y ROADMAP)

_La tarea 2 llevó el ciclo TDD completo; no hizo falta un commit REFACTOR porque la implementación ya era mínima._

## Files Created/Modified

- `drizzle/0007_bot_reconocimiento.sql` — tablas `telegram_action_tokens`, `incident_snoozes`, `telegram_poll_state` y columnas de reconocimiento en `incidents` (generada por `drizzle-kit generate`, no escrita a mano).
- `drizzle/meta/0007_snapshot.json`, `drizzle/meta/_journal.json` — metadatos de la migración; `when` posterior al de 0006.
- `src/lib/schema.ts` — modelo de tokens, silencios, estado del polling y reconocimiento.
- `src/lib/telegram.ts` — `botRequest` como único constructor de la URL, `getTelegramUpdates`, `deleteTelegramWebhook`, `answerTelegramCallback`, `redactToken` y filas de acciones en el teclado.
- `src/lib/telegram-keyboard.ts` — tokens de 128 bits, hash, parser estricto, matriz de acciones y emisión en el render.
- `src/lib/telegram-updates.ts` — esquema tolerante del Update, allowlist pura, `applyTokenAction` y el carril con offset y retroceso.
- `src/lib/incident-actions.ts` — `applyIncidentAction` (ack) y `consumeActionToken` con seis razones finitas.
- `src/lib/incident-store.ts` — `queueEdit` exportada; cierre y escalada la reutilizan sin cambiar su comportamiento.
- `src/lib/notification-dispatch.ts` — emisión de tokens antes de la marca de intento y `actionRows` en apertura y edición; hora de Madrid en el texto editado.
- `src/lib/madrid-day.ts` — `madridClock`.
- `src/lib/worker-loop.ts` — dependencia opcional `updates`, `WORKER_UPDATES_MAX_WAIT_SECONDS` y `updatesWaitSeconds`.
- `src/worker.ts` — el carril sustituye `delay(WORKER_IDLE_MS)` y recibe la señal de apagado.
- `tests/telegram-fake.ts` — Bot API simulada con confirmación por offset, `allowed_updates`, `deleteWebhook` y fallos de un solo uso.
- `tests/telegram-updates.test.ts` — prueba de punta a punta, batería negativa, idempotencia, teclado, salud y reloj de Madrid.
- `tests/madrid-day.test.ts` — reloj de Madrid en invierno, verano y los dos cambios de hora de 2026.
- `tests/migrations.test.ts` — comparación de columnas contra el snapshot más reciente.

## Decisions Made

- **Una transacción por update autorizado.** Consumir el token, aplicar el efecto, encolar la edición y avanzar el offset comparten commit; la entrega "al menos una vez" de Telegram se convierte en efecto único.
- **El token no guarda `message_id`.** Se valida contra la fila `incident:<id>:open` ya confirmada, que es la prueba de que el botón pertenece a ese mensaje.
- **Los tokens se emiten en cada render.** Un envío fallido deja filas sin usar, nunca un botón huérfano reutilizable.
- **Carril desactivado con chat negativo.** La allowlist supone un chat privado; un grupo quedaría mudo sin avisar, así que se deja una línea de log finita y no se llama a la API.
- **Backoff de 1 s a 30 s y cota del update veneno.** Un fallo repetido no forma un bucle caliente ni bloquea la cola para siempre.
- **`madridClock` con `Intl`.** Ningún offset fijo ni la zona del proceso pueden mover la etiqueta.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] La suite de migraciones comparaba columnas contra el snapshot 0005**
- **Found during:** Verificación final del plan
- **Issue:** `tests/migrations.test.ts` comparaba las columnas vivas de `incidents` con las del snapshot 0005; las tres columnas aditivas de 0007 hacían fallar la igualdad aunque la migración es correcta.
- **Fix:** La cadena histórica de 0005 conserva sus aserciones y las columnas e índices vivos se comparan contra el snapshot más reciente del journal.
- **Files modified:** `tests/migrations.test.ts`
- **Verification:** `pnpm test` completo en verde (42 archivos, 564 pruebas).
- **Commit:** `b117d7a`

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** La corrección mantiene la prueba de alineación útil para futuras migraciones aditivas; no cambia código de producción.

## TDD Gate Compliance

| Gate | Commit | Evidence |
|------|--------|----------|
| RED | `6620e45` `test(05-01): add failing test for the Madrid acknowledgement clock` | `madridClock` devolvía `undefined` frente a `10:32` y la edición no contenía el `HH:mm` calculado; fallos de aserción, no de carga |
| GREEN | `24dddd8` `feat(05-01): show the Madrid acknowledgement clock in the edited notice` | Las tres suites de la tarea 2 pasan con `TZ=Pacific/Honolulu` (78 pruebas) |
| REFACTOR | — | No fue necesario: la implementación es mínima |

La tarea 1 es trazadora y no TDD; se ejecutó como producción y se verificó de extremo a extremo antes de la tarea 2.

## Verification

- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-updates.test.ts tests/telegram.test.ts tests/incident-store.test.ts tests/notification-dispatch.test.ts` → 4 archivos, 91 pruebas, todas en verde.
- `TZ=Pacific/Honolulu DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/madrid-day.test.ts tests/telegram-updates.test.ts tests/notification-dispatch.test.ts` → 3 archivos, 78 pruebas, todas en verde.
- `pnpm typecheck` → sin errores.
- `pnpm test` completo con base desechable → 42 archivos, 564 pruebas, todas en verde.
- ESLint (con el adaptador TS 6 del proyecto) sobre los archivos tocados → sin avisos.

## Issues Encountered

- El fake devolvía `message_id` como número en la edición y la prueba lo esperaba así; en el cuerpo real viaja como cadena porque `notification_outbox.messageId` es texto. Se ajustó la expectativa, no el producto.
- `deleteWebhook` aparece en la primera llamada de cada carril nuevo; la batería negativa lo incluye en la lista de salidas esperadas.

## User Setup Required

None - no external service configuration required. No hay variables de entorno nuevas (D-11).

## Pending Human Verification (end-of-phase)

Aplazado al `human-check` de fin de fase por `workflow.human_verify_mode=end-of-phase`:

1. Con el bot real y el worker arrancado, provocar un aviso crítico, pulsar Reconocer en Telegram y comprobar que el mensaje se edita sin sonido y sin el botón.
2. Reiniciar el worker y confirmar que el reconocimiento sigue guardado con canal `telegram`.
3. En el repositorio `media-stack`, buscar cualquier `getUpdates` o `setWebhook` con el mismo token (Open Question 3); si existiera, el carril no debe activarse en producción hasta resolverlo.

## Next Phase Readiness

- El contrato del carril, el modelo de token, la migración 0007 y la matriz del teclado quedan fijados para 05-02 a 05-05.
- `applyTokenAction` devuelve `ignored` para `snooze_1h`, `snooze_24h`, `unsnooze` y `why`, y `keyboardActions` solo emite `ack`: son los puntos de extensión de 05-02 y 05-03, no rutas alcanzables hoy.
- 05-06 añade `tests/incident-actions.test.ts` (idempotencia, D-02, D-05 y las seis razones del token) y el bloque de la migración 0007.
- Los IDs BOT-02, BOT-04, BOT-06 y BOT-10 los declaran también los planes hermanos; `requirements.ready-ids` los mantiene bloqueados hasta que el último plan de la fase publique su SUMMARY.

---
*Phase: 05-bot-de-lectura-y-reconocimiento*
*Completed: 2026-11-26*

## Self-Check: PASSED

- Archivos creados y modificados existen en disco.
- Commits `e6e7147`, `6620e45`, `24dddd8` y `b117d7a` son ancestros de HEAD.
- `pnpm typecheck` sin errores y suite completa en verde (564 pruebas).
