---
phase: 04-resumen-diario
plan: "02"
subsystem: notifications
tags: [postgresql, telegram, digest, truncation, cohorts, unicode, frozen-payload]

requires:
  - phase: 04-resumen-diario
    plan: "01"
    provides: digest_runs queue, frozen payload, Madrid targets and the shared Telegram cooldown
  - phase: 02-incidencias-y-entrega-nica
    provides: incidents, incident_events and the durable opening disposition in notification_outbox
  - phase: 03-agrupaci-n-inventario-y-ayudantes
    provides: helper-cleanup assigned to the digest even when PUSH_WARNINGS is enabled

provides:
  - Daily digest with open-now, new-in-period, critical and resolved counters
  - Durable-disposition selection that excludes legacy, silent and individual deliveries
  - Footer-only digest for observed activity without eligible rows and silence for empty days
  - UTF-16 bounded plain text that drops whole lines, keeps the footer and reports exact +N omissions
  - Same-instant order tie-break by episode id and host-group aggregation for pre-period opens

affects: [04-03 digest visibility and health]

actuals:
  tokens: 11829
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "One PostgreSQL statement reads cohorts, exact counters and bounded details from the same snapshot"
    - "Line-level budget: drop whole lines from the end until the exact +N fits, preserving headers and footer"
    - "Omitted = open-now minus represented episodes, so unmaterialised rows and dropped host groups count exactly"
    - "Naive incident timestamps normalised with AT TIME ZONE 'UTC' before applying instant ranges"

key-files:
  created: []
  modified:
    - src/lib/digest-content.ts
    - src/lib/digest-runs.ts
    - tests/notification-dispatch.test.ts
    - tests/telegram.test.ts

key-decisions:
  - "The durable opening row decides the detail set; current preferences and the policy digest boolean never reclassify an episode"
  - "New counts visible dispositions (digest, telegram, push) while silent and legacy episodes stay out of every cohort"
  - "Resolved counts digest or individual closures and excludes migration-dedup, silent and legacy ones"
  - "Opened-now uses the prepare instant, so a resolution committed after the tick start still leaves the episode in the snapshot"
  - "Pre-period opens are grouped per host; recovery opens after the cut are explicit lines but never count as new"
  - "The footer states observed activity only and never claims that a critical was delivered"
  - "Omitted is computed as open-now minus represented episodes, covering the bounded query and dropped groups in one figure"
  - "Host names come from the runtime configuration and are bounded; titles are bounded and stripped of controls, line separators and bidi overrides"

patterns-established:
  - "A single MATERIALIZED CTE chain produces totals, bounded details and host aggregates in one round trip"
  - "Renderer drops aggregate lines before explicit ones so a dropped group becomes +N instead of noisy rows"
  - "The Telegram client remains the last size barrier but the composer guarantees the footer already fits"

requirements-completed: [DIG-03, DIG-04, DIG-06]

coverage:
  - id: D1
    description: "The digest distinguishes open-now, new-in-period and the exact critical and resolved counters from the durable disposition"
    requirement: DIG-03
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#builds the daily cohorts and counters from the durable disposition"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#leaves the individual queue and the timeline untouched"
        status: pass
    human_judgment: false
  - id: D2
    description: "A day without details or countable activity never contacts Telegram; a footer with activity is content"
    requirement: DIG-04
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#sends a footer-only digest when there is activity but no eligible row"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#stays silent when the day has no details and no countable activity"
        status: pass
    human_judgment: false
  - id: D3
    description: "The plain-text message stays within 4096 UTF-16 units, keeps its counters and link and reports the exact +N unique omissions"
    requirement: DIG-06
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#delivers a bounded digest with exact omissions when the details exceed the text"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#caps the materialised details and reports the rest as omitted"
        status: pass
      - kind: unit
        ref: "tests/telegram.test.ts#keeps the footer and the exact omitted count inside the provider limit"
        status: pass
      - kind: unit
        ref: "tests/telegram.test.ts#counts a dropped host group as omitted instead of representing it"
        status: pass
      - kind: unit
        ref: "tests/telegram.test.ts#honours a narrow budget while keeping the footer"
        status: pass
      - kind: unit
        ref: "tests/telegram.test.ts#does not split surrogate pairs or let a title forge another row"
        status: pass
    human_judgment: false
  - id: D4
    description: "The frozen payload and link survive an authorized retry after a 429 even when the hub changed between attempts"
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#repeats the frozen digest after an authorized retry even when the episodes change"
        status: pass
    human_judgment: false

duration: 17min
completed: 2026-11-26
status: complete
commits: 3
plan_head_before: 0b717f1adea7b803d370d576319dc10e8e1e27af
plan_head_after: faeee679916391d37fd7723554a4f079c047bd35
---

# Phase 4 Plan 2: Resumen diario — cohortes, contadores y truncado explícito

**Resumen diario con abiertas en la instantánea, nuevas del periodo, contadores exactos de críticas y resueltas, silencio cuando no hay contenido y truncado por líneas que conserva el pie y el `+N` dentro de 4096 unidades UTF-16.**

## Performance

- **Duration:** 17 min
- **Started:** 2026-11-26T08:11:00Z
- **Completed:** 2026-11-26T08:28:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Una sola sentencia de PostgreSQL con CTE materializadas devuelve cohortes, contadores exactos y filas de detalle acotadas de la misma instantánea: el corte `[objetivo anterior, objetivo actual)` se aplica sobre instantes normalizados y la selección sigue la apertura durable `digest/suppressed/digest_pending`.
- El resumen distingue anteriores todavía abiertas (agrupadas por host), nuevas aún abiertas, nuevas ya cerradas y abiertas durante la recuperación después del corte; una nueva y abierta suma en ambos totales y ocupa una sola línea.
- `helper-cleanup` entra siempre que su apertura sea de resumen, aunque `PUSH_WARNINGS` haya movido otras advertencias a push; las silenciosas, históricas y las que ya tienen canal individual no se listan.
- Las críticas se cuentan por ID con evento `opened` o `severity` crítico dentro del periodo, aunque después bajaran de severidad; las resueltas excluyen cierres sintéticos de migración, silenciosos e históricos.
- Un día sin filas elegibles pero con actividad contabilizable envía solo el pie; un día sin detalles ni actividad no contacta Telegram.
- El compositor reserva encabezados, contadores y enlace, retira líneas completas desde el final hasta que el `+N` exacto cabe y nunca supera 4096 unidades UTF-16: no parte pares sustitutos, neutraliza saltos y controles y conserva el pie y el enlace.
- La repetición autorizada tras un 429 reenvía exactamente el payload y el botón congelados aunque la base haya cambiado entre intentos.

## Task Commits

Cada tarea se commitó de forma atómica. La tarea TDD tiene dos commits (test → feat):

1. **Task 1: Entregar un resumen real con cohortes, totales y silencio cuando esté vacío** - `3aabdfb` (feat)
2. **Task 2: Truncar con recuento exacto y preservar el pie al reenviar tras un 429**
   - `d0c24f9` (test, RED)
   - `faeee67` (feat)

## TDD Evidence

| Task | RED (target tests) | GREEN |
| --- | --- | --- |
| 2 | `keeps the footer and the exact omitted count inside the provider limit` — el pie desaparecía al truncar el texto completo | presupuesto por líneas con `+N` exacto y pie preservado |
| 2 | `counts a dropped host group as omitted instead of representing it` — devolvía 4096 unidades con `limit: 1200` y omitía 0 | se retiran líneas completas y el grupo del host cuenta como omitido |
| 2 | `honours a narrow budget while keeping the footer` — ignoraba el límite y cortaba el enlace | el bucle recalcula con los dígitos reales de N |
| 2 | `delivers a bounded digest with exact omissions when the details exceed the text` — el payload real perdía el enlace | el transporte recibe un texto acotado con pie y `+N` |

El informe RED completo está en `.gsd/tdd-evidence/04-02/red-task2.log` (ignorado por git): 4 fallos de aserción reales, 57 pruebas en verde, sin fallos de carga ni de fixture. `gsd_run` no está instalado en este entorno, así que el clasificador `tdd-red-evidence` no pudo ejecutarse; la evaluación semántica quedó registrada a mano.

## Files Created/Modified

- `src/lib/digest-content.ts` — una sentencia con cohortes, contadores y detalles acotados; selección por disposición durable; render con presupuesto UTF-16, `+N` exacto, saneado y enlace autenticado
- `src/lib/digest-runs.ts` — pasa los nombres de host configurados a la instantánea
- `tests/notification-dispatch.test.ts` — cohortes, límites exactos, recuperación, solo pie, silencio, cola intacta, tope de consulta, truncado real y payload congelado
- `tests/telegram.test.ts` — corpus unitario del render: tamaño, Unicode, controles, orden por ID, agregados omitidos y presupuesto estrecho

## Decisions Made

- **La apertura durable es la autoridad del detalle.** No se recalcula con la política actual ni con el booleano `digest`; una escalada reescribe la fila de apertura y el episodio deja de ser línea de resumen.
- **Nuevas incluye disposiciones visibles.** Cuenta `digest`, `telegram` y `push`, pero nunca silenciosas ni históricas: el resumen no resucita lo que la política silenció.
- **Resueltas usa la misma población visible** y excluye `migration-dedup`, `legacy` y silenciosas, tal como pide el plan.
- **Abiertas ahora es la instantánea de preparación.** Un cierre confirmado después del inicio del tick no saca al episodio del resumen; una apertura posterior al corte sí entra como abierta, sin contarse como nueva.
- **Pie observacional.** «Actividad observada» evita afirmar que una crítica se entregó; el contador de críticas mide eventos, no entregas.
- **Omisiones = abiertas − representadas.** Cubre en una sola cifra las filas que la consulta acotada no materializó y los grupos de host retirados.
- **Los grupos agregados se retiran antes que las líneas explícitas.** Liberan espacio con pocos caracteres y su contenido completo pasa a `+N`.
- **Instantes normalizados.** Drizzle escribe los `timestamp` como reloj UTC; cada comparación usa `AT TIME ZONE 'UTC'` para que el periodo siga significando instantes en los cambios de hora.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Las comparaciones de periodo mezclaban reloj local y UTC**
- **Found during:** Task 1 (primera ejecución del caso de recuperación dentro de la ventana)
- **Issue:** El parámetro `Date` de `pg` se serializaba con componentes locales mientras Drizzle persiste los `timestamp` como componentes UTC; un cierre posterior a la instantánea se clasificaba como anterior y el episodio desaparecía de abiertas.
- **Fix:** Todas las comparaciones normalizan la columna con `AT TIME ZONE 'UTC'` y los parámetros van como `timestamptz`.
- **Files modified:** `src/lib/digest-content.ts`
- **Verification:** `builds the daily cohorts and counters from the durable disposition`
- **Committed in:** `3aabdfb`

**2. [Rule 1 - Scope] El tracer entregó de más el truncado y se reencuadró al alcance del plan**
- **Found during:** Task 2 (preparación del ciclo TDD)
- **Issue:** La tarea 1 implementó ya el presupuesto por líneas que el plan reserva para la tarea 2; sin ese hueco no había un RED real que acreditase la tarea.
- **Fix:** Se redujo la tarea 1 a lo que el plan pide (pie conservado en un día normal y cota del proveedor), se escribieron las pruebas de la tarea 2, se capturó el RED y se restauró el truncado completo en el GREEN.
- **Files modified:** `src/lib/digest-content.ts`
- **Verification:** RED con 4 fallos de aserción (`d0c24f9`); GREEN 61/61 (`faeee67`)
- **Committed in:** `3aabdfb` (ámbito de la tarea 1) y `faeee67` (truncado completo)

---

**Total deviations:** 2 auto-fixed (1 correctness, 1 scope correction)
**Impact on plan:** La corrección de instantes era necesaria para que las cohortes fuesen exactas; el reencuadre dejó la tarea TDD con evidencia RED real sin cambiar el resultado final. Sin ampliación de alcance.

## Issues Encountered

- **`gsd_run` no está instalado.** No se pudo ejecutar el clasificador `tdd-red-evidence` ni el registro de ventanas; la evidencia RED se conserva en `.gsd/tdd-evidence/04-02/`.
- **ESLint directo falla con TypeScript 7.** `pnpm lint <archivos>` usa el adaptador de la API de TS 6 y pasa sin avisos en los ficheros tocados; es la vía documentada del repositorio.
- **La suite completa se ejecutó con workers acotados:** 41 archivos y 534 pruebas en verde (`--maxWorkers=3`).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `buildDigestSnapshot` queda listo para que 04-03 proyecte el estado del último resumen en Avisos sin exponer el contenido.
- Los motivos finitos y el estado de `digest_runs` no cambian; el payload sigue siendo la única representación del texto entregado.
- Las cohortes y los contadores no dependen de la paginación de Avisos ni de la selección de host.

---

## Self-Check: PASSED

- 4/4 files listed above exist on disk.
- 3/3 commits are ancestors of HEAD (`3aabdfb`, `d0c24f9`, `faeee67`).
- `HUB_REQUIRE_TEST_DB=1 pnpm exec vitest run --maxWorkers=3` → 41 files, 534 tests passed.
- `pnpm typecheck` → exit 0; lint focalizado de los 4 ficheros → sin avisos.

---

*Phase: 04-resumen-diario*
*Completed: 2026-11-26*
