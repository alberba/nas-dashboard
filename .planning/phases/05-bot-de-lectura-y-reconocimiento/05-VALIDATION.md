---
phase: "05"
slug: bot-de-lectura-y-reconocimiento
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-26"
---

# Fase 5 · Estrategia de validación

## Infraestructura de pruebas

| Comprobación | Entorno |
| --- | --- |
| Vitest | Vitest 5.1.0 (`tests/**/*.test.ts`) con `vitest.config.ts` y el alias `@` a `src`. |
| PostgreSQL | PostgreSQL 18 desechable de loopback (`postgres:18` en Docker, como en CI), `DATABASE_URL` de pruebas y `HUB_REQUIRE_TEST_DB=1` para impedir omisiones. No hay base local configurada. |
| Bot API simulada | `tests/telegram-fake.ts` (ola 0): cola de updates con confirmación por `offset`, `allowed_updates`, `deleteWebhook`, 429 con `retry_after` y captura de cada petición. Sin token ni red reales. |
| Navegador | `pnpm test:e2e tests/e2e/incidents.spec.ts` para el estado y las acciones de Avisos, con atributos `data-*` en lugar de copy. |
| Node | Local v24.22.3. CI y la imagen usan Node 26, y la suite de redacción corre también ahí. |

La [investigación](05-RESEARCH.md#validation-architecture) registra 20 pruebas de `tests/telegram.test.ts` aprobadas antes de implementar la fase. Las pruebas de fase se ejecutarán en las olas siguientes.

## Frecuencia

- Tras cada tarea ejecuta su comando focalizado. Sin base de datos: `pnpm test tests/telegram.test.ts tests/telegram-updates.test.ts`.
- Tras cada ola ejecuta `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts tests/incident-actions.test.ts tests/api-incidents.test.ts tests/migrations.test.ts`, más `pnpm typecheck` y `pnpm lint`. Confirma que PostgreSQL no omitió casos.
- Antes de verificar la fase ejecuta `HUB_REQUIRE_TEST_DB=1 pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, la suite de redacción bajo Node 26 y el recorrido Playwright de Avisos.

## Matriz de verificación por tarea

Una fila por tarea de los seis PLAN.md (05-06 ejecuta en la ola 2). Todas se ejecutan con PostgreSQL 18 desechable y `HUB_REQUIRE_TEST_DB=1`, salvo la prueba de Avisos, que además necesita el build, la base migrada y Chromium.

| Plan | Tarea | Requisitos | Prueba | Comando |
| --- | --- | --- | --- | --- |
| 05-01 | 1 (tracer) | BOT-02, BOT-04, BOT-06, BOT-10 | `tests/telegram-updates.test.ts`, `tests/telegram.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-updates.test.ts tests/telegram.test.ts tests/incident-store.test.ts tests/notification-dispatch.test.ts && pnpm typecheck` |
| 05-01 | 2 | BOT-04 | `tests/madrid-day.test.ts`, `tests/telegram-updates.test.ts` | `TZ=Pacific/Honolulu HUB_REQUIRE_TEST_DB=1 pnpm test tests/madrid-day.test.ts tests/telegram-updates.test.ts tests/notification-dispatch.test.ts && pnpm typecheck` |
| 05-02 | 1 | BOT-04, BOT-06 | `tests/incident-snooze.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-snooze.test.ts tests/telegram-updates.test.ts && pnpm typecheck` |
| 05-02 | 2 | BOT-04 | `tests/snooze-delivery.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/snooze-delivery.test.ts tests/incident-store.test.ts tests/notification-dispatch.test.ts tests/incident-push.test.ts && pnpm typecheck` |
| 05-03 | 1 | BOT-05, BOT-06 | `tests/incident-why.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-why.test.ts tests/incident-snooze.test.ts tests/telegram-updates.test.ts && pnpm typecheck` |
| 05-03 | 2 | BOT-05, BOT-06 | `tests/incident-why.test.ts`, `tests/telegram.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-why.test.ts tests/telegram.test.ts tests/notification-dispatch.test.ts tests/snooze-delivery.test.ts && pnpm typecheck` |
| 05-04 | 1 | BOT-04 | `tests/api-incidents.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts tests/incident-store.test.ts && pnpm typecheck` |
| 05-04 | 2 | BOT-04 | `tests/e2e/incidents.spec.ts` | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/incidents.spec.ts` |
| 05-04 | 3 | BOT-04 | `tests/digest-ack-labels.test.ts` | `TZ=Pacific/Honolulu HUB_REQUIRE_TEST_DB=1 pnpm test tests/digest-ack-labels.test.ts tests/notification-dispatch.test.ts tests/telegram.test.ts && pnpm typecheck` |
| 05-05 | 1 | BOT-06 | `tests/telegram-lane-hardening.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-lane-hardening.test.ts tests/telegram-updates.test.ts && pnpm typecheck` más el recuento de `cleanupTelegramState` en `src/worker.ts` |
| 05-05 | 2 | BOT-02, BOT-06 | `tests/telegram-contract.test.ts`, `tests/telegram-replays.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-contract.test.ts tests/telegram-replays.test.ts tests/telegram-updates.test.ts tests/incident-actions.test.ts && pnpm typecheck` |
| 05-05 | 3 | BOT-10 | `tests/telegram-redaction.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-redaction.test.ts tests/telegram.test.ts && pnpm typecheck && pnpm lint`, más la comprobación manual con el bot real |
| 05-06 | 1 | BOT-04, BOT-06 | `tests/incident-actions.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-actions.test.ts tests/telegram-updates.test.ts && pnpm typecheck` |
| 05-06 | 2 | BOT-04 | `tests/migrations.test.ts` | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts && pnpm typecheck` |

## Ola 0

- [ ] `tests/telegram-fake.ts`: Bot API simulada con confirmación por `offset`, `allowed_updates`, `deleteWebhook`, 429 con `retry_after` y captura de peticiones. Hace posibles las pruebas de reinicio, replay y redacción.
- [ ] `tests/telegram-updates.test.ts`: contrato del `Update` (accesible, inaccesible con `date: 0`, `inline_message_id`, texto, tipo desconocido, campos extra y tipos erróneos), allowlist y carril de polling.
- [ ] `tests/incident-actions.test.ts` (plan 05-06, ola 2): idempotencia de reconocer, política de entrega (D-02), medición (D-05) y razones de `consumeActionToken` (BOT-04, BOT-06). Silenciar y quitar el silencio los prueba `tests/incident-snooze.test.ts` (05-02) y la persistencia tras reinicio y los replays, `tests/telegram-replays.test.ts` (05-05).
- [ ] `tests/incident-why.test.ts`: una respuesta por estado del aviso (BOT-05).
- [ ] `drizzle/0007_*.sql` con su snapshot y su journal, generados con `drizzle-kit` antes de las pruebas de integración.
- Sin dependencias nuevas que instalar.

## Comprobaciones de entorno

| Comportamiento | Requisito | Ejecución |
| --- | --- | --- |
| Los cuatro botones con el bot real | BOT-04, BOT-05 | En UAT, pulsa Silenciar, Quitar silencio, Reconocer y "Por qué me llegó esto" en un aviso real. Comprueba que la edición del mensaje no notifica y que el estado persiste tras reiniciar el worker. |
| Un solo consumidor del token | BOT-02 | Antes de activar el carril en producción, comprueba en el repositorio `media-stack` que no llama a `getUpdates` ni configura un webhook con el mismo token. |
| Redacción bajo Node 26 | BOT-10 | Ejecuta la suite de redacción en la matriz de CI con Node 26. |

## Cierre de la validación

- [ ] Todos los comandos focalizados ejecutados y resultados registrados.
- [ ] Migración `0007` y persistencia verificadas con PostgreSQL 18.
- [ ] Redacción del token verificada también con Node 26.
- [ ] Playwright de Avisos y verificación manual con el bot real registrados con evidencia.
- [ ] Frecuencia observada y cumplimiento Nyquist revisados al cerrar la fase.

**Aprobación** Pendiente.
