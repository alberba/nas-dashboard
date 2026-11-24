---
phase: 01-auditor-a-del-ruido
verified: 2026-11-24T19:38:26Z
status: passed
score: 23/23 must-haves verified
covered_files:
  - .planning/phases/01-auditor-a-del-ruido/01-01-PLAN.md
  - .planning/phases/01-auditor-a-del-ruido/01-01-SUMMARY.md
  - .planning/phases/01-auditor-a-del-ruido/01-02-PLAN.md
  - .planning/phases/01-auditor-a-del-ruido/01-02-SUMMARY.md
  - .planning/phases/01-auditor-a-del-ruido/01-03-PLAN.md
  - .planning/phases/01-auditor-a-del-ruido/01-03-SUMMARY.md
  - .planning/phases/01-auditor-a-del-ruido/01-AUDIT.json
  - .planning/phases/01-auditor-a-del-ruido/01-AUDIT.md
  - README.md
  - package.json
  - scripts/audit/fixtures/alerts_sample.csv
  - scripts/audit/fixtures/telegram_export_sample.html
  - scripts/audit/noise_audit.py
  - scripts/audit/telegram_export.py
  - scripts/audit/test_noise_audit.py
  - scripts/audit/test_telegram_export.py
covered_digest: "v4:sha256:127f021ca89e20071459e7462edc6cf08ce990493e923672b65971b812989cf2"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Revisar 01-AUDIT.md §Política de avisos y §Objetivo de éxito y aceptar, o pedir cambios, el mapa 9 immediate / 9 digest / 4 silent, el orden de apagado de cinco pasos y el objetivo de 1,0 mensajes proactivos/día; confirmar también que se acepta publicar la columna de push como — mientras no exista el CSV de alerts."
    expected: "El operador aprueba el mapa y el objetivo, o registra los cambios concretos; la fase no se cierra como passed hasta esa aceptación."
    why_human: "D-12 de 01-CONTEXT.md y la segunda fila de Manual-Only de 01-VALIDATION.md reservan la aceptación del mapa y del objetivo al juicio del operador; ningún test puede sustituir esa decisión."
---

# Phase 1: Auditoría del ruido Verification Report

**Phase Goal:** Producir el informe de ruido que fija la política: qué mensajes llegan, desde qué emisor, con qué frecuencia y qué proporción son recuperaciones o duplicados.
**Verified:** 2026-11-24T19:38:26Z
**Status:** passed
**Re-verification:** No — verificación inicial

## Goal Achievement

El objetivo se cumple en los artefactos: `01-AUDIT.json` y `01-AUDIT.md` publican los 148 mensajes del export (146 del bot y 2 del operador), la atribución por emisor y familia, la frecuencia por eras, los duplicados y las repeticiones, el histograma, las ventanas 30/60/90 y un mapa de política de 22 claves con orden de apagado y objetivo numérico. Las 23 verdades de los tres planes se reprodujeron contra el código y los artefactos, no contra los SUMMARY. No hay gaps de must-have. El mapa y el objetivo quedaron aprobados en la prueba de aceptación del operador (D-12).

### Observable Truths

| # | Plan | Truth | Status | Evidence |
|---|------|-------|--------|----------|
| 1 | 01 | El dataset declara `fe32cd…be74`, 76.936 bytes, 148 mensajes, 146 del bot y 2 del operador, y la ventana 2026-04-25 → 2026-11-24. | ✓ VERIFIED | `01-AUDIT.json#dataset` (`messages:148`, `bot_messages:146`, `operator_messages:2`, `first_at`, `last_at`); `shasum -a 256` del export real y `stat -f%z` = 76.936; pin en `scripts/audit/telegram_export.py:24`. |
| 2 | 01 | Los 45 separadores no cuentan como mensajes, los 58 `joined` heredan remitente y ninguna fila queda con remitente nulo. | ✓ VERIFIED | `dataset.date_separators:45`; parseo real: 148 filas, 58 `joined`, 90 con remitente propio y 0 remitentes nulos; `telegram_export.py:122-132,188-193`; tests `test_telegram_export.py:41-56`. |
| 3 | 01 | Cada mensaje del bot cae en una familia del catálogo o en `unknown`; familias + operador = total. | ✓ VERIFIED | `inventory.families` suma 146 en 10 familias (95/31/5/4/3/2/2/2/1/1) y `inventory.unknown: []`; 146 + 2 = 148; `noise_audit.py:603-669`. |
| 4 | 01 | El inventario nombra WUD, security-monitor, security-updater, upgrade.sh, merged_updates.py, copia, issue-automator y el SMART desconocido con conteo y evidencia `archivo:línea`; el hub declara 0 Telegram por Web Push. | ✓ VERIFIED | `inventory.emitters` (9 filas) con `evidence` tipo `stacks/monitoring/compose.yaml:78-96`, `stacks/backup/media-backup.sh:137-157`, etc.; `hub.messages:0`, `hub.channel:push`; `noise_audit.py:613-668`. |
| 5 | 01 | Las eras E1–E4 reproducen 8/105/20/15, declaran 156/36/10/12 días inclusivos y publican `rate = messages / inclusive_days`; E4 = 1,25/día. | ✓ VERIFIED | `eras` E1–E4 con esos mensajes, días y rates 0,05/2,92/2,00/1,25; 8/156, 105/36, 20/10, 15/12; `test_noise_audit.py:1027-1046`. |
| 6 | 01 | El JSON declara las fuentes de evidencia y distingue disponible, permiso denegado, ventana corta y no disponible; solo el export cubre la ventana de 30–90 días. | ✓ VERIFIED | `evidence_sources` con 9 fuentes y estados `available` (export y estados de copia/seguridad), `denied` (outbox y failed-release), `partial` (docker logs) y `unavailable` (journal, alerts); `export.proves` = "contenido de la ventana completa"; `noise_audit.py:531-599`; `EvidenceTest` en `test_noise_audit.py:1047-1102`. |
| 7 | 01 | Los tests de `scripts/audit` usan `unittest` y fixture sintético; el test contra el export real se salta si falta, nunca falla por ausencia. | ✓ VERIFIED | `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` → 116 tests, OK; `skipUnless(real_export_path().exists(), …)` en `test_telegram_export.py:174` y `test_noise_audit.py:294,436,664,716,759,816,887,938,1027,1245,1388,1616`; `package.json:15`. |
| 8 | 02 | El informe cuantifica 11 grupos WUD repetidos por contenedor y tag destino, con 14 mensajes extra. | ✓ VERIFIED | `repetitions.groups` = 11 y suma de `extra_messages` = 14; `noise_audit.py:1201-1235`; `RepetitionTest`. |
| 9 | 02 | Las recuperaciones de Telegram son 0 por construcción y 0 observadas; las del hub viven en `alerts.resolvedAt` y se publican como no medidas, nunca mezcladas. | ✓ VERIFIED | `recoveries.telegram` 146 mensajes, 120 aperturas, 26 informativos, 0 recuperaciones, ratio 0,0; `recoveries.hub_push.status:unavailable` con numéricos `null`; sin llave `total`; `noise_audit.py:839-866`. |
| 10 | 02 | El duplicado entre sistemas publica 14 mensajes WUD, 12 con el mismo tag, 13 revisiones manuales y 1 actualización real, contando una vez por mensaje WUD. | ✓ VERIFIED | `duplicates.inter_system`: `messages:14`, `same_target:12`, `manual_only:13`, `real_update:1`, `items` de longitud 14; `noise_audit.py:975-1060`; `DuplicateTest`. |
| 11 | 02 | El duplicado entre canales solo nombra la copia como candidata; sin CSV publica `null` y —, y con CSV calcula la latencia desde `alerts.at`. | ✓ VERIFIED | `inter_channel` `status:unavailable`, `duplicates:null`, `latency_s:null`, `candidates:["backup-failed"]`; ejecución independiente con `--alerts-csv scripts/audit/fixtures/alerts_sample.csv` → `status:measured`, latencia 1500 s desde `at`; `noise_audit.py:1063-1085`; `test_noise_audit.py:646-675`. |
| 12 | 02 | El histograma tiene 24 cubos, usa la hora de pared sin convertir y suma total − `missing_time`; E4 conserva 06:00 = 8. | ✓ VERIFIED | `histogram.buckets` 24 claves que suman 148; `missing_time:0`; `histogram.by_era.E4["6"] = 8` (máximo de E4); `noise_audit.py:1099-1121`; `test_noise_audit.py:677-710`. |
| 13 | 02 | El top 3 es determinista con desempate alfabético: `security:update` 31, `wud:tdarr` 15, `wud:radarr` 10. | ✓ VERIFIED | `top_keys` en ese orden y con esos volúmenes; `noise_audit.py:1123-1155`; `TopKeysTest`. |
| 14 | 02 | Los 95 WUD se agrupan en 51 pasadas con hueco ≤ 5 min; el ritmo por era se recalcula y E4 = 1,25/día. | ✓ VERIFIED | `wud_events.messages:95`, `passes` de longitud 51; `eras.E4.inclusive_days:12` y `rate:1.25`; `noise_audit.py:1157-1199`; `WudEventTest`. |
| 15 | 02 | Cada era publica `events` = pasadas WUD iniciadas en la era + mensajes no WUD; `events ≤ messages`, E2 62 < 105 y la suma es 102. | ✓ VERIFIED | `eras` events 6/62/19/15 y messages 8/105/20/15; suma de events = 102 = 51 + (146 − 95); `E2.events:62 < E2.messages:105`; `test_noise_audit.py:887-925`. |
| 16 | 02 | Cada ventana 30/60/90 publica `by_emitter` con nueve ids, `messages` y `rate = round(messages/inclusive_days, 2)`; la suma coincide y WUD publica 14/0,47, 95/1,58 y 95/1,06. | ✓ VERIFIED | `windows.30d/60d/90d` = 44/140/144; cada `by_emitter` tiene 9 ids y suma exactamente el total de la ventana; WUD 14/0,47, 95/1,58, 95/1,06; `noise_audit.py:1262-1300`; `WindowTest`. |
| 17 | 02 | Regenerar el mismo export produce el mismo JSON canónico y `--check-repro` lo demuestra comparando bytes ordenados. | ✓ VERIFIED | `python3 scripts/audit/noise_audit.py --export "$HOME/Downloads/ChatExport_NAS Monitor/messages.html" --check-repro` → `{"reproducible": true}`, exit 0; `check_repro` agrega dos veces y compara `canonical_json` en `noise_audit.py:2263-2271`. |
| 18 | 03 | Las 12 claves reales del hub y las 10 familias de Telegram tienen exactamente una disposición; no hay huérfanas ni duplicadas y el total es 22. | ✓ VERIFIED | `policy.buckets` 9/9/4 = 22 y `total_keys:22`; 12 claves hub contrastadas con `src/lib/collector.ts:136,170,180,189,199,212` y `src/lib/maintenance-alerts.ts:69,89,112,137,179,226`; 10 familias de Telegram; `noise_audit.py:1524-1544`; `PolicyMapTest`. |
| 19 | 03 | WUD queda en silent y la copia en immediate; el éxito de seguridad/release va a digest y el fallo o manual review a immediate. | ✓ VERIFIED | `policy.buckets.silent` contiene `wud`; `immediate` contiene `backup`; `security-update.split_by_outcome` = failed→immediate, manual→immediate, updated→digest; `release-apply` = failed→immediate, applied→digest; `noise_audit.py:1524-1544`. |
| 20 | 03 | El apagado es upgrade.sh, merged_updates.py, security-updater, security-monitor y WUD; la copia no se apaga sino que se estrecha a `backup-failed` con origen propio; issue-automator y SMART quedan fuera de alcance para la fase 8. | ✓ VERIFIED | `shutdown_order.order` = 5 pasos en ese orden; `narrowed` = backup → backup-failed, `origin:"media-stack backup"`, `SEC-06`, `PITFALLS #24`; `out_of_scope` = issue-automator y unknown-smart con `revisit:"phase 8"`; `noise_audit.py:1301-1335`; `ShutdownOrderTest`. |
| 21 | 03 | El objetivo es numérico sobre E4 = 1,25/día y propone 1,0 proactivos/día; el ack se define como mediana(sentAt → ackAt) por severidad con guardia p90 y se publica como — porque no hay evento de ack. | ✓ VERIFIED | `success_target`: `baseline_messages_per_day:1.25`, `proactive_messages_per_day:1.0`, `window_days:14`; `ack.current:null`, `status:"not_measurable"`, `guard:"p90"`, `p90_guard_minutes:60`; el MD imprime `Valor actual | —`; `noise_audit.py:1545-1580`; `SuccessTargetTest`. |
| 22 | 03 | La tendencia marca `16d824e`, `d6831af`, `38061f0` y WUD 9.8.0 (`cc8d8a3`), y separa E3a (3–7 nov) de E3b (8–12 nov). | ✓ VERIFIED | `trend.markers` con 4 ids, fechas y `date_only:false`; `trend.eras.E3a` 11 mensajes / 4 WUD (2026-11-03…07) y `E3b` 9 mensajes (2026-11-08…12); `noise_audit.py:1436-1461`; `TrendTest`. |
| 23 | 03 | `01-AUDIT.md` se renderiza desde el JSON, declara el denominador inclusivo, muestra — en push y ack y no contiene cuerpos completos de mensajes. | ✓ VERIFIED | 15 secciones (`resumen`…`reproducibilidad`) renderizadas por `render_report`; `--check-report` → `{"report_matches": true}`, exit 0; denominador inclusivo en §Resumen/§Supuestos; push y ack con —; 0 cuerpos de ≥ 12 caracteres y 0 fragmentos de 8 palabras del export aparecen en JSON/MD; sin `/Users/`, sin `"text"` y sin el nombre del operador; `noise_audit.py:2221-2260`; `test_noise_audit.py:928,1492,1617`. |

**Score:** 23/23 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/audit/telegram_export.py` | Parser pinneado del export | ✓ VERIFIED | 255 líneas; lee una vez, valida sha256/bytes, normaliza fechas, `joined`, `tel:`, texto sin hora; escritura NDJSON privada. |
| `scripts/audit/noise_audit.py` | Agregados, política e informe | ✓ VERIFIED | 2.504 líneas; CLI con `--check-report`, `--check-repro`, `--alerts-csv`, `--out-md`; sin red ni PostgreSQL. |
| `scripts/audit/test_telegram_export.py` | Tests del parser | ✓ VERIFIED | 10 pruebas; fixture sintético y export real con `skipUnless`. |
| `scripts/audit/test_noise_audit.py` | Tests de agregados e invariantes | ✓ VERIFIED | 106 pruebas; suite total 116 OK. |
| `scripts/audit/fixtures/telegram_export_sample.html` | Fixture sintético | ✓ VERIFIED | Único HTML versionado bajo `scripts/audit`; sin datos reales. |
| `scripts/audit/fixtures/alerts_sample.csv` | CSV sintético de alerts | ✓ VERIFIED | 4 filas con cabecera `hostId,key,severity,at,resolvedAt`; permite probar el bloque medido. |
| `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json` | Agregados canónicos | ✓ VERIFIED | 21 secciones; sin `text` ni cuerpos; `report.source_hash` = sha256 del export. |
| `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` | Informe de 15 secciones | ✓ VERIFIED | Renderizado desde el JSON; privacidad y cifras comprobadas. |
| `package.json` | Scripts `test:audit` y `audit:noise` | ✓ VERIFIED | Líneas 15–16; sin dependencias nuevas. |
| `README.md` | Runbook de la auditoría | ✓ VERIFIED | Línea 157 documenta export externo, `/tmp/noise-audit` y los scripts; sin setup externo. |

**Artifacts:** 10/10 verified

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `noise_audit.py` | `telegram_export.py` | `parse_export` / `parse_export_document` | ✓ WIRED | `noise_audit.py` importa y usa el parser en `aggregate` y `check_repro`. |
| `noise_audit.py` | `01-AUDIT.json` | `aggregate(...)` + `canonical_json(...)` | ✓ WIRED | CLI escribe el JSON en `main`; `check_repro` usa la misma agregación. |
| `noise_audit.py` | `01-AUDIT.md` | `build_report_model` + `render_report` | ✓ WIRED | `--out-md` renderiza el modelo; `--check-report` reconstruye desde el agregado y compara bytes. |
| `noise_audit.py` | `src/lib/collector.ts` / `maintenance-alerts.ts` | `HUB_KEYS` | ✓ WIRED | Las 12 claves del mapa coinciden con las 12 claves reales del hub. |
| `test_telegram_export.py` | fixture HTML | `Path(__file__).parent / "fixtures"` | ✓ WIRED | Pruebas sintéticas sobre el fixture versionado. |
| `test_noise_audit.py` | fixture alerts CSV | `load_alerts_csv` | ✓ WIRED | Prueba y ejecución independiente con el CSV. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `01-AUDIT.json` | `dataset`, `inventory`, `eras`, `recoveries`, `duplicates`, `histogram`, `windows` | Export HTML real (sha256 pinneado) | Sí — 148 filas parseadas y contadas | ✓ FLOWING |
| `01-AUDIT.md` | `report.sections` | `build_report_model(aggregate)` | Sí — 15 secciones desde el JSON, no copy hardcodeado | ✓ FLOWING |
| `recoveries.hub_push` | `alerts.resolvedAt` | CSV externo opcional | No por defecto (D-03), pero el camino medido funciona con el fixture | ✓ WIRED (condicionado) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Suite de auditoría | `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` | 116 tests, OK | ✓ PASS |
| Informe coherente | `python3 scripts/audit/noise_audit.py --check-report --out-json .planning/phases/01-auditor-a-del-ruido/01-AUDIT.json --out-md .planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` | `{"report_matches": true}`, exit 0 | ✓ PASS |
| Deriva detectada | Copia en `/tmp` con `dataset.messages=9999` + mismo MD, `--check-report` | `{"report_matches": false}`, exit 1 | ✓ PASS |
| Reproducibilidad | `python3 scripts/audit/noise_audit.py --export "$HOME/Downloads/ChatExport_NAS Monitor/messages.html" --check-repro` | `{"reproducible": true}`, exit 0 | ✓ PASS |
| Push medido con CSV | `--alerts-csv scripts/audit/fixtures/alerts_sample.csv --out-json /tmp/… --out-md /tmp/…` | `hub_push` `measured` 4 aperturas / 2 recuperaciones; MD publica las cifras y deja de decir "no disponible" | ✓ PASS |
| Permisos del NDJSON | Prueba de `write_ndjson` | Directorio 0700, fichero 0600, `O_NOFOLLOW` | ✓ PASS |
| Suite de la app | `pnpm test` | 167 passed, 108 skipped, exit 0 | ✓ PASS |

### Probe Execution

No hay probes de shell declarados (`scripts/*/tests/probe-*.sh`) ni mencionados en los planes o SUMMARY; Step 7c no aplica.

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| — | — | Sin probes declarados | N/A |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| AUDT-01 | 01-01, 01-02 | Informe con mensajes/día por emisor de los últimos 30–90 días (WUD, security-monitor, copia, issue-automator, upgrade, hub). | ✓ SATISFIED | `windows.30d/60d/90d` con 44/140/144 mensajes y `by_emitter` de 9 ids (incluye `wud`, `security-monitor`, `backup`, `issue-automator`, `upgrade-script`, `hub`); inventario completo. |
| AUDT-02 | 01-02 | Separa aperturas de recuperaciones y cuantifica duplicados push + Telegram con latencia. | ✓ SATISFIED (condicionado) | Telegram: 120 aperturas / 26 informativos / 0 recuperaciones; entre sistemas: 14/12/1/13 y latencia mínima 39 min. El bloque push/Telegram queda `unavailable` por D-03 (sin acceso a `alerts`), publica `null`/— explícito y el adaptador con CSV se verificó (`measured`, latencia desde `alerts.at`); no se mezcla con Telegram. |
| AUDT-03 | 01-02 | Distribución horaria y top 3 de claves por volumen. | ✓ SATISFIED | Histograma de 24 cubos (suma 148, E4 06:00 = 8) y top 3 `security:update` 31 / `wud:tdarr` 15 / `wud:radarr` 10. |
| AUDT-04 | 01-03 | Mapa definitivo inmediata/digest/silenciosa y orden de apagado de emisores de `media-stack`. | ✓ SATISFIED | 22 claves en 9/9/4 sin duplicados; 5 pasos de apagado; copia estrechada; 2 emisores fuera de alcance. |
| AUDT-05 | 01-03 | Objetivo de éxito medido: mensajes proactivos/día y tiempo hasta reconocer. | ✓ SATISFIED | 1,0 proactivos/día sobre E4 = 1,25/día; ack definido (mediana por severidad, guardia p90) y publicado como — con `current:null`. |

**Coverage:** 5/5 requirements accounted for; 0 orphaned (AUDT-01…05 son los únicos IDs de la fase).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | Sin `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/placeholder en los archivos de la fase | — | Sin blockers ni warnings |
| `01-AUDIT.md` | 16, 27, 96–99, 311, 321 | Mezcla de separadores decimales (`1.0`/`1.25` junto a `0,05`) | ℹ️ Info | Cosmético; IN-02 está registrado como `skipped` en `01-REVIEW-DISPOSITION.md` y no cambia ninguna cifra |
| `01-AUDIT.md` | 1 | El título usa "NAS Monitor", nombre del producto y display del bot, no el nombre personal del operador | ℹ️ Info | No es una fuga: no aparece "Albert Salom Vanrell", ni cuerpos, ni rutas `/Users/`; la prohibición de privacidad se cumple |

**Anti-patterns:** 0 blockers, 0 warnings, 2 informativos.

### Code Review Fix Verification

| Finding | Disposition claimed | Independent check |
|---------|---------------------|-------------------|
| WR-01 NDJSON world-readable / symlink | fixed | `telegram_export.py:243-255` crea directorio 0700, fichero 0600 y `O_NOFOLLOW`; `test_telegram_export.py:171-172` afirma modos. |
| WR-02 `--check-report` trusts snapshot | fixed | `noise_audit.py:2254-2260` reconstruye `build_report_model(data)` y compara `data["report"] == model` y el MD; copia con `dataset.messages=9999` devuelve `false`/exit 1. |
| WR-03 push narrative hardcoded | fixed | `build_report_model` ramifica por `hub_push.status` y `push.status`; ejecución con CSV publica `measured` y las cifras; sin CSV mantiene —. |
| WR-04 inventory flags contradict decisions | fixed | `build_inventory` deriva `can_emit_recovery` de `RECOVERY_CAPABLE` y `in_cutover` de `build_shutdown_order` (`noise_audit.py:645-659`); test de consistencia `test_noise_audit.py:224-267`. |
| WR-05 parser drops text-less / inherits sender | fixed | `telegram_export.py:122-132` cierra la fila anterior al abrir el siguiente mensaje y `close()`; `:188-193` solo hereda en `joined` y lanza si falta; tests `:122-168`. |
| WR-06 `resolvedAt < at` accepted | fixed | `load_alerts_csv` lanza y cuenta la fila en `skipped_rows` (`noise_audit.py:906-912`); test `:479-502`. |
| IN-01 dash assertions / Spanish copy | fixed | `test_noise_audit.py:1499-1546` fija celdas y `None`; la prueba del denominador usa valores, no la palabra "inclusivos". |
| IN-02 decimal separators | skipped | Confirmado cosmético; no rompe ningún must-have (ver Anti-Patterns). |
| IN-03 time-less rows joined as midnight | fixed | `_inter_system` (`:994-1000`) y `join_push_windows` (`:943`) saltan `time is None`; tests `:503-515,616-630`. |

### Privacy and Scope Checks

| Check | Command | Result |
|-------|---------|--------|
| Export real coincide con el pin | `shasum -a 256 "$HOME/Downloads/ChatExport_NAS Monitor/messages.html"` | `fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74`, 76.936 bytes |
| Sin NDJSON versionado | `git ls-files '*.ndjson'` | Vacío |
| Único HTML versionado | `git ls-files 'scripts/audit/**/*.html'` | Solo el fixture sintético |
| Sin cambios de producto | `git diff --name-only -- src agent` | Vacío |
| `media-stack` intacto | `git -C ../media-stack status --porcelain` | Vacío |
| Sin dependencias nuevas | `git diff --name-only -- pnpm-lock.yaml` | Vacío |
| Sin rutas del operador | Búsqueda de `/Users/` en JSON/MD | 0 apariciones |
| Sin cuerpos ni nombres personales | Comparación de cada `text` (≥ 12 caracteres) y ventanas de 8 palabras contra JSON/MD; búsqueda de nombres | 0 fugas; el nombre del operador no aparece |
| Sin la clave `text` | `'"text"' in 01-AUDIT.json` | `False` |

### Human Verification

#### 1. Aceptación del mapa de política y del objetivo de éxito

**Resultado:** Aprobado. El registro de aceptación documenta el orden delegado
y el tratamiento del push histórico. [01-UAT.md](01-UAT.md)

**Test:** Leer `01-AUDIT.md` §Política de avisos y §Objetivo de éxito. Aceptar o pedir cambios sobre: (a) el mapa de 22 claves con 9 immediate / 9 digest / 4 silent, incluido WUD en silent y la copia en immediate; (b) el orden de apagado de cinco pasos con la copia estrechada a `backup-failed`; (c) el objetivo de 1,0 mensajes proactivos/día sobre una línea base E4 de 1,25/día; (d) que la columna de push siga publicada como — hasta disponer del CSV de `alerts`.
**Expected:** El operador aprueba el conjunto o registra los cambios concretos. Si pide cambios, se abre una ronda de ajuste antes de dar la fase por cerrada.
**Why human:** D-12 de `01-CONTEXT.md` y la fila "The final immediate/digest/silent map and the success target are acceptable to the operator" de `01-VALIDATION.md` reservan esta aceptación al juicio del operador. Es la única decisión que ningún test puede sustituir; el resto de la validación manual (prosa, privacidad y coherencia del informe) la realizó el verificador y pasó.

### Gaps Summary

**No gaps found.** Las 23 verdades de los tres planes, los 10 artefactos, los 6 enlaces clave y los 5 requisitos AUDT se verificaron contra el código, el JSON, el Markdown y el export real. No hay blockers, deuda marker ni must-have incumplido.

Dos matices quedan registrados, ninguno como gap:

1. El bloque de duplicado push/Telegram está `unavailable` porque no hay CSV de `alerts` (D-03). El informe no inventa la cifra: publica `null`/—, nombra la copia como única candidata y el adaptador mide correctamente cuando se le pasa el fixture. La aceptación de esta limitación forma parte de la decisión humana.
2. IN-02 (separadores decimales) sigue `skipped` por decisión de la revisión; es cosmético y no altera ninguna cifra ni must-have.

---

_Verified: 2026-11-24T19:38:26Z_
_Verifier: the agent (gsd-verifier)_
