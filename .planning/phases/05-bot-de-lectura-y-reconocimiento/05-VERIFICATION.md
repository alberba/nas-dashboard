---
phase: 05-bot-de-lectura-y-reconocimiento
verified: 2026-11-26T15:54:04Z
status: passed
score: 46/47 must-haves verified
covered_files: [
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-01-PLAN.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-01-SUMMARY.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-02-PLAN.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-02-SUMMARY.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-03-PLAN.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-03-SUMMARY.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-04-PLAN.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-04-SUMMARY.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-05-PLAN.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-05-SUMMARY.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-06-PLAN.md",
    ".planning/phases/05-bot-de-lectura-y-reconocimiento/05-06-SUMMARY.md",
    "drizzle/0007_bot_reconocimiento.sql",
    "drizzle/meta/0007_snapshot.json",
    "drizzle/meta/_journal.json",
    "src/app/api/[...path]/route.ts",
    "src/components/dashboard.tsx",
    "src/components/views/alerts.tsx",
    "src/lib/digest-content.ts",
    "src/lib/incident-actions.ts",
    "src/lib/incident-snooze.ts",
    "src/lib/incident-store.ts",
    "src/lib/incident-why.ts",
    "src/lib/madrid-day.ts",
    "src/lib/notification-dispatch.ts",
    "src/lib/schema.ts",
    "src/lib/telegram-cleanup.ts",
    "src/lib/telegram-keyboard.ts",
    "src/lib/telegram-updates.ts",
    "src/lib/telegram.ts",
    "src/lib/types.ts",
    "src/lib/worker-loop.ts",
    "src/worker.ts",
    "tests/api-incidents.test.ts",
    "tests/digest-ack-labels.test.ts",
    "tests/e2e/incidents.spec.ts",
    "tests/incident-actions.test.ts",
    "tests/incident-snooze.test.ts",
    "tests/incident-why.test.ts",
    "tests/madrid-day.test.ts",
    "tests/migrations.test.ts",
    "tests/snooze-delivery.test.ts",
    "tests/telegram-contract.test.ts",
    "tests/telegram-fake.ts",
    "tests/telegram-lane-hardening.test.ts",
    "tests/telegram-redaction.test.ts",
    "tests/telegram-replays.test.ts",
    "tests/telegram-updates.test.ts",
    "tests/telegram.test.ts"
  ]
covered_digest: "v4:sha256:6e841fe32b83f9030e9fd3fdb77046e538c4209caed3a2d618fb2c2b2e720dea"
behavior_unverified: 1
overrides_applied: 0
decision_coverage:
  honored: 14
  total: 14
  not_honored: []
behavior_unverified_items:
  - truth: "El carril de updates es un hito del bucle del lock: el poll acotado sustituye al reposo de 1 s, un fallo no renueva la marca de salud y SIGTERM aborta la espera."
    test: "Arrancar el worker con Telegram configurado, dejar un getUpdates de 3 s en vuelo y enviar SIGTERM."
    expected: "El proceso termina sin esperar al final del long poll y sin registrar un error no controlado."
    why_human: "Los tests ejercitan el hito y que un fallo no renueva la marca, y el cliente se prueba con una señal ya abortada; ninguno hace que el apagado del worker interrumpa una petición en curso."
human_verification:
  - test: "Con el bot real y el worker arrancado, provocar o simular un aviso crítico inmediato, pulsar Reconocer en Telegram, comprobar que el mensaje se edita sin sonido y sin el botón, reiniciar el worker y abrir Avisos con la API. En el repositorio media-stack, buscar cualquier llamada a getUpdates o setWebhook que use el mismo token del bot."
    expected: "El reconocimiento sigue guardado tras el reinicio con canal telegram. media-stack no consume updates ni configura webhook con ese token; si lo hiciera, el carril no se activa en producción hasta resolverlo."
    why_human: "Requiere el bot real, el cliente de Telegram y el otro repositorio; el fake no prueba la sonoridad de una edición ni la coexistencia de consumidores."
  - test: "Con el bot real y el hub de pruebas, provocar un aviso crítico inmediato y pulsar los cuatro botones: Reconocer, Silenciar 1 h, Por qué me llegó esto y Quitar silencio. Comprobar que cada edición es silenciosa, que la respuesta de Por qué cita el aviso sin sonido, que Avisos muestra el estado de cada paso, que el resumen del día siguiente etiqueta el episodio y que docker compose logs worker no contiene el token. Ejecutar además la suite completa con Node 26 y pnpm build."
    expected: "Los cuatro botones funcionan una sola vez cada uno y se reflejan en el aviso, en Avisos y en el resumen; la respuesta de Por qué llega citando el aviso y sin sonido; ningún log contiene el token; la suite completa y el build pasan con Node 26. Si media-stack consumiera updates con el mismo token, el carril no se activa en producción hasta resolverlo."
    why_human: "Requiere el bot real, el cliente de Telegram y su sonoridad, el contenedor del worker, el repositorio hermano media-stack y la versión de Node del CI; el fake y el runner local no los prueban."
  - test: "Con el bot real, pulsar Silenciar 1 h y Silenciar 24 h, comprobar que el mismo mensaje se edita sin sonido y muestra «Silenciada hasta HH:MM» con la hora de Madrid, y que el teclado ofrece Quitar silencio. Provocar una reapertura del mismo host y clave dentro del plazo, pulsar Quitar silencio y dejar vencer el plazo."
    expected: "Durante el plazo no llega ningún aviso por la reapertura y la incidencia sigue visible en Avisos y en el resumen; Quitar silencio restaura los dos botones; al vencer no llega ningún mensaje retenido."
    why_human: "La supresión, el vencimiento y el estado del teclado están cubiertos con la base y el despacho reales, pero la recepción y la ausencia de sonido en el cliente dependen de Telegram."
  - test: "Con el bot real, provocar un aviso de temperatura por encima del umbral y pulsar «Por qué me llegó esto»; reconocer y volver a pulsar Por qué en el teclado nuevo; escalar a crítica y pulsar de nuevo; resolver y comprobar el teclado y el texto."
    expected: "El primer mensaje cita el aviso, llega sin sonido y muestra regla, umbral, valor leído y canal; una pulsación nueva del mismo estado avisa de que ya está respondido sin otro mensaje; la escalada permite otra respuesta con la severidad actual; tras resolver solo quedan Por qué y Abrir en el hub y no se muestra el dato leído."
    why_human: "La respuesta citada, el deduplicado por estado y el contenido se prueban con el cliente simulado, pero la cita real, el silencio y el render del cliente son externos."
  - test: "Abrir Avisos con una incidencia abierta y operar los controles reconocer, silenciar 1 h, silenciar 24 h y quitar el silencio en escritorio y en móvil; con un aviso enviado, reconocer desde el hub y mirar el mensaje de Telegram."
    expected: "El estado y los controles se leen y se pulsan sin solaparse; el mensaje de Telegram se edita en silencio, sin el botón Reconocer y con la hora de Madrid."
    why_human: "Playwright afirma el estado estructural por data-*, pero la legibilidad, el tamaño táctil y la edición real del mensaje exigen un navegador y un móvil reales."
  - test: "Arrancar el worker con el bot configurado, dejar un getUpdates de 3 s en vuelo y enviar SIGTERM."
    expected: "El proceso sale sin esperar al final del long poll y sin error no controlado."
    why_human: "Ningún test hace que el SIGTERM del worker aborte una petición en curso; el hito y la marca de salud sí están cubiertos."
---

# Phase 5: Bot de lectura y reconocimiento — Verification Report

**Phase Goal:** Añadir al bot los botones de lectura y reconocimiento —abrir, silenciar y reconocer— con allowlist, tokens de un solo uso y sin filtrar el token.
**Verified:** 2026-11-26T15:54:04Z
**Status:** human_needed
**Re-verification:** No — verificación inicial.

## Nota sobre el modo MVP

ROADMAP marca la fase como `**Mode:** mvp`, pero el objetivo no sigue el formato de historia de usuario (`user-story.validate` → `valid: false`). Las fases 01 a 04 tienen la misma discrepancia y se verificaron con el método goal-backward estándar contra los criterios de éxito del roadmap; este informe hace lo mismo. Es ℹ️ Info y no afecta al estado. Para el formato MVP estricto habría que reformular el objetivo con `/gsd-mvp-phase 5`.

## Goal Achievement

Los cinco criterios de éxito del roadmap son el contrato. Las verdades de los seis planes los detallan y añaden los invariantes de D-01 a D-14.

### Observable Truths — Roadmap Success Criteria

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | Un update de un usuario o chat fuera de la allowlist se ignora sin efecto observable | ✓ VERIFIED | `telegram-updates.ts:139-155` exige `from.id` = `chat.id` = chat configurado, chat privado, `from.is_bot` falso, mensaje del bot (o inaccesible `date: 0` con token válido) y token `^v1:[A-Za-z0-9_-]{22}$`; el bucle solo avanza el offset (`:426-430`). Tests ejecutados: «ignores every unauthorised update, only advancing the offset» (8 variantes, cero peticiones salientes, `lastUpdateId` = 208), «denies on each allowlist condition on its own» (6 condiciones), «returns a result for every degenerate input» |
| SC2 | El operador abre la incidencia, la silencia 1 h o 24 h y la reconoce desde los botones, y el estado persiste tras un reinicio | ✓ VERIFIED | `incident-actions.ts:52-206` (`ack`, `snooze`, `unsnooze`), `incident-snooze.ts:82-165`, teclado `telegram-keyboard.ts:67-75` y filas `:120-146`. Persistencia en columnas y tablas de `drizzle/0007_bot_reconocimiento.sql`. Tests: «acknowledges a real notice once…», «stores a one-hour/twenty-four hour silence…», «repeats no effect when the same update or button arrives again», «lane restarted» (recuento de efectos ≤ 1), «keeps one acknowledgement when it is repeated by either channel». La recepción real y el reinicio con bot real quedan en Human Verification #1 y #3 |
| SC3 | «Por qué me llegó esto» responde desde el propio mensaje | ✓ VERIFIED | `incident-why.ts:62-107` encola una respuesta por estado; `notification-dispatch.ts:737-808` la envía; `telegram.ts:424-449` usa `reply_parameters` y `disable_notification`. Tests ejecutados: «sends the reply quoting the notice, without sound and with the rule and the reading», «opens a new reply after a severity escalation and after a close», «leaves one row when two presses of the same state run concurrently» |
| SC4 | Un callback repetido o caducado no ejecuta dos veces la acción ni rompe el bot | ✓ VERIFIED | Consumo atómico `incident-actions.ts:233-292` (seis razones finitas, sin lanzar, `usedAt` solo en el consumo correcto) y una sola transacción efecto+offset `telegram-updates.ts:433-457`. Tests ejecutados: 5 acciones × 6 escenarios de replay (30 casos: token repetido, offset sin confirmar, caducado, otro mensaje, incidencia borrada, carril reiniciado), «returns every token failure without burning the token», «drops a poisoned update after three attempts…» |
| SC5 | El token del bot no aparece en logs ni en respuestas | ✓ VERIFIED | Única formación de URL en `botRequest` (`telegram.ts:212-227`); `redactToken` (`:87-90`) en toda línea del carril (`telegram-updates.ts:267`) y resultados finitos sin cuerpo del proveedor. Tests ejecutados: 6 métodos × 13 modos de fallo, logs con canario, filas de outbox y resumen, y prueba estructural que recorre `src/` y exige una sola URL con `/bot` |

### Observable Truths — Plan Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| P1-1 | BOT-02: cualquier update ajeno, de otro chat, de grupo, de texto o comando se ignora sin efecto observable ni log de su contenido | ✓ VERIFIED | Como SC1. `telegram-updates.ts:426-430`; test negativo de 8 casos y `telegram-redaction.test.ts` (ninguna línea con el canario) |
| P1-2 | BOT-02 (idempotencia): dos veces el mismo `update_id` o el mismo botón no repiten el efecto | ✓ VERIFIED | `telegram-updates.ts:433-457` (token usado → `ignored`) y `incident-actions.ts:233-292`. Tests «repeats no effect…» y el escenario «repeated token»/«update repeated because the offset was not confirmed» de las 5 acciones |
| P1-3 | BOT-02 (concurrencia): solo el dueño del lock consume y token, efecto, edición y offset se confirman en una sola transacción | ✓ VERIFIED | `telegram-updates.ts:347-348,415-416` (lock antes y después del poll) y `:433-457` (una `db.transaction` con consumo, efecto y UPSERT del offset). Evidencia conductual: el test del veneno deja el offset quieto en los dos primeros fallos (`telegram-lane-hardening.test.ts:206`) y el replay tras offset sin confirmar no repite el efecto; `incident-actions.test.ts:490-495` demuestra que una reversión restaura el token |
| P1-4 | BOT-04: Reconocer guarda quién, cuándo y canal, persiste, edita el aviso y el botón desaparece | ✓ VERIFIED | `incident-actions.ts:52-86`; `notification-dispatch.ts:985-1004` (hora de Madrid); `telegram-keyboard.ts:67-75` deja `why` y el silencio, sin `ack`. Tests «acknowledges a real notice once and edits the same message», «keeps one acknowledgement when it is repeated by either channel», «leaves the acknowledgement clock out of an unacknowledged notice» |
| P1-5 | BOT-06: token opaco de 128 bits/25 bytes, hash en la base y consumo único validado contra chat y mensaje | ✓ VERIFIED | `telegram-keyboard.ts:30-48,85-111` (`v1:` + 16 bytes base64url, SHA-256); `incident-actions.ts:260-290` liga el token a la fila `incident:<id>:open` `sent` por Telegram con el mismo `chatId`/`messageId` |
| P1-6 | BOT-10: la URL con el token se forma solo en `botRequest` y todo log del carril pasa por `redactToken` | ✓ VERIFIED | `telegram.ts:212-227`, `telegram-updates.ts:267`. Cubierto por la suite de redacción y la prueba estructural de una sola URL |
| P1-7 | El carril es un hito del bucle del lock: poll acotado, un fallo no renueva la marca y SIGTERM aborta la espera | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Hito y cota: `worker-loop.ts:100-108`, `worker.ts:174-176,187`; tests «does not renew the health mark when the poll fails», «bounds the poll wait to the next collection». El aborto por SIGTERM de una espera en curso está en el código (`worker.ts:51-56`, señal pasada a `botRequest`) pero ningún test lo ejercita — ver Human Verification #6 |
| P2-1 | BOT-04: Silenciar 1 h o 24 h guarda el silencio por host y clave, registra el evento y edita el mensaje | ✓ VERIFIED | `incident-actions.ts:159-183`, `incident-snooze.ts:82-138`. Tests «stores a one-hour silence…», «stores a twenty-four hour silence…» (ejecutados con `TZ=Pacific/Honolulu`) |
| P2-2 | D-01: durante el plazo no interrumpen reapertura, escalada pendiente, lo ya encolado ni el push; los eventos siguen registrándose y las ediciones salen | ✓ VERIFIED | `incident-store.ts:298-366` (supresión al abrir y al escalar), `notification-dispatch.ts:617-623` (apertura) y `:1220-1234` (push). Tests «suppresses the reopening…», «withholds the escalation…», «suppresses a queued opening…», «suppresses the push fallback…», «still edits a sent notice while silent…» |
| P2-3 | D-03: al vencer no se envía nada; solo un evento posterior vuelve a interrumpir | ✓ VERIFIED | Fila suprimida terminal (`incident-store.ts:348-365`); `dispatchTelegramOpening` solo actúa sobre `pending`. Test «suppresses a queued opening and never resends it after the deadline» |
| P2-4 | D-13: el teclado ofrece Quitar silencio mientras dura y Reconocer no se deshace desde el chat | ✓ VERIFIED | `telegram-keyboard.ts:67-75` (`snoozed` → `unsnooze`; sin acción de deshacer). Test «offers silence controls only while they make sense» y la edición del test «still edits a sent notice while silent…» (acción `unsnooze`, ninguna `snooze_1h`) |
| P2-5 | BOT-04 (idempotencia): repetir o acortar no crea evento ni acorta el plazo; una más larga lo extiende | ✓ VERIFIED | `incident-snooze.ts:104-137` compara la duración pedida con la viva. Test «keeps a repeated silence and extends a longer one» |
| P2-6 | BOT-06: un token de silencio repetido, caducado o de otro mensaje no cambia el estado y recibe el aviso genérico | ✓ VERIFIED | `consumeActionToken` (`incident-actions.ts:246-272`). Test «ignores a repeated, expired or foreign silence token» |
| P2-7 | Un silencio fijado entre el reclamo y la marca de intento impide la petición | ✓ VERIFIED | La lectura del silencio precede a `beginOutboxAttempt` en apertura (`:617-640`) y push (`:1220-1237`). Tests «holds back a request when the silence arrives between the claim and the attempt mark» y «also holds back a push claimed before the silence arrives» |
| P2-8 | Reconocer y silenciar son independientes | ✓ VERIFIED | Ramas separadas en `incident-actions.ts`; ninguna escribe el campo de la otra. Test «keeps acknowledging and silencing independent» |
| P3-1 | BOT-05: Por qué envía una respuesta citada, sin sonido, con regla y umbral, dato leído y canal | ✓ VERIFIED | `incident-why.ts:117-191` y `telegram.ts:424-449`. Tests «sends the reply quoting the notice…», «explains each key with its own reading and none without a measurement» (74 frente a umbral 70) |
| P3-2 | D-08: la explicación refleja el estado actual; resuelta no muestra dato leído | ✓ VERIFIED | Texto generado al enviar (`notification-dispatch.ts:763-789`), `whyFacts` oculta la lectura si `resolvedAt`. Tests «reflects an escalation in the severity of the text…», «explains a resolved notice without a reading» |
| P3-3 | D-09: una respuesta por estado; reconocer, silenciar y quitar silencio no abren estado nuevo | ✓ VERIFIED | `incident-why.ts:22,36-52` (solo `opened`, `severity`, `closed`). Test «keeps the notice state across acknowledging, silencing and removing the silence» y «answers a fresh token of the same state…» |
| P3-4 | BOT-06: token de Por qué repetido, caducado o ajeno no envía nada y dos pulsaciones concurrentes dejan una sola fila | ✓ VERIFIED | Clave única `incident:<id>:why:<seq>` con `onConflictDoNothing` (`incident-why.ts:92-106`). Tests «ignores a repeated, expired or foreign why token», «leaves one row when two presses of the same state run concurrently» |
| P3-5 | D-10: tras resolverse, el teclado conserva Por qué y Abrir en el hub y retira Reconocer y Silenciar | ✓ VERIFIED | `telegram-keyboard.ts:68` (`resolved` → `["why"]`). Tests «offers why in every keyboard state and only why once resolved», «renders a single why row on the resolved notice edit» |
| P3-6 | La respuesta pasa por el outbox: respeta la pausa del 429, no se reenvía tras confirmación incierta y se trunca a 4096 | ✓ VERIFIED | `dispatchWhy` reutiliza `recordTelegramRetry`/`recordTelegramUncertain` (`notification-dispatch.ts:806-830`), `telegramText` trunca. Tests «honours the shared pause after a 429 and sends the reply once», «never resends an uncertain confirmation», «leaves a confirmed rejection failed and never falls back to push» |
| P3-7 | La respuesta no se silencia con un silencio activo y sale con `disable_notification` | ✓ VERIFIED | `dispatchWhy` no consulta el silencio para decidir el envío; `sendTelegramReply` fija `disable_notification: true`. Test «sends the reply while a silence is active» |
| P4-1 | BOT-04/D-14: Avisos muestra el estado (Reconocida con quién, cuándo y canal; Silenciada hasta HH:MM) y ofrece las acciones; hub y Telegram comparten estado | ✓ VERIFIED | `alerts.tsx:280-369` (`data-ack-*`, `data-snooze-*`, `data-action`), `dashboard.tsx:369-412`, proyección `incident-store.ts:1004-1016`. Tests de API «applies acknowledge, snooze and unsnooze from the hub once per state», «publishes the hub state…»; e2e `INC-E2E-05` no reejecutado por este verificador (arranca servidor) y Human Verification #5 |
| P4-2 | D-14: una acción del hub sobre una incidencia con aviso enviado edita en silencio el mensaje de Telegram | ✓ VERIFIED | La acción comparte `applyIncidentAction` → `queueEdit` (`incident-actions.ts:84,150`), y `dispatchEdit` usa el `messageId` original. Test «applies acknowledge, snooze and unsnooze…» (una sola edición por `seq`) y «queues no edit when the episode never had a Telegram notice» |
| P4-3 | POST /api/incidents/:id/(acknowledge\|snooze\|unsnooze): sesión y Origen, cuerpo estricto con host, 404 por host/incidencia, 409 resuelta, 200 idempotente | ✓ VERIFIED | `route.ts:282-361` (regex de id, `z.strictObject`, pareja id/host, `db.transaction`). Tests «refuses a resolved episode and any body outside the contract», «never acts on another host's episode», «requires a session and an allowed origin…» |
| P4-4 | D-04: el resumen etiqueta lo reconocido o silenciado y no mueve contadores | ✓ VERIFIED | `digest-content.ts:148-155` (etiquetas con `madridClock`) y `:299-334`. Tests «labels an acknowledged digest episode without moving the counters», «writes the Madrid deadline of a live silence as a computed value», «keeps the footer and the link with forty labelled lines» |
| P4-5 | D-01: una apertura o escalada suprimida por silencio sigue en Avisos y en abiertas ahora del resumen | ✓ VERIFIED | `incident-store.ts:899-939` (`snoozed` en `finiteReasons`) y `digest-content.ts:330-334` (cohorte `snoozed`). Tests «publishes the hub state and a silence-held opening…», «lists an opening withheld by a silence in the open cohort», «counts a digest episode escalated to critical while silenced» |
| P4-6 | D-05: la proyección pública lleva instante, canal y nombre de sesión, nunca un identificador de Telegram | ✓ VERIFIED | `projectRow` (`incident-store.ts:1004-1010`) y `publicVia`; el `acknowledgedBy` de Telegram es nulo por construcción. Test «publishes the hub state… without Telegram identifiers» |
| P4-7 | Las acciones del hub no exigen verificación reciente | ✓ VERIFIED | La rama no llama a `guardSensitiveAction` (`route.ts:279-281`) y el test de la ruta opera solo con sesión y Origen. Aceptado como T-05-15 |
| P5-1 | BOT-06: cada acción soporta token repetido, offset sin confirmar, caducado, mensaje ajeno, incidencia borrada y reinicio con como mucho un efecto y sin excepción | ✓ VERIFIED | 30 casos `it.each` ejecutados en `telegram-replays.test.ts` (efectos 0 o 1, `ok: true`, una respuesta por update) |
| P5-2 | Un update que falla por infraestructura se reintenta 3 veces y al tercero se salta con log finito | ✓ VERIFIED | `telegram-updates.ts:461-475`, `POISON_MAX_ATTEMPTS` (`:56`). Test «drops a poisoned update after three attempts…» (offset quieto, salto al tercero, canario ausente) |
| P5-3 | Tras 6 días el carril omite el offset y acepta un id menor | ✓ VERIFIED | `telegram-updates.ts:388-393` y UPSERT sin guarda monotónica (`:444-455`). Tests «omits a stale offset…», «keeps the offset while the stored id is fresh» |
| P5-4 | Un 409 provoca un nuevo `deleteWebhook` antes del siguiente poll, con retroceso, sin bucle caliente | ✓ VERIFIED | `telegram-updates.ts:407-412` y `:369-381`; backoff `:291-302`. Test «removes the webhook again before polling after a conflict» (orden exacto de llamadas) |
| P5-5 | BOT-02: el contrato del Update se prueba con fixtures reales y cada condición de la allowlist deniega por sí sola | ✓ VERIFIED | `tests/telegram-contract.test.ts` (20 fixtures, 24 degeneradas, matriz de unicidad, tipos ajenos por el carril) |
| P5-6 | BOT-10: el token no aparece en resultados, logs, outbox ni resumen para cada método y fallo | ✓ VERIFIED | `tests/telegram-redaction.test.ts` (6 métodos × 13 modos, `console.*`, `log` del carril, filas, estructura del árbol) |
| P5-7 | La limpieza horaria borra tokens vencidos hace más de un día y silencios vencidos hace más de 7 sin tocar lo vigente ni el polling | ✓ VERIFIED | `telegram-cleanup.ts:40-61`; llamada en `worker.ts:171-172`. Test «prunes expired tokens and silences without touching live state» y «keeps the retention windows…» |
| P5-8 | La suite de redacción corre en CI con Node 26 | ✓ VERIFIED | `.github/workflows/ci.yml:31-43` (`node-version: 26`, `pnpm test`) |
| P6-1 | BOT-04 (idempotencia): reconocer dos veces, por el mismo canal o por el otro, devuelve `unchanged`; resuelta `resolved`; inexistente `not_found` | ✓ VERIFIED | `incident-actions.ts:59-63`. Tests «keeps one acknowledgement when it is repeated by either channel», «reports a resolved or unknown episode without writing anything» |
| P6-2 | D-02: reconocer no se consulta en la política de entrega; una escalada a crítica sigue interrumpiendo | ✓ VERIFIED | La rama `ack` no lee outbox ni política (`incident-actions.ts:52-86`). Test «lets a later critical escalation interrupt an episode acknowledged from the hub» (fila `incident:<id>:open` `pending` por Telegram) |
| P6-3 | D-05: `acknowledgedAt` es un instante con zona y medible frente al `result.at` de la apertura | ✓ VERIFIED | `schema.ts:176` (`timestamp with time zone`) y `drizzle/0007...sql`. Test «measures the time to acknowledge against the sent opening» (89 s inyectados) |
| P6-4 | BOT-06: `consumeActionToken` devuelve las seis razones sin lanzar y sin quemar el token | ✓ VERIFIED | `incident-actions.ts:208-292`. Test «returns every token failure without burning the token» (incluye `incident_missing` en transacción revertida) |
| P6-5 | La migración 0007 conserva filas, es repetible y su snapshot encadena con 0006 | ✓ VERIFIED | `drizzle/0007_bot_reconocimiento.sql` (solo `CREATE TABLE`, `ADD COLUMN` e índices), snapshot `prevId` = id de 0006, journal con `when` posterior. Tests «adds acknowledgement, tokens, silences and the poll offset without rewriting history», «applies 0007 to a new database and on top of 0006 with pnpm db:migrate» |

**Score:** 46/47 truths verified (1 present, behavior-unverified)

### Deferred Items

None. No hay huecos que una fase posterior cubra.

### Required Artifacts

`verify.artifacts` → 25/25 con existencia y sustancia (exit 0 en los seis planes).

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `drizzle/0007_bot_reconocimiento.sql` | Tablas aditivas de tokens, silencios y polling; columnas de reconocimiento | ✓ VERIFIED | 33 líneas; solo `CREATE TABLE`, `ADD COLUMN`, FK e índices |
| `drizzle/meta/0007_snapshot.json`, `drizzle/meta/_journal.json` | Snapshot encadenado y entrada de journal | ✓ VERIFIED | `prevId` = id de 0006; `when` 1795699659076 > 0006 |
| `src/lib/telegram-updates.ts` | Esquema del Update, allowlist pura y carril con offset transaccional | ✓ VERIFIED | 492 líneas; sustancial y cableado desde `worker.ts` |
| `src/lib/telegram-keyboard.ts` | Tokens opacos, matriz de acciones y filas del teclado | ✓ VERIFIED | 146 líneas; usado por despacho y carril |
| `src/lib/incident-actions.ts` | Ack/snooze/unsnooze compartidos y consumo atómico | ✓ VERIFIED | 292 líneas; usado por Telegram, hub y pruebas |
| `src/lib/incident-snooze.ts` | Consulta, alta y baja del silencio | ✓ VERIFIED | 165 líneas; usado por store, despacho y acciones |
| `src/lib/incident-why.ts` | Estado del aviso, encolado y hechos de la explicación | ✓ VERIFIED | 226 líneas; usado por carril y despacho |
| `src/lib/telegram-cleanup.ts` | Limpieza de tokens y silencios vencidos | ✓ VERIFIED | 61 líneas; importado y llamado en `worker.ts` |
| `src/lib/telegram.ts` | `botRequest` único, `redactToken`, `getUpdates`, webhook, callback y respuesta | ✓ VERIFIED | 561 líneas; 5 métodos nuevos sobre el `post()` existente |
| `src/app/api/[...path]/route.ts` | Ruta POST de las tres acciones | ✓ VERIFIED | Rama `:282-361` con guardas comunes |
| `src/components/views/alerts.tsx` | Estado y controles con atributos `data-*` | ✓ VERIFIED | `HubState`/`HubControls` (`:280-369`) montados en `AlertsView` |
| `src/lib/digest-content.ts` | Etiquetas y cohorte retenida | ✓ VERIFIED | `detailLine` y CTE con `incident_snoozes` |
| `src/lib/types.ts` | `acknowledged`, `snooze` y motivo `snoozed` | ✓ VERIFIED | Contratos públicos de `Alert` |
| `tests/telegram-fake.ts` | Bot API simulada con confirmación por offset | ✓ VERIFIED | Usada por las cinco suites del carril |
| `tests/incident-actions.test.ts`, `tests/incident-snooze.test.ts`, `tests/incident-why.test.ts`, `tests/snooze-delivery.test.ts`, `tests/telegram-updates.test.ts`, `tests/telegram-replays.test.ts`, `tests/telegram-contract.test.ts`, `tests/telegram-lane-hardening.test.ts`, `tests/telegram-redaction.test.ts`, `tests/digest-ack-labels.test.ts`, `tests/migrations.test.ts`, `tests/api-incidents.test.ts` | Evidencia de comportamiento | ✓ VERIFIED | Ejecutados por este verificador (191 pruebas, 0 omitidas) |

### Key Link Verification

`verify.key-links` devolvió `0/17` con «Target not referenced in source»: falso negativo de la herramienta, que busca la ruta literal (`src/lib/x.ts`) mientras el código importa `./x` o `@/lib/x`. Comprobación manual sobre el árbol final:

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/worker.ts` | `telegram-updates.ts` | Carril como `updates` de `workerTurn` | ✓ WIRED | Import `:16`, `createUpdatesLane` `:114-121`, pasado `:174-176`, reposo `:187` |
| `src/lib/notification-dispatch.ts` | `telegram-keyboard.ts` | Tokens antes de la marca de intento y `actionRows` en send/edit | ✓ WIRED | Import `:23-24`; `:627-638` y `:1065-1076`; `actionRows` en `:658,1100` |
| `src/lib/telegram-updates.ts` | `incident-actions.ts` | Consumo y efecto en una transacción con el offset | ✓ WIRED | Import `:28-32`; `:433-457` |
| `src/lib/incident-actions.ts` | `incident-store.ts` | `queueEdit` encola la edición | ✓ WIRED | Import `:14`; llamadas `:84,150` |
| `src/lib/telegram-updates.ts` | `incident-actions.ts` (silencio) | Ramas `snooze_1h/24h/unsnooze` | ✓ WIRED | `:185-195` |
| `src/lib/incident-store.ts` | `incident-snooze.ts` | `activeSnooze` al abrir y al escalar | ✓ WIRED | Import `:4`; `:779,844`; supresión `:306,355,871` |
| `src/lib/notification-dispatch.ts` | `incident-snooze.ts` | Silencio antes de `beginOutboxAttempt`, apertura y push | ✓ WIRED | Import `:27`; `:617-623`, `:1059-1064`, `:1220-1234` |
| `src/lib/telegram-updates.ts` | `incident-why.ts` | Rama `why` encola dentro de la transacción | ✓ WIRED | Import `:33`; llamada `:199` |
| `src/lib/notification-dispatch.ts` | `incident-why.ts` | `dispatchWhy` compone el texto al enviar | ✓ WIRED | Import `:29`; `:781-789` |
| `src/lib/notification-dispatch.ts` | `telegram.ts` | Respuesta citada | ✓ WIRED | `sendTelegramReply` `:791-804` |
| `src/app/api/[...path]/route.ts` | `incident-actions.ts` | Acción del hub en una transacción | ✓ WIRED | Import `:53`; `:345-347` |
| `src/components/dashboard.tsx` | `route.ts` | POST desde `onAction` | ✓ WIRED | `:379-387`, pasado a `AlertsView` `:797` |
| `src/lib/digest-content.ts` | `schema.ts` | JOIN al silencio vivo y `acknowledgedAt` | ✓ WIRED | `:299-319` y etiquetas `:148-155` |
| `src/worker.ts` | `telegram-cleanup.ts` | Limpieza horaria | ✓ WIRED | Import `:17`; llamada `:172` |
| `src/lib/telegram-updates.ts` | `telegram.ts` | `redactToken` y `deleteWebhook` tras 409 | ✓ WIRED | Import `:35-41`; `:267`, `:369-381`, `:407-412` |
| `tests/incident-actions.test.ts` | `incident-actions.ts` | `applyIncidentAction` y `consumeActionToken` contra base desechable | ✓ WIRED | Import dinámico en `beforeAll`; 5 pruebas ejecutadas |
| `tests/migrations.test.ts` | `drizzle/0007_bot_reconocimiento.sql` | `migrateAll`/`pnpm db:migrate` sobre 0006 | ✓ WIRED | Bloques `bot migration 0007` (`:727`) y `bot migration runner` (`:903`) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `alerts.tsx` `HubState` | `alert.acknowledged` / `alert.snooze` | `projectRow` sobre columnas de `incidents` y `SELECT` de `incident_snoozes` (`incident-store.ts:1086-1099`) | Sí | ✓ FLOWING |
| Aviso de Telegram | teclado de acciones | `issueActionTokens` inserta hashes y devuelve tokens; `renderActionRows` los serializa | Sí | ✓ FLOWING |
| Respuesta de Por qué | `text` | `whyFacts` con incidencia, apertura, política, silencio y última muestra (`notification-dispatch.ts:763-789`) | Sí | ✓ FLOWING |
| Etiquetas del resumen | `acknowledged`, `snoozeUntil` | CTE `readSnapshot` con joins laterales a `notification_outbox` e `incident_snoozes` | Sí | ✓ FLOWING |
| Limpieza horaria | recuentos | `DELETE ... RETURNING` de las dos tablas | Sí | ✓ FLOWING |

### Behavioral Spot-Checks

Ejecutados por este verificador sobre el árbol final (`main` @ `0ba4569`), PostgreSQL 18 desechable en `127.0.0.1:55432`:

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Allowlist, idempotencia, atomicidad, contrato y endurecimiento del carril | `DATABASE_URL=… HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-actions.test.ts tests/telegram-updates.test.ts tests/telegram-replays.test.ts tests/telegram-contract.test.ts tests/telegram-lane-hardening.test.ts` | 5 archivos, 57 pruebas, 0 omitidas | ✓ PASS |
| Silencio, supresión, respuesta de Por qué y etiquetas del resumen | `TZ=Pacific/Honolulu DATABASE_URL=… HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-snooze.test.ts tests/snooze-delivery.test.ts tests/incident-why.test.ts tests/digest-ack-labels.test.ts` | 4 archivos, 46 pruebas, 0 omitidas | ✓ PASS |
| Migración 0007, API del hub, redacción del token, cliente y reloj de Madrid | `DATABASE_URL=… HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/api-incidents.test.ts tests/telegram-redaction.test.ts tests/telegram.test.ts tests/madrid-day.test.ts` | 5 archivos, 88 pruebas, 0 omitidas | ✓ PASS |
| Snapshot encadenado y journal | `node -e` sobre `drizzle/meta/0006_snapshot.json` y `0007_snapshot.json` | `prevId match: true`; journal 8 entradas, 0007 con `when` mayor | ✓ PASS |
| Playwright de Avisos (`INC-E2E-05`) | `pnpm test:e2e tests/e2e/incidents.spec.ts` | No reejecutado: arranca build y servidor | ? SKIP |

**Total ejecutado:** 191 pruebas únicas (57 + 46 + 88), 0 omitidas y 0 en rojo.

### Probe Execution

Step 7c: no aplica. `find scripts -path '*/tests/probe-*.sh'` → 0; los planes no declaran probes.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| BOT-02 | 05-01, 05-05 | El bot ignora cualquier update fuera de la allowlist | ✓ SATISFIED | SC1; allowlist pura, test negativo de 8 casos, matriz de 6 condiciones y tipos ajenos por el carril real |
| BOT-04 | 05-01, 05-02, 05-04, 05-06 | Abrir/silenciar 1 h o 24 h/reconocer desde los botones, con estado persistente | ✓ SATISFIED | SC2; acciones compartidas, silencio por host y clave, Avisos y resumen; persistencia en tablas y test de reinicio del carril. Recepción real: Human #1, #3, #5 |
| BOT-05 | 05-03 | Consultar «por qué me llegó esto» desde el propio mensaje | ✓ SATISFIED | SC3; respuesta citada, sin sonido, una por estado |
| BOT-06 | 05-01, 05-02, 05-03, 05-05, 05-06 | Un callback repetido o caducado no ejecuta dos veces la acción ni rompe el bot | ✓ SATISFIED | SC4; consumo atómico, seis razones finitas, 30 casos de replay y veneno acotado |
| BOT-10 | 05-01, 05-05 | El token del bot nunca aparece en logs ni en respuestas | ✓ SATISFIED | SC5; URL única, `redactToken`, matriz método × fallo y prueba estructural |

**Cobertura:** 5/5 IDs. `REQUIREMENTS.md:133-137` asigna exactamente BOT-02, BOT-04, BOT-05, BOT-06 y BOT-10 a la fase 5. No hay IDs huérfanos ni requirements de la fase sin plan.

### Decision Coverage

All trackable CONTEXT.md decisions are honored by shipped artifacts. (`check.decision-coverage-verify` → `honored: 14`, `total: 14`, `not_honored: []`.)

### Prohibitions (verification: test)

Las 16 prohibiciones de los seis planes tienen cobertura activa; ninguna queda «accept-and-flag».

| Prohibición | Plan | Estado | Evidencia |
|-------------|------|--------|-----------|
| El bot no responde a un update no autorizado ni registra su contenido | 05-01 | ✓ enforced | Test de 8 updates ajenos (cero `answerCallbackQuery`, cero filas) + logs con canario |
| Texto y comandos del operador no ejecutan ninguna acción | 05-01 | ✓ enforced | El mismo test incluye `message` y `/start` |
| El silencio no oculta eventos y deja su fila suprimida con motivo finito | 05-02 | ✓ enforced | «suppresses the reopening…» (evento `opened` presente, `reason` `snoozed`) |
| Al vencer un silencio no se reenvía ni se acumula un aviso retenido | 05-02 | ✓ enforced | «suppresses a queued opening and never resends it after the deadline» |
| El silencio no puede ser indefinido (1 h o 24 h) | 05-02 | ✓ enforced | «refuses any silence duration outside the closed set» + `RangeError` |
| La explicación no se envía con el popup de `answerCallbackQuery` | 05-03 | ✓ enforced | Cada pulsación registra una llamada de cierre y el envío es un mensaje citado |
| Ninguna pulsación de Por qué cambia la incidencia | 05-03 | ✓ enforced | «queues one pending reply… without changing the incident» |
| El texto de la explicación no viaja en el callback | 05-03 | ✓ enforced | `callback_data` solo admite `^v1:…$`; el texto se compone al enviar |
| La acción del hub no se ejecuta sin sesión ni con Origen ajeno | 05-04 | ✓ enforced | «requires a session and an allowed origin for the hub actions» |
| Reconocer o silenciar no cambia contadores del resumen | 05-04 | ✓ enforced | «labels an acknowledged digest episode without moving the counters» |
| Cuerpo con campos desconocidos o duración fuera de 1/24 → 400 | 05-04 | ✓ enforced | «refuses a resolved episode and any body outside the contract» |
| Ningún log, resultado, fila ni respuesta contiene el token ni el contenido del update | 05-05 | ✓ enforced | Suite de redacción completa |
| El offset no avanza antes de agotar los 3 intentos | 05-05 | ✓ enforced | «drops a poisoned update after three attempts…» |
| Un caso de usuario nunca lanza ni se reintenta | 05-05 | ✓ enforced | «treats a user failure as a result, never as a poisoned update» |
| Reconocer no suprime una interrupción posterior por escalada a crítica | 05-06 | ✓ enforced | «lets a later critical escalation interrupt an episode acknowledged from the hub» |
| La migración 0007 no reescribe ni borra filas existentes | 05-06 | ✓ enforced | «adds acknowledgement, tokens, silences and the poll offset without rewriting history» |

### Test Quality Audit

| Test File | Linked Req | Active | Skipped | Circular | Assertion Level | Verdict |
|-----------|-----------|--------|---------|----------|-----------------|---------|
| `tests/telegram-contract.test.ts` | BOT-02 | 4 | 0 | No | Behavioral (matriz de unicidad + carril real) | ✓ |
| `tests/telegram-replays.test.ts` | BOT-06 | 32 casos | 0 | No | Behavioral (efectos y filas durables) | ✓ |
| `tests/telegram-redaction.test.ts` | BOT-10 | 11 | 0 | No | Value/Behavioral (6×13 + estructura) | ✓ |
| `tests/telegram-lane-hardening.test.ts` | BOT-06 | 7 | 0 | No | Behavioral (offset, limpieza, orden de llamadas) | ✓ |
| `tests/telegram-updates.test.ts` | BOT-02, BOT-04, BOT-06 | 9 | 0 | No | Behavioral | ✓ |
| `tests/incident-actions.test.ts` | BOT-04, BOT-06 | 5 | 0 | No | Behavioral (filas, `seq`, token) | ✓ |
| `tests/incident-snooze.test.ts` | BOT-04, BOT-06 | 12 | 0 | No | Behavioral | ✓ |
| `tests/incident-why.test.ts` | BOT-05, BOT-06 | 20 | 0 | No | Behavioral | ✓ |
| `tests/snooze-delivery.test.ts` | BOT-04 | 7 | 0 | No | Behavioral | ✓ |
| `tests/digest-ack-labels.test.ts` | BOT-04 | 7 | 0 | No | Value/Behavioral (hora calculada con `madridClock`, helper probado aparte) | ✓ |
| `tests/api-incidents.test.ts` (nuevas) | BOT-04 | 6 | 0 | No | Status/Value | ✓ |
| `tests/migrations.test.ts` (0007) | BOT-04, BOT-06 | 10 | 0 | No | Behavioral (SQL, snapshot, journal, runner) | ✓ |

`describe.skipIf(!baseUrl)` es el arnés de base desechable; con `HUB_REQUIRE_TEST_DB=1` corrió todo. **Disabled tests on requirements:** 0. **Circular patterns:** 0. **Insufficient assertions:** 0.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (ficheros de la fase) | — | `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/placeholder | — | Ninguno encontrado en los 37 ficheros del diff |
| `src/lib/notification-dispatch.ts` | 754 | Marca de intento antes de las lecturas que componen la respuesta de Por qué (WR-01) | ⚠️ Warning | Si una lectura falla tras la marca, `recoverOutbox` deja la fila `uncertain` y la respuesta pedida se pierde sin haber llegado al proveedor. No contradice ningún must-have (el camino normal envía y el incierto no se reenvía), pero conviene componer el texto antes de la marca |
| `src/lib/incident-actions.ts` | 20 | `} from "./incident-snooze";import {` (IN-03) | ℹ️ Info | Legibilidad; sin efecto de comportamiento |
| `src/lib/telegram-updates.ts` | 100 | Comentario de tipo pegado a la declaración (IN-03) | ℹ️ Info | Legibilidad |
| `src/components/dashboard.tsx` | 416 | Comentario `data` pegado a `sameHost` (IN-03) | ℹ️ Info | Legibilidad |
| `src/components/views/alerts.tsx` | 301 | Hora del reconocimiento en la zona del navegador mientras el vencimiento va en Madrid (IN-01) | ℹ️ Info | Dos relojes para el mismo hecho si el navegador no está en Madrid |
| `src/lib/incident-why.ts` / `incident-store.ts` / `notification-dispatch.ts` | 81 / 152 / 153 | Clave `incident:<id>:open` escrita en tres módulos (IN-02) | ℹ️ Info | Duplicación load-bearing; un cambio de formato no falla en tipos |

WR-01 e IN-01…IN-03 figuran como `open` en `05-REVIEW-DISPOSITION.md`. Ninguno es un marcador de deuda ni un must-have fallido, así que no bloquean el objetivo.

## Human Verification Required

Este verificador no puede reproducir seis comprobaciones porque dependen del bot real, de un cliente de Telegram, de un contenedor o de un apagado real.

### 1. Reconocer con el bot real, reinicio y segundo consumidor

**Test:** Con el bot real y el worker arrancado, provocar un aviso crítico, pulsar Reconocer, comprobar la edición silenciosa sin botón, reiniciar el worker y consultar Avisos. Buscar `getUpdates`/`setWebhook` con el mismo token en `media-stack`.
**Expected:** El reconocimiento sigue guardado con canal `telegram`; `media-stack` no consume updates ni configura webhook.
**Why human:** Requiere el bot, el móvil y el otro repositorio; el fake no prueba la sonoridad ni la coexistencia.

### 2. Los cuatro botones, Avisos, resumen y logs

**Test:** Pulsar Reconocer, Silenciar 1 h, Por qué y Quitar silencio con el bot real; revisar Avisos, el resumen del día siguiente y `docker compose logs worker`. Ejecutar la suite completa con Node 26 y `pnpm build`.
**Expected:** Cada botón actúa una sola vez y se refleja en el aviso, Avisos y el resumen; Por qué cita sin sonido; ningún log contiene el token; suite y build pasan con Node 26.
**Why human:** Depende del cliente, del contenedor y de la versión de Node del CI.

### 3. Silencio real, flapping y vencimiento

**Test:** Silenciar 1 h y 24 h, comprobar «Silenciada hasta HH:MM» y Quitar silencio; provocar una reapertura dentro del plazo y dejar vencer el plazo.
**Expected:** Sin avisos por la reapertura, la incidencia visible en Avisos y resumen, los botones restaurados al quitar y ningún mensaje retenido al vencer.
**Why human:** La supresión y el vencimiento están probados con la base y el despacho reales, pero la recepción y el silencio del cliente son externos.

### 4. Por qué: cita, una por estado y estado actual

**Test:** Pulsar Por qué en un aviso de temperatura; reconocer y volver a pulsar; escalar y pulsar; resolver y mirar el teclado y el texto.
**Expected:** Cita el aviso sin sonido con regla, umbral, valor y canal; el mismo estado avisa «ya respondido»; la escalada permite otra respuesta; resuelta conserva solo Por qué y Abrir y no muestra el dato.
**Why human:** La cita real y el render del cliente no los cubre el fake.

### 5. Avisos en escritorio y móvil

**Test:** Operar las tres acciones desde Avisos en escritorio y móvil; con un aviso enviado, reconocer desde el hub y mirar Telegram.
**Expected:** Estado y controles legibles y pulsables; el mensaje se edita en silencio, sin Reconocer y con la hora de Madrid.
**Why human:** Playwright afirma `data-*`; la legibilidad y el tamaño táctil exigen un humano.

### 6. SIGTERM durante el long poll (verdad con comportamiento no ejercitado)

**Test:** Arrancar el worker con Telegram, dejar un `getUpdates` de 3 s en vuelo y enviar SIGTERM.
**Expected:** El proceso sale sin esperar al final del poll y sin error no controlado.
**Why human:** Ningún test hace que el apagado del worker aborte una petición en curso; el hito y la marca de salud sí están cubiertos.

## Gaps Summary

No hay huecos bloqueantes. Los cinco criterios del roadmap, 41 de las 42 verdades de los planes, las 16 prohibiciones de nivel test, los 25 artefactos y los 17 enlaces clave están verificados contra el código y contra 191 pruebas que este verificador ejecutó en el árbol final. Los cinco requisitos están satisfechos y no hay IDs huérfanos; las 14 decisiones de CONTEXT.md están honradas.

La única verdad no verificada conductualmente es P1-7 en su cláusula de apagado: el hito del bucle y la marca de salud se prueban, pero ningún test hace que SIGTERM aborte un long poll en curso. Se registra como `behavior_unverified` y pasa a la lista humana.

El estado es `human_needed` porque la entrega real por Telegram (sonoridad, cita, teclado en el móvil), el reinicio con el bot real, el contenedor del worker, la legibilidad de Avisos y la coexistencia con `media-stack` dependen de servicios y dispositivos externos. Queda además WR-01 abierto como warning no bloqueante: una lectura fallida tras la marca de intento puede perder una respuesta de Por qué que nunca llegó al proveedor.

---

_Verified: 2026-11-26T15:54:04Z_
_Verifier: the agent (gsd-verifier)_
