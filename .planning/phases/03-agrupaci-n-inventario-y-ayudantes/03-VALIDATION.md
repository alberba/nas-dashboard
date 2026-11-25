---
phase: "03"
slug: agrupaci-n-inventario-y-ayudantes
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-25"
validated: "2026-11-25"
---

# Fase 3 · Estrategia de validación

> Contrato de validación de la fase completa. INCD-09, INCD-10 y CONT-04 tienen verificación automatizada y en verde; las comprobaciones que exigen Docker real o revisión de copy quedan registradas como casos manuales de despliegue.

## Infraestructura de pruebas

| Elemento | Valor |
| --- | --- |
| TypeScript | Vitest 5.1 mediante `pnpm test`; suites `tests/*.test.ts`. |
| Agente | `unittest` mediante `pnpm test:agent`; Docker se simula con el cliente inyectable. |
| Integración | PostgreSQL 18 en `postgresql://hub:hub@127.0.0.1:55432/hub`, con `HUB_REQUIRE_TEST_DB=1` para convertir la ausencia de base en fallo. |
| Navegador | Playwright 1.65 con `CI=1`, base dedicada migrada, build actual y Chromium. |
| Comprobación rápida | Comando focalizado de cada tarea. |
| Suites completas | `pnpm typecheck`, `HUB_REQUIRE_TEST_DB=1 pnpm test`, `pnpm test:agent` y `pnpm build`. |
| E2E de la fase | `CI=1 pnpm test:e2e tests/e2e/incidents.spec.ts tests/e2e/maintenance.spec.ts tests/e2e/maintenance-status.spec.ts` |

Las pruebas de migración usan `scripts/migrate.ts` desde la versión anterior en una base temporal. Para Playwright se ejecuta `pnpm db:migrate` sobre la base de pruebas dedicada antes del build, siguiendo `.github/workflows/ci.yml`. Telegram y Docker se simulan en las pruebas que afectarían recursos externos o privilegiados.

## Frecuencia

- Tras cada tarea ejecuta su comando focalizado y registra los casos que corrieron. Mide el tiempo de la primera ejecución para fijar la latencia real de respuesta.
- Tras cada ola ejecuta las suites de los límites que cambió y la prueba de navegador de ese plan. Los comandos de PostgreSQL fallan si falta la base admisible.
- Antes de verificar la fase ejecuta las suites completas, confirma que no hubo omisiones de PostgreSQL y conserva los resultados de los recorridos de navegador.
- **Latencia observada:** ~10 s para la suite completa de Vitest; ~44 tests de `test_maintenance.py` en menos de 1 s; ~1–2 min para los 21 E2E con build y migración vigentes.

## Matriz de verificación por tarea

| Tarea | Ola | Requisito y decisiones | Amenazas | Evidencia | Comando automatizado | Archivos base | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 03-01-01 | 1 | INCD-09, D-01 | T-03-02, T-03-03 | Migración aditiva, una apertura, enlace autenticado y payload sin inventario. La sonda manual de la tarea verifica la fecha de caché del agente. | `python3 -m unittest discover -s agent -p test_metrics.py && HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/collector-alerts.test.ts tests/api-incidents.test.ts tests/notification-dispatch.test.ts tests/agent-client.test.ts` | ✅ | ✅ green |
| 03-01-02 | 1 | INCD-09, D-02 | T-03-01, T-03-02 | Inhibición durable visible con motivo, entrega original e independencia entre hosts. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts` | ✅ | ✅ green |
| 03-01-03 | 1 | INCD-09, D-03, D-04 | T-03-01 | Ventana nueva, caché y datos inválidos, reanudación y cierre sin aviso nuevo. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/notification-dispatch.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 03-02-01 | 2 | INCD-10, D-05, D-06 | T-03-04 | Ausencia, reaparición, umbral, lista válida vacía, estado visible y cierre con historial. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-incidents.test.ts` | ✅ | ✅ green |
| 03-02-02 | 2 | INCD-10, D-07, D-08 | T-03-04 | Reemplazo único, nombre anterior reutilizado, reinicio de ventana por ausencia, ambigüedad, ID y entrega conservados. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts` | ✅ | ✅ green |
| 03-02-03 | 2 | INCD-10, D-05 a D-08 | T-03-05 | Confirmación directa y diferida con inventario posterior a la operación, rechazo de caché anterior, mutaciones concurrentes de vigilancia, cierre atómico y aislamiento de hosts. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-incidents.test.ts tests/api-lifecycle.test.ts && pnpm typecheck` | ✅ | ✅ green |
| 03-03-01 | 3 | CONT-04, D-09 a D-11 | T-03-06 a T-03-08 | Sigue el contador de intentos reales. Estado de Mantenimiento e incidencia con política de resumen. | `python3 -m unittest discover -s agent -p test_maintenance.py && HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-maintenance.test.ts tests/maintenance-alerts.test.ts tests/agent-client.test.ts` | ✅ | ✅ green |
| 03-03-02 | 3 | CONT-04, D-09 | T-03-06 | Identidad demostrable, lista de candidatos, exclusiones, recolección y preservación de volúmenes. | `pnpm test:agent` | ✅ | ✅ green |
| 03-03-03 | 3 | CONT-04, D-10 a D-12 | T-03-07, T-03-08 | Cierre acreditado de varios pendientes, fallo de listado, reinicio y compatibilidad. | `pnpm test:agent && HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/maintenance-alerts.test.ts tests/agent-client.test.ts tests/api-maintenance.test.ts && pnpm typecheck` | ✅ | ✅ green |

*Estado: ⬜ pendiente · ✅ green · ❌ red · ⚠️ inestable*

Las 9 tareas tienen comando automatizado y referencias de prueba que existen en el repositorio. La suite completa (`41` archivos, `473` tests) y `test_maintenance.py` (`44` tests) pasaron sobre PostgreSQL 18 sin omisiones de base. `pnpm test:agent` cubre la suite Python (199 tests) con un error intermitente preexistente ajeno a la fase, detallado en Limitaciones conocidas.

## Cobertura por requisito

| Requisito | Evidencia automatizada | Estado |
| --- | --- | --- |
| INCD-09 | `tests/collector-alerts.test.ts` (grupo `services-down`, evidencia fresca, inhibición), `tests/migrations.test.ts` (0005 aditiva), `tests/api-incidents.test.ts` (proyección autenticada), `tests/notification-dispatch.test.ts` (payload sin inventario) y `tests/e2e/incidents.spec.ts` (detalle autenticado, 3/3) | ✅ COVERED |
| INCD-10 | `tests/collector-alerts.test.ts` (ausencia acreditada, reasignación, ambigüedad y carreras), `tests/api-incidents.test.ts` (overview, enlace y operaciones), `tests/api-lifecycle.test.ts` (aislamiento por host) y `tests/e2e/maintenance.spec.ts` (fila pendiente sin acciones Docker, 11/11) | ✅ COVERED |
| CONT-04 | `agent/test_maintenance.py` (propiedad, edades, reintento y resolución), `tests/collector-alerts.test.ts` (una incidencia digest), `tests/api-maintenance.test.ts` (contrato), `tests/maintenance-alerts.test.ts` (política) y `tests/e2e/maintenance-status.spec.ts` (estados clean/persistente/indeterminado, 7/7) | ✅ COVERED |

## Ola 0

No se necesita una ola 0 propia: Vitest, `unittest`, PostgreSQL desechable y Playwright ya existían. Las tareas ampliaron suites existentes; no hubo referencias MISSING ni infraestructura nueva.

## Recorridos de navegador y revisión manual

| Ola | Prueba automatizada | Resultado observado | Revisión en el entorno local |
| --- | --- | --- | --- |
| 1 | `pnpm test:e2e tests/e2e/incidents.spec.ts` | ✅ 3/3 | Abrir el enlace de una incidencia de caída tras autenticarse, confirmar la fecha de inventario y reconocer los episodios inhibidos. |
| 2 | `pnpm test:e2e tests/e2e/maintenance.spec.ts` | ✅ 11/11 | En Mantenimiento, comprobar que el nombre pendiente queda asociado al host y carece de acciones Docker. |
| 3 | `pnpm test:e2e tests/e2e/maintenance-status.spec.ts` | ✅ 7/7 | Confirmar que el estado de limpieza se distingue de otras secciones y cambia al seleccionar otro host. |

Los 21 recorridos se ejecutaron con `CI=1` sobre PostgreSQL 18 migrado en `postgresql://hub:hub@127.0.0.1:55432/hub_e2e`, build vigente y Chromium: 21/21 pasados. La revisión de copy en un navegador real sigue siendo una comprobación manual de despliegue; los E2E afirman comportamiento mediante atributos `data-*`.

## Casos manuales

| Caso | Requisito | Por qué manual | Instrucciones |
| --- | --- | --- | --- |
| Recogida real de ayudantes con Docker | CONT-04 | El borrado privilegiado y la propiedad por etiquetas se prueban con un cliente Docker simulado; tocar el Docker operativo no es admisible en CI | En un entorno desechable, lanzar una operación de host que cree un ayudante con las etiquetas del agente, esperar el barrido y confirmar el `DELETE` del ID propio, la preservación de volúmenes y la ausencia de borrado de contenedores ajenos. Verificar que el fallo de limpieza aparece en Mantenimiento y que el segundo intento fallido abre una sola incidencia digest por host. |
| Revisión de copy de los estados nuevos | INCD-09, INCD-10, CONT-04 | El estándar de pruebas prohíbe acoplarse al texto de interfaz | Abrir Avisos y Mantenimiento con datos reales y comprobar que inventario fechado, ausencia pendiente, inhibición por caída y estados de limpieza se leen sin ambigüedad y sin acciones Docker sobre un nombre pendiente. |

Los huérfanos anteriores al despliegue quedan fuera de la recogida automática por falta de etiquetas de propiedad; es una limitación de diseño registrada en `03-03-SUMMARY.md`, no un gap de validación.

## Limitaciones conocidas

- **`pnpm test:agent`:** 199 tests con 1 error intermitente preexistente en `test_env_settings` (`FileNotFoundError: '.env.lock'`). `agent/env_settings.py` no se tocó en la fase 3 y la suite focalizada `test_maintenance.py` pasa 44/44; no es una regresión de la fase.
- **Lint:** `pnpm exec eslint` aborta en este entorno con «typescript-eslint does not support TS 7.0» (TypeScript 7.0.2 frente a typescript-eslint 8.72.0). Es una limitación del entorno registrada en `03-03-SUMMARY.md`; `pnpm typecheck` y `pnpm build` terminan en verde.

## Evidencia de la auditoría

| Comando | Resultado |
| --- | --- |
| `pnpm build` | exit 0 |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 41 archivos, 473 tests pasados |
| `python3 -m unittest discover -s agent -p 'test_maintenance.py'` | 44 tests, OK |
| `pnpm test:agent` | 199 tests, 1 error intermitente preexistente en `test_env_settings` (ver Limitaciones conocidas) |
| `CI=1 pnpm test:e2e tests/e2e/incidents.spec.ts tests/e2e/maintenance.spec.ts tests/e2e/maintenance-status.spec.ts` | 21/21 pasados (3 + 11 + 7) |
| `pnpm test` por olas | 436 tests (03-01), 456 (03-02) y 473 (03-03); el crecimiento corresponde a los casos añadidos por los planes |

## Cierre de la validación

- [x] Comandos focalizados ejecutados y evidencia registrada por tarea.
- [x] PostgreSQL 18 verifica migración y transacciones sin omitir casos.
- [x] Recorridos Playwright ejecutados con build y migración vigentes (21/21).
- [x] Tiempos medidos y resultados recogidos en los resúmenes.
- [x] `nyquist_compliant: true` con evidencia de validación para INCD-09, INCD-10 y CONT-04.

**Aprobación:** approved 2026-11-25

## Validation Audit 2026-11-25

| Metric | Count |
|---|---|
| Gaps found | 3 |
| Resolved | 3 |
| Escalated | 0 |
