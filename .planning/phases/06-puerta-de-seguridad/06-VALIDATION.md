---
phase: "06"
slug: "puerta-de-seguridad"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-27"
---

# Fase 6 · Estrategia de validación

> Contrato de validación de la fase para muestrear el resultado durante la ejecución. Sale de la [investigación](06-RESEARCH.md#validation-architecture).

---

## Infraestructura de pruebas

| Propiedad | Valor |
|-----------|-------|
| **Framework** | Vitest 5.1.0 (unitarios y API) y Playwright 1.65 (e2e en Chromium) |
| **Configuración** | `vitest.config.ts` (alias `@` a `src`, `include: ["tests/**/*.test.ts"]`) y `playwright.config.ts` (`webServer: pnpm start`) |
| **Comando rápido** | `pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/security-headers.test.ts` |
| **Suite completa** | `HUB_REQUIRE_TEST_DB=1 pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e` |
| **Base de datos** | PostgreSQL 18 desechable de loopback, como en CI. `HUB_REQUIRE_TEST_DB=1` impide que se omitan casos. |
| **Duración estimada** | ~60 s el comando rápido; la suite completa con e2e, varios minutos |

---

## Frecuencia

- **Tras cada tarea:** `pnpm test <ficheros de la tarea> && pnpm typecheck`, con `HUB_REQUIRE_TEST_DB=1` cuando la tarea toque rutas.
- **Tras cada ola:** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/security-headers.test.ts tests/api-hosts.test.ts tests/api-incidents.test.ts tests/api-host-commands.test.ts tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts tests/agent-client.test.ts && pnpm typecheck && pnpm lint`.
- **Antes de `/gsd-verify-work`:** suite completa, `pnpm build` y los e2e de CSP, `sensitive-action`, `maintenance-workflows`, `files-apps` y `hosts` en verde, más el `pnpm test:e2e` completo en CI.
- **Latencia máxima de respuesta:** 120 s por comando focalizado.

---

## Matriz de verificación por tarea

Se completa al cerrar la planificación, con una fila por tarea de los PLAN.md de la fase.

| Task ID | Plan | Ola | Requisito | Amenaza | Comportamiento seguro | Tipo | Comando automático | Fichero existe | Estado |
|---------|------|-----|-----------|---------|-----------------------|------|--------------------|----------------|--------|

*Estado: ⬜ pendiente · ✅ verde · ❌ rojo · ⚠️ inestable*

### Requisitos → pruebas (de la investigación)

| Req | Comportamiento | Tipo | Comando | ¿Existe? |
|-----|----------------|------|---------|----------|
| SEC-01 | Cada acción y comando protegido devuelve 403 `recent_verification_required` sin verificación, no llama al agente y no inserta `operations` | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ❌ Ola 0 |
| SEC-01 | Cada acción y comando exento no devuelve 403 de verificación | integración | idem | ❌ Ola 0 |
| SEC-01 | `containers/remove`, `deployments/settings` y `renovate/merge` siguen protegidos | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts` | ✅ |
| SEC-01 | La UI abre el diálogo de passkey exactamente para lo protegido (`data-sensitive-action`) y `check-health` no | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/sensitive-action.spec.ts tests/e2e/maintenance-workflows.spec.ts tests/e2e/files-apps.spec.ts` | ✅ (adaptar) |
| SEC-02 | Una acción nueva en `actionSchema` o un comando nuevo en `hostCommandIds` sin entrada falla (tipos y test) | unitario + tipos | `pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | ❌ Ola 0 |
| SEC-02 | Todo literal `route === "…"` del catch-all y toda ruta regex tiene entrada en el manifiesto | unitario (estructura) | `pnpm test tests/sensitive-actions.test.ts` | ❌ Ola 0 |
| SEC-02 | `src/app/api/**/route.ts` coincide con `routeFiles` del manifiesto | unitario (estructura) | idem | ❌ Ola 0 |
| SEC-02 | Un método no declarado (p. ej. `DELETE /api/action`) no llega al handler | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ❌ Ola 0 |
| SEC-04 | Cuerpo por encima del tope: 413, sin parseo, sin `operations`, sin `console.error` | unitario + integración | `pnpm test tests/request-body.test.ts` y `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ❌ Ola 0 |
| SEC-04 | `Content-Length` declarado grande se rechaza sin leer el flujo; un cuerpo troceado sin cabecera se corta | unitario | `pnpm test tests/request-body.test.ts` | ❌ Ola 0 |
| SEC-04 | `deployments/settings` admite hasta su tope propio de 64 KiB y rechaza más | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-deployment-settings.test.ts` | ✅ (ampliar) |
| SEC-04 | Respuesta del agente por encima del tope: `NasInvalidResponse` con `ResponseTooLarge`, sin JSON parcial; la ruta responde 502 `agent_response_too_large`; el colector no escribe muestra | unitario + integración | `pnpm test tests/agent-client.test.ts` y `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-logs.test.ts tests/collector-alerts.test.ts` | ✅ (ampliar) |
| SEC-04 | `next.config.ts` emite HSTS y CSP `default-src 'none'` en `/api/:path*`; `buildContentSecurityPolicy` no lleva `'unsafe-inline'` ni `'unsafe-eval'` en scripts de producción y sí `object-src 'none'` y `frame-ancestors 'none'` | unitario (estructura) | `pnpm test tests/security-headers.test.ts` | ❌ Ola 0 |
| SEC-04 | El documento sirve CSP con nonce y no hay `securitypolicyviolation` en login, panel, 404 ni al registrar el service worker | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/csp.spec.ts` | ❌ Ola 0 |

Los tests aseveran estado, resultado o estructura, nunca copy (`CODING_STANDARD.md`). El 413 se comprueba por estado HTTP y las directivas por nombre, no por el texto completo.

---

## Ola 0

- [ ] `tests/verified-session.ts`: helper compartido que siembra `recentVerification` y fija `session: { id: "test-session" }`. Lo necesitan `api-hosts`, `api-incidents`, `api-host-commands`, `api-lifecycle` y el nuevo test de matriz.
- [ ] `tests/sensitive-actions.test.ts`: manifiesto, escaneo de literales, `routeFiles` y matriz de comportamiento por entrada (SEC-01, SEC-02).
- [ ] `tests/request-body.test.ts`: los dos caminos del lector y el 413 sin efectos (SEC-04).
- [ ] `tests/security-headers.test.ts`: `headers()` de `next.config.ts` y `buildContentSecurityPolicy` (SEC-04).
- [ ] `tests/e2e/csp.spec.ts`: sin violaciones de CSP con la compilación de producción (SEC-04).
- [ ] Adaptar `tests/e2e/files-apps.spec.ts`, `hosts.spec.ts` y `maintenance-workflows.spec.ts` para interceptar `/api/verification` en los flujos migrados.
- Framework ya instalado; sin dependencias nuevas.

---

## Comprobaciones de entorno

| Comportamiento | Requisito | Por qué es manual | Ejecución |
|----------------|-----------|-------------------|-----------|
| HSTS llega una sola vez por el dominio principal y por el de Tailscale Serve | SEC-04 | Depende de Nginx Proxy Manager y Tailscale Serve, que no corren en CI | En UAT, `curl -sI` contra ambos dominios y comprobar una sola cabecera `Strict-Transport-Security`. El conmutador HSTS de Nginx Proxy Manager debe quedar apagado. |
| CSP sin violaciones en Safari y Firefox con passkey y push | SEC-04 | Playwright solo cubre Chromium | En UAT, abrir el panel, verificar con passkey y activar push; la consola no debe mostrar violaciones de CSP. |
| Topes de respuesta del agente frente a tamaños reales | SEC-04 | Los topes propuestos son supuestos sin medir | Antes de cerrar la fase, medir `/metrics`, `/files` y `/logs` en producción y confirmar que quedan por debajo de su tope. |

---

## Cierre de la validación

- [ ] Todas las tareas tienen verificación `<automated>` o dependen de la Ola 0
- [ ] Continuidad del muestreo: nunca tres tareas seguidas sin verificación automática
- [ ] La Ola 0 cubre todas las referencias MISSING
- [ ] Sin modo watch
- [ ] Latencia de respuesta por debajo de 120 s
- [ ] `nyquist_compliant: true` en el frontmatter

**Aprobación:** pendiente
