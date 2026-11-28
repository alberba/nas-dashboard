---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "07"
subsystem: infra
tags: [media-stack, issue-automator, seerr, hmac, ingest, python, webhook]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: "Contrato v1 del ingest firmado (08-01) y variables NOTIFY_INGEST_* del catalogo (08-06)"
provides:
  - "issue-automator publica la apertura (issue:seerr:<id>, eventId issue:<id>:open) y el cierre (issue:<id>:resolved) de cada issue de Seerr en el ingest del hub, firmados con HMAC-SHA256"
  - "Enrutado por tipo de notificacion: ISSUE_RESOLVED no ejecuta ninguna accion, TEST_NOTIFICATION y /test no envian nada, otros tipos explicitos se ignoran"
  - "Costura build_issue_event / deliver_issue_event para la bandeja durable de 08-15"
  - "issue-automator sin ningun camino a Telegram"
affects: [08-15, 08-10, 08-09]

actuals:
  tokens: 6000
  tasks: 3
  commits: 5

plan_head_before: 7cba1ae
plan_head_after: a41d829

tech-stack:
  added: []
  patterns:
    - "Evento serializado una sola vez (bytes) y firmado en cada entrega con marca de tiempo nueva: lo enviado es exactamente lo firmado"
    - "api_request falso con enrutado por URL y servidor HTTP real en el puerto 0 para probar el manejador del webhook"
    - "Vector de contrato compartido con el hub y con media-backup como oraculo de firma"

key-files:
  created: []
  modified:
    - ../media-stack/stacks/extras/issue-automator/main.py
    - ../media-stack/stacks/extras/compose.yaml
    - ../media-stack/tests/issue-automator.test.sh
    - ../media-stack/docs/profiles.md

key-decisions:
  - "P-22: process_webhook_payload enruta por notif_type; ISSUE_RESOLVED publica el cierre y vuelve antes de cualquier consulta; TEST_NOTIFICATION/test responden ok sin salida; ISSUE_CREATED y sin tipo ejecutan la automatizacion; cualquier otro tipo explicito responde ignored"
  - "P-23: build_issue_event serializa el cuerpo una vez con eventId estable y deliver_issue_event hace un unico intento firmado, True solo con 2xx; sin reintentos en proceso (los aporta la bandeja de 08-15)"
  - "P-24: NOTIFY_INGEST_URL, NOTIFY_INGEST_SECRET y NOTIFY_INGEST_HOST_ID van juntas o ninguna (ConfigError con los nombres que faltan); sin ninguna el servicio arranca y avisa en el registro; load_config devuelve ingest en lugar de telegram"
  - "Un id de issue que no son 1 a 9 digitos no se publica (numeric_issue_id), para no emitir una clave que el hub rechazaria con 422"
  - "Un cierre sin id numerico responde ok con published false y registra el error, sin efectos"

patterns-established:
  - "Textos hacia el hub: etiquetas HTML fuera, espacios colapsados y truncados a los topes del esquema (200, 100, 300, 500) con plain_text"

requirements-completed: [CONT-02]

coverage:
  - id: D1
    description: "ISSUE_CREATED ejecuta la automatizacion de siempre y publica una apertura firmada con clave issue:seerr:<id>, eventId issue:<id>:open y datos sin HTML ni excesos de longitud; la firma coincide con un HMAC estandar"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_a_created_issue_runs_the_automation_and_publishes_one_opening"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_the_signature_is_the_standard_hmac_over_timestamp_and_body"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_published_text_carries_no_markup"
        status: pass
    human_judgment: false
  - id: D2
    description: "ISSUE_RESOLVED publica un solo cierre y no llama a Seerr, Radarr, Sonarr ni Bazarr; los tipos de prueba y otros tipos no producen peticiones"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_a_resolved_issue_publishes_one_closing_and_runs_no_automation"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_test_notifications_send_nothing_anywhere"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_other_notification_types_are_ignored_without_effects"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_the_test_endpoint_answers_200_and_sends_nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "Un fallo de entrega (401, 409, 422, 500, red o excepcion) es un solo intento y el webhook sigue respondiendo 200 con published false"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_a_failed_delivery_is_one_attempt_and_the_webhook_still_answers_200"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Publish.test_an_unexpected_error_in_the_delivery_does_not_break_the_webhook"
        status: pass
    human_judgment: false
  - id: D4
    description: "El vector de contrato de 08-01 (bytes y firma fijos) lo reproduce la implementacion; el secreto y el cuerpo firmado no aparecen en registro ni respuesta"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#ContractVector.test_the_signature_is_the_contract_one"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Secrecy.test_neither_the_secret_nor_the_body_reach_the_log_or_the_response"
        status: pass
    human_judgment: false
  - id: D5
    description: "Configuracion NOTIFY_INGEST_* (tres o ninguna), compose sin TELEGRAM_*, y documentacion de Issue Resolved en Seerr"
    requirement: CONT-02
    verification:
      - kind: other
        ref: "python3 scripts/env_contract.py check && scripts/check.sh fast"
        status: pass
    human_judgment: true
    rationale: "La redaccion de docs/profiles.md y la prueba con una issue real de Seerr (abrir y cerrar contra el hub desplegado) se hacen en la puerta humana 08-10"

duration: 25min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 07: issue-automator publica issues en el ingest del hub Summary

**issue-automator abre y cierra cada issue de Seerr en el hub con eventos firmados HMAC-SHA256 de la biblioteca estandar (`issue:seerr:<id>`, eventId estable por transicion), enruta por tipo de notificacion para que un cierre nunca dispare la lista negra y ya no tiene ningun camino a Telegram.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-11-28
- **Tasks:** 3 (5 commits: tracer, RED+GREEN de la tarea 2, RED+GREEN de la tarea 3)
- **Files modified:** 4 (todos en `../media-stack`, rama `phase-08-cutover`)

## Enrutado por tipo tal como quedo (`process_webhook_payload`)

| `notification_type` (o `event`) | Efecto | Respuesta |
| --- | --- | --- |
| `TEST_NOTIFICATION`, `test` | ninguno, sin peticiones salientes | `ok` |
| `ISSUE_RESOLVED` | publica `resolved` con `data` vacio; vuelve antes de `get_seerr_issue` y de cualquier manejador | `ok` + `published` |
| `ISSUE_CREATED` o sin tipo | automatizacion de siempre (Seerr, Radarr/Sonarr, Bazarr, comentario) y apertura publicada | `success` + `published` |
| cualquier otro (p. ej. `ISSUE_COMMENT`, `ISSUE_REOPENED`) | ninguno | `ignored` |

`/webhook` responde siempre 200 tras un JSON valido, tambien con la entrega fallida. `/test` responde 200 con `{"status":"ok","ingest_configured":<bool>}` y no envia nada.

## Contrato de publicacion

- `POST NOTIFY_INGEST_URL`, `Content-Type: application/json`, `X-Ingest-Timestamp` (`int(time.time())`) y `X-Ingest-Signature: v1=<hex>`; firma `HMAC-SHA256(secreto, "<timestamp>.<cuerpo>")`.
- Cuerpo, bytes exactos de `ingest_body`: JSON compacto (`separators=(",", ":")`) con orden `v`, `source` (`issue-automator`), `eventId`, `hostId`, `key` (`issue:seerr:<id>`), `state` (`open`|`resolved`), `data`. En la apertura `data` lleva `subject` (200), `reportedBy` (100), `problem` (300) y `action` (500), sin etiquetas y con espacios colapsados; en el cierre `{}`.
- `eventId`: `issue:<id>:open` / `issue:<id>:resolved`. El id se valida con `numeric_issue_id` (1 a 9 digitos); si no, no se publica y se registra.
- Confirmacion: solo un 2xx. El vector de 08-01 (`4525b516...eada1`) lo reproduce `sign_ingest` y esta fijado en `ContractVector`.

## Costura para 08-15

- `build_issue_event(issue_id, state, data)` -> `{"issue_id", "state", "event_id", "body"}` con el cuerpo ya serializado (bytes) y el `eventId` calculado una vez.
- `deliver_issue_event(event)` -> `bool`: firma `event["body"]` con una marca de tiempo nueva, hace un intento y devuelve True solo con 2xx; captura excepciones inesperadas y registra solo el tipo.
- `publish_issue_event(issue_id, state, data)`: construye y entrega; sin `ingest` registra una advertencia y devuelve False. **08-15 sustituye la llamada a `deliver_issue_event` dentro de `publish_issue_event` por el encolado durable**; la bandeja guarda `body` y llama a `deliver_issue_event` en cada reintento sin cambiar el contrato ni el `eventId` (un reintento es un 200 duplicado en el hub).

## Task Commits

Todos en `../media-stack`, rama `phase-08-cutover` (base `7cba1ae`, sin tocar `main`, sin push):

1. **Task 1 (tracer): apertura firmada, sin Telegram** - `4340326` (feat)
2. **Task 2 RED: cierre, tipos ignorados y fallo de entrega** - `455491f` (test)
3. **Task 2 GREEN: cierre en el hub y enrutado por tipo** - `ee8a64c` (feat)
4. **Task 3 RED: vector, secreto fuera del registro, excepcion en la entrega** - `c7af5bf` (test)
5. **Task 3 GREEN: entrega a prueba de excepciones y documentacion de Issue Resolved** - `a41d829` (feat)

**Ultimo commit de `phase-08-cutover`: `a41d829`.** (`main` de media-stack sigue en `0d920ca`.)

### Evidencia RED

- Tarea 2: 3 fallos de asercion sobre el comportamiento objetivo (`test_a_resolved_issue_publishes_one_closing_and_runs_no_automation`: `'open' != 'resolved'`; `test_a_resolved_issue_id_can_come_from_any_of_the_three_places`; `test_other_notification_types_are_ignored_without_effects`: `'success' != 'ignored'`). Evaluacion semantica: los tres tests se ejecutaron y fallaron por la razon prevista (el cierre aun abria y los tipos desconocidos aun ejecutaban la automatizacion).
- Tarea 3: 1 error en `test_an_unexpected_error_in_the_delivery_does_not_break_the_webhook` (`RuntimeError: boom` propagada por el webhook). Los casos del vector y del registro nacieron en verde porque `ingest_body`, `sign_ingest` y `api_request` ya cumplian el contrato desde la tarea 1; son pruebas de bloqueo (regresion), no de comportamiento nuevo.

## Deviations from Plan

None - plan executed exactly as written. Ajustes menores dentro del alcance: un cierre sin id numerico responde `ok` con `published: false` (el plan no lo especificaba); `numeric_issue_id` valida el id contra el esquema del hub antes de publicar; las pruebas del manejador usan un servidor HTTP real en el puerto 0 para comprobar el codigo 200 del webhook y de `/test`.

## Verification

- `bash tests/issue-automator.test.sh` en `ubuntu:24.04`: 36 tests, OK (python3 3.12 del contenedor).
- `python3 scripts/env_contract.py check` y `scripts/check.sh fast`: exit 0.
- Criterios: `send_telegram` x0, `api.telegram.org` x0, `TELEGRAM_BOT_TOKEN` en el compose x0, `ISSUE_RESOLVED` x2 en `main.py`, `NOTIFY_INGEST` en `docs/profiles.md` presente.
- `git -C ../media-stack diff --stat` por tarea: solo ficheros de `files_modified`; `docs/profiles.md` solo cambia la seccion de issue-automator (WUD, security-monitor y la tabla de Telegram intactos, los cambia 08-09).

## Known Stubs

None.

## Threat Flags

None. T-08-20 (cierre o comentario que reejecuta la automatizacion) y T-08-21 (secreto o cuerpo en registro y respuesta) estan mitigados y cubiertos por pruebas; T-08-22 se acepta como en el plan; T-08-SC: sin paquetes nuevos, solo `hmac`, `hashlib`, `time` y `re` de la biblioteca estandar.

## Notes for 08-15 and 08-10

- 08-15: la rama no se integra antes de que la bandeja durable sustituya la entrega de un solo intento; hasta entonces un fallo de entrega solo se registra.
- 08-10: la instancia necesita `NOTIFY_INGEST_URL` (alcanzable desde el contenedor), `NOTIFY_INGEST_SECRET` (el del hub) y `NOTIFY_INGEST_HOST_ID`; en Seerr hay que marcar tambien **Issue Resolved**. Verificacion real pendiente: issue de prueba, abrir y cerrar.
- Integrar `phase-08-cutover` en `main` de `media-stack` despliega (ADR-0007): no se hizo aqui.
- `CONT-02` no se marca como completado aqui: lo declaran tambien planes aun sin SUMMARY (08-02, 08-03, 08-10, 08-15); lo marca el orquestador al cerrar el ultimo.

## Self-Check: PASSED

- Commits `4340326`, `455491f`, `ee8a64c`, `c7af5bf` y `a41d829` existen en `phase-08-cutover` de `media-stack` (`git rev-list --count 7cba1ae..HEAD` = 5).
- Los 4 ficheros de `files_modified` cambiados y el arbol de `media-stack` limpio.
