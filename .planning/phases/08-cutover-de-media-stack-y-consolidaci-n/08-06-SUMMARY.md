---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "06"
subsystem: infra
tags: [media-stack, backup, hmac, ingest, telegram, bash, jq, openssl]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: "Contrato v1 del ingest firmado (08-01), consumido aqui como productor"
provides:
  - "media-backup.sh publica backup-failed firmado en el ingest del hub, con 3 intentos y mismo eventId"
  - "Aviso directo de Telegram como ultimo recurso, solo para backup-failed, con prefijo fijo y token fuera de argv"
  - "media-backup notify-test ingest|fallback para verificar cada camino sin un fallo real"
  - "NOTIFY_INGEST_URL, NOTIFY_INGEST_SECRET y NOTIFY_INGEST_HOST_ID en catalogo, plantilla, .env.example y compose de la copia"
affects: [08-10, 08-03, 08-07, 08-09]

actuals:
  tokens: 35000
  tasks: 3
  commits: 3

plan_head_before: 0d920ca
plan_head_after: 7cba1ae

tech-stack:
  added: ["jq (apk)", "openssl (apk)"]
  patterns:
    - "Evento firmado: jq -nc --arg construye el cuerpo, openssl dgst -hmac firma <timestamp>.<cuerpo>, curl --data-binary @- envia los mismos bytes"
    - "Token de Telegram por curl -K - (entrada estandar), nunca en argv"
    - "curl falso con codigos por intento y oraculo HMAC independiente en Python"

key-files:
  created: []
  modified:
    - ../media-stack/stacks/backup/media-backup.sh
    - ../media-stack/stacks/backup/Dockerfile
    - ../media-stack/stacks/backup/compose.yaml
    - ../media-stack/env/catalog.json
    - ../media-stack/env/instance.example.template
    - ../media-stack/.env.example
    - ../media-stack/tests/backup.test.sh
    - ../media-stack/docs/backup.md
    - ../media-stack/docs/backup.en.md

key-decisions:
  - "P-18: INGEST_RETRY_DELAYS por defecto 0 30 60; las pruebas fijan 0 0 0; cada intento recalcula marca de tiempo y firma y reutiliza backup-failed:<epoca>"
  - "P-19: solo un 2xx confirma (401, 409, 422, 5xx y red cuentan como fallo); el secreto HMAC queda unos milisegundos en argv de openssl dentro del contenedor (T-08-19, aceptado), nunca en el de curl"
  - "P-20: notify-test ingest abre y cierra con eventId backup-failed:test-<epoca>:open y :resolved; notify-test fallback envia un directo con marcador de prueba y sale 1 si no se pudo enviar"
  - "P-21: la tarea 3 toca 5 ficheros a mano mas .env.example generado, sin dividir"
  - "direct_notice devuelve 1 si no hay Telegram o curl falla; report_failure ignora ese estado y la copia sigue saliendo con 1"

patterns-established:
  - "Un solo camino directo permitido en media-stack: direct_notice, llamado solo desde report_failure (fallo) y notify-test"

requirements-completed: [SEC-06, CONT-02]

coverage:
  - id: D1
    description: "Una copia fallida publica un evento firmado en el ingest y no envia nada a Telegram con un 2xx; la firma coincide con un oraculo HMAC en Python"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/backup.test.sh#test_failed_backup_publishes_a_signed_event_and_skips_telegram"
        status: pass
    human_judgment: false
  - id: D2
    description: "Hasta 3 intentos con el mismo eventId y un unico aviso directo solo si ningun intento recibe 2xx; una copia correcta nunca envia"
    requirement: SEC-06
    verification:
      - kind: integration
        ref: "tests/backup.test.sh#test_a_retry_reuses_the_event_and_a_late_2xx_sends_no_direct_notice"
        status: pass
      - kind: integration
        ref: "tests/backup.test.sh#test_without_any_2xx_the_backup_sends_one_direct_notice"
        status: pass
      - kind: integration
        ref: "tests/backup.test.sh#test_a_successful_backup_never_notifies_anyone"
        status: pass
    human_judgment: false
  - id: D3
    description: "El token de Telegram solo viaja por la configuracion de curl en la entrada estandar; el cuerpo se construye con jq y no puede romperse con texto de errores"
    requirement: SEC-06
    verification:
      - kind: integration
        ref: "tests/backup.test.sh#test_without_any_2xx_the_backup_sends_one_direct_notice"
        status: pass
      - kind: integration
        ref: "tests/backup.test.sh#test_error_text_cannot_break_or_extend_the_event"
        status: pass
    human_judgment: false
  - id: D4
    description: "notify-test ingest abre y cierra una incidencia de prueba; notify-test fallback envia un aviso directo; otro uso sale con 2"
    verification:
      - kind: integration
        ref: "tests/backup.test.sh#test_notify_test_ingest_opens_and_closes_a_test_incident"
        status: pass
    human_judgment: false
  - id: D5
    description: "Contrato de entorno al dia y duplicado conocido documentado en docs/backup.md y docs/backup.en.md"
    requirement: CONT-02
    verification:
      - kind: other
        ref: "python3 scripts/env_contract.py check && scripts/check.sh fast"
        status: pass
    human_judgment: true
    rationale: "La redaccion de la documentacion y la verificacion real contra el hub y Telegram de produccion se hacen en la puerta humana 08-10"

duration: 25min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 06: Aviso de copia fallida por el ingest del hub Summary

**media-backup publica un `backup-failed` firmado con HMAC-SHA256 (jq + openssl + curl) con 3 intentos y el mismo eventId, y solo cae a un aviso directo de Telegram, con prefijo fijo y el token por stdin, si el hub no confirma con un 2xx.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-11-28
- **Tasks:** 3
- **Files modified:** 9 (todos en `../media-stack`, rama `phase-08-cutover`)

## Contrato de publicacion tal como quedo

- `POST $NOTIFY_INGEST_URL`, `Content-Type: application/json`, cabeceras `X-Ingest-Timestamp` (`date +%s`, 10 digitos) y `X-Ingest-Signature: v1=<64 hex>`.
- Cuerpo (orden de campos fijo, construido con `jq -nc --arg`): `{"v":1,"source":"backup","eventId":...,"hostId":...,"key":"backup-failed","state":"open"|"resolved","data":{"errors":[...]}}`; errores truncados a 5 de hasta 200 caracteres.
- Firma `HMAC-SHA256(NOTIFY_INGEST_SECRET, "<timestamp>.<cuerpo>")` con `openssl dgst -sha256 -hmac`; el cuerpo viaja por `--data-binary @-` y son exactamente los bytes firmados. Verificada contra el vector de 08-01 dentro de la imagen Alpine real (`4525b516...eada1`).
- Confirmacion: cualquier 2xx (202 aceptado, 200 duplicado). Fallo de red cuenta como `000`.
- `eventId`: `backup-failed:<epoca de la copia>`, calculado una vez por ejecucion y reutilizado en cada intento.
- Funciones: `ingest_configured`, `ingest_post`, `publish_with_retries`, `direct_notice`, `report_failure`, `cmd_notify_test`. `alert()` y su URL con el token en argv desaparecieron.
- Directo: `curl -fsS --max-time 20 -o /dev/null -K -` con `url = ".../bot<token>/sendMessage"` por stdin; texto = `DIRECT_NOTICE_PREFIX` + `BACKUP_HOST` y hora + errores.

## Variables nuevas

`NOTIFY_INGEST_URL` (vacia), `NOTIFY_INGEST_SECRET` (secreto, vacia), `NOTIFY_INGEST_HOST_ID` (`nas-home`), todas en el alcance `instance`, sin `required`. En el contenedor tambien `INGEST_RETRY_DELAYS` (`0 30 60`) y `DIRECT_NOTICE_PREFIX` como constantes sobreescribibles por entorno (no estan en el catalogo: son internas del script y de las pruebas). Paquetes de imagen: `jq` y `openssl` (apk).

## Task Commits

Todos en `../media-stack`, rama `phase-08-cutover` (base `0d920ca`, sin tocar `main`, sin push):

1. **Task 1 (tracer): publicacion firmada, sin Telegram con 2xx** - `1e5666c` (feat)
2. **Task 2: reintentos y fallback directo** - `dc6a4f1` (feat)
3. **Task 3: contrato de entorno y documentacion** - `7cba1ae` (feat)

**Ultimo commit de `phase-08-cutover`: `7cba1ae`.**

## Deviations from Plan

None - plan executed exactly as written. Ajustes menores dentro del alcance: se anadio un comentario `shellcheck disable=SC2016` en una prueba (el `$(...)` del nombre de fichero debe quedar literal) y `direct_notice` devuelve estado distinto de 0 si no se envia, para que `notify-test fallback` pueda fallar de forma visible.

## Verification

- `bash tests/backup.test.sh` en `ubuntu:24.04`: 50 passed, 0 failed.
- `python3 scripts/env_contract.py check` y `scripts/check.sh fast` (ShellCheck): exit 0; `stacks/wire/compose.yaml` sin cambios.
- Criterios: `report_failure` x2, `jq` en Dockerfile, `direct_notice` x3, `bot$TELEGRAM_BOT_TOKEN` x0, `NOTIFY_INGEST` x3 en catalogo y compose, `TELEGRAM_BOT_TOKEN` x1 en compose.
- Imagen Alpine construida: `jq` 1.8.2, OpenSSL 3.5.9, firma igual al vector del contrato, `notify-test` con modo invalido sale con 2.

## Known Stubs

None.

## Threat Flags

None. Las mitigaciones T-08-16 (token fuera de argv), T-08-17 (directo solo en fallo y notify-test), T-08-18 (jq y truncado) y T-08-SC estan aplicadas y cubiertas por pruebas; T-08-19 se acepta como en el plan.

## Notes for 08-10

- Verificacion real pendiente en la puerta humana: `media-backup notify-test ingest` contra el hub desplegado y `notify-test fallback` contra Telegram.
- Integrar `phase-08-cutover` en `main` de `media-stack` despliega (ADR-0007): no se hizo aqui.
- `.env` de la instancia debe recibir `NOTIFY_INGEST_URL` (alcanzable desde el contenedor), `NOTIFY_INGEST_SECRET` (igual que el del hub) y, si procede, `NOTIFY_INGEST_HOST_ID`.

## Self-Check: PASSED

- Commits `1e5666c`, `dc6a4f1` y `7cba1ae` existen en `phase-08-cutover` de `media-stack`; `main` sigue en `0d920ca`.
- Los 9 ficheros de `files_modified` cambiados y el arbol de `media-stack` limpio.
