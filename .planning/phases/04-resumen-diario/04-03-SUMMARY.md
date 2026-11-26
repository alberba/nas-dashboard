---
phase: 04-resumen-diario
plan: "03"
subsystem: notifications
tags: [digest, visibility, healthcheck, docker, worker, agent, boot-identity, tmpfs]

requires:
  - phase: 04-resumen-diario
    plan: "01"
    provides: digest_runs queue, frozen payload, finite reasons and Madrid targets
  - phase: 04-resumen-diario
    plan: "02"
    provides: cohortes, contadores y texto acotado del resumen
  - phase: 02-incidencias-y-entrega-nica
    provides: the collection advisory lock and the authenticated overview path

provides:
  - Global digest projection (latest arrived target, finite status and reason) in the authenticated overview
  - Bounded worker log for durable failure, expiry and uncertainty transitions
  - Worker progress mark with boot identity, a local Compose probe and a container healthcheck
  - Agent serve-loop progress mark published only with the protected LOCK free
  - Shared HEALTHCHECK inherited by both agent Compose configurations

affects: [04-03 verification, phase close-out]

actuals:
  tokens: 20902
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Projection ordered by target instant, never by last write, so a rewritten older date cannot replace a newer one"
    - "Closed public reason lists with an explicit unknown-to-null mapping"
    - "Atomic 0600 mark in the container tmpfs, validated by freshness, private mode and /proc boot identity"
    - "Progress published from the serve loop only while a non-blocking LOCK acquisition succeeds"
    - "Worker milestones extracted into an injectable loop module that never starts the process on import"

key-files:
  created:
    - src/lib/worker-health.ts
    - src/lib/worker-loop.ts
    - scripts/check-worker-health.ts
  modified:
    - src/lib/digest-runs.ts
    - src/lib/types.ts
    - src/app/api/[...path]/route.ts
    - src/components/views/alerts.tsx
    - src/app/globals.css
    - src/worker.ts
    - compose.yaml
    - agent/server.py
    - agent/Dockerfile
    - tests/api-incidents.test.ts
    - tests/notification-dispatch.test.ts
    - tests/e2e/incidents.spec.ts
    - agent/test_metrics.py

key-decisions:
  - "The digest is a hub-global projection: the same state answers for every host of the overview and survives a host change"
  - "Ordering follows targetAt, so a date rewritten later (or a missed-run marker) never displaces a newer target"
  - "Only durable transitions recorded by this tick emit a log; reading a terminal row again is silent"
  - "Uncertainty says confirmation is missing and never asserts whether Telegram accepted the message"
  - "The worker mark moves only after milestones of the loop that owns the lock, and renew re-checks the lock after every await"
  - "The agent publishes progress from service_actions only when the same LOCK used by metrics and actions is free"
  - "Both probes reject missing, malformed, future, stale, unsafe, dead-PID and reused-PID marks"

patterns-established:
  - "A local, read-only Docker probe with no network, no database, no Docker socket and no new port"
  - "Boot identity from field 22 of /proc/<pid>/stat shared by the Node probe and the Python agent probe"
  - "Docker health evidence on disposable containers by freezing the real process with SIGSTOP and restoring it with SIGCONT"

requirements-completed: [CONT-03]

coverage:
  - id: C1
    description: "Avisos shows the latest arrived digest target with a finite status and reason, globally and only with a session; the payload never crosses the API"
    requirement: CONT-03
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#projects the latest digest target globally with a finite reason"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#drops an unknown digest reason, keeps a prepared claim pending and reports zero history"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#keeps the digest projection behind a session"
        status: pass
      - kind: e2e
        ref: "tests/e2e/incidents.spec.ts#INC-E2E-01 opens an episode older than the 100 recent through email login"
        status: pass
      - kind: e2e
        ref: "tests/e2e/incidents.spec.ts#INC-E2E-04 keeps the global digest result when the host changes"
        status: pass
    human_judgment: false
  - id: C2
    description: "The worker emits one bounded line per durable failure, expiry or uncertainty, including a recovered attempt and the last lost window, and repeats nothing on a terminal read"
    requirement: CONT-03
    verification:
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#reports one bounded failure transition for a confirmed rejection"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#reports an ambiguous attempt as uncertain without claiming a delivery"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#reports the last lost window once when the tick returns after the deadline"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#keeps an attempt-started lease uncertain without a resend"
        status: pass
      - kind: integration
        ref: "tests/notification-dispatch.test.ts#records one omission after a long stop instead of replaying days"
        status: pass
    human_judgment: false
  - id: C3
    description: "Compose marks the worker unhealthy when its loop stops progressing while the process lives, and healthy again when progress resumes"
    requirement: CONT-03
    verification:
      - kind: unit
        ref: "tests/notification-dispatch.test.ts#worker health > writes a fresh private mark that the compose probe accepts"
        status: pass
      - kind: unit
        ref: "tests/notification-dispatch.test.ts#worker health > marks a stopped loop unhealthy while the process is still alive and recovers"
        status: pass
      - kind: unit
        ref: "tests/notification-dispatch.test.ts#worker health > rejects a fresh mark from a reused PID with another start identity"
        status: pass
      - kind: unit
        ref: "tests/notification-dispatch.test.ts#worker health > rejects missing, malformed, future, unsafe, dead and unreadable marks"
        status: pass
      - kind: unit
        ref: "tests/notification-dispatch.test.ts#worker health > renews only after real milestones of the loop that owns the lock"
        status: pass
      - kind: integration
        ref: "disposable Docker container nas-dashboard:local (SIGSTOP → unhealthy, SIGCONT → healthy)"
        status: pass
    human_judgment: false
  - id: C4
    description: "Both agent images inherit a HEALTHCHECK that fails when the live serve loop stops publishing progress or the protected LOCK stays taken"
    requirement: CONT-03
    verification:
      - kind: unit
        ref: "agent/test_metrics.py#HealthProbeTest.test_a_stopped_loop_is_unhealthy_while_the_process_is_still_alive"
        status: pass
      - kind: unit
        ref: "agent/test_metrics.py#HealthProbeTest.test_a_lock_held_by_another_thread_blocks_progress_and_recovery"
        status: pass
      - kind: unit
        ref: "agent/test_metrics.py#HealthProbeTest.test_missing_malformed_future_unsafe_dead_and_unreadable_marks_fail"
        status: pass
      - kind: integration
        ref: "disposable Docker container hub-agent:healthcheck-test (SIGSTOP → unhealthy stale, SIGCONT → healthy)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-26
status: complete
commits: 6
plan_head_before: 20836677eef4bf3cfdbac571dcdf33437e48b4fd
plan_head_after: aa91325859e350859ed86b5b3e06f8b6567766fa
---

# Phase 4 Plan 3: Resumen diario — visibilidad global y salud de los procesos

**Avisos proyecta el último objetivo del resumen con estado y motivo finitos, el worker registra una transición acotada por fallo, vencimiento o incertidumbre, y Docker declara unhealthy un worker o agente vivo cuyo bucle dejó de avanzar.**

## Performance

- **Duration:** 45 min
- **Tasks:** 3
- **Files modified:** 16
- **Commits:** 6 (medidos desde `20836677eef4bf3cfdbac571dcdf33437e48b4fd`)

## Accomplishments

- El overview autenticado incluye `digest` con la fecha civil, el objetivo, un estado público y un motivo de lista cerrada. La consulta ordena por `targetAt` (no por `updatedAt`), filtra objetivos aún no llegados y devuelve `null` con cero historial o con una respuesta anterior del hub.
- `prepared`/`claimed` se publican como `pending`; `sent`, `empty`, `unconfigured`, `expired`, `failed` y `uncertain` conservan su significado. Un motivo desconocido se descarta en lugar de reenviarse.
- Avisos muestra un panel global con `data-digest-state`, `data-digest-date`, `data-digest-target`, `data-digest-reason` y `data-digest-scope="global"`. La incertidumbre se presenta como falta de confirmación, sin afirmar si Telegram entregó.
- El worker emite una sola línea acotada por transición durable (`fallo`, `vencido`, `incierto`) con fecha civil y motivo finito. Repetir el tick sobre una fila terminal no emite nada, no reenvía y no crea un aviso por otro canal.
- La marca de salud del worker es un JSON pequeño escrito de forma atómica con modo `0600` en `/tmp` del contenedor, con `progressAt`, PID e identidad de arranque de `/proc/<pid>/stat`. Solo se renueva si el lock de recolección sigue vigente y un hito real terminó.
- `drainWorker` renueva tras cada oportunidad de entrega y `workerTurn` tras la consulta, la recolección, el drenaje y la limpieza. Un error repetido sin progreso no extiende la marca; el apagado y la pérdida del lock la invalidan y bloquean renovaciones posteriores.
- El agente publica desde `service_actions()` solo si `LOCK.acquire(blocking=False)` prospera: la marca cubre a la vez el bucle del servidor y el camino protegido de `/metrics` y acciones. La sonda `python server.py --health-check` es de solo lectura y no inicia servidor, hebras, socket Docker ni comandos del host.
- `agent/Dockerfile` declara `HEALTHCHECK` una sola vez; `agent/compose.yaml` y `agent/compose.apps.yaml` construyen la misma imagen `hub-agent:1` y conservan `read_only: true`, `tmpfs: [/tmp]`, entorno y binds.

## Task Commits

1. **Task 1: Mostrar el resultado real del último resumen en Avisos** — `3e5a3e4` (feat, tracer)
2. **Task 2: Detectar la falta de progreso del worker desde Compose**
   - `c8ebdfa` (test, RED)
   - `ec03945` (feat)
3. **Task 3: Detectar un agente vivo con el servidor o el lock detenido**
   - `ec7f48d` (test, RED)
   - `f8ad33c` (feat)
4. **Cierre de documentación de la tolerancia** — `aa91325` (docs)

## TDD Evidence

| Task | RED (target tests) | GREEN |
| --- | --- | --- |
| 2 | 10 fallos: el marcador no se escribía, la sonda solo devolvía `missing`, `drainWorker`/`workerTurn` no renovaban y el script no existía | `WorkerHealth`, `checkWorkerHealth`, `drainWorker` y `workerTurn` con lock revalidado y hitos reales |
| 3 | 7 fallos y 1 error: `HealthMark.refresh()` devolvía `False`, la sonda solo devolvía `missing`, `write_health_mark` no existía y el modo CLI comprobaba el token antes que la salud | marca atómica, `service_actions` con LOCK no bloqueante, sonda de solo lectura y `--health-check` previo al token |

Los registros completos están en `.gsd/tdd-evidence/04-03/` (ignorado por git): `red-task2.log` (10 fallos de aserción), `green-task2.log` (10/10), `red-task3.log` (7 fallos + 1 error de `NotImplementedError`) y `green-task3.log` (212 pruebas OK). `gsd_run` no está instalado, así que `tdd-red-evidence` no pudo ejecutarse; la evaluación semántica queda registrada a mano.

## Docker evidence

Contenedores desechables, sin credenciales ni volúmenes de producción; todos eliminados al terminar, junto con las imágenes de prueba y la base `hub_worker_health`.

| Servicio | Configuración observada | Transición |
| --- | --- | --- |
| Worker (`nas-dashboard:local`) | marca `WORKER_STALE_MS = 90 s`; evidencia con `--health-interval=2s --health-retries=2 --health-start-period=10s` | `healthy` → `SIGSTOP` al PID 1 (node vivo, `State=running`) → `unhealthy` a los 100 s → `SIGCONT` → `healthy` |
| Agente (`hub-agent:healthcheck-test`) | imagen: `CMD python server.py --health-check`, interval 30 s, timeout 5 s, start-period 30 s, retries 3; evidencia con 2 s/2 retries | `healthy` → `SIGSTOP` al PID 1 (python vivo, `State=running`) → `unhealthy` con salida `Marca de salud del agente no válida (stale)` a los 100 s → `SIGCONT` → `healthy` |

Ambos `docker compose config --quiet` de `agent/` validan con la misma imagen `hub-agent:1`; el `tmpfs: [/tmp]` y `read_only: true` siguen presentes. El `HEALTHCHECK` del worker se declara en `compose.yaml` (la imagen de la app es compartida con web y migrate) y el del agente en la imagen común.

## Files Created/Modified

- `src/lib/digest-runs.ts` — `projectDigestOverview`, lista cerrada de motivos, `DigestTransition` y emisión única en recuperación, vencimiento, rechazo e incertidumbre
- `src/lib/types.ts` — `PublicDigestStatus`, `PublicDigestReason`, `DigestState` y `Overview.digest` opcional
- `src/app/api/[...path]/route.ts` — proyección global en el overview autenticado, tolerante a un fallo de lectura del panel
- `src/components/views/alerts.tsx` — panel de resumen con estado, fecha de Madrid y motivo; cero historial explícito
- `src/app/globals.css` — tonos del panel de resumen reutilizando `.alert-delivery`
- `src/worker.ts` — log acotado de transiciones y cableado de la marca de salud y del bucle extraído
- `src/lib/worker-health.ts` — marca atómica, identidad de arranque, sonda de frescura/PID/modo y `WorkerHealth`
- `src/lib/worker-loop.ts` — `drainWorker` y `workerTurn` inyectables, sin arrancar el proceso al importar
- `scripts/check-worker-health.ts` — entrada local del healthcheck de Compose, sin red
- `compose.yaml` — `tmpfs: [/tmp]` y healthcheck del worker
- `agent/server.py` — marca desde `service_actions`, sonda local, modo `--health-check` e invalidación al arrancar/parar
- `agent/Dockerfile` — `HEALTHCHECK` compartido por ambas configuraciones
- `tests/api-incidents.test.ts` — proyección global, motivo desconocido, cero historial, payload privado y 401
- `tests/notification-dispatch.test.ts` — transiciones del resumen y 10 casos de salud del worker
- `tests/e2e/incidents.spec.ts` — resumen sembrado en Avisos y conservación global al cambiar de host
- `agent/test_metrics.py` — 8 casos de marca, LOCK en otra hebra, PID reutilizado y modo CLI

## Decisions Made

- **Global por construcción.** `digest` no depende del host seleccionado; la prueba de API compara las respuestas de `nas-home` y `apps` y la de Playwright vuelve a Avisos tras cambiar de host.
- **Orden por objetivo.** `ORDER BY targetAt DESC` evita que una fecha antigua reescrita después (o el marcador de omisión) tape el objetivo más reciente.
- **Razón cerrada.** Un valor no reconocido se publica como `null`; ni el cuerpo remoto ni el `reason` crudo llegan al cliente.
- **Sin aviso proactivo por fallo del resumen.** El estado se consulta en Avisos; el worker solo registra una línea y no crea otra entrega.
- **Hitos, no latidos.** La marca del worker avanza con consultas, recolección, oportunidades de entrega y comprobación ociosa; un temporizador lateral no la mantiene.
- **El lock se revalida después del await.** `WorkerHealth.renew()` consulta `holdsCollectionLock` antes de escribir y se cierra permanentemente en apagado o pérdida.
- **El LOCK del agente decide.** `service_actions()` solo renueva si puede tomarlo sin espera; una acción o métrica bloqueada deja de publicar progreso.
- **Identidad de arranque.** Campo 22 de `/proc/<pid>/stat` en Node y Python; un PID reutilizado con otra identidad no es sano aunque la marca sea reciente.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] La base local de e2e no tenía aplicada la migración 0006**
- **Found during:** Task 1, primera ejecución de `pnpm test:e2e`
- **Issue:** `relation "digest_runs" does not exist` al sembrar el resumen; `.env.local` apuntaba a una base de desarrollo aún en 0005
- **Fix:** `pnpm db:migrate` sobre la base local de desarrollo (migración aditiva ya validada por `tests/migrations.test.ts`)
- **Files modified:** ninguno (estado de base local)
- **Verification:** las 4 pruebas de `tests/e2e/incidents.spec.ts` pasan

**2. [Rule 3 - Blocking] El import estático del bucle arrastraba el pool antes de `DATABASE_URL`**
- **Found during:** Task 2, primera ejecución de la suite completa tras añadir los tests de salud
- **Issue:** `worker-loop` → `notification-dispatch` → `push` → `db` creaba el pool en el import del módulo de test, antes de que `beforeAll` apuntara a la base desechable; 44 pruebas de base fallaban con `relation ... does not exist`
- **Fix:** los módulos de salud se cargan con `await import(...)` dentro del `beforeAll` del bloque, después de que la suite de base haya migrado su base
- **Files modified:** `tests/notification-dispatch.test.ts`
- **Verification:** 55/55 en la suite; 550/550 en la suite completa
- **Committed in:** `c8ebdfa`

**3. [Rule 3 - Blocking] La prueba de Playwright necesitaba dos hosts en un despliegue de un solo host**
- **Found during:** Task 1, `INC-E2E-04`
- **Issue:** CI configura `NAS_AGENT_URL` (un solo host) y el overview real sobrescribía el directorio simulado con un único host
- **Fix:** la prueba construye cada respuesta de overview desde la respuesta primaria real y sustituye solo `host`/`hosts`; el estado del resumen sigue viniendo del servidor
- **Files modified:** `tests/e2e/incidents.spec.ts`
- **Verification:** `INC-E2E-04` pasa y conserva `data-digest-target` tras volver de Mantenimiento
- **Committed in:** `3e5a3e4`

**4. [Rule 2 - Missing Critical] El bucle del worker no tenía una ruta inyectable**
- **Found during:** Task 2, preparación del ciclo TDD
- **Issue:** `worker.ts` arrancaba `main()` al importarse, así que los hitos y el manejo de errores no se podían verificar sin un proceso hijo
- **Fix:** se extrajo `drainWorker`/`workerTurn` a `src/lib/worker-loop.ts` con dependencias inyectables; `worker.ts` solo cablea las funciones reales
- **Files modified:** `src/worker.ts`, `src/lib/worker-loop.ts`
- **Verification:** 10 pruebas de salud cubren hitos, lock perdido, parada y error sin progreso
- **Committed in:** `ec03945`

**5. [Rule 2 - Missing Critical] La sonda del agente necesitaba reloj y `/proc` inyectables**
- **Found during:** Task 3, GREEN de la prueba de código de salida
- **Issue:** `run_health_check` usaba siempre el reloj real y `/proc` del host, así que una marca de prueba con reloj fijo se veía `stale`/`dead_pid`
- **Fix:** `read_health_check` y `run_health_check` aceptan `now` y `proc` opcionales; el modo CLI y Docker usan los valores reales
- **Files modified:** `agent/server.py`
- **Verification:** `pnpm test:agent` 212/212
- **Committed in:** `f8ad33c`

---

**Total deviations:** 5 auto-fixed (3 blocking, 2 missing-critical testability)
**Impact on plan:** sin ampliación de alcance. La migración local era un requisito de entorno; la carga diferida de módulos y la extracción del bucle hicieron verificables las propiedades del plan sin cambiar el comportamiento desplegado.

## Issues Encountered

- **`gsd_run` no está instalado.** No se ejecutó `tdd-red-evidence` ni el registro de ventanas; la evidencia RED/GREEN se conserva en `.gsd/tdd-evidence/04-03/` y la evaluación semántica quedó registrada a mano.
- **El primer contenedor de evidencia arrancaba `pnpm worker`.** `SIGSTOP` al PID 1 congelaba pnpm, no node, y la marca seguía renovándose. La evidencia final usa `node --import tsx src/worker.ts` como PID 1 para detener el bucle real.
- **El `status` de zsh es de solo lectura.** El primer guion de espera Docker abortó por esa variable; se renombró a `health_state` sin tocar contenedores ni configuración.
- **`docker compose config` requiere `.env` y `POSTGRES_PASSWORD`.** La validación se hizo con un `.env` desechable y un valor ficticio, eliminados al terminar.
- **La suite completa se ejecutó con workers acotados:** 41 archivos y 550 pruebas en verde (`--maxWorkers=3`).

## Threat Model Coverage

- **T-04-05 (Information disclosure):** la proyección selecciona solo `date`, `targetAt`, `status` y `reason`; el payload se prueba con un marcador secreto en API y e2e y no aparece. El overview sin sesión responde 401 sin cuerpo de resumen. El log solo emite fecha y motivo finito.
- **T-04-06 (Spoofing):** una marca solo avanza con un hito bajo el lock, y la sonda valida antigüedad, modo privado, existencia del PID e identidad de arranque. Los casos de PID reutilizado, lock perdido y proceso vivo sin avance están cubiertos en Vitest, pytest y Docker.
- **T-04-07 (Elevation of privilege):** ambas sondas son locales y de solo lectura; no abren puertos, no añaden privilegios, no usan el socket Docker y no ejecutan comandos del host. El `HEALTHCHECK` se ejecuta con el usuario del contenedor.
- **T-04-SC (Tampering):** sin paquetes nuevos; solo Node, stdlib de Python y Compose existentes.

## Known Stubs

None.

## User Setup Required

None - no new configuration. `compose.yaml` añade `tmpfs: [/tmp]` y el healthcheck del worker; el agente hereda su sonda de la imagen. La migración `0006` ya se aplica con el arranque normal del hub.

## Next Phase Readiness

- El estado del resumen y sus motivos quedan disponibles para el cierre de fase y para cualquier panel futuro sin exponer el payload.
- Las sondas permiten observar un proceso vivo pero bloqueado en NAS y Apps sin cambiar su interfaz de red ni sus binds.
- Los umbrales documentados (90 s de marca, 2 s de escritura, 30 s de intervalo y 3 reintentos en la imagen) dejan margen sobre los timeouts ordinarios de 25 s de recolección y 10 s de proveedor.

---

## Self-Check: PASSED

- 16/16 files listed above exist on disk.
- 6/6 commits are ancestors of HEAD (`3e5a3e4`, `c8ebdfa`, `ec03945`, `ec7f48d`, `f8ad33c`, `aa91325`).
- `HUB_REQUIRE_TEST_DB=1 pnpm exec vitest run --maxWorkers=3` → 41 files, 550 tests passed.
- `pnpm test:agent` → 212 tests OK (2 skipped).
- `pnpm typecheck` → exit 0; lint focalizado de los 11 ficheros TS → sin avisos.
- `pnpm test:e2e tests/e2e/incidents.spec.ts` → 4/4 passed.
- Docker: worker `healthy → unhealthy → healthy` con el proceso vivo; agente `healthy → unhealthy (stale) → healthy`.

---

*Phase: 04-resumen-diario*
*Completed: 2026-11-26*
