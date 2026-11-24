---
phase: 01-auditor-a-del-ruido
plan: 02
subsystem: testing
tags: [python, unittest, audit, telegram, duplicates, histogram, reproducibility]

requires:
  - phase: 01-01
    provides: "Export parseado y pinneado, clasificación de 10 familias, inventario de 9 emisores, eras E1-E4 y 01-AUDIT.json"
provides:
  - "Recuperaciones separadas por canal: 0 en Telegram y hub en no medido"
  - "Duplicado entre sistemas 14/12/1/13 medido por mensaje WUD, y entre canales sin cifra sin CSV"
  - "Histograma de 24 cubos con la hora de pared, top 3 de claves y 51 pasadas WUD"
  - "Doble cifra events/messages por era (6/62/19/15) y ventanas 30/60/90 con by_emitter"
  - "Adaptador CSV de alerts y comprobación de reproducibilidad byte a byte"
affects: [01-03, 02, 03, 04, 05, 06, 07, 08]

actuals:
  tokens: 19417
  tasks: 3
  commits: 6
  plan_head_before: 5bbe765619d686c4f48d076e8c1a67a96958bd49
  plan_head_after: 9f46efa04ca6083965c722ed70c58b99c8c6e393

tech-stack:
  added: []
  patterns:
    - "TDD test-first por tarea con commits separados test → feat"
    - "Dos bloques de duplicado separados; nunca una cifra única de canales"
    - "Hora de pared para el histograma y ZoneInfo solo para pared→instante UTC"
    - "JSON canónico con sort_keys y comparación de bytes en --check-repro"

key-files:
  created:
    - scripts/audit/fixtures/alerts_sample.csv
  modified:
    - scripts/audit/noise_audit.py
    - scripts/audit/test_noise_audit.py
    - .planning/phases/01-auditor-a-del-ruido/01-AUDIT.json

key-decisions:
  - "La recuperación de Telegram es 0 por construcción y el hub se publica como no medido hasta que exista alerts.resolvedAt"
  - "El duplicado entre sistemas cuenta una vez por mensaje WUD aunque casen dos líneas del updater"
  - "El histograma usa row['hour'] tal cual, sin convertir la hora de pared del export"
  - "Las ventanas se anclan al día del último mensaje y calculan el rate con días inclusivos"
  - "El CSV de alerts es aditivo: sin él, push queda unavailable y las tablas de Telegram no cambian"

patterns-established:
  - "Toda cifra derivada del export se afirma primero contra un fixture sintético y luego contra el export real con skipUnless"
  - "Los campos de push se publican como null y se renderizan como —, nunca como 0"

requirements-completed: [AUDT-01, AUDT-02, AUDT-03]

coverage:
  - id: D1
    description: "Recuperaciones separadas por canal: Telegram 120 aperturas, 26 informativos, 0 recuperaciones; hub_push unavailable sin CSV y sin llave total"
    requirement: AUDT-02
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#RecoveryTest.test_the_real_export_has_146_messages_and_zero_recoveries"
        status: pass
    human_judgment: false
  - id: D2
    description: "Duplicado entre sistemas con 14 mensajes WUD, 12 tags idénticos, 1 actualización real y 13 revisiones manuales"
    requirement: AUDT-02
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#DuplicateTest.test_the_real_export_reproduces_the_inter_system_duplicate"
        status: pass
    human_judgment: false
  - id: D3
    description: "Histograma de 24 cubos con pico de 8 mensajes a las 06:00 en E4, suma igual al total menos missing_time y hora de pared intacta"
    requirement: AUDT-03
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#HistogramTest.test_the_real_export_keeps_eight_messages_at_0600_in_e4"
        status: pass
    human_judgment: false
  - id: D4
    description: "Top 3 determinista: security:update 31, wud:tdarr 15 y wud:radarr 10 con desempate alfabético"
    requirement: AUDT-03
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#TopKeysTest.test_the_real_export_has_the_expected_top_three"
        status: pass
    human_judgment: false
  - id: D5
    description: "95 mensajes WUD agrupados en 51 pasadas, 11 grupos repetidos y 14 mensajes extra"
    requirement: AUDT-01
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#WudEventTest.test_the_real_export_has_51_scan_passes_and_11_repeated_groups"
        status: pass
    human_judgment: false
  - id: D6
    description: "Doble cifra por era 6/62/19/15 y ventanas 30/60/90 con 44/140/144 mensajes y by_emitter de los nueve ids"
    requirement: AUDT-03
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#WindowTest.test_the_real_export_reproduces_the_windows_and_era_events"
        status: pass
    human_judgment: false
  - id: D7
    description: "Adaptador CSV de alerts con cabecera estricta, filas inválidas contadas y latencia de copia desde alerts.at"
    requirement: AUDT-02
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#DuplicateTest.test_with_a_csv_the_copy_latency_comes_from_alerts_at"
        status: pass
    human_judgment: false
  - id: D8
    description: "Reproducibilidad byte a byte del mismo export mediante canonical_json y --check-repro"
    requirement: AUDT-01
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#ReproducibilityTest.test_the_real_export_is_reproducible_byte_for_byte"
        status: pass
      - kind: other
        ref: "python3 scripts/audit/noise_audit.py --export <export> --check-repro"
        status: pass
    human_judgment: false

# Metrics
duration: 10min
completed: 2026-11-24
status: complete
---

# Phase 01 Plan 02: Recuperaciones, duplicados, horas y líneas base

**La auditoría publica 0 recuperaciones en Telegram y el hub como no medido, 14/12/1/13 en el duplicado entre sistemas, 51 pasadas WUD, el pico de 8 mensajes a las 06:00 en E4 y ventanas de 30/60/90 días con 44/140/144 mensajes y rate por emisor.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-11-24T18:56:31Z (aprox.)
- **Completed:** 2026-11-24T19:05:01Z (aprox.)
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- `recoveries.telegram` reparte los 146 mensajes del bot en 120 aperturas y 26 informativos, con 0 recuperaciones y ratio 0.0; `hub_push` queda `unavailable` y todos sus campos numéricos en `null`, sin una llave `total` que mezcle canales.
- `duplicates.inter_system` cuenta 14 mensajes WUD afectados, 12 con el mismo tag destino, 1 actualización real y 13 revisiones manuales, una vez por mensaje WUD; `inter_channel` solo publica una cifra con CSV y, sin él, `duplicates` y `latency_s` son `null`.
- `histogram` publica 24 cubos con la hora de pared (E4 conserva 8 mensajes a las 06:00) y suma el total menos `missing_time`; `top_keys` publica `security:update` 31, `wud:tdarr` 15 y `wud:radarr` 10.
- `wud_events` agrupa 95 mensajes en 51 pasadas y `repetitions` publica 11 grupos con 14 mensajes extra; cada era publica `events` 6/62/19/15 frente a `messages` 8/105/20/15.
- `windows.30d/60d/90d` publican 44/140/144 mensajes con `by_emitter` de los nueve ids y `rate = round(messages / inclusive_days, 2)`; `--check-repro` confirma dos agregaciones canónicas idénticas.

## Task Commits

Cada tarea se commiteó atómicamente, con el test RED antes de la implementación:

1. **Task 1: Recuperaciones por canal** - `f7e8eec` (test) → `fa8eaa4` (feat)
2. **Task 2: Duplicados y adaptador CSV de alerts** - `6323221` (test) → `82d799a` (feat)
3. **Task 3: Histograma, top 3, eventos WUD y ventanas** - `0bb0cfe` (test) → `9f46efa` (feat)

**Plan metadata:** `docs(01-02): close out the plan with its summary` lo registra este mismo archivo.

## Files Created/Modified

- `scripts/audit/noise_audit.py` — constantes de recuperación, CSV de alerts, join de push, duplicados, histograma, top 3, eventos WUD, repeticiones, ventanas y `--check-repro`.
- `scripts/audit/test_noise_audit.py` — 35 pruebas nuevas de recuperaciones, CSV, duplicados, histograma, top 3, eventos, ventanas y reproducibilidad; la suite completa suma 68.
- `scripts/audit/fixtures/alerts_sample.csv` — cuatro filas sintéticas de `hostId,key,severity,at,resolvedAt`, sin datos reales.
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json` — agregados canónicos con las secciones nuevas y sin cuerpos de mensajes.

## Decisions Made

- La apertura se decide por mensaje, no por línea: un `security-update` con una línea `manual` y otra `updated` cuenta una vez como apertura.
- El `hub_push` se resume con las filas del CSV (`openings`, `recovery_messages`, ratio) y no se infiere del volumen de Telegram.
- La latencia entre canales se calcula como `telegram_sent_at - alerts.at` en segundos; la recuperación usa `resolvedAt`.
- La columna de push es aditiva: `push` publica `skipped_rows` y el estado, y las tablas de Telegram no cambian sin CSV.
- El JSON evita la subcadena `text` en valores y el campo `text`, incluida la frase de evidencia heredada de 01-01.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Un timestamp sintético de la prueba de eventos WUD había perdido el prefijo `f` y se corrigió antes del commit de la tarea 3; no afectó al producto ni a las cifras.

## User Setup Required

None - no external service configuration required. La auditoría sigue siendo stdlib-only y el CSV real de alerts vive fuera del repositorio.

## Next Phase Readiness

`01-AUDIT.json` contiene ya todas las cifras que 01-03 necesita: recuperaciones por canal, los dos bloques de duplicado, histograma, top de claves, repeticiones, eventos WUD, ventanas y `--check-repro`. La fase 01-03 puede fijar el mapa alerta/digest/silencio y el orden de apagado sin volver a tocar el dataset.

## Self-Check: PASSED

- `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` → 68 tests, OK.
- `python3 scripts/audit/noise_audit.py --export <export> --check-repro` → `{"reproducible": true}`, exit 0.
- Gates del plan: 146 mensajes, 0 recuperaciones, hub `unavailable`, 14/12/1/13, 24 cubos, 11 grupos/14 extras, 51 pasadas, events 6/62/19/15, 44/140/144, top 3 correcto.
- `pnpm test` → 167 passed, 108 skipped; `git -C ../media-stack status --porcelain` vacío; `src/` y `agent/` sin cambios.
