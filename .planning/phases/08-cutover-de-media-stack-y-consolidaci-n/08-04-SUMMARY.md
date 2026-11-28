---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "04"
subsystem: database
tags: [postgres, drizzle, rollups, history, worker, performance]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: migración 0009 (08-14), ingest en producción (puerta 08-10)
provides:
  - tablas sample_rollups y container_rollups (migración aditiva 0010) con claves compuestas
  - src/lib/history-rollups.ts con rollupRange, rollupRecent, backfillRollups, readHistory y readContainerHistory
  - overview 7d y container-history 7d desde rollup de 15 minutos; 30d reagregado a 1 hora con media ponderada por n
  - carril rollups de workerTurn cada WORKER_ROLLUP_MS y backfill al arrancar el worker
  - reversa scripts/rollback/0010_history_rollups.sql guardada por el último avance aplicado
affects: [08-05 retención de 48 h y presupuesto medido, 08-11 despliegue 2]

actuals:
  tokens: 15500
  tasks: 3
  commits: 3

plan_head_before: 3eebb2564cd8bf3edcff3d2d2a06867dd24e0cf7
plan_head_after: ef39c3453832ecf61547250b2aae22defefd25f3

tech-stack:
  added: []
  patterns:
    - "Una sola definición del INSERT ... SELECT ... ON CONFLICT DO UPDATE compartida por el pase periódico y el backfill"
    - "Lectura de rollup con media ponderada sum(x*n)/nullif(sum(n) FILTER (WHERE x IS NOT NULL),0)"
    - "Prueba de equivalencia contra un oráculo con la consulta cruda original copiada literalmente"

key-files:
  created:
    - drizzle/0010_history_rollups.sql
    - drizzle/meta/0010_snapshot.json
    - src/lib/history-rollups.ts
    - scripts/rollback/0010_history_rollups.sql
    - tests/history-rollups.test.ts
  modified:
    - drizzle/meta/_journal.json
    - src/lib/schema.ts
    - src/app/api/[...path]/route.ts
    - src/lib/worker-loop.ts
    - src/worker.ts
    - tests/migrations.test.ts

key-decisions:
  - "P-13: sample_rollups (hostId, bucket, n, 13 columnas double precision nulas) y container_rollups (hostId, container, bucket, n, cpu, memory, rx, tx), bucket timestamp sin zona, una sola migración 0010"
  - "P-14: el worker recalcula las últimas 2 h de ambas tablas cada 60 s en una transacción; backfill idempotente por días al arrancar"
  - "P-15: 30d usa sum(x*n)/nullif(sum(n) FILTER (WHERE x IS NOT NULL),0); la ponderación es aproximada si una columna falta solo en parte de un cubo"
  - "lastRollup se marca antes de ejecutar el carril (como la recogida), de modo que un fallo se reintenta cada periodo y no en cada turno de 1 s"

requirements-completed: [PERF-01]

coverage:
  - id: D1
    description: "Overview 7d y 30d desde rollups, equivalentes a la agregación cruda (13 columnas, misma serie con huecos nulos)"
    requirement: PERF-01
    verification:
      - kind: integration
        ref: "tests/history-rollups.test.ts#equivale (overview 7d y 30d, 1h/6h/24h crudos)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Historial por contenedor desde rollups (7d, 30d reagregado), huecos nulos y validación 400 del nombre"
    requirement: PERF-01
    verification:
      - kind: integration
        ref: "tests/history-rollups.test.ts#equivale (contenedor)"
        status: pass
    human_judgment: false
  - id: D3
    description: "rollupRecent y backfillRollups idempotentes; muestra tardía corregida; carril del worker"
    requirement: PERF-01
    verification:
      - kind: integration
        ref: "tests/history-rollups.test.ts#idempotencia, backfill, carril del worker"
        status: pass
    human_judgment: false
  - id: D4
    description: "Migración 0010 aditiva, repetible sin efecto y reversible"
    requirement: PERF-01
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#history rollups migration 0010"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 04: Rollups de historial Summary

**El overview y el historial por contenedor de 7 y 30 días se sirven de rollups de 15 minutos (30d reagregado a 1 hora con media ponderada por muestras), mantenidos por el worker cada 60 s y poblados por días al arrancar, con migración 0010 aditiva y reversible.**

## Performance

- **Duration:** 20 min
- **Tasks:** 3 (1 tracer, 2 auto tdd)
- **Files modified:** 11 (5 nuevos, 6 editados; 3 de ellos generados por drizzle-kit o en la lista de esquema)
- **Commits de producción:** f612956, 1f47ead, ef39c34

## Accomplishments

- **Esquema (tarea 1, tracer).** `sampleRollups` y `containerRollups` en `schema.ts` y migración generada `0010_history_rollups`. Revisado a mano el SQL: ambas tablas llevan clave primaria compuesta (`hostId, bucket` y `hostId, container, bucket`), `bucket` es `timestamp` sin zona e índice `sample_rollups_bucket_idx`.
- **Módulo `history-rollups.ts`.** `HISTORY_RANGES`, `WORKER_ROLLUP_MS = 60_000`, `ROLLUP_WINDOW_HOURS = 2`, `rollupRange(executor, from, to)`, `rollupRecent(executor, now?)`, `backfillRollups(executor, { onDay, stopping })`, `readHistory` y `readContainerHistory`. Las medias de las 13 columnas viven en un único fragmento SQL que usan la lectura cruda y el INSERT del rollup.
- **Rutas.** `overview` y `container-history` delegan en el módulo; `route.ts` ya no contiene `FROM samples` ni la tabla `ranges` y mantiene el 400 del nombre (1 a 200 caracteres).
- **Worker.** `WorkerTurnDeps.rollups?` y `state.lastRollup?` (opcional: los arneses de `notification-dispatch` y `telegram-updates` pasan sin cambios). `worker.ts` ejecuta `rollupRecent(db)` en su carril y `backfillRollups(db)` tras adquirir el bloqueo, con registro por día, renovando la marca de salud por día y sin impedir el arranque si falla.
- **Reversa.** `scripts/rollback/0010_history_rollups.sql` aborta salvo que el último `created_at` del diario sea `1795860558509` (el `when` real de la entrada 0010), elimina las dos tablas y la fila del diario. Ensayada 0010 → reversa → 0010.

## Tolerancias de equivalencia y tiempos

- Comparación con el oráculo crudo (consulta original copiada literalmente): `toBeCloseTo(x, 6)` en las 13 columnas de overview y en las 4 de contenedor, todos los cubos menos el primero (parcial en crudo, completo en rollup). 1h, 6h y 24h se comparan exactos contra el oráculo (mismo código crudo).
- Datos sembrados: 30 días a ~5 min con 1 de cada 7 muestras descartada y jitter (cubos de distinto tamaño), swap y latencia ausentes en bloques de un cubo de cada 7, contenedor `beta` ausente en un cubo de cada 3. Se comprueba además que el rollup tiene tamaños `n` distintos y cubos sin swap, de modo que una media sin ponderar no pasaría. Una mutación (+0,01 a `cpu`) hace fallar la equivalencia.
- Sesión con `TimeZone = Asia/Kolkata` (+5:30): la equivalencia de 7d se mantiene.
- Backfill sobre 31 días y ~8,3 mil muestras sembradas: ~1,1 s (incluye borrar los rollups y comprobar el contenido). La medición real con 500k muestras es de 08-05.

## Task Commits

1. **Tarea 1: overview 7d desde el rollup de 15 minutos** - `f612956` (feat)
2. **Tarea 2: 30d reagregado, historial por contenedor y reversa de 0010** - `1f47ead` (feat)
3. **Tarea 3: backfill por días y carril del worker que agrega cada 60 s** - `ef39c34` (feat)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Bloqueo] El ensayo de reversa de 0009 asumía que 0009 era el último avance**
- **Found during:** Tarea 2
- **Issue:** Con 0010 en el diario, `rehearses 0009 → rollback → 0009` hacía `migrateAll` y esperaba `entries.at(-1)` = 0009; la reversa de 0009 se negaría por su guarda.
- **Fix:** El ensayo ahora migra hasta el índice 9 (`migrateThrough(client, 9)`) y toma `entries[9]` y `slice(0, 9)`; el resto de la prueba no cambia.
- **Files modified:** tests/migrations.test.ts
- **Commit:** 1f47ead

**2. [Rule 3 - Bloqueo] `HISTORY_RANGES` seguía haciendo falta en `container-history` tras la tarea 1**
- **Found during:** Tarea 1
- **Issue:** El plan elimina la tabla `ranges` de la ruta en la tarea 1 pero `container-history` aún la usaba hasta la tarea 2.
- **Fix:** La tarea 1 importó `HISTORY_RANGES` en la ruta como puente; la tarea 2 lo retiró al delegar en `readContainerHistory`. Sin efecto en el resultado final.
- **Files modified:** src/app/api/[...path]/route.ts
- **Commit:** f612956, 1f47ead

**3. [Rule 2 - Crítico] El backfill puede alargar el arranque**
- **Found during:** Tarea 3
- **Issue:** Con un histórico grande, el backfill ocurre antes de la primera marca de salud y la sonda podría dar el worker por no sano.
- **Fix:** `backfillRollups` acepta `stopping` (se comprueba entre días) y `onDay` asíncrono; el worker renueva la marca de salud tras cada día procesado.
- **Files modified:** src/lib/history-rollups.ts, src/worker.ts
- **Commit:** ef39c34

**Total deviations:** 3 auto-fixed (2 Rule 3, 1 Rule 2). **Impact:** ninguno sobre el contrato de `<interfaces>`; `backfillRollups` añade las opciones `stopping` y un `onDay` asíncrono además de `onDay`.

## Issues Encountered

- Mi aserción inicial de que `beta` nunca vale 0 era errónea (el valor sembrado puede ser 0 de forma legítima); se sustituyó por la comprobación de que un cubo sin contenedor es una fila nula en todas las columnas.
- Los rollups no se podan en este plan: la retención de `sample_rollups` y `container_rollups` y el recorte de `samples` a 48 h son de 08-05. La limpieza existente de 30 días sobre `samples` no se ha tocado.

## Known Stubs

Ninguno.

## Threat Flags

Ninguna superficie nueva: no hay rutas, rutas de autenticación ni dependencias nuevas. T-08-12 y T-08-13 mitigadas (7d y 30d leen de rollups; `bucket` sin zona y pruebas `equivale` con oráculo).

## Verification

- `pnpm test tests/history-rollups.test.ts tests/migrations.test.ts tests/api-hosts.test.ts tests/notification-dispatch.test.ts tests/telegram-updates.test.ts`: verde. Suite completa: 63 ficheros, 1090 pruebas, verde.
- `pnpm typecheck`, `pnpm lint` (ignorando los directorios de herramientas del checkout principal) y `pnpm build`: verdes.
- Criterios: `grep -c "FROM samples"` en la ruta = 0; `sample_rollups` en `schema.ts` = 2; `readHistory` en la ruta = 2; `lastRollup` en `worker-loop.ts` = 4; `rollupRecent` en `worker.ts` = 2; reversa presente; «history rollups» en `migrations.test.ts` = 1.

## Next Phase Readiness

Listo para 08-05 (retención de 48 h y presupuesto con 500k muestras): las tablas, el backfill y el pase periódico existen y son idempotentes. 08-11 debe desplegar migración 0010 y arrancar el worker (que hace el backfill) antes de acortar la retención.

## Self-Check: PASSED

Ficheros creados presentes y commits f612956, 1f47ead y ef39c34 en la historia de la rama.
