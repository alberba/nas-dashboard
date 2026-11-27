---
phase: 06-puerta-de-seguridad
plan: "06"
subsystem: api-security
tags: [response-limit, bounded-reader, streaming, agent-client, effect, nextjs, vitest, playwright]

requires:
  - phase: 06-puerta-de-seguridad
    provides: "06-03: catch ordenado y route.ts del catch-all; 06-05: BodyTooLarge y su rama 413 en el catch"
provides:
  - "ResponseTooLarge, AGENT_RESPONSE_LIMITS y responseLimitFor en src/lib/nas.ts"
  - "Lector acotado unico (readBounded) en nasEffectForHost: rechazo por Content-Length sin leer, corte en streaming con cancelacion, decodificacion unica al final"
  - "502 agent_response_too_large con mensaje fijo en espanol desde el catch-all"
  - "useHostRead, listado de archivos y estado de mantenimiento conservan el ultimo dato y dicen que la respuesta es demasiado grande"
  - "SnapshotState.tooLarge y data-snapshot-note=too-large; data-files-error en el listado"
  - "Seccion del README Limites de cuerpo y de respuesta"
affects: [07-acciones-desde-telegram]

actuals:
  tokens: 9334
  tasks: 3
  commits: 6

plan_head_before: 55879e6950adefb5db87d543915f53cd5f33e2f7
plan_head_after: 3de5f0949dc3a761a457b16982463de796507ab1

tech-stack:
  added: []
  patterns:
    - "Un solo lector acotado por el que pasa toda respuesta del agente: el exceso es un tipo de error propio dentro de NasInvalidResponse (o NasRejected si la respuesta ya era un error), asi los llamadores existentes lo tratan como contrato roto sin cambios"
    - "Acumular los trozos y decodificar una sola vez: JSON.parse solo ve una respuesta que cupo entera, sin importar donde caiga el corte (incluido mitad de un caracter multibyte)"
    - "El estado de la vista distingue el fallo por tamano con un codigo estable del cuerpo 502, no por el texto"

key-files:
  created: []
  modified:
    - src/lib/nas.ts
    - "src/app/api/[...path]/route.ts"
    - src/components/views/use-host-read.ts
    - src/components/file-browser.tsx
    - src/lib/maintenance-polling.ts
    - src/components/views/maintenance-status.tsx
    - tests/agent-client.test.ts
    - tests/api-deployments.test.ts
    - tests/api-logs.test.ts
    - tests/collector-alerts.test.ts
    - tests/maintenance-polling.test.ts
    - tests/security-review.test.ts
    - tests/e2e/files-apps.spec.ts
    - README.md

key-decisions:
  - "El exceso en una respuesta correcta es NasInvalidResponse({ cause: ResponseTooLarge }), nunca NasRejected: collector.ts y deploy-progress.ts ya tratan esa clase como contrato roto y un POST ejecutado cae en la rama de resultado pendiente, asi que no se toco ninguno"
  - "En una respuesta con error el exceso es NasRejected con su estado y el mensaje generico: el estado es lo fiable"
  - "readBounded recibe la senal del Effect y cancela el lector al abortar (p. ej. por timeout), y nunca devuelve datos parciales tras abortar"
  - "El listado de archivos solo conserva las entradas cuando el fallo es de la misma raiz y carpeta que las cargadas (referencia al ultimo listado correcto); al cambiar de carpeta se descartan"
  - "El 502 deja una linea de log con solo el tope, sin contenido"

patterns-established:
  - "Un camino nuevo del agente con respuesta grande se declara en AGENT_RESPONSE_LIMITS y responseLimitFor; el resto cae en 1 MiB"

requirements-completed: [SEC-04]

coverage:
  - id: D1
    description: "Una respuesta del agente con Content-Length por encima del tope no se lee, y una sin cabecera se corta en streaming cancelando el lector; ambas son NasInvalidResponse con cause ResponseTooLarge"
    requirement: "SEC-04"
    verification:
      - kind: test
        ref: "tests/agent-client.test.ts#refuses a declared oversize without reading the stream"
        status: pass
      - kind: test
        ref: "tests/agent-client.test.ts#cuts an undeclared oversize while streaming and cancels the reader"
        status: pass
    human_judgment: false
  - id: D2
    description: "Exactamente el tope se lee y se valida, y JSON.parse nunca ve datos parciales en ningun punto de corte, incluido mitad de un caracter multibyte"
    requirement: "SEC-04"
    verification:
      - kind: test
        ref: "tests/agent-client.test.ts#reads exactly the cap and parses it whole, never a partial body"
        status: pass
      - kind: test
        ref: "tests/agent-client.test.ts#turns every cut point into ResponseTooLarge, even inside a multibyte character"
        status: pass
    human_judgment: false
  - id: D3
    description: "El exceso de un POST es resultado pendiente (NasInvalidResponse) y el de una respuesta con error conserva NasRejected con su estado"
    requirement: "SEC-04"
    verification:
      - kind: test
        ref: "tests/agent-client.test.ts#leaves an oversized POST answer as an unverified result, not a rejection"
        status: pass
      - kind: test
        ref: "tests/agent-client.test.ts#keeps the status of an oversized error answer as a rejection"
        status: pass
    human_judgment: false
  - id: D4
    description: "GET /api/deployments y GET /api/logs con una respuesta por encima del tope responden 502 agent_response_too_large sin datos del agente, y la lectura siguiente responde 200"
    requirement: "SEC-04"
    verification:
      - kind: test
        ref: "tests/api-deployments.test.ts#answers 502 with a stable code when the agent response is over its cap"
        status: pass
      - kind: test
        ref: "tests/api-logs.test.ts#answers 502 with a stable code and no log line when the agent answer is over its cap"
        status: pass
    human_judgment: false
  - id: D5
    description: "El colector trata el exceso de /metrics como contrato roto: ninguna muestra, ninguna incidencia resuelta ni connection abierta"
    requirement: "SEC-04"
    verification:
      - kind: test
        ref: "tests/collector-alerts.test.ts#treats a metrics answer over its cap as a contract failure, not a disconnect"
        status: pass
    human_judgment: false
  - id: D6
    description: "El sondeo de mantenimiento conserva el ultimo snapshot como obsoleto con tooLarge, lo limpia en la siguiente respuesta correcta y deja la fase error si no habia snapshot"
    requirement: "SEC-04"
    verification:
      - kind: test
        ref: "tests/maintenance-polling.test.ts#a response the hub refused as too large"
        status: pass
    human_judgment: false
  - id: D7
    description: "Un refresco fallido de la misma carpeta conserva las entradas y expone data-files-error; otra carpeta descarta las anteriores"
    requirement: "SEC-04"
    verification:
      - kind: test
        ref: "tests/e2e/files-apps.spec.ts#a refresh of the same folder refused as too large keeps the listed entries"
        status: pass
    human_judgment: false
  - id: D8
    description: "useHostRead muestra el mensaje del servidor ante agent_response_too_large y conserva el ultimo dato valido"
    requirement: "SEC-04"
    verification: []
    human_judgment: true
    rationale: "No hay prueba de hook de React en el repositorio ni pagina que lo ejerza con ese 502; el comportamiento es una rama de seis lineas sobre el hook existente que ya conservaba old.data. Revisar en el navegador."
  - id: D9
    description: "Los topes por camino son los valores de D-10, que son suposiciones sin medir (A1)"
    requirement: "SEC-04"
    verification: []
    human_judgment: true
    rationale: "Dependen de los tamanos reales de /metrics, /files y /logs en produccion, que CI no tiene: medir Content-Length en el servidor y vigilar los 502 durante unos dias."
---

# Phase 6 Plan 06: Topes de respuesta del agente Summary

**Lector acotado unico en nasEffectForHost con topes por camino: el exceso es NasInvalidResponse(ResponseTooLarge), la ruta responde 502 agent_response_too_large y las vistas conservan el ultimo dato valido.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-11-27T12:14:40Z
- **Completed:** 2026-11-27T12:23:30Z
- **Tasks:** 3
- **Files modified:** 14

## Accomplishments

- **Topes aplicados (D-10):** `/metrics` 2 MiB, `/maintenance` 1 MiB, `/deployments` 2 MiB, `/files` 8 MiB, `/trash` 2 MiB, `/logs` 8 MiB, respuesta a un POST 256 KiB y cualquier otro camino 1 MiB, en `AGENT_RESPONSE_LIMITS`; `responseLimitFor` usa el `pathname` sin la consulta y un `body` definido marca un POST.
- **Lector acotado (SEC-04):** `readBounded` rechaza por `Content-Length` sin leer el flujo (y cancela el cuerpo), o lee en streaming contando bytes, cancela el lector al pasar el tope y decodifica una sola vez al final. Tambien cancela si el Effect aborta (timeout) y no devuelve nada parcial.
- **Modelado del exceso:** respuesta correcta -> `NasInvalidResponse({ cause: ResponseTooLarge })` (colector, deploy-progress y la rama de resultado pendiente de un POST no cambian); respuesta con error -> `NasRejected` con su estado y mensaje generico; cualquier otro fallo sigue siendo `NasUnavailable`. `maintenance.ts`, `events.ts` y `deployments.ts` propagan el error (events usa `allSettled` y degrada), asi que no se tocaron.
- **Ruta (D-11):** el catch responde 502 con `agent_response_too_large` y un mensaje fijo en espanol, despues de `BodyTooLarge` y antes del log generico; el log lleva solo el tope.
- **Vistas (D-11):** `useHostRead` muestra el mensaje del servidor ante ese codigo; el listado de archivos conserva las entradas de la misma carpeta y expone `data-files-error`; el sondeo de mantenimiento publica `tooLarge` (snapshot obsoleto, o fase error sin snapshot) y la nota usa `data-snapshot-note="too-large"` con texto propio.
- **README:** seccion `## Limites de cuerpo y de respuesta` tras "Cabeceras de seguridad", con los topes de cuerpo (16/64/32 KiB y su 413), la tabla de topes de respuesta, la limitacion de los directorios muy grandes y la lista unica de acciones protegidas (`src/lib/sensitive-actions.ts`, ventana de 5 minutos).

## Task Commits

1. **Tarea 1 (tracer):** `d7d65c2` feat (constantes y `ResponseTooLarge`), `87d1688` test (RED), `e0dcf55` feat (GREEN: lector, ruta, hook)
2. **Tarea 2 (tdd):** `17e1d70` test (RED), `2a6e95a` feat (GREEN: listado, sondeo, nota)
3. **Tarea 3:** `3de5f09` test (logs y colector) y README

## TDD Gate Compliance

- **RED tarea 1:** 5 pruebas de `agent-client.test.ts` fallaron por la asercion planificada (un `SyntaxError` o una respuesta aceptada en lugar de `ResponseTooLarge`/`NasInvalidResponse`) y 1 de `api-deployments.test.ts` (503 en lugar de 502); las pruebas de `responseLimitFor` y de la respuesta con error ya pasaban porque la constante se entrego en un commit previo y el estado de una respuesta con error ya se conservaba. Evaluacion semantica: el objetivo se ejecuto y fallo por la razon prevista, no por importacion ni sintaxis.
- **RED tarea 2:** 3 pruebas del sondeo fallaron por `tooLarge` ausente. La prueba e2e se escribio en el mismo commit RED pero no se ejecuto en rojo (exige compilar y arrancar el servidor); se ejecuto en verde tras la implementacion.
- Tarea 3 no es TDD: las pruebas de logs y colector cubren comportamiento ya entregado por la tarea 1 y pasaron al escribirse.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Literales de `SnapshotState` en `tests/security-review.test.ts`**
- **Found during:** Tarea 2
- **Issue:** `tooLarge: boolean` es obligatorio en `SnapshotState`, asi que los dos literales de la prueba dejaban de compilar.
- **Fix:** anadido `tooLarge: false` a ambos.
- **Files modified:** `tests/security-review.test.ts`
- **Commit:** `2a6e95a`

**2. [Rule 2 - Missing critical] Cancelacion del lector al abortar el Effect**
- **Found during:** Tarea 1
- **Issue:** el plan solo pedia cancelar al pasar el tope; sin ligar el lector a la senal, un timeout dejaba el cuerpo abierto y la promesa podia devolver un cuerpo cortado.
- **Fix:** `readBounded` recibe la senal de `Effect.tryPromise`, cancela el lector al abortar y lanza en lugar de devolver datos parciales.
- **Files modified:** `src/lib/nas.ts`
- **Commit:** `e0dcf55`

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical). **Impact:** sin cambio de alcance.

## Issues Encountered

- El contenedor desechable `hub-phase3-pg` (`127.0.0.1:55432`) se detuvo durante la ejecucion y su contrasena no coincide con la de CI, asi que se levanto uno propio, `hub-0606-pg` (`postgres:18`, `127.0.0.1:55433`, usuario y contrasena del bloque `env` de CI, `--rm`), con `pnpm db:migrate` y `HUB_REQUIRE_TEST_DB=1`: ninguna suite se omitio. No se abrio `.env.local` (el script de migraciones lo carga si existe, pero las variables exportadas prevalecen).
- `pnpm lint` completo sigue fallando por los directorios de herramienta no versionados (problema previo en `deferred-items.md`); `pnpm lint src tests` sale 0.

## Verification

- `HUB_REQUIRE_TEST_DB=1 pnpm test` (suite completa): 55 archivos / 817 pruebas en verde, ninguna omitida.
- `pnpm typecheck` sin errores; `pnpm lint src tests` sin errores ni avisos; `pnpm build` correcto.
- `pnpm test:e2e tests/e2e/files-apps.spec.ts`: 6 pruebas en verde, incluida la nueva.
- `git diff 55879e6..HEAD -- agent`: vacio, el agente Python no cambio.
- **Medicion en produccion (comprobacion humana, A1):** pendiente. Medir el `Content-Length` real de `/metrics`, de `/files` sobre la carpeta de descargas mas grande y de `/logs` de un contenedor muy hablador, y vigilar los `502 agent_response_too_large` unos dias; lo esperado es que cada respuesta quede por debajo de la mitad de su tope.

## Known Stubs

None.

## Threat Flags

None. Sin rutas, endpoints ni dependencias nuevas; T-06-20 a T-06-22 mitigadas por el lector unico, la prueba con espia sobre `JSON.parse` y el mensaje fijo del 502. T-06-23 aceptada y documentada en el README.

## Self-Check: PASSED

- Archivos modificados presentes; los seis commits (`d7d65c2`, `87d1688`, `e0dcf55`, `17e1d70`, `2a6e95a`, `3de5f09`) existen en la rama.
