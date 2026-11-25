---
phase: "02"
slug: "incidencias-y-entrega-nica"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-24"
validated: "2026-11-25"
---

# Fase 2 · Estrategia de validación

> Contrato de validación de la fase completa. Todos los requisitos de la fase tienen verificación automatizada; las comprobaciones que dependen de un proveedor real, de la bandeja del sistema operativo o de una operación sobre la base de producción quedan registradas como casos manuales de despliegue.

## Infraestructura

| Propiedad | Valor |
|---|---|
| **Framework** | Vitest 5.1 y Playwright 1.65 |
| **Configuración** | `vitest.config.ts` y `playwright.config.ts` |
| **PostgreSQL** | PostgreSQL 18.7 desechable; `tests/database.ts` solo admite loopback y `HUB_REQUIRE_TEST_DB=1` convierte la ausencia de base en fallo |
| **Comando rápido** | `HUB_REQUIRE_TEST_DB=1 pnpm test <archivos>` |
| **Suite completa** | `HUB_REQUIRE_TEST_DB=1 pnpm test` |
| **E2E de la fase** | `pnpm build && pnpm exec playwright test tests/e2e/incidents.spec.ts` |
| **Estáticos** | `pnpm typecheck`, `pnpm lint <archivos>` y `pnpm build` |
| **Duración observada** | ~8–11 s para 41 archivos / 422 tests de Vitest; ~50 s para los 3 E2E de incidencias |

## Frecuencia

- **Tras cada tarea:** ejecutar su comando focalizado con PostgreSQL local.
- **Tras cada plan:** `HUB_REQUIRE_TEST_DB=1 pnpm test` y `pnpm typecheck`.
- **Antes de verificar la fase:** suite completa verde, `pnpm build` y los E2E de incidencias.
- **Antes del despliegue:** completar los casos manuales de Telegram, PWA y operación de migración/reversa.
- **Latencia máxima de feedback:** ~15 s para Vitest; ~2 min incluyendo build y E2E.

## Mapa de verificación por tarea

| Task ID | Plan | Wave | Requisito | Threat Ref | Comportamiento seguro | Tipo | Comando automatizado | ¿Existe? | Estado |
|---|---|---|---|---|---|---|---|---|---|
| 02-01-01 | 01 | 1 | INCD-01 | T-02-01 / T-02-03 | El backfill conserva IDs, cierra duplicados con marca sintética y no crea trabajo saliente | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | ✅ | ✅ green |
| 02-01-02 | 01 | 1 | INCD-01, INCD-02, INCD-05 | T-02-02 | Episodio, evento y outbox se confirman o revierten juntos; concurrencia arbitrada por el índice parcial | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-store.test.ts tests/collector-alerts.test.ts tests/api-events.test.ts tests/api-lifecycle.test.ts` | ✅ | ✅ green |
| 02-01-03 | 01 | 1 | INCD-01, INCD-05 | T-02-01 | La reversa rechaza un journal incompatible y el re-avance conserva identidad sin trabajo de notificación | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 02-02-01 | 02 | 2 | CONT-01, INCD-04 | T-02-04 | Un 200 inválido no escribe muestras ni abre, cambia o resuelve incidencias | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/agent-client.test.ts tests/collector-alerts.test.ts tests/api-hosts.test.ts` | ✅ | ✅ green |
| 02-02-02 | 02 | 2 | CONT-01, INCD-04 | T-02-04 | Sin evidencia válida no hay transición sana; la escalada conserva el episodio y aplica la política auditada | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/agent-client.test.ts tests/collector-alerts.test.ts tests/maintenance-alerts.test.ts tests/api-maintenance.test.ts tests/api-deployments.test.ts tests/events.test.ts` | ✅ | ✅ green |
| 02-03-01 | 03 | 3 | SEC-03 | T-02-05 / T-02-06 | El preflight de la app usa la precedencia real de Next y termina antes de `next start` con configuración inválida | integración | `pnpm test tests/runtime-config.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 02-03-02 | 03 | 3 | SEC-03 | T-02-05 / T-02-06 | El worker falla antes de `pool.connect`; Telegram/VAPID son grupos completos y los diagnósticos no revelan valores | integración | `pnpm test tests/runtime-config.test.ts && pnpm typecheck && pnpm build` | ✅ | ✅ green |
| 02-04-01 | 04 | 4 | INCD-02, INCD-05, INCD-06, BOT-01 | T-02-07 / T-02-08 | Solo el dueño del lock reclama y confirma un envío; el mensaje guarda chat y `message_id` reales | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` | ✅ | ✅ green |
| 02-04-02 | 04 | 4 | INCD-02, INCD-03, INCD-04, INCD-06, INCD-07, BOT-01 | T-02-07 / T-02-10 | 429 durable, 400/403/404 terminales, edición del mensaje original y canal comprometido sin segundo envío | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` | ✅ | ✅ green |
| 02-05-01 | 05 | 5 | INCD-04, INCD-08, BOT-03 | T-02-09 / T-02-11 | El enlace exige sesión y la pareja exacta host/ID; la proyección no expone datos del transporte | integración + e2e | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts && pnpm build && pnpm exec playwright test tests/e2e/incidents.spec.ts` | ✅ | ✅ green |
| 02-05-02 | 05 | 5 | INCD-04, INCD-08, BOT-03 | T-02-09 / T-02-11 | El reemplazo local exige revisión anterior y la prueba push encola para el propietario de la sesión | unidad + integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-push.test.ts tests/api-incidents.test.ts tests/service-worker.test.ts && pnpm typecheck` | ✅ | ✅ green |

*Estado: ⬜ pendiente · ✅ green · ❌ red · ⚠️ inestable*

## Cobertura por requisito y decisión

| Requisito / decisión | Evidencia automatizada | Estado |
|---|---|---|
| INCD-01 | `tests/migrations.test.ts` (identidad, backfill silencioso, journal) y `tests/incident-store.test.ts` (fingerprint entre episodios) | ✅ COVERED |
| INCD-02 | `tests/incident-store.test.ts` (carrera y unicidad), `tests/collector-alerts.test.ts` (un episodio y un aviso) y `tests/notification-dispatch.test.ts` (sin segundo envío) | ✅ COVERED |
| INCD-03 | `tests/notification-dispatch.test.ts` (edición por seq, cierre antes del envío) y `tests/telegram.test.ts` (`editMessageText`) | ✅ COVERED |
| INCD-04 | `tests/collector-alerts.test.ts` (escalada y downshift), `tests/maintenance-alerts.test.ts` (política), `tests/notification-dispatch.test.ts` (canal push comprometido) y `tests/incident-push.test.ts` (reemplazo local) | ✅ COVERED |
| INCD-05 | `tests/incident-store.test.ts` (rollback del outbox), `tests/migrations.test.ts` (sin trabajo tras el re-avance) y `tests/notification-dispatch.test.ts` (resultado durable) | ✅ COVERED |
| INCD-06 | `tests/notification-dispatch.test.ts` (dos sesiones reales compitiendo por el lock y lease sin inicio) | ✅ COVERED |
| INCD-07 | `tests/notification-dispatch.test.ts` (429 tras reinicio y 400/403/404 con fallback único) y `tests/telegram.test.ts` (clasificación) | ✅ COVERED |
| INCD-08 | `tests/api-incidents.test.ts` (proyección finita, sin destinos) y `tests/e2e/incidents.spec.ts` (estado visible en la vista) | ✅ COVERED |
| BOT-01 | `tests/notification-dispatch.test.ts` (chat configurado) y `tests/telegram.test.ts` (cliente saliente) | ✅ COVERED |
| BOT-03 | `tests/telegram.test.ts` (`incidentHref` sin credenciales), `tests/e2e/incidents.spec.ts` (correo, passkey y sesión expirada) y `tests/service-worker.test.ts` (apertura validada desde el aviso) | ✅ COVERED |
| SEC-03 | `tests/runtime-config.test.ts` (app, worker, precedencia, valores de ejemplo y secretos en diagnóstico) | ✅ COVERED |
| CONT-01 | `tests/agent-client.test.ts` (contratos de los tres endpoints) y `tests/collector-alerts.test.ts` / `tests/maintenance-alerts.test.ts` (payload inválido no transiciona) | ✅ COVERED |
| D-01 | `tests/notification-dispatch.test.ts` (lease sin inicio, lease iniciado e intento ambiguo) | ✅ COVERED |
| D-02 | `tests/notification-dispatch.test.ts` y `tests/telegram.test.ts` (429, 400/403/404 y fallback) | ✅ COVERED |
| D-03 | `tests/migrations.test.ts` y `tests/incident-store.test.ts` (heredados silenciosos) | ✅ COVERED |
| D-04 | `tests/collector-alerts.test.ts` (watch→fail, downshift, push y silencio) | ✅ COVERED |
| D-05 | `tests/notification-dispatch.test.ts`, `tests/incident-push.test.ts` y `tests/service-worker.test.ts` (etiqueta, revisión y reemplazo) | ✅ COVERED |
| D-06 | `tests/notification-dispatch.test.ts` y `tests/telegram.test.ts` (edición por seq sin segundo `sendMessage`) | ✅ COVERED |

## Wave 0

No se necesita una ola 0 propia: la infraestructura de Vitest, PostgreSQL desechable y Playwright ya existía y `tests/database.ts` se reforzó en 02-01 con `HUB_REQUIRE_TEST_DB=1`.

## Casos manuales

| Caso | Requisito | Por qué manual | Instrucciones |
|---|---|---|---|
| Telegram real con bot y chat de prueba | BOT-01, INCD-03, INCD-06 | El repositorio no tiene credenciales reales ni contacta `api.telegram.org`; el transporte se prueba con `fetch` inyectado | Configurar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en el entorno del worker. Provocar una apertura, una escalada y un cierre. Confirmar que llega un solo mensaje y que escalada y cierre editan ese mismo mensaje, con el botón al episodio. |
| Bandeja de la PWA en iOS | INCD-04, D-05 | `getNotifications`/`showNotification` reales dependen del sistema operativo; la lógica se prueba con una superficie inyectada y el service worker con un `self` simulado | Con el hub visible y un aviso presente, escalar la incidencia y comprobar que no se vuelve a notificar. Repetir después de descartar el aviso y comprobar que no reaparece. Si el dispositivo no soporta la API, confirmar que el cambio queda visible en el hub. |
| Despliegue y reversa sobre la base real | SEC-03, INCD-01 | Exige parar app y worker, hacer una copia restaurable y operar sobre PostgreSQL de producción; el ensayo 0003 → 0004 → reversa → 0004 sí está automatizado | Seguir `README.md` y las notas de 02-01-SUMMARY: recuentos de preflight, parada de servicios, `pnpm db:migrate`, comprobación de identidad y reversa con archivo previo de `notification_outbox` e `incident_events` si hubo actividad. |
| Ajustes distingue cola de entrega | BOT-03 | Es texto de interfaz; el estándar de tests prohíbe acoplarse al copy | Abrir Ajustes, lanzar la prueba push y comprobar que el mensaje distingue «en cola» de «entregado» y que el estado del hub lo refleja. |

## Cierre

- [x] Todas las tareas tienen verificación automatizada y las 11 filas del mapa están en verde.
- [x] Continuidad de muestreo: ninguna tarea de la fase carece de comando automatizado.
- [x] La infraestructura existente cubre la fase; no hay referencias MISSING de una ola 0.
- [x] No se usan modos `watch` en los comandos de verificación.
- [x] La latencia de feedback es menor de 15 s para Vitest y ~2 min incluyendo build y E2E.
- [x] `nyquist_compliant: true` en el frontmatter.

**Aprobación:** approved 2026-11-25

## Validation Audit 2026-11-25

| Metric | Count |
|---|---|
| Gaps found | 1 |
| Resolved | 1 |
| Escalated | 0 |
