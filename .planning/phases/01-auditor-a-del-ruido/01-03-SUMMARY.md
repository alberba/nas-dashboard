---
phase: 01-auditor-a-del-ruido
plan: 03
subsystem: testing
tags: [python, unittest, audit, policy, shutdown-order, success-target, report]

requires:
  - phase: 01-01
    provides: "Parser del export, inventario de 9 emisores, eras E1-E4 y 01-AUDIT.json"
  - phase: 01-02
    provides: "Recuperaciones, duplicados, histograma, top de claves, eventos WUD, ventanas y --check-repro"
provides:
  - "Mapa definitivo de 22 claves: 9 immediate, 9 digest y 4 silent, con WUD silent y la copia immediate"
  - "Orden de apagado de cinco pasos con la copia estrechada a backup-failed y dos emisores fuera de alcance"
  - "Objetivo numérico de 1,0 mensajes proactivos/día sobre E4 = 1,25/día y ack definido pero no medido"
  - "Cuatro marcadores temporales, split E3a/E3b y notas de denominador, push y ack"
  - "01-AUDIT.md de 15 secciones renderizado desde 01-AUDIT.json con --check-report y --check-repro"
affects: [02, 03, 04, 05, 06, 07, 08]

actuals:
  tokens: 29552
  tasks: 3
  commits: 6
  plan_head_before: b6d391d2ee4ea6a89c61e91cff405d7973542294
  plan_head_after: bf452d032ae0cdaa7f7b1e00763a62009db2e093

tech-stack:
  added: []
  patterns:
    - "Modelo de informe con secciones id/title/source y tablas o párrafos; el render nunca recibe filas crudas"
    - "Cada cifra declara su fuente (export/codigo/state/no medido) y los huecos se renderizan como —"
    - "TDD test-first por tarea con commits separados test → feat"
    - "JSON canónico sin la subcadena text y comparación byte a byte para --check-report y --check-repro"

key-files:
  created:
    - .planning/phases/01-auditor-a-del-ruido/01-AUDIT.md
  modified:
    - scripts/audit/noise_audit.py
    - scripts/audit/test_noise_audit.py
    - .planning/phases/01-auditor-a-del-ruido/01-AUDIT.json

key-decisions:
  - "El mapa cubre 22 claves sin duplicados: 9 immediate, 9 digest y 4 silent; WUD queda silent y la copia immediate"
  - "security-update y release-apply se publican en digest con split_by_outcome que manda manual y failed a immediate"
  - "El objetivo se apoya en E4 con denominador inclusivo (15/12 = 1,25) y propone 1,0 proactivos/día; el ack se publica como — porque no existe ackAt"
  - "El orden de apagado no incluye la copia: se estrecha a backup-failed con origen propio (SEC-06, PITFALLS #24); issue-automator y unknown-smart se revisan en la fase 8"
  - "E3 se parte en E3a (3–7 nov) y E3b (8–12 nov) para separar el efecto del tag.transform del de WUD 9.8.0"
  - "01-AUDIT.md se renderiza solo desde report.sections y --check-report compara bytes; todo el JSON evita la subcadena text"

patterns-established:
  - "Las secciones del informe se construyen desde agregados con fuente declarada y un — explícito cuando no hay dato"
  - "Los contratos de decisión (policy, shutdown_order, success_target, trend, footnotes) viven en el JSON y el Markdown es una vista"
  - "La privacidad se prueba con un cuerpo centinela sintético: el cuerpo no cruza al modelo ni al Markdown"

requirements-completed: [AUDT-04, AUDT-05]

coverage:
  - id: D1
    description: "Mapa definitivo de 22 claves (12 del hub y 10 familias de Telegram) con 9 immediate, 9 digest y 4 silent, sin huérfanas ni duplicados"
    requirement: AUDT-04
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#PolicyMapTest"
        status: pass
    human_judgment: false
  - id: D2
    description: "Objetivo numérico de 1,0 mensajes proactivos/día sobre E4 = 1,25/día, con ack median(sentAt -> ackAt), guardia p90 y current None"
    requirement: AUDT-05
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#SuccessTargetTest"
        status: pass
    human_judgment: false
  - id: D3
    description: "Orden de apagado de cinco pasos, copia estrechada a backup-failed, dos emisores fuera de alcance, cuatro marcadores, split E3a/E3b y tres notas"
    requirement: AUDT-04
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#ShutdownOrderTest"
        status: pass
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#TemporalMarkerTest"
        status: pass
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#TrendTest"
        status: pass
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#FootnoteTest"
        status: pass
    human_judgment: false
  - id: D4
    description: "01-AUDIT.md con las 15 secciones renderizado desde 01-AUDIT.json, privacidad por cuerpo centinela y comprobaciones --check-report y --check-repro"
    requirement: AUDT-05
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py#FinalReportTest"
        status: pass
      - kind: other
        ref: "python3 scripts/audit/noise_audit.py --check-report --out-json .planning/phases/01-auditor-a-del-ruido/01-AUDIT.json --out-md .planning/phases/01-auditor-a-del-ruido/01-AUDIT.md"
        status: pass
      - kind: other
        ref: "python3 scripts/audit/noise_audit.py --export <export> --check-repro"
        status: pass
    human_judgment: false
  - id: D5
    description: "Revisión de la prosa del informe: español operativo, tablas coherentes con el JSON y ningún cuerpo personal"
    requirement: AUDT-04
    verification: []
    human_judgment: true
    rationale: "La calidad y la exactitud de la prosa en español no se pueden afirmar sin acoplar los tests al copy; se revisa a mano en /gsd-verify-work junto con el mapa y el objetivo."

# Metrics
duration: 8min
completed: 2026-11-24
status: complete
---

# Phase 01 Plan 03: Mapa de política, apagado y objetivo de éxito

**El informe fija 22 claves en 9 immediate / 9 digest / 4 silent, un apagado de cinco pasos que estrecha la copia, un objetivo de 1,0 proactivos/día sobre E4 = 1,25/día y un ack definido pero publicado como —, todo renderizado en 15 secciones desde el JSON.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-11-24T19:07:51Z (aprox.)
- **Completed:** 2026-11-24T19:15:31Z (aprox.)
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- `policy` publica las 12 claves del hub y las 10 familias de Telegram en 9 immediate, 9 digest y 4 silent, con `security-update` y `release-apply` en digest y su `split_by_outcome` mandando `manual`/`failed` a immediate; `container:<name>` queda silent y agrupado en la fase 3.
- `shutdown_order` fija cinco pasos (upgrade-script, merged-updates, security-updater, security-monitor, wud), deja la copia fuera de `order` y la estrecha a `backup-failed` con `origin="media-stack backup"`, `SEC-06` y `PITFALLS #24`; issue-automator y unknown-smart se revisan en la fase 8.
- `success_target` se apoya en `eras.E4` (12 días inclusivos, 1,25/día) y propone 1,0 proactivos/día; el ack define `median(sentAt -> ackAt)` por severidad con guardia p90, `current=None` y `status="not_measurable"`.
- `trend` marca `16d824e`, `d6831af`, `38061f0` y `cc8d8a3` (WUD 9.8.0) y separa E3a (11 mensajes, 4 WUD) de E3b (9 mensajes), sumando los 20 de E3; `footnotes` añade denominador, push y ack.
- `01-AUDIT.md` renderiza las 15 secciones desde `report.sections`, muestra — en push y ack, declara el sha256 y no contiene cuerpos; `--check-report` acepta el informe y rechaza una alteración, y `--check-repro` confirma dos agregaciones idénticas.
- El JSON conserva intactas todas las secciones de 01-01 y 01-02: la comparación con el HEAD anterior da `dataset`, `eras`, `duplicates`, `histogram`, `top_keys`, `windows` y el resto sin cambios.

## Task Commits

Cada tarea se commiteó atómicamente, con el test RED antes de la implementación:

1. **Task 1: Mapa de política y objetivo de éxito** - `4903f93` (test) → `38e1b5b` (feat)
2. **Task 2: Orden de apagado, marcadores, split E3 y notas** - `e1daef1` (test) → `a27d22d` (feat)
3. **Task 3: Render final de 15 secciones y --check-report** - `9117d45` (test) → `bf452d0` (feat)

**Plan metadata:** `docs(01-03): close out the plan with its summary` lo registra este mismo archivo; la actualización de estado se commitea con `docs(01-03): record progress and session continuity`.

## Files Created/Modified

- `scripts/audit/noise_audit.py` — `HUB_KEYS`, `TELEGRAM_FAMILIES`, `E3_SPLIT`, `REPORT_SECTION_IDS`, `build_policy_map`, `build_shutdown_order`, `build_temporal_markers`, `build_trend_table`, `build_footnotes`, `build_success_target`, `build_report_model`, `render_report`, `check_report` y CLI `--out-md`/`--check-report`.
- `scripts/audit/test_noise_audit.py` — 37 pruebas nuevas de política, objetivo, apagado, marcadores, tendencia, notas y render; la suite de auditoría suma 105.
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json` — añade `policy`, `shutdown_order`, `success_target`, `trend`, `footnotes` y `report` sin reemplazar ninguna sección anterior.
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` — informe operativo en español de 15 secciones renderizado desde el JSON.

## Decisions Made

- El denominador es inclusivo y E4 vale 1,25/día; el objetivo propuesto es 1,0 proactivos/día y el ack se publica como — hasta que exista `ackAt`.
- El mapa no duplica claves: los splits de `security-update` y `release-apply` se declaran dentro de su entrada y la unión sigue siendo 22.
- La copia nunca entra en el orden de apagado: se estrecha a `backup-failed` con origen propio para no perder la única mitigación de "hub caído = silencio".
- Los marcadores usan la hora real de cada commit de `media-stack` cuando se conoce; ninguno queda como fecha a las 00:00.
- El render se alimenta solo de `report.sections`; `--check-report` reconstruye el modelo desde el JSON y compara bytes.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. La ejecución siguió el orden test → feat de las tres tareas y las cifras del plan se reprodujeron sin ajustes.

## User Setup Required

None - no external service configuration required. La auditoría sigue siendo stdlib-only y el export vive fuera del repositorio.

## Next Phase Readiness

La fase 01 entrega el mapa definitivo, el orden de apagado, el objetivo y el informe reproducible. La fase 02 puede implementar `policy.ts` sobre las 22 claves y la fase 8 puede ejecutar el cutover familia por familia; queda para `/gsd-verify-work` la revisión humana de la prosa y la aceptación del objetivo por el operador.

## Self-Check: PASSED

- `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` → 105 tests, OK.
- `python3 scripts/audit/noise_audit.py --check-report --out-json ... --out-md ...` → `{"report_matches": true}`, exit 0; un Markdown alterado devuelve `false` y exit 1.
- `python3 scripts/audit/noise_audit.py --export <export> --check-repro` → `{"reproducible": true}`, exit 0.
- Gates del plan: 22 claves 9/9/4, apagado de 5 pasos + copia estrechada + 2 fuera de alcance, E4 1,25 → 1,0, `ack.current is None`, 4 marcadores, E3a+E3b = 20 con 4 WUD en E3a, 15 secciones, `report.source_hash == source.sha256`, sin `text` en el JSON.
- `pnpm test` → 167 passed, 108 skipped; `git -C ../media-stack status --porcelain` vacío; `src/` y `agent/` sin cambios.
