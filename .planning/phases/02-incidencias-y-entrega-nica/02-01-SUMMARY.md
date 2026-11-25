---
phase: 02-incidencias-y-entrega-nica
plan: "01"
subsystem: database
tags: [postgresql, drizzle, migration, incidents, outbox, rollback, transactions]

requires:
  - phase: 01-auditor-a-del-ruido
    provides: "Política de ruido y mapa de claves auditado que la fase 2 aplicará en la ola 2"

provides:
  - "Tabla incidents con identidad estable, fingerprint por host y clave, seq y marca de episodio heredado"
  - "incident_events como timeline inmutable por (incidentId, seq)"
  - "notification_outbox con clave lógica única, lease, token de reclamación, revisión y resultados por canal"
  - "recordIncidentObservation en src/lib/incident-store.ts"
  - "Reversa operativa scripts/rollback/0004_incidents.sql y ensayo 0003 → 0004 → reversa → 0004"

affects: [02-02, 02-04, 02-05, phase-3]

actuals:
  tokens: 32765
  tasks: 3
  commits: 3
  plan_head_before: 11352daf78764610f1da488546b227757a0b63d0
  plan_head_after: 6c284e9395db40d9cba705c8a3a75d23b6a7399b

tech-stack:
  added: []
  patterns:
    - "Outbox transaccional: episodio, evento y trabajo de entrega en una sola transacción"
    - "Unicidad parcial incidents_open_host_key_idx sobre (hostId, key) donde resolvedAt es nulo"
    - "Fingerprint md5 con prefijos de longitud para que el par (hostId, key) sea inyectivo"
    - "Cierre sintético de migración marcado y reversible por closedBy = 'migration-dedup'"

key-files:
  created:
    - drizzle/0004_incidents.sql
    - drizzle/meta/0004_snapshot.json
    - scripts/rollback/0004_incidents.sql
    - src/lib/incident-store.ts
    - tests/incident-store.test.ts
  modified:
    - drizzle/meta/_journal.json
    - src/lib/schema.ts
    - src/lib/collector.ts
    - src/lib/lifecycle.ts
    - tests/database.ts
    - tests/migrations.test.ts
    - tests/collector-alerts.test.ts
    - tests/api-events.test.ts
    - tests/api-lifecycle.test.ts

key-decisions:
  - "Renombrar alerts a incidents y la secuencia alerts_id_seq a incidents_id_seq conserva ids e identidad sin recrear la tabla"
  - "Todo episodio nuevo escribe una única fila lógica incident:<id>:open; si la condición no es inmediata queda suprimida con digest_pending o policy_silent"
  - "Los episodios heredados no crean ninguna fila de outbox; origin='legacy' es la marca persistida que la ola 2 proyectará como legacy_open"
  - "El store desacopla el canal de la transacción: el llamador pasa la disposición y la ola 2 sustituye el deliveryFor provisional del collector por el mapa auditado"
  - "La reversa elimina el índice parcial antes de reponer los duplicados abiertos y aborta si 0004 no es el último avance del journal"

patterns-established:
  - "Observación: el cierre y la transición de severidad incrementan seq y escriben su evento en la misma transacción que el outbox"
  - "Concurrencia: inserción con onConflictDoNothing, relectura de la fila abierta y actualizaciones serializadas por SELECT ... FOR UPDATE"
  - "Conciliación: los tests comparan epocas con extract(epoch) porque las columnas timestamp sin zona usan relojes distintos en pg y Drizzle"

requirements-completed: [INCD-01, INCD-02, INCD-05]

coverage:
  - id: D1
    description: "Migración 0004: histórico preservado, fingerprint estable, un solo episodio abierto por host y clave, duplicados cerrados con marca sintética y backfill silencioso (D-03)"
    requirement: INCD-01
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#keeps history, closes duplicates and leaves the legacy backfill silent"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#keeps SQL, snapshot and journal aligned"
        status: pass
    human_judgment: false
  - id: D2
    description: "recordIncidentObservation: apertura, evento y aviso en una transacción; concurrencia arbitrada por el índice parcial; rollback si falla el outbox (INCD-02, INCD-05)"
    requirement: INCD-05
    verification:
      - kind: integration
        ref: "tests/incident-store.test.ts#opens once, closes once and keeps the fingerprint across episodes"
        status: pass
      - kind: integration
        ref: "tests/incident-store.test.ts#confirms a single opening when several observations race"
        status: pass
      - kind: integration
        ref: "tests/incident-store.test.ts#rolls back the episode and its event when the outbox cannot be written"
        status: pass
    human_judgment: false
  - id: D3
    description: "Collector delegando en el store: una apertura, un evento y un aviso por condición; reutiliza el episodio tras recrear el collector; los heredados siguen silenciosos"
    requirement: INCD-02
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#persists one episode, one timeline and one logical notice per condition"
        status: pass
      - kind: integration
        ref: "tests/collector-alerts.test.ts#reuses the open episode when the collector module is recreated"
        status: pass
      - kind: integration
        ref: "tests/incident-store.test.ts#keeps legacy open episodes silent through revalidation, escalation and closure"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cierre desde lifecycle solo tras eliminación confirmada, acotado al host y la clave container:<nombre>, con seq, evento y outbox coherentes"
    requirement: INCD-02
    verification:
      - kind: integration
        ref: "tests/api-lifecycle.test.ts#closes only the selected host's container incident after a confirmed removal"
        status: pass
      - kind: integration
        ref: "tests/api-lifecycle.test.ts#records an agent rejection once and never retries it"
        status: pass
      - kind: integration
        ref: "tests/api-lifecycle.test.ts#leaves an uncertain result pending and does not send it again"
        status: pass
    human_judgment: false
  - id: D5
    description: "Reversa operativa y re-avance ensayados en PostgreSQL 18: ids y secuencia preservados, duplicados originales repuestos y rechazo de un journal incompatible"
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#rehearses 0003 → 0004 → rollback → 0004 without repeating or losing ids"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#refuses a journal where 0004 is not the last applied advance"
        status: pass
    human_judgment: false
  - id: D6
    description: "Procedimiento de despliegue y reversa para el operador: parada de app y worker, copia restaurable, recuentos de preflight y tablas a archivar"
    verification: []
    human_judgment: true
    rationale: "La ejecución real sobre la base de producción exige parar servicios, hacer la copia y decidir el archivo de notification_outbox e incident_events; ningún test puede probar esa operación."

duration: 41min
completed: 2026-11-25
status: complete
---

# Phase 02 Plan 01: Incidencias con identidad y outbox transaccional

**Migración reversible de `alerts` a `incidents` con fingerprint estable, timeline y outbox, y un store que escribe episodio, evento y primer aviso en una sola transacción.**

## Performance

- **Duration:** 41 min
- **Started:** 2026-11-25T08:12:16+01:00
- **Completed:** 2026-11-25T08:53:00+01:00
- **Tasks:** 3
- **Files modified:** 14 (9 modificados, 5 creados)

## Accomplishments

- `0004_incidents.sql` renombra `alerts` a `incidents` conservando ids, cierres históricos y la secuencia de identidad; rellena `fingerprint`, `seq` y `origin` antes de imponer el índice parcial.
- El backfill deduplica los episodios abiertos por `at DESC, id DESC`, marca los cierres sintéticos con `closedBy = 'migration-dedup'` y guarda su `resolvedAt` original para que la reversa deshaga solo esos cierres.
- `incident_events` y `notification_outbox` nacen con claves reales: `(incidentId, seq)` y la clave lógica única del primer aviso y de cada edición.
- `recordIncidentObservation` escribe transición, evento y trabajo de entrega juntos; arbitra aperturas concurrentes con el índice parcial y una relectura que no cuenta como segunda apertura.
- El collector y `forgetExpectedContainer` dejan de escribir `resolvedAt` directamente y delegan en el store, con `closedBy = 'collector'` y `'lifecycle'`.
- `scripts/rollback/0004_incidents.sql` repone los duplicados originales, conserva los cierres válidos y aborta si 0004 no es el último avance del journal.

## Task Commits

Cada tarea se confirmó de forma atómica:

1. **Task 1: Migrar un aviso histórico y volver a leerlo desde el esquema del hub** — `9cbf220` (feat)
2. **Task 2: Registrar desde el collector un episodio y su primer aviso en la misma transacción** — `340425f` (feat)
3. **Task 3: Ensayar reversa y siguiente avance antes del despliegue** — `6c284e9` (test)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: la tarea 2 llevaba `tdd="true"`. El test de comportamiento y la implementación se confirmaron en el único commit atómico por tarea que exige el encargo de ejecución; no se creó un commit RED separado._

## Files Created/Modified

- `drizzle/0004_incidents.sql` — renombrado, backfill, deduplicación sintética, índice parcial y tablas nuevas.
- `drizzle/meta/0004_snapshot.json` — estado final del esquema, con `prevId` apuntando al snapshot 0003.
- `drizzle/meta/_journal.json` — entrada `0004_incidents` con `when` 1795591379120.
- `scripts/rollback/0004_incidents.sql` — reversa transaccional con guarda de journal y restauración solo de cierres sintéticos.
- `src/lib/schema.ts` — `incidents`, alias `alerts = incidents`, `incidentEvents` y `notificationOutbox`.
- `src/lib/incident-store.ts` — `incidentFingerprint` y `recordIncidentObservation`.
- `src/lib/collector.ts` — `condition` conserva el debounce y delega; disposición provisional `deliveryFor`.
- `src/lib/lifecycle.ts` — cierre por `container:<nombre>` solo tras eliminación confirmada.
- `tests/database.ts` — `HUB_REQUIRE_TEST_DB=1` convierte la ausencia de PostgreSQL en fallo.
- `tests/migrations.test.ts` — migración multi-host anclada a 0003, ensayo 0004 y reversa.
- `tests/incident-store.test.ts` — concurrencia, rollback de outbox, heredados y ediciones por seq.
- `tests/collector-alerts.test.ts` — episodios, eventos y outbox por host en lugar de envíos directos.
- `tests/api-events.test.ts` — fixture con la forma nueva de `incidents`.
- `tests/api-lifecycle.test.ts` — cierre por host, rechazo e incertidumbre sin cambios.

## Decisions Made

- El fingerprint se calcula como `md5('incident:' || length(hostId) || ':' || hostId || ':' || length(key) || ':' || key)`, idéntico en SQL y TypeScript. Los prefijos de longitud evitan colisiones entre pares distintos.
- Todo episodio nuevo tiene una sola fila lógica `incident:<id>:open`. Si la condición no es inmediata, la fila queda `suppressed` con `digest_pending` o `policy_silent`; así la ola 2 puede persistir el motivo y reactivarla sin cambiar la clave.
- Los episodios heredados no crean ninguna fila de outbox. `origin = 'legacy'` es la marca durable que impide reprogramar su apertura al revalidar o escalar.
- Una escalada de una fila suprimida que nunca inició envío la reactiva como `pending` en el canal inmediato que indique el llamador (D-04). La ola 2 sustituirá `deliveryFor` por el mapa auditado.
- El outbox incluye `attempts`, `fallbackResult` y `editResult` además de los campos del plan. Las olas 4 y 5 no modifican `drizzle/`, así que la forma se fija ahora para conservar resultado inicial, fallback y última edición por separado.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] La reversa restauraba duplicados con el índice parcial todavía activo**
- **Found during:** Task 3, primer ensayo 0003 → 0004 → reversa.
- **Issue:** El `UPDATE` que devuelve `resolvedAt = NULL` a los cierres sintéticos chocaba con `incidents_open_host_key_idx` antes de eliminarlo.
- **Fix:** La reversa elimina el índice parcial antes de restaurar los duplicados y después deshace las columnas y tablas auxiliares.
- **Files modified:** `scripts/rollback/0004_incidents.sql`.
- **Verification:** El ensayo completo 0003 → 0004 → reversa → 0004 pasa en PostgreSQL 18.
- **Committed in:** `6c284e9`.

### Procesos ajustados al encargo

- La tarea 2 llevaba `tdd="true"`; el encargo exige un único commit atómico por tarea, así que no hay commit RED separado. El test de comportamiento se ejecutó contra el store y es la puerta de la tarea.
- No se actualizaron `ROADMAP.md` ni `STATE.md`; el orquestador es su único escritor tras la ola, según el encargo.

**Total deviations:** 1 auto-fixed (Rule 1) y 2 ajustes de proceso.
**Impact on plan:** Ninguno sobre el alcance. El fallo de orden de la reversa era real y quedó cubierto por el ensayo automatizado.

## Issues Encountered

- Las columnas `timestamp` sin zona se leen como UTC en Drizzle y como hora local en `pg`. Los tests comparan con `extract(epoch from ...)` para no depender del huso del proceso; el esquema existente no se tocó.
- `pnpm lint` completo falla por los directorios de entorno no versionados (`.agents/`, `.opencode/`): 6558 problemas ajenos a este plan. El lint acotado a los 10 archivos tocados termina con exit 0.
- `pnpm test` imprime errores esperados de agentes simulados (`NasRejected`, `GitHub 500`); son stderr de casos negativos ya existentes.

## Evidence · PostgreSQL 18

Servidor desechable: PostgreSQL 18.7 (Debian 18.7-1.pgdg13+2), `postgresql://hub:hub@127.0.0.1:55432/hub`. `tests/database.ts` crea y elimina una base por suite y solo admite loopback.

| Command | Result |
|---|---|
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | 5 tests passed (3 migración + 2 reversa) |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-store.test.ts tests/collector-alerts.test.ts tests/api-events.test.ts tests/api-lifecycle.test.ts` | 24 tests passed (4 files) |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts && pnpm typecheck` | 5 tests passed; `tsc --noEmit` exit 0 |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 35 files, 286 tests passed |
| `DATABASE_URL` ausente + `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | Falla explícitamente: «HUB_REQUIRE_TEST_DB=1 requiere DATABASE_URL apuntando a PostgreSQL local» |
| Lint acotado a los archivos del plan | exit 0 |

## Deployment and rollback notes

**Despliegue (unidad completa, después de la ola 5).** Parar `app` y `worker` antes de aplicar 0004: el código anterior consulta `alerts` por nombre y un worker vivo podría escribir mientras el esquema está a medias. Después: `pnpm db:migrate` y arranque de las versiones nuevas. La fase no se despliega por olas.

**Preflight de solo lectura (antes de migrar).** Contar filas de `alerts`, filas abiertas (`resolvedAt IS NULL`), grupos `(hostId, key)` con más de una abierta y el máximo `id`. En el ensayo: 5 filas, 4 abiertas, un grupo duplicado `nas-home/backup-failed` con 3 abiertas y 1 cierre histórico. Tras 0004: 5 filas, 2 abiertas, 2 cierres sintéticos, 0 filas en `notification_outbox` y 0 en `incident_events`.

**Copia restaurable.** Base completa (o dump del esquema `public` y del esquema `drizzle`). Si se revierte tras actividad real, archivar antes `notification_outbox` (resultados, chat/message_id, revisión, lease) e `incident_events` (timeline); la reversa las elimina y no las exporta. Conservar también el estado de `drizzle.__drizzle_migrations`.

**Reversa.** `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/0004_incidents.sql`. El script corre en una transacción, elimina primero el índice parcial, restaura solo `resolvedAt` de las filas con `closedBy = 'migration-dedup'` y conserva los cierres válidos anteriores y posteriores. Aborta si `drizzle.__drizzle_migrations` no tiene 0004 como último avance (`created_at = 1795591379120`) y borra únicamente esa entrada.

**Ensayo realizado.** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` ejecuta 0003 → 0004 → reversa → 0004 con PostgreSQL 18 desechable. Comprueba ids originales, reposición de los duplicados, secuencia de identidad sin reutilización, journal de 4 → 5 entradas, ausencia de trabajo de notificación tras el re-avance y rechazo de un journal con un avance posterior simulado. No se usaron canales reales.

**Después de la reversa.** `pnpm db:migrate` vuelve a aplicar 0004; los ids se conservan y los duplicados se vuelven a deduplicar. No se reutilizan ids porque la secuencia se renombra, nunca se recrea.

## Next Phase Readiness

- La ola 2 puede apoyarse en `recordIncidentObservation`, en `notificationOutbox` (`status`, `nextAttemptAt`, `leaseUntil`, `claimToken`, `attemptStartedAt`, `revision`, `chatId`, `messageId`, `result`, `fallbackResult`, `editResult`) y en `origin = 'legacy'`.
- `deliveryFor` del collector es deliberadamente provisional; la ola 2 debe sustituirlo por el mapa auditado antes de habilitar el dispatcher.
- Las olas 2 a 5 no modifican `drizzle/`: la forma del outbox es el contrato. Cualquier cambio de columnas exigiría una migración nueva no prevista por los planes.
- El overview sigue devolviendo la forma interna de `incidents`; la ola 5 debe proyectar solo los campos públicos y el estado de entrega.
- Pendiente operativo: parada de app/worker, copia restaurable y recuentos de preflight antes de cualquier despliegue real.

## Self-Check: PASSED

- `drizzle/0004_incidents.sql`, `drizzle/meta/0004_snapshot.json`, `scripts/rollback/0004_incidents.sql`, `src/lib/incident-store.ts` y `tests/incident-store.test.ts` existen.
- `9cbf220`, `340425f` y `6c284e9` son ancestros de HEAD.
- PostgreSQL 18 ejecutó las 35 suites del proyecto (286 tests) sin omisiones.
