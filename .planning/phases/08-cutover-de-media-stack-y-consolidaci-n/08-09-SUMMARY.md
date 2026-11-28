---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "09"
subsystem: infra
tags: [media-stack, telegram, wud, security-monitor, env-contract, compose]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: "Rama phase-08-cutover de media-stack con 08-06 a 08-08 (ultimo commit 907369e): codigo emisor de Telegram ya retirado"
provides:
  - "monitoring/compose.yaml sin variables WUD_TRIGGER_TELEGRAM_* y sin TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID en security-monitor"
  - "Prueba del compose renderizado: solo backup recibe las credenciales de Telegram y wud no tiene ninguna clave WUD_TRIGGER_"
  - "Catalogo y plantillas con TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID solo en el alcance instance"
affects: [08-10, 08-12]

actuals:
  tokens: 6000
  tasks: 2
  commits: 2

plan_head_before: 907369e
plan_head_after: 79d9033

tech-stack:
  added: []
  patterns:
    - "La ausencia de credenciales se vigila sobre el modelo renderizado (todos los perfiles, .env de fixture con las dos claves = dummy), no sobre texto"

key-files:
  created: []
  modified:
    - ../media-stack/stacks/monitoring/compose.yaml
    - ../media-stack/tests/template.test.sh
    - ../media-stack/env/catalog.json
    - ../media-stack/env/instance.example.template
    - ../media-stack/env/apps-server.example.template
    - ../media-stack/.env.example
    - ../media-stack/apps-server/.env.example

key-decisions:
  - "P-27: WUD queda sin trigger de notificacion; se eliminan las cuatro variables WUD_TRIGGER_TELEGRAM_* y el comentario del umbral, y queda una linea que indica que el estado se consulta en la interfaz de WUD y en security-monitor. Los comentarios wud.tag.transform de otros compose los corrige 08-12."
  - "P-28: el alcance apps-server pierde TELEGRAM_* en catalogo, plantilla y .env.example generado; un .env ya desplegado con esas lineas solo recibe la advertencia de clave ajena. MONITOR_NAME se conserva y su comentario pasa a decir que etiqueta las salidas y registros de los actualizadores."

requirements-completed: []

coverage:
  - id: D1
    description: "En el compose renderizado con todos los perfiles solo backup recibe TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID, y wud no tiene ninguna clave WUD_TRIGGER_"
    requirement: SEC-06
    verification:
      - kind: integration
        ref: "tests/template.test.sh#test_no_service_but_backup_gets_telegram_credentials"
        status: pass
      - kind: integration
        ref: "tests/template.test.sh#test_instance_specific_values_come_from_the_env"
        status: pass
    human_judgment: false
  - id: D2
    description: "TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID solo existen en el alcance instance; los ejemplos generados estan al dia y el contrato de entorno pasa"
    requirement: SEC-06
    verification:
      - kind: command
        ref: "python3 scripts/env_contract.py check"
        status: pass
      - kind: command
        ref: "scripts/check.sh fast"
        status: pass
      - kind: integration
        ref: "tests/apps-server.test.sh"
        status: pass
      - kind: integration
        ref: "tests/env-contract.test.sh#test_generated_contract_files_are_current"
        status: pass
    human_judgment: false
  - id: D3
    description: "Despliegue real: tras el cutover, WUD y security-monitor corren sin credenciales de Telegram y un .env de apps-server con las dos lineas antiguas solo produce una advertencia"
    requirement: SEC-06
    verification: []
    human_judgment: true
    rationale: "Requiere el cutover en produccion (08-10); aqui solo se comprueba el modelo renderizado y el generador."

duration: 3min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 09: WUD y security-monitor sin credenciales de Telegram Summary

**El compose de monitoring ya no entrega credenciales ni trigger de Telegram a WUD ni a security-monitor; solo `backup` las recibe, y el catalogo, las plantillas y los `.env.example` generados dejan `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` unicamente en el alcance `instance`.**

## Performance

- **Duration:** ~3 min (2026-11-28T08:28Z a 08:31Z de reloj; la suite `template.test.sh` con Docker real tarda ~1 min)
- **Tasks:** 2 (2 commits en `../media-stack`, rama `phase-08-cutover`)
- **Files modified:** 7, todos en `../media-stack`

## Ajustes retirados por alcance

| Alcance / servicio | Retirado |
| --- | --- |
| compose `security-monitor` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| compose `wud` | `WUD_TRIGGER_TELEGRAM_TELEGRAM_THRESHOLD`, `..._ONDIGEST`, `..._BOTTOKEN`, `..._CHATID` y su comentario de umbral |
| catalogo, alcance `apps-server` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (el alcance `instance` queda intacto; `secret: true` y `wire: false` conservados) |
| `env/apps-server.example.template` y `apps-server/.env.example` | las dos lineas de Telegram |
| `env/instance.example.template` y `.env.example` | solo comentarios: la frase de WUD sobre sus avisos, la linea final «Telegram alerts use ...» de la seccion VO, y la mencion a issue-automator en el comentario de Telegram, que ahora dice que es el ultimo recurso directo de la copia cuando el ingest del hub no confirma |
| `MONITOR_NAME` (ambas plantillas) | solo el comentario: etiqueta las salidas y registros de los actualizadores (ya no habla de notificaciones de seguridad) |

## Task Commits

Todos en `../media-stack`, rama `phase-08-cutover` (base `907369e`, sin tocar `main`, sin push):

1. **Task 1 (tracer): compose sin credenciales ni trigger y prueba de ausencia** - `c6845b3` (feat)
2. **Task 2: catalogo y plantillas con Telegram solo en `instance`** - `79d9033` (feat)

**Ultimo commit de `phase-08-cutover`: `79d9033`.** (`main` de media-stack sigue en `0d920ca`.)

## Pruebas

- `test_wud_telegram_only_notifies_major_versions` sustituida por `test_no_service_but_backup_gets_telegram_credentials`: con todos los perfiles y el `.env` de fixture (que define ambas claves como `dummy`), el unico servicio con esas claves es `backup` y `wud` no tiene ninguna clave `WUD_TRIGGER_`. La asercion de `WUD_TRIGGER_TELEGRAM_TELEGRAM_BOTTOKEN` desaparece de `test_instance_specific_values_come_from_the_env`; las del login de WUD, Tailscale, mousehole y homarr siguen.
- `tests/template.test.sh` (Bash 5 en el anfitrion, Docker real): 30 passed, 1 failed; el unico `FAIL` es `test_compose_rejects_an_empty_gluetun_control_key` (linea base de macOS, conocida).
- `python3 scripts/env_contract.py check`: exit 0. `scripts/check.sh fast`: exit 0. `tests/apps-server.test.sh`: pasa.
- Criterios: `grep -c WUD_TRIGGER_TELEGRAM` y `grep -c TELEGRAM_BOT_TOKEN` sobre `monitoring/compose.yaml` = 0; `grep -c TELEGRAM` = 0 en `env/apps-server.example.template` y `apps-server/.env.example`; alcances de `TELEGRAM_BOT_TOKEN` = `['instance']`.
- `git status` tras `env_contract.py generate`: solo cambian `.env.example` y `apps-server/.env.example`; `stacks/wire/compose.yaml` no cambia.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Comentarios de plantilla que describian avisos de Telegram ya inexistentes**
- **Found during:** Task 2
- **Issue:** el comentario de Telegram en la plantilla de instancia aun decia que lo usa issue-automator (08-05/08-06 lo movieron al ingest del hub, y su compose ya no referencia Telegram), y el de `MONITOR_NAME` de la plantilla de instancia hablaba de notificaciones de seguridad.
- **Fix:** el comentario de Telegram solo nombra el camino directo de la copia; el de `MONITOR_NAME` se cambia tambien en la plantilla de instancia (el plan lo pedia solo para apps-server).
- **Files modified:** `../media-stack/env/instance.example.template`, `../media-stack/.env.example`
- **Committed in:** `79d9033`

**Total deviations:** 1 auto-fixed (comentarios). **Impact:** sin cambio de comportamiento.

## Issues Encountered

- `tests/env-contract.test.sh` falla en macOS 3 casos (`test_assistant_reports_indirect_shell_override_of_an_extension`, `test_assistant_reports_shell_only_interpolation`, `test_worker_requires_its_server_address`); se comprobo con un `git archive` del commit anterior que fallan igual sin los cambios de este plan. Fuera de alcance; el CI de Linux del PR (08-10) los cubre.

## Known Stubs

None.

## Threat Flags

None. T-08-24 mitigado (compose, catalogo de apps-server y plantillas sin las credenciales, y prueba del compose renderizado que exige que solo `backup` las reciba); T-08-SC: sin paquetes nuevos.

## Notes for 08-10 and 08-12

- 08-10: `phase-08-cutover` no se integra en `main` aqui; integrarla despliega (ADR-0007). Un `.env` de apps-server desplegado con las dos lineas de Telegram sigue siendo valido (solo advertencia del contrato).
- 08-12: `docs/profiles.md`, `docs/upgrading.md` y los comentarios `wud.tag.transform` de otros compose aun mencionan Telegram/umbral; pendientes ahi junto con la guarda estatica.
- `SEC-06` no se marca como completado: lo declara tambien 08-10 (sin SUMMARY); lo marca el orquestador al cerrar el ultimo.

## Self-Check: PASSED

- Commits `c6845b3` y `79d9033` existen en `phase-08-cutover` de `media-stack` (`git rev-list --count 907369e..HEAD` = 2); arbol de `media-stack` limpio.
- Los 7 ficheros de `files_modified` cambiados; `git diff --stat 907369e..HEAD` solo muestra esos 7.
