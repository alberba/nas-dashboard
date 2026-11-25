---
phase: 03-agrupaci-n-inventario-y-ayudantes
plan: "03"
subsystem: maintenance
tags:
  - docker
  - helper-cleanup
  - incidents
  - digest
  - postgresql
  - zod
  - playwright

requires:
  - phase: 03-agrupaci-n-inventario-y-ayudantes
    plan: "01"
    provides: "Marca Docker de inventario, grupos por host e inhibición de contenedores"
  - phase: 03-agrupaci-n-inventario-y-ayudantes
    plan: "02"
    provides: "Ventana de inventario reconciliada, cierre idempotente y proyección watchPending"

provides:
  - "Registro compartido de ayudantes con etiquetas de instalación, instancia y familia"
  - "Barrido de fondo cada 60 s con gracia de 10 min, presupuesto de candidatos y DELETE ?v=0"
  - "Sección opcional helperCleanup validada por Zod y proyectada fuera de la caché del snapshot"
  - "Señal helper-cleanup tras dos intentos reales del mismo ID, con disposición digest explícita"
  - "Cierre solo con inventario completo y sin IDs afectados; sin envío de recuperación"

affects: [04, verify-work]

actuals:
  tokens: 21367
  tasks: 3
  commits: 3
  plan_head_before: e1a6a64ed5f96244bf275210caf1b0e72279abcc
  plan_head_after: 2fb4dd1c1e252efc3da2a91cc25be3945e04e63d

tech-stack:
  added: []
  patterns:
    - "Propiedad demostrada por etiqueta de marcador + propietario de la misma instalación + instancia de proceso"
    - "El contador de intentos solo avanza al fallar un DELETE real; leer el snapshot no cuenta"
    - "Nunca se elimina un contenedor en ejecución, aunque sea antiguo o de una generación anterior"
    - "La ausencia se acredita con un 404 estructurado o con una lista Docker completa que ya no incluye el ID"
    - "El estado clean exige un barrido completo; un DELETE aceptado no cierra el conjunto por sí solo"
    - "La proyección helperCleanup se calcula en cada lectura, fuera de la caché del resto del snapshot"

key-files:
  created:
    - agent/helper_cleanup.py
  modified:
    - agent/maintenance.py
    - agent/server.py
    - agent/Dockerfile
    - agent/test_maintenance.py
    - src/lib/maintenance.ts
    - src/lib/agent-snapshots.ts
    - src/lib/maintenance-alerts.ts
    - src/lib/notification-policy.ts
    - src/lib/collector.ts
    - src/components/views/maintenance-status.tsx
    - tests/api-maintenance.test.ts
    - tests/collector-alerts.test.ts
    - tests/maintenance-alerts.test.ts
    - tests/e2e/maintenance-status.spec.ts
    - agent/test_host_commands.py

key-decisions:
  - "La instalación se identifica con AGENT_INSTALLATION_ID o, en su defecto, hostname más rol; la instancia es un UUID por proceso"
  - "El marcador propio (hub.agent.helper=1) se excluye del inventario de /metrics para no dar de alta ayudantes transitorios"
  - "La gracia de 10 minutos se mide desde la etiqueta de creación validada, nunca desde la hora del snapshot"
  - "Un ayudante del proceso actual solo se elimina tras su release; uno de una generación anterior debe estar parado y tener edad suficiente"
  - "El estado indeterminado conserva los recuentos pendientes pero no emite una señal sana ni duplica la incidencia"
  - "helper-cleanup tiene una rama digest explícita que ignora PUSH_WARNINGS (D-11)"
  - "El colector recuerda el último checkedAt acreditado por host para que una respuesta antigua no cierre el episodio"

patterns-established:
  - "HelperRegistry: labels(), enrol(), release(), protect(), record_delete_failure(), finish_sweep(), section()"
  - "HelperReaper: lista completa, revalidación por ID con Docker y DELETE /containers/{id}?v=0"
  - "DockerError conserva el status HTTP para distinguir ausencia acreditada (404) de fallo indeterminado"
  - "helperCleanup opcional en MaintenanceSnapshot; un agente anterior no rompe la lectura"

requirements-completed: [CONT-04]

coverage:
  - id: D1
    description: "El primer fallo real de limpieza se ve en Mantenimiento y el segundo del mismo ayudante abre una sola incidencia por host en Avisos"
    requirement: CONT-04
    verification:
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_a_failed_delete_is_visible_then_persistent_after_the_background_retry"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#opens one digest episode for a persistent helper cleanup failure"
        status: pass
    human_judgment: false
  - id: D2
    description: "El barrido solo elimina IDs con propiedad, identidad y estado demostrados; preserva cargas ajenas, activas, recientes y volúmenes"
    requirement: CONT-04
    verification:
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_foreign_containers_with_the_same_image_are_never_deleted"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_active_helpers_and_old_running_helpers_are_preserved"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_a_previous_generation_orphan_is_deleted_without_volumes"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_an_incoherent_inspection_preserves_the_helper"
        status: pass
    human_judgment: false
  - id: D3
    description: "Los ayudantes de disco y de reinicio comparten el registro; el reinicio queda protegido mientras su comando está en marcha"
    requirement: CONT-04
    verification:
      - kind: unit
        ref: "agent/test_maintenance.py#DiskExecutorTest.test_runs_smartctl_in_the_image_with_the_host_devices_read_only"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_the_reboot_helper_is_protected_while_it_runs"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_two_coexisting_roles_are_each_deleted_once"
        status: pass
    human_judgment: false
  - id: D4
    description: "La incidencia se mantiene mientras quede un pendiente y solo se cierra tras un inventario completo sin IDs afectados, sin envío de recuperación"
    requirement: CONT-04
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#keeps the episode while one helper remains pending and closes on the complete check"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_a_partial_resolution_keeps_the_remaining_helper_pending"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_an_inventory_failure_preserves_the_pending_attempts"
        status: pass
    human_judgment: false
  - id: D5
    description: "El contrato de la API distingue recuentos y estados coherentes; Mantenimiento diferencia confirmación, indeterminación y fallo"
    requirement: CONT-04
    verification:
      - kind: integration
        ref: "tests/api-maintenance.test.ts#publishes a coherent helper cleanup section"
        status: pass
      - kind: integration
        ref: "tests/api-maintenance.test.ts#rejects incoherent helper counts and states"
        status: pass
      - kind: e2e
        ref: "tests/e2e/maintenance-status.spec.ts#the cleaning cell distinguishes a persistent failure from a confirmed host (spec creado, no ejecutado)"
        status: unknown
    human_judgment: true
    rationale: "El orquestador pidió no ejecutar Playwright E2E en este plan; la comprobación visual de la celda de limpieza queda para la verificación de fin de fase."
  - id: D6
    description: "Una comprobación antigua no sustituye a la última acreditada y una lectura repetida no duplica la incidencia"
    requirement: CONT-04
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#does not let an older cleanup check close the episode"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#does not duplicate the episode on a repeated reading"
        status: pass
      - kind: unit
        ref: "agent/test_maintenance.py#HelperCleanupTest.test_an_older_check_date_never_replaces_a_newer_one"
        status: pass
    human_judgment: false

duration: 28min
completed: 2026-11-25
status: complete
---

# Phase 03 Plan 03: Limpieza de ayudantes y resolución acreditada

**Recogida de ayudantes Docker propios por etiqueta, instancia y edad, con reintento de fondo tras un DELETE fallido y una sola incidencia digest por host que solo se cierra con inventario completo.**

## Performance

- **Duration:** 28 min (15:06–15:34 Europe/Madrid, aproximado)
- **Started:** 2026-11-25T14:06:04Z
- **Completed:** 2026-11-25T14:34:00Z
- **Tasks:** 3
- **Files modified:** 16 (1 creado, 15 modificados)

## Política de propiedad, edad e identidad

Cada ayudante se crea con cinco etiquetas: marcador propio, propietario, familia, instancia y fecha de creación.

| Etiqueta | Valor | Uso |
|---|---|---|
| `hub.agent.helper` | `1` | Único marcador que convierte un contenedor en candidato |
| `hub.agent.helper.owner` | `AGENT_INSTALLATION_ID` o `hub-agent:<hostname>:<rol>` | Aísla instalaciones; otra instalación nunca es candidata |
| `hub.agent.helper.family` | `host`, `disk` o `reboot` | Tipo conocido; una familia desconocida se preserva |
| `hub.agent.helper.instance` | UUID del proceso | Distingue la generación actual de una anterior |
| `hub.agent.helper.created` | epoch de creación | Edad real; la hora del snapshot no concede gracia |

Reglas del barrido (`HelperReaper.sweep`, cada 60 s):

1. La lista `/containers/json?all=true` debe ser completa y válida; un elemento sin ID Docker de 64 hex o una lista no disponible deja el estado indeterminado y no elimina nada.
2. Solo se consideran contenedores con el marcador propio y el propietario de esta instalación.
3. Nunca se elimina un contenedor en estado `running`, `paused`, `restarting` o `removing`, aunque sea antiguo o de una generación anterior.
4. Un ayudante del proceso actual solo es candidato después de su `release()`; uno de una generación anterior debe estar parado y superar la gracia de 10 minutos.
5. Antes del DELETE se vuelve a pedir `/containers/{id}/json` y se revalidan ID, marcador, propietario, familia, instancia y estado. Una inspección incoherente deja el barrido indeterminado y preserva el contenedor.
6. Solo se emite `DELETE /containers/{id}?v=0`. Los volúmenes con nombre y anónimos permanecen en el host.
7. Hay un presupuesto de 5 candidatos por iteración, timeouts de 8 s y reclamación por ID para serializar intentos concurrentes con el `finally` del ejecutor.
8. Un 404 estructurado de Docker acredita la ausencia; un fallo genérico incrementa el contador del ID y lo deja para el siguiente barrido.

El registro se comparte mediante `helper_cleanup.shared_registry()` entre `HostExecutor`, `DiskExecutor`, el ayudante de reinicio, las acciones de mantenimiento y los despliegues, incluso cuando un ejecutor se crea de forma indirecta. El ayudante de reinicio conserva `AutoRemove`; se registra al crear, se libera si falla el arranque y se protege mientras el comando está en marcha.

## Contrato `helperCleanup`

Sección opcional para no romper a un agente anterior:

```ts
export type MaintenanceHelperCleanup = {
  available: boolean;
  status: "clean" | "failing" | "persistent" | "indeterminate";
  checkedAt: string | null;   // ISO de la última comprobación real
  pending: number;            // IDs con al menos un DELETE fallido
  persistent: number;         // IDs con dos o más DELETE fallidos
};
```

- `failing`: hay pendientes con un solo fallo. Se ve en Mantenimiento y no abre incidencia.
- `persistent`: al menos un ID con dos fallos reales. Es la única entrada que abre `helper-cleanup` en Avisos.
- `indeterminate`: la última lista falló, la inspección fue incoherente o todavía no hay barrido completo. Conserva los recuentos y no emite señal sana.
- `clean`: un barrido completo no encontró IDs afectados. Es la única señal que cierra el episodio.
- `checkedAt` es monótono: una comprobación más antigua nunca sustituye a la última acreditada.
- El esquema Zod rechaza `persistent > pending`, `clean` con pendientes o sin fecha, `failing` sin pendientes y `persistent` sin persistentes.
- La proyección se calcula en cada `Maintenance.snapshot()` fuera de la caché de 60 s, para que un fallo recién conocido aparezca en la siguiente lectura.
- `/metrics` excluye los contenedores con el marcador propio para que la vigilancia de inventario no dé de alta ayudantes transitorios.

## Decisión de cierre (D-09 a D-12)

- El primer fallo de DELETE se registra en `Mantenimiento` en cuanto ocurre, sin esperar una petición web.
- El contador solo avanza al fallar un intento real de eliminar. Leer el snapshot, fallar la lista o fallar la inspección no cuenta.
- Dos fallos de IDs distintos no suman: cada ID tiene su propio contador. Dos fallos del mismo ID producen `persistent`.
- La incidencia se abre con la sección validada cuando `persistent > 0`, aunque el último inventario sea indeterminado: los intentos reales ya están demostrados.
- Si queda un pendiente con un solo fallo tras resolver el persistente, no se emite señal y la incidencia permanece abierta (D-12).
- El cierre exige un inventario completo sin IDs afectados; un DELETE aceptado o un 404 no cierran el conjunto por sí solos.
- `helper-cleanup` tiene una rama digest explícita en `notification-policy.ts`: con `PUSH_WARNINGS=true` sigue siendo digest y nunca genera Telegram o push inmediato.
- Una respuesta sin sección `helperCleanup` (agente anterior) no altera la incidencia del host.

## Limitación de huérfanos históricos

Los ayudantes creados antes de este despliegue no llevan etiquetas de propiedad y **no son candidatos automáticos**. El barrido solo puede demostrar propiedad, generación e identidad de los contenedores etiquetados; ampliar los patrones por imagen o nombre eliminaría cargas ajenas que comparten la imagen `hub-agent:1`. La recogida autónoma queda limitada, por tanto, a los ayudantes etiquetados desde este despliegue en adelante. Los huérfanos históricos siguen requiriendo revisión manual. Esta limitación se registra aquí y no se amplió el selector.

## Accomplishments

- Registro compartido y etiquetado que reconoce a los ayudantes propios de host, disco y reinicio.
- Reintento de fondo sin navegador: el segundo intento del mismo ID ocurre en el ciclo de 60 s.
- Primera representación del fallo en Mantenimiento y una sola incidencia `helper-cleanup` en Avisos tras el segundo fallo real.
- Preservación de contenedores ajenos, activos, recientes, protegidos, con etiquetas incompletas o con inspección incoherente.
- Eliminación acotada por ID validado y con `?v=0`; nunca se tocan volúmenes.
- Cierre acreditado solo con inventario completo y sin envío de recuperación; la incidencia cerrada sigue proyectándose en Avisos con política digest.

## Task Commits

Cada tarea se confirmó de forma atómica:

1. **Task 1: Mostrar un fallo real de un ayudante e intentar recogerlo en segundo plano** — `87b770c` (feat)
2. **Task 2: Recoger ayudantes huérfanos de los productores restantes sin tocar cargas activas** — `b8e9016` (feat)
3. **Task 3: Resolver la incidencia solo al comprobar todos los resultados** — `2fb4dd1` (feat)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: el ayudante de reinicio se integró en el commit 1 porque `server.py` ya formaba parte de ese tracer; el commit 2 añade su prueba de protección junto con `DiskExecutor`. Los estados indeterminados y el recuento visible se incluyeron en el commit 2 porque sus pruebas de barrido los necesitaban._

## Files Created/Modified

- `agent/helper_cleanup.py` — etiquetas, registro, contadores, barrido acotado, revalidación y `DELETE ?v=0`.
- `agent/maintenance.py` — `DockerError` con status, `HostExecutor` y `DiskExecutor` etiquetados, `helperCleanup` fuera de la caché.
- `agent/server.py` — registro compartido, filtro del inventario, ayudante de reinicio protegido y ciclo de fondo.
- `agent/Dockerfile` — incluye `helper_cleanup.py` en el COPY existente.
- `src/lib/maintenance.ts` — tipos `MaintenanceHelperCleanup` y `MaintenanceSnapshot.helperCleanup`.
- `src/lib/agent-snapshots.ts` — esquema Zod opcional con coherencia de recuentos y estados.
- `src/lib/maintenance-alerts.ts` — señal `helper-cleanup` por ID persistente y cierre solo con `clean` fresco.
- `src/lib/notification-policy.ts` — disposición digest explícita que ignora `PUSH_WARNINGS`.
- `src/lib/collector.ts` — última comprobación acreditada por host; una respuesta antigua no cierra.
- `src/components/views/maintenance-status.tsx` — celda Limpieza con confirmación, fallo, persistencia e indeterminación.
- `agent/test_maintenance.py` — 17 pruebas nuevas de registro, barrido, protección y resolución.
- `agent/test_host_commands.py` — fixture de ID Docker válido y DELETE `?v=0`.
- `tests/api-maintenance.test.ts` — contrato, degradación de Docker, incoherencias y lectura repetida.
- `tests/collector-alerts.test.ts` — episodio digest, intentos dispersos, resolución parcial, stale, repetición, ausencia de sección y aislamiento por host.
- `tests/maintenance-alerts.test.ts` — señal, umbral, indeterminate, stale y política digest.
- `tests/e2e/maintenance-status.spec.ts` — estados persistente, clean e indeterminado (spec creado, no ejecutado).

## Decisions Made

- La propiedad exige marcador **y** propietario de la misma instalación; la imagen compartida nunca acredita propiedad.
- La generación se identifica por UUID de proceso, no por reinicio del módulo ni por hora.
- Los contenedores en ejecución se preservan siempre; la recogida autónoma solo actúa sobre IDs parados y acreditados.
- El estado `clean` exige barrido completo; el 404 o el DELETE aceptado resuelven el ID, no el conjunto.
- Una respuesta stale no puede sustituir a la última comprobación acreditada por host.
- El cierre de la incidencia no encola ningún envío inmediato; la política digest queda persistida en el outbox para la fase 4.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Guarda de comprobación stale en el colector**
- **Found during:** Task 3
- **Issue:** una respuesta `/maintenance` antigua podía cerrar un episodio ya acreditado por una comprobación más nueva (T-03-07).
- **Fix:** `src/lib/collector.ts` recuerda el último `checkedAt` por host y no emite la señal `helper-cleanup` si la respuesta es anterior.
- **Files modified:** `src/lib/collector.ts`
- **Verification:** `tests/collector-alerts.test.ts#does not let an older cleanup check close the episode`.
- **Committed in:** `87b770c` (la guarda se añadió durante la tarea 1 y se reforzó con la prueba en la tarea 3).

**2. [Rule 1 - Bug] Fixture de ID Docker en `test_host_commands.py`**
- **Found during:** Task 1
- **Issue:** el fixture devolvía `"helper"` y el nuevo Registro exige un ID Docker de 64 hex; el test fallaba antes de probar el comportamiento.
- **Fix:** el fixture usa `"b" * 64` y espera `DELETE ?v=0`, que además preserva volúmenes.
- **Files modified:** `agent/test_host_commands.py`
- **Verification:** `pnpm test:agent` (suite completa sin el flake conocido).
- **Committed in:** `87b770c`.

### Ajustes de proceso

- **`src/lib/collector.ts` y `agent/test_host_commands.py` fuera de `files_modified`:** ambos cambios son necesarios para T-03-07 y para que la suite existente siga siendo válida con el ID validado. No se modificó ningún otro archivo ajeno.
- **Reparto de commits:** el ayudante de reinicio (`server.py`) se incluyó en el commit 1 porque el tracer ya tocaba `server.py`; su prueba de protección y `DiskExecutor` se confirmaron en el commit 2. Los estados indeterminados con recuento visible también se incluyeron en el commit 2 porque las pruebas de barrido los necesitaban.
- **Playwright no ejecutado:** se actualizó `tests/e2e/maintenance-status.spec.ts` con los estados persistente, clean e indeterminado, según la instrucción del orquestador; la ejecución queda para la verificación de fin de fase.
- **Docker real no ejecutado:** todos los casos de recogida usan el cliente Docker falso. No se tocaron cargas del host operativo.
- **`STATE.md` y `ROADMAP.md`:** no se tocaron; el orquestador es su único escritor.
- **Sin dependencias nuevas:** `agent/requirements.txt` y `pnpm-lock.yaml` no cambian (T-03-SC).

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug) y 5 ajustes de proceso.
**Impact on plan:** ninguno sobre el alcance. Las tres tareas y sus criterios de aceptación están cubiertos; los dos auto-fixes eran necesarios para T-03-07 y para no romper la suite existente.

## Threat Model Evidence

- **T-03-06 (Elevation of Privilege, selección y eliminación):** solo recibe DELETE un ID con marcador propio, propietario de la instalación, familia conocida, instancia válida, edad suficiente y estado parado, tras una segunda inspección Docker. Se cubren contenedor ajeno con la misma imagen, propietario ajeno, etiquetas incompletas, activo antiguo, reinicio en ejecución, ID inválido, inventario caído, inspección incoherente y dos roles coexistentes. Todas las eliminaciones usan `?v=0`.
- **T-03-07 (Tampering, resultado de limpieza):** contrato validado, contador por ID, `checkedAt` monótono, ausencia acreditada por 404 o lista completa, cierre solo con `clean`, y una respuesta stale no sustituye una comprobación nueva. Se prueban dos fallos dispersos, resolución parcial, fallo de lista, reinicio con huérfano y fin confirmado.
- **T-03-08 (Information Disclosure, logs y Mantenimiento):** el snapshot autenticado solo expone disponibilidad, estado, fecha y recuentos acotados; los logs del agente solo incluyen familia e ID truncado, nunca comandos, rutas del socket ni errores crudos. El esquema Zod rechaza estados y recuentos incoherentes.
- **T-03-SC (Tampering, dependencias):** no se añadieron dependencias ni se modificó el lockfile; se usaron el cliente Docker existente, la biblioteca estándar, Zod, Vitest y PostgreSQL 18 local.

## Evidence · PostgreSQL 18, Vitest y agente

| Command | Result |
|---|---|
| `python3 -m unittest discover -s agent -p 'test_maintenance.py'` | 44 tests, OK |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-maintenance.test.ts tests/maintenance-alerts.test.ts tests/agent-client.test.ts` | 4 files, 86 tests passed |
| `pnpm test:agent` (tras la tarea 2) | 198 tests, OK (skipped=2) |
| `pnpm test:agent` (final, dos intentos) | 199 tests, 1 error: flake conocido de `test_env_settings` (ver abajo) |
| Suite de agente sin `test_env_settings` | 179 tests, OK (skipped=2) |
| `pnpm typecheck` | exit 0 |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 41 files, 473 tests passed |
| `pnpm build` | exit 0 (solo avisos preexistentes de `BETTER_AUTH_SECRET` por defecto) |
| `pnpm test:e2e tests/e2e/maintenance-status.spec.ts` | No ejecutado por instrucción del orquestador |

Las suites de PostgreSQL se ejecutaron contra `postgresql://hub:hub@127.0.0.1:55432/hub` con `HUB_REQUIRE_TEST_DB=1`; no hubo omisiones por falta de base. El cliente Docker falso registró cada llamada y las pruebas afirman qué IDs reciben DELETE y que la ruta incluye `?v=0`.

## Issues Encountered

- **Flake preexistente de `env_settings`:** `test_env_settings.EnvSettingsTest.test_serializes_concurrent_writes_without_losing_updated_bytes` falla de forma intermitente con `FileNotFoundError: '.env.lock'`; en la ejecución final falló en dos intentos y también de forma aislada. `agent/env_settings.py` no se modificó en este plan y no se corrigió, según la instrucción del orquestador. La suite completa sin ese módulo pasa (179 tests).
- **Lint no ejecutable en este entorno:** `pnpm exec eslint` aborta con `typescript-eslint does not support TS 7.0` antes de analizar ningún archivo. Es una limitación del entorno (TypeScript 7.0.2 frente a typescript-eslint 8.72.0), no de los cambios. `pnpm typecheck` y las suites pasan.

## User Setup Required

None - no external service configuration required. No hay migración nueva ni variables de entorno adicionales. El despliegue del agente debe reconstruir la imagen para incluir `helper_cleanup.py`; los ayudantes anteriores al despliegue quedan fuera de la recogida automática por falta de etiquetas.

## Next Phase Readiness

- La fase 4 puede consumir `helper-cleanup` desde el outbox con `channel: "digest"` y `reason: "digest_pending"`; la política ya impide el push inmediato.
- La proyección `helperCleanup` es opcional para agentes anteriores y no altera la incidencia si falta.
- La verificación de fin de fase debe ejecutar `pnpm test:e2e tests/e2e/maintenance-status.spec.ts` y revisar visualmente la celda Limpieza en sus estados clean, persistente e indeterminado.
- No hay bloqueos conocidos para la fase 4.

## Self-Check: PASSED

- `agent/helper_cleanup.py` y la sección `helperCleanup` existen y están validadas por Zod.
- `87b770c`, `b8e9016` y `2fb4dd1` son ancestros de `HEAD`.
- PostgreSQL 18 ejecutó 41 suites y 473 tests sin omisiones de base.
- `pnpm typecheck` y `pnpm build` terminaron con exit 0.
- El cierre acreditado, la preservación de volúmenes y la ausencia de DELETE para IDs ajenos están cubiertos por pruebas registradas.

---
*Phase: 03-agrupaci-n-inventario-y-ayudantes*
*Completed: 2026-11-25*
