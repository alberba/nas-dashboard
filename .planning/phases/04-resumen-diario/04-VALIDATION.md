---
phase: "04"
slug: resumen-diario
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-26"
---

# Fase 4 · Estrategia de validación

## Infraestructura de pruebas

| Comprobación | Entorno |
| --- | --- |
| Vitest | `pnpm test`, configuración de Vitest del repositorio. |
| PostgreSQL | PostgreSQL 18 desechable de loopback, `DATABASE_URL` de pruebas y `HUB_REQUIRE_TEST_DB=1` para impedir omisiones. |
| Agente | `pnpm test:agent` con la versión de Python de CI. |
| Navegador | `pnpm test:e2e tests/e2e/incidents.spec.ts` con Chromium, build actual y base de CI desechable migrada. |
| Probes | Docker y Compose desechables. Cliente Telegram simulado, sin secretos ni volúmenes operativos. |

La [investigación](04-RESEARCH.md#validation-architecture) registra 16 pruebas de calendario y Telegram aprobadas antes de implementar la fase. Las pruebas de fase se ejecutarán en las olas siguientes.

## Frecuencia

- Tras cada tarea ejecuta su comando focalizado. Registra el tiempo y el número de casos que corrieron.
- Tras cada ola ejecuta sus suites focalizadas y `pnpm typecheck` y `pnpm lint`. Confirma que PostgreSQL no omitió casos.
- Antes de verificar la fase ejecuta `HUB_REQUIRE_TEST_DB=1 pnpm test`, `pnpm test:agent`, `pnpm typecheck`, `pnpm lint`, `pnpm build` y el recorrido Playwright. Guarda la evidencia de las sondas reales.

## Matriz de verificación por tarea

| Tarea | Plan | Ola | Requisito | Amenaza | Evidencia | Tipo | Comando | Archivo de prueba | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 04-01-01 | 01 | 1 | DIG-01, DIG-05 | T-04-01 | Primera entrega y enlace, continuidad de la migración, takeover con y sin intento y commit que cruza el vencimiento sin invocar el transporte. | Integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/notification-dispatch.test.ts` | Existe | Pendiente |
| 04-01-02 | 01 | 1 | DIG-01, DIG-02, DIG-05 | T-04-01, T-04-02 | Hora normal y configurable, salto y solapamiento, medianoche, cambio de configuración y dos horas exactas. | Unidad e integración | `TZ=Pacific/Honolulu HUB_REQUIRE_TEST_DB=1 pnpm test tests/madrid-day.test.ts tests/runtime-config.test.ts tests/notification-dispatch.test.ts && pnpm typecheck` | Existe | Pendiente |
| 04-01-03 | 01 | 1 | DIG-01, DIG-05 | T-04-02 | Cooldown compartido, 429 confirmado antes y después de encolar, push durante la pausa y texto congelado. | Integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` | Existe | Pendiente |
| 04-02-01 | 02 | 2 | DIG-03, DIG-04 | T-04-03, T-04-04 | Cohortes, límites, contadores, elegibilidad durable, solo pie, vacío y continuidad de entrega individual. | Integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts` | Existe | Pendiente |
| 04-02-02 | 02 | 2 | DIG-03, DIG-06 | T-04-03, T-04-04 | Pie y +N dentro de 4096, Unicode, orden estable y texto íntegro al repetir. | Unidad e integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts && pnpm typecheck` | Existe | Pendiente |
| 04-03-01 | 03 | 3 | CONT-03 | T-04-05 | Fallido, vencido, incierto, acceso autenticado, estado global, log acotado y respuesta sin datos privados. | Integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts tests/notification-dispatch.test.ts` | Existe | Pendiente |
| 04-03-02 | 03 | 3 | CONT-03 | T-04-06 | Marca vieja con proceso vivo, marca reciente con PID reutilizado, idle real, corrupción, pérdida de lock y recuperación. | Unidad e integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts && pnpm typecheck` | Existe | Pendiente |
| 04-03-03 | 03 | 3 | CONT-03 | T-04-06, T-04-07 | Lock ocupado en otra hebra, pérdida de progreso, PID reutilizado, probe local y retorno a healthy. | Unidad e integración | `pnpm test:agent` | Existe | Pendiente |

## Ola 0

La infraestructura y las suites invocadas existen. Cada tarea añade los casos que cubre a esas suites en la misma unidad de ejecución. El runner de migración cubre base nueva y el cambio de 0005 a 0006 antes de que el trabajador se ejecute en una base migrada. El script nuevo de salud se prueba después de crearlo en 04-03-02.

## Comprobaciones de entorno

| Comportamiento | Requisito | Ejecución |
| --- | --- | --- |
| El worker vivo pierde la señal de progreso | CONT-03 | Construye la imagen y ejecuta Compose en entorno aislado. Espera a healthy, interrumpe el progreso sin eliminar el proceso y observa unhealthy. Reanuda y observa healthy. |
| Los dos servicios de agente heredan la sonda | CONT-03 | Comprueba la imagen desde ambos Compose. Valida la transición con el proceso vivo y el mismo LOCK ocupado en configuración desechable. Suelta el lock y verifica la recuperación. La suite simula además una marca reciente con PID reutilizado. |
| La explicación del resumen es legible y global | CONT-03 | Ejecuta `pnpm test:e2e tests/e2e/incidents.spec.ts` con resultado sembrado y datos de dos hosts. Revisa manualmente la distinción entre fallo e incertidumbre sin exigir coincidencia literal del texto en tests. |

## Cierre de la validación

- [ ] Todos los comandos focalizados ejecutados y resultados registrados.
- [ ] Validación del calendario con TZ ajena a Madrid y el Node 26 de CI.
- [ ] Migración y persistencia verificadas con PostgreSQL 18.
- [ ] Playwright y los probes en Docker registrados con evidencia.
- [ ] Frecuencia observada y cumplimiento Nyquist revisados al cerrar la fase.

**Aprobación** Pendiente.
