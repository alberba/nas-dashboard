---
phase: 06-puerta-de-seguridad
verified: 2026-11-27T15:10:00Z
status: passed
score: 3/3 must-haves verified
covered_files:
  - ".planning/phases/06-puerta-de-seguridad/06-01-PLAN.md"
  - ".planning/phases/06-puerta-de-seguridad/06-01-SUMMARY.md"
  - ".planning/phases/06-puerta-de-seguridad/06-02-PLAN.md"
  - ".planning/phases/06-puerta-de-seguridad/06-02-SUMMARY.md"
  - ".planning/phases/06-puerta-de-seguridad/06-03-PLAN.md"
  - ".planning/phases/06-puerta-de-seguridad/06-03-SUMMARY.md"
  - ".planning/phases/06-puerta-de-seguridad/06-04-PLAN.md"
  - ".planning/phases/06-puerta-de-seguridad/06-04-SUMMARY.md"
  - ".planning/phases/06-puerta-de-seguridad/06-05-PLAN.md"
  - ".planning/phases/06-puerta-de-seguridad/06-05-SUMMARY.md"
  - ".planning/phases/06-puerta-de-seguridad/06-06-PLAN.md"
  - ".planning/phases/06-puerta-de-seguridad/06-06-SUMMARY.md"
  - "next.config.ts"
  - "src/app/api/[...path]/route.ts"
  - "src/app/api/auth/[...all]/route.ts"
  - "src/lib/csp.ts"
  - "src/lib/host-commands.ts"
  - "src/lib/nas.ts"
  - "src/lib/request-body.ts"
  - "src/lib/sensitive-actions.ts"
  - "src/lib/verification-api.ts"
  - "src/proxy.ts"
covered_digest: "v4:sha256:f45c0237c8156aeb6a065b11531fe83ee66a69a954381cef2b29d11f9db0d8d2"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Decidir sobre CR-01 (06-REVIEW.md, disposición 'open'): el factor de verificación (passkey o contraseña) se elige a partir de la cabecera Origin que envía el cliente"
    expected: "Decisión explícita: corregir ahora (derivar el factor de Host/X-Forwarded-Host fijado por el proxy y exigir que Origin coincida), o diferir/aceptar con motivo por escrito. Mientras no se decida, con un origen alternativo en TRUSTED_ORIGINS quien conozca la contraseña y tenga sesión puede obtener una verificación 'password' enviando Origin del origen alternativo contra el dominio público y ejecutar acciones destructivas sin passkey."
    why_human: "La mecánica es anterior a la fase (src/lib/verification.ts viene de c3c648a, #14) y los criterios de la hoja de ruta no exigen fijar el factor, pero es un hallazgo crítico abierto sobre la propiedad que la fase quiere garantizar antes de que Telegram inicie acciones. Aceptar o corregir es una decisión de riesgo del propietario."
  - test: "Comprobar las cabeceras reales por dominio: curl -sI https://<dominio-principal> y https://<entrada-alternativa-tailscale> | grep -i -E 'strict-transport-security|content-security-policy'"
    expected: "Una sola Strict-Transport-Security: max-age=15552000 (sin includeSubDomains ni preload) y una CSP con nonce y 'strict-dynamic' en el documento; con el interruptor HSTS de Nginx Proxy Manager apagado."
    why_human: "Depende del despliegue real (Nginx Proxy Manager, Tailscale Serve); el repositorio solo prueba la estructura y la compilación local."
  - test: "Abrir el panel en Safari y Firefox, verificar con passkey y activar push; mirar la consola"
    expected: "Ninguna violación de CSP. Playwright solo cubre Chromium."
    why_human: "Comportamiento de navegador no cubierto por la suite automática (06-VALIDATION.md lo deja pendiente de UAT)."
  - test: "Recorrer el diálogo de passkey en la tarjeta del host, la búsqueda Ctrl K y las filas de contenedor con una passkey real"
    expected: "El diálogo se abre para lo protegido y no para check-health; foco, consecuencias y tono correctos según 06-UI-SPEC.md."
    why_human: "Los e2e aseveran estado y peticiones, no la calidad visual ni el flujo con autenticador real."
---

# Phase 6: Puerta de seguridad - Verification Report

**Phase Goal:** Exigir verificación reciente en el servidor para toda acción destructiva y endurecer la frontera HTTP del hub antes de que Telegram pueda iniciar acciones.
**Verified:** 2026-11-27T15:10:00Z
**Status:** human_needed
**Re-verification:** No, verificación inicial

## Goal Achievement

### Observable Truths (contrato de la hoja de ruta)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Toda ruta destructiva (stop, restart, update, purge, empty-trash, clean-images, reconnect-apps, host-command, merge de Renovate) rechaza la acción sin verificación reciente en el servidor | VERIFIED | `src/lib/sensitive-actions.ts`: `actionPolicies` protege stop, restart, update-container, reboot, purge, empty-trash; `hostCommandPolicies` protege 7 de 8 comandos (check-health exento). Guards en el servidor: `route.ts:636` (`/api/action`), `host-commands.ts:244` (`runHostCommand`), `lifecycle.ts:213` (containers/remove), `deployment-settings.ts:131`, `renovate-merge.ts:150`. El guard lee solo el registro `recent_verification` de la sesión (`verification.ts` `requireRecentVerification`), con frontera `now >= expiresAt`. Todo `nasForHost` hacia `/action`, `/command` y `/deployments/settings` pasa por una de esas rutas (grep). Pruebas: 96 casos en `tests/sensitive-actions.test.ts` (403 `recent_verification_required`, 0 peticiones al agente, 0 filas en `operations`). Mutación propia: quitar el guard de `renovate-merge.ts` hace fallar 2 pruebas; despromover `purge` en el manifiesto hace fallar la prueba de conjunto exacto. Ambas revertidas. |
| 2 | La lista de acciones protegidas vive en un único módulo y un test falla si una ruta nueva no la declara | VERIFIED | `routeManifest`, `patternRoutes`, `routeFiles`, `routeVerdict` en `sensitive-actions.ts` con `satisfies Record<ActionId, Policy>` y `satisfies Record<HostCommand, Policy>` (no compila una acción o comando nuevo sin entrada). `route.ts:162` aplica `routeVerdict` antes de cualquier handler (404/405 tras sesión; 401 primero). Escaneos en `tests/sensitive-actions.test.ts:268-357`: literales `route ===`, `.exec(route)`, `route.ts` bajo `src/app/api`, verbos exportados, lecturas de cuerpo fuera de `request-body.ts`, matriz 413. UI (`dashboard.tsx:488`, `maintenance-extras.tsx:104`, `command-search.tsx:41`) lee `requiresVerificationFor*` y no mantiene lista propia. |
| 3 | Las respuestas incluyen CSP conservadora y HSTS, y una mutación con cuerpo excesivo se rechaza antes de parsear | VERIFIED (con comprobaciones de despliegue en humano) | HSTS `max-age=15552000` en `/:path*` y CSP `default-src 'none'; frame-ancestors 'none'` en `/api/:path*` (`next.config.ts`); CSP de documentos con nonce por petición, `'strict-dynamic'`, sin `unsafe-inline`/`unsafe-eval` en producción, `object-src 'none'` (`src/lib/csp.ts`, `src/proxy.ts`, `force-dynamic` en `layout.tsx`). `request-body.ts`: rechazo por Content-Length declarado sin leer, conteo en streaming, decodificado único, `JSON.parse` solo tras caber; `BodyTooLarge` primera rama del catch del catch-all; sin lecturas directas de cuerpo en `src/` (grep y escaneo). Better Auth acotado a 32 KiB (`auth/[...all]/route.ts`). Respuestas del agente acotadas en `nas.ts` (`readBounded`, 502 `agent_response_too_large`). |

### Must-haves de los PLAN (resumen)

| Truth | Status | Evidence |
|-------|--------|----------|
| D-01/D-02: start, trash, move, restore exentos | VERIFIED | `actionPolicies` y matriz `allActions` (200 sin verificación) |
| check-health exento, 7 comandos protegidos (D-03) | VERIFIED | `hostCommandPolicies`; matriz por comando |
| Replay idempotente sin verificación nueva en `/api/action` | VERIFIED | `route.ts:621-632` precede al guard; test `sensitive-actions.test.ts:556` |
| Frontera del TTL (backstop) | VERIFIED | Código `now >= expiresAt`; test `treats an expiresAt at the request instant as expired` |
| Nonce distinto por petición (backstop) | VERIFIED | `crypto.randomUUID()` por petición en `proxy.ts`; e2e `csp.spec.ts:106-111` compara dos nonces (e2e no reejecutado por mí) |
| 413 antes de parsear, sin operación, log ni agente | VERIFIED | `request-body.ts`; matriz 413 en `sensitive-actions.test.ts:949+`; `request-body.test.ts` (15) |
| deployments/settings con tope propio de 64 KiB | VERIFIED | `api-deployment-settings.test.ts` pasa, incl. deriva frente a `agent/env_settings.py` |
| Better Auth: 413 sobre 32 KiB y paso fiel por debajo | VERIFIED | `auth-body-limit.test.ts` (7) en verde |
| Tope de respuesta del agente y vistas que conservan el último dato | VERIFIED | `agent-client.test.ts`, `maintenance-polling.test.ts` en verde; e2e `files-apps`/`maintenance-status` declarados en 06-VALIDATION (no reejecutados) |
| UI sin `window.confirm` para clean-images | VERIFIED | `grep`: solo `settings.tsx:183` (ajuste no relacionado) |

**Score:** 3/3 verdades del contrato verificadas; 0 sin evidencia de comportamiento. El estado es `human_needed` por los puntos de abajo, no por una verdad fallida.

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `src/lib/sensitive-actions.ts` | VERIFIED | Sustantivo (222 líneas), importado por servidor y UI |
| `src/lib/request-body.ts` | VERIFIED | Único lector de cuerpos; usado por route, host-commands, lifecycle, renovate-merge, deployment-settings, verification-api, auth |
| `src/lib/csp.ts`, `src/proxy.ts` | VERIFIED | `proxy.ts` importa `buildContentSecurityPolicy`; matcher solo documentos |
| `next.config.ts` | VERIFIED | HSTS global y CSP de API; sin CSP de documentos |
| `src/lib/nas.ts` | VERIFIED | `readBounded` único en `nasEffectForHost`; topes por camino |
| `tests/sensitive-actions.test.ts`, `request-body.test.ts`, `security-headers.test.ts`, `auth-body-limit.test.ts`, `agent-client.test.ts` | VERIFIED | Existen y pasan |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `route.ts` | `sensitive-actions.ts` | `requiresVerificationForAction`, `routeVerdict` | WIRED |
| `host-commands.ts` | `sensitive-actions.ts` | `requiresVerificationForCommand` antes de `executeHostCommand` | WIRED |
| `dashboard.tsx`, `maintenance-extras.tsx`, `command-search.tsx` | `sensitive-actions.ts` | predicados del manifiesto | WIRED |
| `route.ts` | `request-body.ts` | `readJsonBody`; `BodyTooLarge` primera rama del catch | WIRED |
| `verification-api.ts` | `request-body.ts` | relanza `BodyTooLarge` | WIRED |
| `auth/[...all]/route.ts` | `request-body.ts` | `readBodyText(AUTH_BODY_LIMIT)` | WIRED |
| `nas.ts` | `route.ts` | `ResponseTooLarge` a 502 `agent_response_too_large` | WIRED |
| `proxy.ts` | `csp.ts` | `buildContentSecurityPolicy(nonce, isDev)` | WIRED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Suite completa con PostgreSQL de loopback | `HUB_REQUIRE_TEST_DB=1 npx vitest run` | 823/824; 1 fallo en `runtime-config.test.ts` (VAPID), que pasó 2/2 al repetirlo (72/72) | PASS (flaky ajeno a la fase) |
| Tipos | `tsc --noEmit --incremental false` | sin salida | PASS |
| Lint de `src` y `tests` | eslint | exit 0 | PASS |
| Mutación: quitar guard de Renovate | vitest | 2 pruebas fallan | PASS (la red detecta la regresión) |
| Mutación: despromover `purge` | vitest | 1 prueba falla | PASS |

### Probe Execution

SKIPPED: la fase no declara sondas `probe-*.sh`.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SEC-01 | 06-01, 06-03 | Toda ruta destructiva exige verificación reciente en el servidor | SATISFIED (ver CR-01 en humano) | Verdad 1 |
| SEC-02 | 06-01, 06-05 | Lista única; una ruta nueva no puede olvidarla sin que falle un test | SATISFIED | Verdad 2 |
| SEC-04 | 06-02, 06-04, 06-05, 06-06 | CSP conservadora, HSTS y límite de cuerpo en mutaciones | SATISFIED | Verdad 3 |

Los tres IDs de la fase (SEC-01, SEC-02, SEC-04) aparecen en frontmatter de los PLAN y en REQUIREMENTS.md (marcados Complete, Phase 6). Sin requisitos huérfanos: SEC-03 es de la Fase 2 y SEC-05/06 de la Fase 8.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (archivos de la fase) | - | `TBD`/`FIXME`/`XXX` | - | Ninguno encontrado |
| `src/lib/verification.ts` / `verification-api.ts` | 51, 105 / 85-142 | Factor de verificación decidido por `Origin` del cliente (CR-01) | Warning (decisión humana) | Ver verificación humana 1 |
| `src/lib/verification-api.ts` | 73-84 | Sin límite de intentos en `/api/verification/password` (WR-01, sin probar) | Warning | Abierto en 06-REVIEW-DISPOSITION.md |
| `src/lib/nas.ts`, `collector.ts` | 27-41, 385-389 | Exceso de `/metrics` ciega el monitoreo sin log (WR-02) | Warning | Abierto; topes a medir en producción |
| rutas protegidas | - | Orden de replay inconsistente y sin comparar la acción (WR-03) | Warning | Abierto; el caso de host-command es más estricto, no más laxo |
| `src/proxy.ts` | 29 | Rutas con punto sin CSP (IN-01) | Info | Abierto |

### Human Verification Required

Ver el frontmatter (`human_verification`): (1) decisión sobre CR-01; (2) cabeceras reales por dominio; (3) Safari y Firefox; (4) diálogo de passkey con autenticador real.

### Gaps Summary

No hay verdades de la hoja de ruta que fallen: la protección en servidor de las acciones destructivas, el manifiesto único con pruebas que fallan ante rutas no declaradas, la CSP con nonce, HSTS y el límite de cuerpo con 413 antes de parsear existen, están conectados y los ejercitan pruebas que pasan (confirmado con dos mutaciones propias).

Queda una decisión que no se puede cerrar desde el código: CR-01, un hallazgo crítico de la revisión de código sin triar (`06-REVIEW-DISPOSITION.md`, los 9 hallazgos en `open`). Es una debilidad anterior a la fase en cómo se elige el factor de verificación, que solo se manifiesta con un origen alternativo configurado, pero afecta justo a la garantía que esta fase prepara para la Fase 7 (acciones desde Telegram). Se recomienda triarlo antes de empezar la Fase 7. Los hallazgos WR-01 a WR-04 e IN-01 a IN-04 también siguen sin disposición.

Nota ajena a la fase: `tests/runtime-config.test.ts` tiene un caso intermitente (par VAPID generado al azar); `pnpm lint` completo falla por directorios de herramienta no versionados (ya anotado en `deferred-items.md`).

---

_Verified: 2026-11-27T15:10:00Z_
_Verifier: Claude (gsd-verifier)_
