---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "08"
subsystem: infra
tags: [media-stack, telegram, upgrade, security-monitor, merged-updates, python, bash]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: "Rama phase-08-cutover de media-stack con los planes 08-06 y 08-07 (ultimo commit a41d829)"
provides:
  - "upgrade.sh sin camino a Telegram: notice() solo escribe `notice: <texto>` en la salida cuando la ejecucion es desatendida"
  - "merged_updates.py sin Deployment.notify ni cola notifications.json; el fallo de una release imprime su linea por stderr y sigue restaurando y relanzando"
  - "updater.py de seguridad sin notify, flush_notifications, notify_outcome ni cola update-notifications.json; la recuperacion pasa a print y los outcomes solo fijan el codigo de salida"
  - "main.py del monitor sin telegram ni digest; run pierde el parametro notify y sigue contando security_updates en last-status.json"
affects: [08-09, 08-10]

actuals:
  tokens: 9500
  tasks: 3
  commits: 5

plan_head_before: a41d829
plan_head_after: 907369e

tech-stack:
  added: []
  patterns:
    - "Prueba con las variables de Telegram definidas y con el transporte de red (urlopen, curl falso) que falla o registra la llamada: la ausencia del emisor se asevera por llamadas, no por texto"
    - "updater.run se prueba con un Host de sustitucion y `updater.command` que falla si se llama: el codigo de salida lo fijan los resultados"

key-files:
  created: []
  modified:
    - ../media-stack/scripts/upgrade.sh
    - ../media-stack/tests/upgrade.test.sh
    - ../media-stack/scripts/merged_updates.py
    - ../media-stack/stacks/monitoring/security-monitor/updater.py
    - ../media-stack/tests/merged-updates.test.sh
    - ../media-stack/tests/security-update.test.sh
    - ../media-stack/stacks/monitoring/security-monitor/main.py
    - ../media-stack/tests/security-monitor.test.sh

key-decisions:
  - "P-25: upgrade.sh `notify()` pasa a `notice()` (sin la palabra notify), solo escribe `notice: <texto>` con UNATTENDED=1; die() y los cuatro puntos de aviso la llaman con el mismo texto; se borran la lectura de TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID y el curl -K -"
  - "P-26: merged_updates.py y updater.py pierden envios, colas y ficheros de cola; los avisos de resultado pasan a print (stderr para el fallo de release, stdout para la recuperacion); los outcomes del actualizador se anaden todos y solo fijan el codigo de salida"
  - "main.py del monitor conserva notified-updates.json (historial que evita repetir el recuento de una misma CVE corregida) y last-status.json sin cambios"
  - "El mensaje de `disable` del actualizador ya no dice que las notificaciones siguen activas: dice que el monitor sigue comparando y contando actualizaciones verificadas"

patterns-established:
  - "Un fallo de release o una vuelta atras deja su linea en la salida (journal) y conserva el codigo de salida; la apertura del incidente es del hub desde el snapshot (deploy-failed, release-retained)"

requirements-completed: []

coverage:
  - id: D1
    description: "Una ejecucion desatendida de upgrade.sh con credenciales de Telegram en .env no llama a curl con -K ni a telegram y deja `notice:` en la salida en los escenarios de aviso (retenida, mayor, vuelta atras correcta y fallida, aplicada); sin --unattended no hay `notice:`; los codigos de salida no cambian"
    requirement: SEC-06
    verification:
      - kind: integration
        ref: "tests/upgrade.test.sh#test_unattended_applies_compatible_releases_without_prompts"
        status: pass
      - kind: integration
        ref: "tests/upgrade.test.sh#test_unattended_stops_before_a_major_release"
        status: pass
      - kind: integration
        ref: "tests/upgrade.test.sh#test_unattended_failure_rolls_back_automatically"
        status: pass
      - kind: integration
        ref: "tests/upgrade.test.sh#test_unattended_failed_rollback_leaves_its_line_on_the_output"
        status: pass
      - kind: integration
        ref: "tests/upgrade.test.sh#test_interactive_runs_write_no_notice_and_make_no_telegram_request"
        status: pass
    human_judgment: false
  - id: D2
    description: "Los despliegues de releases no tienen Deployment.notify, no crean notifications.json (correcta ni fallida), la fallida sigue restaurando y relanzando y deja su linea por stderr, y no hay peticion a telegram con las variables presentes"
    requirement: SEC-06
    verification:
      - kind: integration
        ref: "tests/merged-updates.test.sh#Deployment.test_a_deployment_has_no_notification_transport"
        status: pass
      - kind: integration
        ref: "tests/merged-updates.test.sh#Deployment.test_approved_major_only_recreates_affected_app"
        status: pass
      - kind: integration
        ref: "tests/merged-updates.test.sh#Deployment.test_failed_major_restores_database_and_code"
        status: pass
    human_judgment: false
  - id: D3
    description: "El actualizador de seguridad no expone notify, flush_notifications ni notify_outcome, no crea update-notifications.json y run devuelve 0, 1, 1 y 0 para aplicada, retroceso, error y manual, con la vuelta atras de una actualizacion pendiente y su linea de recuperacion en la salida"
    requirement: SEC-06
    verification:
      - kind: unit
        ref: "tests/security-update.test.sh#Policy.test_the_updater_has_no_notification_path"
        status: pass
      - kind: integration
        ref: "tests/security-update.test.sh#Run.test_an_applied_update_exits_zero_and_prints_its_result"
        status: pass
      - kind: integration
        ref: "tests/security-update.test.sh#Run.test_a_rollback_exits_one_and_prints_its_result"
        status: pass
      - kind: integration
        ref: "tests/security-update.test.sh#Run.test_an_error_exits_one_and_prints_its_result"
        status: pass
      - kind: integration
        ref: "tests/security-update.test.sh#Run.test_a_pending_update_is_rolled_back_and_the_recovery_stays_on_the_output"
        status: pass
    human_judgment: false
  - id: D4
    description: "El monitor de seguridad no tiene telegram ni digest, run no admite notify, cuenta security_updates (1 y luego 0, agrupacion, CVE repetidas, casos silenciosos, modo automatico) y no llama a urlopen con las variables de Telegram definidas"
    requirement: SEC-06
    verification:
      - kind: unit
        ref: "tests/security-monitor.test.sh#Monitor.test_the_monitor_has_no_telegram_or_digest_and_run_takes_no_notify"
        status: pass
      - kind: unit
        ref: "tests/security-monitor.test.sh#Monitor.test_confirmed_fix_counts_once_and_groups_shared_containers"
        status: pass
      - kind: unit
        ref: "tests/security-monitor.test.sh#Monitor.test_automatic_mode_leaves_the_verified_update_ready_for_the_host_updater"
        status: pass
    human_judgment: false
  - id: D5
    description: "Despliegue real: con el codigo nuevo en el NAS ningun proceso de actualizacion envia a Telegram y los fallos aparecen como incidencias del hub"
    requirement: SEC-06
    verification: []
    human_judgment: true
    rationale: "Requiere el cutover en produccion (08-10) y borrar las colas notifications.json y update-notifications.json (checklist 08-03); la guarda estatica del repositorio la aporta 08-09"

duration: 25min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 08: media-stack deja de enviar avisos de actualizacion y seguridad a Telegram Summary

**`upgrade.sh`, `merged_updates.py`, el actualizador de seguridad y el monitor de comparaciones ya no tienen ningun emisor ni cola de Telegram: sus resultados quedan en la salida (y en el diario de systemd), los codigos de salida no cambian y el monitor sigue contando las actualizaciones verificadas en `last-status.json`.**

## Performance

- **Duration:** ~25 min (2026-11-28T08:18Z a 08:27Z de reloj; incluye ~4 min de suites Docker)
- **Tasks:** 3 (5 commits: tracer, RED+GREEN de la tarea 2, RED+GREEN de la tarea 3)
- **Files modified:** 8, todos en `../media-stack`, rama `phase-08-cutover`

## Simbolos eliminados

| Fichero | Eliminado | Sustituto |
| --- | --- | --- |
| `scripts/upgrade.sh` | `notify()`, lectura de `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`, `printf ... curl -K -` y el aviso `warning: Telegram notification failed` | `notice()` (solo `echo "notice: $1"` con `UNATTENDED=1`) |
| `scripts/merged_updates.py` | `Deployment.notify` y sus tres llamadas, cola `notifications.json` | `print(..., file=sys.stderr)` en la rama de fallo; la rama correcta ya imprimia la etiqueta y los servicios |
| `stacks/monitoring/security-monitor/updater.py` | `notify_outcome`, `notify` (el `docker exec` a `main.telegram`), `flush_notifications`, cola `update-notifications.json` y su lectura/escritura en `run` | `print` de la recuperacion; `outcomes` conserva todos los resultados solo para el codigo de salida |
| `stacks/monitoring/security-monitor/main.py` | `telegram`, `digest`, parametro `notify` de `run`, `import urllib.parse` | `print` con el recuento de actualizaciones verificadas |

## Textos que pasan a la salida

- `upgrade.sh` (UNATTENDED=1, stdout): `notice: <texto>` con los textos de siempre (release retenida, fallo con vuelta atras, vuelta atras fallida, actualizado y verificado, `actualizacion automatica detenida: ...` desde `die`). `die` mantiene su `error:` por stderr.
- `merged_updates.py` (stderr): `<tag> falló; restaurados código, imágenes y datos anteriores`, y la excepcion sigue propagandose.
- `updater.py` (stdout): `<MONITOR_NAME> — recuperación completada: <servicio>`; cada resultado ya se imprimia (`<servicio> → <tag>: <resultado>`).
- `main.py` (stdout): `Verified security updates: N image updates` o `No new verified security updates` (sin mencionar Telegram).
- `updater.py disable`: `Auto-updates disabled; the monitor keeps comparing images and counting verified security updates` (decia que las notificaciones seguian activas, ya falso).

## Task Commits

Todos en `../media-stack`, rama `phase-08-cutover` (base `a41d829`, sin tocar `main`, sin push):

1. **Task 1 (tracer): upgrade.sh sin Telegram** - `e5ef4a9` (feat)
2. **Task 2 RED: despliegues y actualizador no envian nada** - `e14b166` (test)
3. **Task 2 GREEN: sin notify, colas ni transporte** - `1d6c488` (feat)
4. **Task 3 RED: el monitor cuenta actualizaciones verificadas** - `a33da54` (test)
5. **Task 3 GREEN: sin telegram ni digest** - `907369e` (feat)

**Ultimo commit de `phase-08-cutover`: `907369e`.** (`main` de media-stack sigue en `0d920ca`.)

### Evidencia RED

- Tarea 1 (tracer): ejecutadas las pruebas nuevas contra el `upgrade.sh` anterior, fallan 4 escenarios (`applies_compatible`, `stops_before_a_major`, `failure_rolls_back`, `failed_rollback`) por la llamada a `curl -K` con las credenciales en `.env`; los 12 casos preexistentes siguen en verde.
- Tarea 2: contra el `updater.py` anterior fallan `test_the_updater_has_no_notification_path` (`True is not false : notify`) y los cuatro `Run` con exit/resultado que pasaban por `flush_notifications` (`AssertionError: command`, el `docker exec` a `main.telegram`). `test_a_manual_result_exits_zero` nace en verde (ese resultado ya se filtraba) y es una prueba de bloqueo.
- Tarea 3: contra el `main.py` anterior, 1 fallo de asercion (`test_the_monitor_has_no_telegram_or_digest...`) y 14 errores por la firma de `run` (la prueba ya no pasa `notify`). Evaluacion semantica: el rojo es el de la superficie eliminada y la firma; el comportamiento de recuento lo cubren los casos que pasan tras la eliminacion.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Mensaje de `updater.py disable` ya incorrecto**
- **Found during:** Task 2
- **Issue:** `Auto-updates disabled; verified security notifications remain enabled` afirmaba una notificacion que ya no existe.
- **Fix:** el texto describe el comportamiento real (el monitor sigue comparando y contando).
- **Files modified:** `../media-stack/stacks/monitoring/security-monitor/updater.py`
- **Verification:** `py_compile` y `tests/security-update.test.sh`
- **Committed in:** `1d6c488`

**2. [Rule 2 - Missing Critical] Pruebas de `updater.run` que el plan daba por existentes**
- **Found during:** Task 2
- **Issue:** el plan pide comprobar que `run` devuelve 0, 1 y 1, pero ninguna prueba ejecutaba `updater.run`.
- **Fix:** clase `Run` con un `Host` de sustitucion y `updater.command`, `urlopen` y la red que fallan si se llaman, mas el caso de vuelta atras pendiente.
- **Files modified:** `../media-stack/tests/security-update.test.sh`
- **Committed in:** `e14b166`

**3. [Rule 1 - Cleanup] `import urllib.parse` huerfano en `main.py`**
- **Found during:** Task 3
- **Issue:** solo lo usaba `telegram()`.
- **Fix:** se elimina el import; `urllib.request` se conserva porque `wud_containers` lo usa.
- **Committed in:** `907369e`

---

**Total deviations:** 3 auto-fixed (1 mensaje obsoleto, 1 prueba faltante, 1 import sin uso)
**Impact on plan:** Sin alcance nuevo ni cambios de comportamiento; solo se cierran huecos de verificacion y restos del codigo eliminado.

## Verification

- `tests/upgrade.test.sh` en `ubuntu:24.04`: 16 passed, 0 failed.
- `tests/merged-updates.test.sh` (Bash 5 en el anfitrion, Docker real): 14 tests OK en 96 s.
- `tests/security-update.test.sh` (Bash 5, Docker real): 19 tests OK en 131 s.
- `tests/security-monitor.test.sh` en `ubuntu:24.04`: 21 tests OK.
- `scripts/check.sh fast`: exit 0 (tras el ultimo commit).
- Criterios: `notify` x0 en `upgrade.sh`, `merged_updates.py` y `updater.py`; `flush_notifications` x0; `api.telegram.org`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` x0 en los cuatro ficheros; `def telegram` y `def digest` x0 en `main.py`; `git grep "update-notifications\|notifications.json"` fuera de `tests/` sin referencias.
- `git diff --stat a41d829..HEAD`: solo los 8 ficheros de `files_modified`.

## Known Stubs

None.

## Threat Flags

None. T-08-23 mitigado (los cuatro emisores eliminados y pruebas con las variables de Telegram presentes que comprueban cero llamadas de red); T-08-25: nadie lee ya `notifications.json` ni `update-notifications.json`, el borrado de los ficheros existentes es del checklist de 08-03/08-10; T-08-SC: sin paquetes nuevos.

## Notes for 08-09 and 08-10

- 08-09: compose, WUD, catalogo, plantillas y la guarda estatica del repositorio; `docs/profiles.md` y la documentacion de `upgrade.sh`/security-monitor que aun mencionen Telegram o el aviso del actualizador siguen pendientes (no se tocaron aqui).
- 08-10: integrar `phase-08-cutover` en `main` de `media-stack` despliega (ADR-0007); no se hizo aqui. Tras el cutover hay que borrar `notifications.json` y `update-notifications.json` del anfitrion.
- `SEC-06` no se marca como completado aqui: lo declaran tambien planes sin SUMMARY (08-09, 08-10); lo marca el orquestador al cerrar el ultimo.
- La release aplicada con exito ya no avisa fuera del hub; solo deja `notice: actualizado de ...` en la salida del diario.

## Self-Check: PASSED

- Commits `e5ef4a9`, `e14b166`, `1d6c488`, `a33da54` y `907369e` existen en `phase-08-cutover` de `media-stack` (`git rev-list --count a41d829..HEAD` = 5), arbol de `media-stack` limpio.
- Los 8 ficheros de `files_modified` cambiados.
