---
phase: 03-agrupaci-n-inventario-y-ayudantes
plan: "02"
subsystem: incidents
tags:
  - incidents
  - inventory
  - docker
  - container-watch
  - postgresql
  - concurrency
  - settings

requires:
  - phase: 03-agrupaci-n-inventario-y-ayudantes
    plan: "01"
    provides: "Metrics.containersObservedAt, contexto de inventario, bloqueo de observación y proyección Alert"

provides:
  - "Ventana durable de ausencia por host y por nombre, acreditada solo con listas Docker nuevas, completas y consecutivas"
  - "Retirada a los 30 minutos acreditados con cierre de fase 2 y conservación del historial"
  - "Reasignación de la vigilancia y del episodio por ID de Docker o pareja Compose única"
  - "Cierre idempotente compartido de start, stop y eliminación entre API y colector"
  - "Mutación serializada por fila de la configuración y control de revisión de la vigilancia"
  - "Proyección watchPending por host y filas pendientes sin acciones Docker en Mantenimiento"

affects: [03-03, 04, verify-work]

actuals:
  tokens: 26919
  tasks: 3
  commits: 5
  plan_head_before: 57f5aabecb6dfa50440a1add5a2cf167cf0a30ec
  plan_head_after: cdb376a2caffd3dc2897551e98c446b9fc0fd1ba

tech-stack:
  added: []
  patterns:
    - "El reloj de ausencia se basa en marcas de inventario Docker, nunca en la hora del sistema"
    - "La cadena de evidencia se corta en fallo de transporte, fallo de contrato o reinicio del worker sin perder lo acreditado"
    - "La configuración se modifica por campos bajo bloqueo de fila y comparte transacción con las transiciones del store"
    - "Una revisión de vigilancia tomada antes de pedir métricas invalida lecturas que pierden una carrera"
    - "La finalización de una operación de contenedor es única e idempotente para API y colector"

key-files:
  created:
    - src/lib/container-watch.ts
  modified:
    - src/lib/settings.ts
    - src/lib/collector.ts
    - src/lib/incident-store.ts
    - src/lib/lifecycle.ts
    - src/lib/types.ts
    - src/lib/validation.ts
    - "src/app/api/[...path]/route.ts"
    - src/components/dashboard.tsx
    - src/components/views/maintenance.tsx
    - src/components/views/alerts.tsx
    - tests/collector-alerts.test.ts
    - tests/api-incidents.test.ts
    - tests/e2e/maintenance.spec.ts

key-decisions:
  - "La ausencia se acredita con el tramo entre dos marcas Docker consecutivas; el reloj de pared no acredita nada"
  - "Un tramo superior a CONNECTION_STALE_MS (75 s) no es evidencia y solo reinicia la cadena"
  - "El worker se identifica con un UUID de proceso en globalThis: recargar el módulo no simula un reinicio y un proceso nuevo sí lo es"
  - "Un nombre ausente nunca abre un episodio; si ya estaba abierto se marca observationPending con motivo container-absent"
  - "Al vencer los 30 minutos se retira el nombre y se cierra el episodio con closedBy reconciliation y el cierre de fase 2"
  - "La igualdad de ID de Docker tiene prioridad sobre la pareja Compose y sobre el nombre anterior"
  - "Dos orígenes que reclaman el mismo reemplazo o un destino ya vigilado dejan ambos casos pendientes"
  - "Una fila de destino solo se cierra cuando la identidad probada demuestra que es la misma vigilancia"
  - "La revisión se lee antes de pedir métricas y se comprueba bajo el bloqueo de la fila de configuración"
  - "El body de Ajustes es estricto y la proyección pública elimina el estado interno de vigilancia"

patterns-established:
  - "Contrato durable ContainerWatch: revision, workerId, lastInventoryAt, chainAt, entries e identities"
  - "Mutación de configuración con mutateSettings(hostId, (current, tx) => ...) y sin esperas de red dentro"
  - "Transiciones del store dentro de una transacción ajena con recordIncidentObservationIn"
  - "Atributos data-watch-* para que Playwright afirme el estado sin acoplarse al copy"

requirements-completed: [INCD-10]

coverage:
  - id: D1
    description: "Un nombre esperado ausente queda pendiente con cero tiempo acreditado y no abre una incidencia nueva"
    requirement: INCD-10
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#accredits an absent name only across consecutive fresh complete lists"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#publishes a pending absence through the collector in the overview and the real episode"
        status: pass
    human_judgment: false
  - id: D2
    description: "La ausencia se acredita solo con listas nuevas, completas y consecutivas; fallo de contrato, fallo de transporte y reinicio del worker no consumen gracia"
    requirement: INCD-10
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#accredits an absent name only across consecutive fresh complete lists"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#ignores a repeated or older Docker list for the watch window"
        status: pass
    human_judgment: false
  - id: D3
    description: "A los 30 minutos acreditados se retira el nombre y se cierra cualquier episodio abierto conservando ID, historial y entrega"
    requirement: INCD-10
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#retires an absent name after thirty accredited minutes and closes its episode"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#keeps the watch when the name reappears before the window expires"
        status: pass
    human_judgment: false
  - id: D4
    description: "La vigilancia y el episodio pasan al reemplazo probado por ID o Compose única, incluido el nombre anterior ocupado por otro contenedor"
    requirement: INCD-10
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#moves the watch and the episode to a new name with the same Docker ID"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#moves the watch to a unique Compose replacement with another ID"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#keeps the original link working after a proven container rename"
        status: pass
    human_judgment: false
  - id: D5
    description: "Los reemplazos ambiguos, compartidos o con fila de destino existente conservan la espera o resuelven solo la duplicada"
    requirement: INCD-10
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#keeps both names pending when a scaled Compose service is ambiguous"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#does not choose a destination claimed by two watched names"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#keeps the original episode and closes a duplicate destination row"
        status: pass
    human_judgment: false
  - id: D6
    description: "Una parada, reinicio o eliminación confirmada no se sobrescribe con una lectura anterior y cierra una sola vez"
    requirement: INCD-10
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#ignores a collector reading started before a confirmed stop"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#waits for a post-operation list before confirming a lost stop and closes once"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#keeps a removal unconfirmed until the inventory proves the absence"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#preserves a concurrent threshold edit and the watch reconciliation"
        status: pass
      - kind: integration
        ref: "tests/api-lifecycle.test.ts#closes only the selected host's container incident after a confirmed removal"
        status: pass
    human_judgment: false
  - id: D7
    description: "Mantenimiento muestra el nombre pendiente con primera ausencia y sin acciones Docker, y Avisos separa la ausencia de la inhibición por caída"
    verification:
      - kind: e2e
        ref: "tests/e2e/maintenance.spec.ts#an absent name is pending for its host without Docker actions (spec creado, no ejecutado)"
        status: unknown
    human_judgment: true
    rationale: "El orquestador pidió no ejecutar Playwright E2E en este plan; la comprobación visual de la fila pendiente y del bloque de Avisos queda para la verificación de fin de fase."

duration: 22min
completed: 2026-11-25
status: complete
---

# Phase 03 Plan 02: Inventario reconciliado y vigilancia continua

**La vigilancia de `expectedContainers` sobrevive a renombrados y recreaciones con evidencia Docker fechada, retira un nombre solo tras 30 minutos acreditados y comparte una única transacción con la intención del operador.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-11-25T14:40:55Z (aproximado, inicio de la ejecución)
- **Completed:** 2026-11-25T15:02:00Z (aproximado, última verificación)
- **Tasks:** 3
- **Files modified:** 14 (1 creado, 13 modificados)

## Contrato de vigilancia

El estado durable vive en `Settings.watch` (columna JSONB existente de `configuration`) y es opcional para que una fila antigua o el binario anterior sigan funcionando.

```ts
// src/lib/types.ts
export type ContainerWatch = {
  revision: number;                 // intención de vigilancia
  workerId: string | null;          // proceso que produjo la última lista
  lastInventoryAt: number | null;   // última lista completa evaluada (epoch s)
  chainAt: number | null;           // última lista que continúa la cadena
  entries: Record<string, ContainerWatchEntry>;
  identities: Record<string, ContainerIdentity>;
};
export type ContainerWatchEntry = {
  identity: ContainerIdentity;
  absentSince: number;              // primera ausencia (epoch s)
  observedAt: number;               // última lista que acreditó esta ausencia
  accreditedMs: number;             // tiempo de ausencia probado
};
export type ContainerIdentity = {
  containerId: string | null;
  composeProject: string | null;
  composeService: string | null;
};
```

- **Estado por nombre:** una entrada solo existe mientras el nombre está ausente. Al reaparecer se borra y `expectedContainers` conserva el nombre.
- **Reloj de ausencia:** solo una lista con `containersObservedAt` válido, completo y mayor que `lastInventoryAt` evalúa la ausencia. El primer avistamiento crea la entrada con `accreditedMs = 0`. Las listas siguientes suman el tramo real solo si `chainAt === lastInventoryAt`, `workerId` coincide y el tramo no supera `CONNECTION_STALE_MS` (75 s, que cubre `sampleInterval` de 5 s y 30 s). La hora del sistema nunca suma.
- **Continuidad:** un fallo de transporte o de contrato llama a `breakWatchContinuity`; un proceso nuevo cambia `workerId`. En ambos casos se conserva lo acreditado y la lista siguiente inicia una cadena nueva, sin acreditar el hueco.
- **Umbral:** al llegar a 30 min se retira el nombre de `expectedContainers`, se borra su entrada y se cierra el episodio abierto con `closedBy: "reconciliation"` y el cierre de fase 2 (ID, eventos, outbox y resultado de entrega intactos).
- **Agente anterior:** sin `containersObservedAt` no se escribe estado de vigilancia ni se evalúa la ausencia; los contenedores presentes siguen su evaluación normal.
- **Proyección:** `pendingWatch(settings)` publica `Overview.watchPending` solo para el host solicitado. El body de Ajustes es estricto y las respuestas de configuración eliminan `watch` mediante `publicSettings`.

## Decisiones de reasignación

- La evidencia se guarda al confirmar presencia, por nombre, con ID de Docker y pareja Compose.
- La igualdad de ID se evalúa primero y gana incluso si otro contenedor ocupa el nombre anterior.
- Si no hay ID, se usa la pareja `project`/`service`, siempre sobre una lista completa nueva.
- El candidato debe ser único y no puede estar ya en `expectedContainers`; dos orígenes que reclaman el mismo candidato dejan ambos casos pendientes.
- Una fila de destino existente se cierra solo cuando la identidad probada demuestra que es la misma vigilancia. La fila original conserva ID, `at`, `origin`, outbox y eventos; se actualizan `key`, `fingerprint` y título en una transacción, con un evento `reassigned` que cita la referencia anterior y la nueva.
- Reemplazo en marcha: la fila original se enlaza y se cierra con el cierre de fase 2. Reemplazo detenido: la misma fila se reanuda (`resumed`), conserva su aviso previo y no abre uno nuevo.
- Una ausencia corta la ventana de fallo por detención: una reaparición detenida vuelve a acreditar sus 30 s desde la primera lectura nueva.

## Interfaces que 03-03 debe consumir

- `src/lib/container-watch.ts`
  - `reconcileContainers({ host, metrics, now, revision })` — única entrada de reconciliación de inventario.
  - `watchRevision(settings)` / `watchOf(settings)` — revisión y estado durable.
  - `pendingWatch(settings)` — filas pendientes públicas.
  - `identityOf(container)`, `inventoryMark(metrics)`, `breakWatchContinuity(hostId)`.
  - `WATCH_THRESHOLD_MS`, `CONTAINER_ABSENT_REASON`, `containerPrefix`.
- `src/lib/settings.ts`
  - `mutateSettings(hostId, (current, tx) => next)` — serializa una lectura-modificación-escritura por host y permite transiciones del store en la misma transacción. No esperar Docker dentro.
  - `getSettings(hostId)` — documento normalizado; `defaults`, `normalizeSettings`.
- `src/lib/incident-store.ts`
  - `recordIncidentObservationIn(tx, input)` — transición dentro de una transacción ajena.
  - `markContainerObservationPendingIn(tx, { hostId, key, reason, now })` — marca `observationPending` sin abrir ni cerrar.
  - `transferContainerWatchIn(tx, { hostId, fromName, toName, title, running, mergeDestination, now })` — reasigna clave, fingerprint, título, evento y cierre/reanudación.
- `src/lib/lifecycle.ts`
  - `finalizeContainerOperation({ hostId, hostName, operationId, action, name, containerId, container, detail, now })` — cierre idempotente de `start`, `restart`, `stop` y `remove-container`; resuelve el nombre vigilado por el ID confirmado.
  - `ContainerOperationAction`.
- `src/lib/types.ts`
  - `ContainerWatch`, `ContainerWatchEntry`, `ContainerIdentity`, `ContainerWatchPending`.
  - `Alert.observationPending` + `Alert.inhibitedReason === "container-absent"`.
  - `Overview.watchPending`.

## Accomplishments

- La ausencia de un nombre esperado se ve en el inventario autenticado del host como `watchPending`, sin ID ficticio ni controles Docker, y no abre una incidencia nueva.
- El estado durable por nombre sobrevive a reinicios del worker y a fallos de transporte: lo ya acreditado se conserva y el hueco no se acredita.
- El nombre se retira exactamente a los 30 minutos acreditados y su episodio se cierra con el historial y la entrega intactos.
- Un renombrado por ID y una recreación Compose única trasladan la vigilancia y la referencia de Avisos; los casos ambiguos no eligen destino.
- Paradas, reinicios y eliminaciones confirmadas comparten un cierre idempotente; una lectura iniciada antes de la operación no puede resucitar la vigilancia.
- La edición concurrente de umbrales y la reconciliación preservan ambas operaciones sobre la misma fila de configuración.

## Task Commits

Cada tarea se confirmó de forma atómica (con dos commits de endurecimiento posteriores):

1. **Task 1: Mostrar un nombre ausente pendiente hasta reconciliarlo** — `fcc7af6` (feat)
2. **Task 2: Reasignar la vigilancia y el episodio a un reemplazo comprobado** — `57e8cc4` (feat)
3. **Task 3: Conservar la intención del operador al intercalarse con el colector** — `6ee758c` (feat)
4. **Endurecimiento de la prueba de continuidad** — `88dc19f` (test)
5. **Ventana de fallo tras ausencia e identidad por ID** — `cdb376a` (fix)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: el planner de reasignación y la transición `transferContainerWatchIn` forman parte del modelo durable introducido en el commit 1 para que el tracer fuera completo; el commit 2 añade la reanudación sin ventana nueva y las pruebas de comportamiento. El commit 4 refuerza el caso de fallo de transporte y el 5 corrige la ventana de fallo tras una ausencia y la resolución del nombre por ID._

## Files Created/Modified

- `src/lib/container-watch.ts` — estado durable, acreditación de ausencia, decisión de identidad, caducidad y reasignación.
- `src/lib/settings.ts` — normalización y `mutateSettings` transaccional por fila; se retiró el escritor de documento completo.
- `src/lib/collector.ts` — revisión antes de pedir métricas, reconciliación, corte de continuidad, ausencia sin apertura y promoción de operaciones pendientes.
- `src/lib/incident-store.ts` — transición dentro de transacción ajena, ausencia pendiente, transferencia de vigilancia y limpieza del bloqueo al cerrar.
- `src/lib/lifecycle.ts` — `finalizeContainerOperation` compartido e idempotente.
- `src/lib/types.ts` — tipos de vigilancia y proyección `watchPending`.
- `src/lib/validation.ts` — `settingsSchema` estricto.
- `src/app/api/[...path]/route.ts` — ajustes por campos, cierre compartido de acciones, `watchPending` y configuración pública sin `watch`.
- `src/components/dashboard.tsx` — entrega `watchPending` a Mantenimiento.
- `src/components/views/maintenance.tsx` — panel de vigilancia pendiente sin acciones Docker.
- `src/components/views/alerts.tsx` — bloque de ausencia pendiente separado de la inhibición por caída.
- `tests/collector-alerts.test.ts` — acreditación, caducidad, reaparición, fallos, reinicio, reasignación y ambigüedad.
- `tests/api-incidents.test.ts` — overview real, enlace original, carreras, operaciones perdidas, caché anterior y ajustes.
- `tests/e2e/maintenance.spec.ts` — fila pendiente por host y ausencia de acciones (spec creado, no ejecutado).

## Decisions Made

- El estado de vigilancia se guarda en la misma fila JSONB de configuración por host para compartir el bloqueo con los ajustes y las acciones.
- La evidencia de identidad se actualiza en cada presencia confirmada, no en cada lectura de una caché repetida.
- La caducidad usa el cierre existente y un `closedBy` nuevo (`reconciliation`) en lugar de una transición paralela.
- El body de Ajustes no puede transportar `watch`; la proyección pública tampoco lo devuelve.
- Las operaciones de contenedor se cierran con una sola función compartida para que la API y el colector no dupliquen eventos ni resultados.
- El nombre de una entrada ya renombrada se resuelve por el ID confirmado, no por el nombre de la muestra que inició la acción.

## Deviations from Plan

### Ajustes de proceso

- **Cinco commits en lugar de tres:** los tres commits de tarea son atómicos; `88dc19f` es una prueba adicional del corte por fallo de transporte y `cdb376a` corrige dos hallazgos surgidos al validar las aceptaciones (ventana de fallo tras ausencia y resolución por ID). No se modificó ningún fichero fuera de `files_modified`.
- **Reparto del código de reasignación:** el planner y la transición del store se incluyeron en el commit 1 para que el tracer tuviera el modelo durable completo; el commit 2 los valida y añade la reanudación sin ventana nueva.
- **`tests/api-lifecycle.test.ts` sin cambios:** las carreras y la promoción de operaciones se cubren en `tests/api-incidents.test.ts`, que ejercita la ruta HTTP real, el colector y el agente simulado. El fichero de ciclo de vida sigue ejecutándose y pasa con el nuevo cierre compartido.
- **Playwright no ejecutado:** se actualizó `tests/e2e/maintenance.spec.ts` con la fila pendiente y la ausencia de acciones, según la instrucción del orquestador; la ejecución queda para la verificación de fin de fase.
- **`STATE.md` y `ROADMAP.md`:** no se tocaron; el orquestador es su único escritor.

**Total deviations:** 0 auto-fixed de código fuera de las correcciones del commit 5 y 5 ajustes de proceso.
**Impact on plan:** ninguno sobre el alcance. Las tres tareas y sus criterios de aceptación están cubiertos; las dos correcciones del commit 5 eran necesarias para D-05/D-07.

## Threat Model Evidence

- **T-03-04 (Tampering, evidencia y asignación):** solo una marca de inventario nueva, válida y completa acredita ausencia o reasignación. Se cubren marca repetida, marca anterior, agente anterior, lista vacía completa, fallo de contrato, fallo de transporte, reinicio del worker, ID bajo otro nombre, Compose escalado, dos orígenes al mismo destino y dos hosts.
- **T-03-05 (Tampering, mutación concurrente):** `mutateSettings` inserta la fila si falta y la bloquea; las transiciones del store comparten la transacción. La revisión se toma antes de pedir métricas. Se cubren edición simultánea de umbral, lectura anterior a una parada, respuesta perdida de start/stop, inventario cacheado anterior, confirmación repetida y aislamiento por host.
- **T-03-SC (Tampering, dependencias):** no se añadieron dependencias ni se modificó `pnpm-lock.yaml`; se usaron Vitest, Drizzle, PostgreSQL 18 local y Playwright ya instalados.

## Evidence · PostgreSQL 18 and Vitest

| Command | Result |
|---|---|
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-incidents.test.ts` (Task 1) | 2 files, 55 tests passed |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts` (Task 2) | 3 files, 62 tests passed |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-incidents.test.ts tests/api-lifecycle.test.ts` (Task 3) | 3 files, 66 tests passed |
| `pnpm typecheck` | exit 0 |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 41 files, 456 tests passed |
| ESLint sobre los 14 ficheros del plan | exit 0 |
| `pnpm test:e2e tests/e2e/maintenance.spec.ts` | No ejecutado por instrucción del orquestador |

Las suites de PostgreSQL se ejecutaron contra `postgresql://hub:hub@127.0.0.1:55432/hub` con `HUB_REQUIRE_TEST_DB=1`; no hubo omisiones por falta de base. El agente HTTP simulado sirvió métricas con marca Docker, listas vacías, respuestas inválidas y fallos de transporte.

## Issues Encountered

- El entorno no exportaba `DATABASE_URL`; los comandos se ejecutaron con la variable en línea sobre PostgreSQL 18 de loopback.
- La identidad del worker se movió de una constante de módulo a `globalThis`: recargar el módulo en las pruebas no debe simular un reinicio, mientras que un proceso nuevo sí cambia el identificador. El reinicio se prueba sembrando un `workerId` distinto.

## User Setup Required

None - no external service configuration required. No hay migración nueva ni variables de entorno adicionales.

## Next Phase Readiness

- 03-03 puede reutilizar `mutateSettings` para cualquier estado durable por host y `finalizeContainerOperation` para cerrar operaciones de contenedor sin duplicar eventos.
- La limpieza de ayudantes debe registrar su propia clave estable por host y no reutilizar `container:` para evitar la reconciliación de inventario.
- La revisión de fin de fase debe ejecutar `pnpm test:e2e tests/e2e/maintenance.spec.ts` y revisar visualmente el panel pendiente y el bloque de Avisos.
- No hay bloqueos conocidos para 03-03.

## Self-Check: PASSED

- `src/lib/container-watch.ts`, `src/lib/settings.ts`, `src/lib/incident-store.ts`, `src/lib/lifecycle.ts` y las suites modificadas existen.
- `fcc7af6`, `57e8cc4`, `6ee758c`, `88dc19f` y `cdb376a` son ancestros de `HEAD`.
- PostgreSQL 18 ejecutó 41 suites y 456 tests sin omisiones de base de datos.
- `pnpm typecheck` y el lint de los ficheros del plan terminaron con exit 0.

---
*Phase: 03-agrupaci-n-inventario-y-ayudantes*
*Completed: 2026-11-25*
