---
phase: 06-puerta-de-seguridad
plan: "05"
subsystem: api-security
tags: [route-manifest, fail-closed-dispatch, static-scans, better-auth, request-body-limit, vitest, nextjs]

requires:
  - phase: 06-puerta-de-seguridad
    provides: "06-01: sensitive-actions.ts con actionPolicies y hostCommandPolicies; 06-04: readBodyText, BodyTooLarge y la matriz de 413"
provides:
  - "routeManifest, patternRoutes y routeVerdict: el catch-all no despacha ninguna pareja método y ruta sin declarar (404 o 405 con Allow, tras la sesión)"
  - "routeFiles y escaneos estáticos de literales, expresiones regulares, ficheros route.ts, verbos exportados, lecturas de cuerpo y matriz de 413"
  - "ProtectedPostRoute y fixtures tipados de containers/remove, deployments/settings y renovate/merge"
  - "AUTH_BODY_LIMIT (32 KiB) y envoltorio POST de /api/auth/* con 413 y paso fiel por debajo del tope"
affects: [06-06, 07-acciones-desde-telegram]

actuals:
  tokens: 7459
  tasks: 3
  commits: 7

plan_head_before: ed71125dc9832066e65eedda7a5110184c2dc9f0
plan_head_after: 59f9ae7641124a33cb436224ab89263e28fde747

tech-stack:
  added: []
  patterns:
    - "Manifiesto declarado con satisfies y literales conservados: el tipo ProtectedPostRoute se deriva de él y obliga a un fixture por ruta protegida"
    - "Despacho fail-closed: la consulta al manifiesto precede a toda la cadena de if, así un estilo de despacho nuevo no escapa"
    - "Escaneo estático del código fuente con node:fs en una prueba, sin base de datos, comparado en ambos sentidos con el manifiesto"

key-files:
  created:
    - tests/auth-body-limit.test.ts
  modified:
    - src/lib/sensitive-actions.ts
    - src/app/api/[...path]/route.ts
    - src/app/api/auth/[...all]/route.ts
    - src/lib/request-body.ts
    - tests/sensitive-actions.test.ts
    - tests/api-logs.test.ts

key-decisions:
  - "routeVerdict compara el nombre exacto con Object.hasOwn: constructor, __proto__ y toString no son rutas, y ACTION o action/extra no coinciden"
  - "Las dos expresiones regulares del catch-all viven como incidentDetailPattern e incidentActionPattern en el manifiesto y el despachador las importa: una sola copia, sin deriva posible"
  - "setup comprueba el método antes de la sesión y responde 405; el resto responde 404 o 405 solo tras la sesión, de modo que una petición anónima no averigua qué rutas existen"
  - "Una acción por elemento se declara con un puntero a la tabla (perItem(actionPolicies)), no con una copia"
  - "El envoltorio de Better Auth lee el cuerpo como texto UTF-8 y reconstruye la petición; sin cuerpo no se pasa body, y content-length se elimina porque la petición nueva lo calcula"

patterns-established:
  - "Una ruta, verbo o mutación nueva se declara primero en routeManifest; una ruta protegida completa exige además su fixture tipado, y una mutación exige su fila de 413"
  - "Las pruebas de escaneo quitan comentarios antes de buscar patrones, para no fallar por un comentario que cita request.json()"

requirements-completed: [SEC-02, SEC-04]

coverage:
  - id: D1
    description: "El catch-all consulta un manifiesto de rutas y no despacha ninguna pareja método y ruta sin declarar: DELETE responde 405 con Allow, una ruta desconocida 404, y 401 precede a ambos"
    requirement: "SEC-02"
    verification:
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#route manifest dispatch"
        status: pass
      - kind: unit
        ref: "tests/sensitive-actions.test.ts#gives a verdict for every declared pair and rejects the rest"
        status: pass
    human_judgment: false
  - id: D2
    description: "Una ruta, un verbo o una mutación nueva sin declarar hace fallar una prueba o tsc (literales, expresiones regulares, route.ts, verbos exportados, lecturas de cuerpo y matriz de 413)"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "tests/sensitive-actions.test.ts#route declarations"
        status: pass
      - kind: other
        ref: "pnpm typecheck con una ruta protegida añadida sin fixture: error TS2741"
        status: pass
    human_judgment: false
  - id: D3
    description: "containers/remove, deployments/settings y renovate/merge responden 403 sin verificación, sin agente ni operación; presence, push/test y settings no piden verificación"
    requirement: "SEC-02"
    verification:
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#whole-route protection"
        status: pass
    human_judgment: false
  - id: D4
    description: "POST de /api/auth/* con más de 32 KiB responde 413 sin invocar a Better Auth; por debajo del tope recibe el mismo método, URL, cabeceras (salvo content-length) y cuerpo"
    requirement: "SEC-04"
    verification:
      - kind: unit
        ref: "tests/auth-body-limit.test.ts"
        status: pass
      - kind: e2e
        ref: "pnpm test:e2e tests/e2e/dashboard.spec.ts tests/e2e/sensitive-action.spec.ts (12 passed)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Las exenciones presence, verification/password y la baja de push (suposición A10) no figuran en D-06 y quedan declaradas con motivo a la espera de confirmación del usuario"
    verification: []
    human_judgment: true
    rationale: "Decidir si esas tres exenciones son aceptables es una decisión de producto del operador; ninguna prueba puede afirmarlo"

duration: 6min
completed: 2026-11-27
status: complete
---

# Phase 6 Plan 05: Manifiesto de rutas y tope de cuerpo de Better Auth Summary

**Manifiesto de rutas con métodos y política por entrada que el catch-all consulta antes de despachar (404 o 405 con Allow), escaneos estáticos y fixtures tipados que hacen fallar una ruta, verbo o mutación sin declarar, y envoltorio de Better Auth con tope de 32 KiB.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-11-27T12:07:19Z
- **Completed:** 2026-11-27T12:13:45Z
- **Tasks:** 3
- **Files modified:** 7 (1 nuevo)

## Accomplishments

- `routeManifest` declara las 23 rutas por nombre del catch-all con sus verbos y una política por mutación; `patternRoutes` recoge las dos expresiones regulares de incidencias; `routeVerdict` es una función pura que devuelve `ok`, `not_found` o `method_not_allowed` con los métodos permitidos.
- El despachador consulta el veredicto tras la sesión: `DELETE /api/action` y `DELETE /api/settings` responden 405 con `Allow`, una ruta desconocida 404, y 401 sigue precediendo a ambos. `setup`, público por diseño, comprueba el método antes de la sesión.
- Escaneos estáticos (sin base de datos) comparan en ambos sentidos los literales `route === ...`, los `.exec(route)`, los `route.ts` de `src/app/api`, los verbos exportados y las filas de 413, y prohíben cualquier lectura de cuerpo de petición fuera de `request-body.ts`.
- `ProtectedPostRoute` se deriva del tipo del manifiesto: añadir una ruta protegida sin fixture rompe `tsc` (comprobado con una ruta temporal, error TS2741).
- `POST /api/auth/*` lee el cuerpo con `AUTH_BODY_LIMIT`, responde 413 sin invocar a Better Auth y reconstruye la petición con el mismo método, URL y cabeceras salvo `content-length`.

## Manifiesto de rutas y política por entrada

| Ruta | Métodos | Política |
| --- | --- | --- |
| verification, hosts, maintenance, deployments, events, renovate, renovate/progress, overview, container-history, files, trash, logs | GET | lectura |
| setup | GET, POST | POST exenta (SETUP_TOKEN, cuenta cero, bloqueo advisory) |
| verification/password | POST | exenta (es la propia verificación, exige sesión) |
| containers/remove | POST | protegida |
| deployments/settings | POST | protegida |
| renovate/merge | POST | protegida |
| host-command | POST | por elemento (`hostCommandPolicies`) |
| action | POST | por elemento (`actionPolicies`) |
| presence | POST | exenta (latido de pestaña visible) |
| settings | GET, POST | POST exenta (umbrales, D-06) |
| push | GET, POST, DELETE | POST exenta (suscripción), DELETE exenta (baja de la propia suscripción) |
| push/test | POST | exenta (D-06, encola una prueba al propietario) |
| incidents/:id (patrón) | GET | lectura |
| incidents/:id/(acknowledge\|snooze\|unsnooze) (patrón) | POST | exenta (D-05) |
| src/app/api/auth/[...all]/route.ts (`routeFiles`) | delegada | exenta: Better Auth valida credenciales y limita intentos; cuerpo acotado a 32 KiB |

## Exenciones pendientes de confirmar (suposición A10)

Tres exenciones no figuran en D-06 y se declararon con motivo; el usuario debe confirmarlas en la revisión:

1. `presence` (POST): latido de la pestaña visible, no actúa sobre nada.
2. `verification/password` (POST): es la propia verificación y exige sesión. Un límite de intentos queda fuera de alcance (Open Question 2, se recomienda como backlog).
3. `DELETE push`: baja de la propia suscripción del navegador.

## Task Commits

1. **Tarea 1 (tracer): DELETE /api/action responde 405**
   - RED `2847d5d` (test): pruebas de 405, 404, 401 y de `routeVerdict`
   - GREEN `1892b6d` (feat): manifiesto, `routeVerdict` y consulta en el catch-all
2. **Tarea 2: escaneos estáticos y fixtures tipados**
   - RED `c522273` (test)
   - GREEN `113cba9` (feat): `routeFiles`
3. **Tarea 3: tope de cuerpo de Better Auth**
   - constante `e67efc4` (feat): `AUTH_BODY_LIMIT`
   - RED `20b5251` (test)
   - GREEN `59f9ae7` (feat): envoltorio POST

**Plan metadata:** commit `docs(06-05)` posterior (este resumen, STATE y ROADMAP).

## TDD Gate Compliance

- **RED tarea 1:** los cuatro casos HTTP de 405 (DELETE action, DELETE settings, GET action y POST hosts, DELETE setup) fallan con el estado 200 o 400 en lugar de 405, y los tres casos de `routeVerdict` con `TypeError: routeVerdict is not a function`. Evaluación semántica: el objetivo se ejecutó y falló en la aserción prevista (estado HTTP) para el HTTP; para `routeVerdict` el fallo es la ausencia del símbolo, esperada antes de implementarlo. Los casos de 404 y 401 ya se cumplían y quedan como guardas de regresión.
- **RED tarea 2:** solo falla el escaneo de `routeFiles` (`TypeError: Cannot convert undefined or null to object`, símbolo ausente). Los demás escaneos describen el estado actual del código, ya coherente con el manifiesto de la tarea 1, así que pasan desde el principio y funcionan como guardas; su sensibilidad se comprobó con la ruta protegida temporal sin fixture.
- **RED tarea 3:** cinco de siete pruebas fallan en la aserción prevista (200 en lugar de 413, `content-length` presente, el flujo defectuoso resuelto en lugar de rechazado). La prueba se ejecutó con el reportero de Vitest y no con un TAP clasificado por `gsd_run check tdd-red-evidence`: el plan es `type: execute`, no `type: tdd`.
- GREEN y los commits `test` precedentes están presentes para las tareas 1 a 3.

## Files Created/Modified

- `src/lib/sensitive-actions.ts` - `routeManifest`, `patternRoutes`, `routeVerdict`, `routeFiles`, `ProtectedPostRoute` y los patrones de incidencia.
- `src/app/api/[...path]/route.ts` - consulta el veredicto tras la sesión (setup antes) y usa los patrones del manifiesto.
- `src/app/api/auth/[...all]/route.ts` - GET sin cambios y POST con lectura acotada y petición reconstruida.
- `src/lib/request-body.ts` - `AUTH_BODY_LIMIT = 32 * 1024`.
- `tests/sensitive-actions.test.ts` - despacho por manifiesto, escaneos estáticos, fixtures tipados; `bodyLimitCases` sube a nivel de módulo.
- `tests/auth-body-limit.test.ts` - nuevo: 413 sobre el tope, paso fiel en el tope, sin cuerpo, multibyte, flujo defectuoso y GET.
- `tests/api-logs.test.ts` - `POST /api/logs` ahora espera 405.

## Decisions Made

Ver `key-decisions` del frontmatter. Además, el escaneo de lecturas de cuerpo busca receptores llamados `request`/`req` (o que terminen en `Request`) para no confundir `response.json()` de los clientes del agente y de GitHub.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `POST /api/logs` cambia de 404 a 405**
- **Found during:** Tarea 1 (suite completa tras el GREEN)
- **Issue:** `tests/api-logs.test.ts` esperaba 404 para un POST a una ruta de solo lectura; con el manifiesto la respuesta correcta es 405, igual que `POST /api/hosts` según el plan.
- **Fix:** la prueba aserta 405 y sigue verificando que el agente no recibe peticiones.
- **Files modified:** `tests/api-logs.test.ts`
- **Verification:** `pnpm test` completa en verde.
- **Committed in:** `1892b6d`

**2. [Rule 1 - Bug] El fixture de `push/test` dejaba una fila en `notification_outbox`**
- **Found during:** Tarea 2 (RED)
- **Issue:** la fila del propietario se borraba en cascada al eliminar el usuario en la prueba de 413 de `setup`, y la comparación de trazas fallaba por orden de pruebas.
- **Fix:** `afterEach` del bloque nuevo que vacía `notification_outbox` y `presence`.
- **Files modified:** `tests/sensitive-actions.test.ts`
- **Committed in:** `c522273`

**3. [Rule 3 - Blocking] Se separó `AUTH_BODY_LIMIT` en un commit propio antes del RED**
- **Found during:** Tarea 3
- **Issue:** sin la constante, el RED de la prueba habría fallado por `repeat(NaN)` en vez de por la aserción prevista.
- **Fix:** commit `e67efc4` con la constante únicamente; el comportamiento sigue sin implementar hasta el GREEN.
- **Committed in:** `e67efc4`

**Total deviations:** 3 auto-fixed (2 bug, 1 blocking). **Impacto:** sin cambio de alcance; la primera es una consecuencia directa del 405 pedido por el plan.

## Issues Encountered

- `DATABASE_URL` no estaba exportado: las suites se ejecutaron contra el PostgreSQL 18 desechable de loopback (`127.0.0.1:55432`, contenedor `hub-phase3-pg`) con `HUB_REQUIRE_TEST_DB=1`, así que ninguna suite se omitió. Los e2e usaron una base `hub_e2e_0605` creada y borrada para la ocasión, con las variables de prueba de CI, sin abrir `.env.local`.
- En la primera suite completa `tests/migrations.test.ts` (0007) agotó su plazo de 5 s bajo carga; aislada pasó y las ejecuciones siguientes de la suite completa dieron 55 archivos en verde. Es la misma intermitencia anotada en 06-04.
- `pnpm lint` completo sigue fallando por los directorios de herramienta no versionados (`.claude/`, `.agents/`, `.codex/`, `.opencode/`), problema previo anotado en `deferred-items.md`; `pnpm lint src tests` sale 0.

## Verification

- `HUB_REQUIRE_TEST_DB=1 pnpm test` (suite completa): 55 archivos / 804 pruebas en verde, ninguna omitida.
- `pnpm typecheck`: sin errores. `pnpm lint src tests`: sin errores ni avisos.
- `pnpm build`: correcto, con las variables de prueba de CI.
- `pnpm test:e2e tests/e2e/dashboard.spec.ts tests/e2e/sensitive-action.spec.ts`: 12 pruebas en verde, incluido el alta y el inicio de sesión con passkey y el inicio de sesión por contraseña a través del envoltorio.

## Known Stubs

None.

## Threat Flags

None: no se añaden rutas HTTP, dependencias ni variables de entorno; la superficie nueva (el envoltorio de Better Auth) es la mitigación T-06-18 del propio plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 06-06 y la fase 7 parten de un manifiesto que obliga a declarar cada ruta, verbo y mutación nuevos; `executeHostCommand` sigue sin guard propio y solo debe llamarse desde una ruta que aplique este manifiesto.
- Pendiente del usuario: confirmar las exenciones de `presence`, `verification/password` y `DELETE push` (A10).

## Self-Check: PASSED

- Ficheros: `tests/auth-body-limit.test.ts`, `src/lib/sensitive-actions.ts`, `src/app/api/auth/[...all]/route.ts` presentes.
- Commits `2847d5d`, `1892b6d`, `c522273`, `113cba9`, `e67efc4`, `20b5251` y `59f9ae7` alcanzables desde HEAD; `git rev-list --count` desde la base da 7.

---
*Phase: 06-puerta-de-seguridad*
*Completed: 2026-11-27*
