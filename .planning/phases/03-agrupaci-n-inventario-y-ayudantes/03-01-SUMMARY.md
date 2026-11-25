---
phase: 03-agrupaci-n-inventario-y-ayudantes
plan: "01"
subsystem: incidents
tags:
  - incidents
  - services-down
  - inventory
  - docker
  - postgresql
  - telegram

requires:
  - phase: 02-incidencias-y-entrega-nica
    provides: "Episodios, outbox transaccional, proyección pública y enlace autenticado"

provides:
  - "Incidencia services-down por host con contexto de inventario fechado y acotado"
  - "Metrics.containersObservedAt y distinción entre lectura nueva, caché repetida y agente anterior"
  - "Bloqueo de observación inhibido, idempotente y aislado por host"
  - "Recuperación con evidencia fresca, reanudación del mismo episodio y ventana nueva de 30 s"
  - "Detalle autenticado con inventario y episodios inhibidos aunque queden fuera del listado limitado"

affects: [03-02, 03-03, 04]

actuals:
  tokens: 27590
  tasks: 3
  commits: 3
  plan_head_before: b7dfffa0592d3f05fdbbfbaa4c34ffbaf183d538
  plan_head_after: 306d2cd62a956c9d79b6260f8958bfecf80b531c

tech-stack:
  added: []
  patterns:
    - "El estado de observación se persiste separado de la entrega: inhibitedBy, inhibitedReason y observationPending"
    - "La evidencia Docker se fecha con containersObservedAt; una copia repetida de la misma lectura no cuenta como observación nueva"
    - "La transición del grupo y el bloqueo de contenedores comparten una única transacción del store"
    - "La proyección autenticada adjunta los episodios inhibidos del grupo sin ampliar el listado limitado"

key-files:
  created:
    - drizzle/0005_incident_context.sql
    - drizzle/meta/0005_snapshot.json
  modified:
    - agent/server.py
    - drizzle/meta/_journal.json
    - src/lib/schema.ts
    - src/lib/types.ts
    - src/lib/agent-snapshots.ts
    - src/lib/collector.ts
    - src/lib/incident-store.ts
    - src/components/views/alerts.tsx
    - tests/migrations.test.ts
    - tests/collector-alerts.test.ts
    - tests/api-incidents.test.ts

key-decisions:
  - "La clave durable auditada `connection` sigue identificando el episodio; `kind: services-down` es una proyección pública con el mismo ID y enlace"
  - "`incidents.context` es JSONB nullable para que el binario anterior siga escribiendo y leyendo durante el despliegue"
  - "El bloqueo de observación usa columnas propias (`inhibitedBy`, `inhibitedReason`, `observationPending`) y nunca toca el estado de entrega"
  - "Un grupo nuevo captura el último inventario almacenado antes de la apertura; nunca inspecciona Docker durante la caída"
  - "La frescura se mide con `containersObservedAt` contra la apertura del grupo; para agentes anteriores se espera un intervalo de caché de 10 s tras la recuperación"
  - "Una lectura repetida del mismo `containersObservedAt` no reinicia ni hace avanzar ninguna ventana de 30 s"
  - "Un contenedor ausente durante la recuperación mantiene la inhibición y queda pendiente para la reconciliación de 03-02"

patterns-established:
  - "Datos de entrega y datos de observación son superficies distintas; el proveedor solo recibe título, detalle estático, host, severidad y enlace"
  - "Selección por hostId y clave, con bloqueo de la fila del grupo antes de las filas de contenedor ordenadas por id"
  - "Atributos data-* para que Playwright y Vitest afirmen estado sin acoplarse al copy"

requirements-completed: [INCD-09]

coverage:
  - id: D1
    description: "Una caída confirmada abre un solo grupo services-down por host con el último inventario almacenado, su fecha y su origen"
    requirement: INCD-09
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#groups a sustained outage into one services-down episode with a dated inventory"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#labels an older agent inventory with the sample date and keeps unknown state explicit"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#projects the outage group with its inventory and inhibited episodes beyond the recent list"
        status: pass
    human_judgment: false
  - id: D2
    description: "El aviso inicial identifica el host y enlaza al episodio autenticado sin serializar el inventario ni los nombres de contenedores"
    requirement: INCD-09
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#delivers the outage notice with the host and link but never the inventory"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#delivers one opening with the configured chat and episode button"
        status: pass
    human_judgment: false
  - id: D3
    description: "La migración 0005 es aditiva y conserva IDs, fingerprints, historial y destinos de una apertura confirmada y otra pendiente"
    requirement: INCD-09
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#adds the context and observation columns without rewriting history or delivery"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#keeps SQL, snapshot and journal aligned"
        status: pass
    human_judgment: false
  - id: D4
    description: "Las incidencias abiertas de contenedor quedan inhibidas con motivo, conservan su entrega y no repiten la transición tras reiniciar el colector"
    requirement: INCD-09
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#inhibits open container episodes during the outage and keeps their delivery"
        status: pass
    human_judgment: false
  - id: D5
    description: "La primera lectura fresca tras la caída cierra el grupo, reanuda el episodio detenido, cierra el que ya marcha y deja pendiente el ausente; un fallo nuevo espera 30 s"
    requirement: INCD-09
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#confirms previous episodes only with post-outage evidence and windows new failures"
        status: pass
      - kind: unit
        ref: "python3 -m unittest discover -s agent -p test_metrics.py"
        status: pass
    human_judgment: false
  - id: D6
    description: "El detalle de Avisos muestra inventario fechado, estado sin verificar y episodios inhibidos con atributos observables"
    verification: []
    human_judgment: true
    rationale: "La comprobación visual del detalle y de los selectores en el navegador corresponde a la revisión manual de fin de fase; el E2E de fin de fase no se ejecutó en este plan por instrucción del orquestador."

duration: 21min
completed: 2026-11-25
status: complete
---

# Phase 03 Plan 01: Caída agrupada, inventario previo y bloqueo de observación

**Una caída confirmada abre un solo episodio `services-down` por host con el último inventario almacenado y fechado, inhibe los episodios de contenedor abiertos y solo los confirma con una lectura Docker posterior a la recuperación.**

## Performance

- **Duration:** 21 min
- **Started:** 2026-11-25T14:16:16Z (aproximado, inicio de la ejecución)
- **Completed:** 2026-11-25T14:37:02Z (aproximado, última verificación)
- **Tasks:** 3
- **Files modified:** 13 (2 creados, 11 modificados)

## Accomplishments

- La clave auditable `connection` conserva el episodio y su entrega, pero la proyección pública lo expone como `kind: services-down` con el mismo ID y el enlace `incidentHref`.
- `incidents.context` guarda el último inventario válido del host con `observedAt`, `observedFrom` (`inventory` o `sample`), `complete`, entradas acotadas a 50 y `omitted`. Un host sin muestra declara estado desconocido; una lista vacía acreditada sigue siendo evidencia completa.
- El agente publica `containersObservedAt` desde la fecha real de su caché Docker. Un `/metrics` con la misma caché conserva la marca; una consulta nueva la actualiza. El contrato Zod la acepta opcional para agentes anteriores.
- Al confirmarse la caída (60 s), el store abre o reutiliza el grupo y, en la misma transacción, marca las incidencias abiertas `container:` del host con `inhibitedBy`, `inhibitedReason = host-unreachable` y `observationPending = true`, con un único evento `inhibited` por cambio real.
- En la primera lectura válida posterior, el grupo se cierra con la transición de fase 2 (sin mensaje de recuperación). Cada episodio previo se resuelve por separado: en marcha se cierra; detenido reanuda el mismo ID; ausente queda pendiente para 03-02.
- Un fallo nuevo de un contenedor que estaba sano solo abre tras una ventana nueva de 30 s y con observaciones Docker distintas. El tiempo previo, el tiempo caído y las copias repetidas de una lectura quedan fuera.
- Avisos añade el bloque de inventario fechado, la condición sin verificar y la lista de episodios inhibidos, con atributos `data-*` para pruebas de comportamiento.

## Interfaces entregadas para 03-02

### 1. `Metrics.containersObservedAt`

```ts
// src/lib/types.ts
export type Metrics = {
  timestamp: number;
  /** Docker list date (Unix seconds); absent on agents before the field existed. */
  containersObservedAt?: number;
  // ...
};
```

- `agent/server.py` solo lo incluye cuando `container_cache[0] > 0`; la marca es la fecha de la lista Docker, no la de la muestra.
- `metricsSnapshotSchema.containersObservedAt` es `epoch.optional()` (positivo y finito). Ausente = agente anterior, nunca “lista vacía”.
- La marca no cambia mientras la caché de 10 s se reutiliza; un fallo de Docker conserva el tratamiento 503 existente y no fecha la lista como nueva.

### 2. Contexto estructurado de incidente

```ts
// src/lib/types.ts
export type IncidentInventoryContext = {
  kind: "services-down";
  observedAt: number | null;          // segundos de época
  observedFrom: "inventory" | "sample" | "unknown";
  complete: boolean;                  // false = sin evidencia; no lista vacía
  entries: { name: string; state: string }[]; // máximo 50
  omitted: number;                    // entradas restantes no visibles
};
```

- Persistido en `incidents.context` (JSONB nullable).
- `captureServiceInventory(hostId, before)` lee la última muestra almacenada `at <= before`; nunca consulta el agente.
- `inventoryContextFromSample(sample)` es la función pura reutilizable para clasificar la muestra y acotar la lista.
- `INCIDENT_INVENTORY_LIMIT = 50`; el detalle expone `omitted` para el recuento restante.
- Los episodios históricos con `context = null` se proyectan con el último dato anterior a su apertura si sigue dentro de retención, sin reescribir la fila.

### 3. Bloqueo de observación

```ts
// incidents
context: jsonb | null
inhibitedBy: integer | null       // id del episodio services-down
inhibitedReason: text | null      // "host-unreachable" (HOST_UNREACHABLE_REASON)
observationPending: boolean       // default false

// recordIncidentObservation
clearObservation?: boolean;
inhibitContainers?: { reason: string };
```

- `recordIncidentObservation` sigue siendo la única transición de episodio: abre, observa, escala, reanuda con `clearObservation` o cierra. El outbox se escribe en la misma transacción.
- `inhibitContainers` bloquea las filas `container:` abiertas del host en la misma transacción del grupo. Es idempotente: si el grupo y el motivo ya están puestos, no incrementa `seq` ni inserta otro evento.
- `clearObservation` retira el bloqueo conservando ID, fingerprint y resultado de entrega. Si el contenedor sigue detenido, inserta un evento `resumed` y conserva el episodio; si marcha, se usa el cierre de fase 2.
- `IncidentObservationResult.inhibitedIncidentIds` enumera los episodios bloqueados en esa transacción.
- `projectIncidents(rows)` adjunta `inhibited: Alert[]` al grupo `connection`, incluidos los episodios fuera del listado de 100.

### 4. Reglas de evidencia reutilizables por 03-02

- `incidentKind(key)` clasifica `connection` → `services-down`, `container:` → `container`, resto → `condition`.
- Una lectura es posterior a la caída si `containersObservedAt * 1000 >= group.at` (agente nuevo) o si `now >= group.resolvedAt + 10_000` (agente anterior).
- Una marca `<=` la última evaluada es una copia repetida y no cuenta como observación nueva.
- La ausencia de un contenedor durante la recuperación **no** abre nada: conserva `inhibitedBy` y `observationPending = true` para la reconciliación destructiva de 03-02.
- Las operaciones de 03-02 que exijan inventario completo y fresco deben usar la misma marca explícita (`containersObservedAt`) y no aceptar una caché anterior ni repetida.

### 5. Proyección pública de `Alert`

Se añaden `kind`, `inventory`, `inhibitedBy`, `inhibitedReason`, `observationPending` e `inhibited`. La proyección sigue sin publicar `chatId`, `messageId`, endpoints, tokens ni cuerpos del proveedor.

## Task Commits

Cada tarea se confirmó de forma atómica:

1. **Task 1: Abrir una incidencia agrupada y visitarla desde la notificación** — `5ddbdea` (feat)
2. **Task 2: Mantener los episodios previos inhibidos mientras falta evidencia** — `2155355` (feat)
3. **Task 3: Recuperar con evidencia válida y separar fallos anteriores de fallos nuevos** — `306d2cd` (fix)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: la migración y las columnas de observación son compartidas por las tres tareas; el commit 1 incluye el plumbing común del store/colector, el commit 2 añade la vista y la prueba de inhibición y el commit 3 añade el reinicio de la marca Docker y la prueba mixta de recuperación. Los tres commits compilan y pasan sus comandos de verificación._

## Files Created/Modified

- `drizzle/0005_incident_context.sql` — DDL aditiva: `context`, `inhibitedBy`, `inhibitedReason`, `observationPending`, índice `incidents_inhibited_idx`.
- `drizzle/meta/0005_snapshot.json` y `drizzle/meta/_journal.json` — snapshot y journal de la migración generados con el Kit instalado.
- `src/lib/schema.ts` — columnas nuevas y tipo JSONB de contexto.
- `src/lib/types.ts` — `Metrics.containersObservedAt`, `IncidentInventoryContext`, `IncidentKind` y campos públicos de `Alert`.
- `src/lib/agent-snapshots.ts` — validación opcional de `containersObservedAt`.
- `src/lib/incident-store.ts` — captura de inventario, transición de inhibición, `clearObservation`, `inhibitedIncidentIds` y proyección con episodios inhibidos.
- `src/lib/collector.ts` — grupo por `connection`, corte de ventanas al primer fallo de transporte, inhibición en la transacción del grupo y confirmación con evidencia fresca.
- `src/components/views/alerts.tsx` — inventario fechado, estado sin verificar y episodios inhibidos con selectores `data-*`.
- `agent/server.py` — `containersObservedAt` desde la fecha real de la caché Docker.
- `tests/migrations.test.ts` — migración 0004 → 0005, continuidad de entrega, compatibilidad del binario anterior y journal actualizado.
- `tests/collector-alerts.test.ts` — grupo, inventario, agente anterior, inhibición idempotente, recuperación mixta y payload real del dispatcher.
- `tests/api-incidents.test.ts` — proyección autenticada, inventario, episodios inhibidos fuera de los 100 recientes, 401 y aislamiento por host.

## Decisions Made

- El tipo público `services-down` es una proyección; la clave durable `connection` no cambia para no romper el fingerprint, la política auditada ni el outbox.
- El contexto es nullable y no se actualiza en episodios existentes: la evidencia capturada al abrir sobrevive a una recuperación.
- La inhibición es un estado de observación, no de entrega. El outbox y el resultado original quedan intactos.
- Un nombre ausente no se interpreta como fallo nuevo ni abre un aviso: queda pendiente para 03-02.
- Para agentes anteriores se mantiene la ruta ordinaria de métricas con una espera de un intervalo de caché (10 s) después de la recuperación.
- La lista visible se acota a 50 entradas y el resto se publica como `omitted`, evitando un detalle ilimitado.

## Deviations from Plan

### Ajustes de proceso

- **Tareas 2 y 3 con `tdd="true"`:** el encargo exige un commit atómico por tarea, así que no hay commits RED separados. Los casos de comportamiento se ejecutaron contra la implementación y son la puerta de cada tarea.
- **Reparto de commits:** el commit 1 contiene el plumbing común de store/colector que las tres tareas comparten (migración, contexto, proyección y transición). El commit 2 añade la vista y la prueba de inhibición; el commit 3 añade el reinicio de la marca Docker y la prueba mixta de recuperación. No se modificó ningún fichero fuera de `files_modified`.
- **E2E de fin de fase:** no se ejecutó `pnpm test:e2e tests/e2e/incidents.spec.ts` porque el orquestador indicó que la verificación E2E de fin de fase no corresponde a este plan. La comprobación visual del detalle queda para esa revisión.
- **`STATE.md` y `ROADMAP.md`:** no se tocaron; el orquestador es su único escritor. La modificación preexistente de `.planning/STATE.md` quedó fuera de los commits.

**Total deviations:** 0 auto-fixed de código y 4 ajustes de proceso.
**Impact on plan:** ninguno sobre el alcance; los tres comandos de tarea y las suites completas de Vitest pasan.

## Evidence · PostgreSQL 18, Vitest and agent probe

| Command | Result |
|---|---|
| `python3 -m unittest discover -s agent -p test_metrics.py` | 1 test passed |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/collector-alerts.test.ts tests/api-incidents.test.ts tests/notification-dispatch.test.ts tests/agent-client.test.ts` (Task 1) | 5 files, 64 tests passed |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts` (Task 2) | 3 files, 42 tests passed |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/notification-dispatch.test.ts` (Task 3) | 3 files, 52 tests passed |
| `pnpm typecheck` | exit 0 |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 41 files, 436 tests passed |
| `pnpm test:agent` | 182 tests, 1 error preexistente en `test_env_settings.py` (`.env.lock`); no relacionado con este plan |
| Sonda local `containersObservedAt` con reloj y Docker simulados | marca 1000 conservada en lectura cacheada; 1015 en la consulta nueva |
| Lint de los ficheros del plan | exit 0 |

La suite de migración ejecuta el migrador real sobre PostgreSQL 18 desechable: siembra una conexión abierta con apertura confirmada y destino, otra con entrega pendiente y un episodio cerrado; aplica 0005 y comprueba IDs, `resolvedAt`, fingerprints, `seq`, `origin` y el outbox intactos. También inserta con la forma antigua (sin columnas nuevas) para acreditar la compatibilidad del binario anterior. El recorrido del colector usa dos agentes HTTP simulados y el dispatcher real con transporte de Telegram simulado.

## Threat Model Evidence

- **T-03-01 (Tampering):** las transiciones usan `hostId` y la clave exacta; la inhibición bloquea el grupo y luego las filas `container:` ordenadas por id. Los tests cubren dos hosts con el mismo nombre de contenedor, respuesta de contrato inválida, muestras repetidas y reinicio del colector.
- **T-03-02 (Information Disclosure):** el detalle exige sesión, host explícito e id; el inventario y los nombres solo viajan en la proyección autenticada. El test del dispatcher comprueba que el texto de Telegram contiene host y severidad, pero no el inventario. Los tests de API comprueban 401 sin sesión y 404 con otro host, y que no se publican `chatId`/`messageId`.
- **T-03-03 (Tampering):** 0005 es aditiva y nullable; no reescribe filas ni outbox. El test de migración conserva aperturas confirmadas y pendientes, IDs, fingerprints y destinos, y el binario anterior sigue insertando.
- **T-03-SC (Tampering):** no se añadieron dependencias ni se tocó el lockfile; se usaron Drizzle Kit, Vitest, Playwright y `unittest` ya instalados.

## Issues Encountered

- `pnpm test:agent` completo falla en `agent/test_env_settings.py::test_serializes_concurrent_writes_without_losing_updated_bytes` con `FileNotFoundError: [Errno 2] No such file or directory: '.env.lock'`. El fallo también aparece al ejecutar ese fichero aislado y no toca ficheros de este plan; la suite focalizada `test_metrics.py` pasa. Se deja como defecto preexistente fuera de alcance.
- El colector conserva estado en memoria (ventanas de 30 s y última marca Docker). Los tests usan reloj inyectado y, cuando hace falta, reinician el módulo para acreditar que las transiciones durables no dependen de ese estado.

## User Setup Required

No hay variables de entorno ni credenciales nuevas. Para desplegar:

1. Aplicar `pnpm db:migrate` (0005). Es aditiva y compatible con el binario anterior; puede ejecutarse con la app y el worker antiguos en marcha.
2. Desplegar el agente actualizado para que emita `containersObservedAt`. Un agente anterior sigue funcionando: el hub espera un intervalo de caché de 10 s tras la recuperación antes de usar su inventario como evidencia.
3. Reiniciar el worker para activar la nueva lógica del colector.
4. La comprobación física de Telegram y del detalle en Avisos queda para la revisión manual de fin de fase.

## Next Phase Readiness

- 03-02 puede reutilizar `recordIncidentObservation` con `clearObservation` para retirar el bloqueo, `captureServiceInventory`/`inventoryContextFromSample` para clasificar el inventario y `containersObservedAt` para exigir frescura explícita.
- El bloqueo de un contenedor ausente se conserva con `inhibitedBy` y `observationPending = true`; 03-02 debe decidir la reconciliación y la purga sin abrir un aviso por la mera ausencia.
- Los episodios inhibidos se proyectan dentro del grupo `services-down` aunque queden fuera de los 100 recientes, incluido su estado de entrega original.
- Pendiente para la fase: revisión visual del detalle en Avisos y el E2E de fin de fase.

## Self-Check: PASSED

- `drizzle/0005_incident_context.sql`, `drizzle/meta/0005_snapshot.json`, `src/lib/incident-store.ts`, `src/lib/collector.ts`, `src/components/views/alerts.tsx`, `tests/migrations.test.ts`, `tests/collector-alerts.test.ts` y `tests/api-incidents.test.ts` existen.
- `5ddbdea`, `2155355` y `306d2cd` son ancestros de `HEAD`.
- PostgreSQL 18 ejecutó las 41 suites (436 tests) sin omisiones de base de datos.
- `pnpm typecheck`, el lint de los ficheros del plan y la sonda de `containersObservedAt` terminaron con exit 0.

---

*Phase: 03-agrupaci-n-inventario-y-ayudantes*
*Completed: 2026-11-25*
