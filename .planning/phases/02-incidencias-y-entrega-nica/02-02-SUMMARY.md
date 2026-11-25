---
phase: 02-incidencias-y-entrega-nica
plan: "02"
subsystem: validation
tags: [zod, effect, incidents, outbox, notification-policy, postgresql]

requires:
  - phase: 01-auditor-a-del-ruido
    provides: "Mapa auditado de claves immediate/digest/silent y objetivo de ruido"
  - phase: 02-incidencias-y-entrega-nica
    plan: "01"
    provides: "incidents, incident_events y notification_outbox con canal, revisión y motivo"

provides:
  - "Decodificadores Zod de /metrics, /maintenance y /deployments dentro de nasEffectForHost"
  - "Reglas de evidencia: secciones degradadas, medidas nulas y listas ausentes no resuelven su condición"
  - "notificationPolicy con el catálogo auditado, PUSH_WARNINGS y motivos digest_pending/policy_silent"
  - "D-04: watch → fail conserva el episodio y sustituye una apertura todavía no enviada"
  - "Limpieza de claimToken/leaseUntil al preemptar o suprimir una apertura pendiente"

affects: [02-04, 02-05, phase-3]

actuals:
  tokens: 16749
  tasks: 2
  commits: 2
  plan_head_before: da1f7efe88042cda3da07bdfd26b13657d3c7ff5
  plan_head_after: f8d69cdabd3789efed5d73074531e4177871cd86

tech-stack:
  added: []
  patterns:
    - "Contrato del agente: Zod por pathname GET dentro del Effect, antes del límite Promise"
    - "Evidencia: una lectura inválida, degradada o ausente deja la condición intacta; solo una lectura válida la mueve"
    - "Política: el collector no elige canal por severidad aislada; consulta el catálogo auditado por clave"
    - "Preempción: una apertura pendiente se actualiza con revisión nueva y sin claim utilizable"

key-files:
  created:
    - src/lib/agent-snapshots.ts
    - src/lib/notification-policy.ts
  modified:
    - src/lib/nas.ts
    - src/lib/collector.ts
    - src/lib/incident-store.ts
    - src/lib/maintenance-alerts.ts
    - tests/agent-client.test.ts
    - tests/api-hosts.test.ts
    - tests/collector-alerts.test.ts
    - tests/maintenance-alerts.test.ts
    - tests/host-fixtures.ts

key-decisions:
  - "El cuerpo de una respuesta HTTP se lee como texto: un rechazo no JSON sigue siendo NasRejected y solo un 2xx ilegible es NasInvalidResponse"
  - "collectHost omite una muestra inválida sin abrir connection; el fallo real de transporte y la gracia del reinicio previsto se conservan"
  - "cpu null, una lista térmica vacía y una lista de discos vacía son ausencia de evidencia, no recuperación"
  - "disk-health watch es digest; fail es inmediato; un disco unknown mantiene el episodio porque no confirma salud"
  - "deploy-failed solo resuelve con un historial con éxito; una lista vacía o ausente no es evidencia de salud"
  - "El canal de una apertura degradada se reescribe al canal de la nueva disposición antes de suprimirla"
  - "Un fallo de despliegue con un release instalado estrictamente más nuevo sigue resolviendo aunque el historial esté podado"

patterns-established:
  - "Decodificación por método y pathname: /metrics, /maintenance y /deployments?lines=…"
  - "Una sección degradada suprime solo su señal; la otra instantánea válida sigue aportando evidencia"
  - "Motivos persistidos: digest_pending, policy_silent y legacy_open; la entrega inmediata no persiste motivo"
  - "La preempción limpia claimToken y leaseUntil para que un dispatcher lento no envíe la revisión vieja"

requirements-completed: [CONT-01, INCD-04]

coverage:
  - id: D1
    description: "Contrato de /metrics: el cliente decodifica la muestra, el collector la persiste y un 200 inválido no escribe muestras ni toca incidencias"
    requirement: CONT-01
    verification:
      - kind: unit
        ref: "tests/agent-client.test.ts#decodes a valid metrics snapshot and preserves optional views"
        status: pass
      - kind: unit
        ref: "tests/agent-client.test.ts#rejects broken JSON or a wrong shape in a successful response"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#persists a valid sample and ignores a malformed 200 without touching incidents"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#treats a wrong shape in a 200 as a contract failure, not a disconnect"
        status: pass
    human_judgment: false
  - id: D2
    description: "Contratos de /maintenance y /deployments: secciones degradadas, SMART unknown e historial ausente no fabrican salud; la lectura independiente válida sigue evaluándose"
    requirement: CONT-01
    verification:
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#keeps the disk condition when a carrier reports an unknown status"
        status: pass
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#does not claim health from an empty or missing deployment history"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#leaves a degraded section intact while an independent reading resolves its own condition"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#ignores an invalid maintenance payload without resolving its episodes"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#ignores an invalid deployments payload without resolving its episodes"
        status: pass
    human_judgment: false
  - id: D3
    description: "Política auditada y D-04: watch → fail conserva el episodio, genera un solo aviso inicial y respeta downshift, push y silencio"
    requirement: INCD-04
    verification:
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#keeps the audited immediate keys and the disk escalation"
        status: pass
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#replaces only eligible warnings with push when PUSH_WARNINGS is enabled"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#escalates disk-health from watch to fail in the same episode"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#cancels a pending immediate opening when disk-health drops to watch before the send"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#keeps a container condition visible without delivery"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-04 sobre un canal ya comprometido y motivo legacy_open: no se abre un segundo envío y la fila heredada se distingue"
    requirement: INCD-04
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#uses push for eligible warnings and keeps a committed push channel"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#persists legacy_open when a pre-migration episode is revalidated"
        status: pass
    human_judgment: false

duration: 72min
completed: 2026-11-25
status: complete
---

# Phase 02 Plan 02: Contratos del agente, evidencia y escalada auditada

**Decodificación Zod de métricas, mantenimiento y despliegues en el cliente del agente, reglas de ausencia de evidencia y política auditada que conserva el episodio al escalar `disk-health` de watch a fail.**

## Performance

- **Duration:** 72 min
- **Started:** 2026-11-25T08:59:00+01:00
- **Completed:** 2026-11-25T10:11:00+01:00
- **Tasks:** 2
- **Files modified:** 11 (2 creados, 9 modificados)

## Accomplishments

- `nasEffectForHost` decodifica `/metrics`, `/maintenance` y `/deployments?lines=…` con Zod dentro del Effect. Un 2xx con JSON roto o forma inválida produce `NasInvalidResponse`; un rechazo HTTP conserva `NasRejected` aunque su cuerpo no sea JSON.
- `collectHost` omite una muestra inválida sin abrir `connection` ni escribir muestras; un fallo de transporte real mantiene la desconexión y la gracia del reinicio previsto.
- `cpu: null`, una lista térmica vacía y una lista de discos vacía dejan su episodio intacto. Un SMART con estados `unknown` tampoco resuelve `disk-health`.
- `deploy-failed` solo resuelve con un historial con éxito; una lista vacía o ausente no fabrica una transición sana. `release-retained` exige una lista válida.
- `notificationPolicy` aplica el catálogo auditado: cinco claves inmediatas, `disk-health` watch→digest y fail→inmediato, cinco claves de resumen y `container:<name>` silencioso. `PUSH_WARNINGS` sustituye solo warnings elegibles.
- D-04 conserva el ID del episodio, incrementa `seq` y reescribe la apertura pendiente con el canal y la revisión nuevas; los claims viejos quedan invalidados.
- Una apertura ya enviada por push conserva su canal y no crea un Telegram; una apertura enviada por Telegram encola una edición.

## Task Commits

Cada tarea se confirmó de forma atómica:

1. **Task 1: Validar una muestra de métricas hasta la incidencia persistida** — `04f8359` (feat)
2. **Task 2: Completar los contratos y el recorrido de una advertencia que escala a crítica** — `f8d69cd` (feat)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: la tarea 2 llevaba `tdd="true"`. El encargo exige un único commit atómico por tarea, así que el caso de comportamiento se ejecutó contra la implementación y se confirmó en ese commit, sin un commit RED separado._

## Files Created/Modified

- `src/lib/agent-snapshots.ts` — esquemas por pathname GET para métricas, mantenimiento y despliegues; validación estructural sin coerción a salud.
- `src/lib/notification-policy.ts` — catálogo auditado, `pushWarningsEnabled` y decisión con canal, motivo, digest e inmediatez.
- `src/lib/nas.ts` — lectura del cuerpo como texto, distinción `NasRejected`/`NasInvalidResponse` y decodificación dentro del Effect.
- `src/lib/collector.ts` — omisión de muestras inválidas, reglas de evidencia y disposición por clave.
- `src/lib/incident-store.ts` — limpieza de claim/lease al preemptar o suprimir, canal nuevo en downshift y edición solo del canal comprometido.
- `src/lib/maintenance-alerts.ts` — SMART unknown, lista retenida válida e historial de despliegues como evidencia.
- `tests/agent-client.test.ts` — métricas válidas, JSON roto, forma inválida y rechazo no JSON.
- `tests/api-hosts.test.ts` — contenedor alineado con la forma real del productor (`compose: null`, campos de ciclo de vida).
- `tests/collector-alerts.test.ts` — trazador HTTP→DB, CPU/temperatura sin medida, desconexión, D-04, push, silencio, payloads inválidos, historial y `legacy_open`.
- `tests/maintenance-alerts.test.ts` — política auditada, SMART unknown, retención e historial ausentes.
- `tests/host-fixtures.ts` — contenedor de fixture alineado con el productor.

## Observation shapes admitted

| Endpoint | Required core | Optional / nullable tolerated | Rejected as contract failure |
|---|---|---|---|
| `GET /metrics` | `timestamp > 0`, `hostname`, `memory.total > 0`, `network`, `io`, `uptime`, `disks[].total > 0`, `temperatures`, `containers[]` | `cpu: null`, `cpuCores`, `cpuBreakdown`, `load`, `system`, `filesystems`, `raid`, `network.interfaces`, `io.latency`, container `network`/`healthObservedSince` | JSON roto, `memory.total = 0`, falta `containers`, tipos no finitos |
| `GET /maintenance` | `timestamp`, `role`, `follower`, `security`, `backup`, `disks`, `units`, `failedUnits`, `reboot`, `docker`, `degraded` | `containers` (versiones anteriores), `at`/`since`/`installedAt` nulos, `disks[].status: unknown`, SMART `size`/`temperature` nulos | `role` no admitido, `degraded` no lista, dispositivo sin `status` válido |
| `GET /deployments?lines=…` | `timestamp`, `role`, `available`, `follower`, `blocker`, `history`, `retained`, `journal.entries`, `degraded` | `secretSettings` ausente en agentes anteriores (`[]` por defecto), `at`/`since`/`commit` nulos, `retained: []` | `history` no lista, `retained` con entradas sin release, `blocker.code` no admitido |

## Notification policy

| Clave | Disposición | Motivo persistido |
|---|---|---|
| `connection`, `temperature`, `backup-failed`, `stack-unit-failed`, `deploy-failed` | Telegram inmediato | `policy_immediate` |
| `disk-health` en `watch` | Digest (o push con `PUSH_WARNINGS=true`) | `digest_pending` |
| `disk-health` en `fail` | Telegram inmediato | `policy_immediate` |
| `cpu`, `memory`, `disk`, `reboot-pending`, `release-retained` | Digest (o push con `PUSH_WARNINGS=true`) | `digest_pending` |
| `container:<name>` | Silencioso, visible en el hub | `policy_silent` |
| Episodio heredado revalidado con fila de outbox | Suprimido | `legacy_open` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Un downshift de crítica a warning conservaba el canal Telegram**
- **Found during:** Task 2, caso de bajada antes del envío.
- **Issue:** `changeSeverity` suprimía la apertura pendiente pero dejaba `channel = 'telegram'`, así que la fila no representaba el destino de resumen de la nueva severidad.
- **Fix:** la rama de supresión reescribe `channel` con la disposición nueva y limpia `claimToken`/`leaseUntil`.
- **Files modified:** `src/lib/incident-store.ts`.
- **Verification:** `cancels a pending immediate opening when disk-health drops to watch before the send` pasa y comprueba `channel: digest`.
- **Committed in:** `f8d69cd`.

**2. [Rule 3 - Blocking] El fixture compartido de métricas no tenía los campos que el productor emite**
- **Found during:** Task 1, al aplicar el esquema estricto de contenedor.
- **Issue:** `tests/host-fixtures.ts` omitía `compose`, `oneShot`, `exitCode`, `orphan` y `recreateOnCompose`; sin ellos el collector no podía probar el productor real.
- **Fix:** se alineó el contenedor del fixture con `lifecycle.classify_one` y `container_stat` (incluido `compose: null`).
- **Files modified:** `tests/host-fixtures.ts`, `tests/api-hosts.test.ts`.
- **Verification:** las suites de collector y API vuelven a pasar con el esquema estricto.
- **Committed in:** `04f8359`.

### Procesos ajustados al encargo

- La tarea 2 llevaba `tdd="true"`; el encargo exige un único commit atómico por tarea, así que no hay commit RED separado. El test de comportamiento se ejecutó contra la implementación y es la puerta de la tarea.
- No se actualizaron `ROADMAP.md` ni `STATE.md`; el orquestador es su único escritor tras la ola, según el encargo.

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 3) y 2 ajustes de proceso.
**Impact on plan:** Ninguno sobre el alcance. El canal obsoleto era un fallo real de D-04 y el fixture era una omisión de la forma del productor.

## Issues Encountered

- Los tests de API siguen imprimiendo errores esperados de agentes simulados (`NasRejected`) en casos negativos ya existentes; son stderr, no fallos.
- El lint completo del repositorio incluye directorios de entorno no versionados (`.agents/`, `.opencode/`); el lint acotado a los 11 archivos del plan termina con exit 0.

## Evidence · PostgreSQL 18

Servidor desechable: PostgreSQL 18.7, `postgresql://hub:hub@127.0.0.1:55432/hub`, con `HUB_REQUIRE_TEST_DB=1`.

| Command | Result |
|---|---|
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/agent-client.test.ts tests/collector-alerts.test.ts tests/api-hosts.test.ts` | 3 files, 22 tests passed (Task 1) |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/agent-client.test.ts tests/collector-alerts.test.ts tests/maintenance-alerts.test.ts tests/api-maintenance.test.ts tests/api-deployments.test.ts tests/events.test.ts` | 6 files, 58 tests passed (Task 2) |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 35 files, 311 tests passed |
| `pnpm typecheck` | `tsc --noEmit` exit 0 |
| `pnpm lint <11 archivos del plan>` | exit 0 |
| Baseline before Task 1: same 3-file command | 3 files, 15 tests passed |

No se usaron canales reales de Telegram ni Web Push. Las pruebas de push comprueban la fila de outbox y el canal, no la bandeja de un dispositivo.

## Next Phase Readiness

- La ola 3 puede confiar en `metricsSnapshotSchema`, `maintenanceSnapshotSchema` y `deploymentsSnapshotSchema`; cualquier forma nueva del agente debe justificarse contra una versión real y añadirse al esquema.
- `notificationPolicy` es la única fuente de canal/motivo para el collector. La ola 4 debe consumir las filas `digest_pending` para el resumen y tratar `policy_silent` como visible sin envío.
- D-04 deja la apertura pendiente con revisión nueva y sin claim; la ola 4 debe reclamar solo filas con `attemptStartedAt` nulo y respetar `claimToken`.
- `legacy_open` solo se persiste cuando un episodio heredado ya tiene una fila de outbox que suprimir; `origin = 'legacy'` sigue siendo la marca durable para los que no la tienen.
- `tests/host-fixtures.ts` es ahora la forma de referencia del contenedor del productor; futuras fixtures deben reutilizarla.

## Self-Check: PASSED

- `src/lib/agent-snapshots.ts` y `src/lib/notification-policy.ts` existen.
- `04f8359` y `f8d69cd` son ancestros de HEAD.
- PostgreSQL 18 ejecutó las 35 suites (311 tests) sin omisiones.
- El typecheck y el lint acotado terminan con exit 0.
