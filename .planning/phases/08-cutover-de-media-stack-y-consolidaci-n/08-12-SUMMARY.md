---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "12"
subsystem: infra
tags: [media-stack, telegram, guard, docs, compose, ingest]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: "Rama phase-08-cutover de media-stack con 08-06 a 08-09 (ultimo commit 79d9033): emisores de Telegram retirados de WUD, security-monitor y actualizadores"
provides:
  - "tests/telegram-emitters.test.sh: guarda estatica que falla si reaparece un emisor de Telegram o un tercer productor del ingest"
  - "Comentarios wud.tag.transform de arr, jackett, vo y vpn sin mencion a Telegram"
  - "profiles.md, upgrading.md, apps-server.md y setup.sh describen solo el camino directo de la copia como uso de Telegram"
affects: [08-10]

actuals:
  tokens: 14000
  tasks: 2
  commits: 2

plan_head_before: 79d9033
plan_head_after: a517638

tech-stack:
  added: []
  patterns:
    - "Guarda estatica con grep y find (sin git): cada comprobacion recibe la raiz a escanear, asi la prueba la ejecuta tambien sobre una copia alterada del arbol (control negativo)"

key-files:
  created:
    - ../media-stack/tests/telegram-emitters.test.sh
  modified:
    - ../media-stack/stacks/arr/compose.yaml
    - ../media-stack/stacks/jackett/compose.yaml
    - ../media-stack/stacks/vo/compose.yaml
    - ../media-stack/stacks/vpn/compose.yaml
    - ../media-stack/docs/profiles.md
    - ../media-stack/docs/upgrading.md
    - ../media-stack/docs/apps-server.md
    - ../media-stack/scripts/setup.sh

key-decisions:
  - "P-29: la guarda es un tests/*.test.sh mas, asi que scripts/check.sh ci la ejecuta y shellcheck la lintea sin tocar check.sh. Recorre el arbol con find y grep (sin git), poda .*, docs, tests y node_modules, y usa python3 para el catalogo. Unica excepcion permitida: stacks/backup/ para api.telegram.org y TELEGRAM_."
  - "P-30: los comentarios de los cuatro compose dicen solo que las recompilaciones de linuxserver se leen como prerelease tras la transformacion de etiquetas y que WUD las sigue listando para security-monitor; la linea wud.tag.transform no se toca."

requirements-completed: []

coverage:
  - id: D1
    description: "Una guarda de media-stack falla si api.telegram.org aparece fuera de media-backup.sh, TELEGRAM_ llega por compose a otro servicio, queda un WUD_TRIGGER_, el catalogo da TELEGRAM_* a apps-server, un compose fuera de la copia menciona Telegram o hay un tercer productor del ingest"
    requirement: SEC-06
    verification:
      - kind: integration
        ref: "tests/telegram-emitters.test.sh#test_api_telegram_org_only_in_backup"
        status: pass
      - kind: integration
        ref: "tests/telegram-emitters.test.sh#test_telegram_credentials_only_reach_backup"
        status: pass
      - kind: integration
        ref: "tests/telegram-emitters.test.sh#test_no_wud_trigger_variables"
        status: pass
      - kind: integration
        ref: "tests/telegram-emitters.test.sh#test_telegram_catalog_is_instance_only"
        status: pass
      - kind: integration
        ref: "tests/telegram-emitters.test.sh#test_compose_outside_backup_does_not_mention_telegram"
        status: pass
      - kind: integration
        ref: "tests/telegram-emitters.test.sh#test_only_two_producers_use_the_ingest"
        status: pass
      - kind: integration
        ref: "tests/telegram-emitters.test.sh#test_the_guard_is_not_vacuous"
        status: pass
    human_judgment: false
  - id: D2
    description: "Los compose, la documentacion y el asistente dejan de atribuir avisos de Telegram a WUD, security-monitor y los actualizadores y dicen donde se ve cada cosa"
    requirement: SEC-06
    verification:
      - kind: command
        ref: "scripts/check.sh fast"
        status: pass
      - kind: command
        ref: "grep -ci telegram stacks/{arr,vpn}/compose.yaml docs/upgrading.md docs/apps-server.md = 0; grep -c 'Alerts from backup, What' scripts/setup.sh = 0"
        status: pass
    human_judgment: true
    rationale: "Que el texto sea claro y verdadero para el operador no lo comprueba ninguna prueba; lo revisa el humano en el PR de 08-10."
  - id: D3
    description: "El CI de Linux del PR ejecuta la guarda y tests/setup.test.sh con el texto nuevo del asistente"
    requirement: SEC-06
    verification: []
    human_judgment: true
    rationale: "tests/setup.test.sh necesita Docker Compose en el anfitrion y falla en macOS por la linea base; lo cubre el CI del PR (08-10)."

duration: 3min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 12: Guarda de emisores de Telegram y documentacion alineada Summary

**`media-stack` tiene una guarda estatica (`tests/telegram-emitters.test.sh`, 7 pruebas, controles negativos sobre una copia alterada del arbol) que hace fallar el CI si reaparece un emisor de Telegram fuera de la copia o un tercer productor del ingest, y los compose, la documentacion y el asistente dicen solo la verdad sobre el camino directo de la copia.**

## Performance

- **Duration:** ~3 min
- **Tasks:** 2 (2 commits en `../media-stack`, rama `phase-08-cutover`)
- **Files modified:** 9 en `../media-stack` (1 nuevo)

## Comprobaciones de la guarda

| Prueba | Exige | Control negativo (copia alterada) |
| --- | --- | --- |
| `test_api_telegram_org_only_in_backup` | `api.telegram.org` solo en `stacks/backup/media-backup.sh` | se anade a `issue-automator/main.py` |
| `test_telegram_credentials_only_reach_backup` | `TELEGRAM_` solo en el compose de `stacks/backup/` (compose raiz, `stacks/*`, `apps-server/`, `worker/`) | `TELEGRAM_BOT_TOKEN` en `stacks/extras/compose.yaml` |
| `test_no_wud_trigger_variables` | cero ficheros con `WUD_TRIGGER_` | una variable en `stacks/monitoring/compose.yaml` |
| `test_telegram_catalog_is_instance_only` | los alcances de `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `env/catalog.json` son exactamente `instance` | `TELEGRAM_CHAT_ID` en `apps-server` |
| `test_compose_outside_backup_does_not_mention_telegram` | ningun compose fuera de `stacks/backup/` dice telegram (sin distinguir mayusculas) | mencion en mayusculas en `arr` y en minusculas en `vpn` |
| `test_only_two_producers_use_the_ingest` | `NOTIFY_INGEST_URL` solo en `media-backup.sh`, el compose de la copia, el compose de extras y `issue-automator/main.py` (se excluyen `env`, `examples`, `.env.example` y plantillas) | un tercer compose y un tercer script |
| `test_the_guard_is_not_vacuous` | `media-backup.sh` contiene `api.telegram.org`, el compose de la copia define `TELEGRAM_BOT_TOKEN`, y la copia y issue-automator usan `NOTIFY_INGEST_URL`; el escaner encuentra esos ficheros | no aplica |

## Documentos reescritos

- `docs/profiles.md` (ingles): WUD lista las imagenes en su interfaz, sin trigger de notificacion, y lo que atiende el operador aparece en el hub (Mantenimiento y Despliegues); security-monitor cuenta correcciones, no envia aviso propio y deja el resultado en los ficheros de comparacion y `last-status.json` (se conserva la descripcion de que cuenta como correccion; se quitan «Failed deliveries remain pending» y «notify»); en las imagenes ancladas, los resultados van al diario `journalctl -u media-stack-security-updates` y un despliegue fallido o una release retenida aparecen en el hub.
- `docs/upgrading.md` (ingles): los resultados del actualizador desatendido van al diario `media-stack-upgrade` y el hub avisa de un despliegue fallido o una release retenida.
- `docs/apps-server.md` (espanol): fuera la frase de configurar Telegram y la de avisos pendientes; `MONITOR_NAME` distingue las salidas de cada host.
- `scripts/setup.sh`: el texto de `ask_telegram` describe el aviso directo de ultimo recurso de la copia; sin preguntas ni variables nuevas.

## Task Commits

Todos en `../media-stack`, rama `phase-08-cutover` (base `79d9033`, sin tocar `main`, sin push):

1. **Task 1 (tracer): guarda y comentarios de compose** - `5be5bec` (test)
2. **Task 2: documentacion y asistente** - `a517638` (docs)

**Ultimo commit de `phase-08-cutover`: `a517638`.** (`main` de media-stack sigue en `0d920ca`.)

## Verificacion

- `tests/telegram-emitters.test.sh`: 7 passed, 0 failed, tanto con Bash 5 en el anfitrion como en `ubuntu:24.04` con la orden de `<verify>` del plan.
- `scripts/check.sh fast`: exit 0 (incluye `shellcheck` de la prueba nueva y de `setup.sh`).
- La guarda entra en `scripts/check.sh ci` sin tocar `check.sh` (recorre `tests/*.test.sh`).
- `git -C ../media-stack diff --stat 79d9033..HEAD`: solo ficheros de `files_modified`.

## Deviations from Plan

**1. [Documentacion] `docs/profiles.md` conserva 2 menciones a Telegram, no 0**
- **Found during:** Task 2
- **Issue:** el criterio `grep -ci telegram docs/profiles.md` esperaba 0, pero quedan dos lineas que ya dejo 08-07 y son verdaderas: el parrafo de issue-automator («no longer sends Telegram messages») y la mencion al aviso de ultimo recurso de la copia. El plan dice explicitamente que ese parrafo no se toca, y el camino directo de la copia es el uso legitimo que debe seguir documentado.
- **Fix:** no se tocan; las otras cuatro menciones (WUD, security-monitor, imagenes ancladas) se reescribieron. `upgrading.md` y `apps-server.md` quedan en 0.
- **Files modified:** ninguno adicional.

**Total deviations:** 1 (criterio de aceptacion mal dimensionado; sin cambio de comportamiento). Sin desviaciones en `scripts/check.sh`: no hizo falta cablear la guarda.

## Issues Encountered

- `tests/setup.test.sh` no se pudo ejecutar localmente: en macOS falla (`profiles.sh: backup: unbound variable`, linea base de la plataforma) y en el contenedor `ubuntu:24.04` falta Docker Compose. El cambio en `setup.sh` es una sola cadena de `echo` sin cambio de preguntas, y `check.sh fast` (shellcheck) pasa; el CI de Linux del PR (08-10) ejecuta la prueba completa.

## Known Stubs

None.

## Threat Flags

None. T-08-29 mitigado (guarda con lista de excepciones minima, controles negativos y prueba de que no esta vacia; la ejecuta `check.sh ci`); T-08-SC: sin paquetes nuevos.

## Notes for 08-10

- `phase-08-cutover` (ultimo commit `a517638`) no se integra en `main` aqui; integrarla despliega (ADR-0007).
- `SEC-06` no se marca como completado: lo declara tambien 08-10 (sin SUMMARY); lo marca el orquestador al cerrar el ultimo.

## Self-Check: PASSED

- Commits `5be5bec` y `a517638` existen en `phase-08-cutover` de `media-stack` (`git rev-list --count 79d9033..HEAD` = 2); arbol de `media-stack` limpio.
- `tests/telegram-emitters.test.sh` existe y los 8 ficheros modificados cambian.
