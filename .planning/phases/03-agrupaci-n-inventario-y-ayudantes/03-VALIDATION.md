---
phase: "03"
slug: agrupaci-n-inventario-y-ayudantes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-25"
---

# Fase 3 · Estrategia de validación

## Infraestructura de pruebas

| Elemento | Valor |
| --- | --- |
| TypeScript | Vitest mediante `pnpm test`; suites `tests/*.test.ts`. |
| Agente | `unittest` mediante `pnpm test:agent`; Docker se simula con el cliente inyectable. |
| Integración | `DATABASE_URL` de PostgreSQL 18 de loopback con permiso para crear bases desechables, más `HUB_REQUIRE_TEST_DB=1`. |
| Navegador | Playwright con base local dedicada, variables de CI, migración aplicada, build actual y Chromium. |
| Comprobación rápida | Comando focalizado de cada tarea. |
| Suites completas | `pnpm typecheck`, `pnpm lint`, `HUB_REQUIRE_TEST_DB=1 pnpm test`, `pnpm test:agent` y `pnpm build`. |

Las pruebas de migración usan `scripts/migrate.ts` desde la versión anterior en una base temporal. Para Playwright se ejecuta `pnpm db:migrate` sobre la base de pruebas dedicada antes del build, siguiendo `.github/workflows/ci.yml`. Telegram y Docker se simulan en las pruebas que afectarían recursos externos o privilegiados.

## Frecuencia

- Tras cada tarea ejecuta su comando focalizado y registra los casos que corrieron. Mide el tiempo de la primera ejecución para fijar la latencia real de respuesta.
- Tras cada ola ejecuta las suites de los límites que cambió y la prueba de navegador de ese plan. Los comandos de PostgreSQL fallan si falta la base admisible.
- Antes de verificar la fase ejecuta las suites completas, confirma que no hubo omisiones de PostgreSQL y conserva los resultados de los recorridos de navegador.

## Matriz de verificación por tarea

| Tarea | Ola | Requisito y decisiones | Amenazas | Evidencia | Comando automatizado | Archivos base | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03-01-01 | 1 | INCD-09, D-01 | T-03-02, T-03-03 | Migración aditiva, una apertura, enlace autenticado y payload sin inventario. La sonda manual de la tarea verifica la fecha de caché del agente. | `python3 -m unittest discover -s agent -p test_metrics.py && HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/collector-alerts.test.ts tests/api-incidents.test.ts tests/notification-dispatch.test.ts tests/agent-client.test.ts` | Existentes | Pendiente |
| 03-01-02 | 1 | INCD-09, D-02 | T-03-01, T-03-02 | Inhibición durable visible con motivo, entrega original e independencia entre hosts. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts` | Existentes | Pendiente |
| 03-01-03 | 1 | INCD-09, D-03, D-04 | T-03-01 | Ventana nueva, caché y datos inválidos, reanudación y cierre sin aviso nuevo. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/notification-dispatch.test.ts && pnpm typecheck` | Existentes | Pendiente |
| 03-02-01 | 2 | INCD-10, D-05, D-06 | T-03-04 | Ausencia, reaparición, umbral, lista válida vacía, estado visible y cierre con historial. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-incidents.test.ts` | Existentes | Pendiente |
| 03-02-02 | 2 | INCD-10, D-07, D-08 | T-03-04 | Reemplazo único, nombre anterior reutilizado, reinicio de ventana por ausencia, ambigüedad, ID y entrega conservados. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts` | Existentes | Pendiente |
| 03-02-03 | 2 | INCD-10, D-05 a D-08 | T-03-05 | Confirmación directa y diferida con inventario posterior a la operación, rechazo de caché anterior, mutaciones concurrentes de vigilancia, cierre atómico y aislamiento de hosts. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-incidents.test.ts tests/api-lifecycle.test.ts && pnpm typecheck` | Existentes | Pendiente |
| 03-03-01 | 3 | CONT-04, D-09 a D-11 | T-03-06 a T-03-08 | Sigue el contador de intentos reales. Estado de Mantenimiento e incidencia con política de resumen. | `python3 -m unittest discover -s agent -p test_maintenance.py && HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-maintenance.test.ts tests/maintenance-alerts.test.ts tests/agent-client.test.ts` | Existentes | Pendiente |
| 03-03-02 | 3 | CONT-04, D-09 | T-03-06 | Identidad demostrable, lista de candidatos, exclusiones, recolección y preservación de volúmenes. | `pnpm test:agent` | Existentes | Pendiente |
| 03-03-03 | 3 | CONT-04, D-10 a D-12 | T-03-07, T-03-08 | Cierre acreditado de varios pendientes, fallo de listado, reinicio y compatibilidad. | `pnpm test:agent && HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/maintenance-alerts.test.ts tests/agent-client.test.ts tests/api-maintenance.test.ts && pnpm typecheck` | Existentes | Pendiente |

## Ola 0

La infraestructura existe en el repositorio. Las tareas amplían suites existentes. Ejecutar cada ola con PostgreSQL 18 y las dependencias Python y Node del proyecto. Instalar Chromium mediante el comando de CI cuando no esté disponible.

## Recorridos de navegador y revisión manual

| Ola | Prueba automatizada | Revisión en el entorno local |
| --- | --- | --- |
| 1 | `pnpm test:e2e tests/e2e/incidents.spec.ts` | Abrir el enlace de una incidencia de caída tras autenticarse, confirmar la fecha de inventario y reconocer los episodios inhibidos. |
| 2 | `pnpm test:e2e tests/e2e/maintenance.spec.ts` | En Mantenimiento, comprobar que el nombre pendiente queda asociado al host y carece de acciones Docker. |
| 3 | `pnpm test:e2e tests/e2e/maintenance-status.spec.ts` | Confirmar que el estado de limpieza se distingue de otras secciones y cambia al seleccionar otro host. |

Si se valida el ciclo con un Docker real, usar un entorno desechable con ayudantes de prueba y conservar en el resumen la evidencia de propiedad y protección. Las suites mockeadas verifican los casos de borrado y los límites de selección.

## Cierre de la validación

- [ ] Comandos focalizados ejecutados y evidencia registrada por tarea.
- [ ] PostgreSQL 18 verifica migración y transacciones sin omitir casos.
- [ ] Recorridos Playwright ejecutados con build y migración vigentes.
- [ ] Tiempos medidos y resultados recogidos en los resúmenes.
- [ ] `nyquist_compliant` actualizado cuando haya evidencia de validación.

**Aprobación** Pendiente.
