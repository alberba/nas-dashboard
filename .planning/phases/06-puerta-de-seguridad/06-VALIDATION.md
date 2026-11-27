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
| 06-01-T1 | 06-01 | 1 | SEC-01, SEC-02 | T-06-01, T-06-03 | Una acción protegida sin verificación reciente responde 403 `recent_verification_required` sin llegar al agente ni a `operations`; la UI decide desde el manifiesto | tracer (integración + tipos) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | Se crea en la tarea (`tests/sensitive-actions.test.ts`, `tests/verified-session.ts`) | ⬜ |
| 06-01-T2 | 06-01 | 1 | SEC-01 | T-06-02 | Cada comando de host que cambia estado exige verificación reciente; `check-health` no | integración (matriz por comando) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/api-host-commands.test.ts && pnpm typecheck` | ✅ (ampliar) | ⬜ |
| 06-01-T3 | 06-01 | 1 | SEC-01 | T-06-01, T-06-04 | Los tests de API existentes siembran la verificación con el ayudante compartido y la acción de incidencia (D-05) sigue exenta | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/api-hosts.test.ts tests/api-incidents.test.ts tests/api-host-commands.test.ts tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts && pnpm typecheck && pnpm lint` | ✅ | ⬜ |
| 06-02-T1 | 06-02 | 1 | SEC-04 | T-06-05, T-06-09 | El login se hidrata con CSP con nonce por petición y sin `securitypolicyviolation` | tracer (e2e) | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/csp.spec.ts` | Se crea en la tarea (`tests/e2e/csp.spec.ts`) | ⬜ |
| 06-02-T2 | 06-02 | 1 | SEC-04 | T-06-06, T-06-07, T-06-08 | HSTS en toda respuesta y CSP mínima en `/api/:path*`, comprobadas por nombre de directiva | unitario (estructura) | `pnpm test tests/security-headers.test.ts && pnpm typecheck` | Se crea en la tarea (`tests/security-headers.test.ts`) | ⬜ |
| 06-02-T3 | 06-02 | 1 | SEC-04 | T-06-08, T-06-09 | Panel, 404 y registro del service worker sin violaciones; cabeceras reales con HSTS y CSP de API | e2e + comprobación humana | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/csp.spec.ts tests/e2e/dashboard.spec.ts` | ✅ | ⬜ |
| 06-03-T1 | 06-03 | 2 | SEC-01 | T-06-10, T-06-11 | La tarjeta y la búsqueda abren el diálogo de passkey para los comandos protegidos y envían `check-health` directo | tracer (unitario + e2e) | `pnpm test tests/maintenance-ui.test.ts && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/maintenance-workflows.spec.ts` | ✅ (ampliar) | ⬜ |
| 06-03-T2 | 06-03 | 2 | SEC-01 | T-06-10 | Purgar, vaciar la papelera y reiniciar pasan por el diálogo de acción sensible en los e2e | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/files-apps.spec.ts tests/e2e/hosts.spec.ts tests/e2e/maintenance.spec.ts tests/e2e/sensitive-action.spec.ts` | ✅ (adaptar) | ⬜ |
| 06-04-T1 | 06-04 | 2 | SEC-04 | T-06-12, T-06-13 | Un cuerpo de más de 16 KiB en `/api/action` responde 413 sin parsear, sin `operations` y sin `console.error` | tracer (unitario + integración) | `pnpm test tests/request-body.test.ts && HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | Se crea en la tarea (`tests/request-body.test.ts`) | ⬜ |
| 06-04-T2 | 06-04 | 2 | SEC-04 | T-06-14, T-06-15 | Contenedor, host, ajustes y merge leen el cuerpo con el helper; los ajustes admiten 64 KiB y rechazan más | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-deployment-settings.test.ts tests/api-lifecycle.test.ts tests/api-merge-progress.test.ts tests/api-host-commands.test.ts && pnpm typecheck` | ✅ (ampliar) | ⬜ |
| 06-04-T3 | 06-04 | 2 | SEC-04 | T-06-12, T-06-14 | Las catorce mutaciones del catch-all responden 413 sin degradarlo a 400 o 503 | integración (matriz) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/verification.test.ts tests/api-hosts.test.ts tests/api-incidents.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ |
| 06-05-T1 | 06-05 | 3 | SEC-02 | T-06-16, T-06-17, T-06-19 | Un verbo o ruta no declarados no llegan a ningún handler: `DELETE /api/action` responde 405 con `Allow` y 401 precede a 404 y 405 | tracer (integración) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | ✅ (ampliar) | ⬜ |
| 06-05-T2 | 06-05 | 3 | SEC-02 | T-06-16, T-06-19 | Los escaneos estáticos fallan ante un literal, una ruta regex, un `route.ts` o una lectura de cuerpo sin declarar | unitario (estructura) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ |
| 06-05-T3 | 06-05 | 3 | SEC-04 | T-06-18 | El POST de `/api/auth/*` rechaza con 413 por encima de 32 KiB sin invocar a Better Auth y no rompe login ni passkey | unitario + e2e | `pnpm test tests/auth-body-limit.test.ts && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/dashboard.spec.ts tests/e2e/sensitive-action.spec.ts` | Se crea en la tarea (`tests/auth-body-limit.test.ts`) | ⬜ |
| 06-06-T1 | 06-06 | 4 | SEC-04 | T-06-20, T-06-21, T-06-22 | Una respuesta del agente por encima del tope no se lee entera: 502 `agent_response_too_large` y la vista conserva el último dato | tracer (unitario + integración) | `pnpm test tests/agent-client.test.ts && HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-deployments.test.ts && pnpm typecheck` | ✅ (ampliar) | ⬜ |
| 06-06-T2 | 06-06 | 4 | SEC-04 | T-06-23 | El listado de archivos y el estado de mantenimiento conservan el último dato y señalan que la respuesta es demasiado grande | unitario + e2e | `pnpm test tests/maintenance-polling.test.ts && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/files-apps.spec.ts` | ✅ (ampliar) | ⬜ |
| 06-06-T3 | 06-06 | 4 | SEC-04 | T-06-21, T-06-23 | Logs y colector tratan el exceso como contrato roto y no escriben muestra; el README documenta los límites | integración + comprobación humana | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/deploy-progress.test.ts tests/agent-client.test.ts tests/api-logs.test.ts tests/api-maintenance.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ |

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
