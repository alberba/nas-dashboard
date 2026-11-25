---
phase: 03-agrupaci-n-inventario-y-ayudantes
verified: 2026-11-25T15:11:14Z
status: gaps_found
score: 13/21 must-haves verified
covered_files: [
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-01-PLAN.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-01-SUMMARY.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-02-PLAN.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-02-SUMMARY.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-03-PLAN.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-03-SUMMARY.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-CONTEXT.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-PATTERNS.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-REVIEW-DISPOSITION.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-REVIEW-FIX.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-REVIEW.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-SECURITY.md",
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-VALIDATION.md",
    "agent/Dockerfile",
    "agent/helper_cleanup.py",
    "agent/maintenance.py",
    "agent/server.py",
    "agent/test_host_commands.py",
    "agent/test_maintenance.py",
    "agent/test_metrics.py",
    "drizzle/0005_incident_context.sql",
    "drizzle/meta/0005_snapshot.json",
    "drizzle/meta/_journal.json",
    "src/app/api/[...path]/route.ts",
    "src/components/dashboard.tsx",
    "src/components/views/alerts.tsx",
    "src/components/views/maintenance-status.tsx",
    "src/components/views/maintenance.tsx",
    "src/lib/agent-snapshots.ts",
    "src/lib/collector.ts",
    "src/lib/container-watch.ts",
    "src/lib/incident-store.ts",
    "src/lib/lifecycle.ts",
    "src/lib/maintenance-alerts.ts",
    "src/lib/maintenance.ts",
    "src/lib/notification-dispatch.ts",
    "src/lib/notification-policy.ts",
    "src/lib/schema.ts",
    "src/lib/settings.ts",
    "src/lib/types.ts",
    "src/lib/validation.ts",
    "tests/api-incidents.test.ts",
    "tests/api-lifecycle.test.ts",
    "tests/api-maintenance.test.ts",
    "tests/collector-alerts.test.ts",
    "tests/e2e/incidents.spec.ts",
    "tests/e2e/maintenance-status.spec.ts",
    "tests/e2e/maintenance.spec.ts",
    "tests/maintenance-alerts.test.ts",
    "tests/migrations.test.ts",
    "tests/notification-dispatch.test.ts"
  ]
covered_digest: "v4:sha256:36560cecf7a547b40e7acf97b01696292120278d087701e0c0a511b9a901ddc9"
behavior_unverified: 0
overrides_applied: 0
decision_coverage:
  honored: 12
  total: 12
  not_honored: []
gaps:
  - truth: "D-04 y criterio 2. La inhibición por caída se conserva hasta una observación posterior válida."
    status: failed
    reason: "La reconciliación usa la lista antes de aplicar el límite de frescura de la caída y reclasifica una ausencia con datos anteriores al episodio."
    artifacts:
      - path: src/lib/collector.ts
        issue: "reconcileContainers se ejecuta antes de connectionGroupIsFresh."
      - path: src/lib/incident-store.ts
        issue: "markContainerObservationPendingIn borra inhibitedBy al registrar la ausencia."
    missing:
      - "Aplicar el límite de frescura de la caída a la reconciliación, incluidas ausencia, transferencia y cierre. Cubrir un nombre ausente en la primera respuesta con caché anterior a la caída."
  - truth: "D-05 y D-06. La gracia se agota solo tras 30 minutos acreditados por inventarios completos consecutivos."
    status: failed
    reason: "Una respuesta válida sin containersObservedAt deja abierta la cadena. El siguiente inventario fechado acredita también el intervalo no observado."
    artifacts:
      - path: src/lib/container-watch.ts
        issue: "El retorno temprano ante una marca ausente conserva chainAt y workerId."
    missing:
      - "Romper la continuidad ante un inventario sin marca conservando lo acreditado. Probar la secuencia fechado, sin marca, fechado, sin fallo de transporte intermedio."
  - truth: "D-09, D-12 y criterio 4. Los fallos se conservan y el cierre exige acreditar la ausencia de cada ayudante pendiente."
    status: failed
    reason: "El barrido lee los IDs pendientes después de obtener el inventario y acredita ausencias de ayudantes cuyos fallos se registraron después de capturar esa lista."
    artifacts:
      - path: agent/helper_cleanup.py
        issue: "HelperReaper.sweep compara un inventario previo con pending_ids leído posteriormente."
    missing:
      - "Vincular la acreditación de ausencias a los pendientes cubiertos por ese inventario y respetar los cambios concurrentes del registro. Probar el registro de un fallo nuevo mientras se obtiene la lista."
---

# Fase 03 · Verificación de agrupación, inventario y ayudantes

- **Objetivo** — Agrupar una caída de host en una sola incidencia, eliminar las incidencias fantasma de `expectedContainers` y recoger los ayudantes privilegiados huérfanos del agente.
- **Verificado** — 2026-11-25T15:11:14Z
- **Estado** — `gaps_found`
- **Primera verificación** — 13 de 21 criterios y verdades verificados. Las seis prohibiciones se comprobaron aparte.

El ROADMAP marca la fase como MVP y su objetivo está redactado como resultado técnico. El validador de historias de GSD rechazó ese formato. Se verificaron directamente el objetivo y los cuatro criterios solicitados, con los recorridos operativos de Avisos y Mantenimiento.

## Cumplimiento del objetivo

### Criterios del ROADMAP

| # | Resultado observable | Estado | Evidencia |
|---|---|---|---|
| 1 | Una sola incidencia de servicios y una sola apertura por caída del host. | VERIFICADO | El colector escribe `connection` por host y el almacén la proyecta como `services-down`. La prueba de caída sostenida y la del dispatcher comprueban una fila, una apertura y un envío. |
| 2 | Las incidencias de contenedor conservan la inhibición visible durante la caída y se evalúan con evidencia nueva al volver. | FALLIDO | La inhibición y la nueva ventana están probadas en el recorrido normal. La primera respuesta con caché anterior a la caída puede quitar el vínculo y el motivo de inhibición. Sonda A. |
| 3 | Renombrar o recrear un contenedor deja de generar una incidencia permanente por el nombre anterior. | VERIFICADO | Las pruebas de mismo ID, reemplazo Compose, ambigüedad y retirada del nombre vencido comprueban traslado o cierre. La contabilización de gracia tiene el defecto de la sonda B. |
| 4 | La recogida autónoma protege otras cargas y hace visible un fallo de limpieza. | FALLIDO | La recogida y la visibilidad funcionan en secuencia. Con registro concurrente de fallos, el barrido puede borrar la evidencia y publicar `clean` sin eliminar el ayudante. Sonda C. |

### Verdades de los planes

| Plan | Verdad | Estado | Código y prueba |
|---|---|---|---|
| 03-01 | D-01 · Una apertura, Telegram con host y enlace, inventario fechado y miembros inhibidos en Avisos. | VERIFICADO | [collector.ts](../../../src/lib/collector.ts#L414), [incident-store.ts](../../../src/lib/incident-store.ts#L969), [alerts.tsx](../../../src/components/views/alerts.tsx#L79). Pruebas de caída, envío real con transporte inyectado y detalle autenticado. [Colector](../../../tests/collector-alerts.test.ts#L1904), [envío](../../../tests/collector-alerts.test.ts#L2377), [API](../../../tests/api-incidents.test.ts#L663). |
| 03-01 | D-02 · Los episodios abiertos siguen visibles, con motivo y estado sin verificar. La entrega se conserva. | VERIFICADO | El almacén cambia el bloqueo de observación y añade el evento en la misma transacción del grupo. Avisos lee `inhibitedReason` y `observationPending`. [Almacén](../../../src/lib/incident-store.ts#L349), [vista](../../../src/components/views/alerts.tsx#L125), [prueba de inhibición y entrega](../../../tests/collector-alerts.test.ts#L2034). |
| 03-01 | D-03 · Un fallo nuevo empieza una ventana de 30 s tras la caída. | VERIFICADO | El fallo de transporte borra el temporizador por host. El colector descarta marcas repetidas y evalúa los fallos nuevos con umbral de 30 s. La prueba comprueba ausencia de apertura al repetir la caché y a los 10 s, y apertura silenciosa a los 30 s. [Colector](../../../src/lib/collector.ts#L243), [prueba](../../../tests/collector-alerts.test.ts#L2190). |
| 03-01 | D-04 · La primera observación válida reanuda o cierra el mismo episodio y una ausencia queda pendiente. | FALLIDO | En el recorrido normal se preserva el episodio detenido y se cierra el que vuelve a correr. Para el ausente, `reconcileContainers` puede retirar la inhibición antes de verificar la frescura. Sonda A. |
| 03-01 | Una conexión anterior conserva ID, fingerprint, estado y destino. Se proyecta como grupo. | VERIFICADO | Migración 0005 aditiva preserva filas y outbox. En una sonda independiente, una fila histórica sin contexto con entrega ya enviada conservó la fila completa y el único trabajo de salida, y se proyectó como `services-down`. [Migración](../../../drizzle/0005_incident_context.sql), [prueba de migración](../../../tests/migrations.test.ts#L380), [proyección](../../../src/lib/incident-store.ts#L910). |
| 03-01 | Error de contrato corta la ventana, gracia de reinicio planificado y aislamiento por host. | VERIFICADO | [Ruta de error y gracia](../../../src/lib/collector.ts#L380), [prueba de dos hosts](../../../tests/collector-alerts.test.ts#L441), [contrato y reinicio](../../../tests/collector-alerts.test.ts#L645), [reinicio de ventanas](../../../tests/collector-alerts.test.ts#L1870). |
| 03-02 | D-05 · Gracia de 30 minutos de inventario válido, reaparición y umbral de contenedor detenido. | FALLIDO | Reaparición y nuevo umbral probados. El tiempo posterior al inventario sin marca puede abonarse desde la última marca anterior. [Reconciliación](../../../src/lib/container-watch.ts#L268), [reaparición](../../../tests/collector-alerts.test.ts#L1033), [umbral](../../../tests/collector-alerts.test.ts#L1138), sonda B. |
| 03-02 | D-06 · Ausencia pendiente visible, sin incidencia nueva, seguida de retirada y cierre al vencer la gracia. | FALLIDO | La proyección y el cierre con historial están probados. El defecto del reloj de gracia puede hacer vencer antes el plazo, y una ausencia obsoleta puede aparecer como pendiente. [Overview](../../../src/app/api/%5B...path%5D/route.ts#L394), [vista](../../../src/components/views/maintenance.tsx#L188), [API](../../../tests/api-incidents.test.ts#L790), [retirada](../../../tests/collector-alerts.test.ts#L960), sondas A y B. |
| 03-02 | D-07 · Traslado dentro del host por ID o pareja Compose única. La ambigüedad sigue pendiente. | VERIFICADO | El ID tiene prioridad, un nombre ya vigilado queda excluido y dos orígenes que reclaman un destino impiden el traslado. [Selección](../../../src/lib/container-watch.ts#L147), [ID](../../../tests/collector-alerts.test.ts#L1267), [Compose y ambigüedad](../../../tests/collector-alerts.test.ts#L1417). |
| 03-02 | D-08 · Un reemplazo mantiene identidad, historial y entrega del episodio. Su estado determina si cierra. | VERIFICADO | [Traslado transaccional](../../../src/lib/incident-store.ts#L477), [reserva al llegar al umbral](../../../tests/collector-alerts.test.ts#L1233), [reemplazo detenido](../../../tests/collector-alerts.test.ts#L1345), [continuidad del enlace](../../../tests/api-incidents.test.ts#L869). |
| 03-02 | Una lista vacía fechada cuenta. La ausencia de evidencia, un fallo de transporte o un reinicio de worker excluyen el intervalo. | FALLIDO | El control admite una lista vacía y distingue marca repetida, fallo y worker distinto. La muestra sin marca deja un intervalo acreditable en la lectura siguiente. [Prueba existente](../../../tests/collector-alerts.test.ts#L857), sonda B. |
| 03-02 | Una parada o eliminación confirmada gana frente a la lectura anterior. Los ajustes preservan la vigilancia por host. | VERIFICADO | API, colector y finalizador usan revisión y bloqueo por host. [Ajustes](../../../src/lib/settings.ts), [finalización](../../../src/lib/lifecycle.ts), [cambio concurrente](../../../tests/api-incidents.test.ts#L1004), [carrera de parada](../../../tests/api-incidents.test.ts#L1065), [borrado aislado](../../../tests/api-lifecycle.test.ts#L366). |
| 03-03 | D-09 · El primer fallo aparece en Mantenimiento y la persistencia produce un único episodio por host. | FALLIDO | Registro, API y vista exponen el fallo en secuencia. La sonda C demuestra que un fallo nuevo puede desaparecer del registro antes de publicarse. [Registro](../../../agent/helper_cleanup.py#L244), [snapshot](../../../agent/maintenance.py#L813), [vista](../../../src/components/views/maintenance-status.tsx#L255), [prueba agente](../../../agent/test_maintenance.py#L952), [API](../../../tests/api-maintenance.test.ts#L298). |
| 03-03 | D-10 · Dos DELETE fallidos reales por ayudante. Una lista fallida, la caché o dos IDs distintos no suman. | VERIFICADO | El contador es por ID y el umbral se calcula a partir de intentos de DELETE. [Registro](../../../agent/helper_cleanup.py#L244), [fallos dispersos](../../../agent/test_maintenance.py#L1022), [fallo de inventario](../../../agent/test_maintenance.py#L1205), [duplicado de lectura](../../../tests/collector-alerts.test.ts#L2619). |
| 03-03 | D-11 · Incidencia elegible para resumen y pendiente de resumen incluso con `PUSH_WARNINGS`. | VERIFICADO | La política devuelve `digest`, `digest_pending` e `immediate: false`. [Política](../../../src/lib/notification-policy.ts#L83), [prueba de outbox](../../../tests/collector-alerts.test.ts#L2483), [prueba de PUSH_WARNINGS](../../../tests/maintenance-alerts.test.ts#L740). |
| 03-03 | D-12 · Cierre tras eliminar o acreditar la ausencia de todos los IDs pendientes. Un agente anterior o inventario incompleto conserva el episodio. | FALLIDO | El hub conserva el episodio ante secciones ausentes o incompletas. Puede recibir un `clean` indebido de un barrido concurrente y cerrarlo. [Señal](../../../src/lib/maintenance-alerts.ts#L158), [pruebas del cierre y agente anterior](../../../tests/collector-alerts.test.ts#L2528), sonda C. |
| 03-03 | Barrido automático acotado de ayudantes propios y parados. Protege cargas activas, ajenas y volúmenes. | VERIFICADO | El hilo del agente usa el socket existente. El barrido comprueba etiquetas, ID, antigüedad y estado, vuelve a inspeccionar y hace DELETE sin forzar con `v=0`. Los ejecutores registran el ID devuelto por su propio CREATE y liberan en `finally`; si WAIT falla, Docker rechaza el DELETE sin forzar de un contenedor en marcha. [Hilo](../../../agent/server.py#L577), [barrido](../../../agent/helper_cleanup.py#L459), [ejecutores](../../../agent/maintenance.py#L451), [protecciones](../../../agent/test_maintenance.py#L1075), [inspección y límite](../../../agent/test_maintenance.py#L1239). |

### Prohibiciones comprobadas

| Restricción | Evidencia |
|---|---|
| Sin ráfaga por host ni inventario en Telegram. | El colector simula la caída repetida y un único envío. El payload contiene host y enlace, y excluye nombres de inventario. Los avisos de contenedor son silenciosos. [Pruebas](../../../tests/collector-alerts.test.ts#L1904), [payload](../../../tests/collector-alerts.test.ts#L2377). |
| Sin traslado ambiguo ni apertura por ausencia temporal. | Las pruebas comprueban destinos múltiples, dos orígenes para un destino y cero incidencias nuevas con ausencia. [Ambigüedad](../../../tests/collector-alerts.test.ts#L1464), [ausencia](../../../tests/collector-alerts.test.ts#L857). |
| Sin eliminar cargas ajenas, activas ni volúmenes, y sin Telegram ni push por limpieza. | Las pruebas de Docker inspeccionan las llamadas y las exclusiones por identidad y estado. La política y el outbox mantienen `digest`. [Docker](../../../agent/test_maintenance.py#L1075), [política](../../../tests/maintenance-alerts.test.ts#L740). |

### Artefactos, enlaces y flujo de datos

El CLI dio 12/12 entradas de artefactos presentes y sustantivas. Su comprobación textual de enlaces dio 0/12 al buscar las rutas completas descritas por los planes. Se contrastaron los 12 enlaces en sus puntos de ejecución.

| Plan | Enlaces y origen de datos observados |
|---|---|
| 03-01 | `server.metrics` obtiene la marca de la caché Docker y el esquema admite la marca opcional. El colector llama al almacén para `connection` e inhibición. El almacén lee muestras reales e incidencias/outbox por host e ID, y la API autenticada los suministra a Avisos. El dispatcher consume el trabajo de apertura ligado al mismo ID. |
| 03-02 | El colector llama a `reconcileContainers`. Esta llama al almacén dentro de la transacción de `mutateSettings`. La API y el finalizador comparten ese mecanismo. `overview.watchPending` sale de los ajustes durables y Dashboard lo entrega a Mantenimiento. El límite de frescura aparece después del primer enlace y deja el defecto A. |
| 03-03 | Servidor y ejecutores comparten el registro de ayudantes. El snapshot lo incorpora incluso cuando usa caché de Mantenimiento. El cliente valida `helperCleanup`; Mantenimiento lo renderiza y el colector deriva una señal que pasa por la política antes de persistir. La procedencia de `clean` falla en el caso C. |

La comprobación de decisiones de GSD encontró las 12 decisiones de CONTEXT en los artefactos enviados. La presencia de la decisión no cambia el resultado de las sondas. Las suites de integración con PostgreSQL se ejecutaron con `HUB_REQUIRE_TEST_DB=1`; sus guardas de omisión por falta de base no se activaron. Las aserciones relevantes comprueban filas, transiciones, identidad, peticiones enviadas y atributos de estado de interfaz.

## Sondas y regresiones

| Sonda | Reproducción | Resultado |
|---|---|---|
| A · Frescura tras caída | En una copia temporal de `confirms previous episodes only with post-outage evidence and windows new failures`, comprobar `absentId` inmediatamente tras la primera respuesta con la marca anterior al grupo. | Falla. Se esperaban el ID del grupo y `host-unreachable`; PostgreSQL devuelve `inhibitedBy: null` y `container-absent`. [Orden de llamada](../../../src/lib/collector.ts#L451), [actualización](../../../src/lib/incident-store.ts#L430). |
| B · Continuidad sin marca | En una copia temporal de `accredits an absent name only across consecutive fresh complete lists`, inmediatamente tras la muestra sin fecha en el segundo 90, recoger `at(95)` y comprobar que se mantienen 60 000 ms acreditados. | Falla con 95 000 ms. El retorno sin marca no corta `chainAt` y la lectura siguiente suma 35 000 ms. [Reconciliación](../../../src/lib/container-watch.ts#L274). |
| C · Cierre de limpieza concurrente | Con `PYTHONPATH=agent python3`, crear un `HelperRegistry` con un ID pendiente. Inyectar en `HelperReaper` un Docker cuya llamada GET captura una lista vacía y, antes de devolverla, registra dos fallos de DELETE para un segundo ID. Comprobar que el segundo ID sigue pendiente tras `sweep()`. | Falla. El barrido devuelve `{'status': 'clean', 'deleted': 0}` y el registro queda con `pending: 0`, `persistent: 0`, IDs pendientes `[]`. El GET anterior no cubre el segundo ID. [Barrido](../../../agent/helper_cleanup.py#L378). |
| Caché real del agente con Docker inyectado | Llamar tres veces a `server.metrics()` con reloj 1000, 1005 y 1015 y un Docker que devuelve una lista vacía completa. | Pasa. Marcas 1000, 1000 y 1015; dos consultas Docker. [Agente](../../../agent/server.py#L347). |
| Episodio anterior | Con PostgreSQL temporal, sembrar `connection` sin contexto y con apertura Telegram enviada. Recoger dos fallos de transporte y proyectar el episodio. | Pasa. Fila e ID/fingerprint intactos, mismo chat y mensaje, un solo trabajo de salida y proyección `services-down`. |

Las copias temporales se retiraron tras ejecutar las sondas. La fase no declara scripts de sonda versionados.

| Comprobación | Resultado |
|---|---|
| Vitest focalizado con PostgreSQL obligatorio, suites collector-alerts, api-incidents, api-lifecycle, api-maintenance, maintenance-alerts, migrations y notification-dispatch. | Repetido. 7 archivos, 144 pruebas aprobadas. Incluye regresión de fase 02, ensayo de migración y entrega única. |
| `python3 -m unittest discover -s agent -p 'test_maintenance.py'` y suite `test_metrics.py`. | Repetido. 48 y 1 pruebas aprobadas. |
| `python3 -m unittest discover -s scripts/audit -p 'test_*.py'`. | Repetido. 116 aprobadas; regresión de fase 01. |
| Build, tipos, Vitest completo y Playwright. | Evidencia de ejecución aportada. Build y tipos con salida 0, 484/484 en 41 archivos y 21/21 E2E. Se contrastaron los recorridos de [Avisos](../../../tests/e2e/incidents.spec.ts), [vigilancia pendiente](../../../tests/e2e/maintenance.spec.ts#L436) y [estado de limpieza](../../../tests/e2e/maintenance-status.spec.ts#L281). |
| `pnpm test:agent`. | Evidencia aportada. 203 pruebas, con el error preexistente de `.env.lock` en `test_env_settings`. El archivo de implementación no cambió en la fase. |

### Compatibilidad y riesgo residual

- **Agente anterior.** Un episodio de conexión puede mostrar la fecha de la muestra si falta la fecha de inventario. Inicio y parada con respuesta perdida esperan a que tanto la muestra como la recogida superen la caché; el borrado sigue exigiendo inventario posoperación fechado. La omisión de `helperCleanup` no genera cierre. El defecto B afecta al retorno de una muestra sin marca a una con marca. [Pruebas de agente anterior](../../../tests/api-incidents.test.ts#L1389), [limpieza sin sección](../../../tests/collector-alerts.test.ts#L2666).
- **Reinicio con respuesta perdida.** Residual aceptado. El colector excluye `restart` de la confirmación por inventario: observar el mismo contenedor en marcha no prueba que haya cambiado su generación. La operación permanece pendiente y no se confirma falsamente. [Colector](../../../src/lib/collector.ts#L566), [prueba](../../../tests/api-incidents.test.ts#L1229).
- **Ayudantes históricos.** La recogida automática exige etiquetas propias y deja los huérfanos anteriores al despliegue sin etiquetas en Docker. Se conserva el límite de propiedad acordado. [Selección](../../../agent/helper_cleanup.py#L459), [prueba de etiquetas incompletas](../../../agent/test_maintenance.py#L1110).

## Cobertura de requisitos

| Requisito | Plan | Estado | Evidencia decisiva |
|---|---|---|---|
| INCD-09 | 03-01 | Parcial | Agrupación, entrega única, historial e inhibición probados. La recuperación con caché obsoleta cambia el estado del contenedor ausente antes de tiempo. |
| INCD-10 | 03-02 | Parcial | Ausencias, renombrados y recreaciones tienen reconciliación y cobertura. El reloj acredita parte de un intervalo sin inventario fechado. |
| CONT-04 | 03-03 | Parcial | Recogida, protecciones, visibilidad y política digest probadas. El barrido puede perder un fallo concurrente y publicar un cierre falso. |

### Seguridad y revisión

El registro de fase declara nueve amenazas mitigadas y las nueve correcciones de revisión cerradas. Se comprobó que los mecanismos de revisión están presentes, incluidos el bloqueo por revisión, el orden de traslado antes de caducidad, la inspección de estado y el límite de intentos. El fallo A limita la mitigación T-03-01 y T-03-04, el fallo B afecta a T-03-04 y el fallo C invalida la garantía de evidencia completa en T-03-07. La fase no cambió las dependencias ni el lockfile. [Seguridad](03-SECURITY.md), [correcciones](03-REVIEW-FIX.md), [disposición](03-REVIEW-DISPOSITION.md).

## Verificación humana

Los tres bloqueos son reproducibles automáticamente. La validación de despliegue mantiene dos comprobaciones manuales complementarias. [Matriz de validación](03-VALIDATION.md).

1. **Docker desechable.** Observar el barrido de un ayudante propio huérfano, verificar que se conserva su volumen y observar el primer fallo en Mantenimiento y la incidencia digest tras un segundo fallo. La integración de esta verificación usó un cliente Docker inyectado.
2. **Lectura de estados.** Comprobar en Avisos y Mantenimiento que la fecha, el motivo de inhibición, la ausencia pendiente y el estado de limpieza se distinguen al cambiar de host. Playwright comprueba el estado estructural, y la revisión manual cubre la claridad del texto.

## Resumen de bloqueos

El objetivo de la fase queda bloqueado por tres defectos de evidencia: reconciliación anterior al filtro de frescura, gracia que atraviesa una muestra sin inventario fechado y acreditación de ausencia de ayudantes registrados después de capturar la lista. Los tres quedan dentro de los requisitos de esta fase.

_Verificado por gsd-verifier._
