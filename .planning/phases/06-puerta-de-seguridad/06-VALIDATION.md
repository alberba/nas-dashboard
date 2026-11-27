---
phase: "06"
slug: "puerta-de-seguridad"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-27"
validated: "2026-11-27"
---

# Fase 6 · Estrategia de validación

> Contrato de validación de la fase completa. SEC-01, SEC-02 y SEC-04 tienen verificación automatizada y en verde. Las comprobaciones que exigen el entorno real (proxies, Safari y Firefox, tamaños de producción), la revisión de diseño y de redacción y la confirmación de las exenciones de la suposición A10 quedan registradas como casos manuales o decisiones pendientes del usuario, no como brechas.

---

## Infraestructura de pruebas

| Propiedad | Valor |
|-----------|-------|
| **Framework** | Vitest 5.1.0 (unitarios y API) y Playwright 1.65 (e2e en Chromium) |
| **Configuración** | `vitest.config.ts` (alias `@` a `src`, `include: ["tests/**/*.test.ts"]`) y `playwright.config.ts` (`webServer: pnpm start`) |
| **Comando rápido** | `pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/security-headers.test.ts` |
| **Suite completa** | `HUB_REQUIRE_TEST_DB=1 pnpm test && pnpm typecheck && pnpm lint src tests && pnpm build && pnpm test:e2e` |
| **Base de datos** | PostgreSQL 18 desechable de loopback, como en CI. `HUB_REQUIRE_TEST_DB=1` impide que se omitan casos. Los e2e usan una base dedicada y migrada, con `CI=1` y `NAS_HOSTS` vacío para aislarlos de la configuración local. |
| **Duración observada** | Vitest completo, de 20 a 32 s según la carga; e2e focalizados, de 6 a 33 s; `pnpm test:e2e` completo (11 ficheros, 79 pruebas), 1,8 min |

---

## Frecuencia

- **Tras cada tarea:** `pnpm test <ficheros de la tarea> && pnpm typecheck`, con `HUB_REQUIRE_TEST_DB=1` cuando la tarea toque rutas.
- **Tras cada ola:** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/security-headers.test.ts tests/api-hosts.test.ts tests/api-incidents.test.ts tests/api-host-commands.test.ts tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts tests/agent-client.test.ts && pnpm typecheck && pnpm lint src tests`.
- **Antes de `/gsd-verify-work`:** suite completa, `pnpm build` y los e2e de CSP, `sensitive-action`, `maintenance-workflows`, `files-apps` y `hosts` en verde, más el `pnpm test:e2e` completo en CI.
- **Inicios de sesión en los e2e:** Better Auth limita los inicios de sesión por correo. `csp`, `sensitive-action` y `maintenance-workflows` esperan su turno en `beforeAll` cuando reciben 429, de modo que cualquier subconjunto de ficheros corre en una sola invocación. Tras restaurar ficheros de una prueba de mutación, `rm -rf .next && pnpm build` antes de lanzar los e2e: una compilación incremental hecha en los mismos segundos arrastró código obsoleto durante esta auditoría.
- **Latencia máxima de respuesta:** 120 s por comando focalizado.

---

## Matriz de verificación por tarea

Una fila por tarea de los seis PLAN.md. Todas las pruebas referenciadas existen y están en verde.

| Task ID | Plan | Ola | Requisito | Amenaza | Comportamiento seguro | Tipo | Comando automático | Fichero existe | Estado |
|---------|------|-----|-----------|---------|-----------------------|------|--------------------|----------------|--------|
| 06-01-T1 | 06-01 | 1 | SEC-01, SEC-02 | T-06-01, T-06-03 | Una acción protegida sin verificación reciente responde 403 `recent_verification_required` sin llegar al agente ni a `operations`; la UI decide desde el manifiesto | tracer (integración + tipos) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | ✅ (`tests/sensitive-actions.test.ts`, `tests/verified-session.ts`) | ✅ green |
| 06-01-T2 | 06-01 | 1 | SEC-01 | T-06-02 | Cada comando de host que cambia estado exige verificación reciente; `check-health` no | integración (matriz por comando) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/api-host-commands.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 06-01-T3 | 06-01 | 1 | SEC-01 | T-06-01, T-06-04 | Los tests de API existentes siembran la verificación con el ayudante compartido y la acción de incidencia (D-05) sigue exenta | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/api-hosts.test.ts tests/api-incidents.test.ts tests/api-host-commands.test.ts tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts && pnpm typecheck && pnpm lint` | ✅ | ✅ green |
| 06-02-T1 | 06-02 | 1 | SEC-04 | T-06-05, T-06-09 | El login se hidrata con CSP con nonce por petición y sin `securitypolicyviolation` | tracer (e2e) | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/csp.spec.ts` | ✅ (`tests/e2e/csp.spec.ts`) | ✅ green |
| 06-02-T2 | 06-02 | 1 | SEC-04 | T-06-06, T-06-07, T-06-08 | HSTS en toda respuesta y CSP mínima en `/api/:path*`, comprobadas por nombre de directiva | unitario (estructura) | `pnpm test tests/security-headers.test.ts && pnpm typecheck` | ✅ (`tests/security-headers.test.ts`) | ✅ green |
| 06-02-T3 | 06-02 | 1 | SEC-04 | T-06-08, T-06-09 | Panel, 404 y registro del service worker sin violaciones; cabeceras reales con HSTS y CSP de API | e2e + comprobación humana | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/csp.spec.ts tests/e2e/dashboard.spec.ts` | ✅ | ✅ green |
| 06-03-T1 | 06-03 | 2 | SEC-01 | T-06-10, T-06-11 | La tarjeta y la búsqueda abren el diálogo de passkey para los comandos protegidos y envían `check-health` directo | tracer (unitario + e2e) | `pnpm test tests/maintenance-ui.test.ts && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/maintenance-workflows.spec.ts` | ✅ | ✅ green |
| 06-03-T2 | 06-03 | 2 | SEC-01 | T-06-10 | Purgar, vaciar la papelera y reiniciar pasan por el diálogo de acción sensible en los e2e | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/files-apps.spec.ts tests/e2e/hosts.spec.ts tests/e2e/maintenance.spec.ts tests/e2e/sensitive-action.spec.ts` | ✅ | ✅ green |
| 06-04-T1 | 06-04 | 2 | SEC-04 | T-06-12, T-06-13 | Un cuerpo de más de 16 KiB en `/api/action` responde 413 sin parsear, sin `operations` y sin `console.error` | tracer (unitario + integración) | `pnpm test tests/request-body.test.ts && HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | ✅ (`tests/request-body.test.ts`) | ✅ green |
| 06-04-T2 | 06-04 | 2 | SEC-04 | T-06-14, T-06-15 | Contenedor, host, ajustes y merge leen el cuerpo con el helper; los ajustes admiten 64 KiB y rechazan más | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-deployment-settings.test.ts tests/api-lifecycle.test.ts tests/api-merge-progress.test.ts tests/api-host-commands.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 06-04-T3 | 06-04 | 2 | SEC-04 | T-06-12, T-06-14 | Las catorce mutaciones del catch-all responden 413 sin degradarlo a 400 o 503 | integración (matriz) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/verification.test.ts tests/api-hosts.test.ts tests/api-incidents.test.ts && pnpm typecheck && pnpm lint` | ✅ | ✅ green |
| 06-05-T1 | 06-05 | 3 | SEC-02 | T-06-16, T-06-17, T-06-19 | Un verbo o ruta no declarados no llegan a ningún handler: `DELETE /api/action` responde 405 con `Allow` y 401 precede a 404 y 405 | tracer (integración) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 06-05-T2 | 06-05 | 3 | SEC-02 | T-06-16, T-06-19 | Los escaneos estáticos fallan ante un literal, una ruta regex, un `route.ts` o una lectura de cuerpo sin declarar | unitario (estructura) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts && pnpm typecheck && pnpm lint` | ✅ | ✅ green |
| 06-05-T3 | 06-05 | 3 | SEC-04 | T-06-18 | El POST de `/api/auth/*` rechaza con 413 por encima de 32 KiB sin invocar a Better Auth y no rompe login ni passkey | unitario + e2e | `pnpm test tests/auth-body-limit.test.ts && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/dashboard.spec.ts tests/e2e/sensitive-action.spec.ts` | ✅ (`tests/auth-body-limit.test.ts`) | ✅ green |
| 06-06-T1 | 06-06 | 4 | SEC-04 | T-06-20, T-06-21, T-06-22 | Una respuesta del agente por encima del tope no se lee entera: 502 `agent_response_too_large` y la vista conserva el último dato | tracer (unitario + integración) | `pnpm test tests/agent-client.test.ts && HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-deployments.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 06-06-T2 | 06-06 | 4 | SEC-04 | T-06-23 | El listado de archivos y el estado de mantenimiento conservan el último dato y señalan que la respuesta es demasiado grande | unitario + e2e | `pnpm test tests/maintenance-polling.test.ts && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/files-apps.spec.ts` | ✅ | ✅ green |
| 06-06-T3 | 06-06 | 4 | SEC-04 | T-06-21, T-06-23 | Logs y colector tratan el exceso como contrato roto y no escriben muestra; el README documenta los límites | integración + comprobación humana | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/deploy-progress.test.ts tests/agent-client.test.ts tests/api-logs.test.ts tests/api-maintenance.test.ts && pnpm typecheck && pnpm lint` | ✅ | ✅ green |

*Estado: ⬜ pendiente · ✅ verde · ❌ rojo · ⚠️ inestable*

Las 17 tareas tienen comando automático y la prueba que referencian existe en el repositorio. La suite completa (55 archivos, 824 tests) pasó sobre PostgreSQL 18 sin omisiones, y los 79 e2e pasaron con la compilación de producción vigente. La auditoría añadió 11 casos (7 de Vitest y 4 de e2e) para seis brechas, descritas en «Brechas cerradas por la auditoría».

### Requisitos → pruebas (de la investigación)

| Req | Comportamiento | Tipo | Comando | ¿Existe? |
|-----|----------------|------|---------|----------|
| SEC-01 | Cada acción y comando protegido devuelve 403 `recent_verification_required` sin verificación, no llama al agente y no inserta `operations` | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ✅ |
| SEC-01 | Cada acción y comando exento no devuelve 403 de verificación | integración | idem | ✅ |
| SEC-01 | `containers/remove`, `deployments/settings` y `renovate/merge` siguen protegidos | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts` | ✅ |
| SEC-01 | La UI abre el diálogo de passkey exactamente para lo protegido (`data-sensitive-action`) y `check-health` no | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/sensitive-action.spec.ts tests/e2e/maintenance-workflows.spec.ts tests/e2e/files-apps.spec.ts` | ✅ |
| SEC-02 | Una acción nueva en `actionSchema` o un comando nuevo en `hostCommandIds` sin entrada falla (tipos y test) | unitario + tipos | `pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | ✅ |
| SEC-02 | Todo literal `route === "…"` del catch-all y toda ruta regex tiene entrada en el manifiesto | unitario (estructura) | `pnpm test tests/sensitive-actions.test.ts` | ✅ |
| SEC-02 | `src/app/api/**/route.ts` coincide con `routeFiles` del manifiesto | unitario (estructura) | idem | ✅ |
| SEC-02 | Un método no declarado (p. ej. `DELETE /api/action`) no llega al handler | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ✅ |
| SEC-04 | Cuerpo por encima del tope: 413, sin parseo, sin `operations`, sin `console.error` | unitario + integración | `pnpm test tests/request-body.test.ts` y `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ✅ |
| SEC-04 | `Content-Length` declarado grande se rechaza sin leer el flujo; un cuerpo troceado sin cabecera se corta | unitario | `pnpm test tests/request-body.test.ts` | ✅ |
| SEC-04 | `deployments/settings` admite hasta su tope propio de 64 KiB y rechaza más | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-deployment-settings.test.ts` | ✅ |
| SEC-04 | Respuesta del agente por encima del tope: `NasInvalidResponse` con `ResponseTooLarge`, sin JSON parcial; la ruta responde 502 `agent_response_too_large`; el colector no escribe muestra | unitario + integración | `pnpm test tests/agent-client.test.ts` y `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-logs.test.ts tests/collector-alerts.test.ts` | ✅ |
| SEC-04 | `next.config.ts` emite HSTS y CSP `default-src 'none'` en `/api/:path*`; `buildContentSecurityPolicy` no lleva `'unsafe-inline'` ni `'unsafe-eval'` en scripts de producción y sí `object-src 'none'` y `frame-ancestors 'none'` | unitario (estructura) | `pnpm test tests/security-headers.test.ts` | ✅ |
| SEC-04 | El documento sirve CSP con nonce y no hay `securitypolicyviolation` en login, panel, 404 ni al registrar el service worker | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/csp.spec.ts` | ✅ |

Los tests aseveran estado, resultado o estructura, nunca copy (`CODING_STANDARD.md`). El 413 se comprueba por estado HTTP y las directivas por nombre, no por el texto completo.

---

## Cobertura por requisito

| Requisito | Evidencia automatizada | Estado |
|-----------|------------------------|--------|
| SEC-01 | `tests/sensitive-actions.test.ts` (96 casos: cada acción del esquema declarada una vez con motivo, 403 `recent_verification_required` sin llegar al agente ni a `operations` para las protegidas, ningún 403 para las exentas, el límite de cinco minutos, el reenvío de una operación registrada y la matriz por comando de host), `tests/api-host-commands.test.ts` (26), `tests/api-lifecycle.test.ts` (13), `tests/api-deployment-settings.test.ts` (23), `tests/api-merge-progress.test.ts` (22), `tests/api-hosts.test.ts` (8), `tests/api-incidents.test.ts` (33) y `tests/maintenance-ui.test.ts` (2); e2e `sensitive-action.spec.ts` (9), `maintenance-workflows.spec.ts` (7, tarjeta y búsqueda), `files-apps.spec.ts` (6), `hosts.spec.ts` (8) y `maintenance.spec.ts` (12, filas de contenedor) | ✅ COVERED |
| SEC-02 | `tests/sensitive-actions.test.ts`: `route declarations` (cada literal y cada ruta regex del catch-all, cada `route.ts`, los verbos exportados y toda lectura de cuerpo declarados, sin entradas obsoletas), `route manifest dispatch` (405 con `Allow`, 401 antes que 404 y 405, claves heredadas del objeto que no resuelven como ruta) y `whole-route protection` (rutas protegidas y exentas con su petición tipada); `pnpm typecheck` obliga a declarar toda acción y todo comando nuevos | ✅ COVERED |
| SEC-04 | `tests/request-body.test.ts` (15), `tests/auth-body-limit.test.ts` (7), `tests/sensitive-actions.test.ts` (413 sin parseo, sin `operations` y sin `console.error` en `/api/action` y en cada mutación), `tests/security-headers.test.ts` (4), `tests/agent-client.test.ts` (12), `tests/api-deployments.test.ts` (6), `tests/api-logs.test.ts` (9), `tests/collector-alerts.test.ts` (50, sin muestra ante una respuesta excesiva), `tests/maintenance-polling.test.ts` (8) y el tope propio de 64 KiB de `tests/api-deployment-settings.test.ts`; e2e `csp.spec.ts` (5), `dashboard.spec.ts` (3, inicio de sesión y passkey bajo el envoltorio de Better Auth), `files-apps.spec.ts` y `maintenance-status.spec.ts` (10, conservan el último dato) | ✅ COVERED |

---

## Ola 0

- [x] `tests/verified-session.ts`: helper compartido que siembra `recentVerification` y fija `session: { id: "test-session" }`. Lo usan `api-hosts`, `api-incidents`, `api-host-commands`, `api-lifecycle` y la matriz de `sensitive-actions`.
- [x] `tests/sensitive-actions.test.ts`: manifiesto, escaneo de literales, `routeFiles` y matriz de comportamiento por entrada (SEC-01, SEC-02). 96 casos.
- [x] `tests/request-body.test.ts`: los dos caminos del lector y el 413 sin efectos (SEC-04). 15 casos.
- [x] `tests/security-headers.test.ts`: `headers()` de `next.config.ts` y `buildContentSecurityPolicy` (SEC-04). 4 casos.
- [x] `tests/e2e/csp.spec.ts`: sin violaciones de CSP con la compilación de producción (SEC-04). 5 pruebas.
- [x] `files-apps.spec.ts`, `hosts.spec.ts` y `maintenance-workflows.spec.ts` interceptan `/api/verification` en los flujos migrados.
- Framework ya instalado; sin dependencias nuevas.

---

## Brechas cerradas por la auditoría

Seis brechas con comportamiento sin prueba que lo fijara. Cada prueba se verificó con una mutación temporal de la implementación que la hace fallar, y `src/` y `agent/` se restauraron sin cambios.

| # | Requisito | Tarea | Brecha | Prueba añadida | Falla ante |
|---|-----------|-------|--------|----------------|------------|
| 1 | SEC-01 | 06-01-T2 | Nada fijaba que una petición mal formada a `/api/host-command` se responda como tal y no como falta de verificación: la puerta va después del cuerpo, el host y la clave | `tests/api-host-commands.test.ts`, 4 casos «answers $name as itself without a recent verification» (comando fuera de la lista 400, host desconocido 404, clave ausente 400 y clave que no es UUID 400, sin agente ni `operations`) | La puerta antes de validar (4 casos) o entre el cuerpo y el host y la clave (3 casos) |
| 2 | SEC-04 | 06-06-T1 | El cliente del agente prueba el tope de las respuestas a POST, pero ninguna prueba de ruta fijaba que un éxito por encima del tope en un comando de host quede pendiente, no fallido, y no se reenvíe | `tests/api-host-commands.test.ts`, «leaves an answer over its cap pending and never sends it again» (502 `pending`, operación `pending`, un solo envío al agente aun reintentando con la misma clave) | Una respuesta excesiva modelada como rechazo en `src/lib/nas.ts` (7 pruebas, las dos nuevas y cinco del cliente) |
| 3 | SEC-04 | 06-06-T1 | Lo mismo para las acciones de contenedor de `/api/action` | `tests/api-lifecycle.test.ts`, «leaves an action answered over the cap pending and does not send it again» | La misma mutación |
| 4 | SEC-04 | 06-04-T2 | El tope de 64 KiB de los ajustes de despliegue del hub debe coincidir con el `MAX_REQUEST_BYTES` del agente, que se despliega aparte, y nada lo vigilaba | `tests/api-deployment-settings.test.ts`, «stays aligned with the request cap the agent enforces» (lee la constante de `agent/env_settings.py`) | El tope del agente se aleja del del hub |
| 5 | SEC-04 | 06-06-T2 | `useHostRead` y el estado de mantenimiento conservan el último dato y señalan el rechazo por tamaño, pero `06-06-SUMMARY.md` (D8) lo dejaba sin verificación automática; solo el listado de archivos tenía e2e | `tests/e2e/maintenance-status.spec.ts`, 3 pruebas: un refresco rechazado conserva los datos y se distingue de otros fallos, una primera lectura rechazada termina en la fase de error con la misma nota y los eventos de hoy conservan sus filas y solo retransmiten el rechazo por tamaño | La nota no distingue el tamaño, el mensaje del servidor no se retransmite o se retransmite cualquiera, o el dato anterior se descarta (cuatro mutaciones) |
| 6 | SEC-01 | 06-03-T2 | Las acciones de fila de los contenedores (parar, reiniciar, arrancar) no tenían prueba de que abran el diálogo de passkey exactamente para las protegidas del manifiesto | `tests/e2e/maintenance.spec.ts`, «container row actions open the passkey dialog exactly for the protected ones» | La interfaz se salta el diálogo al parar o lo pide al arrancar (dos mutaciones) |

### Pruebas existentes endurecidas

Dos defectos de la prueba, no de la implementación, en `tests/e2e/maintenance-workflows.spec.ts`:

- **Lectura sin espera.** «the host actions card asks for verification exactly for the protected commands» leía los comandos con `evaluateAll` justo tras `goto`, antes de que la tarjeta se dibujara. En una tirada de 30 repeticiones, de las 6 que superaron el inicio de sesión, 4 fallaron en esa lectura; con la espera por `backup-now` (solo lo lista un host `instance`) pasaron 10 de 10, cada una con un servidor nuevo.
- **Presupuesto de inicios de sesión.** El `beforeAll` no esperaba el 429 de Better Auth como `csp.spec.ts` y `sensitive-action.spec.ts`. El subconjunto de cinco ficheros del contrato de frecuencia fallaba 2 de 2; ahora pasa (35 de 35) y los ocho ficheros de la fase corren en una sola invocación (60 de 60).

---

## Recorridos de navegador

| Fichero | Pruebas | Resultado |
|---------|---------|-----------|
| `csp.spec.ts` | 5 | ✅ |
| `dashboard.spec.ts` | 3 | ✅ |
| `files-apps.spec.ts` | 6 | ✅ |
| `hosts.spec.ts` | 8 | ✅ |
| `maintenance-status.spec.ts` | 10 (3 nuevas) | ✅ |
| `maintenance-workflows.spec.ts` | 7 | ✅ |
| `maintenance.spec.ts` | 12 (1 nueva) | ✅ |
| `sensitive-action.spec.ts` | 9 | ✅ |

Los ocho ficheros suman 60 pruebas (56 antes de la auditoría más 4 nuevas) y pasan 60 de 60 en una sola invocación. `overview`, `incidents` y `logs` completan las 79 de `pnpm test:e2e`, que pasan 79 de 79. Todas se ejecutaron con `CI=1` sobre PostgreSQL 18 migrado, una compilación limpia y Chromium.

---

## Comprobaciones de entorno

Declaradas por los planes 06-02 y 06-06. Siguen pendientes: no se pueden ejecutar desde CI ni desde esta auditoría.

| Comportamiento | Requisito | Por qué es manual | Ejecución | Estado |
|----------------|-----------|-------------------|-----------|--------|
| HSTS llega una sola vez por el dominio principal y por el de Tailscale Serve | SEC-04 | Depende de Nginx Proxy Manager y Tailscale Serve, que no corren en CI (A3, A4) | En UAT, `curl -sI` contra ambos dominios y comprobar una sola cabecera `Strict-Transport-Security`. El conmutador HSTS de Nginx Proxy Manager debe quedar apagado. | Pendiente (UAT) |
| CSP sin violaciones en Safari y Firefox con passkey y push | SEC-04 | Playwright solo cubre Chromium (A7, A8) | En UAT, abrir el panel, verificar con passkey y activar push; la consola no debe mostrar violaciones de CSP. | Pendiente (UAT) |
| Topes de respuesta del agente frente a tamaños reales | SEC-04 | Los topes propuestos son supuestos sin medir (A1) | Antes de cerrar la fase, medir `/metrics`, `/files` y `/logs` en producción y confirmar que quedan por debajo de su tope; vigilar unos días los `502 agent_response_too_large`. | Pendiente (producción) |

## Casos manuales de revisión

| Caso | Requisito | Por qué es manual | Instrucciones | Estado |
|------|-----------|-------------------|---------------|--------|
| Aspecto y ergonomía del diálogo de passkey en la tarjeta de host, la búsqueda y las filas de contenedor (foco, consecuencias, tono) | SEC-01 | Los e2e aseveran estado y peticiones, no la calidad visual ni el flujo con una passkey real (`06-03-SUMMARY.md`, D5) | Revisar al cierre de la fase con `06-UI-SPEC.md` | Pendiente |
| Redacción de la sección «Límites de cuerpo y de respuesta» del README | SEC-04 | El estándar de pruebas prohíbe acoplarse al texto | Leerla con los topes reales delante y confirmar que la lista de acciones protegidas es la del manifiesto | Pendiente |

## Decisión pendiente del usuario

**Exenciones de la suposición A10** (`06-05-SUMMARY.md`). Tres mutaciones no figuran en D-06 y se declararon exentas con motivo: `presence` (latido de la pestaña visible), `verification/password` (es la propia verificación y exige sesión) y `DELETE push` (baja de la suscripción del propio navegador). Esta auditoría no las confirma ni las rechaza. La matriz de `tests/sensitive-actions.test.ts` verifica cada una con la política declarada, de modo que, si el usuario decide protegerlas, el cambio es la entrada del manifiesto y la misma matriz la comprueba.

---

## Limitaciones conocidas

- **`pnpm lint` a secas:** falla solo por los directorios de herramienta no versionados (`.agents/`, `.claude/`, `.codex/`, `.opencode/`), que ESLint recorre porque `eslint.config.mjs` no los ignora (`deferred-items.md`). `pnpm lint src tests` sale 0.
- **Agente Python:** la fase no cambió `agent/`, por lo que no se ejecutó `pnpm test:agent`. La alineación del tope de 64 KiB con `MAX_REQUEST_BYTES` se vigila desde `tests/api-deployment-settings.test.ts`.

---

## Evidencia de la auditoría

| Comando | Resultado |
|---------|-----------|
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 55 archivos, 824 tests pasados, 0 omitidos (817 antes de la auditoría) |
| `pnpm typecheck` | exit 0 |
| `pnpm lint src tests` | exit 0 |
| `pnpm build` | exit 0, desde `.next` borrado |
| `CI=1 pnpm test:e2e` | 79 de 79 pasados (1,8 min) |
| `CI=1 pnpm test:e2e` con los ocho ficheros de la fase en una invocación | 60 de 60 pasados |
| `CI=1 pnpm test:e2e` con CSP, `sensitive-action`, `maintenance-workflows`, `files-apps` y `hosts` | 35 de 35 pasados |
| Pruebas de mutación de las seis brechas | Cada prueba nueva falla ante su mutación; `git diff -- src agent` vacío tras restaurar |

---

## Cierre de la validación

- [x] Todas las tareas tienen verificación `<automated>` o dependen de la Ola 0
- [x] Continuidad del muestreo: nunca tres tareas seguidas sin verificación automática
- [x] La Ola 0 cubre todas las referencias MISSING
- [x] Sin modo watch
- [x] Latencia de respuesta por debajo de 120 s
- [x] `nyquist_compliant: true` en el frontmatter

**Aprobación:** approved 2026-11-27 como cumplimiento Nyquist de SEC-01, SEC-02 y SEC-04. No cierra las comprobaciones de entorno, los casos manuales de revisión ni la decisión sobre A10, que siguen pendientes.

## Validation Audit 2026-11-27

| Metric | Count |
|---|---|
| Gaps found | 6 |
| Resolved | 6 |
| Escalated | 0 |
