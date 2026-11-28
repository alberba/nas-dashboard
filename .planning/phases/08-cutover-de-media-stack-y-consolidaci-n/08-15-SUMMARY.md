---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "15"
subsystem: infra
tags: [media-stack, issue-automator, outbox, retry, backoff, seerr, ingest, python]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: "Costura build_issue_event / deliver_issue_event de issue-automator (08-07) y guarda de emisores de Telegram (08-12)"
provides:
  - "Bandeja durable en disco (/outbox): cada apertura y cierre de una issue de Seerr se guarda y se entrega al ingest con reintento hasta el 2xx"
  - "Retroceso exponencial acotado (15 s x 2^(n-1), tope 900 s), mismo cuerpo y eventId en cada intento, firma y marca de tiempo nuevas con el secreto vigente"
  - "Orden por issue, limites de 14 dias y 200 eventos, ficheros corruptos apartados, arranque que falla alto sin carpeta escribible"
  - "Carpeta ${APPDATA_ROOT}/issue-automator con el propietario de la Instancia, creada por scripts/init.sh con el perfil extras"
affects: [08-10]

actuals:
  tokens: 9300
  tasks: 3
  commits: 4

plan_head_before: a517638bf08c7bf7159dca41c7eba2d16de572cd
plan_head_after: ab88c11905fad77e5967e5ee10e09480f4bab1c8

tech-stack:
  added: []
  patterns:
    - "Un fichero JSON por evento, escritura atomica por renombrado (como atomic_json de security-monitor), solo biblioteca estandar"
    - "Hilo daemon de vaciado con threading.Event: despierta al encolar y cada 30 s; el evento se reconstruye del fichero en cada pasada"
    - "Reloj de pruebas movido a mano (main.time sustituido) y `now` explicito en encolar y vaciar: los reintentos se prueban sin dormir"

key-files:
  created: []
  modified:
    - ../media-stack/stacks/extras/issue-automator/main.py
    - ../media-stack/stacks/extras/compose.yaml
    - ../media-stack/scripts/lib/profiles.sh
    - ../media-stack/tests/issue-automator.test.sh
    - ../media-stack/tests/template.test.sh
    - ../media-stack/tests/profiles.test.sh
    - ../media-stack/docs/profiles.md

key-decisions:
  - "P-42: un fichero JSON por evento con escritura atomica; descartados SQLite, un broker y los reintentos solo en memoria"
  - "P-43: ${APPDATA_ROOT}/issue-automator montada en /outbox, servicio con user PUID:PGID, PROFILE_DIRS[extras] gana `app issue-automator`; sin variable nueva en .env (OUTBOX_DIR solo para pruebas)"
  - "P-44: reintenta cualquier respuesta distinta de 2xx (tambien 4xx); limites como constantes (14 dias, 200 eventos, tope 900 s)"
  - "P-45: un evento no sale si delante queda otro de la misma issue sin confirmar; otras issues no se bloquean"
  - "P-46: main() sale con codigo 1 y un mensaje que nombra la carpeta y scripts/init.sh si la bandeja no es escribible"
  - "P-47: el tracer cruza webhook, disco, hilo e ingest en main.py y su prueba; el cableado de volumen y perfil es declarativo (tarea 3)"
  - "Dedup por nombre de fichero (<ms>-<issue>-<estado>.json): encolar dos veces el mismo evento devuelve True y deja un solo fichero"

patterns-established:
  - "Registros de la bandeja validados por forma (v, event_id coherente con issue y estado, cuerpo, tiempos): un fichero que no cuadra se aparta como .corrupt"

requirements-completed: [CONT-02]

coverage:
  - id: D1
    description: "Una issue creada o resuelta se guarda en la bandeja sin peticion al ingest durante el webhook; el vaciado y el hilo entregan los bytes guardados con firma HMAC estandar y borran el fichero solo con 2xx; el fichero no lleva secreto ni firma"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_a_created_issue_leaves_one_file_and_sends_nothing_during_the_webhook"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_the_stored_file_carries_neither_the_secret_nor_a_signature"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_the_drain_sends_the_stored_bytes_signed_and_empties_the_outbox"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_the_worker_delivers_without_a_manual_drain"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reintento con retroceso 15/30/.../900 s, mismo cuerpo y eventId, firmas y marcas distintas; 200 duplicate confirma y 401/409/422/503/red reintentan; una rotacion de secreto firma con el nuevo"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_a_failure_backs_off_15_then_30_seconds_and_the_third_pass_delivers"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_the_backoff_doubles_and_never_exceeds_900_seconds"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_a_duplicate_is_a_confirmation_and_other_failures_are_retried"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_a_rotated_secret_signs_the_next_attempt"
        status: pass
    human_judgment: false
  - id: D3
    description: "Orden por issue (un cierre espera a su apertura, otra issue no se bloquea), supervivencia a un reinicio (recarga del modulo) e idempotencia al encolar"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_a_closing_waits_for_its_opening_and_another_issue_does_not"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_a_pending_event_survives_a_restart"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_queueing_the_same_event_twice_leaves_one_file"
        status: pass
    human_judgment: false
  - id: D4
    description: "Limites de 14 dias y 200 eventos, ficheros corruptos apartados y borrados a los 14 dias, y ningun registro con secreto, firma o cuerpo"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_an_event_older_than_14_days_is_dropped_without_a_request"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_the_201st_event_drops_the_oldest"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_a_corrupt_file_is_set_aside_once_and_blocks_nothing"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_no_log_line_holds_the_secret_or_the_body"
        status: pass
    human_judgment: false
  - id: D5
    description: "check_outbox, arranque que falla alto con carpeta no escribible, /health con pending, compose con user PUID:PGID y volumen /outbox, perfil extras con `app issue-automator`, guarda de emisores en verde"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_the_service_refuses_to_start_without_a_writable_outbox"
        status: pass
      - kind: integration
        ref: "tests/issue-automator.test.sh#Outbox.test_health_reports_how_many_events_are_pending"
        status: pass
      - kind: integration
        ref: "tests/template.test.sh#test_issue_automator_is_built_locally_with_no_config_file"
        status: pass
      - kind: unit
        ref: "tests/profiles.test.sh#test_extras_keeps_the_issue_automator_outbox_for_the_instance_user"
        status: pass
      - kind: integration
        ref: "tests/telegram-emitters.test.sh (7 tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Comportamiento real en la Instancia: una issue de Seerr abierta y cerrada con el hub apagado y luego encendido, y la carpeta creada por scripts/init.sh con el propietario correcto"
    requirement: CONT-02
    verification: []
    human_judgment: true
    rationale: "Necesita la Instancia desplegada, el hub y Seerr reales; es la prueba de la puerta humana 08-10 (no se despliega nada desde aqui)"

duration: 5min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 15: bandeja durable de issue-automator Summary

**issue-automator guarda cada evento de apertura y cierre de una issue de Seerr como un fichero JSON atomico en `/outbox` y un hilo daemon lo entrega al ingest firmado, con retroceso exponencial hasta 900 s, orden por issue y limites de 14 dias y 200 eventos, y solo lo borra con el 2xx del hub (un 200 `duplicate` cuenta).**

## Performance

- **Duration:** ~5 min de reloj (08:38:00Z a 08:43:32Z)
- **Tasks:** 3 (4 commits en `../media-stack`, rama `phase-08-cutover`)
- **Files modified:** 7, todos en `../media-stack`; el hub no cambia

## Mecanismo tal como quedo

**Fichero.** `<creacion en ms, 13 digitos>-<issue>-<estado>.json` en `OUTBOX_DIR` (por defecto `/outbox`; solo las pruebas fijan `OUTBOX_DIR`). Contenido: `v` (1), `event_id` (`issue:<id>:open|resolved`), `issue_id`, `state`, `body` (texto ASCII con los bytes exactos del cuerpo firmado), `created_at`, `attempts`, `next_attempt`. Sin secreto, sin firma, sin cabeceras. Escritura: fichero `.tmp` al lado, `fsync` y `os.replace`.

**Constantes** (en `main.py`, no son variables de entorno): `OUTBOX_MAX_EVENTS = 200`, `OUTBOX_MAX_AGE_SECONDS = 14 * 86400`, `OUTBOX_BACKOFF_BASE = 15`, `OUTBOX_BACKOFF_CAP = 900`, `OUTBOX_POLL_SECONDS = 30`.

**Funciones.** `outbox_enqueue(event, now=None)` (bajo `OUTBOX_LOCK`; valida issue numerica y estado; no reescribe un evento ya pendiente; con 200 ficheros descarta el mas antiguo y lo registra por `eventId`), `outbox_pending()`, `outbox_drain(now=None)` -> `{"delivered","failed","dropped","pending"}`, `check_outbox(path)`, `start_outbox_worker()` / `stop_outbox_worker()`, auxiliares `outbox_write`, `outbox_remove`, `outbox_names`, `outbox_sweep_corrupt`. `publish_issue_event` ahora encola y el resultado del webhook trae `queued` en lugar de `published`; `deliver_issue_event` no se tocó.

**Vaciado.** Una pasada recorre los registros por nombre (= por creacion). Descarta los de mas de 14 dias (sin peticion; no bloquean a su cierre), salta los no vencidos y los de una issue con un evento delante sin confirmar, y entrega el resto. Tras un fallo: `attempts += 1`, `next_attempt = now + min(900, 15 * 2^(attempts-1))` (15, 30, 60, 120, 240, 480, 900, 900...), reescritura atomica. Cualquier respuesta que no sea 2xx reintenta (401, 409, 422, 503, red y excepcion incluidos). El evento se reconstruye del fichero en cada pasada y el secreto se lee de la configuracion vigente en cada intento, asi que ni un reinicio ni una rotacion necesitan estado.

**Hilo.** Daemon; drena al arrancar, despierta por un `threading.Event` al encolar y cada 30 s; una excepcion del vaciado se registra solo por tipo y el hilo sigue. `main()` llama a `check_outbox` y luego a `start_outbox_worker` antes de `run_server()`.

**Arranque seguro.** `check_outbox` crea la carpeta, prueba la escritura con un fichero y borra los `.tmp` sobrantes; ante un `OSError` lanza `ConfigError` con la carpeta y `scripts/init.sh`, y `main()` sale con codigo 1 sin arrancar hilo ni servidor.

**Ficheros corruptos.** JSON invalido o con forma incorrecta (incluido un `event_id` que no cuadra con issue y estado) se renombra a `.json.corrupt`, se registra una vez con el nombre del fichero y no entra en `outbox_pending`; un `.corrupt` de mas de 14 dias (mtime) se borra en la siguiente pasada.

## Como se ve y se vacia la bandeja

- Pendientes: `curl http://localhost:5056/health` devuelve `"pending": <n>` (cuenta los `.json` de la carpeta; 0 sin `ingest`).
- Carpeta: `${APPDATA_ROOT}/issue-automator` (en el contenedor, `/outbox`): `ls` para ver los eventos, `rm` de un fichero para descartarlo a mano; los `*.corrupt` son registros apartados.
- El registro del servicio nombra `eventId`, intento y espera; nunca el cuerpo, la firma ni el secreto.

## Compose, perfil y documentacion

- `stacks/extras/compose.yaml`: `user: ${PUID:?...}:${PGID:?...}` y un unico volumen `${APPDATA_ROOT:?...}/issue-automator:/outbox`; ninguna variable nueva en `environment`.
- `scripts/lib/profiles.sh`: `PROFILE_DIRS[extras]` gana `app issue-automator` (propietario PUID:PGID); `scripts/upgrade.sh` ejecuta `init.sh` antes de recrear.
- `docs/profiles.md`: parrafo nuevo en la seccion issue-automator (que guarda, reintento hasta 15 min, limites, `/health`, init.sh y arranque que falla).

## Task Commits

Todos en `../media-stack`, rama `phase-08-cutover` (base `a517638`; sin tocar `main`, que sigue en `0d920ca`; sin push):

1. **Task 1 (tracer): encolar en disco y entregar desde un hilo** - `5bb69ef` (feat)
2. **Task 2 RED: reintento, orden, limites, reinicio y arranque** - `9e390a0` (test)
3. **Task 2 GREEN: arranque sin bandeja escribible y limpieza de ficheros viejos** - `6350b00` (feat)
4. **Task 3: carpeta de datos, propietario y volumen de la bandeja, y documentacion** - `ab88c11` (feat)

**Ultimo commit de `phase-08-cutover`: `ab88c11905fad77e5967e5ee10e09480f4bab1c8`.**

### Evidencia RED (tarea 2)

Comando: `bash tests/issue-automator.test.sh` (59 tests, `FAILED (failures=2, errors=2)`). Fallan exactamente los cuatro objetivos de comportamiento nuevo: `test_check_outbox_creates_the_folder_and_sweeps_leftover_temporaries` y `test_check_outbox_refuses_a_folder_it_cannot_write_and_names_it` (`AttributeError: module 'main' has no attribute 'check_outbox'`, la funcion aun no existe), `test_a_corrupt_file_older_than_14_days_is_deleted` (aserto: la lista tenia los dos `.corrupt` en lugar de uno) y `test_the_service_refuses_to_start_without_a_writable_outbox` (`SystemExit not raised`). Evaluacion semantica: los cuatro se ejecutaron y fallaron por la razon prevista. Los otros 13 casos nuevos nacieron en verde porque el tracer ya implementaba retroceso, orden, limites, dedup, apartado de corruptos, rotacion y `/health`; son bloqueos de regresion del endurecimiento y no pruebas de conducta nueva. El clasificador `check tdd-red-evidence` no se ejecuto: el plan es `type: execute` (una tarea con `tdd="true"`), no `type: tdd`.

## Prueba del hilo

Los dos casos con hilo (`test_the_worker_delivers_without_a_manual_drain`, con `OUTBOX_POLL_SECONDS` a 0.05, y `test_a_new_event_wakes_a_worker_that_is_waiting_out_a_long_poll`, con los 30 s por defecto) esperan hasta 5 s al ingest falso y terminaron en milisegundos: no aparecen entre los casos mas lentos del informe de duracion, cuyo maximo son los ~2 s del caso de cuatro codigos (cuatro servidores HTTP reales, ~0,5 s de `shutdown` cada uno). Ningun caso con espera necesito mas margen: el resto usa `now` explicito y un reloj manual, sin dormir. Suite completa: 59 tests en ~4,7 s en `ubuntu:24.04` (python3 3.12).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `docs/profiles.md` conservaba dos menciones a Telegram que impedian el criterio de la tarea 3**
- **Found during:** Task 3 (verify: `! grep -qi telegram docs/profiles.md`)
- **Issue:** 08-12 documento (su desviacion 1) que quedaban dos lineas, heredadas de 08-07, en la descripcion de issue-automator: «It no longer sends Telegram messages» y «The backup's last-resort Telegram notice». El plan 08-15 da por hecho que el documento ya no nombra el servicio y su verificacion falla con ellas.
- **Fix:** reescritas las dos frases dentro de la seccion de issue-automator: «It sends no messages of its own» y «The backup's last-resort notice (docs/backup.md)». El camino directo de la copia sigue documentado en `docs/backup.md`.
- **Files modified:** ../media-stack/docs/profiles.md
- **Verification:** `grep -ci telegram docs/profiles.md` = 0; `tests/telegram-emitters.test.sh` 7 tests en verde
- **Committed in:** ab88c11

### Ajustes menores dentro del alcance

- `tests/issue-automator.test.sh` gano una clase base `OutboxCase` (configuracion con `OUTBOX_DIR` temporal, `FakeNetwork`, `http()` para llamar al manejador real) de la que cuelgan `Publish`, `Outbox` y `Secrecy`; `FakeNetwork` gano `script` (respuestas en orden) e `ingest_called`. Las aserciones de 08-07 sobre `published` y sobre entregas en linea ahora leen `queued` y cuentan ficheros y peticiones del vaciado; `Secrecy` ejecuta el vaciado con el `api_request` real y comprueba los registros.
- `outbox_enqueue` devuelve `True` cuando el evento ya estaba pendiente (esta en la bandeja) y valida que issue y estado sean seguros para el nombre del fichero; un fallo al reescribir un intento se registra por tipo y no aborta la pasada.

**Total deviations:** 1 auto-fixed (1 blocking). **Impact:** sin cambio de alcance; una redaccion de documentacion que el plan ya daba por hecha.

## Verification

- `bash tests/issue-automator.test.sh` en `ubuntu:24.04`: 59 tests, OK (tambien en local, python 3.13, incluido el caso de carpeta de solo lectura que en root se sustituye por un fichero bloqueante).
- `tests/profiles.test.sh`: 18 pasadas, 0 fallos. `tests/template.test.sh`: 30 pasadas, 1 fallo, el conocido de linea base `test_compose_rejects_an_empty_gluetun_control_key` (solo macOS).
- `tests/telegram-emitters.test.sh` en `ubuntu:24.04`: 7 tests, OK. `scripts/check.sh fast`: exit 0.
- Criterios: `def outbox_enqueue` x1, `def start_outbox_worker` x1, `OUTBOX_MAX_EVENTS` x2, `def check_outbox` x1, `app issue-automator` x1 en `profiles.sh`, `/outbox` x1 en el compose, `localhost:5056/health` x1 en `docs/profiles.md`.
- `git -C ../media-stack diff --stat` por tarea: solo ficheros de `files_modified`; `docs/profiles.md` solo cambia la seccion de issue-automator.
- No ejecutados aqui (no hay Instancia): `tests/init.test.sh` (necesita root) ni la creacion real de la carpeta por `scripts/init.sh`.

## Known Stubs

None.

## Threat Flags

None. T-08-36 (orden por issue), T-08-37 (limites y tope de retroceso), T-08-38 (secreto y firma fuera de ficheros y registros) mitigados y cubiertos por pruebas; T-08-39 y T-08-40 aceptados como en el plan; T-08-SC: sin paquetes nuevos, solo biblioteca estandar. El unico dato nuevo expuesto es `pending` en `/health`, un contador.

## Issues Encountered

None.

## Notes for 08-10

- Integrar `phase-08-cutover` en `main` de `media-stack` despliega (ADR-0007): no se hizo aqui. La rama ya trae la bandeja, requisito para integrarla (08-07 lo dejo dicho).
- Antes de la puerta humana: en la Instancia, `scripts/upgrade.sh` ejecuta `scripts/init.sh` antes de recrear y crea `${APPDATA_ROOT}/issue-automator` con PUID:PGID. Comprobacion real pendiente: apagar el hub, abrir y cerrar una issue de prueba en Seerr, ver `pending` en `/health`, encender el hub y comprobar que la incidencia se abre y se cierra.
- `CONT-02` no se marca como completado aqui: lo declaran tambien planes aun sin SUMMARY (08-10 entre ellos); lo marca el orquestador al cerrar el ultimo.

## Self-Check: PASSED

- Commits `5bb69ef`, `9e390a0`, `6350b00` y `ab88c11` existen en `phase-08-cutover` de `media-stack` (`git rev-list --count a517638..HEAD` = 4); el arbol de `media-stack` esta limpio.
- Los 7 ficheros de `files_modified` cambiados.
