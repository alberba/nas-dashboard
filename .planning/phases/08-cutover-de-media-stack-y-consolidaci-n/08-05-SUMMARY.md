---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "05"
subsystem: database
tags: [postgres, retention, rollups, worker, performance, budget]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: tablas de rollup, backfill y carril del worker (08-04)
provides:
  - pruneSamples (lotes de 2 000, presupuesto de 15 s) guardado por cubo agregado y última muestra del host
  - pruneHistory que además poda sample_rollups, container_rollups e ingest_events a 30 días
  - historyStatement(hostId, range), la sentencia que ejecuta readHistory
  - tests/overview-budget.test.ts y script test:perf (solo con HUB_PERF=1)
affects: [08-11 despliegue 2, 08-13]

actuals:
  tokens: 21000
  tasks: 2
  commits: 2

plan_head_before: 2c240e23e9dba969a647155f5eda6c54dde81fb6
plan_head_after: 3995acf2f4bf139b0baa86331534512f70baf89e

tech-stack:
  added: []
  patterns:
    - "Borrado por lotes con DELETE ... WHERE id IN (SELECT ... LIMIT n) y presupuesto de tiempo"
    - "Pruebas de borrado dentro de una transacción siempre revertida, sin tocar la siembra compartida"
    - "Aserción de plan con EXPLAIN (FORMAT JSON) sobre la misma sentencia que ejecuta la ruta"

key-files:
  created:
    - tests/overview-budget.test.ts
  modified:
    - src/lib/history-rollups.ts
    - src/worker.ts
    - tests/history-rollups.test.ts
    - package.json
    - README.md

key-decisions:
  - "P-32: una sola función pruneHistory (muestras guardadas, rollups e ingest_events a 30 días) como único punto de entrada del worker y de las pruebas"
  - "P-33: lotes de 2 000 filas y presupuesto de 15 000 ms (menor que WORKER_STALE_MS = 90 s); budgetMs 0 ejecuta exactamente un lote"
  - "P-34: la poda compara con now() de la base y las pruebas siembran relativo a now(); no hay reloj de JavaScript"
  - "P-35: historyStatement(hostId, range) se exporta y readHistory la ejecuta, de modo que la prueba de plan y la ruta no divergen"

requirements-completed: [PERF-01, PERF-02]

coverage:
  - id: D1
    description: "Las muestras crudas solo se borran si son anteriores a 48 h, su cubo está agregado y no son la última del host; la pasada es acotada por lotes y presupuesto"
    requirement: PERF-01
    verification:
      - kind: integration
        ref: "tests/history-rollups.test.ts#retención"
        status: pass
    human_judgment: false
  - id: D2
    description: "pruneHistory poda rollups e ingest_events a 30 días y una pasada repetida no borra nada"
    requirement: PERF-01
    verification:
      - kind: integration
        ref: "tests/history-rollups.test.ts#retención pruneHistory poda rollups e ingest a 30 días"
        status: pass
    human_judgment: false
  - id: D3
    description: "GET /api/overview?range=30d con 500 000 muestras tiene p95 menor de 150 ms por la ruta real"
    requirement: PERF-02
    verification:
      - kind: integration
        ref: "tests/overview-budget.test.ts#el overview de 30d tiene p95 menor de 150 ms"
        status: pass
    human_judgment: false
  - id: D4
    description: "El plan de 30d no lee samples y la poda a 48 h deja idéntica la serie de 24h"
    requirement: PERF-02
    verification:
      - kind: integration
        ref: "tests/overview-budget.test.ts#el plan de 30d no lee samples y sí sample_rollups"
        status: pass
      - kind: integration
        ref: "tests/overview-budget.test.ts#la poda a 48 horas no cambia la serie de 24h"
        status: pass
    human_judgment: false

duration: 18min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 05: Retención de 48 h y presupuesto medido Summary

**La limpieza del worker recorta las muestras crudas a 48 horas solo cuando su cubo de 15 minutos ya está en `sample_rollups` y siempre deja la última de cada host, en lotes acotados por debajo del umbral de salud; el overview de 30 días mide p95 = 64,0 ms sobre 500 000 muestras reales.**

## Performance

- **Duration:** 18 min
- **Tasks:** 2 (1 tracer, 1 auto tdd)
- **Files modified:** 6 (1 nuevo, 5 editados)
- **Commits de producción:** 06b0932, 3995acf

## Medidas (esta ejecución, PostgreSQL 18 local en contenedor)

Ejecución con `--silent=false`; los tiempos de siembra y poda varían entre ejecuciones (dos ejecuciones registradas).

| Medida | Valor |
| --- | --- |
| Overview 30d | **p95 64,0 ms**, máximo 98,5 ms, N = 50 (5 de calentamiento descartadas) |
| Overview 24h (informativo, sin umbral) | p95 141,8 ms, máximo 153,0 ms, N = 50 |
| Siembra de 500 000 muestras | 38 518 ms (otra ejecución: 60 822 ms) |
| Backfill de rollups | 22 514 ms (otra: 21 324 ms) |
| ANALYZE (3 tablas) | 358 ms (otra: 471 ms) |
| Poda de 466 717 muestras con `pruneHistory` | 194 580 ms (otra: 95 677 ms), `exhausted: true` |

Ninguno de los tiempos de preparación se acerca a la mitad del techo de 900 s. No hubo que corregir ninguna sentencia: el p95 de 30d quedó muy por debajo de 150 ms a la primera, así que no se tocó el umbral ni la lectura. El plan de 30d recorre `sample_rollups` y ninguna relación `samples`.

## Accomplishments

- **Poda guardada (tarea 1, tracer).** `pruneSamples` ejecuta lotes con una sola sentencia `DELETE ... WHERE id IN (SELECT ... LIMIT n)`. La subconsulta exige que la muestra sea anterior a `now() - 48 h`, que exista en `sample_rollups` la fila del mismo host con `bucket = date_bin('15 minutes', at, ...)` y que exista una muestra posterior del mismo host por comparación de fila `(at, id)`, de modo que la última siempre sobrevive, incluso con marcas de tiempo repetidas. Devuelve `{ deleted, exhausted }`.
- **`pruneHistory`.** Llama a `pruneSamples` y poda `sample_rollups`, `container_rollups` (por `bucket`) e `ingest_events` (por `receivedAt`) a 30 días con `now()` de la base. El callback `cleanup` de `worker.ts` la usa y ya no borra `samples` directamente; el corte de 30 días de incidencias, operaciones, presencia y Telegram no cambia. El registro en español sale solo si se podó alguna muestra.
- **`historyStatement`.** La construcción de la sentencia de `readHistory` se extrajo (rutas crudas y de rollup) sin cambiar la salida; `readHistory` la ejecuta.
- **Pruebas `retención` (6).** Dos hosts, cubo ausente, última muestra con marcas repetidas, lotes pequeños con `budgetMs: 0` y una pasada repetida que da cero. Cada una corre en una transacción siempre revertida, de modo que no toca la siembra compartida. Una mutación (quitar la guarda del cubo y la de la última muestra) hace fallar 3 de ellas.
- **Presupuesto (tarea 2).** `tests/overview-budget.test.ts` se omite entera sin `HUB_PERF=1` antes de tocar la base. Con él siembra 500 000 muestras (~2 KB de JSONB con 10 contenedores), hace backfill y `ANALYZE`, mide 30d y 24h por el handler real, comprueba el plan con `EXPLAIN (FORMAT JSON)` y verifica tras `pruneHistory` que baja el recuento, que la última muestra sigue y que la serie de 24h es la misma.
- **Documentación.** `pnpm test:perf` y un párrafo en `README.md` sobre la prueba, su coste y la retención.

## Task Commits

1. **Tarea 1: poda guardada por cubo agregado y limpieza del worker** - `06b0932` (feat)
2. **Tarea 2: presupuesto p95 con 500 000 muestras** - `3995acf` (test)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Bloqueo] La prueba de zona horaria de 08-04 dejaba filas `zone-host` que rompían el backfill**
- **Found during:** Tarea 1
- **Issue:** `tests/history-rollups.test.ts` (prueba "el rollup guarda el cubo sin zona horaria") confirma filas con la hora local de Asia/Kolkata, cinco horas y media por delante del reloj de la sesión. El backfill por días las incluía y los pasos limitados por `now()` no, así que "backfill: puebla ambas tablas" fallaba de forma intermitente según la hora (n = 2 frente a 1 en el cubo reciente).
- **Fix:** la prueba borra al final las filas de `zone-host` de `samples`, `sample_rollups` y `container_rollups`. No cambia código de producción.
- **Files modified:** tests/history-rollups.test.ts
- **Commit:** 06b0932

**2. [Rule 1 - Bug de prueba] Comparación exacta de flotantes en la serie de 24h**
- **Found during:** Tarea 2
- **Issue:** `toEqual` entre dos lecturas de 24h falló por el último dígito (68,69726692520527 frente a 68,69726692520528): el orden de suma de `avg` difiere entre lecturas.
- **Fix:** comparación con `toBeCloseTo(..., 6)`, que es la tolerancia que ya usa la equivalencia de 08-04.
- **Files modified:** tests/overview-budget.test.ts
- **Commit:** 3995acf

**3. [Rule 3 - Bloqueo] `test:perf` con `--silent=false`**
- **Found during:** Tarea 2
- **Issue:** esta versión de Vitest oculta la salida de `console.info` en las pruebas que pasan, de modo que el p95, el máximo y N que el plan manda registrar no se verían.
- **Fix:** el script añade `--silent=false` a la forma de `<interfaces>`.
- **Files modified:** package.json
- **Commit:** 3995acf

**Total deviations:** 3 auto-fixed (2 Rule 3, 1 Rule 1). **Impact:** ninguno sobre el contrato de `<interfaces>`; `historyStatement` y la parte de `package.json` correspondiente se entregaron como estaba previsto (la primera, en el commit de la tarea 1 por ser una extracción que la poda no necesita pero la tarea 2 reutiliza).

## Issues Encountered

- La primera pasada de poda sobre 466 717 filas tardó entre 95 y 195 s en lotes de 2 000. En producción cada pasada del worker se detiene a los 15 s y continúa a la hora siguiente, de modo que alcanzar el volumen acumulado llevará varias pasadas; la guarda protege los datos y 24h no depende de las filas antiguas.
- La prueba de presupuesto ocupa del orden de 1 GB y varios minutos, y por eso solo corre con `pnpm test:perf`.

## Known Stubs

Ninguno.

## Threat Flags

Ninguna superficie nueva: sin rutas, autenticación, dependencias ni migraciones. T-08-14 (borrar lo no agregado o la última muestra) y T-08-15 (limpieza larga que caduca la marca de salud) mitigadas, con pruebas del cubo ausente, de dos hosts y de `budgetMs: 0`. T-08-SC: sin paquetes nuevos.

## Verification

- `pnpm test` completo con la base desechable: 63 ficheros, 1096 pruebas pasadas y 4 omitidas (las del presupuesto, sin `HUB_PERF`).
- `HUB_PERF=1 ... vitest run tests/overview-budget.test.ts`: 4 de 4 verdes (dos ejecuciones completas; la primera falló solo por la comparación de flotantes ya corregida).
- `pnpm typecheck`, `pnpm lint` (ignorando los directorios de herramientas) y `pnpm build`: verdes.
- Criterios: `db.delete(samples)` en `worker.ts` = 0; `pruneHistory` en `worker.ts` = 2; `retención` en `tests/history-rollups.test.ts` = 1; `test:perf` en `package.json` = 1; `historyStatement` en `history-rollups.ts` presente; `tests/overview-budget.test.ts` presente.

## Next Phase Readiness

Listo para 08-11: la retención de 48 h es irreversible, así que la copia de seguridad previa y el backfill de 08-04 deben haberse hecho antes de desplegar este plan. Para el registro de 08-11: p95 de 30d = 64,0 ms, primera poda de ~0,47 millones de filas en varias pasadas de 15 s.

## Self-Check: PASSED

Ficheros creados presentes (`tests/overview-budget.test.ts`) y commits 06b0932 y 3995acf en la historia de la rama.
