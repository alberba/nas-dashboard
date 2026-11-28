---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "10"
subsystem: infra
tags: [media-stack, ingest, cutover, telegram, issue-automator, outbox, release-follower]

requires:
  - phase: 08-cutover-de-media-stack-y-consolidaci-n
    provides: "Ingest del hub (08-01), ciclo de issues y guardia de evidencia (08-02), script y documento del cutover (08-03), rama phase-08-cutover de media-stack con 08-06 a 08-09, 08-12 y 08-15"
provides:
  - "Despliegue 1 del hub en produccion: ingest firmado, migracion 0009 y NOTIFY_INGEST_SECRET"
  - "PR #110 de media-stack integrado (d8005a6) y release v3.7.0 aplicada por el seguidor del NAS"
  - "wud, security-monitor e issue-automator sin variables TELEGRAM_ ni WUD_TRIGGER_; la copia conserva el fallback directo"
  - "Evidencia de la puerta humana 1: eventos firmados por familia, alcanzabilidad contenedor a hub, issue real de Seerr y reintento de la bandeja"
affects: [08-11, 08-13, 08-14]

actuals:
  tokens: 45000
  tasks: 3
  commits: 0

plan_head_before: 1439f6e332ae54edc6c69723b797fc0c696b2d8e
plan_head_after: 1439f6e332ae54edc6c69723b797fc0c696b2d8e

tech-stack:
  added: []
  patterns:
    - "Puerta humana de produccion: el ejecutor prepara PR en borrador y CI, el usuario despliega y el ejecutor verifica con recuentos y codigos HTTP, sin leer ningun .env"
    - "Eventos de prueba abiertos y cerrados con diferencia de milisegundos quedan suprimidos (resolved_before_send): comprobar el camino completo con una incidencia que permanezca abierta unos segundos"

key-files:
  created: []
  modified: []

key-decisions:
  - "P-31: los pasos de produccion son checkpoint:human-action porque D-11 reserva al usuario el despliegue y el acceso a webs y al NAS; el PR de media-stack se abrio en borrador para impedir una integracion accidental."
  - "El PR #110 incluye una excepcion en .gitleaks.toml para los secretos inventados de las pruebas (reglas generic-api-key y env-secret-value en tests/backup.test.sh y tests/issue-automator.test.sh)."
  - "La URL de NOTIFY_INGEST_URL es la de Tailscale del hub, http://100.74.226.92:4323/api/notifications/ingest, probada desde un contenedor del NAS sobre la red por defecto."
  - "El emisor SMART externo no existe en el NAS (D-06): no hay nada que apagar; el hub cubre los discos con disk-health."

patterns-established:
  - "Un fichero 600 en el checkout del seguidor no es legible por un contenedor que corre como PUID:PGID: copiar con COPY --chmod en el Dockerfile"

requirements-completed: [CONT-02, SEC-06]

coverage:
  - id: D1
    description: "Ingest del hub en produccion: sin firma 401, firma incorrecta 401, repeticion 200 sin incidencia nueva, y copia e issue-automator abren y cierran incidencia con dos 202"
    requirement: CONT-02
    verification:
      - kind: manual_procedural
        ref: "scripts/ingest-test-event.sh --state both (backup, incidencia 158; issue:seerr:999999, incidencia 159); curl POST sin firma = 401"
        status: pass
    human_judgment: true
    rationale: "Despliegue y pruebas contra produccion ejecutados por el usuario (D-11); el ejecutor repitio solo el POST sin firma"
  - id: D2
    description: "Un contenedor del NAS sobre la red por defecto alcanza el ingest del hub por Tailscale"
    requirement: CONT-02
    verification:
      - kind: manual_procedural
        ref: "alpine:3.24 en el NAS, backup --state both contra http://100.74.226.92:4323/api/notifications/ingest: 202 y 202"
        status: pass
    human_judgment: true
    rationale: "Prueba en el NAS, fuera del alcance del ejecutor (D-11)"
  - id: D3
    description: "Tras la release, wud, security-monitor e issue-automator no tienen variables TELEGRAM_ ni WUD_TRIGGER_; backup conserva TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID"
    requirement: SEC-06
    verification:
      - kind: manual_procedural
        ref: "docker inspect <contenedor> | grep -cE 'TELEGRAM|WUD_TRIGGER': 0, 0, 0 y backup con 2"
        status: pass
    human_judgment: true
    rationale: "Comprobacion sobre contenedores reales del NAS por recuento, sin imprimir valores"
  - id: D4
    description: "media-backup notify-test ingest y notify-test fallback funcionan desde el contenedor real"
    requirement: CONT-02
    verification:
      - kind: manual_procedural
        ref: "docker exec backup media-backup notify-test ingest (salida 0, el hub confirmo el evento y su cierre); notify-test fallback (salida 0, aviso directo enviado)"
        status: pass
    human_judgment: true
    rationale: "Ejecucion en el NAS por el usuario"
  - id: D5
    description: "Issue real de Seerr abre y cierra su incidencia con el mensaje de Telegram editado; con el ingest inalcanzable la bandeja retiene dos eventos y al restaurarlo los entrega y vuelve a pending 0 sin duplicar"
    requirement: CONT-02
    verification:
      - kind: manual_procedural
        ref: "issue real de prueba (confirmada por el usuario); issue #8 con URL inalcanzable: pending=2, sin incidencia; restaurada: pending=0, una sola incidencia (166)"
        status: pass
    human_judgment: true
    rationale: "Requiere Seerr real, Telegram y el NAS"
  - id: D6
    description: "PR #110 integrado de una vez, vuelta atras documentada (revertir el commit), duplicado de la copia aceptado y emisor SMART buscado"
    requirement: SEC-06
    verification:
      - kind: other
        ref: "gh pr view 110 --repo alberba/media-stack: state MERGED, merge d8005a6, 2026-11-28T09:45:44Z"
        status: pass
    human_judgment: false

duration: puerta humana en dos pasadas (2026-11-28)
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 10: Cutover de media-stack Summary

**El ingest del hub esta en produccion y probado por familia, el PR #110 de media-stack esta integrado y desplegado (v3.7.0), los emisores directos de Telegram estan apagados salvo el fallback de la copia, y issue-automator publica por una bandeja durable que sobrevive a un hub inalcanzable.**

## Performance

- **Duration:** puerta humana dividida en dos pasadas del ejecutor y los pasos del usuario, 2026-11-28
- **Tasks:** 3 (1 tracer, 2 checkpoint:human-action)
- **Files modified:** 0 en este repositorio (el trabajo vive en `media-stack` y en produccion)

## Accomplishments

- **PR y CI.** Rama `phase-08-cutover` subida, PR en borrador https://github.com/alberba/media-stack/pull/110 con `validate` y `gitleaks` en verde en los runs de `push` y `pull_request` (cabeza `c81dded`). Despues integrado por el usuario: merge `d8005a6`, 2026-11-28T09:45:44Z.
- **Despliegue 1 del hub.** `NOTIFY_INGEST_SECRET` (64 hex, generado en el servidor, nunca mostrado) en el `.env` del hub, copia previa de la base en `~/hub-backups/pre-phase08-202611280912.dump` (91 MB), push de `main` (cabeza `1439f6e`; produccion estaba byte a byte en `1981e77`, fin de la fase 7), Checks y Deploy (run 46129857011) en verde, app y worker sanos y tabla `ingest_events` creada (migracion 0009).
- **Eventos de prueba (D-09).** Desde el Mac, con `scripts/ingest-test-event.sh`:
  - copia `--state both`: 202 abierta y 202 resuelta (incidencia 158);
  - issue-automator `issue:seerr:999999 --state both`: 202 y 202 (incidencia 159);
  - repeticion exacta de `gate1-issue-202611281035:open`: 200 `{"status":"duplicate"}`;
  - secreto equivocado: 401;
  - POST sin firma: 401 (repetido por el ejecutor en las dos pasadas, contra `http://100.74.226.92:4323/api/notifications/ingest`).
- **Telegram de la puerta.** Las incidencias 158 y 159 no emitieron mensaje: su fila del outbox quedo `suppressed` con motivo `resolved_before_send`, porque abrir y cerrar llegaron con unos 100 ms de diferencia (regla existente del dispatcher, correcta). Un evento enviado por error con id sin sufijo abrio la incidencia 160, que permanecio abierta 34 s: `incident-open` enviado y `incident-edit` enviado al resolver. Con ella queda probado el camino completo ingest, incidencia, outbox, Telegram y edicion; se cerro con un evento resuelto (202).
- **Alcanzabilidad desde el NAS (D-09).** Un contenedor `alpine:3.24` sobre la red por defecto de Docker, con el secreto en su entorno, envio `backup --state both` a `http://100.74.226.92:4323/api/notifications/ingest`: 202 y 202. Esa es la URL de `NOTIFY_INGEST_URL`.
- **Emisor SMART (D-06): no encontrado.** `smartmontools` deshabilitado e inactivo, sin proceso `smartd`; `/etc/smartd.conf` solo tiene el `DEVICESCAN ... -m root -M exec smartd-runner` por defecto de Debian (correo a root, sin uso porque `smartd` no corre); sin cron ni timer que notifique, sin `api.telegram.org` bajo `/etc`; `media-stack-evidence.timer` solo registra evidencia local. Las alertas internas de UGOS no se inspeccionaron (solo interfaz). El hub cubre los discos con `disk-health`.
- **`.env` del NAS antes de integrar.** Se anadieron `NOTIFY_INGEST_URL`, `NOTIFY_INGEST_HOST_ID=nas-home` y `NOTIFY_INGEST_SECRET` (mismo valor que el hub, formato comprobado) al `.env` de la Instancia en `/volume2/media-stack-env/.env` (enlazado desde `/volume2/media-stack/.env`), con copia `.env.bak-phase08-202611281042`. `PUID`, `PGID`, `APPDATA_ROOT` y `TELEGRAM_*` ya estaban.
- **Release.** `auto-release` publico v3.7.0 (09:53Z) y el seguidor del NAS la aplico (checkout `699eb23`, contenedores recreados a las 09:55Z).
- **Emisores apagados (D-09).** Recuento de `TELEGRAM|WUD_TRIGGER` en el entorno: `wud` 0, `security-monitor` 0, `issue-automator` 0. `backup` conserva 2 (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) mas las 3 `NOTIFY_INGEST_*`; `issue-automator` tiene las 3 `NOTIFY_INGEST_*`.
- **Copia.** `docker exec backup media-backup notify-test ingest`: salida 0, "the hub confirmed the test event and its closing" (prueba tambien que el secreto coincide con el del hub). `notify-test fallback`: salida 0, "direct notice sent".
- **Seerr.** Webhook con **Issue Resolved** activado; la notificacion de prueba respondio bien y no salio ningun mensaje de Telegram (confirmado por el usuario).
- **Issue real (D-05).** El usuario reporto y resolvio una issue de prueba: se ejecuto la automatizacion, el hub abrio la incidencia con su mensaje de Telegram y el mismo mensaje se edito al resolver («funciona»).
- **Reintento de la bandeja (Open Questions 3 y 5).** Con `NOTIFY_INGEST_URL` sustituida solo por el entorno del shell a `http://100.74.226.92:1/...` (el `.env` intacto) y `issue-automator` recreado, el usuario reporto y resolvio la issue #8 (WALL·E). Registros: "Queued issue:8:open", "Could not deliver ... retrying", "Queued issue:8:resolved"; `/health` con **`pending` = 2**, dos ficheros en la bandeja y ninguna incidencia nueva en el hub. Al restaurar la URL real y recrear: "Published issue:8:open to the hub" y "Published issue:8:resolved to the hub" unos 60 s despues, **`pending` = 0**, bandeja vacia. En el hub, `ingest_events` `issue:8:open` e `issue:8:resolved` apuntan a la **misma incidencia (166)**, sin duplicados. Su fila de outbox `incident:166:open` quedo `suppressed` (`resolved_before_send`, 56 ms entre ambos), por lo que esa no genero Telegram; es la regla esperada del dispatcher.
- **Colas obsoletas.** Solo existia `/volume2/media-stack-appdata/security-monitor/update-notifications.json` (contenido `[]`), borrado. No hay `notifications.json` bajo el appdata (profundidad 3).

## Task Commits

Esta puerta no produce commits en el repositorio del hub (`files_modified: []`); el trabajo vive en `media-stack` y en produccion.

1. **Task 1: PR en borrador y CI en verde** - `c81dded` en `media-stack` (chore, excepcion de gitleaks); PR #110 integrado despues como `d8005a6`.
2. **Task 2: Desplegar el ingest y probar por familia** - sin commit propio (despliegue del hub `main`, cabeza `1439f6e`).
3. **Task 3: Integrar, esperar al seguidor y verificar** - sin commit propio; release v3.7.0 (`699eb23` en el checkout del NAS).

**Plan metadata:** commit de documentacion de este plan (docs: complete cutover gate plan).

## Files Created/Modified

Ninguno en este repositorio. En `media-stack`: `.gitleaks.toml` (PR #110) y el arreglo posterior del Dockerfile de issue-automator (PR #112, abierto).

## Decisions Made

- **P-31:** los pasos de produccion son `checkpoint:human-action` (D-11): un `git push` a `main` del hub despliega con una migracion y integrar el PR de `media-stack` despliega en el NAS (ADR-0007). El ejecutor prepara lo automatizable y se detiene en cada accion irreversible.
- El orden D-11 se cumplio: hub con ingest y eventos aceptados, contenedor del NAS probado, y solo entonces integrado el PR; ningun emisor se retiro antes.
- Las incidencias de prueba abiertas y cerradas en milisegundos quedan suprimidas por `resolved_before_send`: es la regla del dispatcher, no un defecto del ingest.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] issue-automator no arrancaba tras la release en el NAS (`Permission denied` sobre `/app/main.py`)**
- **Found during:** Task 3 (verificacion posterior a la release, en produccion)
- **Issue:** el contenedor entraba en bucle con `python3: can't open file '/app/main.py': [Errno 13] Permission denied`. El seguidor hace el checkout con umask 077 (`scripts/merged_updates.py:434`), por lo que `main.py` queda 600; el `COPY` del Dockerfile lo deja solo legible por root y el contenedor ahora corre como `PUID:PGID` (1000:10, por la bandeja de 08-15). Ademas, `${APPDATA_ROOT}/issue-automator` la creo Docker como root:root porque el seguidor no ejecuta `scripts/init.sh`.
- **Fix:** arreglo en caliente en el NAS (aplicado por el orquestador y el usuario): `chmod a+r main.py` (el arbol de git sigue limpio), `chown 1000:10` de la carpeta de la bandeja, reconstruida y recreada solo `issue-automator`; queda sano con `pending` 0. Arreglo permanente en `media-stack`: rama `fix/issue-automator-readable-main`, commit `b41ffa5` (`COPY --chmod=0644 main.py ./`), PR https://github.com/alberba/media-stack/pull/112 abierto a la espera de que el usuario lo integre. Verificado en local: imagen construida a partir de un fichero 600 y ejecutada como 1000:10 lee `main.py`.
- **Files modified:** `stacks/extras/issue-automator/Dockerfile` (en el PR #112, fuera de este repositorio)
- **Verification:** `issue-automator` sano tras el arreglo; el reintento de la bandeja y la issue real se probaron despues con exito.
- **Committed in:** `b41ffa5` (media-stack, PR #112 pendiente de integrar)

**2. [Rule 3 - Blocking] Falsos positivos de gitleaks en el CI del PR**
- **Found during:** Task 1
- **Issue:** el secreto inventado `NOTIFY_INGEST_SECRET` de las pruebas de `tests/backup.test.sh` y `tests/issue-automator.test.sh` hacia fallar `gitleaks`.
- **Fix:** excepcion en `.gitleaks.toml` limitada a esos dos ficheros y a las reglas `generic-api-key` y `env-secret-value`.
- **Files modified:** `.gitleaks.toml` (media-stack)
- **Committed in:** `c81dded`

---

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 3)
**Impact on plan:** ambas necesarias para el CI y para que issue-automator funcione en produccion; sin ampliacion de alcance. El arreglo permanente (PR #112) esta pendiente de integrar: mientras tanto el NAS depende del `chmod` en caliente, que una recompilacion futura de la imagen sin ese cambio volveria a romper.

## Issues Encountered

- Tras el cutover, el seguidor de releases no ejecuta `scripts/init.sh`, asi que un host actualizado solo por el seguidor necesita ejecutar `scripts/init.sh` una vez (o un `chown` manual) para la carpeta de la bandeja de issue-automator. La documentacion del cutover asume que el actualizador la crea; en la practica la creo Docker como root.
- El primer `gh pr checks` mostro un `gitleaks` «pending» de un run de `push` ya completado con exito: era un resto de la interfaz, no un fallo.

## Follow-ups (para el usuario)

- Integrar el PR #112 de `media-stack` (arreglo permanente de `COPY --chmod=0644`).
- En hosts actualizados solo por el seguidor: ejecutar `scripts/init.sh` una vez o `chown` manual de `<APPDATA_ROOT>/issue-automator`; conviene reflejarlo en `docs/media-stack-cutover.md` y en `docs/upgrading.md` de `media-stack`.
- La release v3.7.0 no tiene el arreglo del Dockerfile hasta que se integre el PR #112.

## User Setup Required

Ninguno pendiente: el secreto, las tres variables `NOTIFY_INGEST_*` y la bandeja ya estan configuradas en produccion.

## Known Stubs

Ninguno. No se creo codigo en este repositorio.

## Threat Flags

Ninguno nuevo: la superficie (ingest firmado, bandeja local) esta en el modelo de amenazas de 08-01 y 08-15. T-08-26 mitigada (orden D-11 cumplido, contenedor del NAS probado antes de integrar), T-08-27 mitigada (el secreto nunca se imprimio ni se paso por argumentos, recuentos con `grep -c`, el ejecutor no leyo ningun `.env`) y T-08-SC sin instalaciones de gestores de paquetes en el repositorio.

## Next Phase Readiness

La puerta 1 esta cerrada: el ingest esta en produccion y `media-stack` pasa sus avisos por el hub. Quedan 08-11 (despliegue 2: rollups y retencion de 48 h), 08-13 y 08-14 segun la hoja de ruta. Recomendable integrar el PR #112 antes de la siguiente release de `media-stack`.

## Self-Check: PASSED

- `gh pr view 110`: estado MERGED, merge `d8005a6`, 2026-11-28T09:45:44Z.
- `gh pr view 112`: abierto (pendiente del usuario, documentado como seguimiento).
- Commit `c81dded` presente en el historial de `media-stack` (ancestro de `d8005a6`).
- POST sin firma al ingest: 401 (verificado por el ejecutor).
