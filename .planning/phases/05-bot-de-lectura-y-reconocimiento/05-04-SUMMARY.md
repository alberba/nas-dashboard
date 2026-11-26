---
phase: 05-bot-de-lectura-y-reconocimiento
plan: "04"
subsystem: notifications
tags: [telegram, hub, acknowledge, snooze, digest, outbox, playwright, drizzle]

# Dependency graph
requires:
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "01"
    provides: applyIncidentAction con ack, tokens de un solo uso y edición silenciosa
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "02"
    provides: silencio por (hostId, key), acciones snooze y unsnooze y el motivo snoozed
  - phase: 04-resumen-diario
    provides: consulta única del resumen con cohortes durables y tope de 4096
provides:
  - Ruta POST de reconocer, silenciar y quitar silencio desde el hub
  - Proyección pública de reconocimiento, silencio vigente y motivo snoozed
  - Estado y controles de reconocimiento y silencio en Avisos
  - Etiquetas del resumen y cohorte de aperturas retenidas por silencio
affects: [05-05, 05-06, fase-6]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 12412
  tasks: 3
  commits: 5
  plan_head_before: e33526c65047e32bfac7b409ccd6cfe376d4225e
  plan_head_after: 25dd323e50a63cd4844f3af690db899a50b415b7

tech-stack:
  added: []
  patterns:
    - "Una mutación del hub es la misma applyIncidentAction de Telegram, con via hub y el nombre de sesión como by"
    - "La fila se resuelve por la pareja id y hostId: nunca por el id solo"
    - "La proyección carga los silencios vivos una vez por lote y los empareja por (hostId, key)"
    - "El estado del operador es una etiqueta al final de la línea del resumen, nunca una segunda fila"

key-files:
  created:
    - tests/digest-ack-labels.test.ts
  modified:
    - src/app/api/[...path]/route.ts
    - src/lib/types.ts
    - src/lib/incident-store.ts
    - src/lib/digest-content.ts
    - src/components/views/alerts.tsx
    - src/components/dashboard.tsx
    - tests/api-incidents.test.ts
    - tests/e2e/incidents.spec.ts

key-decisions:
  - "El cuerpo es un z.strictObject con host y hours del conjunto cerrado: la duración se exige en snooze y se prohíbe en las otras dos acciones"
  - "La acción responde 200 con outcome y la incidencia proyectada tras releer la fila, para que la vista y la lista coincidan"
  - "Un silencio se publica solo con la incidencia abierta; un episodio resuelto no muestra estado ni controles"
  - "La cohorte del resumen admite la apertura o escalada suprimida con motivo snoozed: D-01 la mantiene visible"
  - "acknowledgedAt y el vencimiento del silencio se comparan como instantes, sin AT TIME ZONE, porque ya son timestamptz"

patterns-established:
  - "Acción del hub por la ruta existente con guardas comunes de Origen y sesión, sin guardSensitiveAction"
  - "Atributos data-ack-* y data-snooze-* como contrato de estado para Playwright, nunca el texto"
  - "Una etiqueta opcional al final de la línea del resumen, con la hora calculada por madridClock"

requirements-completed: [BOT-04]

coverage:
  - id: D1
    description: "POST /api/incidents/:id/(acknowledge|snooze|unsnooze) aplica la acción del hub con cuerpo estricto y alcance por host"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#applies acknowledge, snooze and unsnooze from the hub once per state"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#never acts on another host's episode"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#refuses a resolved episode and any body outside the contract"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#requires a session and an allowed origin for the hub actions"
        status: pass
    human_judgment: false
  - id: D2
    description: "La incidencia publica el reconocimiento, el silencio vigente y el motivo snoozed sin identificadores de Telegram"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#publishes the hub state and a silence-held opening without Telegram identifiers"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#projects finite delivery states and reasons for overview and detail"
        status: pass
    human_judgment: false
  - id: D3
    description: "Avisos muestra el estado de cada incidencia abierta y ofrece reconocer, silenciar 1 h y 24 h y quitar el silencio"
    requirement: "BOT-04"
    verification:
      - kind: e2e
        ref: "tests/e2e/incidents.spec.ts#INC-E2E-05 acknowledges, silences and unsilences an episode from Avisos"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#applies acknowledge, snooze and unsnooze from the hub once per state"
        status: pass
    human_judgment: false
  - id: D4
    description: "El resumen etiqueta lo reconocido y silenciado sin mover contadores y lista lo retenido por un silencio"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/digest-ack-labels.test.ts#labels an acknowledged digest episode without moving the counters"
        status: pass
      - kind: integration
        ref: "tests/digest-ack-labels.test.ts#writes the Madrid deadline of a live silence as a computed value"
        status: pass
      - kind: integration
        ref: "tests/digest-ack-labels.test.ts#lists an opening withheld by a silence in the open cohort"
        status: pass
      - kind: integration
        ref: "tests/digest-ack-labels.test.ts#counts a digest episode escalated to critical while silenced"
        status: pass
      - kind: integration
        ref: "tests/digest-ack-labels.test.ts#keeps the footer and the link with forty labelled lines"
        status: pass
    human_judgment: false
  - id: D5
    description: "Una acción del hub sobre un aviso enviado edita en silencio el mensaje de Telegram (D-14)"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#applies acknowledge, snooze and unsnooze from the hub once per state"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#queues no edit when the episode never had a Telegram notice"
        status: pass
    human_judgment: true
    rationale: "Que la edición llegue al mensaje real sin sonido, con el teclado nuevo, exige el bot y el móvil; queda en el human-check de fin de fase."

duration: 23 min
completed: 2026-11-26
status: complete
---

# Phase 05 Plan 04: Reconocer y silenciar desde el hub y en el resumen Summary

**Avisos reconoce, silencia y quita el silencio con la misma `applyIncidentAction` que Telegram, publica el estado en cada incidencia y el resumen lo etiqueta sin mover un solo contador.**

## Performance

- **Duration:** 23 min
- **Started:** 2026-11-26T14:44:00Z
- **Completed:** 2026-11-26T15:07:00Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- `POST /api/incidents/:id/acknowledge|snooze|unsnooze` valida el id con el mismo patrón que la consulta puntual y el cuerpo con `z.strictObject`; `hours` solo existe en `snooze` y solo vale 1 o 24. Sin sesión 401, con Origen ajeno 403, incidencia resuelta 409, pareja id/host inexistente 404 y, si procede, 200 con `outcome` e incidencia proyectada.
- La acción entra en `db.transaction` con `via: "hub"`, `by` igual al nombre de la sesión recortado a 80 caracteres y el instante de la petición: escribe el mismo estado, el mismo evento y la misma edición silenciosa que el botón de Telegram, sin `guardSensitiveAction`.
- `Alert` publica `acknowledged` (instante, canal y nombre de sesión) y `snooze` (vencimiento y canal) solo con el silencio vivo y la incidencia abierta; `PublicDeliveryReason` gana `snoozed` y una apertura retenida por silencio se ve en Avisos con ese motivo.
- Cada fila abierta de Avisos lleva `data-ack-state`, `data-ack-via`, `data-snooze-state` y `data-snooze-until`, y los controles `acknowledge`, `snooze-1h`, `snooze-24h` y `unsnooze` con `data-action`. Una incidencia resuelta no muestra ni estado ni controles; mientras una acción está en vuelo los botones de esa fila quedan deshabilitados.
- `src/components/dashboard.tsx` traduce la acción al verbo y al cuerpo, repite el patrón de sesión caducada con `signInAgain`, muestra el error con `setToast`, actualiza la incidencia enlazada y llama a `refresh()`.
- El resumen lee `acknowledgedAt` y el silencio vigente en la misma consulta única, admite la apertura suprimida con motivo `snoozed` en la cohorte de abiertas ahora y añade "Reconocida" y "Silenciada hasta HH:mm" al final de la línea, con la hora de Madrid calculada por `madridClock`.

## Task Commits

Cada tarea se comprometió de forma atómica; las dos tareas TDD llevan RED y GREEN separados:

1. **Tarea 1 RED: pruebas que fallan de las acciones del hub** - `d0e88ec` (test)
2. **Tarea 1 GREEN: reconocer, silenciar y quitar silencio por la API** - `fd3b9d8` (feat)
3. **Tarea 2: estado y controles en Avisos** - `13a5bb8` (feat)
4. **Tarea 3 RED: pruebas que fallan de las etiquetas del resumen** - `91c6478` (test)
5. **Tarea 3 GREEN: etiquetas, cohorte retenida y hora de Madrid** - `25dd323` (feat)

**Plan metadata:** `docs(05-04)` (este archivo, STATE y ROADMAP)

_No hizo falta commit REFACTOR: la implementación de las dos tareas TDD ya era la mínima._

## Files Created/Modified

- `src/app/api/[...path]/route.ts` — rama POST `incidents/:id/(acknowledge|snooze|unsnooze)` con id validado, cuerpo estricto, pareja id/host y `applyIncidentAction` en transacción.
- `src/lib/types.ts` — `Alert.acknowledged`, `Alert.snooze`, los tipos `AlertAcknowledged` y `AlertSnooze` y el motivo `snoozed`.
- `src/lib/incident-store.ts` — `snoozed` en `finiteReasons`; `projectRow` recibe el silencio y rellena el estado; `projectIncidents` lee los silencios vivos una vez por lote.
- `src/lib/digest-content.ts` — unión lateral al silencio vivo, `acknowledgedAt` en el CTE, cohorte `digestOpen` ampliada, `acknowledged` y `snoozeUntil` en el detalle y las dos etiquetas en `detailLine`.
- `src/components/views/alerts.tsx` — `IncidentHubAction`, `onAction`, `HubState`, `HubControls`, la etiqueta del motivo `snoozed` y el estado de acción en vuelo.
- `src/components/dashboard.tsx` — `runIncidentAction` con verbo, cuerpo, 401, error, incidencia enlazada y refresco.
- `tests/api-incidents.test.ts` — seis pruebas nuevas y la limpieza de `incident_snoozes` entre casos.
- `tests/e2e/incidents.spec.ts` — episodio `e2e-incident-actions` con su aviso enviado y `INC-E2E-05`.
- `tests/digest-ack-labels.test.ts` — siete pruebas de etiquetas, cohorte, agregadas y tope de longitud.

## Decisions Made

- **Un solo cuerpo estricto con una regla cruzada.** `z.strictObject` rechaza campos desconocidos y el `refine` exige `hours` solo en `snooze`: una duración en `acknowledge` o `unsnooze` es 400, no un campo ignorado.
- **La respuesta relee la fila.** Después de la transacción se vuelve a proyectar la incidencia, así el cliente recibe el estado y el silencio que acaba de escribir en lugar de una copia previa.
- **El silencio no se publica en un episodio resuelto.** La fila sigue existiendo para la próxima apertura de la condición, pero la vista de un episodio cerrado no muestra estado ni controles.
- **La cohorte del resumen se amplía, los contadores no se tocan.** `digestOpen` admite la supresión por silencio; `totals`, `critical` y `aggregated` conservan su fórmula, así que reconocer o silenciar un episodio ya listado no mueve ninguna cifra.
- **Las columnas nuevas se comparan como instantes.** `acknowledgedAt` y `snooze.until` son `timestamptz`, así que no llevan `AT TIME ZONE 'UTC'`, que solo aplica a `at` y `resolvedAt`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Los silencios de una prueba se filtraban a la siguiente**
- **Found during:** Tarea 1 (RED)
- **Issue:** `incident_snoozes` se indexa por `(hostId, key)` y no tiene clave ajena a `incidents`, así que el `beforeEach` existente no la vaciaba y un silencio de un caso habría cambiado la proyección del siguiente.
- **Fix:** el `beforeEach` de `tests/api-incidents.test.ts` borra también `incident_snoozes`.
- **Files modified:** `tests/api-incidents.test.ts`
- **Verification:** la suite completa de API (32 pruebas) pasa en verde con los casos de silencio intercalados.
- **Committed in:** `d0e88ec` (parte del commit RED)

---

**Total deviations:** 1 auto-fixed (1 bug en el aislamiento de las pruebas).
**Impact on plan:** Ninguno sobre el alcance; el arreglo es el que exige la nueva tabla en una suite que ya limpiaba el resto del estado.

## TDD Gate Compliance

| Gate | Commit | Evidence |
|------|--------|----------|
| RED (tarea 1) | `d0e88ec` `test(05-04): add failing tests for the hub incident actions` | 4 de las 6 pruebas nuevas fallan por aserción: `expected 404 to be 200`, `expected 404 to be 409`. Las 26 previas siguen en verde. `check tdd-red-evidence` → `RED_EVIDENCE_OK`. |
| GREEN (tarea 1) | `fd3b9d8` `feat(05-04): acknowledge, silence and unsilence an episode from the hub` | `pnpm test tests/api-incidents.test.ts tests/incident-store.test.ts` → 39/39 y `pnpm typecheck` sin errores. |
| RED (tarea 3) | `91c6478` `test(05-04): add failing tests for the digest acknowledgement labels` | 4 de las 7 pruebas fallan por aserción: línea idéntica tras reconocer, falta `02:01` del silencio, `+0` frente a 1 en abiertas ahora y en críticas. `check tdd-red-evidence` → `RED_EVIDENCE_OK`. |
| GREEN (tarea 3) | `25dd323` `feat(05-04): label the acknowledged and silenced episodes in the digest` | `TZ=Pacific/Honolulu pnpm test tests/digest-ack-labels.test.ts tests/notification-dispatch.test.ts tests/telegram.test.ts` → 85/85 y `pnpm typecheck` sin errores. |
| REFACTOR | — | No fue necesario: la implementación de ambas tareas ya era la mínima. |

La tarea 2 no lleva `tdd="true"`: su puerta es la prueba de Playwright de la tarea.

## Verification

- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts tests/incident-store.test.ts && pnpm typecheck` → 2 archivos, 39 pruebas en verde; tsc sin errores.
- `pnpm typecheck && pnpm lint src tests && pnpm build` → sin errores; Next.js 16.4.6 compila y genera las rutas.
- `pnpm lint` completo → falla solo por los directorios de entorno no versionados (`.opencode/`, `.claude/`, `.agents/`), fuera del alcance de este plan; el lint de `src` y `tests` termina con exit 0.
- `pnpm test:e2e tests/e2e/incidents.spec.ts` contra una base desechable migrada en el servidor de loopback → 5 pruebas en verde (INC-E2E-01 a INC-E2E-05); la base se eliminó al terminar.
- `TZ=Pacific/Honolulu DATABASE_URL=... HUB_REQUIRE_TEST_DB=1 pnpm test tests/digest-ack-labels.test.ts tests/notification-dispatch.test.ts tests/telegram.test.ts && pnpm typecheck` → 3 archivos, 85 pruebas en verde.
- `TZ=Europe/Madrid DATABASE_URL=... HUB_REQUIRE_TEST_DB=1 pnpm test tests/digest-ack-labels.test.ts` → 7/7: la hora de Madrid no depende de la zona del proceso.
- `DATABASE_URL=... HUB_REQUIRE_TEST_DB=1 pnpm test` → 47 archivos, 625 pruebas, todas en verde.
- `grep -rn "Reconocer\|Silenciar\|Quitar silencio\|Reconocida\|Silenciada hasta\|Retenido por un silencio" tests/` → única coincidencia, un comentario en `tests/telegram-updates.test.ts`; ninguna prueba depende del copy nuevo.

## Issues Encountered

- `pnpm lint` sin rutas recorre los directorios de herramientas sin versionar y acumula miles de avisos ajenos al proyecto; se verificó con `pnpm lint src tests`, que es la superficie del plan.

## User Setup Required

None - no external service configuration required. Sin migraciones, variables de entorno ni dependencias nuevas.

## Pending Human Verification (end-of-phase)

Aplazado al `human-check` de fin de fase por `workflow.human_verify_mode=end-of-phase`:

1. Con el bot real y una incidencia con aviso enviado, reconocer desde Avisos y comprobar que el mensaje de Telegram se edita en silencio, sin el botón Reconocer y con la hora de Madrid (D-14).
2. Silenciar 1 h desde Avisos y comprobar en el móvil que el mismo mensaje muestra el vencimiento y ofrece Quitar silencio; quitar el silencio y ver volver los dos botones.
3. Revisar en escritorio y en móvil que el bloque de estado y los tres controles de una fila abierta se leen y se pulsan sin solaparse.

## Next Phase Readiness

- El contrato de la ruta, la proyección pública y los atributos de la vista quedan fijados; 05-05 puede apoyarse en `acknowledged` y `snooze` sin volver a consultarlos por separado.
- 05-05 hereda la limpieza del silencio vencido: hoy `projectIncidents` y el resumen ya lo ignoran, pero la fila sigue en `incident_snoozes` hasta que se borre.
- La fase 6 puede fijar la lista de acciones protegidas: estas tres no pasan por `guardSensitiveAction` por decisión de 05-CONTEXT (T-05-15 aceptado).
- BOT-04 lo declaran también planes hermanos; `requirements.ready-ids` lo mantiene bloqueado hasta que el último plan de la fase publique su SUMMARY.

---
*Phase: 05-bot-de-lectura-y-reconocimiento*
*Completed: 2026-11-26*

## Self-Check: PASSED

- Los nueve archivos creados o modificados existen en disco.
- Los commits `d0e88ec`, `fd3b9d8`, `13a5bb8`, `91c6478` y `25dd323` son ancestros de HEAD.
- `git rev-list --count e33526c..HEAD` = 5, el mismo número que declara `actuals.commits`.
- `pnpm typecheck` sin errores y la suite completa en verde (47 archivos, 625 pruebas).
