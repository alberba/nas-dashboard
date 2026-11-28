---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "02"
subsystem: notifications
tags: [incidents, telegram, ingest, notification-policy, evidence-guard]

requires:
  - phase: 08-01
    provides: ingest firmado (handleIngest, composeIngestNotice, closedBy ingest)
provides:
  - "notificationPolicy: issue:seerr:<n> inmediata de Telegram con cualquier severidad y PUSH_WARNINGS"
  - "IncidentObservation.origin (live | ingest) y guardia evidenceAt en la rama de cierre"
  - "AlertSignal.evidenceAt en backup-failed a partir de backup.at, reenviada por el colector"
  - "pruebas del ciclo abrir y cerrar con edicion del mensaje, texto plano acotado y envio sin parse_mode"
affects: [08-06 y 08-07 productores, 08-10 puerta de apagado del emisor SMART externo]

actuals:
  tokens: 5000
  tasks: 3
  commits: 3

plan_head_before: c79249642cec5473343512743b4c9d36a43475ee
plan_head_after: beec7d9d755f0d543abefd89d8e65b1a691a6f28

tech-stack:
  added: []
  patterns:
    - "Guardia de evidencia vieja: una observacion de cierre con evidenceAt anterior a open.at no cierra un episodio de origen ingest"
    - "Rama de politica explicita por prefijo, antes del respaldo de claves no auditadas"

key-files:
  created: []
  modified:
    - src/lib/notification-policy.ts
    - src/lib/incident-store.ts
    - src/lib/notification-ingest.ts
    - src/lib/maintenance-alerts.ts
    - src/lib/collector.ts
    - tests/notification-ingest.test.ts
    - tests/maintenance-alerts.test.ts
    - tests/collector-alerts.test.ts
    - tests/incident-store.test.ts

key-decisions:
  - "P-07: la guardia evidenceAt solo afecta a incidencias con origin ingest; las del colector se cierran con un snapshot ok como antes"
  - "P-08: IncidentObservation.origin admite live (por defecto) e ingest; la columna es texto libre, sin migracion"
  - "P-09: evidenceAt es Date.parse(backup.at) en ms, solo en backup-failed, y el colector solo la envia en la rama failing false"

requirements-completed: [CONT-02]

coverage:
  - id: D1
    description: "issue:seerr:<n> es inmediata de Telegram con cualquier severidad y con PUSH_WARNINGS activo o no"
    requirement: CONT-02
    verification:
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#sends every Seerr issue to Telegram at once"
        status: pass
      - kind: integration
        ref: "tests/notification-ingest.test.ts#no depende de PUSH_WARNINGS para entregar la issue por Telegram"
        status: pass
    human_judgment: false
  - id: D2
    description: "Ciclo de vida por issue: open abre con origen ingest, resolved cierra con closedBy ingest y edita el mensaje, el reintento y el open repetido no duplican, reabrir abre un episodio nuevo"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/notification-ingest.test.ts#ciclo"
        status: pass
    human_judgment: false
  - id: D3
    description: "Un snapshot ok con backup.at anterior a la apertura por el ingest no cierra el aviso; uno posterior lo cierra una sola vez; las incidencias live no cambian"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/collector-alerts.test.ts#ingest: an older ok snapshot leaves the notice open and a newer one closes it once"
        status: pass
      - kind: integration
        ref: "tests/incident-store.test.ts#recovery evidence"
        status: pass
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#carries the backup timestamp as evidence only on the backup signal"
        status: pass
    human_judgment: false
  - id: D4
    description: "Titulo (<=120) y detalle (<=600) del ingest sin caracteres de control con entradas hostiles en el tope, y envio de Telegram sin parse_mode"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/notification-ingest.test.ts#texto compuesto por el hub"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-06: SMART cubierto por disk-health (critico inmediato, aviso al digest) sin clave nueva"
    verification:
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#reports a disk to watch or a failing disk with its severity"
        status: pass
      - kind: unit
        ref: "tests/maintenance-alerts.test.ts#keeps the audited immediate keys and the disk escalation"
        status: pass
    human_judgment: false

duration: 8 min
completed: 2026-11-28
status: complete
---

# Phase 8 Plan 02: Ciclo de issues de Seerr y guardia de evidencia vieja Summary

**Cada issue de Seerr es una incidencia inmediata de Telegram que el ingest abre y cierra editando el mismo mensaje, y un snapshot de mantenimiento con evidencia anterior no puede cerrar el aviso que el ingest acaba de abrir.**

## Performance

- **Duration:** 8 min
- **Tasks:** 3 (1 tracer, 2 auto/tdd)
- **Files modified:** 9 (5 de fuente, 4 de pruebas), sin ficheros nuevos
- **Suite completa:** 60 archivos, 1052 pruebas pasan; `pnpm typecheck` y `pnpm lint` sin errores

## Accomplishments

- **Disposicion de `issue:seerr:`:** rama explicita en `notificationPolicy` (`SEERR_ISSUE_PREFIX`), colocada tras la del prefijo silencioso y antes del respaldo de claves no auditadas, que devuelve `{ telegram, policy_immediate, digest: false, immediate: true }` con cualquier severidad y cualquier `pushWarnings`. Resuelve la nota de 08-01: la clave ya no cae al digest.
- **Ciclo de vida (D-05):** `handleIngest` abre con `origin: "ingest"`; un `resolved` posterior cierra con `closedBy = ingest` y, una vez enviado el primer aviso, deja una sola fila `incident-open` y una `incident-edit` (ningun mensaje nuevo). Reintento (200 `duplicate`) y `open` con otro `eventId` (`observed`) no duplican; reabrir tras cerrar abre un episodio nuevo con otro id.
- **Guardia `evidenceAt` (alcance real):** solo se aplica cuando la incidencia abierta tiene `origin = "ingest"` y `open.at > evidenceAt`; entonces la observacion de cierre devuelve `ignored` sin escribir filas. Las incidencias `live` (las del colector) se cierran con un snapshot `ok` como antes y los casos existentes de `collector-alerts` no se tocaron.
- **Senal `backup-failed`:** lleva `evidenceAt = Date.parse(backup.at)` solo si `backup.at` es una fecha valida (ninguna otra senal la lleva); `condition` la reenvia a la observacion unicamente en la rama `failing: false`; `collectSnapshotAlerts` la pasa desde la senal.
- **Texto compuesto (T-08-08):** `composeIngestNotice` de 08-01 ya aplicaba una unica funcion de saneado (`plain`) con los topes 120/600/200, asi que no hizo falta cambiar codigo; se anadieron las pruebas con entradas hostiles (saltos de linea, tabuladores, NUL, bidi, separador de linea Unicode, etiquetas, Markdown, menciones, fences) en el tope de cada campo y con cinco errores de 200 caracteres en un evento de copia.
- **Sin `parse_mode`:** confirmado leyendo `telegram.ts` y `notification-dispatch.ts` (el unico `parse_mode` de `telegram.ts` es un comentario) y probado de extremo a extremo: una prueba abre una issue hostil por la ruta firmada, ejecuta `runDispatchOnce` con un transporte que registra la peticion y comprueba que el cuerpo de `sendMessage` no tiene `parse_mode`.
- **D-06 (SMART):** cubierto por los casos existentes de `disk-health` en `tests/maintenance-alerts.test.ts` (senal con `watch` y `fail`, critico inmediato de Telegram, aviso al digest o push segun `pushWarnings`); no se anadio ninguna clave nueva ni caso nuevo, porque los cuatro comportamientos ya estaban cubiertos.

## Task Commits

1. **Tarea 1 (tracer): una issue de Seerr se abre y se cierra por el ingest** - `91b1932` (feat)
2. **Tarea 2: un snapshot viejo no cierra el aviso que el ingest acaba de abrir** - `96fb946` (feat)
3. **Tarea 3: texto plano y acotado, envio sin parse_mode, D-06** - `beec7d9` (test)

**Plan metadata:** commit de este SUMMARY (docs).

## Decisions Made

P-07, P-08 y P-09 se aplicaron como estan en el plan (ver `key-decisions`). Sin paquetes nuevos, sin migracion, sin variables de entorno nuevas.

## Deviations from Plan

### Auto-fixed Issues

**1. [Nota de proceso] Ciclo TDD de las tareas 2 y 3**
- La implementacion de la tarea 2 se escribio antes que sus pruebas y la de la tarea 3 no necesito codigo (el saneado ya existia desde 08-01), por lo que no hubo fase RED separada. Para sustituirla se hizo una comprobacion de mutacion en la tarea 2: con la condicion `open.origin === "ingest"` cambiada por una imposible, fallan exactamente el caso `ingest` del colector y el caso del almacen "ignores a recovery whose evidence predates an ingest episode"; restaurada, todo pasa.

**2. [Rule 3 - Blocking] Caracteres invisibles literales en una prueba**
- **Found during:** Tarea 3
- **Issue:** la herramienta de escritura convirtio los escapes Unicode de direccion (bidi) y de separador de linea de la cadena hostil en caracteres literales invisibles dentro del fichero de pruebas (el mismo fenomeno que ya se anoto en 08-01).
- **Fix:** la cadena se construye con `String.fromCharCode(0x0000, 0x202e, 0x2028)`, de modo que el fichero no contiene ningun caracter invisible.
- **Files modified:** `tests/notification-ingest.test.ts`
- **Commit:** `beec7d9`

**Total deviations:** 1 auto-fixed (Rule 3) y 1 nota de proceso. **Impact:** ninguno sobre el alcance.

## Issues Encountered

Ninguno pendiente.

## Known Stubs

Ninguno.

## Threat Flags

Ninguno: no se anade superficie de red, autenticacion ni esquema. T-08-07 (cierre con snapshot viejo) queda mitigado por la guardia `evidenceAt` (casos de almacen y de colector); T-08-08 por el saneado unico y la ausencia de `parse_mode`; T-08-09 por la lista de alcance de 08-01 (la prueba `una resolved de una fuente no cierra la incidencia de otra` responde 422 sin efectos).

## Verification

- `HUB_REQUIRE_TEST_DB=1 pnpm test` (suite completa): 60 archivos, 1052 pruebas pasan; sin suites omitidas.
- `pnpm typecheck` y `pnpm lint` (con los ignores del entorno): sin errores.
- Criterios de aceptacion: `grep -c "issue:seerr:" src/lib/notification-policy.ts` = 1; `grep -c 'origin: input.origin' src/lib/incident-store.ts` = 1; `grep -c evidenceAt` = 3 en `incident-store.ts`, 4 en `collector.ts` y 3 en `maintenance-alerts.ts`.

## Next Phase Readiness

El hub ya abre y cierra issues de Seerr con ciclo de vida y protege el aviso de copia fallida frente a la carrera con el snapshot. Los productores (08-06 y 08-07) pueden enviar `issue:seerr:<n>`; 08-10 debe localizar y apagar el emisor SMART externo. No se tocaron STATE.md ni ROADMAP.md (los escribe el orquestador).

## Self-Check: PASSED

- FOUND: src/lib/notification-policy.ts, src/lib/incident-store.ts, src/lib/notification-ingest.ts, src/lib/maintenance-alerts.ts, src/lib/collector.ts, tests/notification-ingest.test.ts, tests/maintenance-alerts.test.ts, tests/collector-alerts.test.ts, tests/incident-store.test.ts
- FOUND commits: 91b1932, 96fb946, beec7d9
