---
phase: 04-resumen-diario
researched: 2026-11-26
status: complete
confidence: high
---

# Fase 4 · Investigación del resumen diario

## User Constraints

- El usuario eligió investigar y planificar sin un `04-CONTEXT.md` propio. DIG-01 a DIG-06 y CONT-03 fijan un resumen global diario a las 08:00 de `Europe/Madrid` por defecto, horario configurable, recuperación durante 2 h, abiertas y nuevas, contadores de críticas y resueltas, silencio cuando está vacío, truncado explícito y visibilidad del fallo. El healthcheck del agente y del worker debe detectar un proceso que sigue vivo pero no progresa. [Roadmap](../../ROADMAP.md#phase-4-resumen-diario) · [Requisitos](../../REQUIREMENTS.md#resumen-diario)
- La fase 2 registra como incierta una apertura que pudo aceptarse, sin otro envío, y reintenta el 429 confirmado según `retry_after`. Se mantienen la entrega primaria única y la regla de escalada inmediata que corresponde a cada clave. La fase 3 clasifica `helper-cleanup` para el resumen incluso con `PUSH_WARNINGS`. El resumen es una entrega agregada del hub, que reutiliza el único worker, bot y chat. Ingesta y apagado de emisores de `media-stack` pertenecen a fase 8. [Decisiones fase 2](../02-incidencias-y-entrega-nica/02-CONTEXT.md) · [Decisiones fase 3](../03-agrupaci-n-inventario-y-ayudantes/03-CONTEXT.md) · [Política auditada](../01-auditor-a-del-ruido/01-AUDIT.md)
- No ampliar privilegios ni alcance de red del agente. El navegador solo habla con Next.js y el worker sigue siendo el escritor único. [Proyecto](../../PROJECT.md)

## Standard Stack

| Área | Base comprobada y uso |
| --- | --- |
| Calendario | CI usa `node-version: 26` y la imagen es `node:26-bookworm-slim`. Node 26 habilita Temporal por defecto. La shell devuelve `v24.22.3` y `typeof Temporal === "undefined"`. Preferir Temporal nativo para la nueva conversión de servidor y verificar la ejecución con Node 26. Si se mantiene Node 24 sin flags para ese camino, usar Intl sin dependencia con la regla descrita abajo. |
| Persistencia | Drizzle sobre PostgreSQL 18, con migración aditiva por el comando `pnpm db:migrate` y el advisory lock actual. |
| Entrega | Reutilizar `sendTelegramMessage`, que implementa texto plano, timeout, bloqueo de redirects, validación y resultados tipados. |
| Salud | Mantener Compose, stdlib Python, `ThreadingHTTPServer` y el loop Node que posee el lock. Las sondas pueden ser internas a cada contenedor. |

[Node 26 sobre Temporal](https://nodejs.org/en/blog/release/v26.0.0#temporal-api) · [CI](../../../.github/workflows/ci.yml#L10-L47) · [Imagen del hub](../../../Dockerfile#L1-L18) · [Comandos y dependencias](../../../package.json) · [VERIFIED: src/lib/telegram.ts:1-56,265-287]

## Architecture Patterns

### 04-01 · Día de Madrid, configuración y reclamación

**Horario civil.** `madridDay(now)` ya devuelve límites inclusivo/exclusivo alrededor de medianoche para la actividad de hoy. El parser espera exactamente `GMT±HH:MM` y devuelve cero cuando el nombre no coincide. La iteración de offsets de medianoche no documenta la resolución del salto ni de la hora repetida si se aplica al horario configurable. Preservar el contrato del consumidor actual. Calcular el objetivo con fecha civil y hora configurada, en lugar de sumar horas al inicio del día. [VERIFIED: src/lib/madrid-day.ts:14-75] · [Vista que lo consume](../../../src/lib/events.ts#L79-L99)

- Recomiendo `Temporal.ZonedDateTime.from(…, { disambiguation: "compatible" })`. En un solapamiento elige la primera ocurrencia. Si el reloj salta, desplaza la hora por la duración del salto. Para una implementación Intl en Node 24 sin flags, obtener los offsets válidos antes y después de la fecha, probar los instantes candidatos y elegir el más temprano si ambos representan la hora solicitada. Si ninguno coincide por el salto, aplicar el offset anterior para trasladar la hora por la discontinuidad. Un fallo al interpretar el offset es un error, pues UTC no representa Madrid. [Documentación de Temporal](https://tc39.es/proposal-temporal/docs/timezone.html#resolving-time-ambiguity-in-temporal)
- Sonda de referencia observada localmente con el flag experimental `--harmony-temporal` de Node 24. El 29 de marzo de 2026, 08:00 produjo `06:00Z` y 02:30 produjo `01:30Z` (03:30 local). El 25 de octubre de 2026, 08:00 produjo `07:00Z` y 02:30 produjo `00:30Z` (primera ocurrencia). El flag se usó solo para comprobar la conversión, no se propone para despliegue. Añadir una prueba con `TZ` de proceso distinto.
- [ASSUMED: configuración del producto] Validar un horario global con 08:00 por defecto. Una variable de arranque validada por `readRuntimeConfig` cubre el requisito sin una pantalla de preferencias. La investigación previa plantea `DIGEST_HOUR` y configuración global opcional. Si se elige persistencia de preferencias, no mezclarla con el `jsonb().$type<Settings>()` actual de los hosts. Una fecha reclamada conserva objetivo y vencimiento aunque cambie la hora. [VERIFIED: src/lib/schema.ts:127-135] · [Investigación previa](../../research/ARCHITECTURE.md#dónde-y-cuándo)
- Una fila por fecha civil de Madrid en `digest_runs` con clave única de día y reclamación `ON CONFLICT DO NOTHING RETURNING`. Persistir objetivo y ventana `[objetivo, objetivo + 2 h)` en instantes. Si el horario está cerca de medianoche, considerar el día civil anterior mientras su ventana siga abierta. Al recuperar tras varios días sin worker, mostrar la última omisión relevante sin mandar resúmenes atrasados. El estado del último objetivo sigue visible antes del horario de hoy. [PostgreSQL 18, INSERT](https://www.postgresql.org/docs/18/sql-insert.html#SQL-ON-CONFLICT)

**Qué se puede garantizar.** El contrato público de `sendMessage` devuelve un `Message` al tener éxito y no expone una clave de idempotencia de envío. Un crash entre la marca durable y el POST es indistinguible, al recuperar, de un crash después de la aceptación remota y antes del acuse. La ventana de recuperación opera mientras conste que ningún intento pudo aceptarse. Tras el punto ambiguo, conservar una única salida potencial, persistir «entrega sin confirmar» y mostrarla sin afirmar que el bot no la recibió. [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)

| Estado lógico, nombres propuestos | Acción |
| --- | --- |
| Día sin fila o preparado sin marca de inicio | Crear o retomar dentro de la ventana. Si existe texto congelado, reutilizarlo. |
| Marca de inicio sin confirmación | Terminar incierto. Sin POST adicional ni fallback. |
| 429 confirmado y persistido | Reprogramar el mismo texto con `retry_after` desde la recepción, presupuesto acotado y el mismo límite de 2 h. Si la próxima hora alcanza el límite, registrar fallo. |
| Rechazo definitivo | Fallo visible, sin respaldo del resumen. |
| Confirmado, vacío, expirado o sin canal | Día terminal. Distinguir los estados de forma finita y contar como entrega solo un éxito confirmado. |

**Integración durable.** El worker posee la sesión `PoolClient` del lock. `claimOutboxJob` solo selecciona hoy `'incident-open', 'incident-edit', 'incident-push', 'push-test'`. `recoverOutbox` distingue `"attemptStartedAt" IS NULL` de `IS NOT NULL` y marca `'uncertain'` el inicio sin confirmación en tipos distintos de `'incident-edit'`. Recomiendo usar el outbox con un trabajo dedicado y clave única por día y `digest_runs` para calendario y payload. Persistir ambos atómicamente o derivar el estado de la entrega de una sola fila de autoridad. La transacción SQL termina antes de HTTP. Revalidar dueño, claim y plazo justo antes de persistir el inicio. [VERIFIED: src/worker.ts:60-113] · [VERIFIED: src/lib/notification-dispatch.ts:129-255,967-1006] · [Locks de PostgreSQL 18](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS)

**429 y prioridades.** El 429 de apertura desplaza las filas Telegram ya existentes en `"pending", "claimed"` sin intento. Un job insertado después no hereda el retraso. Las ediciones usan un camino diferente. El plan debe asegurar que un resumen nuevo no eluda un cooldown vigente del mismo bot y que un 429 del resumen se coordine con los avisos; un vencimiento durable compartido es una opción local. Probar 429 anterior al encolado, reinicio y expiración durante cooldown sin bloquear el worker esperando al proveedor. Dar prioridad a las críticas sin agotar un lote entero antes de observar si vence el resumen. [VERIFIED: src/lib/notification-dispatch.ts:378-426,651-689] · [Telegram retry_after](https://core.telegram.org/bots/api#responseparameters)

### 04-02 · Instantánea, secciones y truncado

- Consultar PostgreSQL para los hosts configurados. El overview existente limita resultados a las 100 incidencias más recientes de un host. Los casos de actividad se pueden derivar de `at`, `resolvedAt` y los eventos de apertura/escalada del episodio. Un aviso candidato nace como `kind: "incident-open"`, `channel: "digest"`, `status: "suppressed"`, razón `"digest_pending"`. La opción de push devuelve simultáneamente `channel: "push"` y `digest: true`, por lo que el booleano aislado no basta. Usar la disposición persistida, incluir `helper-cleanup` incluso con opt-in de push, respetar `"legacy_open"` y las familias silenciosas. [VERIFIED: src/lib/schema.ts:141-206] · [VERIFIED: src/lib/incident-store.ts:795-849] · [VERIFIED: src/lib/notification-policy.ts:49-91] · [Overview](../../../src/app/api/%5B...path%5D/route.ts#L320-L338)
- [ASSUMED: semántica de secciones] Para nuevas, críticas y resueltas usar `[objetivo anterior, objetivo actual)`, no `now - 24 h`. Así un catch-up hasta dos horas después no altera el corte. Para abiertas ahora usar la fecha de construcción de la instantánea persistida. Recomiendo que una nueva aún abierta contribuya a ambos totales pero ocupe una sola línea. Las antiguas abiertas se pueden resumir por host. Contar críticas distintas por ID con evento de apertura/escalada en el periodo y resueltas por fecha, sin anunciar «entregadas» sin confirmación. Un pie con categorías no vacías es contenido aunque no haya filas detalladas. [DIG-03/DIG-04](../../REQUIREMENTS.md#resumen-diario) · [Contenido propuesto](../../research/ARCHITECTURE.md#contenido)
- Mantener la entrega agregada aparte. Sobrescribir la apertura individual a `"sent"` o adjuntar el message ID del resumen al episodio rompería la escalada o permitiría que `incident-edit` editara el resumen. Si se quiere mostrar inclusión por incidencia, modelarla aparte y conservar la política de aperturas. Probar incidencias que abren y cierran en el periodo, cambio posterior de severidad, ajustes de push cambiados y renombrado con ID persistido. [VERIFIED: src/lib/incident-store.ts:254-335]
- Renderizar texto plano y orden estable. Reservar encabezados, pie y `+N` antes de llenar con líneas completas. Usar el límite conservador de `4096` unidades UTF-16 que aplica `telegramText` y no partir pares sustitutos. Acotar títulos y neutralizar saltos internos que simulen otras filas. N representa entradas únicas omitidas, incluidas las que no materializó una consulta acotada. Separar totales exactos de filas visibles. Reutilizar el botón de ruta autenticada a Avisos. No introducir un parámetro de enlace de detalle que la ruta aún no consuma. [VERIFIED: src/lib/telegram.ts:11-13,49-56,265-287] · [Límite Bot API](https://core.telegram.org/bots/api#sendmessage)

### 04-03 · Visibilidad y healthchecks

- Usar el estado global del último objetivo relevante en Avisos, independiente del host seleccionado. Mostrar hora, estado y motivo finito distinguiendo pendiente, enviado, vacío, sin configurar, vencido, fallido e incierto. El worker registra una salida acotada al cambiar a fallo o incertidumbre, sin token, destino, payload ni cuerpo remoto. El fallo del digest no genera otra notificación proactiva. La ruta se mantiene autenticada. [VERIFIED: src/lib/incident-store.ts:836-897] · [Punto de entrada](../../../src/app/api/%5B...path%5D/route.ts#L234-L270)
- Worker. Escribir una marca local atómica desde el loop principal tras comprobar el lock y completar progreso útil, nunca desde un intervalo independiente. Invalidar la marca al arrancar, salir o perder el lock. Un await atascado no la renueva. Medir las etapas normales: `drain` procesa hasta 20 jobs, el intento Telegram tiene timeout de 10 s y GET del agente 25 s por defecto. Actualizar tras hitos reales o acotar lote para evitar falsos negativos con tráfico normal. [VERIFIED: src/worker.ts:17-113] · [VERIFIED: src/lib/notification-dispatch.ts:17-21] · [VERIFIED: src/lib/nas.ts:18-23]
- Agente. La sonda debe comprobar el progreso del servidor y el mismo `LOCK` de métricas y acciones. El NAS puede enlazar una IP concreta en `network_mode: host`, y no siempre escucha en `127.0.0.1`. Recomiendo publicar una marca en `/tmp` desde `service_actions()` del servidor, solo si un intento de tomar `LOCK` sin espera prospera. Así la sonda de Docker comprueba bucle y lock sin mover el bind, añadir puertos ni transportar credenciales. Ambos agentes ya montan tmpfs en `/tmp`. Si se elige HTTP, mantener autenticación y allowlist y verificar ambos tipos de bind. El probe no necesita Docker, nuevas acciones ni comandos del host. [VERIFIED: agent/server.py:479-522,588-593] · [Configuración para NAS y Apps](../../../scripts/configure.mjs#L81-L101) · [Python 3.14 socketserver](https://docs.python.org/3.14/library/socketserver.html#socketserver.BaseServer.service_actions) · [Compose NAS](../../../agent/compose.yaml) · [Compose Apps](../../../agent/compose.apps.yaml)
- Declarar probes con presupuesto y reintentos para worker y los dos agentes. Docker registra `starting`, `healthy` y `unhealthy`. `restart: unless-stopped` está ligado a la salida y por sí solo no reinicia procesos solo porque su salud cambió. No omitir la prueba de bloqueo en contenedores desechables ni cambiar el deploy para reiniciar por salud sin un requisito. [Compose del hub](../../../compose.yaml#L40-L59) · [Docker healthcheck](https://docs.docker.com/reference/dockerfile/#healthcheck) · [Política de reinicio](https://docs.docker.com/engine/containers/start-containers-automatically/#use-a-restart-policy)

## Don't Hand-Roll

- Usar la zona IANA y el runtime existente, sin offsets fijos ni dependencia nueva de cron.
- Usar unicidad, transacciones y lock de PostgreSQL. Un temporizador o caché en memoria no es una barrera durable.
- Usar el cliente Telegram y las razones públicas finitas. No crear otro transporte ni otra política de reintento.

## Common Pitfalls

1. Sumar ocho horas a medianoche produce un horario visible distinto el domingo de DST.
2. Considerar toda preparación como envío mata un trabajo seguro. Reintentar toda marca pendiente de acuse puede duplicar un POST que se aceptó.
3. Si el reloj o el cooldown alcanzan el vencimiento, no iniciar HTTP aunque la reclamación comenzara antes. Un éxito confirmado después del vencimiento es válido si empezó a tiempo.
4. 5xx, desconexión, cuerpo inválido y timeouts pueden encubrir éxito. Conservar el estado incierto y la última evidencia sin filtrar fallos remotos.
5. `kill -0`, un temporizador lateral y una ruta que eluda el lock pueden certificar un proceso que no presta su función principal.

## Validation Architecture

Vitest, `unittest`, Playwright y PostgreSQL 18 de loopback ya existen. `HUB_REQUIRE_TEST_DB=1` convierte la ausencia de DB y una URL remota en fallo, en lugar de dejar pasar las pruebas omitidas. Usar transporte Telegram inyectado y Compose desechable, sin bot ni contenedores de producción. Los targets nuevos de digest y worker se declaran y crean en los planes antes de usar rutas que aún no existen. [Harness](../../../tests/database.ts#L4-L35) · [Norma de pruebas](../../../CODING_STANDARD.md)

| Ola | Requisitos | Evidencia | Comandos base |
| --- | --- | --- | --- |
| 1 | DIG-01, DIG-02, DIG-05 | Hora normal, configurable, 23/25 h, salto, hora repetida, otro TZ y medianoche. Borde de dos horas, cambio de hora configurada, dos clientes, crash antes y después de la marca, 429 persistido, lease y migración 0005 a 0006. | `pnpm test tests/madrid-day.test.ts tests/runtime-config.test.ts` y `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/notification-dispatch.test.ts`, ampliadas junto a la nueva suite de resumen. |
| 2 | DIG-03, DIG-04, DIG-06 | Abiertas antiguas, nueva resuelta, límites de periodo, críticas por ID, limpieza con push opt-in, silenciosas, solo pie, vacío y Unicode 4095/4096/4097. El payload simulado conserva el pie y `+N` al reintentar. | `pnpm test tests/telegram.test.ts` junto a suites de render e integración de resumen. |
| 3 | CONT-03 | Fallo, incertidumbre, expiración y control de auth sin secretos en el hub. Proceso vivo con loop o lock atascado, recuperación, marcador stale, arranque viejo y probes reales con estado `unhealthy` en Docker desechable. | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts`, `pnpm test:agent` y `pnpm test:e2e tests/e2e/incidents.spec.ts` tras migrar y construir con entorno CI. Añadir target focalizado de salud del worker. |

- Línea base observada. `pnpm test tests/madrid-day.test.ts tests/telegram.test.ts` registró 16 pruebas aprobadas sobre el código anterior.
- Cada tarea ejecuta su suite focalizada y define qué fallo descubre. Cerrar cada ola con `pnpm typecheck` y `pnpm lint` más los tests de límites afectados. Para el cierre de fase ejecutar `pnpm build`, pruebas del agente, integración PostgreSQL sin omisiones y la sonda real de Compose. En Playwright comprobar comportamiento, estado y auth al consultar Avisos. La lectura manual puede revisar claridad sin atar las regresiones al copy.

## Confidence

- Alta sobre el calendario, las garantías posibles de entrega, el stack declarado y las rutas locales. Ejecutar el target nuevo también bajo Node 26 para acreditar la disponibilidad de Temporal nativo en el entorno objetivo.
- Media sobre las decisiones de producto sin CONTEXT propio. La fuente del horario, la presentación de cohortes y el alcance de la historia visible se han propuesto como supuestos explícitos dentro del roadmap.
