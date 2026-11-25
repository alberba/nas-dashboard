---
phase: 03-agrupaci-n-inventario-y-ayudantes
verified: 2026-11-25T15:21:44Z
status: human_needed
score: 21/21 must-haves verified
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
    ".planning/phases/03-agrupaci-n-inventario-y-ayudantes/03-VERIFICATION-FIX.md",
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
    "src/lib/nas.ts",
    "src/lib/notification-dispatch.ts",
    "src/lib/notification-policy.ts",
    "src/lib/schema.ts",
    "src/lib/settings.ts",
    "src/lib/types.ts",
    "src/lib/validation.ts",
    "src/worker.ts",
    "tests/agent-client.test.ts",
    "tests/api-incidents.test.ts",
    "tests/api-lifecycle.test.ts",
    "tests/api-maintenance.test.ts",
    "tests/collector-alerts.test.ts",
    "tests/e2e/incidents.spec.ts",
    "tests/e2e/maintenance-status.spec.ts",
    "tests/e2e/maintenance.spec.ts",
    "tests/incident-store.test.ts",
    "tests/maintenance-alerts.test.ts",
    "tests/migrations.test.ts",
    "tests/notification-dispatch.test.ts"
  ]
covered_digest: "v4:sha256:ec288324daa9f1bb4f85641237661d7840a8010f2062cd42712a00241671dea3"
behavior_unverified: 0
overrides_applied: 0
decision_coverage:
  honored: 12
  total: 12
  not_honored: []
re_verification:
  previous_status: gaps_found
  previous_score: 13/21
  gaps_closed:
    - "A · El inventario anterior a la caída no modifica las vigilancias ni los episodios de contenedor."
    - "B · Una lista sin fecha interrumpe la acreditación de ausencia."
    - "C · El barrido conserva los fallos registrados después de iniciar la consulta de inventario."
  gaps_remaining: []
  regressions: []
deferred:
  - truth: "Envío del resumen diario que recoge la incidencia de limpieza"
    addressed_in: "Fase 4"
    evidence: "ROADMAP, fase 4 (DIG-01 a DIG-06) y 03-CONTEXT.md, D-11."
human_verification:
  - test: "Ejecutar el barrido y provocar dos fallos de limpieza en Docker desechable."
    expected: "El ayudante propio huérfano se retira, se conservan el volumen y las demás cargas, y los fallos pasan por Mantenimiento y por una única incidencia digest."
    why_human: "La suite utiliza un cliente Docker inyectado."
  - test: "Revisar Avisos y Mantenimiento con datos de despliegue y cambiar de host."
    expected: "El inventario fechado, la inhibición, la ausencia pendiente y el estado de limpieza son distinguibles para el operador."
    why_human: "Playwright afirma el estado estructural y la comprobación manual cubre la claridad del texto."
---

# Fase 03 · Verificación de agrupación, inventario y ayudantes

- **Objetivo** — Agrupar una caída de host en una sola incidencia, eliminar las incidencias fantasma de `expectedContainers` y recoger los ayudantes privilegiados huérfanos del agente.
- **Verificado** — 2026-11-25T15:21:44Z, sobre `a005ccd`
- **Estado** — `human_needed`. Los 21 puntos y las seis prohibiciones tienen evidencia automatizada. Quedan dos comprobaciones manuales de despliegue.
- **Reverificación** — 21/21 frente a 13/21 en `ed40dfb`. Las sondas A, B y C pasan.

Se contrastaron los cuatro criterios de ROADMAP y las 17 verdades de los planes con los puntos de entrada de producción, la persistencia y las pruebas de comportamiento.

## Cumplimiento del objetivo

### Criterios del ROADMAP

| # | Resultado observable | Estado | Evidencia |
|---|---|---|---|
| 1 | Una sola incidencia de servicios y una sola apertura por caída del host. | VERIFICADO | El colector escribe `connection` por host y el almacén la proyecta como `services-down`. La prueba de caída sostenida y la del dispatcher comprueban una fila, una apertura y un envío. |
| 2 | Las incidencias de contenedor conservan la inhibición visible durante la caída y se evalúan con evidencia nueva al volver. | VERIFICADO | La prueba de recuperación conserva la inhibición con caché anterior y exige una nueva ventana de 30 s para fallos nuevos. [Sonda A](../../../tests/collector-alerts.test.ts#L2194). |
| 3 | Renombrar o recrear un contenedor deja de generar una incidencia permanente por el nombre anterior. | VERIFICADO | Los casos de mismo ID o reemplazo Compose único trasladan la vigilancia. La ausencia acreditada durante 30 minutos retira el nombre anterior y cierra su episodio. [Retirada](../../../tests/collector-alerts.test.ts#L964), [traslado](../../../tests/collector-alerts.test.ts#L1271). |
| 4 | La recogida autónoma protege otras cargas y hace visible un fallo de limpieza. | VERIFICADO | El barrido recoge el huérfano propio y preserva cargas activas, ajenas y volúmenes. Un fallo concurrente permanece visible en el registro. [Recogida](../../../agent/test_maintenance.py#L1075), [sonda C](../../../agent/test_maintenance.py#L1205). |

### Verdades de los planes

| Plan | Verdad | Estado | Código y prueba |
|---|---|---|---|
| 03-01 | D-01 · Una apertura, Telegram con host y enlace, inventario fechado y miembros inhibidos en Avisos. | VERIFICADO | [collector.ts](../../../src/lib/collector.ts#L414), [incident-store.ts](../../../src/lib/incident-store.ts#L969), [alerts.tsx](../../../src/components/views/alerts.tsx#L79). Pruebas de caída, envío real con transporte inyectado y detalle autenticado. [Colector](../../../tests/collector-alerts.test.ts#L1908), [envío](../../../tests/collector-alerts.test.ts#L2390), [API](../../../tests/api-incidents.test.ts#L663). |
| 03-01 | D-02 · Los episodios abiertos siguen visibles, con motivo y estado sin verificar. La entrega se conserva. | VERIFICADO | El almacén cambia el bloqueo de observación y añade el evento en la misma transacción del grupo. Avisos lee `inhibitedReason` y `observationPending`. [Almacén](../../../src/lib/incident-store.ts#L349), [vista](../../../src/components/views/alerts.tsx#L125), [prueba de inhibición y entrega](../../../tests/collector-alerts.test.ts#L2034). |
| 03-01 | D-03 · Un fallo nuevo empieza una ventana de 30 s tras la caída. | VERIFICADO | El fallo de transporte borra el temporizador por host. El colector descarta marcas repetidas y evalúa los fallos nuevos con umbral de 30 s. La prueba comprueba ausencia de apertura al repetir la caché y a los 10 s, y apertura silenciosa a los 30 s. [Colector](../../../src/lib/collector.ts#L243), [prueba](../../../tests/collector-alerts.test.ts#L2190). |
| 03-01 | D-04 · La primera observación válida reanuda o cierra el mismo episodio y una ausencia queda pendiente. | VERIFICADO | El inventario posterior permite reanudar el episodio detenido, cerrar el que vuelve a correr y reclasificar el ausente como pendiente. El filtro antecede tanto a la reconciliación como a `collectContainers`. [Colector](../../../src/lib/collector.ts#L454), [sonda A](../../../tests/collector-alerts.test.ts#L2194). |
| 03-01 | Una conexión anterior conserva ID, fingerprint, estado y destino. Se proyecta como grupo. | VERIFICADO | Migración 0005 aditiva preserva filas y outbox. El ensayo de migración conserva IDs, fingerprints y outbox. Las pruebas de revalidación y proyección más la sonda histórica de `ed40dfb` comprueban la compatibilidad con episodios anteriores. [Migración](../../../drizzle/0005_incident_context.sql), [prueba de migración](../../../tests/migrations.test.ts#L380), [proyección](../../../src/lib/incident-store.ts#L910). |
| 03-01 | Error de contrato corta la ventana, gracia de reinicio planificado y aislamiento por host. | VERIFICADO | [Ruta de error y gracia](../../../src/lib/collector.ts#L380), [prueba de dos hosts](../../../tests/collector-alerts.test.ts#L441), [contrato y reinicio](../../../tests/collector-alerts.test.ts#L645), [reinicio de ventanas](../../../tests/collector-alerts.test.ts#L1870). |
| 03-02 | D-05 · Gracia de 30 minutos de inventario válido, reaparición y umbral de contenedor detenido. | VERIFICADO | La reaparición conserva la vigilancia y reinicia la ventana de fallo de un detenido. La lista sin marca corta `chainAt` conservando el crédito acumulado. [Reconciliación](../../../src/lib/container-watch.ts#L268), [reaparición](../../../tests/collector-alerts.test.ts#L1033), [umbral](../../../tests/collector-alerts.test.ts#L1138), sonda B. |
| 03-02 | D-06 · Ausencia pendiente visible, sin incidencia nueva, seguida de retirada y cierre al vencer la gracia. | VERIFICADO | La proyección expone la ausencia pendiente y la expiración retira el nombre y cierra su episodio con historial. El filtro del grupo y el corte de continuidad protegen el estado y el plazo. [Overview](../../../src/app/api/%5B...path%5D/route.ts#L394), [vista](../../../src/components/views/maintenance.tsx#L188), [API](../../../tests/api-incidents.test.ts#L790), [retirada](../../../tests/collector-alerts.test.ts#L960), sondas A y B. |
| 03-02 | D-07 · Traslado dentro del host por ID o pareja Compose única. La ambigüedad sigue pendiente. | VERIFICADO | El ID tiene prioridad, un nombre ya vigilado queda excluido y dos orígenes que reclaman un destino impiden el traslado. [Selección](../../../src/lib/container-watch.ts#L147), [ID](../../../tests/collector-alerts.test.ts#L1267), [Compose y ambigüedad](../../../tests/collector-alerts.test.ts#L1417). |
| 03-02 | D-08 · Un reemplazo mantiene identidad, historial y entrega del episodio. Su estado determina si cierra. | VERIFICADO | [Traslado transaccional](../../../src/lib/incident-store.ts#L477), [reserva al llegar al umbral](../../../tests/collector-alerts.test.ts#L1233), [reemplazo detenido](../../../tests/collector-alerts.test.ts#L1345), [continuidad del enlace](../../../tests/api-incidents.test.ts#L869). |
| 03-02 | Una lista vacía fechada cuenta. La ausencia de evidencia, un fallo de transporte o un reinicio de worker excluyen el intervalo. | VERIFICADO | La lista vacía fechada acredita tiempo. Las marcas repetidas o anteriores quedan fuera del cálculo. Un fallo de contrato, transporte, un cambio de worker o una lista sin marca interrumpen la continuidad. [Reloj y sonda B](../../../tests/collector-alerts.test.ts#L857), [caché antigua](../../../tests/collector-alerts.test.ts#L1089). |
| 03-02 | Una parada o eliminación confirmada gana frente a la lectura anterior. Los ajustes preservan la vigilancia por host. | VERIFICADO | API, colector y finalizador usan revisión y bloqueo por host. [Ajustes](../../../src/lib/settings.ts), [finalización](../../../src/lib/lifecycle.ts), [cambio concurrente](../../../tests/api-incidents.test.ts#L1004), [carrera de parada](../../../tests/api-incidents.test.ts#L1065), [borrado aislado](../../../tests/api-lifecycle.test.ts#L366). |
| 03-03 | D-09 · El primer fallo aparece en Mantenimiento y la persistencia produce un único episodio por host. | VERIFICADO | Registro, API y vista exponen el primer fallo. Tras el segundo intento fallido el hub abre un episodio por host. La revisión del barrido conserva los fallos concurrentes. [Registro](../../../agent/helper_cleanup.py#L244), [snapshot](../../../agent/maintenance.py#L813), [vista](../../../src/components/views/maintenance-status.tsx#L255), [prueba agente](../../../agent/test_maintenance.py#L952), [API](../../../tests/api-maintenance.test.ts#L298). |
| 03-03 | D-10 · Dos DELETE fallidos reales por ayudante. Una lista fallida, la caché o dos IDs distintos no suman. | VERIFICADO | El contador es por ID y el umbral se calcula a partir de intentos de DELETE. [Registro](../../../agent/helper_cleanup.py#L244), [fallos dispersos](../../../agent/test_maintenance.py#L1022), [fallo de inventario](../../../agent/test_maintenance.py#L1227), [duplicado de lectura](../../../tests/collector-alerts.test.ts#L2632). |
| 03-03 | D-11 · Incidencia elegible para resumen y pendiente de resumen incluso con `PUSH_WARNINGS`. | VERIFICADO | La política devuelve `digest`, `digest_pending` e `immediate: false`. [Política](../../../src/lib/notification-policy.ts#L83), [prueba de outbox](../../../tests/collector-alerts.test.ts#L2496), [prueba de PUSH_WARNINGS](../../../tests/maintenance-alerts.test.ts#L740). |
| 03-03 | D-12 · Cierre tras eliminar o acreditar la ausencia de todos los IDs pendientes. Un agente anterior o inventario incompleto conserva el episodio. | VERIFICADO | El hub conserva el episodio ante secciones ausentes, antiguas o incompletas. El agente exige un barrido completo con revisión vigente y cero pendientes para publicar `clean`. [Señal](../../../src/lib/maintenance-alerts.ts#L158), [pruebas del cierre y agente anterior](../../../tests/collector-alerts.test.ts#L2541), sonda C. |
| 03-03 | Barrido automático acotado de ayudantes propios y parados. Protege cargas activas, ajenas y volúmenes. | VERIFICADO | El hilo del agente usa el socket existente. El barrido comprueba etiquetas, ID, antigüedad y estado, vuelve a inspeccionar y hace DELETE sin forzar con `v=0`. Los ejecutores registran el ID devuelto por su propio CREATE y liberan en `finally`; si WAIT falla, Docker rechaza el DELETE sin forzar de un contenedor en marcha. [Hilo](../../../agent/server.py#L577), [barrido](../../../agent/helper_cleanup.py#L459), [ejecutores](../../../agent/maintenance.py#L451), [protecciones](../../../agent/test_maintenance.py#L1075), [inspección y límite](../../../agent/test_maintenance.py#L1239). |

### Prohibiciones comprobadas

| Restricción | Evidencia |
|---|---|
| Sin ráfaga de avisos por host. | La caída repetida produce un episodio y un trabajo de apertura. [Agrupación](../../../tests/collector-alerts.test.ts#L1908). |
| Sin inventario ni nombres de contenedores inhibidos en Telegram. | El único envío identifica el host y enlaza al episodio. La prueba inspecciona el payload saliente. [Payload](../../../tests/collector-alerts.test.ts#L2390). |
| Sin traslado ambiguo. | Se conservan las vigilancias cuando hay varios destinos o dos orígenes reclaman el mismo destino. [Varios destinos](../../../tests/collector-alerts.test.ts#L1468), [dos orígenes](../../../tests/collector-alerts.test.ts#L1514). |
| Sin apertura por ausencia temporal. | Una ausencia acreditada acumula tiempo con cero incidencias nuevas. [Ausencia](../../../tests/collector-alerts.test.ts#L857). |
| Sin eliminar cargas ajenas, activas ni volúmenes. | Las pruebas inspeccionan los IDs excluidos y el parámetro `v=0` de la eliminación del huérfano. [Volúmenes](../../../agent/test_maintenance.py#L1075), [ajenos](../../../agent/test_maintenance.py#L1093), [activos](../../../agent/test_maintenance.py#L1134). |
| Sin Telegram ni push por limpieza. | La única entrada del outbox queda en `digest` con estado `suppressed` y motivo `digest_pending`. La política conserva esa disposición aun con `PUSH_WARNINGS`. [Outbox](../../../tests/collector-alerts.test.ts#L2496), [política](../../../tests/maintenance-alerts.test.ts#L740). |

### Artefactos, enlaces y flujo de datos

El CLI dio 12/12 entradas de artefactos presentes y sustantivas. Su comprobación textual de enlaces dio 0/12 al buscar las rutas completas descritas por los planes. Se contrastaron los 12 enlaces en sus puntos de ejecución.

| Plan | Enlaces y origen de datos observados |
|---|---|
| 03-01 | `server.metrics` obtiene la marca de la caché Docker y el esquema admite la marca opcional. El colector llama al almacén para `connection` e inhibición. El almacén lee muestras reales e incidencias/outbox por host e ID, y la API autenticada los suministra a Avisos. El dispatcher consume el trabajo de apertura ligado al mismo ID. |
| 03-02 | El colector llama a `reconcileContainers`. Esta llama al almacén dentro de la transacción de `mutateSettings`. La API y el finalizador comparten ese mecanismo. `overview.watchPending` sale de los ajustes durables y Dashboard lo entrega a Mantenimiento. El límite de frescura precede a la llamada de reconciliación. |
| 03-03 | Servidor y ejecutores comparten el registro de ayudantes. El snapshot lo incorpora incluso cuando usa caché de Mantenimiento. El cliente valida `helperCleanup`; Mantenimiento lo renderiza y el colector deriva una señal que pasa por la política antes de persistir. La revisión capturada antes de listar limita la evidencia de ausencia que acepta el registro. |

### Cobertura de decisiones

El CLI encontró 12/12 decisiones de CONTEXT en los artefactos. La tabla de verdades verifica el comportamiento correspondiente a D-01…D-12. Las suites de integración con PostgreSQL se ejecutaron con `HUB_REQUIRE_TEST_DB=1`; sus guardas de omisión por falta de base no se activaron. Las aserciones relevantes comprueban filas, transiciones, identidad, peticiones enviadas y atributos de estado de interfaz.

## Sondas y regresiones

Las tres regresiones versionadas se reejecutaron sobre `a005ccd`. Sus aserciones comprueban episodios y ajustes persistidos, o el registro y estado devueltos por el agente.

| Sonda | Resultado observado y motivo |
|---|---|
| A · Frescura tras caída | **Pasa.** La primera lista anterior a la caída deja el episodio ausente abierto, con `inhibitedBy` apuntando al grupo, `inhibitedReason: host-unreachable` y secuencia 2. La lista posterior permite marcarlo como pendiente y avanzar a secuencia 3. La guarda común excluye la transferencia y el cierre por reconciliación con esa misma caché. [Guarda](../../../src/lib/collector.ts#L454), [regresión](../../../tests/collector-alerts.test.ts#L2271). |
| B · Continuidad sin fecha | **Pasa.** Tras acreditar 60 000 ms, la lista del segundo 90 sin marca corta la cadena. La lista fechada en el segundo 95 conserva 60 000 ms. El acumulado anterior al arreglo era de 95 000 ms. [Mutación](../../../src/lib/container-watch.ts#L275), [regresión](../../../tests/collector-alerts.test.ts#L912). |
| C · Fallos concurrentes de limpieza | **Pasa.** El Docker simulado captura una lista vacía y registra dos fallos para un segundo ID durante el GET. El barrido acredita la ausencia del primer ID, conserva el segundo como único pendiente persistente y publica un estado distinto de `clean`. [Registro](../../../agent/helper_cleanup.py#L317), [barrido](../../../agent/helper_cleanup.py#L402), [regresión](../../../agent/test_maintenance.py#L1205). |

| Ejecución | Resultado | Procedencia |
|---|---|---|
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 41 archivos, 484/484, con PostgreSQL obligatorio. La ejecución focalizada anterior pasó 144/144 en 7 archivos. | Reejecución del verificador |
| `python3 -m unittest discover -s agent -p 'test_maintenance.py'` | 49/49 | Reejecución del verificador |
| `python3 -m unittest discover -s agent -p 'test_metrics.py'` | 1/1 | Reejecución del verificador |
| `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` | 116/116. Regresión de la fase 01. | Reejecución del verificador |
| `pnpm typecheck` | Salida 0 | Reejecución del verificador |
| `pnpm build` | Salida 0 | Orquestador |
| `pnpm test:agent` | 204 casos, 202 aprobados y 2 omitidos por requerir `renameat2` de Linux. El flake de `test_env_settings` quedó sin reproducir. | Orquestador |
| `CI=1 pnpm test:e2e tests/e2e/incidents.spec.ts tests/e2e/maintenance.spec.ts tests/e2e/maintenance-status.spec.ts` | 21/21. Se contrastaron los recorridos de [Avisos](../../../tests/e2e/incidents.spec.ts), [vigilancia pendiente](../../../tests/e2e/maintenance.spec.ts#L436) y [limpieza](../../../tests/e2e/maintenance-status.spec.ts#L281). | Orquestador |

### Compatibilidad y riesgo residual

- **Agente anterior.** Un episodio de conexión puede mostrar la fecha de la muestra si falta la fecha de inventario. Inicio y parada con respuesta perdida esperan a que tanto la muestra como la recogida superen la caché; el borrado sigue exigiendo inventario posoperación fechado. La omisión de `helperCleanup` no genera cierre. Una muestra sin marca interrumpe la acreditación de ausencias. [Pruebas de agente anterior](../../../tests/api-incidents.test.ts#L1389), [limpieza sin sección](../../../tests/collector-alerts.test.ts#L2679).
- **Reinicio con respuesta perdida.** Residual aceptado. El colector excluye `restart` de la confirmación por inventario: observar el mismo contenedor en marcha no prueba que haya cambiado su generación. La operación permanece pendiente y no se confirma falsamente. [Colector](../../../src/lib/collector.ts#L566), [prueba](../../../tests/api-incidents.test.ts#L1229).
- **Ayudantes históricos.** La recogida automática exige etiquetas propias y deja los huérfanos anteriores al despliegue sin etiquetas en Docker. Se conserva el límite de propiedad acordado. [Selección](../../../agent/helper_cleanup.py#L459), [prueba de etiquetas incompletas](../../../agent/test_maintenance.py#L1110).

## Cobertura de requisitos

| Requisito | Plan | Estado | Evidencia decisiva |
|---|---|---|---|
| INCD-09 | 03-01 | SATISFECHO | Una apertura por host, historial e inhibición visibles y recuperación del contenedor controlada por evidencia posterior. |
| INCD-10 | 03-02 | SATISFECHO | Retirada tras gracia acreditada, transferencia solo con identidad inequívoca y corte ante listas sin fecha. |
| CONT-04 | 03-03 | SATISFECHO | Recogida acotada y protegida, primer fallo visible, incidencia digest persistente y cierre con ausencia o retirada acreditada. |

### Seguridad y revisión

El registro de fase declara nueve amenazas mitigadas y las nueve correcciones de revisión cerradas. Se comprobó que los mecanismos de revisión están presentes, incluidos el bloqueo por revisión, el orden de traslado antes de caducidad, la inspección de estado y el límite de intentos. Las tres regresiones acreditan las mitigaciones de frescura y continuidad de T-03-01 y T-03-04, y la revisión concurrente de T-03-07. La fase no cambió las dependencias ni el lockfile. [Seguridad](03-SECURITY.md), [correcciones](03-REVIEW-FIX.md), [disposición](03-REVIEW-DISPOSITION.md).

## Verificación humana

Quedan pendientes las dos comprobaciones de despliegue de esta sección. El método de GSD fija `human_needed` mientras queden comprobaciones humanas. [Matriz de validación](03-VALIDATION.md).

1. **Docker desechable.** Observar el barrido de un ayudante propio huérfano, verificar que se conserva su volumen y observar el primer fallo en Mantenimiento y la incidencia digest tras un segundo fallo. La integración de esta verificación usó un cliente Docker inyectado.
2. **Lectura de estados.** Comprobar en Avisos y Mantenimiento que la fecha, el motivo de inhibición, la ausencia pendiente y el estado de limpieza se distinguen al cambiar de host. Playwright comprueba el estado estructural, y la revisión manual cubre la claridad del texto.

## Resumen

Los tres gaps de `ed40dfb` quedan cerrados y los cuatro criterios de ROADMAP están cubiertos. El segundo bloque `mark === null` en `reconcileContainers` es inalcanzable tras el retorno temprano y queda como observación de mantenimiento sin impacto en la verificación. La entrega efectiva del resumen diario corresponde a la fase 4. [Rama duplicada](../../../src/lib/container-watch.ts#L385).

_Verificado por gsd-verifier._
