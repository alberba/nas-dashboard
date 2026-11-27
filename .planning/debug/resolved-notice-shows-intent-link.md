---
status: diagnosed
trigger: "resolved-notice-shows-intent-link: al cerrarse una incidencia con una intención pendiente, el aviso recuperado no debería mostrar «Confirmar en el hub» y la intención debería dejar de estar viva"
created: 2026-11-27T20:30:00Z
updated: 2026-11-27T20:45:00Z
goal: find_root_cause_only
---

## Current Focus

hypothesis: CONFIRMED. El comportamiento observado es exactamente el que implementan D-05/D-06 de la fase 7; nadie cancela la intención al resolver y ni el render ni el hub miran `resolvedAt`.
test: leer la ruta de resolución, el render de ediciones, la matriz de teclados, el hub (inspect/execute) y los tests que fijan D-05.
expecting: encontrar un punto que cancele o filtre la intención al resolver; no existe.
next_action: ninguno (modo diagnóstico). Devolver ROOT CAUSE FOUND al orquestador.

bug_class: Bohrbug (determinista; se reproduce con resolve + intención pendiente)
candidate_causes:
  - "[code] ruta de resolución (`recordIncidentObservationIn`) no toca `telegram_action_intents`"
  - "[code] render (`composeActionRows` + `keyboardActions`) mantiene url + cancelar con incidencia resuelta (D-05)"
  - "[config/spec] el criterio del UAT test 4 contradice D-05 de 07-CONTEXT.md"
and_gate: "sí. El síntoma exige dos condiciones a la vez: la intención sigue `pending` tras resolver (sin cancelación en la transacción de cierre) Y el render no filtra por `resolvedAt`. Quitar solo el filtro de render esconde el enlace pero deja la intención ejecutable desde el hub."

## Symptoms

expected: Cuando una incidencia de Telegram (p. ej. backup-failed) se resuelve («Copia recuperada») mientras hay una telegram_action_intents en estado pending, la edición de recuperación no incluye el botón url «Confirmar en el hub» y la intención se cancela/cierra (no queda viva).
actual: Incidencia 153 resuelta 20:02:47Z con la intención 18a7eac0 pending (expiresAt 20:04:01Z). La edición de recuperación (outbox key `incident:153:edit:2`, 20:02:49Z) se renderizó con la intención viva y el usuario vio «Confirmar en el hub» en «Copia recuperada» hasta que la edición `:expire` de las 20:04:02Z lo quitó. La intención acabó `expired`, no `cancelled`.
errors: ninguno
reproduction: provocar backup-failed, pulsar «Acciones…» → «Copia ahora» sin abrir el enlace, y resolver la incidencia antes del TTL de 5 min.
started: fase 7 recién implementada; detectado en la UAT (test 4).

## Eliminated

- hypothesis: la edición de recuperación se renderiza con una intención que debería haber expirado (reloj o `expireDueIntents` mal)
  evidence: a las 20:02:49Z la intención seguía dentro de TTL (expiresAt 20:04:01Z). `liveIntentOf` (pending y expiresAt > now) devuelve la fila correctamente; `expireDueIntents` hace su trabajo en la edición `:expire` de las 20:04:02Z.
  timestamp: 2026-11-27T20:35:00Z
- hypothesis: el hub rechaza ya intenciones de incidencias resueltas y el enlace visible es solo cosmético
  evidence: `handleIntentExecute` no consulta `incidents.resolvedAt` en ningún punto (ver Evidence). No hay guarda.
  timestamp: 2026-11-27T20:40:00Z

## Evidence

- timestamp: 2026-11-27T20:32:00Z
  checked: .planning/phases/07-acciones-verificadas-desde-telegram/07-CONTEXT.md D-05 y D-06
  found: "D-05: Si la incidencia se resuelve mientras hay un intent pendiente, el intent sigue valiendo hasta que caduque. El diálogo del hub indica que la incidencia ya está resuelta y deja confirmar." "D-06: Al resolverse la incidencia, los botones de acción desaparecen del aviso... Un intent ya emitido se rige por D-05."
  implication: la decisión de producto vigente es lo contrario de lo que espera el UAT test 4.
- timestamp: 2026-11-27T20:33:00Z
  checked: src/lib/incident-store.ts:695-724 (única escritura de `resolvedAt`, en `recordIncidentObservationIn`) y `closeEpisode` (294-324)
  found: la transacción de cierre actualiza `incidents`, inserta el evento `closed` y encola la edición (`queueEdit` con seq nuevo). No toca `telegram_action_intents`. `cancelLiveIntent` solo se llama desde `applyTokenAction` (telegram-updates.ts:313, botón «Cancelar»).
  implication: la intención queda `pending` al resolver. Primera mitad de la causa.
- timestamp: 2026-11-27T20:34:00Z
  checked: src/lib/notification-dispatch.ts:1173-1190 (`dispatchEdit`) y 616-653 (`composeActionRows`)
  found: `dispatchEdit` hace `liveIntentOf(incident.id, now)` sin mirar `incident.resolvedAt`; `composeActionRows` pasa `liveIntent: intent !== null` a `keyboardActions` y arma `confirm` (url «Confirmar en el hub: …») siempre que `intent` no sea null.
  implication: con la intención viva, la edición de recuperación lleva el enlace. Segunda mitad.
- timestamp: 2026-11-27T20:35:00Z
  checked: src/lib/telegram-keyboard.ts:90-100
  found: `if (state.resolved) return state.liveIntent ? ["intent_cancel", "why"] : ["why"];` con comentario «A live intent is the only thing the menu slot may show... even after the episode resolved (D-05)».
  implication: el render conserva url + Cancelar + Por qué a propósito.
- timestamp: 2026-11-27T20:36:00Z
  checked: tests/telegram-keyboard.test.ts:83-86
  found: test «keeps the link, the cancel and the explanation when an intent outlives the episode» espera `[["url"], ["intent_cancel","why"]]` con `resolved: true, liveIntent: true`.
  implication: el comportamiento observado está fijado por un test; cambiarlo rompe ese test (hay que reescribirlo, no es regresión).
- timestamp: 2026-11-27T20:38:00Z
  checked: src/lib/telegram-intent-api.ts `handleIntentInspect` (367-397) y `handleIntentExecute` (177-249); src/lib/verification-api.ts; src/lib/host-commands.ts; src/lib/operation-runner.ts
  found: inspect solo informa `incident.resolved`. execute no consulta `resolvedAt`; el orden es body, lookup, estado (`pending` → ready), guarda de verificación, host/muestra, claim, ejecución. grep de `resolved|resolvedAt` en verification-api, host-commands y operation-runner: sin resultados.
  implication: una intención viva de una incidencia resuelta SE PUEDE EJECUTAR desde el hub (con sesión y passkey si es protegida).
- timestamp: 2026-11-27T20:39:00Z
  checked: src/components/views/telegram-handoff.tsx:151-155; tests/api-telegram-intents.test.ts:582-605; tests/e2e/telegram-handoff.spec.ts:393 (HANDOFF-09)
  found: el diálogo añade «La incidencia ya está resuelta; puedes confirmar igualmente.» y hay tests (API y e2e) que exigen `state: "ready"` con incidencia resuelta y que el operador puede confirmar.
  implication: ejecutar es intencional (D-05), no un hueco accidental; pero contradice el criterio del UAT 4.
- timestamp: 2026-11-27T20:41:00Z
  checked: 07-UAT.md y `git show 6668cf1`
  found: el test 4 se añadió durante la sesión UAT (no estaba en 07-VERIFICATION.md) con un `expected` que no cita ninguna decisión; el `gap` G-07-4 tiene `artifacts: []` y `missing: []`.
  implication: el criterio nuevo se escribió sin contrastarlo con D-05; el usuario lo ha marcado `issue` (minor) tras ver el enlace.

## Resolution

root_cause: Al resolver una incidencia, la transacción de cierre (`recordIncidentObservationIn`/`closeEpisode` en src/lib/incident-store.ts) no cancela la intención pendiente, y el render de la edición (`dispatchEdit` → `composeActionRows` + `keyboardActions`) no filtra por `resolvedAt`, porque D-05/D-06 de la fase 7 deciden que una intención ya emitida sigue viva hasta caducar; el enlace visible en «Copia recuperada» es ese diseño en acción y entra en conflicto con el criterio nuevo del UAT 4 y G-07-4, que la fase nunca decidió.
fix: (no aplicado; modo diagnóstico)
verification: (no aplicada)
files_changed: []
