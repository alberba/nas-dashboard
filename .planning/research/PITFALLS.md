# Pitfalls Research

**Domain:** homelab notification pipeline + chat-driven remote administration (Telegram) over a privileged NAS/apps agent
**Researched:** 2026-11-24
**Confidence:** HIGH for the code-grounded findings (read from this repo and `media-stack`); MEDIUM for Telegram platform behaviour (429, `callback_data`, webhook retries), which comes from the Bot API contract and must be re-verified against the pinned API version when implemented.

## Scope and method

Every pitfall below is anchored to code that exists today: `src/lib/collector.ts`, `src/lib/push.ts`, `src/lib/maintenance-alerts.ts`, `src/app/api/[...path]/route.ts`, `src/lib/verification*.ts`, `src/lib/host-commands.ts`, `src/lib/lifecycle.ts`, `agent/server.py`, `agent/maintenance.py`, and in `media-stack` the three current Telegram senders (`stacks/backup/media-backup.sh`, `stacks/monitoring/security-monitor/main.py`, the WUD Telegram trigger in `stacks/monitoring/compose.yaml`) plus the state files the hub reads.

There is no `ROADMAP.md` yet. Phases below are the proposed delivery order for this milestone and must be reconciled with the roadmap when it is written:

| Fase propuesta | Nombre | Contenido |
|---|---|---|
| F1 | Auditoría del ruido | Medir qué se envía hoy, desde qué job, con qué frecuencia; histórico agregado de envíos |
| F2 | Incidencias y entrega única | Máquina de estados de incidencia, supresión padre/hijo, outbox persistente, fin de los avisos de recuperación |
| F3 | Resumen diario | Digest con watermark, calendario `Europe/Madrid`, DST, separación activo/resuelto |
| F4 | Bot interactivo | Webhook, autorización del pulsador, callbacks no confiables, vistas del hub |
| F5 | Acciones verificadas y contratos | Step-up real para acciones destructivas, allowlist del agente, contratos runtime hub↔media-stack, secretos |

---

## Critical Pitfalls

### Pitfall 1: La alerta se crea por evaluación, no por incidencia

**What goes wrong:**
`condition()` en `src/lib/collector.ts:25-68` mezcla tres responsabilidades: decide si el estado falla, crea la fila en `alerts` si no hay una abierta, y dispara `notify()` en el mismo instante. No existe una entidad "incidencia" con identidad estable, ni un `dedupeKey` persistido, ni un estado `acknowledged`. El resultado es que el mensaje es un efecto secundario de una evaluación que corre cada 5–30 s (`src/worker.ts`), y cualquier refactor del colector (añadir una comprobación, cambiar el orden, reintentar) puede volver a emitir.

**Why it happens:**
La tabla `alerts` (`src/lib/schema.ts:134-151`) solo tiene `at` y `resolvedAt`. No hay `updatedAt`, `notifiedAt`, `dedupeKey`, `incidentId` ni `messageRef`. Sin esos campos, "una notificación por incidencia" no se puede expresar en la base de datos; solo se puede aproximar con estado en memoria, que se pierde al reiniciar (Pitfall 18).

**How to avoid:**
- Introducir una tabla `incidents` (o ampliar `alerts`) con `id`, `hostId`, `key`, `severity`, `openedAt`, `updatedAt`, `resolvedAt`, `notifiedAt`, `ackedAt`, `dedupeKey UNIQUE`, `telegramMessageId`, `state` (`open`/`acked`/`resolved`).
- Separar en `src/lib/incidents.ts` la transición de estado (`open`, `escalate`, `resolve`, `reopen`) de la entrega (`src/lib/notifications/outbox.ts`). `condition()` solo llama a `transition()`; nunca a `notify()`.
- Hacer que la identidad de la incidencia sea `(hostId, key)` y no la fila temporal. Un `reopen` reutiliza la misma incidencia con un contador, en lugar de crear otra.
- La entrega se decide comparando el estado anterior y el nuevo, no el resultado de la evaluación: `open→open` no envía; `open→escalate` edita el mensaje existente; `open→resolved` no envía nada (decisión del milestone).

**Warning signs:**
- Dos filas abiertas para la misma `(hostId, key)` (hoy lo impide solo la consulta, no una restricción única parcial).
- Mensajes duplicados tras desplegar una versión nueva del worker sin cambiar ningún estado real.
- `alerts` con `at` del día anterior y `resolvedAt` de hoy pero sin ningún mensaje asociado.

**Phase to address:** F2 (modelo) y F1 (medición previa).

**Tests antes de enviar:**
- `tests/incidents.test.ts`: dos evaluaciones consecutivas con el mismo fallo producen una fila y una llamada a `enqueue`; la segunda no incrementa el contador.
- Test de restricción: insertar dos incidencias abiertas con la misma `(hostId, key)` falla a nivel de base de datos.
- Test de transición: `open → resolved → open` reutiliza el mismo `id` y marca `reopenedAt`.

---

### Pitfall 2: La recuperación se envía como mensaje nuevo

**What goes wrong:**
`src/lib/collector.ts:46-59` envía `"Recuperado: " + title` con `tag + "-resolved"` cada vez que una condición deja de fallar. En un día con CPU que oscila, discos que se llenan y vacían, o unidades que se reinician, esto duplica el volumen: un mensaje de apertura y otro de cierre por cada ciclo. Es exactamente la queja que el milestone quiere eliminar.

**Why it happens:**
El `notify()` de `src/lib/push.ts:6` no distingue tipos de evento: Web Push y el futuro Telegram comparten la misma llamada. Además, resolver una alerta y notificar que se ha resuelto se tratan como el mismo acto, cuando son dos decisiones de producto distintas.

**How to avoid:**
- Política explícita por severidad en `src/lib/notifications/policy.ts`: `critical` abre mensaje y lo **edita** al resolverse (o lo deja con un check y lo cierra en el digest); `warning`/`info` solo aparecen en el digest.
- `resolve` nunca crea un mensaje nuevo. Si se quiere avisar, se edita el mensaje original con `editMessageText` usando `telegramMessageId`, y se tolera el error "message is not modified" / "message to edit not found".
- Eliminar el `tag + "-resolved"` y sustituirlo por una transición de estado auditada. El tag de Web Push (`src/lib/push.ts:19`) puede seguir existiendo para agrupar en el navegador, pero no debe originar un envío.

**Warning signs:**
- Proporción de mensajes `Recuperado:` superior al 30 % del total.
- El mismo `tag` aparece con y sin sufijo `-resolved` en la misma hora.
- Usuarios que silencian el chat: indicador de que la política de recuperación es la causa.

**Phase to address:** F2, verificado en F1 con datos reales.

**Tests antes de enviar:**
- `tests/notifications-policy.test.ts`: una incidencia `critical` que se resuelve produce cero llamadas a `sendMessage` y una llamada a `editMessage`; una `warning` resuelta no produce ninguna entrega inmediata.
- Test de edición fallida: si `editMessageText` devuelve 400, la incidencia queda `resolved` igualmente y se registra un `deliveryError`, sin reintentar como mensaje nuevo.

---

### Pitfall 3: Flapping sin histéresis ni cooldown

**What goes wrong:**
Un contenedor que reinicia cada 10 minutos entra y sale de `container:<name>` (`src/lib/collector.ts:209-222`). La condición tiene `duration = 30`, pero `started` se borra en cuanto la comprobación pasa (`collector.ts:47`), así que cada caída de más de 30 s abre una incidencia y cada recuperación la cierra. Resultado: dos eventos por ciclo, doce ciclos por hora, veinticuatro horas. Lo mismo aplica a temperatura con `duration = 30` y a CPU/memoria con `settings.sustainedSeconds`.

**Why it happens:**
No hay ventana de histéresis (entrar a un umbral distinto de salir), ni `cooldown` tras resolver, ni contador de reincidencias. `condition()` es una función pura de un instante; el histórico de la incidencia no se consulta.

**How to avoid:**
- Añadir a `Settings` (`src/lib/validation.ts`, `src/lib/settings.ts`) un `resolveAfterSeconds` distinto de `sustainedSeconds`, y un `cooldownSeconds` por clave.
- En `transition()`, no resolver hasta que la condición lleve `resolveAfterSeconds` sana; mantener `lastFailedAt`/`lastHealthyAt` en la fila.
- Reincidencia: si una incidencia resuelta vuelve a abrirse dentro de `cooldownSeconds`, no se envía mensaje nuevo; se marca `flapping = true` y se agrupa ("X reinicios en la última hora").
- Para contenedores, usar el histórico de `samples` (ya existe, 30 días) para calcular reinicios en la ventana, en lugar de confiar solo en la transición.

**Warning signs:**
- La misma `(hostId, key)` con más de 3 aperturas en una hora.
- `resolvedAt - at` sistemáticamente por debajo de 2 minutos.
- Mensajes de apertura y cierre alternos con el mismo título.

**Phase to address:** F2.

**Tests antes de enviar:**
- `tests/incidents-flapping.test.ts` con reloj inyectado: fallo 40 s, sano 20 s, fallo 40 s → una sola incidencia abierta, `flapping = true`, una sola entrega.
- Test de histéresis: valor entre umbral de entrada y de salida no abre ni cierra.

---

### Pitfall 4: Las alertas por contenedor ahogan la caída del host

**What goes wrong:**
Cuando un host cae, `collectHost()` (`src/lib/collector.ts:106-145`) solo evalúa `connection` y retorna antes de recorrer `expectedContainers`. Eso evita el diluvio en la caída total, pero no en el caso peor: el agente responde `/metrics` con la lista de contenedores vacía o incompleta (reinicio de Docker, `container_cache` recién inicializado en `agent/server.py:267`, host recién arrancado). Entonces `connection` pasa y se abren N incidencias `container:<name>` a la vez. La incidencia crítica del host llega **después** (60 s de `duration` frente a 30 s de los contenedores), así que el usuario recibe cinco mensajes de servicios y ninguno que diga "el NAS está caído".

**Why it happens:**
No hay jerarquía padre/hijo entre `connection` y las condiciones que dependen de que el host esté sano. Cada clave es independiente. Tampoco hay supresión por muestra incompleta: `collectHost` valida `Array.isArray(metrics.containers)` pero no que el número de contenedores sea plausible.

**How to avoid:**
- Declarar dependencias en `src/lib/incidents.ts`: `container:*`, `cpu`, `memory`, `disk`, `temperature` dependen de `connection`. Si `connection` está abierta o la última muestra tiene más de `CONNECTION_STALE_MS`, las hijas **no** se evalúan (ni abren ni resuelven).
- Tratar una muestra con `containers.length === 0` y `expectedContainers.length > 0` como muestra degradada, no como "todos los servicios caídos": no emitir señales y añadir `containers` a un `degraded` local.
- Un solo mensaje padre con un resumen de hijos (máximo N líneas) en lugar de N mensajes.
- Ordenar la evaluación: `connection` primero y con `duration` menor que sus hijas, para que el padre gane la carrera.

**Warning signs:**
- Ráfagas de ≥3 mensajes `Servicio detenido` en menos de un minuto, seguidos de `no responde`.
- `openAlerts` del overview sube de golpe tras un reinicio del agente.
- Incidencias de contenedor que se resuelven solas en el mismo minuto en que se abrieron.

**Phase to address:** F2.

**Tests antes de enviar:**
- `tests/collector-outage.test.ts`: host caído → exactamente una incidencia (`connection`) y cero `container:*`.
- Muestra con `containers: []` y dos esperados → sin nuevas incidencias y sin resolver las existentes.
- Caída con contenedores ya abiertos → las hijas no se resuelven hasta que el padre se resuelva y llegue una muestra válida.

---

### Pitfall 5: Inventario esperado congelado que produce alertas fantasma para siempre

**What goes wrong:**
`expectedContainers` se captura una sola vez en la primera muestra válida (`src/lib/collector.ts:161-167`) y solo lo mutan las rutas de start/stop/restart/remove del hub (`src/app/api/[...path]/route.ts:502-527`, `src/lib/lifecycle.ts:57-75`). Un renombrado de servicio Compose, un `docker compose up` manual o un contenedor que se recrea fuera del hub dejan el nombre viejo en la lista. A partir de ahí, `container:<nombre-viejo>` falla en cada evaluación para siempre. No hay UI para editar la lista. En un sistema de notificaciones esto es una fuente de ruido permanente e imposible de acallar sin tocar la base de datos.

**Why it happens:**
El hub no distingue "servicio que debería existir" de "servicio que existía el día que se inicializó". La lista se persiste en el JSONB de `configuration` (`src/lib/schema.ts:125-133`) y no se reconcilia con el inventario.

**How to avoid:**
- Derivar el inventario de una declaración explícita (Compose labels `com.docker.compose.project/service` en el snapshot de métricas) y no de la primera observación.
- Reconciliar en cada evaluación: si un nombre esperado no aparece en N muestras consecutivas **y** no existe en el inventario del agente, marcarlo `retired` y resolver su incidencia con un motivo, no dejarla abierta.
- Exponer un editor de "servicios esperados" en Ajustes y registrar quién lo cambió.
- Mientras no exista el editor, añadir una migración/one-shot que limpie nombres ausentes con una ventana de gracia.

**Warning signs:**
- Una incidencia `container:*` con `at` de hace semanas y el contenedor ya no existe en el host.
- `expectedContainers` contiene nombres que no aparecen en `samples.data->'containers'`.
- El usuario pide "silenciar" un servicio que ya no usa.

**Phase to address:** F2 (reconciliación) y F5 (editor/contrato).

**Tests antes de enviar:**
- `tests/collector-expected.test.ts`: un nombre ausente durante la ventana de gracia se retira y su incidencia se resuelve con `reason = "retired"`.
- Un nombre presente pero parado sigue generando incidencia (no se retira por estar parado).

---

### Pitfall 6: El digest repite filas resueltas y no tiene watermark

**What goes wrong:**
El digest se implementará casi con seguridad como `SELECT * FROM alerts WHERE at > now() - interval '1 day'`. Esa consulta incluye incidencias ya resueltas y las presenta como activas, y si el envío falla o el proceso reinicia, el siguiente intento vuelve a incluir lo mismo. Sin una marca de "hasta aquí he contado", cada ejecución es una vista distinta del mismo datos y el usuario ve el mismo incidente dos o tres días.

**Why it happens:**
`alerts` no tiene `notifiedAt` ni una tabla de ejecuciones de digest. La única marca temporal es `at`, que es la apertura, no la última vez que se contó. Además, un incidente abierto durante tres días aparecería en los tres digests sin decir "sigue abierto desde el lunes".

**How to avoid:**
- Tabla `digest_runs(day DATE, kind TEXT, startedAt, sentAt, messageId, PRIMARY KEY(day, kind))` y una tabla `digest_items(runId, incidentId, section)`.
- Secciones explícitas en el mensaje: **Abiertas ahora** (estado actual, sin ventana), **Abiertas en el periodo** (nuevas desde el watermark), **Resueltas en el periodo** (solo si `resolvedAt >= watermark`), **Acciones pendientes de confirmar**.
- Watermark = `MAX(sentAt)` de `digest_runs` para ese `kind`, no `now() - 24h`.
- Una incidencia abierta se lista una vez por digest mientras siga abierta, pero con `desde <fecha>` y sin duplicar el detalle; el contador debe ser "abiertas ahora", no "eventos".
- Reintento: si `sentAt` es null, se puede reintentar el mismo `runId`; si `sentAt` existe, es no-op.

**Warning signs:**
- El número de filas del digest es mayor que `openAlerts` del overview.
- El mismo `alert.id` aparece en dos digests consecutivos en la sección de nuevas.
- Un digest con sección "resueltas" que incluye incidencias resueltas antes del periodo.

**Phase to address:** F3.

**Tests antes de enviar:**
- `tests/digest.test.ts` con reloj fijo: incidencia abierta antes de la ventana y aún abierta → aparece en "abiertas ahora", no en "nuevas".
- Incidencia resuelta antes del watermark → no aparece.
- Dos ejecuciones del mismo día → una sola llamada a `sendMessage` (segunda no-op por `digest_runs`).

---

### Pitfall 7: DST y el calendario: el digest se ejecuta dos veces o ninguna

**What goes wrong:**
`Europe/Madrid` cambia de hora el último domingo de marzo (02:00 → 03:00, la hora 02:30 no existe) y el último de octubre (02:00 → 03:00, la hora 02:30 ocurre dos veces). Un digest programado a las 02:30 se salta en primavera y se duplica en otoño. Un `setInterval(24 * 3600 * 1000)` deriva una hora respecto al reloj de pared en cada cambio y, además, no se recupera si el worker estaba caído. `src/lib/madrid-day.ts` ya existe y resuelve el cálculo del día, pero **no** resuelve la programación ni la idempotencia.

**Why it happens:**
Se confunde "cada 24 horas" con "cada día natural". El worker (`src/worker.ts`) no tiene concepto de calendario: su bucle es de 1 segundo y `lastCleanup` es un `Date.now()` en memoria. Si el digest se añade como un `setInterval`, hereda los tres problemas: deriva, DST y pérdida al reiniciar.

**How to avoid:**
- Programar por reloj de pared: cada tick (1 s) calcular `madridDay(now).date` y la hora local; si `hour:minute >= 08:00` y no existe `digest_runs(day, 'daily')`, ejecutar.
- La clave de idempotencia es `(day, kind)` en la base de datos, no el cron. Así, aunque el proceso se reinicie a las 08:01, no repite; y si estuvo caído a las 08:00, lo envía al arrancar (con `late = true` en el mensaje).
- Usar `madridDay(now).start` y `.end` para la ventana, nunca `now - 24h`. En el día de 25 horas, `end - start` es 25 h y el digest debe incluir ese día completo.
- No usar `CRON_TZ`/`TZ` del contenedor como única fuente: el contenedor puede correr en UTC. El cálculo debe ser explícito con `Intl` como ya hace `madrid-day.ts`.
- Test de regresión del parser de offset: `src/lib/madrid-day.ts:42` asume `GMT+HH:MM`; si el runtime devuelve `GMT+1` o `GMT`, cae a offset 0 y desplaza el día. Fijar ICU/`full-icu` y probar los dos cambios de hora.

**Warning signs:**
- Dos mensajes de digest el último domingo de octubre.
- Ningún digest el último domingo de marzo.
- El digest llega a las 07:00 o 09:00 en lugar de las 08:00 tras un cambio de hora.
- `madridDay` devuelve un `start` que no coincide con medianoche en Madrid (test con fechas de transición).

**Phase to address:** F3.

**Tests antes de enviar:**
- `tests/digest-schedule.test.ts`: 2027-03-28 02:30 Madrid no existe → el planificador no ejecuta a esa hora y ejecuta a la primera hora válida; 2027-10-31 02:30 ocurre dos veces → una sola ejecución.
- Reinicio simulado a las 08:00:30 tras un envío correcto → cero envíos.
- Worker caído de 07:00 a 09:00 → un envío con `late = true`, ventana del día correcta.

---

### Pitfall 8: 429, `retry_after` y límites por chat sin cola persistente

**What goes wrong:**
Telegram devuelve `429 Too Many Requests` con `parameters.retry_after` (segundos) cuando se supera el límite por chat (aproximadamente 1 mensaje/s y 20/min en grupos). Un `for` que envía N contenedores en bucle, o un digest que itera hosts, dispara 429 a la tercera petición. Si el código reintenta en el acto, empeora; si ignora el error, pierde mensajes. Si el proceso muere a mitad, no sabe qué se envió.

**Why it happens:**
`src/lib/push.ts:14-33` usa `Promise.allSettled` y descarta el error (solo `console.error`). No hay cola, no hay backoff, no hay estado de entrega. El envío de Telegram se diseñará probablemente copiando esa forma.

**How to avoid:**
- Tabla `notification_outbox(id, dedupeKey UNIQUE, payload, attempts, nextAttemptAt, status, lastError, sentAt, telegramMessageId)`.
- Un único despachador en el worker (no en la ruta HTTP) que toma lotes de 1, respeta `retry_after` como `nextAttemptAt`, y aplica backoff exponencial con jitter para 5xx y errores de red.
- `dedupeKey` estable: `incident:<id>:open`, `incident:<id>:digest:<day>`, `action:<callbackNonce>:result`. El `INSERT ... ON CONFLICT DO NOTHING` es la garantía contra duplicados, no un `Set` en memoria.
- Un mensaje por incidencia, no un mensaje por contenedor: reduce la presión sobre el límite por chat.
- Presupuesto: máximo ~20 mensajes/minuto por chat; el resto se agrupa o se difiere al digest.

**Warning signs:**
- `429` en los logs de `sendMessage` sin `retry_after` respetado.
- Mensajes que llegan en orden distinto al de los eventos.
- El outbox crece sin vaciarse (egress bloqueado, token inválido).

**Phase to address:** F2 (outbox) y F3 (lotes del digest).

**Tests antes de enviar:**
- `tests/outbox.test.ts`: dos encolados con el mismo `dedupeKey` producen una sola fila.
- Mock de `fetch` que devuelve 429 con `retry_after: 7` → no se reintenta antes de 7 s y `attempts` no se incrementa como fallo permanente.
- Fallo 500 persistente → `status = 'failed'` tras N intentos y alerta operativa, sin bucle infinito.

---

### Pitfall 9: Telegram reintenta el webhook y la acción se ejecuta dos veces

**What goes wrong:**
Si el webhook responde con timeout, 5xx o tarda más que el timeout de Telegram, Telegram reenvía **el mismo update** (mismo `update_id`). Si el handler ejecuta la acción antes de responder, un reinicio del hub entre la ejecución y el `200` produce un reinicio de contenedor duplicado. Peor: el mismo `callback_query.id` puede llegar dos veces y `answerCallbackQuery` no es idempotente desde el punto de vista del usuario.

**Why it happens:**
Se confunde "recibir un update" con "ejecutar una acción". El handler HTTP hace trabajo síncrono (llamar al agente, que puede tardar 15 s en un `update-container`) y responde al final. No hay deduplicación por `update_id` ni por `callback_query.id`.

**How to avoid:**
- Responder `200` a Telegram en < 1 s, siempre, tras validar el secreto y persistir el update en `telegram_updates(updateId PRIMARY KEY, receivedAt, processedAt, payload)` con `ON CONFLICT DO NOTHING`. Si ya existe, `200` y salir.
- El trabajo real lo hace el worker desde una cola (`telegram_actions`), no la ruta del webhook. Así el timeout de Telegram no depende de la latencia del agente.
- `drop_pending_updates: false` al registrar el webhook y una tarea de arranque que procese pendientes; no volver a registrar el webhook en cada deploy sin querer.
- `answerCallbackQuery` se llama una vez por `callback_query.id`, y si falla por "query is too old" se registra y se continúa; no se reintenta la acción.

**Warning signs:**
- `update_id` repetidos en los logs.
- Dos `operations` con el mismo `target` y `action` en menos de un minuto, con `userId` del bot.
- Un `update-container` que responde 502 al hub pero el contenedor sí se recreó.

**Phase to address:** F4.

**Tests antes de enviar:**
- `tests/telegram-webhook.test.ts`: el mismo `update_id` dos veces → una fila en `telegram_updates`, una acción encolada, dos respuestas 200.
- Webhook con el agente lento (mock de 20 s) → la respuesta HTTP sigue siendo 200 en < 1 s.
- Reenvío tras un reinicio simulado → el update pendiente se procesa una sola vez.

---

### Pitfall 10: Webhook sin `secret_token` y chocando con el gate de `Origin`

**What goes wrong:**
Dos fallos opuestos en la misma ruta. (a) Si el webhook se cuelga del catch-all `src/app/api/[...path]/route.ts`, el gate `if (mutation && !origins.includes(request.headers.get("origin") ?? ""))` (`route.ts:111-113`) devuelve **403** porque Telegram no envía cabecera `Origin`. (b) Si se "arregla" excluyendo la ruta del gate, cualquiera que descubra la URL puede inyectar updates falsos. Además, `auth.api.getSession` (`route.ts:155-156`) devuelve 401: Telegram no trae cookie de sesión.

**Why it happens:**
El gate de origen se diseñó para navegadores, donde `Origin` es la defensa CSRF. Un webhook es una llamada máquina-a-máquina sin navegador ni sesión. Reutilizar el mismo handler obliga a elegir entre romper el webhook o debilitar el CSRF.

**How to avoid:**
- Ruta dedicada `src/app/api/telegram/webhook/route.ts`, **fuera** del catch-all y sin pasar por `origins` ni por `getSession`.
- Autenticación propia: `X-Telegram-Bot-Api-Secret-Token` comparado con `timingSafeEqual` contra `TELEGRAM_WEBHOOK_SECRET` (≥32 bytes aleatorios), rechazo 401 sin cuerpo útil. Configurar `setWebhook` con `secret_token`.
- Validar también `Content-Type: application/json`, límite de cuerpo (por ejemplo 64 KB) y forma con Zod antes de tocar la base de datos.
- No aceptar `chat_id` ni `user_id` del payload como autorización: se comparan con `TELEGRAM_OPERATOR_USER_ID` y `TELEGRAM_CHAT_ID` configurados en el servidor.
- Documentar que la URL del webhook no es un secreto; el secreto va en la cabecera. Si se usa un path secreto, sigue siendo defensa en profundidad, no la única.

**Warning signs:**
- 403 en el webhook con `origin` ausente.
- 401 de sesión en los logs de Telegram.
- El webhook responde 200 a un `curl` sin cabecera de secreto.
- `getWebhookInfo` muestra `last_error_message` con 403/401.

**Phase to address:** F4.

**Tests antes de enviar:**
- `tests/telegram-webhook.test.ts`: POST sin `X-Telegram-Bot-Api-Secret-Token` → 401; con secreto incorrecto → 401; con secreto correcto y `update_id` nuevo → 200 y una fila.
- POST con `Origin` ausente y secreto correcto → 200 (no 403).
- POST con cuerpo > límite → 413 sin escribir en `telegram_updates`.

---

### Pitfall 11: `callback_data` tratado como confiable (y el límite de 64 bytes)

**What goes wrong:**
El `callback_data` de un botón inline lo elige el servidor al enviar, pero **vuelve del cliente** y el cliente puede modificarlo: no es un canal seguro, es input no confiable. Un diseño habitual es `restart:<hostId>:<containerId>` y el handler confía en esos valores. Además, Telegram limita `callback_data` a **1–64 bytes**: un payload firmado con acción + host + id + nonce + expiración + HMAC supera los 64 bytes y el `sendMessage` falla con `BUTTON_DATA_INVALID`, a menudo solo en producción con ids largos.

**Why it happens:**
Se piensa en el botón como una función RPC firmada por el servidor. En realidad es un formulario pre-rellenado que el usuario puede reescribir (cliente no oficial, proxy, replay). Y el límite de 64 bytes se descubre al añadir el segundo campo.

**How to avoid:**
- `callback_data` = identificador opaco de 16–22 bytes (por ejemplo base64url de un UUID v4), y **todo** el contexto en una tabla `telegram_callbacks(id, action, hostId, target, expectedState, createdAt, expiresAt, usedAt, userId, messageId)`.
- Al recibir el callback: buscar por `id`, comprobar `expiresAt`, `usedAt IS NULL`, `userId`, `messageId` y que `action`/`hostId`/`target` sigan siendo válidos contra el estado actual. Nunca ejecutar lo que venga en `data`.
- Presupuesto de bytes como test: `Buffer.byteLength(data) <= 64`, y un test que falle si el formato crece.
- Los botones de "abrir vista" usan `url` (deep link al hub), no `callback_data`; eso no consume el límite y no ejecuta nada.

**Warning signs:**
- `BUTTON_DATA_INVALID` al enviar.
- Un callback con `data` que no corresponde a ninguna fila de `telegram_callbacks`.
- Acciones ejecutadas sobre un `hostId` que no está en `NAS_HOSTS`.

**Phase to address:** F4.

**Tests antes de enviar:**
- `tests/telegram-callbacks.test.ts`: `data` manipulado con otro `hostId` no ejecuta nada y responde `answerCallbackQuery` con aviso.
- `data` de más de 64 bytes nunca se genera (test del builder).
- Nonce expirado → no ejecuta y marca el mensaje como caducado.

---

### Pitfall 12: Botón obsoleto y replay del mismo callback

**What goes wrong:**
El usuario abre el mensaje de la incidencia a las 09:00, el contenedor se recupera a las 09:05 y a las 09:30 pulsa "Reiniciar". El botón sigue ahí y el handler no comprueba el estado: reinicia un servicio sano. O el usuario pulsa dos veces seguidas y se ejecutan dos operaciones. O reenvía el mismo callback capturado con un cliente no oficial y se repite la acción.

**Why it happens:**
El mensaje de Telegram es un snapshot inmutable; el estado del hub cambió desde entonces. No hay `expectedState` ni versión de incidencia en el callback, ni `usedAt`, ni edición del mensaje tras la acción.

**How to avoid:**
- Guardar `expectedState` (por ejemplo `containerState = "running"`, `incidentVersion`) en `telegram_callbacks` y compararlo con el estado actual justo antes de ejecutar. Si no coincide, responder con `show_alert` "El estado ha cambiado" y editar el mensaje.
- Consumo único atómico: `UPDATE telegram_callbacks SET usedAt = now() WHERE id = $1 AND usedAt IS NULL RETURNING *`; si no devuelve fila, es replay.
- Tras la acción, `editMessageText` para quitar los botones (`reply_markup: { inline_keyboard: [] }`) y mostrar el resultado. Si la edición falla, no se repite la acción.
- TTL corto (por ejemplo 15 min) para acciones y 24 h para "abrir vista".
- `operations.id` (idempotencia) se genera **en el servidor** al consumir el callback y se guarda en `telegram_callbacks.operationId`, no se reutiliza el `callback_query.id`.

**Warning signs:**
- Dos `operations` con el mismo `target` y `action` separadas por segundos.
- Botones visibles en mensajes de incidencias ya resueltas.
- `usedAt` con más de un valor por callback (debería ser único).

**Phase to address:** F4.

**Tests antes de enviar:**
- Doble POST del mismo callback → una sola operación y la segunda respuesta no ejecuta.
- Estado cambiado entre envío y pulsación → 0 operaciones y aviso al usuario.
- Tras ejecutar, el mensaje editado no contiene `inline_keyboard` (assert sobre la llamada a `editMessageText`, no sobre el texto).

---

### Pitfall 13: `idempotency-key` reutilizada con distinta acción u objetivo

**What goes wrong:**
La comprobación de idempotencia actual solo compara el host: `route.ts:426-437` y `lifecycle.ts:102-114` buscan por `operations.id` y, si existe y el host coincide, devuelven la operación anterior **sin comprobar `action` ni `target`**. Un botón de Telegram que reutilice una clave (o un cliente que la reutilice por error) recibe un `ok: true` de una operación que hizo otra cosa. El usuario cree que reinició `sonarr` y en realidad se ejecutó un `stop` de `radarr` hace diez minutos.

**Why it happens:**
La clave se trata como "id de operación", no como "clave de esta intención concreta". El contrato no liga la clave a `(action, target, hostId)`.

**How to avoid:**
- Al reutilizar una clave, comparar `action`, `target` y `hostId` con la operación almacenada; si difieren, `409 Conflict`.
- Guardar un hash de la intención (`sha256(action|target|hostId)`) en `operations` y compararlo.
- Para Telegram, generar la clave en el servidor a partir de `callbackId` y no aceptarla del cliente.
- No reutilizar claves entre chat y navegador: prefijos distintos (`tg:` / `web:`) y validación de que el `userId` de la operación coincide con el actor.

**Warning signs:**
- Un `200 ok` con un `operation.action` distinto del que pidió el cliente.
- Claves de idempotencia repetidas con `target` distinto en la tabla `operations`.

**Phase to address:** F4, con corrección previa en F2 (la ruta actual ya es incorrecta).

**Tests antes de enviar:**
- `tests/api-lifecycle.test.ts`: misma clave, mismo host, distinto `action` → 409 y ninguna llamada al agente.
- Misma clave, mismo `action`, distinto `target` → 409.
- Misma clave, mismo `action` y `target` → replay con la operación original (una sola llamada al agente).

---

### Pitfall 14: Cualquiera que vea el mensaje puede pulsar

**What goes wrong:**
El bot se añade a un grupo, o el operador reenvía el mensaje a "Guardados", o comparte una captura y alguien con acceso al chat pulsa. Los botones inline no tienen noción de "solo el destinatario original". Si el handler autoriza por `chat_id` y no por `from.id`, cualquier miembro del grupo ejecuta acciones destructivas.

**Why it happens:**
Se asume que el chat privado es el perímetro. Telegram separa `message.chat.id` (dónde está el mensaje) de `callback_query.from.id` (quién pulsa). En grupos y canales no coinciden. Además, el `chat_id` de un grupo es tan conocido como el del bot.

**How to avoid:**
- Verificar **ambos**: `callback_query.from.id === TELEGRAM_OPERATOR_USER_ID` y `callback_query.message.chat.id === TELEGRAM_CHAT_ID`. Si no, `answerCallbackQuery` genérico y descartar.
- El bot solo responde en el chat privado configurado; si se añade a un grupo, `my_chat_member` lo detecta y se sale o se ignora.
- Para acciones destructivas, además del `from.id`, exigir step-up del hub (Pitfall 15): la identidad de Telegram no es un segundo factor.
- No incluir datos sensibles (IPs, rutas, tokens) en el texto del mensaje; el chat puede estar sincronizado en varios dispositivos.

**Warning signs:**
- Callbacks con `from.id` distinto del operador.
- El bot aparece en `getChatAdministrators` de un grupo.
- Acciones ejecutadas sin un `userId` del hub asociado.

**Phase to address:** F4.

**Tests antes de enviar:**
- `tests/telegram-authz.test.ts`: callback de otro `from.id` → 0 operaciones, respuesta de alerta; mismo `from.id` en otro chat → 0 operaciones.
- `my_chat_member` con `new_chat_member.status = "member"` en un grupo → el bot no procesa callbacks de ese chat.

---

### Pitfall 15: Acción destructiva desde Telegram sin step-up real

**What goes wrong:**
`guardSensitiveAction` (`src/lib/verification-api.ts:91-110`) requiere un `VerificationSession` con `session.id` y un registro en `recent_verification` creado por Better Auth tras un passkey o password. Un callback de Telegram no tiene sesión: si se fabrica una sesión para el bot, se salta el control; si no se llama al guard, la acción destructiva queda protegida solo por el token del bot. Un teléfono robado o un bot comprometido reinicia el NAS o purga la papelera.

**Why it happens:**
Se confunde "autenticación del canal" (Telegram) con "verificación reciente del operador" (passkey). El guard actual está atado a la sesión web, y el bot no la tiene.

**How to avoid:**
- Definir en un único módulo `src/lib/sensitive-actions.ts` la lista de acciones que exigen step-up: `reboot`, `remove-container`, `purge`, `empty-trash`, `update-container`, `clean-images`, `reconnect-apps`, `host-command` destructivo y merge de Renovate.
- Para Telegram, no fabricar sesión: el callback encola una **solicitud de confirmación** y el bot responde con un enlace profundo al hub (`https://hub/…/confirm?token=…`). El operador confirma con passkey en el hub; el hub marca la solicitud como verificada y el worker ejecuta la acción con el `userId` real y un `verificationId` guardado.
- Alternativa aceptable si el deep link no es viable: segundo paso en el bot con un código TOTP del hub, nunca solo "pulsa otra vez".
- La confirmación caduca (60–120 s), es de un solo uso y está ligada a `(action, hostId, target, expectedState)`.
- Toda acción desde Telegram se registra en `operations` con `actor = "telegram"` y `verificationId`; el listado del hub debe mostrarlo.

**Warning signs:**
- `operations` con `userId` del bot o sin `verificationId` para una acción destructiva.
- Un callback que ejecuta `reboot` sin ningún paso adicional.
- `recent_verification` con `method` inventado (`telegram`).

**Phase to address:** F5, pero F4 no debe publicar acciones destructivas hasta que F5 esté cerrado.

**Tests antes de enviar:**
- `tests/telegram-stepup.test.ts`: callback `reboot` sin confirmación → 0 operaciones y una solicitud `pending`; confirmación caducada → 0 operaciones.
- Confirmación con passkey (mock de `recordRecentVerification`) → una operación con `verificationId` no nulo.
- La lista de acciones protegidas es única: un test enumera todas las rutas y falla si una acción destructiva no está en la lista.

---

### Pitfall 16: El token del bot acaba en logs, URLs y trazas

**What goes wrong:**
La Bot API exige el token en el path (`/bot<token>/sendMessage`). Cualquier log de la URL, un `fetch failed` con `input`, un `curl -v`, un error de proxy o una captura del panel de red lo exponen. En `media-stack`, `security-monitor` ya lo mitiga (`main.py:297-299` evita imprimir el mensaje de la excepción), pero el hub no tiene esa disciplina y el token será nuevo.

**Why it happens:**
El token es parte de la URL por diseño de Telegram, así que los logging middleware, los APM y los mensajes de error lo capturan sin que nadie lo escriba a propósito. Además, el webhook puede configurarse con el token en el path si no se usa `secret_token`.

**How to avoid:**
- Un `redact()` en `src/lib/telegram/client.ts` que sustituya `bot\d+:[A-Za-z0-9_-]+` por `bot<redacted>` en cualquier cadena antes de loguear.
- Nunca construir la URL con `console.log` ni incluirla en errores de dominio; los errores propios llevan `status` y `error_code`, no `url`.
- `TELEGRAM_BOT_TOKEN` solo en el servidor (nunca `NEXT_PUBLIC_`), fuera de `NEXT_PUBLIC_*`, y validado al arranque (F5). No exponerlo en `/api/settings` ni en el snapshot.
- Webhook con `secret_token` en cabecera, no token en el path.
- Rotación documentada: `revoke` en BotFather + actualizar `.env` + reiniciar; el token viejo deja de funcionar.

**Warning signs:**
- `grep -R "bot[0-9]" logs/` devuelve algo.
- Errores 401 de Telegram con la URL completa en el mensaje.
- El token aparece en una respuesta de la API del hub.

**Phase to address:** F4 (cliente) y F5 (validación/rotación).

**Tests antes de enviar:**
- `tests/telegram-redact.test.ts`: un error con `https://api.telegram.org/bot123456:ABC-DEF/sendMessage` se serializa sin `123456:ABC-DEF`.
- Un 401 simulado no incluye la URL en el JSON de error de la API.
- El endpoint de settings no devuelve ninguna variable `TELEGRAM_*`.

---

### Pitfall 17: La allowlist del agente frente al nuevo ingress

**What goes wrong:**
`agent/server.py:453` exige `ALLOWED_IPS` y token; por defecto `127.0.0.1`. Al añadir un webhook, alguien puede pensar que Telegram debe alcanzar el agente (no es así) y abrir el puerto 9450 al rango de Telegram, o poner el agente detrás del mismo reverse proxy que el hub. Entonces la allowlist ve la IP del proxy (a menudo `127.0.0.1` o la red de Docker) y deja de filtrar; el token pasa a ser la única barrera de un servicio que equivale a root.

**Why it happens:**
Se confunde el ingress del hub (público, HTTPS) con el del agente (privado, Tailscale). La ruta del webhook y la ruta del agente comparten reverse proxy y configuración de red.

**How to avoid:**
- El webhook de Telegram termina **solo** en el hub (`app`). El hub llama al agente desde su propia IP de Tailscale/Docker, que ya está en `ALLOWED_IPS`.
- No añadir rangos de Telegram a `ALLOWED_IPS`. Documentarlo en `agent/MAINTENANCE.md` y en el README.
- No publicar `9450` en el reverse proxy público. Si se usa proxy interno, que preserve la IP de origen (`proxy_protocol`/`X-Forwarded-For` solo si el agente lo valida; hoy no lo hace).
- El hub no debe reenviar el `callback_data` ni el payload de Telegram al agente: solo la acción ya validada y normalizada.
- Verificar en un test de configuración que `ALLOWED_IPS` del ejemplo no contiene `0.0.0.0/0` ni rangos públicos.

**Warning signs:**
- `9450` accesible desde fuera de Tailscale.
- `ALLOWED_IPS` con un CIDR amplio o con la subred del proxy público.
- Requests al agente con `Authorization` válido desde una IP no esperada.

**Phase to address:** F4 (diseño de red) y F5 (validación de configuración).

**Tests antes de enviar:**
- `agent/test_server.py`: request desde una IP fuera de `ALLOWED_IPS` → 401 aunque el token sea correcto (ya cubierto; ampliar a IP de proxy).
- Test de configuración: `ALLOWED_IPS=0.0.0.0/0` se rechaza al arrancar el agente.

---

### Pitfall 18: Estado en memoria que muere al reiniciar

**What goes wrong:**
`src/lib/collector.ts:16-19` guarda `started` y `alertSnapshotAt` en `Map`s del proceso. Al reiniciar el worker (deploy, OOM, `docker compose up`), se pierde el tiempo acumulado de las condiciones con `duration`: una CPU al 95 % sostenida durante 4 minutos no alerta porque el contador vuelve a 0. Al contrario, `alertSnapshotAt` se reinicia y la primera pasada reevalúa todos los snapshots de golpe, lo que en un arranque con maintenance degradado puede resolver o abrir incidencias por una lectura incompleta.

**Why it happens:**
El estado de negocio vive en memoria porque es barato, pero el worker es efímero. La tabla `alerts` no guarda `firstSeenAt` ni `lastEvaluatedAt`, así que la memoria es la única fuente.

**How to avoid:**
- Persistir `firstSeenAt` en la incidencia (o en una tabla `condition_state(hostId, key, failingSince, lastHealthyAt)`), y calcular la duración contra eso, no contra el `Map`.
- `started`/`alertSnapshotAt` pasan a ser cachés de rendimiento, nunca la fuente de verdad: si falta, se reconstruye desde la base de datos o se trata como "sin datos" (no como "recién empezado").
- En el arranque, esperar una muestra válida antes de evaluar snapshots; no evaluar con la primera lectura si `degraded` no está vacío.
- Idempotencia del arranque: la transición `open` es `ON CONFLICT DO NOTHING` sobre `(hostId, key)` abierta.

**Warning signs:**
- Después de cada deploy, un minuto sin alertas y luego una ráfaga.
- Incidencias con `at` de hace días que se resuelven y reabren tras reiniciar.
- Alertas de CPU que nunca se disparan en hosts con picos reales de 5 minutos.

**Phase to address:** F2.

**Tests antes de enviar:**
- `tests/collector-restart.test.ts`: simular dos procesos sobre la misma base; el segundo no reinicia `failingSince` y alerta al cumplirse la duración.
- Arranque con maintenance degradado → no resuelve ninguna incidencia existente.
- Reconstrucción desde `condition_state` sin `Map` produce el mismo resultado.

---

### Pitfall 19: Relojes mezclados: `alerts.at` de PostgreSQL y `resolvedAt` de Node

**What goes wrong:**
`condition()` inserta sin `at`, así que `alerts.at` usa `defaultNow()` de PostgreSQL (`src/lib/schema.ts:143`), pero `resolvedAt` se escribe con `new Date(now)` del proceso Node (`collector.ts:51`). Si la base de datos y el worker no comparten reloj exacto (contenedor distinto, host distinto, NTP desfasado), una incidencia puede tener `resolvedAt < at`, duración negativa, y caer fuera de la ventana del digest. Además, las muestras se guardan con `metrics.timestamp` del **agente** (`collector.ts:158`), no con la hora de recepción, y la detección de conexión compara ese reloj con `Date.now()` (`collector.ts:125`, `route.ts:452`).

**Why it happens:**
Cada capa usa su reloj local porque es lo cómodo. No hay una política de "reloj de referencia" ni un `receivedAt`. La documentación de `CONCERNS.md` ya señala el skew del agente, pero no la mezcla `at`/`resolvedAt`.

**How to avoid:**
- Elegir el reloj del **servidor de aplicación** como referencia para incidencias, ventanas y digests. Pasar `at: new Date(now)` explícito en el `insert`, igual que `resolvedAt`.
- Guardar en `samples` tanto `receivedAt` (servidor) como `agentAt` (`metrics.timestamp`), y usar `receivedAt` para frescura, conexión y ventanas de incidencia.
- Clampear `agentAt` a una ventana plausible (±5 min) y marcar `clockSkew` en la muestra cuando se recorte; no usarla para cálculos de negocio.
- En el digest, filtrar por `openedAt`/`resolvedAt` del servidor, nunca por `samples.at`.
- Test de skew: agente con reloj +1 h no debe abrir una incidencia de conexión ni sacar una incidencia de la ventana.

**Warning signs:**
- `resolvedAt < at` en alguna fila.
- Incidencias que "duran" 0 s o 25 h.
- El host aparece desconectado justo después de un cambio de hora o de un reinicio del agente.

**Phase to address:** F2 (modelo) y F3 (ventanas).

**Tests antes de enviar:**
- `tests/incidents-clock.test.ts`: base de datos con `now()` adelantado 30 s no produce duraciones negativas.
- Agente con `timestamp` 1 h en el futuro → `receivedAt` manda, sin incidencia de conexión.
- Digest con incidencia en el borde del día → aparece una sola vez.

---

### Pitfall 20: Tres emisores de Telegram y dos fuentes de verdad

**What goes wrong:**
Hoy escriben al mismo chat: `media-backup.sh` (fallo de copia, `alert()` en la línea 137), `security-monitor` (`telegram()` en `main.py:168`, digest de CVEs) y WUD (`WUD_TRIGGER_TELEGRAM_*` en `stacks/monitoring/compose.yaml:92-96`). Si el hub añade su propio bot sin retirar los anteriores, un fallo de copia produce dos mensajes (media-stack y hub), y un fallo de release puede producir tres (backup, hub, WUD). Peor: "¿está arreglado?" tiene dos respuestas, porque `last-status` dice `failed` hasta la siguiente copia correcta, el hub dice "recuperado" cuando su snapshot lo ve, y `security-monitor` lleva su propio `notified-updates.json`.

**Why it happens:**
Cada servicio resolvió su notificación por su cuenta, en repos y despliegues distintos. No hay un contrato de "quién es el dueño de la entrega". El hub ya lee `last-status` y `failed-release.json`, así que la duplicación es estructural, no accidental.

**How to avoid:**
- Regla de propiedad: **el hub es el único que habla con Telegram**. `media-stack` deja de enviar y sigue escribiendo sus archivos de estado; WUD se configura con `WUD_TRIGGER_TELEGRAM_TELEGRAM_THRESHOLD` desactivado o se elimina el trigger.
- Migración por fases: primero el hub replica lo que ya ve (backup, releases), se verifica paridad, y después se apagan los emisores de `media-stack` en un commit separado con su CI.
- Una sola fuente de verdad por evento: `last-status` para copia, `failed-release.json` + historial para releases, `last-status.json` para security. El hub **lee**, no deduce de mensajes.
- Si `security-monitor` debe seguir enviando su digest diario, el hub no lo duplica y lo documenta como excepción; mejor aún, exportar su estado en `/maintenance` y que el hub lo incluya.
- Añadir un `notifiedBy`/`source` a cada mensaje para poder auditar el origen durante la transición.

**Warning signs:**
- Dos mensajes con el mismo texto o el mismo fallo en menos de un minuto.
- `grep -R "api.telegram.org"` en ambos repos devuelve más de un emisor después del milestone.
- El chat muestra "Backup failed" de media-stack y "Copia fallida" del hub.

**Phase to address:** F1 (inventario de emisores) y F2 (propiedad de entrega).

**Tests antes de enviar:**
- Test de contrato en `media-stack`: con `TELEGRAM_BOT_TOKEN` vacío, el flujo de copia sigue escribiendo `last-status` y no falla por no notificar (ya existe en `tests/backup.test.sh:289`).
- Test en el hub: un `last-status = failed` produce exactamente un mensaje, y el segundo ciclo no repite.
- Checklist de migración: WUD sin trigger de Telegram, `security-monitor` sin `TELEGRAM_*` o con excepción documentada.

---

### Pitfall 21: Cron muerto que nadie nota (backup "ok" para siempre)

**What goes wrong:**
`backup_section()` (`agent/maintenance.py:245-259`) devuelve `{status, at}`. `maintenanceAlertSignals` (`src/lib/maintenance-alerts.ts:61-75`) solo emite señal si `status === "ok"` o `"failed"`; **ignora `at`**. Si el contenedor de backup muere, el cron se rompe o `supercronic` no arranca, `last-status` se queda en `ok` con la fecha de la última copia buena. Ni media-stack (no ejecuta `finish()`) ni el hub alertan. El usuario descubre que no tiene copias el día que necesita restaurar. El mismo patrón aplica a `security-monitor` y a su `last-status.json`.

**Why it happens:**
Se alerta de fallos, no de ausencia. Es el sesgo clásico de la monitorización: el silencio se interpreta como salud. Además, el healthcheck de `stacks/backup/compose.yaml:35` solo mira que el archivo exista y empiece por `ok`; un archivo viejo pasa el check.

**How to avoid:**
- Añadir una condición de frescura en `maintenanceAlertSignals`: si `backup.at` es nulo o tiene más de `BACKUP_MAX_AGE_HOURS` (por ejemplo 36 h para un cron diario), emitir `backup-stale` con severidad `critical`.
- Lo mismo para `security.at` y para el `last-status.json` del monitor.
- Healthcheck real: comparar `at` con `now`, no solo el prefijo. Un `ok` de hace tres días debe marcar unhealthy.
- Dead-man switch externo opcional: si el hub no recibe un snapshot en X horas, alertar por otro canal (el propio hub caído no puede avisar de sí mismo).
- El digest debe mostrar "última copia: hace X h" para que la ausencia sea visible aunque no haya alerta.

**Warning signs:**
- `backup.at` con más de 24 h en `/maintenance`.
- Healthcheck `healthy` con un `last-status` de la semana pasada.
- Cero mensajes de copia durante días, que se interpreta como "todo bien".

**Phase to address:** F2 (frescura) y F3 (visibilidad en el digest).

**Tests antes de enviar:**
- `tests/maintenance-alerts.test.ts`: snapshot con `backup.status = "ok"` y `at` de hace 40 h → señal `backup-stale` con `failing: true`.
- `at` de hace 2 h → sin señal.
- `at` nulo con `status` desconocido → no resuelve una incidencia abierta (comportamiento degradado).

---

### Pitfall 22: El contrato `media-stack` → hub se rompe en silencio

**What goes wrong:**
El hub parsea `last-status` como `"<ok|failed> <ISO>"` (`agent/maintenance.py:250-258`) y `failed-release.json` con campos `since`, `release`. Si media-stack cambia el formato, añade un prefijo, escribe JSON en `last-status` o renombra el archivo, el hub obtiene `status: "unknown"`, y `maintenanceAlertSignals` **no emite ninguna señal**. Una incidencia abierta se queda abierta para siempre o, peor, se resuelve porque la sección no está en `degraded`. `deploymentAlertSignals` ya tiene un parche para el marcador obsoleto (`maintenance-alerts.ts:222-224`), señal de que el contrato es frágil.

**Why it happens:**
Dos repos, dos CI, sin test de contrato. El hub valida con TypeScript tipos que solo existen en compilación; el Python no conoce el esquema. `CONCERNS.md` ya documenta que un JSON corrupto se trata como "sin datos" y puede resolver una alerta real.

**How to avoid:**
- Publicar un contrato versionado (por ejemplo `docs/contracts/maintenance.schema.json`) y validarlo en el hub con Zod en el borde (`src/lib/maintenance.ts`), marcando `degraded` cuando falle.
- En `media-stack`, un test que genere `last-status` y `failed-release.json` reales y los valide contra el esquema compartido (fixture copiado o paquete interno).
- Regla: sección ilegible ⇒ `degraded`, nunca `failing: false`. Aplicar también a `_read_json` (`agent/maintenance.py`) y a `deployments`.
- Versionar el snapshot (`schemaVersion`) y rechazar una versión mayor desconocida en lugar de interpretarla.

**Warning signs:**
- `degraded` vacío con secciones que el hub no entiende.
- Cambios en `media-backup.sh` o `security-monitor` que no tocan ningún test del hub.
- Incidencias de copia/release que no se resuelven tras una recuperación real.

**Phase to address:** F5 (contrato runtime) con verificación en F2.

**Tests antes de enviar:**
- `tests/contract-media-stack.test.ts`: fixture generado por el script de media-stack valida contra el esquema Zod.
- `last-status` con formato inválido → `degraded` contiene `backup` y no se resuelve la incidencia.
- `failed-release.json` truncado → `degraded` contiene `follower`, no `failing: false`.

---

### Pitfall 23: `notify()` después del commit, sin outbox ni reconciliación

**What goes wrong:**
En `condition()` la fila se inserta y **después** se llama a `notify()` (`collector.ts:63-67`). Si el worker cae entre el `INSERT` y el envío, la incidencia queda abierta, `notifiedAt` no existe y nadie reintenta: el mensaje se pierde para siempre. Si el envío tiene éxito pero la escritura posterior falla, no hay constancia. Lo mismo con `src/lib/push.ts:14-33`: `Promise.allSettled` se traga los errores y no hay reintento.

**Why it happens:**
Se usa el proceso como si fuera transaccional. La base de datos y la API de Telegram son dos sistemas; sin patrón outbox, el efecto externo no está ligado al estado.

**How to avoid:**
- Patrón outbox: `transition()` escribe incidencia y `notification_outbox` en la **misma transacción** (`db.transaction`). El despachador es el único que llama a Telegram, marca `sentAt` y reintenta con backoff.
- `notifiedAt` en la incidencia se actualiza al confirmar el envío; el reconciliador compara `open` sin `notifiedAt` y reencola.
- En el arranque, `reconcile()` busca incidencias abiertas sin entrega y las encola.
- Web Push puede seguir siendo best-effort, pero no debe ser el único canal crítico.

**Warning signs:**
- Incidencias abiertas que el usuario no ha visto.
- Reinicios del worker que coinciden con huecos en el histórico de mensajes.
- `push.ts` con errores solo en `console.error`.

**Phase to address:** F2.

**Tests antes de enviar:**
- `tests/outbox-transaction.test.ts`: forzar un fallo tras el `INSERT` de la incidencia y antes de encolar → la transacción revierte y no queda incidencia sin entrega, o queda encolada.
- `reconcile()` sobre una incidencia `open` con `notifiedAt = null` → una fila en el outbox.
- Fallo de `sendMessage` → `attempts` sube y `nextAttemptAt` respeta el backoff.

---

### Pitfall 24: El hub cae y el silencio se confunde con calma

**What goes wrong:**
Si el hub (o el worker) está caído, no hay bot, no hay digest y no hay alertas. `media-stack` sigue a lo suyo y solo habla cuando falla una copia; un fallo de release o una actualización de seguridad quedan en archivos que nadie lee. El usuario ve el chat tranquilo y asume que todo va bien. Al recuperar el hub, no hay compensación: los eventos ocurridos durante la caída no se notifican.

**Why it happens:**
El sistema es pull: el hub lee snapshots. Si el lector muere, la fuente no lo sabe. No hay heartbeat ni dead-man switch.

**How to avoid:**
- Al arrancar el worker, un `catch-up`: leer snapshots y emitir **un** mensaje "hub recuperado; incidencias desde <hora>" con el resumen, no N mensajes atrasados.
- Watchdog externo mínimo (un cron en el host o un servicio de terceros) que avise si `https://hub/api/health` no responde en 15 min. El hub no puede avisar de su propia caída.
- `delivery_lag` visible en el overview: última muestra, último mensaje, última copia, última ejecución de seguridad.
- No enviar mensajes atrasados uno a uno: agrupar por ventana y marcar `late = true`.

**Warning signs:**
- Cero mensajes durante más de 24 h con actividad normal en los hosts.
- `/api/overview` con `lastAt` antiguo.
- Un reinicio del hub sin mensaje de recuperación.

**Phase to address:** F3 (catch-up del digest) y F5 (health/watchdog).

**Tests antes de enviar:**
- `tests/catch-up.test.ts`: worker arranca con dos incidencias abiertas creadas mientras estaba caído → un solo mensaje de recuperación con dos líneas.
- Health endpoint devuelve 200 con base de datos disponible y 503 sin ella.
- El digest no adelanta eventos de la caída como si fueran nuevos.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|---|---|---|---|
| Reutilizar `notify()` de `src/lib/push.ts` para Telegram | Una función para dos canales | Mezcla best-effort (push) con entrega que requiere outbox y 429; impide deduplicar por canal | Nunca para Telegram; solo para Web Push |
| Estado de duración en `Map` del proceso (`collector.ts:16`) | Cero migraciones | Se pierde al reiniciar; alertas que no disparan o disparan tarde | Solo como caché, nunca como fuente de verdad |
| `callback_data` con host/acción/id | Menos tablas | Input no confiable y límite de 64 bytes | Nunca; usar nonce opaco + tabla |
| Enviar desde `media-stack` y desde el hub "por si acaso" | Migración sin coordinación | Doble mensaje y dos fuentes de verdad | Solo durante una transición con feature flag y fecha de apagado |
| Digest con `now() - 24h` | Una línea de SQL | Repite resueltas, se salta DST, no sobrevive a reinicios | Nunca; usar `digest_runs` + `madridDay` |
| Verificar solo en la UI (`CONCERNS.md`) | Menos fricción al añadir rutas | Un session cookie robado ejecuta acciones destructivas | Nunca, y menos con botones de Telegram |
| `ALLOWED_IPS` amplio para "que funcione el webhook" | Depurar rápido | El token pasa a ser la única barrera de un servicio root-equivalente | Nunca |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|---|---|---|
| Telegram Bot API | Reintentar un `429` inmediatamente | Respetar `parameters.retry_after`; backoff con jitter; outbox |
| Telegram webhook | Colgarlo del catch-all con gate de `Origin` | Ruta dedicada, `secret_token` en cabecera, `timingSafeEqual`, sin sesión |
| Telegram webhook | Ejecutar la acción en el handler HTTP | Persistir `update_id`, responder 200 en < 1 s, ejecutar en el worker |
| Telegram inline keyboard | `callback_data` largo o con datos de negocio | ≤ 64 bytes, id opaco, contexto en servidor |
| Telegram `editMessageText` | Tratar "message is not modified" como fallo | Ignorar 400 conocidos y no reenviar |
| Telegram egress | Asumir que el contenedor tiene salida a `api.telegram.org` | Probar egress en CI/health; fallar visible, no silencioso |
| Web Push | `Promise.allSettled` sin métricas | Contar entregas/fallos y borrar suscripciones 404/410 (ya se hace) |
| Agente NAS | Enviar el payload de Telegram al agente | Normalizar la acción en el hub y llamar a la ruta existente |
| `media-stack` → hub | Parsear `last-status` con `split()` sin esquema | Contrato versionado + `degraded` explícito |
| WUD | Dejar el trigger de Telegram activo | Desactivarlo al activar el hub; una sola salida |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|---|---|---|---|
| Un mensaje por contenedor | Ráfaga de N mensajes y 429 | Agrupar por host/incidencia; un mensaje editable | > 5 contenedores o > 3 eventos/min |
| Digest que escanea `samples` | Latencia y CPU en PostgreSQL | Contar sobre `alerts`/`incidents`, no sobre muestras | 30 días de 5 s (≈518k/host) |
| Webhook que espera al agente | Timeouts de Telegram y reintentos | Cola + worker; 200 inmediato | Cualquier acción > 10 s (`update-container` puede tardar minutos) |
| Reenviar el digest completo al editar | Mensajes de 4096 caracteres | Resumen + enlace; truncar con presupuesto | Flotas > 20 hosts o > 30 incidencias |
| Consultar `alerts` sin índice por estado | Overview lento | Índice parcial `WHERE resolvedAt IS NULL` | Miles de incidencias históricas |

## Security Mistakes

| Mistake | Risk | Prevention |
|---|---|---|
| Confiar en `callback_data` | Ejecutar acciones arbitrarias manipulando el payload | Nonce opaco + tabla `telegram_callbacks` + validación de estado |
| Autorizar por `chat_id` y no por `from.id` | Cualquier miembro del grupo ejecuta acciones | Comprobar ambos contra la configuración del servidor |
| Webhook sin `secret_token` | Cualquiera inyecta updates y dispara acciones | Cabecera secreta + `timingSafeEqual` + límite de cuerpo |
| Acción destructiva sin step-up | Robo de teléfono = reinicio/purga del NAS | Deep link a passkey del hub; confirmación de un solo uso con TTL |
| Fabricar una `VerificationSession` para el bot | Se salta `guardSensitiveAction` | Nunca; el step-up ocurre en el hub con el `userId` real |
| Token en logs/URLs | Bot secuestrado; acciones y datos expuestos | `redact()`, errores sin URL, rotación documentada |
| Abrir `9450` al ingress público | Allowlist evadida; root remoto | Mantener el agente en Tailscale; el webhook solo en el hub |
| Reutilizar `idempotency-key` sin comprobar `action`/`target` | Respuesta `ok` de una acción distinta | Comparar intención y `userId`; 409 si difiere |
| Confiar en `Origin` para el webhook | 403 (rompe) o bypass (inseguro) | Ruta separada con autenticación propia |
| Resolver incidencias con snapshot degradado | Falsa sensación de recuperación | `degraded` ⇒ sin señal; nunca `failing: false` |
| Mostrar el token en `/api/settings` | Exfiltración vía XSS | Solo servidor; nunca en respuestas ni en `NEXT_PUBLIC_*` |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---|---|---|
| Mensaje por evento sin contexto | El usuario no sabe qué host ni qué servicio | Título con host + servicio, detalle corto, hora de Madrid |
| Botón sin confirmación destructiva | Pulsación accidental irreversible | Dos pasos con TTL y texto de consecuencia |
| Botón obsoleto que no responde | El usuario pulsa y no pasa nada | Editar el mensaje y avisar "el estado cambió" |
| Digest con resueltas mezcladas | Ruido y falsa urgencia | Secciones "abiertas ahora" / "resueltas en el periodo" |
| Silencio tras resolver | El usuario no sabe si se arregló | Editar el mensaje original con check y hora |
| Hora en UTC | Confusión en el cambio de hora | `Europe/Madrid` explícito en cabecera y en cada fila |
| Enlace "abrir hub" sin deep link | El usuario navega a mano | `url` con `?view=...&host=...&alert=...` |
| Mensajes largos truncados | Se pierde la acción | Resumen + enlace; máximo ~3500 caracteres |

## "Looks Done But Isn't" Checklist

- [ ] **Una notificación por incidencia:** ¿existe una fila de incidencia con `notifiedAt`, o solo se ha cambiado el texto? Verificar la tabla y el outbox, no el mensaje.
- [ ] **Sin aviso de recuperación:** ¿`resolve` crea un mensaje nuevo en algún camino? Verificar con un test que cuente `sendMessage`, no que busque la palabra "Recuperado".
- [ ] **Digest diario:** ¿la idempotencia es `digest_runs(day, kind)` y no un `setInterval`? Verificar reinicio y DST.
- [ ] **Botones:** ¿el `callback_data` mide ≤ 64 bytes y todo el contexto está en servidor? Verificar el builder.
- [ ] **Replay:** ¿el consumo del callback es atómico y de un solo uso? Verificar con dos POST idénticos.
- [ ] **Step-up:** ¿la acción destructiva tiene `verificationId` real o solo el `from.id` de Telegram? Verificar `operations`.
- [ ] **Webhook:** ¿responde 401 sin `secret_token` y 200 con él, sin `Origin` ni cookie? Verificar con curl.
- [ ] **Agente:** ¿`ALLOWED_IPS` sigue siendo privado y el webhook no lo toca? Verificar red y configuración.
- [ ] **Multi-repo:** ¿WUD, backup y security-monitor han dejado de enviar, o hay una excepción documentada? Verificar `grep api.telegram.org`.
- [ ] **Cron muerto:** ¿una copia "ok" de hace 40 h alerta? Verificar `backup.at`.
- [ ] **Contrato:** ¿un `last-status` inválido marca `degraded` y no resuelve? Verificar fixture.
- [ ] **Relojes:** ¿`resolvedAt >= at` siempre? Verificar con la base de datos adelantada.

## Intersección con CONCERNS.md

Estos hallazgos existentes se cruzan directamente con el milestone y deben resolverse en las mismas fases, no en un trabajo paralelo:

| Hallazgo de `CONCERNS.md` | Intersección | Fase |
|---|---|---|
| **Verificación reciente solo en la UI para varias rutas destructivas** (`/api/host-command` sin `guardSensitiveAction`, `/api/action` solo para `reboot`; `update-container`, `purge`, `empty-trash`, `clean-images`, `reconnect-apps`) | El bot de Telegram multiplica la superficie: un botón puede invocar exactamente esas rutas. Si la lista de acciones protegidas sigue implícita, el bot heredará el hueco. Centralizar en `src/lib/sensitive-actions.ts` es requisito de F4/F5. | F5 (bloquea acciones destructivas de F4) |
| **Sin CSP ni HSTS** (`next.config.ts`) | El hub será el destino de deep links de confirmación con un token de un solo uso. Sin CSP, un XSS en el hub puede leer el token de confirmación y completar el step-up. HSTS protege el webhook y los enlaces. | F5 |
| **Secretos de ejemplo que pasan los checks** (`.env.example`, `agent/.env.example`, `agent/.env.apps.example`) | Se añaden `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` y `TELEGRAM_OPERATOR_USER_ID`; si el ejemplo trae valores no vacíos, se repetirá el mismo fallo con un token de bot público. El arranque debe rechazar placeholders. | F5 |
| **Sin validación de configuración al arranque** | Un bot sin token o con chat id vacío debe fallar al arrancar (o deshabilitarse explícitamente), no descubrirse en el primer 401. Igual para el webhook sin secreto. | F5 |
| **Contrato Python↔TS implícito** | `last-status`, `failed-release.json` y los snapshots que alimentan el digest no tienen validación runtime. Sin ella, el digest puede contar como resueltas incidencias que solo están ilegibles. | F5, verificado en F2/F3 |
| **`expectedContainers` obsoleto** | Es una fuente de ruido permanente que el digest amplificará cada día. Debe reconciliarse antes de presumir "una notificación por incidencia". | F2 |
| **Estado en memoria del colector** (`started`, `alertSnapshotAt`) | Cualquier diseño de deduplicación que se apoye en ellos se rompe en cada deploy. Persistir `failingSince`. | F2 |
| **Skew de reloj del agente** | Afecta a la ventana del digest y a la duración de incidencias; usar `receivedAt` del servidor. | F2/F3 |
| **Sin healthchecks de agente/worker** | Un hub "vivo pero atascado" no envía digest y nadie lo nota. Necesario para el dead-man switch. | F5 |

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---|---|---|
| Mensajes duplicados por doble emisor | LOW | Apagar el emisor de `media-stack` (feature flag/commit), verificar paridad, borrar el mensaje duplicado a mano |
| Token del bot filtrado | MEDIUM | `revoke` en BotFather, nuevo token en `.env`, reiniciar hub, rotar el webhook, revisar logs |
| Acción destructiva no autorizada | HIGH | Revisar `operations` y `telegram_updates`, restaurar contenedor/`.env` desde backup, revocar sesiones, rotar `AGENT_TOKEN` si hubo acceso al agente |
| Incidencia fantasma eterna | LOW | Retirar el nombre de `expectedContainers`, resolver la fila con motivo, añadir reconciliación |
| Copia "ok" obsoleta | HIGH | Ejecutar `media-backup run` manual, verificar restic, corregir el cron, añadir alerta de frescura |
| Digest duplicado en DST | LOW | Borrar la fila duplicada de `digest_runs` no; corregir la clave `(day, kind)` y desplegar |
| Webhook en bucle de 403/401 | MEDIUM | Comprobar `getWebhookInfo`, secreto, ruta y reverse proxy; volver a `setWebhook` con `drop_pending_updates: false` |
| Contrato roto con media-stack | MEDIUM | Revertir el cambio de formato, añadir `degraded`, publicar fixture compartido |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---|---|---|
| 1. Alerta por evaluación | F2 | Una fila por `(hostId, key)` abierta; test de doble evaluación |
| 2. Recuperación como mensaje | F2 | `resolve` no llama a `sendMessage`; edita el mensaje |
| 3. Flapping | F2 | Histéresis + cooldown; test de tres ciclos |
| 4. Caída del host ahogada | F2 | Host caído = una incidencia; hijas suprimidas |
| 5. `expectedContainers` congelado | F2 | Nombre ausente se retira con motivo |
| 6. Digest repite resueltas | F3 | `digest_runs` + watermark; dos ejecuciones = un envío |
| 7. DST | F3 | Tests de marzo y octubre; reinicio a las 08:00 |
| 8. 429/`retry_after` | F2/F3 | Outbox respeta `retry_after`; sin bucles |
| 9. Webhook duplicado | F4 | `update_id` único; 200 inmediato |
| 10. Webhook sin secreto / `Origin` | F4 | 401 sin cabecera, 200 con ella y sin `Origin` |
| 11. `callback_data` hostil / 64 bytes | F4 | Nonce opaco; builder ≤ 64 bytes |
| 12. Botón obsoleto / replay | F4 | `usedAt` atómico; estado comparado |
| 13. `idempotency-key` cruzada | F4 (fix en F2) | 409 si `action`/`target` difieren |
| 14. Pulsador no autorizado | F4 | `from.id` y `chat.id` verificados |
| 15. Sin step-up | F5 | `verificationId` real en `operations` |
| 16. Token en logs | F4/F5 | `redact()`; sin URL en errores |
| 17. Allowlist del agente | F4/F5 | `9450` no público; `ALLOWED_IPS` privado |
| 18. Estado en memoria | F2 | Reinicio no reinicia `failingSince` |
| 19. Relojes mezclados | F2/F3 | `resolvedAt >= at`; `receivedAt` manda |
| 20. Tres emisores | F1/F2 | `grep api.telegram.org` = un emisor |
| 21. Cron muerto | F2/F3 | `backup.at` de 40 h alerta |
| 22. Contrato roto | F5 | Fixture compartido; `degraded` explícito |
| 23. Sin outbox | F2 | Transacción + reconciliación |
| 24. Hub caído | F3/F5 | Catch-up agrupado; health/watchdog |

## Sources

- Código de este repo: `src/lib/collector.ts`, `src/lib/push.ts`, `src/lib/maintenance-alerts.ts`, `src/lib/madrid-day.ts`, `src/app/api/[...path]/route.ts`, `src/lib/verification.ts`, `src/lib/verification-api.ts`, `src/lib/host-commands.ts`, `src/lib/lifecycle.ts`, `src/lib/schema.ts`, `src/worker.ts`, `agent/server.py`, `agent/maintenance.py`.
- Código de `media-stack`: `stacks/backup/media-backup.sh`, `stacks/backup/compose.yaml`, `stacks/monitoring/security-monitor/main.py`, `stacks/monitoring/compose.yaml`, `.env.example`.
- `.planning/codebase/CONCERNS.md` (seguridad, zonas frágiles, contratos implícitos, cobertura de tests).
- Telegram Bot API: límites de `callback_data` (1–64 bytes), `retry_after`, `secret_token` de `setWebhook`, `answerCallbackQuery`, límites de mensajes por chat. Verificar contra la versión de la API al implementar.
- Práctica conocida de homelab: dead-man switch para backups, una sola salida de notificaciones, outbox para integraciones externas.

---
*Pitfalls research for: notificaciones homelab y administración remota por chat sobre un agente privilegiado*
*Researched: 2026-11-24*
