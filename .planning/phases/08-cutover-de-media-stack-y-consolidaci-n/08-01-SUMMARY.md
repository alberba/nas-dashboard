---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "01"
subsystem: notifications
tags: [ingest, hmac, idempotency, incidents, telegram, zod]

requires:
  - phase: 08-14
    provides: tabla ingest_events (source+eventId) y migracion 0009
provides:
  - POST /api/notifications/ingest con contrato v1 firmado por HMAC-SHA256
  - handleIngest, verifyIngest, signIngest, composeIngestNotice, ingestEnvelope, ingestScopeAllows
  - readIngestSecrets y validacion de arranque de NOTIFY_INGEST_SECRET(_PREVIOUS)
  - closedBy "ingest" en el almacen de incidencias
affects: [08-02 ciclo de issues de Seerr, 08-03 runbook de rotacion, 08-05 poda de ingest_events, 08-06 y 08-07 productores]

tech-stack:
  added: []
  patterns:
    - "Verificacion HMAC antes de tocar la base, un unico 401 para firma, ventana y cabecera"
    - "Idempotencia en la misma transaccion que la incidencia: INSERT ON CONFLICT DO NOTHING RETURNING y bodyHash"
    - "Secreto opcional al arrancar, leido por peticion; la ruta responde 503 si falta"

key-files:
  created:
    - src/lib/notification-ingest.ts
    - src/app/api/notifications/ingest/route.ts
    - tests/notification-ingest.test.ts
  modified:
    - src/lib/runtime-config.ts
    - src/lib/incident-store.ts
    - src/lib/sensitive-actions.ts
    - .env.example
    - tests/runtime-config.test.ts

key-decisions:
  - "P-01: firma v1=<hex> sobre <timestamp>.<cuerpo>, ventana de 300 s, cuerpo <= 8 KiB, esquema zod estricto"
  - "P-02: un unico 401 y mismo cuerpo para firma, ventana y cabecera; nada toca la base antes de la firma"
  - "P-03/P-05: repeticion exacta 200 duplicate (confirmacion para el productor), mismo eventId con otro cuerpo 409"
  - "P-04: NOTIFY_INGEST_SECRET opcional al arrancar; sin secreto la ruta responde 503"

requirements-completed: [CONT-02]

coverage:
  - deliverable: "Evento backup-failed firmado abre incidencia inmediata de Telegram con outbox (202)"
    verification:
      - kind: test
        ref: "tests/notification-ingest.test.ts#abre una incidencia inmediata de Telegram con su outbox"
        status: pass
    human_judgment: false
  - deliverable: "Rechazos 401/400/413/422/503 sin filas en ingest_events, incidents ni notification_outbox"
    verification:
      - kind: test
        ref: "tests/notification-ingest.test.ts#rechaza / secreto / alcance"
        status: pass
    human_judgment: false
  - deliverable: "Idempotencia atomica: repeticion 200, colision 409, concurrencia y reversion"
    verification:
      - kind: test
        ref: "tests/notification-ingest.test.ts#idempotencia"
        status: pass
    human_judgment: false
  - deliverable: "Secreto actual y anterior (D-17) y arranque sin secreto"
    verification:
      - kind: test
        ref: "tests/notification-ingest.test.ts#secreto, tests/runtime-config.test.ts#notification ingest secrets"
        status: pass
    human_judgment: false

actuals:
  tokens: 10400
  tasks: 3
  commits: 3

plan_head_before: c177bbb1354b311cfc78d2bdfd93d25c323bc28c
plan_head_after: 6136767d3478c9cd995977ebaeb91e400c47cf40

duration: 8 min
completed: 2026-11-28
status: complete
---

# Phase 8 Plan 01: Ingest firmado de avisos Summary

**El hub acepta eventos `backup-failed` firmados con HMAC-SHA256 en `POST /api/notifications/ingest`, los registra una sola vez en la misma transaccion que la incidencia y abre el aviso inmediato de Telegram con su outbox.**

## Contrato v1 implementado

- Ruta `POST /api/notifications/ingest`, fuera del catch-all y sin sesion; `route.ts` solo exporta `POST` y delega en `handleIngest`.
- Cabeceras `X-Ingest-Timestamp` (10 digitos, segundos de epoca) y `X-Ingest-Signature: v1=<64 hex en minuscula>`.
- Firma: `HMAC-SHA256(secreto, "<timestamp>.<cuerpo crudo>")`; ventana `|ahora - timestamp| <= 300 s` (300 pasa, 301 no).
- Cuerpo <= 8 KiB leido solo con `readBodyText`; esquema `z.strictObject` con `v` (1), `source` (`backup` | `issue-automator`), `eventId` (<= 128, `[A-Za-z0-9._:-]`), `hostId`, `key`, `state` (`open` | `resolved`) y `data` opcional estricto (`errors` <= 5x200, `subject` 200, `reportedBy` 100, `problem` 300, `action` 500).
- Alcance (D-07): `backup` solo con `backup-failed`; `issue-automator` solo con `^issue:seerr:\d{1,9}$`; `hostId` debe estar en `getHosts()`.
- El hub compone titulo, detalle y severidad (`composeIngestNotice`): `backup` da "Copia fallida en <host>" (critical) con los errores unidos; `issue-automator` da el asunto (<= 120) con warning. Texto plano sin controles ni `<>`.
- El canal sale de `notificationPolicy` con `closedBy: "ingest"`; `backup-failed` es telegram inmediato.

### Vector de contrato

Secreto `ingest-contract-secret-0123456789abcdef`, timestamp `1700000000`, cuerpo
`{"v":1,"source":"backup","eventId":"backup-failed:1700000000","hostId":"nas-home","key":"backup-failed","state":"open","data":{"errors":["restic backup failed (exit 1)"]}}`
produce la firma `4525b5167d3882979d6b063dde511c6c28d2bec94d65811d2f512581b76eada1` (comprobada byte a byte en `tests/notification-ingest.test.ts`).

### Respuestas por codigo

| Codigo | Cuerpo | Cuando |
| --- | --- | --- |
| 202 | `{status:"accepted",action}` | Evento procesado (`opened`, `observed`, `escalated`, `resolved` o `ignored`) |
| 200 | `{status:"duplicate"}` | Mismo `source`, `eventId` y cuerpo (confirmacion para el productor) |
| 409 | `{status:"conflict"}` | Mismo `source` y `eventId` con otro cuerpo |
| 400 | `{status:"invalid"}` | JSON mal formado, campo desconocido, `v` distinto de 1, esquema |
| 401 | `{status:"unauthorized"}` | Firma, ventana o cabecera: mismo codigo y cuerpo |
| 413 | `{status:"too-large"}` | Cuerpo > 8 KiB, antes de verificar y sin tocar la base |
| 422 | `{status:"out-of-scope"}` | Pareja fuente/clave fuera de alcance o `hostId` desconocido |
| 503 | `{status:"unavailable"}` | Sin secreto valido, host mal configurado o fallo de transaccion |

Todas las respuestas llevan `Cache-Control: no-store`. Ningun camino registra cuerpo, cabeceras ni secreto; un fallo de transaccion solo registra el nombre del error.

### Idempotencia y secretos

- `INSERT INTO ingest_events ... ON CONFLICT DO NOTHING RETURNING` y, si inserta, `recordIncidentObservationIn` en la misma `db.transaction`; cualquier fallo revierte ambas filas y el reintento se procesa. Con dos peticiones simultaneas la segunda espera el indice, ve la fila confirmada y responde duplicado.
- `verifyIngest` evalua el secreto actual y el anterior siempre (`timingSafeEqual` sobre buffers de 32 bytes, sin cortocircuito).
- `readIngestSecrets(env)` devuelve `{secret, previous} | null`; `readRuntimeConfig` valida (razones `invalid`, `example`, `incomplete_pair`) pero no anade campo a `RuntimeConfig`, de modo que el hub arranca sin el secreto.

## Task Commits

1. Tarea 1 (tracer): `31a0d40` feat(08-01): signed ingest opens an immediate backup-failed incident
2. Tarea 2: `6e171b7` test(08-01): every ingest rejection closes without effects
3. Tarea 3: `6136767` test(08-01): atomic idempotency, concurrency and open/resolved cycle

## Decisions Made

P-01 a P-06 se aplicaron tal como estan en el plan. P-05 (cerrada por el usuario): repeticion exacta 200 `duplicate` y colision de contenido 409. Sin paquetes nuevos.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Separadores Unicode literales en una expresion regular**
- **Found during:** Tarea 1
- **Issue:** La herramienta de escritura convirtio las secuencias de escape de los separadores de linea y de parrafo Unicode en caracteres literales dentro de la regex de `plain()`, que rompia el parseo (`Unterminated regular expression`).
- **Fix:** Se sustituyeron por las clases `\p{Zl}\p{Zp}` (mismos caracteres, con la bandera `u`).
- **Files modified:** `src/lib/notification-ingest.ts`
- **Commit:** `31a0d40`

**2. [Rule 2 - Missing critical] Cierre del oraculo con un secreto mal formado**
- **Found during:** Tarea 2
- **Issue:** Un `NOTIFY_INGEST_SECRET` corto o de ejemplo no debe servir para verificar firmas aunque el arranque lo haya dejado pasar en otro entorno.
- **Fix:** `readIngestSecrets` devuelve `null` ante cualquier problema de validacion, asi que la ruta responde 503 en lugar de verificar con un secreto debil; cubierto por una prueba.
- **Files modified:** `src/lib/runtime-config.ts`, `tests/notification-ingest.test.ts`
- **Commit:** `31a0d40`, `6e171b7`

**3. [Nota de proceso] Ciclo TDD de las tareas 2 y 3**
- La tarea 1 (tracer) implemento `handleIngest` completo (todas las ramas de rechazo e idempotencia) para cerrar un camino de produccion extremo a extremo, por lo que las pruebas de las tareas 2 y 3 se escribieron sobre una implementacion ya existente y pasaron al primer intento; no hubo fase RED separada. Las pruebas cubren cada rama del `<behavior>` con aserciones sobre filas y codigos, no sobre copy.

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical) y 1 nota de proceso. **Impact:** ninguno sobre el alcance.

## Issues Encountered

Ninguno pendiente. Nota para 08-02: la clave `issue:seerr:<n>` no esta en `CRITICAL_IMMEDIATE_KEYS` de `notification-policy.ts`, de modo que `notificationPolicy` la deriva a `digest` por ser una clave no auditada; el ingest respeta esa politica y 08-02 decide si la promueve a inmediata.

## Known Stubs

Ninguno.

## Threat Flags

Ninguno: la unica superficie nueva (la ruta de ingest) es la del threat model del plan (T-08-01 a T-08-06), con HMAC, ventana, limite de cuerpo y alcance cerrado.

## Verification

- `HUB_REQUIRE_TEST_DB=1 pnpm test` (suite completa): 60 archivos, 1034 pruebas pasan; `tests/notification-ingest.test.ts` 50 pruebas, `tests/runtime-config.test.ts` 85, `tests/sensitive-actions.test.ts` verde con el escaneo de rutas reales.
- `pnpm typecheck`, `pnpm lint` (con los ignores del entorno) y `pnpm build`: sin errores; `/api/notifications/ingest` aparece como ruta dinamica.
- Criterios de aceptacion: `grep -c "notifications/ingest" src/lib/sensitive-actions.ts` = 1, `grep -c "hmac-ingest"` = 2, `grep -c '"ingest"' src/lib/incident-store.ts` = 1, `grep -c NOTIFY_INGEST_SECRET` = 3 en `.env.example` y 6 en `runtime-config.ts`.

## Next Phase Readiness

Listo para 08-02 (ciclo de vida de issues de Seerr y guarda contra snapshots viejos) y para que 08-03 documente la rotacion del secreto. No se tocaron STATE.md ni ROADMAP.md (los escribe el orquestador).

## Self-Check: PASSED

- FOUND: src/lib/notification-ingest.ts, src/app/api/notifications/ingest/route.ts, tests/notification-ingest.test.ts
- FOUND commits: 31a0d40, 6e171b7, 6136767
