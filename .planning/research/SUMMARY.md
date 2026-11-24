# Project Research Summary

**Project:** hub. — dashboard de homelab de un solo operador (NAS + servidor de apps)
**Domain:** notificaciones operativas, incidencias y bot de Telegram dentro de un hub Next.js con worker único
**Researched:** 2026-11-24
**Confidence:** MEDIUM — HIGH en el código y en la mecánica de la Bot API; MEDIUM en el corte de producto y en todos los umbrales, porque el volumen real de Telegram no está medido.

## Executive Summary

Esto no es "añadir un bot de Telegram". Es sustituir varios emisores independientes de `media-stack` más un `notify()` de Web Push sin política por **un único punto de decisión**: una incidencia con identidad, estado y severidad; un outbox transaccional en PostgreSQL; un solo proceso que envía; y un canal interactivo que no puede ejecutar nada sin la verificación del hub. El ruido actual no viene de una decisión sola, viene de cuatro, y las cuatro están en el código: mensaje de recuperación por evento (`src/lib/collector.ts:46-59`), una alerta y un mensaje por contenedor (`src/lib/collector.ts:209-222`), emisores en paralelo con políticas separadas, y ausencia de una política por severidad. Cualquier feature que no ataque una de esas cuatro no reduce el ruido; el botón inline es la última capa, no la primera.

La propuesta que converge en los cuatro documentos es: `incidents` con `fingerprint = hostId:key`, `status` (`pending`/`open`/`acknowledged`/`snoozed`/`resolved`), `severity` mutable y un índice único parcial; `incident_events` como timeline append-only; `notifications` como outbox transaccional con `dedupeKey` único y leases; **solo el worker que tiene `pg_try_advisory_lock(734921)` drena**; long polling dentro de ese mismo worker; cliente propio sobre `fetch` + Zod; una política que decide **un canal primario por incidencia**; digest a las 08:00 `Europe/Madrid` calculado por instante, no por diferencia de reloj; `media-stack` publicando eventos firmados; y toda acción de host desde Telegram resuelta por **handoff** al hub con sesión y passkey.

Los riesgos que mandan sobre el orden: el volumen no está medido, así que todo umbral es provisional; la migración toca a todos los lectores de `alerts` y hay que probarla sobre datos reales; el prerequisite de seguridad —verificación reciente en el servidor para **todas** las acciones destructivas— hoy no existe (`src/app/api/[...path]/route.ts:438` solo cubre `reboot`), de modo que ninguna acción de Telegram puede publicarse antes de cerrarlo; el fallback de copia de `media-stack` acepta una ventana de duplicado; y el contrato de plataforma (429, 64 bytes de `callback_data`, 4096 caracteres, `getUpdates` incompatible con webhook) debe re-verificarse contra la versión fijada de la Bot API al implementar.

## Key Findings

### Recommended Stack

**Confirmo long polling, `fetch` + Zod, outbox PostgreSQL y digest a las 08:00.** El polling gana por una razón que no es estética: el worker ya es singleton por `pg_try_advisory_lock(734921)` (`src/worker.ts:15`), varios consumidores de `getUpdates` comparten offset y se pisan, y el hub vive detrás de Tailscale, donde Telegram no puede alcanzar una URL privada. Además retira de golpe los dos pitfalls de webhook que más caros son en este repo: el choque con el gate de `Origin` y de sesión del catch-all (`PITFALLS.md`, pitfall 10) y la ruta no autenticada que solo se protege con `secret_token`. El coste es real y hay que asumirlo: dos bucles más en el worker, `deleteWebhook` una vez al arrancar si `getWebhookInfo` muestra URL, y que si el worker cae el bot cae con él (el mismo fallo que ya afecta a la recolección y al digest).

**Confirmo el cliente propio y el outbox; corrijo tres detalles de `STACK.md`.** Un framework como grammY 1.48.0 resuelve middleware, sesiones y menús que aquí no existen para cinco métodos; si el bot crece a conversaciones, se adopta entonces y se mantiene el outbox como capa de entrega (por eso la confianza en "grammY no para v1" es MEDIUM: depende del crecimiento, no de la tecnología). En cambio, el outbox necesita el `dependsOn` y el `leaseUntil` de `ARCHITECTURE.md`, no solo `status`/`attempts`/`nextAttemptAt`: sin `dependsOn` una edición de "resuelta" puede reclamarse antes de que exista el `message_id` original. También guardo el payload renderizado una vez (`payload` jsonb) en lugar de `text` + `replyMarkup` por columnas: un reintento debe enviar exactamente el mismo texto, y el digest depende de eso. Y el digest son 10 filas y ~3500 caracteres, no los 20 items de `STACK.md`: 20 no caben con cabecera y botones dentro de 4096, y FEATURES/ARCHITECTURE convergen en 10.

**Confirmo las 08:00 `Europe/Madrid` como valor por defecto, con una salvedad.** Es la primera hora después de la ventana de silencio 23:00–08:00 que propone `FEATURES.md`, y encaja con el patrón de un operador que revisa el móvil al empezar el día. La alternativa ingenua —`new Date().getHours()` en un contenedor UTC— dispararía entre una y dos horas tarde según el mes (a las 10:00 de Madrid en verano), así que la hora se calcula por instante con `madridInstant`, no por diferencia de reloj. Pero sigue siendo un default, no un hecho: la distribución horaria de la fase 1 es la que confirma si 08:00 es la hora correcta o si el ruido se concentra en otra franja.

**Core technologies:**
- Telegram Bot API 10.5 — `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getUpdates` — métodos antiguos y estables; no hace falta SDK.
- Long polling en `src/worker.ts` — recepción de updates — reutiliza el singleton existente y no exige ingress público.
- `fetch` nativo + Zod (`src/lib/telegram.ts`) — cliente HTTP tipado — control explícito de `retry_after`, cero dependencias nuevas, testeable con un fake en loopback.
- PostgreSQL 18 + Drizzle 0.45.4 — outbox, tokens, estado del bot y del digest — única infraestructura durable; dedup y retry sin Redis.
- `madridInstant(day, hour)` en `src/lib/madrid-day.ts` — calendario del digest — días de 23/25 h y DST resueltos por instante; `madridTime` de `STACK.md` es el mismo helper con otro nombre.
- `web-push` 3.6.7 — adaptador Web Push — se conserva, pero sin política propia.
- Vitest 5.1.0 + fake Bot API con `node:http` — tests — sin red y sin llamar a `api.telegram.org` en CI.

### Expected Features

Las **table stakes** son exactamente las que atacan las cuatro fuentes de ruido; las **differentiators** que valen para un solo operador son las que convierten el mensaje en un punto de entrada sin añadir riesgo; y los **anti-features** son igual de importantes que las features, porque cada uno de ellos vuelve a introducir el ruido que el milestone quiere eliminar. El detalle y las dependencias están en `FEATURES.md`; aquí queda comprimido a lo que decide el roadmap.

**Must have (table stakes):**
- TS-2 — identidad y dedup de incidencia — sin identidad no se puede silenciar, ackear ni explicar; el `tag` de push solo deduplica visualmente en el dispositivo.
- TS-1 — una notificación por incidencia, con estados y sin mensaje de recuperación — es la corrección literal de la queja.
- TS-3 — severidad con efecto real — hoy se fija al insertar y nunca cambia (`CONCERNS.md:263`); sin tiers no hay política.
- TS-8 + TS-9 — router único con adaptadores y un solo canal primario por evento — elimina duplicados y unifica el sitio donde silenciar.
- TS-4 + TS-6 — deep link a la vista correcta y "¿por qué me llegó esto?" — barato, y convierte cada mensaje restante en accionable.
- TS-10 — estado de entrega visible (`sent`/`failed`/`suppressed` + motivo) — "no me llegó" no puede ser indistinguible de "no pasó".
- TS-12 — autorización del operador para todo lo que llega de Telegram — el `chat_id` no es un secreto.

**Should have (competitive):**
- D-9 — agrupación por host con inhibición por `connection` — el mayor reductor de volumen en un host con 15 contenedores.
- D-3 — digest diario de lo no urgente — la otra mitad de la decisión ya tomada.
- TS-5 + D-1 — ack/mute/snooze persistido y botones de solo lectura — el 80 % del valor del bot con el 20 % del riesgo.
- D-12 — puente de verificación Telegram → passkey — el habilitador correcto de cualquier acción destructiva, sin inventar auth en el chat.
- D-4 — timeline de incidencia — explicación y depuración sobre `incident_events` + `operations`.

**Defer (v2+):**
- D-2 + D-8 — acciones inline con undo — solo después de que la verificación en todas las rutas destructivas esté hecha y probada; el undo, además, solo aplica a acciones con inversa segura.
- D-6 — escalado si no hay ack — necesita historial real de ack para calibrar los dos nudges.
- D-11 — presupuesto de supresión — es el seguro del sistema, útil cuando la agrupación ya demostró que hace falta.
- D-7 — enrutado por host (topic/thread) — cosmético con dos hosts.
- D-10 — ack desde push — `showNotification({ actions })` no está garantizado en iOS/Safari; hasta entonces, deep link.
- D-5 — quiet hours — muy visible, pero no es lo que causa el ruido actual y llega con la política ya estabilizada.

**Anti-features (no construir):** chatops de texto libre (`/restart plex`), una alerta por contenedor de `expectedContainers`, mensaje de recuperación por incidencia, reenviar mientras el estado no cambia, empujar logs o el journal completo, acciones destructivas sin confirmación, dos notificadores con políticas separadas, email como tercer canal, un topic por categoría, y "todo es crítico". Cada uno tiene su alternativa concreta en `FEATURES.md`.

El **corte v1** es donde los documentos discrepan y donde manda `PROJECT.md`: FEATURES deja el bot en v1.x y las acciones en v2, pero los Active requirements piden "bot interactivo: botones para abrir vistas y ejecutar acciones con autorización y verificación reciente". Resolución: el núcleo de reducción de ruido de FEATURES es la **primera mitad** del milestone, no el milestone entero; el bot de lectura y ack y las acciones por handoff son fases posteriores del mismo milestone. El criterio del corte: lo que exige historial de ack real o soporte que iOS/Safari no garantiza, fuera; lo que `PROJECT.md` lista como Active, dentro.

### Architecture Approach

El hub es el único que convierte una observación en decisión y el único que formatea y envía; `media-stack` conserva la observación local y publica un evento firmado. El estado durable es PostgreSQL y nada más: `incidents` (rename de `alerts`), `incident_events`, `notifications` (outbox), `telegram_action_tokens`, `telegram_action_intents`, `telegram_updates`, `telegram_state`, `digest_runs`, `ingest_events` y una tabla propia de preferencias. La web solo inserta filas; el webhook —si algún día se usa— solo inserta filas y responde; **nadie envía salvo el worker bajo el lock 734921**. El camino de callback con polling es: `runBot()` → `handleTelegramUpdate` (módulo independiente del transporte) → dedupe por `update_id` → allowlist de `from.id` y `chat.id` → token opaco `a:<token>` resuelto contra la tabla → `answerCallbackQuery` inmediato → ack/snooze (DB + edición en el outbox) o intent de handoff con botón `url`. Las acciones lentas nunca bloquean el bucle de polling; la acción real ocurre en el hub, después de passkey.

**Major components:**
1. `src/lib/notifications/signals.ts` + `policy.ts` — convierten métricas y snapshots en señales puras y deciden canal y momento; sin DB ni red, testeables sin PostgreSQL.
2. `src/lib/incidents.ts` — máquina de estados, `fingerprint`, agrupación e inhibición; la transición y el encolado viven en la misma transacción.
3. `src/lib/notifications/outbox.ts` + `dispatcher.ts` — encolar, reclamar con lease (`FOR UPDATE SKIP LOCKED`), marcar `sent`/`failed`/`suppressed`, recuperar huérfanos.
4. `src/lib/notifications/telegram.ts` + `telegram-action.ts` — Bot API y manejo del update; el transporte (polling o webhook) es sustituible sin tocar autorización ni tokens.
5. `src/lib/notifications/digest.ts` — `madridInstant`, reclamar el día con `digest_runs`, construir una vez, at-most-once.
6. `src/app/api/notifications/ingest/route.ts` — única frontera máquina-a-máquina, HMAC y ventana de 5 minutos; el webhook de Telegram desaparece de v1.
7. `src/worker.ts` — colección, polling, drenaje del outbox, digest y retención; un proceso, un lock, cierre ordenado que espera a los tres bucles.

### Critical Pitfalls

1. **La condición no tiene identidad durable y el debounce vive en memoria** — `condition()` mezcla evaluación, debounce en `Map` (`src/lib/collector.ts:16-19`), inserción en `alerts` y envío (`src/lib/collector.ts:25-68`); `alerts` solo tiene `at` y `resolvedAt` (`src/lib/schema.ts:134-151`), así que no hay `firstSeenAt` que sobreviva a un deploy. Evitarlo con `incidents` + `firstSeenAt` persistido y el índice único parcial por `fingerprint`; el `Map` queda como caché, nunca como fuente de verdad. Fase 2.
2. **La recuperación se envía como mensaje nuevo** — `src/lib/collector.ts:46-59` manda `"Recuperado: …"` con `tag + "-resolved"` en cada ciclo; con flapping son dos mensajes por vuelta. Evitarlo con `resolve` → `editMessageText` del mensaje original (o nada) y un footer en el digest con el contador de resueltas. Fases 2 y 5.
3. **Una caída de host se convierte en N incidencias** — `src/lib/collector.ts:209-222` abre `container:<name>` por cada servicio y la crítica `connection` llega después (60 s frente a 30 s); además `expectedContainers` se congela en la primera muestra (`src/lib/collector.ts:161-167`) y un renombrado deja una incidencia fantasma para siempre. Evitarlo con inhibición por `connection`, `services-down:<host>` para 2+ contenedores en 5 min, `container:<name>` silencioso por defecto y reconciliación del inventario. Fases 2 y 4.
4. **El mensaje se pierde porque se envía fuera de la transacción** — `src/lib/collector.ts:63-67` inserta y luego llama a `notify()`, y `src/lib/push.ts:14-33` usa `Promise.allSettled` que se traga el error; un crash entre el `INSERT` y el envío pierde el aviso sin rastro. Evitarlo con outbox transaccional, drenaje único en el worker y backoff que respete `retry_after` (429 no consume presupuesto de fallos; 400/403/404 son `failed` permanente y visibles). Fase 3.
5. **El callback no es de fiar y la acción no tiene step-up** — `callback_data` vuelve del cliente y tiene 64 bytes, y `guardSensitiveAction` solo se aplica a `reboot` (`src/app/api/[...path]/route.ts:438`) mientras `stop`, `restart`, `update-container`, `purge`, `empty-trash`, `clean-images` y `reconnect-apps` son session-only en el servidor. Evitarlo con token opaco de un solo uso, allowlist doble (`from.id` **y** `chat.id`), y handoff al hub con passkey para toda acción de host. Fases 6, 7 y 8.

Fuera del top 5 pero condicionan fases: el 429 sin `retry_after` y los límites por chat (fase 3), el parser de offset de `src/lib/madrid-day.ts:42` que asume `GMT+HH:MM` (fase 5, según `PITFALLS.md`), el `expectedContainers` obsoleto (fase 2) y el contrato `media-stack` → hub sin validación runtime (fases 2 y 9).

## Contradictions and Resolutions

**1. Webhook contra long polling.** `STACK.md` elige polling con confianza HIGH; `ARCHITECTURE.md` elige webhook, pero condiciona la decisión a que "el hub se despliegue con `BETTER_AUTH_URL` HTTPS detrás de un proxy inverso y el móvil ya lo alcance", y admite que `handleTelegramUpdate` puede llamarse desde `getUpdates` sin cambiar la lógica. `PITFALLS.md` asume webhook en F4. **Resuelvo polling**, porque la premisa que decide es la alcanzabilidad de red y el despliegue documentado es Tailscale + hub privado; el webhook sigue siendo un fallback honesto (una ruta, `setWebhook`, `secret_token` y `timingSafeEqual`) si el hub pasa a ser público y se necesita latencia sub-segundo. Consecuencia de diseño: **una sola frontera no-browser** (el ingest), no dos; `telegram_updates` se escribe desde el worker; y el `answerCallbackQuery` sigue siendo lo primero aunque no haya deadline HTTP, porque el spinner del cliente sí espera.

**2. ¿`media-stack` conserva un envío directo a Telegram?** `FEATURES.md` y `PITFALLS.md` dicen que el hub es el único que habla con Telegram y proponen verificar con `grep api.telegram.org`; `ARCHITECTURE.md` mantiene el fallback de copia si el ingest falla, con ventana de duplicado aceptada. **Resuelvo conservarlo, estrechado**, porque es la única mitigación de "hub caído = silencio" (`PITFALLS.md`, pitfall 24) en la única familia irreversible y no hay dead-man switch externo en alcance. El invariante que importa es "un decisor y una política", no "un cliente HTTP": el fallback manda un texto fijo, solo para `backup-failed`, solo si el ingest no confirma, no decide severidad ni canal y se marca con origen propio para contarlo en la auditoría. Coste explícito: el token del bot sigue en el `.env` de `media-stack`, así que la rotación es conjunta y el checklist de `PITFALLS.md` hay que reescribirlo, no borrarlo.

**3. Web Push: ¿se sustituye o pasa a ser adaptador?** Los tres coinciden en conservar `web-push` y en eliminar el broadcast `notify()`; discrepan en el reparto. `STACK.md` envía Telegram **y** push en paralelo para `immediate`; `FEATURES.md` (TS-8) exige un solo canal por evento; `ARCHITECTURE.md` hace de push un fallback tras agotar reintentos y un primario opcional para `warning`. **Resuelvo con `ARCHITECTURE.md`**: exactamente un canal primario por incidencia; push es (a) fallback de `critical` una sola vez tras agotar los reintentos de Telegram, registrado en `incident_events`, y (b) primario de `warning` solo si `pushWarnings=true`, y en ese caso no aparece también en el digest. El envío paralelo de `STACK.md` reproduciría justo el duplicado que el milestone existe para eliminar. Lo que se sustituye no es el transporte, es el `notify()` sin política y el `public/sw.js` que ignora `data.url`.

**4. ¿`start`/`stop`/`restart` exigen verificación reciente, y se ejecuta en el callback?** La matriz de `FEATURES.md` pide passkey para `restart` y `stop` y la exime para `start`, pero su propia nota de dependencias incluye `start` en la lista a proteger (inconsistencia interna); `PITFALLS.md` no nombra `stop`/`restart` en la lista del pitfall 15 pero exige "todas las destructivas"; `ARCHITECTURE.md` permite ejecución directa con passkey de menos de 5 minutos y deja `start` libre. **Resuelvo en dos capas.** (a) `stop` y `restart` son destructivas —interrumpen un servicio en uso— y exigen verificación reciente en el servidor; `start` es reversible y solo exige allowlist y auditoría. (b) En v1 **no hay ejecución directa**: `TELEGRAM_DIRECT_ACTIONS=0` y toda acción de host es un intent que se ejecuta en el hub tras sesión + passkey. Así la pregunta "¿lo exige el callback?" desaparece: lo exige la ruta del hub, que es la única fuente de verdad, y se evita inventar una segunda autenticación en el chat. La ejecución directa con passkey reciente queda implementada pero apagada hasta que esté probada. TTLs: 5 min para el handoff, 15 min para el token de un botón de acción, 24 h para abrir/ackear.

**5. El corte v1.** `FEATURES.md` propone seis entregables sin bot y manda el bot a v1.x y las acciones a v2; `PROJECT.md` lista el bot con acciones y la verificación server-side como Active de este milestone; `ARCHITECTURE.md` y `PITFALLS.md` incluyen bot y acciones en su build order. **Gana `PROJECT.md`**, que es la fuente de requisitos: el "v1" de FEATURES pasa a ser la primera mitad del milestone y las acciones entran por handoff, no por callback. Se difieren undo, escalado, presupuesto de supresión, enrutado por host, ack desde push y quiet hours por las razones del apartado de features.

**6. ¿Renombrar `alerts` a `incidents`?** `STACK.md` amplía `alerts` en sitio (mínimo riesgo); `ARCHITECTURE.md` renombra y añade el backfill; `FEATURES.md` y `PITFALLS.md` aceptan cualquiera de las dos. **Resuelvo renombrar**, porque el concepto cambia —`pending`, `acknowledged`, `snoozed`, `occurrence`, `fingerprint`, timeline— y hay una veintena de lectores (`src/lib/schema.ts`, `src/lib/types.ts`, `/api/overview`, `src/components/views/alerts.tsx`, tests) que seguirían hablando de `Alert` con una semántica que ya no existe; el rename mecánico obliga a revisarlos todos. No fuerza un big-bang de entrega: el camino legado `notify()` es independiente del nombre de la tabla, así que el modo shadow de la fase 2 sigue funcionando. Precondiciones: comprobar que no hay dos filas abiertas para el mismo `(hostId, key)` antes de crear el índice parcial (si las hay, resolver la más antigua), probar `tests/migrations.test.ts` contra una copia restaurada y dejar migración inversa. El riesgo real no es el rename, es la sintaxis de `uniqueIndex(...).where(sql...)` en Drizzle 0.45.4, que `STACK.md` marca MEDIUM hasta generarla. Adopto además `seq` en las claves (`incident:<id>:open:<seq>`) para que una reapertura no colisione con la apertura anterior.

**7. Digest: resueltas y catch-up.** `STACK.md` y `FEATURES.md` dicen que las resueltas no aparecen; `PITFALLS.md` pide una sección "resueltas en el periodo" para cerrar el bucle; `ARCHITECTURE.md` cuenta las críticas en el pie. **Resuelvo**: ninguna fila de resuelta en el cuerpo, **una línea de footer** con el contador ("N resueltas desde el último resumen"). Cierra el bucle sin reintroducir el mensaje de recuperación por incidencia. Para el catch-up, `STACK.md` dice "si el worker estaba caído a las 08:00, se envía tarde el mismo día"; `ARCHITECTURE.md` y `PITFALLS.md` fijan una ventana de 2 h. **Resuelvo 2 h**, porque "el mismo día" no acota nada y un digest a las 15:00 es ruido; pasada la ventana se marca `failed`/`skipped` y se ve en el hub. Y la garantía es at-most-once: si el proceso muere en `sending`, no se reenvía.

**8. Dónde vive la configuración global.** `STACK.md` prohíbe meter estado del bot en `configuration` porque es `{hostId, id, value: Settings}` y está tipada por host; `ARCHITECTURE.md` guarda `digestHour`, `quietHours` y `pushWarnings` en `configuration(hostId='global', id='notifications')` con un tipo nuevo. **Resuelvo con una tabla propia `notification_settings`** (fila única `id='global'`) y `telegram_state` para offset e ids vinculados; `TELEGRAM_DIGEST_HOUR` solo como semilla. Razón: `getSettings()` devuelve el JSONB crudo casteado a `Settings` y `CONCERNS.md` documenta que un valor malformado puede parar la evaluación de alertas de un host; añadir una segunda forma al mismo JSONB ensancha un fallo conocido. Una tabla nueva es una migración y ningún union de tipos.

## Implications for Roadmap

Diez fases. La auditoría va primera porque el usuario lo decidió así y porque sin ella todo umbral es una suposición; las fases 3–6 son parcialmente paralelizables, pero la 7 es un gate duro antes de la 8. **Familias de requisitos** (las Active de `PROJECT.md`): **A** auditoría, **B** una notificación por incidencia, **C** resumen diario, **D** bot interactivo, **E** verificación server-side, **F** secretos y arranque, **G** CSP/HSTS/límites, **H** contratos runtime, **I** rollups (fuera de este subsistema), **J** healthchecks e inventario (parcial). Cada fase las declara en **Addresses**. Dos repos: solo la fase 9 toca `media-stack` con commits; la 1 lo lee y la 10 ajusta su `.env` de forma operativa.

### La auditoría primero: qué mide y qué desbloquea

La fase 1 no escribe código de producto: mide. **Debe producir siete números**: (1) mensajes/día por emisor, con el inventario real —los documentos no coinciden en la lista, `STACK.md` cita `issue-automator`, `FEATURES.md` cita `upgrade.sh` y `PITFALLS.md` cita el trigger de WUD, y esa discrepancia ya justifica la fase—; (2) proporción recuperación : apertura; (3) incidencias `container:*` simultáneas por caída de host; (4) duplicados push + Telegram por evento y latencia entre ambos; (5) distribución horaria; (6) top 3 claves por volumen; (7) tiempo hasta apertura/ack por severidad. **Desbloquea cuatro decisiones**: el mapa de claves que implementa `policy.ts` (qué es inmediato, qué es digest y qué es silencioso), el orden de apagado de emisores en `media-stack`, la confirmación o el cambio de las 08:00, y si la agrupación de la fase 4 es imprescindible o cosmética. También fija el objetivo de éxito, hoy solo un objetivo: ≤3 mensajes proactivos al día fuera del digest.

Dos avisos que la auditoría debe asumir. Primero, **la Bot API no permite listar los mensajes que ha enviado el bot**; la medición sale de logs de cada emisor, de los archivos de estado (`last-status`, `last-status.json`, `failed-release.json`), del export del chat si existe y, si hace falta, de un contador temporal en el hub. Segundo, **el volumen real no está medido**: los umbrales de las fases 3–5 (10 filas, 3500 caracteres, 2 h de catch-up, presupuesto por chat) son contratos de plataforma o decisiones conservadoras, no hechos; los de éxito (≤3/día, mediana de ack < 15 min) son objetivos provisionales hasta que la fase 1 los confirme.

### Phase 1: Auditoría del ruido
**Rationale:** el usuario eligió explícitamente auditar antes de decidir y ninguna política puede congelarse sin línea base; no escribe código, así que no bloquea el esquema.
**Delivers:** informe con los siete números, inventario de emisores en ambos repos, mapa de claves real y orden de apagado.
**Addresses:** familia A — "auditar el ruido de Telegram con datos reales".
**Avoids:** decidir el corte por intuición (`PITFALLS.md`, F1) y el "dos notificadores" sin evidencia.
**Repo:** hub + lectura de logs de `media-stack` (sin commits).
**Flag:** no es investigación; es medición.

### Phase 2: Fundación — incidencias, contratos y arranque
**Rationale:** no puede haber "un mensaje por incidencia" sin una incidencia; y no se construye una máquina de estados sobre input sin validar.
**Delivers:** migración (`alerts` → `incidents`, columnas, índice único parcial, `incident_events`, `notifications`, `telegram_action_tokens`, `telegram_action_intents`, `telegram_updates`, `telegram_state`, `digest_runs`, `ingest_events`, `notification_settings`), backfill, `signals.ts` + `incidents.apply` en `NOTIFICATIONS_MODE=shadow` sin drenar, debounce durable (`firstSeenAt`), severidad recalculada en cada evaluación, reloj de servidor (`receivedAt`) para frescura y ventanas, reconciliación de `expectedContainers`, validación de arranque que rechaza placeholders y exige `DATABASE_URL` y las `TELEGRAM_*` cuando el bot esté activo, y contratos Zod en el borde para métricas, mantenimiento y despliegues.
**Addresses:** familias B (fundamento), F, H y J (`expectedContainers`) — identidad de incidencia, validación de arranque y contratos runtime.
**Avoids:** pitfalls 1, 3, 5, 18, 19 y 22; los bugs de `CONCERNS.md` sobre inventario congelado y severidad fija.
**Repo:** hub (incluye `agent/`).
**Flag:** sí — migración sobre datos reales, sintaxis del índice parcial en Drizzle y resolución de duplicados abiertos. Es la fase más grande: planificarla en dos planes (migración; shadow + contratos).

### Phase 3: Entrega única — outbox, Telegram y política
**Rationale:** con la incidencia ya escrita en shadow, el primer envío real necesita outbox, cliente y política; es donde muere el mensaje de recuperación.
**Delivers:** `telegram.ts`, `render.ts`, `policy.ts`, `outbox.ts` + `dispatcher.ts` con lease y `SKIP LOCKED`, tabla de error de Telegram (429 respeta `retry_after` sin consumir presupuesto, 5xx con backoff y 6 intentos, 400 reintenta una vez en texto plano, 403/404 `failed` permanente), `editMessageText` al resolver, deep link con `BETTER_AUTH_URL`, "por qué me llegó", opt-out por categoría, `push.ts` como adaptador sin política, y `NOTIFICATIONS_MODE=incidents` para las claves migradas.
**Addresses:** familia B y parte de D — entrega única y botón `url` de apertura.
**Avoids:** pitfalls 2, 8 y 23; anti-patrones 1, 2, 4 y 7.
**Repo:** hub.
**Flag:** no; patrón conocido. Ojo: la activación es **por clave**, no por canal; `policy.ts` debe devolver `silent` para las claves aún no migradas y `condition()` debe dejar de llamar a `notify()` para ellas en la misma transacción, o se duplica el aviso.

### Phase 4: Agrupación e inhibición
**Rationale:** es el mayor reductor de volumen en el caso real y cambia el modelo (padre/hijo), así que va después de que la entrega funcione y antes de que el digest refleje el mundo.
**Delivers:** `groupKey`/`parentId`, inhibición por `connection` abierta, `services-down:<host>` para 2+ contenedores en 5 min, `container:<name>` silencioso salvo contenedores marcados críticos, `incident_events(kind='suppressed', reason='inhibited_by_connection')`.
**Addresses:** familia B — el caso de caída de host.
**Avoids:** pitfalls 4 y 5; anti-patrón 6.
**Repo:** hub.
**Flag:** no; la auditoría confirma la necesidad y el alcance.

### Phase 5: Digest diario
**Rationale:** al mover `warning`/`info` al digest hace falta un destino; y no puede ser otro `notify()`, necesita el mismo outbox y un registro propio.
**Delivers:** `madridInstant`, `digest.ts`, `digest_runs`, watermark por ejecución (nunca `now() - 24h`), secciones "abiertas ahora" / "nuevas en el periodo", footer de críticas y resueltas, 10 filas + "+N" y ~3500 caracteres, sin contenido = sin mensaje, catch-up de 2 h, at-most-once, `disable_notification: true`.
**Addresses:** familia C — resumen diario de lo no urgente.
**Avoids:** pitfalls 6 y 7; el límite de 4096 y la trampa de rendimiento de escanear `samples`.
**Repo:** hub.
**Flag:** sí — el DST de `PITFALLS.md` está mal ejemplificado: el 02:30 no existe, pero el digest es a las 08:00; el riesgo real es el parser de `src/lib/madrid-day.ts:42` y el día de 23/25 h. Probarlo con las dos transiciones y con reinicio a las 08:00:30.

### Phase 6: Bot de lectura y ack
**Rationale:** el botón nace del mensaje ya enviado, y abrir/ackear no toca el host, así que puede entrar sin la puerta de seguridad.
**Delivers:** `runBot()` con `getUpdates(offset, timeout 25, limit 10, allowed_updates)`, offset persistido tras cada batch, `getMe` al arrancar con degradación a "Telegram deshabilitado" si 401, `getWebhookInfo` + `deleteWebhook` una vez si hay webhook, allowlist fail-closed de `from.id` y `chat.id`, `callback_data=a:<token>` contra tabla con TTL y consumo atómico, `answerCallbackQuery` primero, `editMessageText` al ack/snooze/resolver, estado de entrega visible en el hub, `redact()` del token en cualquier log y `handleTelegramUpdate` independiente del transporte.
**Addresses:** familia D y parte de B — botones de apertura, ack/mute/snooze y estado de entrega.
**Avoids:** pitfalls 11, 12, 14 y 16; los pitfalls 9 y 10 de webhook quedan **retirados** por la decisión de transporte.
**Repo:** hub.
**Flag:** no; Bot API estable. Sí un test de contrato del `Update` con Zod y fixtures.

### Phase 7: Puerta de seguridad
**Rationale:** es la diferencia entre un bot y un root remoto con historia de passkey; `PROJECT.md` la exige y hoy el servidor no la cumple en varias rutas.
**Delivers:** `sensitive-actions.ts` con la lista única, `guardSensitiveAction` en todas las rutas destructivas (`stop`, `restart`, `update-container`, `purge`, `empty-trash`, `clean-images`, `reconnect-apps`, `host-command`, merge de Renovate), `requireRecentVerificationForUser`, CSP conservadora + HSTS + límites de body, y comprobación de que `ALLOWED_IPS` del agente sigue siendo privado.
**Addresses:** familias E y G — verificación server-side en todas las destructivas, CSP/HSTS/límites y aislamiento de red del agente.
**Avoids:** pitfalls 15 y 17; los hallazgos de `CONCERNS.md` sobre verificación UI-only y ausencia de CSP.
**Repo:** hub (incluye `agent/`).
**Flag:** no; patrón conocido. **Gate:** ninguna acción de Telegram (fase 8) antes de cerrarla.

### Phase 8: Acciones verificadas desde Telegram (handoff)
**Rationale:** el operador quiere resolver desde el móvil; la única forma segura sin inventar auth en el chat es ejecutar en el hub.
**Delivers:** `operation-runner.ts` único, `telegram_action_intents`, `POST /api/telegram/intents/execute` + `guardIntentAction`, token en el fragmento con `history.replaceState`, confirmación con verbo y objetivo, `operations.channel` y `requestedBy`, `TELEGRAM_DIRECT_ACTIONS=0`.
**Addresses:** familia D (acciones) y E — ejecutar con autorización y verificación reciente.
**Avoids:** pitfalls 12, 13 y 15; anti-patrón 5.
**Repo:** hub.
**Flag:** sí — no hay precedente de handoff en el repo; conviene un spike corto de la UI y del fragmento antes de planificar.

### Phase 9: Cutover de media-stack
**Rationale:** solo se apaga un emisor cuando el hub ya replica lo que ese emisor cuenta y hay una ventana de observación; es otro repo, con commits y CI propios.
**Delivers:** `POST /api/notifications/ingest` con HMAC, ventana de 5 min y `ingest_events` idempotente por `source:eventId`, `eventId` estable derivado del hecho, apagado familia por familia (backup, security, upgrade, WUD al final), flag del fallback de copia y una semana de observación con el contador de duplicados.
**Addresses:** familias B, C y H — las familias de `media-stack` dentro de la entrega única y del digest.
**Avoids:** pitfalls 20, 22 y 24.
**Repo:** **`media-stack`** (commits y CI propios) + la ruta de ingest en el hub.
**Flag:** sí — contrato versionado y fixture compartido; el orden de apagado depende de la auditoría.

### Phase 10: Retirada y limpieza
**Rationale:** mientras quede el camino viejo, alguien lo reutilizará y volverán las dos políticas.
**Delivers:** eliminar las llamadas a `notify()` de `collector.ts` y de las rutas, sustituir `/api/push/test` por `/api/notifications/test`, retención de tablas, documentación de rotación (el token vive en dos `.env` por el fallback, así que se rota en ambos) y repaso del checklist "looks done but isn't" de `PITFALLS.md`.
**Addresses:** familias B y F — retirada del camino viejo y rotación de secretos documentada.
**Avoids:** la reaparición de emisores y la deuda de dos políticas.
**Repo:** hub (+ `.env` de `media-stack`, operativo).
**Flag:** no.

### Phase Ordering Rationale

- **Auditoría antes que código** porque fija el mapa de claves, el orden de apagado y el umbral de éxito; es la única fase que el usuario pidió explícitamente y no bloquea el esquema.
- **Fundación antes que entrega** porque la identidad y el estado son el contrato del que dependen el outbox, la agrupación y el digest; y porque validar los snapshots antes de construir sobre ellos evita resolver incidencias reales por un JSON corrupto.
- **Entrega antes que agrupación** porque agrupar cambia qué se envía; conviene medir el delta con el outbox ya probado. **Agrupación antes que digest** porque el digest debe fotografiar el mundo posterior, no obligar a reajustarlo dos veces.
- **Digest antes que bot** porque es el destino de todo lo que el bot, de otro modo, interrumpiría; y no necesita callbacks.
- **Puerta de seguridad antes que acciones** sin excepción: es el prerequisite que `PROJECT.md` ya identificó y el que convierte un botón en una capacidad auditada. Puede adelantarse en paralelo a las fases 4–6, pero no retrasarse más allá de la 8.
- **Cutover casi al final**, después de la ventana de observación y con el digest ya funcionando, para que las familias migradas tengan destino; **limpieza** solo tras una semana sin doble emisor.

### Repos: qué fase toca `media-stack`

| Fase | Repo | Notas |
|---|---|---|
| 1 | hub + lectura de `media-stack` | Solo logs y archivos de estado; sin commits. |
| 2 | hub | Incluye `agent/` del mismo repo. |
| 3–8 | hub | Ninguna toca `media-stack`. |
| 9 | **`media-stack`** + hub | Commits y CI separados; la ruta de ingest es del hub. |
| 10 | hub + `.env` de `media-stack` | La rotación del token es operativa, no un commit de código. |

### Hardening de seguridad: dónde encaja cada item

| Item de `PROJECT.md` | Fase | Por qué ahí | Bloquea |
|---|---|---|---|
| Verificación server-side en todas las destructivas | 7 | Es el control que el bot hereda; sin él, un botón sería más seguro que la propia UI | Fase 8 |
| Validación de configuración al arranque | 2 | Un worker con `DATABASE_URL` o `TELEGRAM_*` mal no produce incidencias ni avisa; hay que fallar antes de declarar sano | Todas |
| Contratos runtime Python ↔ TS | 2 (snapshots) y 9 (ingest) | Sin ellos, `degraded` se lee como "no falla" y resuelve incidencias reales | 5 y 9 |
| CSP y HSTS + límites de body | 7 | Protege el token del handoff en el fragmento y el hub entero; no bloquea el bot de lectura | Fase 8 (recomendado, no estricto) |

Fuera de este subsistema: los rollups del histórico y los healthchecks de agente son requisitos Active, pero pertenecen a otras fases; aquí solo entran el heartbeat del worker (visibilidad de "el digest no salió") y la reconciliación de `expectedContainers`.

### Research Flags

Fases que necesitan investigación o spike durante la planificación:
- **Phase 2:** migración sobre datos reales, duplicados abiertos antes del índice parcial y sintaxis de `uniqueIndex(...).where(sql...)` en Drizzle 0.45.4.
- **Phase 5:** DST y el parser de offset de `madrid-day.ts`; semántica at-most-once del digest tras un crash en `sending`.
- **Phase 8:** el handoff por fragmento no tiene precedente en el repo; spike de UI + `guardIntentAction` antes de planificar.
- **Phase 9:** contrato versionado con `media-stack` y orden de apagado por familia.

Fases con patrones estándar (no hace falta research-phase):
- **Phase 3:** transactional outbox y `SKIP LOCKED`, bien documentados.
- **Phase 6:** long polling de la Bot API, estable y con contrato conocido.
- **Phase 7:** `guardSensitiveAction`, CSP/HSTS y límites de body, configuración conocida.
- **Phase 10:** retirada de código y documentación.

## Open Questions

1. **¿El hub es alcanzable desde Internet en 443/80/88/8443 con certificado válido, o solo por Tailscale/VPN?** Es la premisa que decide polling o webhook; hoy la recomendación asume privado.
2. **¿Cuál es el volumen real por emisor y por clave de los últimos 30–90 días, y qué proporción son recuperaciones?** Sin esa cifra, el mapa de claves y el corte v1 son provisionales.
3. **¿Existe un export del chat de Telegram (Desktop) o solo los logs de cada emisor?** La Bot API no permite listar mensajes enviados; la fuente cambia el alcance de la fase 1.
4. **¿Qué acciones debe poder ejecutar el operador desde el móvil en este milestone: solo abrir/ack/snooze, o también stop/restart/update/deploy?** Define el alcance de la fase 8 y los TTL.
5. **¿Se acepta el fallback de copia desde `media-stack`, con su ventana de duplicado y el token en dos `.env`?** Es la única excepción a "un solo emisor" y condiciona la rotación.
6. **¿Se confirman las 08:00 `Europe/Madrid` y el objetivo de ≤3 mensajes proactivos al día, o la auditoría puede moverlos?** Es el criterio de éxito del milestone.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH / MEDIUM | HIGH en transporte, cliente, outbox y digest: sale del código y del contrato de la Bot API. MEDIUM en la forma exacta de las columnas y en el índice parcial de Drizzle hasta que la migración corra contra PostgreSQL 18. |
| Features | MEDIUM | El paisaje se apoya en el código leído, pero el corte v1 es una decisión de producto y el volumen no está medido; el mapa de claves se corrige con la fase 1. |
| Architecture | HIGH / MEDIUM | HIGH en límites de componentes y dirección de los flujos (derivados del código); MEDIUM en umbrales y volumen, que dependen de la auditoría. |
| Pitfalls | HIGH / MEDIUM | HIGH en los hallazgos anclados al código (líneas citadas); MEDIUM en el contrato de plataforma (429, 64 bytes, reintentos de webhook), que hay que re-verificar contra la versión fijada al implementar. |
| Roadmap | MEDIUM | El orden es estable porque es de dependencias; la duración y los puntos exactos de corte dependen de la fase 1. |

**Overall confidence:** MEDIUM.

Las tres calidades de evidencia no pesan igual. Lo **anclado al código** (identidad de incidencia, recuperación como mensaje, N contenedores, `notify()` fuera de transacción, verificación solo en `reboot`) es HIGH y no cambia con la auditoría. Lo que es **contrato de plataforma** (límites de Telegram, `retry_after`, `callback_data`, `getUpdates` incompatible con webhook) es HIGH en la fuente pero debe re-verificarse contra la versión fijada. Lo que depende de **volumen no medido** (qué es digest, qué es silencioso, si la agrupación es imprescindible, el objetivo de ≤3/día) es MEDIUM y se corrige en la fase 1.

### Gaps to Address

- **Volumen real de Telegram:** todos los umbrales de las fases 3–5 son provisionales; la fase 1 los convierte en datos y puede mover el corte.
- **Sintaxis del índice único parcial en Drizzle 0.45.4:** `STACK.md` la marca MEDIUM; generarla y probarla antes de dar la fase 2 por cerrada.
- **Formato del digest:** Telegram no renderiza tablas HTML; la "tabla" que proponen `FEATURES.md` y `ARCHITECTURE.md` tiene que ser texto alineado en `<pre>` o una lista de líneas. Decidirlo en la fase 5.
- **Fuente de la auditoría:** si no hay export del chat ni logs retenidos, la fase 1 necesita un contador temporal en el hub antes de poder medir.

## Sources

### Primary (HIGH confidence)
- `.planning/research/STACK.md` — transporte, cliente, outbox, digest, esquema y testing.
- `.planning/research/FEATURES.md` — table stakes, differentiators, anti-features, corte v1 y mapa de claves.
- `.planning/research/ARCHITECTURE.md` — límites, flujos, modelo de incidencia, garantías de entrega, web push y build order.
- `.planning/research/PITFALLS.md` — 24 pitfalls anclados a código y su mapeo a fases.
- `.planning/PROJECT.md` — requisitos Active, constraints y decisiones ya tomadas.
- `.planning/codebase/CONCERNS.md` — intersecciones de seguridad, contratos y bugs conocidos (sin duplicar).
- `.agents/gsd-core/templates/research-project/SUMMARY.md` — estructura de este documento.

### Secondary (MEDIUM confidence)
- Código citado por los investigadores: `src/lib/collector.ts`, `src/lib/push.ts`, `src/lib/schema.ts`, `src/lib/maintenance-alerts.ts`, `src/lib/madrid-day.ts`, `src/lib/verification.ts`, `src/lib/verification-api.ts`, `src/lib/host-commands.ts`, `src/lib/lifecycle.ts`, `src/worker.ts`, `src/app/api/[...path]/route.ts`, `public/sw.js`, `agent/maintenance.py`, `agent/server.py`; en `media-stack`: `stacks/backup/media-backup.sh`, `stacks/monitoring/security-monitor/main.py`, `stacks/monitoring/compose.yaml`, `scripts/upgrade.sh`.

### Tertiary (LOW confidence)
- Documentación externa citada por los investigadores y **no re-verificada** en esta síntesis: Telegram Bot API 10.5 y Bots FAQ, grammY 1.48.0, telegraf 4.16.3, PostgreSQL 18 (`FOR UPDATE SKIP LOCKED`, índices únicos parciales), Prometheus Alertmanager, `web-push` 3.6.7. Re-verificar contra la versión fijada al implementar.

---
*Research completed: 2026-11-24*
*Ready for roadmap: yes*
