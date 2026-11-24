---
phase: 01-auditor-a-del-ruido
plan: 01
subsystem: testing
tags: [python, unittest, html-parser, telegram, audit, dataset]

requires: []
provides:
  - "Parser pinneado del export de Telegram con verificación de sha256 y ventana temporal"
  - "Clasificación determinista de los 146 mensajes del bot en 10 familias y cubo unknown"
  - "Inventario de 9 emisores con evidencia archivo:línea y canal"
  - "Eras E1-E4 con denominador inclusivo explícito y rates recalculados"
  - "Declaración de las 9 fuentes de evidencia y su disponibilidad"
  - "01-AUDIT.json como fuente de verdad de agregados, sin cuerpos de mensajes"
affects: [01-02, 01-03, 02, 03, 04, 05, 06, 07, 08]

actuals:
  tokens: 16300
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Parser HTML de profundidad sobre stdlib, con lectura única de bytes y pin de sha256"
    - "TDD test-first por tarea con commits separados test → feat"
    - "JSON canónico determinista sin cuerpos de mensajes (solo agregados y metadatos)"

key-files:
  created:
    - scripts/audit/telegram_export.py
    - scripts/audit/noise_audit.py
    - scripts/audit/test_telegram_export.py
    - scripts/audit/test_noise_audit.py
    - scripts/audit/fixtures/telegram_export_sample.html
    - .planning/phases/01-auditor-a-del-ruido/01-AUDIT.json
  modified:
    - package.json
    - README.md

key-decisions:
  - "El rate se calcula sobre días inclusivos declarados (156/36/10/12), no sobre días con mensajes ni sobre el periodo completo"
  - "El export se lee una sola vez, se acota por tamaño y se valida por sha256 antes de parsear"
  - "Los agregados nunca serializan texto de mensajes; el NDJSON vive solo en /tmp/noise-audit/"
  - "El hub declara 0 mensajes de Telegram porque su canal es Web Push"

patterns-established:
  - "Auditoría stdlib-only: sin dependencias nuevas, sin red, sin ejecutar el export"
  - "Cada tarea deja tests RED committed antes del commit de implementación"
  - "Los números esperados del plan se afirman tanto contra fixtures sintéticos como contra el export real, con skipUnless"

requirements-completed: [AUDT-01]

coverage:
  - id: D1
    description: "Parser del export pinneado: 148 filas, 146 del bot, 2 del operador, 45 separadores, sin remitentes nulos"
    requirement: AUDT-01
    verification:
      - kind: unit
        ref: "scripts/audit/test_telegram_export.py"
        status: pass
    human_judgment: false
  - id: D2
    description: "Inventario de emisores con 10 familias (suma 146), 9 emisores, cubo unknown y evidencia archivo:línea"
    requirement: AUDT-01
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py"
        status: pass
    human_judgment: false
  - id: D3
    description: "Eras E1-E4 con 8/105/20/15 mensajes, denominadores 156/36/10/12 y rates 0,05/2,92/2,00/1,25"
    requirement: AUDT-01
    verification:
      - kind: unit
        ref: "scripts/audit/test_noise_audit.py"
        status: pass
      - kind: other
        ref: "python3 scripts/audit/noise_audit.py --export <export> --out-json 01-AUDIT.json --force"
        status: pass
    human_judgment: false
  - id: D4
    description: "Runbook de la auditoría en README con test:audit y audit:noise"
    requirement: AUDT-01
    verification: []
    human_judgment: true
    rationale: "La utilidad del runbook depende de que un lector humano pueda seguirlo; el contenido se revisa en la verificación de fase."

# Metrics
duration: 9min
completed: 2026-11-24
status: complete
---

# Phase 01 Plan 01: Inventario de emisores y dataset normalizado

**El export real de Telegram queda parseado y pinneado a 148 mensajes, con los 146 del bot clasificados en 10 familias, 9 emisores inventariados con evidencia y las eras E1-E4 publicando rates sobre denominador inclusivo declarado.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-11-24T18:23:00Z (aprox.)
- **Completed:** 2026-11-24T18:34:00Z (aprox.)
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- `telegram_export.py` valida el sha256 `fe32cd…be74`, los 76.936 bytes y la ventana 2026-04-25 → 2026-11-24 antes de parsear; 45 separadores de fecha no cuentan como mensajes y los 58 `joined` heredan remitente.
- `noise_audit.py` clasifica los 146 mensajes del bot en 95 `wud`, 31 `security-update`, 5 `release-stop`, 4 `release-apply`, 3 `issue-incident`, 2 `backup`, 2 `issue-test`, 2 `smart`, 1 `release-upgrade` y 1 `security-digest` → suma 146, con cubo `unknown` vacío pero explícito.
- El inventario publica 9 emisores con evidencia `archivo:línea`, el hub en canal `push` con 0 mensajes de Telegram y el emisor `unknown-smart` sin código localizable.
- Las eras E1–E4 publican 8/105/20/15 mensajes, 156/36/10/12 días inclusivos y rates 0,05/2,92/2,00/1,25, con `dataset.denominator_note` explicando la diferencia frente a 0,04/1,15 de CONTEXT.
- `evidence_sources` declara las 9 fuentes con `id`, `label`, `access`, `proves` y `status`: export/backup/security disponibles, outbox y failed-release denegados, docker logs en ventana corta, journal y alerts no disponibles.

## Task Commits

Cada tarea se commiteó atómicamente, con el test RED antes de la implementación:

1. **Task 1: Export pinneado, filas normalizadas y JSON de cobertura** - `6789822` (test) → `92d8943` (feat)
2. **Task 2: Clasificación e inventario de emisores con evidencia** - `3b12baa` (test) → `7904947` (feat)
3. **Task 3: Eras con denominador declarado y runbook en README** - `74f3e75` (test) → `ee38d59` (feat)

**Plan metadata:** `b982f08` (fix: descripción de evidencia sin la subcadena `text`)

## Files Created/Modified

- `scripts/audit/telegram_export.py` — parser HTML de profundidad, pin de hash, normalización de texto y escritura NDJSON.
- `scripts/audit/noise_audit.py` — firmas de clasificación, emisores, eras, fuentes de evidencia y CLI de agregados.
- `scripts/audit/test_telegram_export.py` — 10 pruebas de parser, hash, `joined`, `service`, `\n` literal, `tel:`, hora ausente y export real opcional.
- `scripts/audit/test_noise_audit.py` — 23 pruebas de clasificación, inventario, eras, evidencia y export real opcional.
- `scripts/audit/fixtures/telegram_export_sample.html` — fixture sintético sin datos personales ni títulos reales.
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json` — agregados canónicos sin cuerpos de mensajes.
- `package.json` — scripts `test:audit` y `audit:noise`.
- `README.md` — runbook de la auditoría.

## Decisions Made

- El rate usa días inclusivos declarados; se documenta el cambio frente a los 0,04/1,15 de CONTEXT sin alterar los conteos.
- El JSON de agregados excluye `text` por completo; el NDJSON intermedio no se versiona.
- El inventario conserva el emisor SMART desconocido como `unknown-smart` en vez de descartarlo.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] La frase de evidencia del export contenía la subcadena `text`**
- **Found during:** Verificación de cierre del plan
- **Issue:** el gate literal `assert "text" not in json.dumps(d)` fallaba por la palabra `texto` en `evidence_sources[export].proves`, aunque el JSON no tenía campo `text` ni cuerpos.
- **Fix:** se cambió la frase a "contenido de la ventana completa", se regeneró el JSON y se reejecutaron todos los gates.
- **Files modified:** `scripts/audit/noise_audit.py`, `01-AUDIT.json`
- **Verification:** `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` → 33 tests OK; regeneración determinista sin diff.
- **Committed in:** `b982f08`

---

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** Ninguno sobre el alcance ni los números; solo ajuste de redacción para que el gate literal del plan se cumpla.

## Issues Encountered

La ejecución se interrumpió por límite de uso justo después del commit `ee38d59`, antes de escribir este SUMMARY y actualizar STATE.md. El cierre se reconstruyó desde los commits y los artefactos ya commiteados (close-out manual del `safe_resume_gate`), sin reejecutar tareas ni duplicar commits.

## User Setup Required

None - no external service configuration required. La auditoría usa solo la stdlib de Python 3 y el export vive fuera del repositorio.

## Next Phase Readiness

`01-AUDIT.json` está listo como fuente de verdad para 01-02: contiene `dataset`, `sender_split`, `inventory` y `eras`, y los tests del export real corren (no se saltan) en esta máquina. 01-02 añadirá recuperaciones, duplicados, histograma, top de claves y ventanas de 30/60/90 días sobre el mismo JSON.

## Self-Check: PASSED

- `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` → 33 tests, OK.
- Todos los gates del plan (148/146/2/45, familias 146, eras 8/105/20/15 y 156/36/10/12, E4 1,25, 9 fuentes, alerts unavailable) pasan.
- `git ls-files '*.ndjson'` vacío; único HTML versionado es el fixture; `git -C ../media-stack status --porcelain` vacío; `src/` y `agent/` sin cambios.
