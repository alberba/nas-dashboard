---
phase: "02"
slug: "incidencias-y-entrega-nica"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-24"
---

# Fase 2 · Estrategia de validación

## Infraestructura

Vitest con `vitest.config.ts`, PostgreSQL 18 desechable mediante `tests/database.ts`, y Playwright con `playwright.config.ts`. Las verificaciones que dependen de PostgreSQL requieren un `DATABASE_URL` local y deben fallar si la suite omite los casos de base de datos. La CI usa su propio servicio PostgreSQL.

## Frecuencia

- Tras cada tarea, ejecutar su comando focalizado. Los archivos nuevos se crean en la tarea que los verifica.
- Tras cada plan, ejecutar `pnpm typecheck && pnpm test` con PostgreSQL local. Tras el plan de navegación, ejecutar también INC-E2E-01, INC-E2E-02 e INC-E2E-03.
- Antes de verificar la fase, ejecutar los checks de CI aplicables y revisar los casos físicos de Web Push y Telegram con un chat de prueba.

## Evidencia por comportamiento

| Plan | Requisitos y decisiones | Comando focalizado | Señal de fallo |
|---|---|---|---|
| 02-01 | INCD-01, INCD-02, INCD-05, D-03 | `pnpm test tests/migrations.test.ts tests/incident-store.test.ts tests/api-lifecycle.test.ts` | Se pierden filas o claves, se envía por el backfill, aparecen dos abiertas o un rollback deja eventos u outbox huérfanos. |
| 02-02 | CONT-01, INCD-04, D-04 | `pnpm test tests/agent-client.test.ts tests/collector-alerts.test.ts tests/maintenance-alerts.test.ts` | Una respuesta inválida abre o cierra incidencias, escribe métricas inválidas o se pierde la escalada con una observación válida. |
| 02-03 | SEC-03 | `pnpm test tests/runtime-config.test.ts` | App o worker arrancan con credenciales de ejemplo o con configuración obligatoria incompleta. |
| 02-04 | INCD-02, INCD-03, INCD-05–08, BOT-01, D-01, D-02, D-06 | `pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` | Dos workers envían, se reenvía un intento incierto, se ignora el plazo 429 o una edición crea otro mensaje. |
| 02-05 | INCD-04, D-05 | `pnpm test tests/incident-push.test.ts` | Se envía Telegram por una escalada ya entregada por push, se renotifica o se muestra un aviso descartado. |
| 02-05 | INCD-08, BOT-03 | `pnpm test tests/api-incidents.test.ts` y `pnpm exec playwright test tests/e2e/incidents.spec.ts` | El acceso sin sesión devuelve datos, se pierde el destino al autenticarse por correo o passkey o al renovar una sesión caducada, falta el motivo de entrega, o una parada confirmada elude la transición del store. |

## Casos manuales

| Caso | Evidencia |
|---|---|
| Telegram con un bot y chat de prueba | Una apertura llega con el enlace correcto. Una escalada y un cierre editan el mismo mensaje. |
| PWA en iOS con el aviso presente y después de descartarlo | Con el hub activo, el aviso presente se actualiza en silencio. Un aviso descartado no reaparece. Si el cliente carece de soporte, el cambio queda visible en el hub. |

## Cierre

Durante la ejecución, confirmar que cada tarea tiene una comprobación automatizada, registrar las suites ejecutadas sin omisiones y anotar resultados de dispositivo y chat de prueba. La validación queda pendiente hasta reunir esa evidencia.
