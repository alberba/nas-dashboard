---
phase: 06-puerta-de-seguridad
plan: "02"
subsystem: security
tags: [csp, nonce, hsts, nextjs, proxy, playwright, vitest]

# Dependency graph
requires:
  - phase: 06-puerta-de-seguridad
    provides: "06-01 dejó /api/action y host-command bajo verificación reciente; este plan añade la otra mitad de SEC-04 (cabeceras), sin tocar rutas ni guards"
provides:
  - "src/lib/csp.ts: buildContentSecurityPolicy(nonce, isDev) puro y comprobable sin Next"
  - "src/proxy.ts: nonce por petición y CSP de documentos solo para HTML"
  - "next.config.ts: HSTS en toda respuesta y CSP mínima en /api/:path*"
  - "tests/security-headers.test.ts: estructura de headers() y de la política por directiva"
  - "tests/e2e/csp.spec.ts: login, panel, 404, service worker y cabeceras reales sin violaciones"
affects: [06-03, 06-04, 06-05, fase-7-telegram]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 4613
  tasks: 3
  commits: 4
  plan_head_before: 541f4a32a4595e36b694f4d3e0d1292c6b231ac2
  plan_head_after: 7cb2113d0b1df7e9b5a4e9eda476d357814c9dd6

tech-stack:
  added: []
  patterns:
    - "CSP de documentos en el proxy (nonce por petición + strict-dynamic) y CSP estática en next.config.ts solo para /api/:path*"
    - "El e2e recoge securitypolicyviolation en window y falla ante cualquier evento; el nonce se comprueba por directiva y por propiedad (dos cargas distintas)"
    - "zod configurado jitless en el cliente para que su sonda de eval no cuente como violación bajo CSP estricta"

key-files:
  created:
    - src/lib/csp.ts
    - src/proxy.ts
    - tests/security-headers.test.ts
    - tests/e2e/csp.spec.ts
  modified:
    - src/app/layout.tsx
    - src/lib/auth-client.ts
    - next.config.ts
    - README.md

key-decisions:
  - "La CSP de documentos sale solo de src/proxy.ts; next.config.ts no fija CSP para documentos, así no hay dos políticas que colisionen"
  - "style-src conserva 'unsafe-inline' porque el panel serializa atributos style dependientes de datos; sin upgrade-insecure-requests por localhost y porque HSTS cubre el resto"
  - "HSTS max-age=15552000 sin includeSubDomains ni preload: el dominio principal comparte nombre con otros servicios y preload es casi irreversible"
  - "El proxy excluye api, _next/static, _next/image y cualquier ruta con punto: las mutaciones no pasan por su buffer y sw.js, el manifiesto y los iconos quedan intactos"
  - "El layout raíz es force-dynamic para que la 404 generada también reciba el nonce"
  - "zod se configura jitless porque su sonda new Function se reporta como securitypolicyviolation aunque el error se descarte"

patterns-established:
  - "Los tests de cabeceras parsean la política por nombre de directiva y nunca comparan el texto completo"
  - "El navegador prueba la CSP de verdad: login con hidratación y fetch al mismo origen, panel, 404, service worker y composición de cabeceras de API y documento"

requirements-completed: [SEC-04]

coverage:
  - id: D1
    description: "Cada documento (login, panel y 404) se sirve con una CSP que lleva un nonce por petición y 'strict-dynamic', con frame-ancestors 'none', y dos cargas consecutivas usan nonces distintos"
    requirement: "SEC-04"
    verification:
      - kind: e2e
        ref: "tests/e2e/csp.spec.ts#the login loads under a fresh nonce policy, hydrates and signs in without violations"
        status: pass
      - kind: e2e
        ref: "tests/e2e/csp.spec.ts#an unknown route answers 404 with a nonce policy and no violations"
        status: pass
    human_judgment: false
  - id: D2
    description: "Toda respuesta lleva Strict-Transport-Security con max-age=15552000 sin includeSubDomains ni preload, y conserva nosniff, X-Frame-Options, Referrer-Policy y Permissions-Policy"
    requirement: "SEC-04"
    verification:
      - kind: unit
        ref: "tests/security-headers.test.ts#adds a conservative HSTS to every path and keeps the previous headers"
        status: pass
      - kind: e2e
        ref: "tests/e2e/csp.spec.ts#the API and document responses compose HSTS and their own CSP"
        status: pass
    human_judgment: false
  - id: D3
    description: "Las respuestas de la API llevan default-src 'none' y frame-ancestors 'none', y ninguna entrada de headers() fija CSP para documentos"
    requirement: "SEC-04"
    verification:
      - kind: unit
        ref: "tests/security-headers.test.ts#gives API responses a minimal CSP and no document entry sets one"
        status: pass
      - kind: e2e
        ref: "tests/e2e/csp.spec.ts#the API and document responses compose HSTS and their own CSP"
        status: pass
    human_judgment: false
  - id: D4
    description: "Login, panel autenticado, 404 y registro del service worker no producen ningún evento securitypolicyviolation en Chromium con la compilación de producción"
    requirement: "SEC-04"
    verification:
      - kind: e2e
        ref: "tests/e2e/csp.spec.ts (5 pruebas, incluida la hidratación del login y el service worker)"
        status: pass
      - kind: e2e
        ref: "tests/e2e/dashboard.spec.ts#registers a passkey and signs in with it (passkeys siguen funcionando bajo la CSP)"
        status: pass
    human_judgment: false
  - id: D5
    description: "La política de producción no incluye 'unsafe-inline' ni 'unsafe-eval' en script-src y la de desarrollo solo añade 'unsafe-eval'"
    requirement: "SEC-04"
    verification:
      - kind: unit
        ref: "tests/security-headers.test.ts#keeps scripts strict in production"
        status: pass
      - kind: unit
        ref: "tests/security-headers.test.ts#only relaxes eval in development"
        status: pass
    human_judgment: false
  - id: D6
    description: "El README documenta que HSTS lo emite la aplicación, que el interruptor HSTS de Nginx Proxy Manager debe quedar apagado y que la CSP de documentos se revierte borrando src/proxy.ts"
    requirement: "SEC-04"
    verification: []
    human_judgment: true
    rationale: "La redacción y su correspondencia con la decisión operativa se revisan a ojo; la comprobación real contra Nginx Proxy Manager, Tailscale Serve, Safari y Firefox es el human-check de la tarea 3, que se recoge en la UAT de fin de fase."

duration: 13 min
completed: 2026-11-27
status: complete
---

# Phase 06 Plan 02: Puerta de seguridad — CSP con nonce y HSTS Summary

**Cada documento se sirve con un nonce nuevo y `'strict-dynamic'` desde `src/proxy.ts`, la API recibe su CSP mínima y toda respuesta lleva HSTS conservador; login, panel, 404 y service worker pasan en Chromium sin una sola violación.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-11-27T10:46:28Z
- **Completed:** 2026-11-27T10:59:18Z
- **Tasks:** 3
- **Files modified:** 8 (4 nuevos, 4 modificados) más los artefactos de planificación

## Accomplishments

- `src/lib/csp.ts` construye la política sin depender de Next: `default-src 'self'`, `script-src 'self' 'nonce-<nonce>' 'strict-dynamic'` (con `'unsafe-eval'` solo en desarrollo), `style-src 'self' 'unsafe-inline'` por los `style` dependientes de datos, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `connect-src 'self'`, `worker-src 'self'`, `manifest-src 'self'` y `frame-ancestors 'none'`.
- `src/proxy.ts` genera el nonce con `crypto.randomUUID()`, lo fija en `x-nonce` y en la cabecera `Content-Security-Policy` de la petición (para que Next lo aplique a sus scripts) y de la respuesta. La política se aplica, no es Report-Only, y el matcher `/((?!api|_next/static|_next/image|.*\\..*).*)` deja fuera la API, los estáticos y todo lo que tenga punto (`sw.js`, `manifest.webmanifest`, iconos).
- `next.config.ts` añade `Strict-Transport-Security: max-age=15552000` a `/:path*`, sin `includeSubDomains` ni `preload`, y una entrada `/api/:path*` con `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. Ninguna entrada fija CSP para documentos: la de HTML sale solo del proxy y no hay colisión.
- `src/app/layout.tsx` declara `dynamic = "force-dynamic"`; la compilación marca `/` y `/_not-found` como dinámicas y la 404 recibe el nonce.
- `tests/security-headers.test.ts` comprueba la estructura de `headers()` y la política por nombre de directiva (HSTS, CSP de API, ausencia de CSP de documento, producción sin `'unsafe-inline'`/`'unsafe-eval'` y desarrollo solo con `'unsafe-eval'`).
- `tests/e2e/csp.spec.ts` usa una sola sesión para el fichero (cookie del `beforeAll`, como `sensitive-action.spec.ts`) y recoge cada `securitypolicyviolation` en `window.__cspViolations`. Verifica la política del login, dos nonces distintos, la hidratación con inicio de sesión por fetch, el panel, la 404, el registro de `/sw.js` con worker activo y la composición real de HSTS y CSP en API y documento.
- `README.md` documenta la decisión: HSTS lo emite la aplicación, el interruptor «HSTS Enabled» de Nginx Proxy Manager debe quedar apagado, HSTS solo vale sobre HTTPS, cómo comprobarlo con `curl -sI` en ambos dominios y cómo revertir la CSP de documentos.

## Task Commits

Cada tarea se cometió por separado:

1. **Task 1: El login se hidrata bajo una CSP con nonce y sin violaciones** — `aab0e46` (feat, tracer)
2. **Task 2: HSTS en toda respuesta y CSP mínima en la API** — `c46d8e1` (test, RED) y `c8009c5` (feat, GREEN)
3. **Task 3: Panel, 404, service worker y cabeceras reales sin violaciones, con la decisión documentada** — `7cb2113` (test)

**Plan metadata:** `docs(06-02): complete nonce CSP and HSTS plan`

_Nota: la tarea 2 siguió RED → GREEN; no hizo falta un commit de refactor._

## Files Created/Modified

- `src/lib/csp.ts` — `buildContentSecurityPolicy(nonce, isDev)` puro con el JSDoc de `style-src` y la ausencia de `upgrade-insecure-requests`
- `src/proxy.ts` — nonce por petición, CSP en petición y respuesta, matcher solo de documentos
- `src/app/layout.tsx` — `dynamic = "force-dynamic"` para que la 404 también reciba el nonce
- `src/lib/auth-client.ts` — zod en modo jitless en el cliente para que su sonda de `new Function` no genere un evento de violación
- `next.config.ts` — HSTS en `/:path*` y CSP mínima en `/api/:path*`
- `tests/security-headers.test.ts` — estructura de `headers()` y de la política por directiva
- `tests/e2e/csp.spec.ts` — login, panel, 404, service worker y composición de cabeceras con la compilación de producción
- `README.md` — sección «Cabeceras de seguridad»

## Decisions Made

- La CSP de documentos vive solo en `src/proxy.ts`; `next.config.ts` no la emite para HTML, así no hay dos políticas que se pisen.
- `style-src` mantiene `'unsafe-inline'` por los atributos `style` que el panel serializa con datos; no se usa `upgrade-insecure-requests` porque Playwright y el desarrollo van por `http://localhost` y HSTS cubre el resto.
- HSTS se emite en la aplicación con 180 días sin `includeSubDomains` ni `preload`, para no arrastrar a otros servicios que comparten el dominio ni adoptar una decisión casi irreversible.
- El matcher excluye `api` para que ninguna mutación pase por el buffer del proxy: el límite de cuerpo de 06-04 sigue siendo el único.
- La 404 se hace dinámica desde el layout raíz en lugar de con un `not-found.tsx` propio.
- zod se ejecuta jitless en el cliente: la validación real es del servidor y así la sonda de `eval` de zod deja de contar como violación.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] La sonda de `eval` de zod generaba una violación de CSP en producción**
- **Found during:** Task 1 (verificación de la tarea)
- **Issue:** el e2e del login falló con `securitypolicyviolation` en `script-src` con `blockedURI: "eval"`. El chunk del cliente incluía la comprobación de zod 4.6 (`new Function("")`) para decidir si compila validadores con JIT; aunque el error se descarta, Chromium lo reporta como violación y el plan exige cero.
- **Fix:** `src/lib/auth-client.ts` configura `z.config({ jitless: true })` antes de crear el cliente de Better Auth, de modo que zod no prueba `eval` en el navegador. El servidor no cambia y la validación sigue siendo suya.
- **Files modified:** `src/lib/auth-client.ts`
- **Verification:** el e2e del login vuelve a verde con el array de violaciones vacío; la suite completa (53 archivos, 728 pruebas) pasa.
- **Committed in:** `aab0e46` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 funcionalidad crítica)
**Impact on plan:** sin cambios de arquitectura ni de alcance; el arreglo es necesario para cumplir el criterio de cero violaciones con la CSP estricta que pide el plan.

## Issues Encountered

- `DATABASE_URL` no estaba exportado en el shell: las suites y el e2e se ejecutaron contra el PostgreSQL 18 desechable de loopback documentado en las fases anteriores (`127.0.0.1:55432`, usuario y base `hub`) con `HUB_REQUIRE_TEST_DB=1`, así que no se omitió ninguna prueba.
- `pnpm lint` sobre todo el repositorio sigue fallando por los directorios de herramienta no versionados (pre-existente, registrado en [`deferred-items.md`](./deferred-items.md)); el chequeo scoped `eslint src tests` sale 0 y es el que se usó en las tres tareas.

## User Setup Required

None - no external service configuration required. La comprobación con `curl -sI` contra Nginx Proxy Manager y Tailscale Serve, y la de Safari y Firefox con passkey y push, es el `human-check` de la tarea 3 y se recoge en la UAT de fin de fase; no bloquea la ejecución del plan.

## Next Phase Readiness

- CSP y HSTS están aplicados y probados con la compilación de producción; 06-03 puede reutilizar `tests/e2e/csp.spec.ts` como patrón de sesión única y de recogida de violaciones.
- La CSP de documentos se revierte borrando `src/proxy.ts`; el HSTS y la CSP de API quedan en `next.config.ts`.
- Pendiente para la UAT: una sola cabecera HSTS por dominio (interruptor de Nginx Proxy Manager apagado) y consola limpia en Safari y Firefox al verificar con passkey y suscribirse a push.

---

*Phase: 06-puerta-de-seguridad*
*Completed: 2026-11-27*

## Self-Check: PASSED

- Archivos creados: `src/lib/csp.ts`, `src/proxy.ts`, `tests/security-headers.test.ts`, `tests/e2e/csp.spec.ts` — todos presentes.
- Commits: `aab0e46`, `c46d8e1`, `c8009c5`, `7cb2113` — todos ancestros de HEAD.
- `pnpm typecheck` sin errores; `eslint src tests` sale 0.
- Suite completa con `HUB_REQUIRE_TEST_DB=1`: 53 archivos / 728 pruebas en verde, ninguna omitida.
- E2E de la tarea 3: `tests/e2e/csp.spec.ts` (5) y `tests/e2e/dashboard.spec.ts` (3), 8 en verde con la compilación de producción.

