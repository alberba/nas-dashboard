---
phase: 06-puerta-de-seguridad
plan: "04"
subsystem: api
tags: [request-body, dos, streaming, nextjs, vitest, zod]

requires:
  - phase: 06-puerta-de-seguridad
    provides: "Guards del servidor y arnés tests/verified-session.ts de 06-01"
provides:
  - "src/lib/request-body.ts: DEFAULT_BODY_LIMIT (16 KiB), BodyTooLarge, readBodyText y readJsonBody, lectura acotada en streaming antes de parsear"
  - "DEPLOYMENT_SETTINGS_BODY_LIMIT (64 KiB), alineado con MAX_REQUEST_BYTES de agent/env_settings.py"
  - "Toda mutación del catch-all responde 413 en español sin operación, incidencia, log ni petición al agente"
affects: [06-05, 06-06]

actuals:
  tokens: 7294
  tasks: 3
  commits: 5
  plan_head_before: 739fbebf1195f4020e31fd408e87dcd4e719f1b1
  plan_head_after: 86cfa10ee89364ebd242aa98dc0fc67b8fba3a74

tech-stack:
  added: []
  patterns:
    - "Un único lector de cuerpo: ninguna ruta llama a request.json(); el conteo en streaming es la autoridad y Content-Length solo un atajo"
    - "BodyTooLarge es la primera rama del catch del catch-all y ningún módulo de ruta lo captura"
    - "Los retornos de promesa dentro del try del handler llevan await para que un rethrow llegue al catch"

key-files:
  created:
    - src/lib/request-body.ts
    - tests/request-body.test.ts
  modified:
    - "src/app/api/[...path]/route.ts"
    - src/lib/verification-api.ts
    - src/lib/lifecycle.ts
    - src/lib/renovate-merge.ts
    - src/lib/host-commands.ts
    - src/lib/deployment-settings.ts
    - tests/sensitive-actions.test.ts
    - tests/api-deployment-settings.test.ts

key-decisions:
  - "readBodyText rechaza por Content-Length declarado sin tocar request.body; si la cabecera falta, no es numérica o miente a la baja, cuenta bytes en streaming y cancela el lector"
  - "El texto se acumula como bytes y se decodifica una sola vez con TextDecoder, para no partir un carácter multibyte entre trozos"
  - "deployments/settings declara su propio tope de 64 KiB porque su esquema admite 64 valores de 4096 caracteres y el agente acepta hasta 64 KiB"
  - "handlePasswordVerification relanza BodyTooLarge y la ruta hace return await del manejador: sin el await el rechazo escapaba del try del catch-all"

patterns-established:
  - "Matriz bodyLimitCases por ruta y método en tests/sensitive-actions.test.ts: 413, recuentos de operations, incidents, incident_events y notification_outbox, console.error sin llamadas y cero peticiones al agente"
  - "Una fila de la matriz marcada readsBody: false documenta las rutas que no leen cuerpo (push/test)"

requirements-completed: [SEC-04]

coverage:
  - id: D1
    description: "Un cuerpo por encima de 16 KiB (declarado o real) se rechaza antes de parsear, sin leer el flujo cuando la cabecera ya lo declara excesivo; exactamente el tope pasa y un byte más no; una cabecera que miente a la baja no lo evita"
    requirement: "SEC-04"
    verification:
      - kind: unit
        ref: "tests/request-body.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Un carácter multibyte partido entre trozos, en cualquier posición de corte, se decodifica igual que el cuerpo entero, y JSON.parse no se invoca sobre un cuerpo que superó el tope"
    requirement: "SEC-04"
    verification:
      - kind: unit
        ref: "tests/request-body.test.ts#decodes a multibyte character split between chunks at every cut"
        status: pass
      - kind: unit
        ref: "tests/request-body.test.ts#does not call JSON.parse on a body over the limit"
        status: pass
    human_judgment: false
  - id: D3
    description: "Las catorce mutaciones con cuerpo del catch-all responden 413 sin dejar filas, sin console.error y sin llegar al agente; verification/password responde 413 y no 400; push/test no lee cuerpo"
    requirement: "SEC-04"
    verification:
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#request body limit on every mutation"
        status: pass
    human_judgment: false
  - id: D4
    description: "deployments/settings admite un cuerpo válido de entre 16 y 64 KiB y rechaza con 413 uno por encima de su tope propio"
    requirement: "SEC-04"
    verification:
      - kind: integration
        ref: "tests/api-deployment-settings.test.ts#body limit"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-11-27
status: complete
---

# Phase 6 Plan 4: Tope de cuerpo y 413 sin rastro Summary

**Lector de cuerpo acotado en streaming (16 KiB, 64 KiB en deployments/settings) que responde 413 en español antes de parsear y sin dejar operación, incidencia ni línea de log, aplicado a todas las mutaciones del catch-all.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-11-27T12:50:00Z (aprox.)
- **Completed:** 2026-11-27T13:03:00Z
- **Tasks:** 3
- **Files modified:** 10 (2 nuevos)

## Accomplishments

- `src/lib/request-body.ts` fija el contrato: `readBodyText(request, limit?)` rechaza por `Content-Length` declarado sin leer el flujo y, si no hay cabecera (o miente a la baja), cuenta bytes en streaming, cancela el lector al pasar el tope y decodifica una sola vez. `readJsonBody` solo llama a `JSON.parse` sobre texto que cupo entero y conserva el `SyntaxError` ante un cuerpo vacío o malformado.
- El catch del catch-all responde `{ error: "La solicitud es demasiado grande." }` con 413 como primera rama, antes de host no encontrado, Zod y el `console.error` genérico: ni operación, ni incidencia, ni log, ni petición al agente.
- Topes aplicados por ruta: 16 KiB (`DEFAULT_BODY_LIMIT`) en setup, verification/password, containers/remove, host-command, las tres acciones de incidencia, renovate/merge, presence, action, settings y push POST/DELETE; 64 KiB (`DEPLOYMENT_SETTINGS_BODY_LIMIT`) en deployments/settings. `push/test` no lee cuerpo.
- Matriz `bodyLimitCases` de 14 mutaciones más la fila `push/test`, con recuento de filas en `operations`, `incidents`, `incident_events` y `notification_outbox`, `console.error` espiado y cero peticiones al agente falso.

## Casos de borde cubiertos

- Content-Length declarado grande con flujo no leído (bandera de `pull`), cuerpo troceado sin cabecera con cancelación del lector, y cabecera que miente a la baja.
- Frontera: exactamente el tope pasa y un byte más se rechaza, con y sin Content-Length.
- Cabecera no numérica: cae al conteo en streaming.
- Multibyte (2 a 4 bytes) partido en todas las posiciones de corte.
- `JSON.parse` espiado: no se llama con un cuerpo por encima del tope.
- verification/password: 413 (no 400) con cuerpo grande y 400 con cuerpo mal formado.
- setup: se vacía la tabla `user` para que la ruta llegue a leer y se vuelve a sembrar después.

## Task Commits

1. **Tarea 1 (tracer): helper, rama action y 413 sin rastro** - `5c665bb` (feat)
2. **Tarea 2 (TDD) RED: tope propio de deployments/settings** - `b1d8f39` (test)
3. **Tarea 2 GREEN: módulos de ruta con el lector acotado** - `137fd82` (feat)
4. **Tarea 3 (TDD) RED: matriz de 413 por mutación** - `6d7ae65` (test)
5. **Tarea 3 GREEN: resto del catch-all y rethrow en la verificación por contraseña** - `86cfa10` (feat)

## TDD notes

- Tarea 2 RED: `answers 413 above its own limit without an operation or agent request` falló con `expected 200 to be 413` (la petición llegaba al agente); el caso "entre 16 y 64 KiB" ya pasaba y queda como protección contra una regresión al aplicar el tope global. La constante `DEPLOYMENT_SETTINGS_BODY_LIMIT` se declaró en el commit RED solo para que la prueba tuviera tamaños definidos; no se usaba aún.
- Tarea 3 RED: 10 casos fallaron con `expected 400 to be 413` (setup, verification/password, tres acciones de incidencia, presence, settings, push POST, push DELETE y la comprobación específica de no degradar a 400). Las rutas ya migradas en la tarea 2 pasaban.
- El plan es `type: execute` (sin evidencia RED por clasificador); la inspección semántica del RED se hizo leyendo los mensajes de aserción de vitest.

## Files Created/Modified

- `src/lib/request-body.ts` - `DEFAULT_BODY_LIMIT`, `BodyTooLarge`, `readBodyText`, `readJsonBody`.
- `src/app/api/[...path]/route.ts` - todas las lecturas con `readJsonBody`, rama `BodyTooLarge` primera en el catch y `return await` de la verificación por contraseña.
- `src/lib/verification-api.ts` - `handlePasswordVerification` relanza `BodyTooLarge`.
- `src/lib/lifecycle.ts`, `src/lib/renovate-merge.ts`, `src/lib/host-commands.ts` - `readJsonBody` con el tope por defecto, antes de cada guard.
- `src/lib/deployment-settings.ts` - `DEPLOYMENT_SETTINGS_BODY_LIMIT` y `readJsonBody` con ese `limit`.
- `tests/request-body.test.ts` - nuevo, 15 pruebas unitarias del lector.
- `tests/sensitive-actions.test.ts` - casos de 413 de `/api/action` y matriz `bodyLimitCases`; el arnés `api` admite `DELETE`.
- `tests/api-deployment-settings.test.ts` - cuerpo entre 16 y 64 KiB pasa, por encima 413.

## Decisions Made

Ver `key-decisions`. La principal fue el `return await` de `handlePasswordVerification`: con el rethrow de `BodyTooLarge`, un `return` sin `await` dentro del `try` dejaba escapar el rechazo del catch-all (lo destapó la matriz, no estaba en el plan).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] El rechazo de verification/password escapaba del catch del catch-all**
- **Found during:** Tarea 3 (GREEN)
- **Issue:** `return handlePasswordVerification(...)` sin `await` dentro de un `try`: la promesa rechazada con `BodyTooLarge` no pasaba por el `catch`, y la prueba fallaba con la excepción sin tratar en vez de 413.
- **Fix:** `return await handlePasswordVerification(...)`, con comentario.
- **Files modified:** `src/app/api/[...path]/route.ts`
- **Verification:** la matriz y `tests/verification.test.ts` en verde.
- **Commit:** `86cfa10`

**Total deviations:** 1 auto-fixed (1 bug). **Impact:** ninguno sobre el alcance; era el borde que el plan pedía vigilar (T-06-14).

## Issues Encountered

- `DATABASE_URL` no estaba exportado: las suites se ejecutaron contra el PostgreSQL 18 desechable de loopback (`127.0.0.1:55432`, contenedor `hub-phase3-pg`) con `HUB_REQUIRE_TEST_DB=1`, así que ninguna suite se omitió.
- `pnpm lint` completo sigue fallando por los directorios de herramienta no versionados (`.claude/`, `.agents/`, `.codex/`, `.opencode/`), problema previo ya anotado en `deferred-items.md`; `pnpm lint src tests` sale 0.
- Una primera ejecución de la suite completa mostró 2 fallos de un archivo que no se pudo reproducir; las tres ejecuciones siguientes dieron 54 archivos / 766 pruebas en verde. No se identificó la prueba intermitente.

## Verification

- `pnpm test` (suite completa, `HUB_REQUIRE_TEST_DB=1`): 54 archivos / 766 pruebas en verde.
- `pnpm typecheck`: sin errores. `pnpm lint src tests`: sin errores.

## Known Stubs

None.

## Threat Flags

None. No hay rutas, dependencias ni esquema nuevos; el único cambio de superficie es el rechazo 413 previo al parseo (T-06-12 a T-06-15 mitigados). Las rutas `/api/auth/*` siguen sin tope hasta 06-05, como declara el plan.

## Next Phase Readiness

06-05 puede consumir `readJsonBody`/`BodyTooLarge` para el cuerpo de Better Auth y el escaneo que impide leer cuerpos sin el helper; 06-06 acota las respuestas del agente.

## Self-Check: PASSED

- `src/lib/request-body.ts` y `tests/request-body.test.ts` existen.
- Commits `5c665bb`, `b1d8f39`, `137fd82`, `6d7ae65` y `86cfa10` presentes en la historia; secuencia RED (`test`) y GREEN (`feat`) respetada en las tareas 2 y 3.
