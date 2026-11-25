# Roadmap: hub.

## Overview

Ocho fases para pasar de varios emisores con políticas separadas a un único punto de decisión: una incidencia con identidad, un outbox transaccional, un solo proceso que envía, un resumen diario para lo no urgente y un bot que no puede ejecutar nada sin la verificación del hub. La fase 1 mide el ruido real antes de congelar la política; la 2 entrega el primer mensaje único por incidencia; la 3 agrupa la caída de un host; la 4 mueve lo no urgente al digest; la 5 añade lectura y reconocimiento; la 6 cierra la verificación server-side antes de que exista cualquier acción desde Telegram; la 7 añade el handoff con passkey; la 8 apaga los emisores de `media-stack` y consolida el histórico. El orden es de dependencias, no de tamaño: la puerta de seguridad nunca queda después de una acción de host, y el cutover nunca queda antes de la entrega y del digest.

Solo la fase 8 toca `media-stack` con commits; la fase 1 lo lee sin modificar y la fase 8 ajusta su `.env` de forma operativa.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Auditoría del ruido** - Medir mensajes, recuperaciones, duplicados y horas antes de fijar la política. (completed 2026-11-24)
- [x] **Phase 2: Incidencias y entrega única** - Una incidencia con identidad y exactamente un mensaje, con outbox y estado de entrega. (completed 2026-11-25)
- [ ] **Phase 3: Agrupación, inventario y ayudantes** - Una caída de host es una incidencia, sin fantasmas ni ayudantes huérfanos.
- [ ] **Phase 4: Resumen diario** - Lo no urgente llega una vez al día, sin duplicarse ni perderse en los cambios de hora.
- [ ] **Phase 5: Bot de lectura y reconocimiento** - Abrir, silenciar y reconocer desde el mensaje, con allowlist y tokens de un solo uso.
- [ ] **Phase 6: Puerta de seguridad** - Verificación reciente en el servidor para todas las acciones destructivas, más CSP y HSTS.
- [ ] **Phase 7: Acciones verificadas desde Telegram** - Iniciar en el chat y completar en el hub con sesión y passkey.
- [ ] **Phase 8: Cutover de media-stack y consolidación** - Ingest firmado, apagado por familias, rollups y retirada del camino viejo.

## Phase Details

### Phase 1: Auditoría del ruido
**Goal:** Producir el informe de ruido que fija la política: qué mensajes llegan, desde qué emisor, con qué frecuencia y qué proporción son recuperaciones o duplicados.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: AUDT-01, AUDT-02, AUDT-03, AUDT-04, AUDT-05
**Success Criteria** (what must be TRUE):
  1. El informe cubre 30–90 días y muestra mensajes/día por emisor (WUD, security-monitor, copia, issue-automator, upgrade, hub).
  2. Separa aperturas de recuperaciones y cuantifica los duplicados push + Telegram del mismo evento, con su latencia.
  3. Incluye la distribución horaria y el top 3 de claves por volumen.
  4. Fija el mapa definitivo de alerta inmediata, digest o silenciosa y el orden de apagado de emisores de `media-stack`.
  5. Fija el objetivo de éxito medido: mensajes proactivos/día y tiempo hasta reconocer.
**Plans**: 3/3 plans complete

Plans:
**Wave 1**
- [x] 01-01: Reconstruir el inventario de emisores y recolectar 30–90 días desde logs, archivos de estado y export del chat

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-02: Cuantificar recuperaciones, duplicados push + Telegram, distribución horaria y top de claves

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-03: Fijar el mapa alerta/digest/silencio, el orden de apagado y el objetivo de éxito

**Repo:** hub + lectura de logs de `media-stack` (sin commits)
**Research flag:** No — es medición, no investigación.

### Phase 2: Incidencias y entrega única
**Goal:** Convertir cada condición vigilada en una incidencia con identidad y entregar exactamente un mensaje por incidencia, con outbox transaccional y estado de entrega visible.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: INCD-01, INCD-02, INCD-03, INCD-04, INCD-05, INCD-06, INCD-07, INCD-08, BOT-01, BOT-03, SEC-03, CONT-01
**Success Criteria** (what must be TRUE):
  1. Cada condición produce una incidencia con identidad estable que sobrevive a un reinicio del worker, y una incidencia abierta no genera un segundo mensaje mientras su estado no cambie.
  2. Al resolverse, el mensaje original se edita (o se cuenta en el resumen) en vez de enviar uno nuevo, y un cambio de severidad se refleja en ese mismo mensaje.
  3. Un fallo entre la decisión y el envío no pierde el aviso, un reintento no lo duplica, un 429 espera `retry_after` y un 400/403/404 queda fallido de forma visible.
  4. El operador ve en el hub el estado de entrega de cada incidencia (enviado, fallido, suprimido y motivo) y llega a la vista correspondiente desde el botón del mensaje.
  5. El hub y el worker no se declaran sanos con credenciales de ejemplo o configuración obligatoria ausente, y un payload de agente inválido no abre ni resuelve una incidencia.
**Plans**: 5/5 plans complete

Plans:
**Wave 1**
- [x] 02-01: Migración reversible y persistencia transaccional de incidencias

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 02-02: Validación de contratos del agente y escalada de severidad

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 02-03: Configuración de arranque y procedimiento de despliegue

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 02-04: Entrega desde el worker con Telegram, Web Push y reintentos

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 02-05: Enlace autenticado, estado visible y actualización silenciosa del push

**Repo:** hub (incluye `agent/`)
**Research flag:** Sí — migración sobre datos reales, duplicados abiertos antes del índice único parcial y sintaxis de `uniqueIndex(...).where(sql...)` en Drizzle 0.45.4.

### Phase 3: Agrupación, inventario y ayudantes
**Goal:** Agrupar una caída de host en una sola incidencia, eliminar las incidencias fantasma de `expectedContainers` y recoger los ayudantes privilegiados huérfanos del agente.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: INCD-09, INCD-10, CONT-04
**Success Criteria** (what must be TRUE):
  1. Una caída de host produce una única incidencia de servicios y no N incidencias de contenedor.
  2. Mientras el host está caído, las incidencias de contenedor quedan inhibidas con su motivo visible, y al volver no se abren por la caída.
  3. Renombrar o recrear un contenedor deja de producir una incidencia `container:<nombre>` permanente.
  4. Los ayudantes privilegiados huérfanos se recogen y un fallo de limpieza queda visible para el operador.
**Plans**: 2/3 plans executed

Plans:
**Wave 1**
- [x] 03-01: Agrupar por host con `services-down` e inhibir contenedores por `connection`

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 03-02: Reconciliar `expectedContainers` con el inventario real y purgar los nombres ausentes con gracia

**Wave 3** *(blocked on Wave 2 completion)*
- [ ] 03-03: Recoger ayudantes huérfanos y hacer visible el fallo de limpieza

**Repo:** hub (incluye `agent/`)
**Research flag:** No — la agrupación y el reaper salen de la auditoría y del código actual.

### Phase 4: Resumen diario
**Goal:** Entregar lo no urgente en un único resumen diario a las 08:00 de Madrid, sin duplicados ni pérdidas en los cambios de hora, y hacer visible cuando no sale.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: DIG-01, DIG-02, DIG-03, DIG-04, DIG-05, DIG-06, CONT-03
**Success Criteria** (what must be TRUE):
  1. El operador recibe un único resumen diario a la hora configurada (08:00 `Europe/Madrid` por defecto) con abiertas ahora, nuevas en el periodo, contador de críticas y de resueltas.
  2. Un cambio de hora o un reinicio alrededor de las 08:00 no produce dos envíos ni lo pierde dentro de una ventana de dos horas.
  3. Sin contenido no se envía nada; con mucho contenido se trunca con "+N" y se respeta el límite de 4096 caracteres.
  4. Si el resumen no sale, el operador lo ve en el hub y el worker lo reporta.
  5. El agente y el worker exponen healthcheck, así que un proceso vivo pero bloqueado no se declara sano.
**Plans**: 3 plans

Plans:
- [ ] 04-01: Calendario de Madrid por instante y reclamación at-most-once del día con `digest_runs`
- [ ] 04-02: Construir el resumen con secciones, footer de críticas y resueltas, y truncado explícito
- [ ] 04-03: Healthchecks de agente y worker y visibilidad de "el resumen no salió"

**Repo:** hub (incluye `agent/`)
**Research flag:** Sí — DST y el parser de offset de `madrid-day.ts`; semántica at-most-once del digest tras un crash en `sending`.

### Phase 5: Bot de lectura y reconocimiento
**Goal:** Añadir al bot los botones de lectura y reconocimiento —abrir, silenciar y reconocer— con allowlist, tokens de un solo uso y sin filtrar el token.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: BOT-02, BOT-04, BOT-05, BOT-06, BOT-10
**Success Criteria** (what must be TRUE):
  1. Un update de un usuario o chat fuera de la allowlist se ignora sin efecto observable.
  2. El operador abre la incidencia, la silencia 1 h o 24 h y la reconoce desde los botones, y el estado persiste tras un reinicio.
  3. "Por qué me llegó esto" responde desde el propio mensaje.
  4. Un callback repetido o caducado no ejecuta dos veces la acción ni rompe el bot.
  5. El token del bot no aparece en logs ni en respuestas.
**Plans**: 3 plans

Plans:
- [ ] 05-01: Long polling con offset persistido, `deleteWebhook` y allowlist doble de `from.id` y `chat.id`
- [ ] 05-02: Tokens opacos de callback, ack/snooze/resolver y "por qué me llegó esto"
- [ ] 05-03: Contrato del `Update`, redacción del token y pruebas de callback repetido o caducado

**Repo:** hub
**Research flag:** No — Bot API estable; hace falta un test de contrato del `Update`, no un spike.

### Phase 6: Puerta de seguridad
**Goal:** Exigir verificación reciente en el servidor para toda acción destructiva y endurecer la frontera HTTP del hub antes de que Telegram pueda iniciar acciones.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: SEC-01, SEC-02, SEC-04
**Success Criteria** (what must be TRUE):
  1. Toda ruta destructiva (stop, restart, update, purge, empty-trash, clean-images, reconnect-apps, host-command, merge de Renovate) rechaza la acción sin verificación reciente en el servidor.
  2. La lista de acciones protegidas vive en un único módulo y un test falla si una ruta nueva no la declara.
  3. Las respuestas incluyen CSP conservadora y HSTS, y una mutación con cuerpo excesivo se rechaza antes de parsear.
**Plans**: 3 plans

Plans:
- [ ] 06-01: Módulo único de acciones sensibles y `guardSensitiveAction` en todas las rutas destructivas
- [ ] 06-02: Test que falla si una ruta destructiva no declara su protección
- [ ] 06-03: CSP, HSTS y límites de cuerpo y de tamaño de respuesta

**Repo:** hub (incluye `agent/`)
**Research flag:** No — `guardSensitiveAction`, CSP/HSTS y límites son configuración conocida.

### Phase 7: Acciones verificadas desde Telegram
**Goal:** Permitir iniciar una acción de host desde Telegram y completarla en el hub con sesión y passkey, sin ejecutar nada desde el callback.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: BOT-07, BOT-08, BOT-09
**Success Criteria** (what must be TRUE):
  1. Una acción iniciada desde Telegram se completa en el hub con sesión y passkey; el chat solo abre el handoff.
  2. Sin verificación reciente en el servidor, la acción destructiva se rechaza aunque el callback sea válido.
  3. Cada acción iniciada queda en `operations` con canal y solicitante.
  4. Un intent caducado o ya consumido no ejecuta la acción dos veces.
**Plans**: 3 plans

Plans:
- [ ] 07-01: Intents de acción con token de un solo uso, TTL de cinco minutos y `guardIntentAction`
- [ ] 07-02: Handoff por fragmento con sesión y passkey en el hub, y confirmación con verbo y objetivo
- [ ] 07-03: `operations` con canal y solicitante, ejecución única y `TELEGRAM_DIRECT_ACTIONS=0`

**Repo:** hub
**Research flag:** Sí — el handoff por fragmento no tiene precedente en el repo; spike de UI y `guardIntentAction` antes de planificar.

### Phase 8: Cutover de media-stack y consolidación
**Goal:** Apagar los emisores de `media-stack` en favor del ingest firmado, servir 30 días de histórico desde rollups y retirar el camino viejo de `notify()`.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: SEC-05, SEC-06, CONT-02, PERF-01, PERF-02
**Success Criteria** (what must be TRUE):
  1. El hub acepta cada evento firmado una sola vez; un HMAC inválido, una ventana vencida o un evento repetido se rechaza sin crear incidencia.
  2. Tras apagar los emisores familia por familia, esos avisos dejan de llegar fuera del hub; el fallback solo manda `backup-failed`, solo si el ingest no confirma y con origen propio.
  3. 30 días de histórico se sirven desde rollups y el overview cumple un presupuesto medido con 500k muestras.
  4. La rotación conjunta del token del bot (hub y `media-stack`) está documentada y probada.
  5. Ningún emisor del hub puede saltarse la política: el camino de `notify()` ya no existe.
**Plans**: 3 plans

Plans:
- [ ] 08-01: Ingest firmado e idempotente en el hub y cutover por familias en `media-stack`, con el fallback de copia estrechado
- [ ] 08-02: Rollups del histórico, caché y presupuesto del overview con 500k muestras
- [ ] 08-03: Retirar `notify()`, fijar retención y probar la rotación conjunta del token

**Repo:** `media-stack` (commits y CI propios) + hub; `.env` de `media-stack` en la rotación operativa
**Research flag:** Sí — contrato de ingest versionado con `media-stack` y orden de apagado por familia.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Auditoría del ruido | 3/3 | Complete    | 2026-11-24 |
| 2. Incidencias y entrega única | 5/5 | Complete    | 2026-11-25 |
| 3. Agrupación, inventario y ayudantes | 2/3 | In Progress | - |
| 4. Resumen diario | 0/3 | Not started | - |
| 5. Bot de lectura y reconocimiento | 0/3 | Not started | - |
| 6. Puerta de seguridad | 0/3 | Not started | - |
| 7. Acciones verificadas desde Telegram | 0/3 | Not started | - |
| 8. Cutover de media-stack y consolidación | 0/3 | Not started | - |
