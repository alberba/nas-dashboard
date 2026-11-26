# Fase 4 · Mapa de patrones del resumen diario

**Fecha** 2026-11-26

El mapa relaciona las piezas previstas en la investigación con el código actual del repositorio. Los nombres de módulos nuevos son orientativos.

## File Classification

| Pieza de fase 4 | Rol | Flujo | Referencia existente |
| --- | --- | --- | --- |
| Calendario y objetivo de Madrid | Utilidad | Transformación por instante | `src/lib/madrid-day.ts`, `tests/madrid-day.test.ts` |
| Hora global y configuración inicial | Configuración | Validación de arranque | `src/lib/runtime-config.ts`, `tests/runtime-config.test.ts`, `.env.example` |
| `digest_runs` y migración | Modelo, migración | Transacción y persistencia | `src/lib/schema.ts`, `drizzle/0005_incident_context.sql`, `tests/migrations.test.ts` |
| Reclamación, entrega y recuperación | Servicio | Cola persistente | `src/lib/notification-dispatch.ts`, `tests/notification-dispatch.test.ts` |
| Composición de incidencias | Servicio | Lectura transaccional y agregación | `src/lib/incident-store.ts`, `src/lib/events.ts` |
| Render y envío del resumen | Utilidad y servicio | Transformación y petición | `src/lib/telegram.ts`, `tests/telegram.test.ts` |
| Proyección del último resumen | Ruta y componente | Petición autenticada y representación | `src/app/api/[...path]/route.ts`, `src/components/dashboard.tsx`, `src/components/views/alerts.tsx` |
| Salud del worker y orquestación | Servicio y configuración | Progreso y fichero local | `src/worker.ts`, `compose.yaml`, `Dockerfile` |
| Salud de ambos agentes | Servicio y configuración | Progreso del servidor y fichero local | `agent/server.py`, `agent/compose.yaml`, `agent/compose.apps.yaml` |

## Pattern Assignments

### 04-01 · Hora, calendario y entrega durable

- **Calendario.** `madrid-day.ts:14–24,60–75` fija la zona explícita, deriva la fecha civil de un instante y obtiene el día siguiente por aritmética de calendario. `events.ts:79–99` consume sus límites inclusivo y exclusivo. Conservar ese contrato para eventos y añadir la resolución de la hora civil configurable con la desambiguación del informe. `madrid-day.test.ts:5–34` compara ISO UTC y días de 23/25 h. Añadir los casos de 08:00 y 02:30 en ambas transiciones, la gracia cruzando medianoche y un TZ de proceso distinto.
- **Configuración.** `runtime-config.ts:318–328,397–430` agrupa validaciones en `IssueList`, valida todo en `readRuntimeConfig` y publica valores ya normalizados. Reutilizar el patrón `issues.add(variable, "invalid")` y probar defecto, límites y valores inválidos con `runtime-config.test.ts`. `worker.ts:60–66` valida antes de conectar al pool. CI y la imagen de producción usan Node 26. Si se elige Temporal nativo, ejecutar la suite bajo ese runtime y documentar el requisito frente a la shell Node 24.
- **Migración.** `schema.ts:221–233` permite que los trabajos no ligados a una incidencia tengan `incidentId` nulo. Mantener una clave lógica única por fecha de Madrid y conservar en `digest_runs` el objetivo y el vencimiento originales. Generar los cambios con el Kit, conservar snapshot y journal, y validar de 0005 a la nueva versión en PostgreSQL local como hace `tests/migrations.test.ts:339–421`. Reutilizar `scripts/migrate.ts`.
- **Antes y después del intento.** `notification-dispatch.ts:129–255` recupera leases, reclama con `FOR UPDATE SKIP LOCKED` y usa el token de la reclamación para marcar el intento durable antes de HTTP. `worker.ts:78–105` es dueño del lock. Mantener el trabajo y el estado del día coherentes en la misma transacción, o derivar el estado de una autoridad única. Antes de marcar el intento comprobar también el vencimiento del día. Al recuperar, una marca sin confirmación queda incierta. Una reclamación anterior a la marca se puede recuperar dentro de la ventana.
- **Espera tras un 429.** `notification-dispatch.ts:378–419` retrasa las filas Telegram que existen al confirmar un 429. `claimOutboxJob` en 191–219 limita los tipos seleccionables. El resumen necesita participar explícitamente en la reclamación y respetar una espera persistente que cubra también filas insertadas después del 429. Probar los dos sentidos entre avisos existentes y resumen, la expiración durante la espera y la ausencia de otro envío tras un intento ambiguo. Las suites de referencia ya simulan leases y un reinicio en `notification-dispatch.test.ts:398–465,523–580`.

### 04-02 · Selección, instantánea y formato

- **Cohortes.** `incident-store.ts:785–825` persiste el episodio, su evento `opened` y la disposición de apertura. Para el detalle del resumen usar la apertura con `kind: "incident-open"`, `channel: "digest"` y razón `digest_pending`. `notification-policy.ts:49–91` devuelve `digest: true` incluso cuando el canal de una advertencia es push y contiene la excepción expresa de `helper-cleanup`. Conservar los canales primarios y las supresiones heredadas. Para críticas deduplicar por ID con los eventos `opened` y `severity` del periodo. Para resueltas consultar `resolvedAt`. El `limit(100)` de la API de overview es solo una proyección por host y no sirve como conjunto de entrada.
- **Identidad del envío.** Congelar una instantánea y su texto antes del primer intento, reutilizarlos ante 429 seguro y mantener separado el resultado de la entrega agregada. `incident-store.ts:254–335` consulta `openKey(incident.id)` al recalcular la severidad. Escribir el message ID del resumen o estado `sent` allí afectaría la escalada o permitiría editar el resumen como si fuera un aviso particular.
- **Formato y transporte.** `telegram.ts:49–55,265–287` aplica 4096 unidades UTF-16, preserva pares sustitutos y envía texto plano con botón. Calcular el presupuesto para encabezado, pie y `+N` antes de llamar a ese cliente. `tests/telegram.test.ts:133–174,203–228` inyecta las respuestas para observar cuerpo, reintento e incertidumbre. Probar que el contenido que llega al transporte conserva el pie y la cifra de omisiones, usa el enlace autenticado a Avisos y carece de payload cuando la instantánea es vacía.

### 04-03 · Estado visible y salud

- **Lectura autenticada.** `src/app/api/[...path]/route.ts:169–170,319–338` exige sesión y separa la selección de host de la consulta de datos. Ampliar la proyección de overview con una lectura global acotada del último resumen. `src/components/dashboard.tsx:187–201,743–758` actualiza ese snapshot y lo pasa a `AlertsView`, que ya traduce estados y razones finitas en `src/components/views/alerts.tsx:13–56`. La proyección y los logs deben contener estado, fechas y motivos finitos. El payload, el destino, los secretos y el cuerpo remoto se quedan en la capa de entrega. Usar atributos de estado para comprobar autenticación, llegada del fallo a Avisos y selección de host sin depender del copy.
- **Worker.** `worker.ts:45–57,78–123` ya drena lotes acotados con abort de apagado y comprueba el lock. Renovar la marca de salud tras hitos efectivos y comprobar cuánto tarda un lote normal. Con el límite de 20 y un timeout de hasta 10 s por envío, una única renovación por lote con un umbral corto puede declarar fallos falsos. La ruta de verificación debe fallar si se bloquea el loop con el proceso todavía vivo. `compose.yaml:40–58` ofrece el patrón de `healthcheck` y dependencias de arranque. El worker hereda el usuario `node` de `Dockerfile:12–19`.
- **Agentes.** `agent/server.py:479–522,588–593` conecta la validación, el `LOCK` de las operaciones sensibles al bloqueo y el servidor principal. Un marcador actualizado desde `service_actions()` al comprobar `LOCK` sin espera cubre el progreso del servidor y el camino protegido. Los dos Compose ya montan `/tmp` como tmpfs. Evitar un puerto nuevo, un probe que invoque Docker y un heartbeat de la hebra del reaper. Si se añade un módulo, el `COPY` enumerado en `agent/Dockerfile:8–9` debe incluirlo. Probar marca fresca, ausente, obsoleta y recuperación después de soltar el lock en ambas configuraciones.

## Shared Patterns

- Usar `tests/database.ts:4–35` con `HUB_REQUIRE_TEST_DB=1` y PostgreSQL desechable de loopback. Los tests de entrega usan clientes inyectados. La aplicación mantiene el advisory lock y no sostiene una transacción durante HTTP.
- Usar `CODING_STANDARD.md` para aserciones de comportamiento y leer la guía pertinente de Next que indique `AGENTS.md` antes de editar la ruta o sus pruebas. Conservar el aislamiento por host de las incidencias y observar el estado global del último resumen desde cualquiera.
- Comandos existentes. `pnpm test tests/madrid-day.test.ts tests/runtime-config.test.ts tests/telegram.test.ts`, `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/notification-dispatch.test.ts tests/api-incidents.test.ts`, `pnpm test:agent` y `pnpm test:e2e tests/e2e/incidents.spec.ts` con el entorno CI migrado y construido. La investigación registra 16/16 de calendario y Telegram como línea base. Las pruebas nuevas de horario, estado del resumen, bloqueo y Compose quedan para ejecución.

## No Analog Found

El calendario recurrente con objetivo configurable y la sonda del progreso real del worker y del agente son nuevos. Usar el calendario civil existente y los límites operativos descritos en la investigación para fijar sus contratos.
