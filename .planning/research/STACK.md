# Stack Research

**Dominio:** notificaciones Telegram con inline actions y digest para el hub Next.js de un solo servidor
**Investigado:** 2026-11-24
**Confianza:** HIGH en Bot API, transporte, librería y versiones verificadas; MEDIUM en la política de clasificación `immediate` / `digest`, que es una decisión de producto

> Alcance: solo el delta de notificaciones y Telegram. El stack existente ya está mapeado en
> `.planning/codebase/STACK.md`, `.planning/codebase/ARCHITECTURE.md` y `src/lib/*`; aquí no se
> re-investiga. Las versiones solo se afirman si salen de `package.json`, `pnpm-lock.yaml`, el
> registry de npm o la documentación oficial consultada el 2026-11-24.
>
> Herramientas web disponibles: la Bot API, el FAQ de Telegram, grammY y el registry de npm se
> pudieron consultar; no hay versiones inventadas.

## Stack recomendado

### Tecnologías core

| Tecnología | Versión | Propósito | Por qué se recomienda | Confianza |
|------------|---------|-----------|-----------------------|-----------|
| Telegram Bot API | 10.5 (2026-11-22) | `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getUpdates` | HTTP+JSON estable, sin SDK obligatorio; los métodos que se usan son antiguos y estables dentro de 10.5 | HIGH |
| Long polling en `src/worker.ts` | n/a | Recibir `callback_query` y mensajes | El worker ya es singleton por `pg_try_advisory_lock(734921)`; varios pollers comparten offset y se pisan, y el lock garantiza uno solo, sin ingress público nuevo | HIGH |
| `fetch` nativo + Zod | Node.js 26 / Zod 4.6.7 | Cliente HTTP tipado y validación del `Update` | Ya existen `fetch` y Zod; evita una dependencia de framework para cinco métodos | HIGH |
| `src/lib/madrid-day.ts` + `madridTime` | existente + helper nuevo | Calendarizar el digest en `Europe/Madrid` | Ya resuelve el día civil y los cambios de hora (23/25 h); no se añade cron | HIGH |
| PostgreSQL 18 + Drizzle ORM | 18 / 0.45.4 | Outbox, tokens de callback y estado del bot | Es la única infraestructura durable existente; un outbox transaccional da dedup, retry y auditoría sin Redis | HIGH |
| Vitest + `node:http` | 5.1.0 / Node.js 26 | Tests del cliente, updates y digest | Permite un fake de la Bot API en loopback sin red ni dependencias nuevas | HIGH |

### Librerías de soporte

| Librería | Versión | Propósito | Cuándo se usa | Confianza |
|----------|---------|-----------|---------------|-----------|
| `node:crypto` | Node.js 26 | `randomBytes` para callback tokens y `timingSafeEqual` para el `secret_token` | Siempre: tokens opacos y comparación constante | HIGH |
| `AbortSignal.timeout` | Node.js 26 | Timeout de `sendMessage`/`getUpdates` y cancelación en SIGTERM | En cada llamada HTTP al bot | HIGH |
| `web-push` | 3.6.7 | Canal Web Push existente | Se conserva; la política puede encolar ambos canales, pero no se reescribe | HIGH |
| `tsx` | 4.23.15 | Ejecutar el worker con TypeScript sin build | Sin cambios: el bot corre dentro del worker | HIGH |

### Herramientas de desarrollo

| Herramienta | Propósito | Notas | Confianza |
|-------------|-----------|-------|-----------|
| `getMe` | Validar el token al arrancar | Si devuelve 401, deshabilitar Telegram y seguir recolectando; no tumbar el worker | HIGH |
| `getWebhookInfo` / `deleteWebhook` | Pasar de webhook a polling | `getUpdates` y webhook son mutuamente excluyentes; borrar el webhook una vez si quedó configurado | HIGH |
| `drizzle-kit` | 0.31.11 | Generar la migración de las tablas nuevas; probarla con `tests/migrations.test.ts` | HIGH |
| Fake Bot API con `node:http` | Test de requests, 429 y cuerpos | Escuchar en `127.0.0.1:0`; nunca llamar a `api.telegram.org` en CI | HIGH |

## Instalación

```bash
# No hace falta ninguna dependencia runtime nueva.
# El cliente es src/lib/telegram.ts sobre fetch nativo y Zod.

# Solo si en el futuro el bot crece a conversaciones/menús y se acepta un framework:
# pnpm add grammy@1.48.0
```

Variables de entorno (solo servidor, nunca `NEXT_PUBLIC_*`):

```bash
TELEGRAM_BOT_TOKEN=            # secreto; mismo nombre que ya usa media-stack
TELEGRAM_CHAT_ID=              # chat destino; string, puede ser negativo en grupos
TELEGRAM_ALLOWED_USER_ID=      # id numérico del usuario autorizado a pulsar acciones
TELEGRAM_API_ROOT=https://api.telegram.org   # opcional; permite un Bot API local
TELEGRAM_DIGEST_HOUR=8         # opcional; hora local Europe/Madrid
```

En `compose.yaml`, `app`, `worker` y `migrate` comparten `env_file: .env`. Para mínimo privilegio,
pasar `TELEGRAM_*` solo al servicio `worker` con `environment:` o un `env_file` propio. No es
imprescindible para v1 porque el token nunca llega al navegador, pero reduce la superficie del
contenedor web. El token se puede reutilizar del `.env` de media-stack durante la migración; al
cerrar el corte, rotarlo con BotFather y reiniciar el worker, y no dejarlo en dos repos a la vez.

## Mecánica de la Bot API que importa

| Método / campo | Regla exacta | Uso recomendado | Confianza |
|----------------|--------------|-----------------|-----------|
| `getUpdates` | Devuelve hasta 100 updates; `offset = last_update_id + 1`; `timeout` en segundos para long polling; no funciona si hay webhook | Polling con `offset`, `timeout: 25`, `limit: 10`, `allowed_updates: ["message","callback_query"]` | HIGH |
| `sendMessage` | `text` 1-4096 caracteres después de parsear entidades; devuelve `Message` con `message_id` | Un mensaje por incidencia y un mensaje por digest; guardar `message_id` | HIGH |
| `InlineKeyboardMarkup` | `inline_keyboard` es un array de filas; cada `InlineKeyboardButton` usa exactamente uno de `url`, `callback_data`, etc. | Fila 1: `url` al hub. Fila 2: `callback_data` solo para acciones seguras | HIGH |
| `callback_data` | 1-64 bytes; es datos que envía el cliente, por tanto manipulables | `a:<token>` opaco de 32 bytes base64url (43 chars + prefijo = 45) | HIGH |
| `CallbackQuery` | Exactamente uno de `data` o `game_short_name`; `message` puede faltar o ser inaccesible; `from` es el usuario | Autorizar por `from.id` y por `message.chat.id`; nunca confiar en `data` | HIGH |
| `answerCallbackQuery` | `text` 0-200 caracteres; es obligatorio responder aunque no se muestre texto, o el cliente deja el spinner | Llamarlo primero, incluso en error; `show_alert: true` solo para fallos | HIGH |
| `editMessageText` | `text` 1-4096; requiere `chat_id` + `message_id` (o `inline_message_id`) | marcar resuelto o actualizar estado sin crear otro mensaje | HIGH |
| `editMessageReplyMarkup` | Cambia solo el teclado | Quitar botones obsoletos al resolver; no manda mensaje nuevo | HIGH |
| `setWebhook` | Solo si se elige webhook: `secret_token` 1-256 chars `[A-Za-z0-9_-]`, header `X-Telegram-Bot-Api-Secret-Token`; HTTPS en puertos 443/80/88/8443; sin redirects | No se usa en la recomendación; sí en la variante webhook | HIGH |
| `getWebhookInfo` / `deleteWebhook` | `getUpdates` no funciona con webhook activo | Al arrancar en modo polling: si `url` no está vacío, `deleteWebhook` y reintentar | HIGH |
| `429` | Respuesta `ok:false`, `error_code:429`, `parameters.retry_after` en segundos | No reintentar en caliente; `nextAttemptAt = now + retry_after` | HIGH |

Límites de frecuencia relevantes (FAQ oficial):

- En un chat, no más de ~1 mensaje por segundo; los bursts cortos pueden pasar, pero acaban en 429.
- En un grupo, no más de 20 mensajes por minuto.
- Broadcast global, ~30 mensajes por segundo; con un solo chat es irrelevante, pero el outbox debe
  serializar igualmente para no encadenar ráfagas.
- `429` incluye `retry_after`; se respeta tal cual y se añade jitter pequeño. No se usa un bucle
  `for` de reintentos inmediatos.

Formato y longitud:

- `parse_mode: "HTML"` con un `escapeHtml` para `&`, `<`, `>`; o texto plano. No usar Markdown con
  texto dinámico: un `_` o `*` en un nombre de contenedor rompe el parseo.
- `link_preview_options: { is_disabled: true }` es el campo actual. `disable_web_page_preview`, que
  usan `security-monitor/main.py` y `issue-automator/main.py`, está obsoleto; se reemplaza al migrar.
- Digest: tope conservador de 3500 caracteres y 20 items; si sobran, `+N más` y un botón `url` a la
  vista de alerts. `sendMessage` no admite más de 4096 y un digest largo se perdería.
- Incidencia: 1-3 líneas y botones. No incluir el detalle completo del snapshot.
- Botones `url`: construir la URL con `BETTER_AUTH_URL` (la base pública que ya exige
  `src/lib/auth.ts`), por ejemplo `${BETTER_AUTH_URL}/?view=alerts&host=<hostId>`. No usar
  `NEXT_PUBLIC_APP_DOMAIN` (es solo el dominio) ni rutas relativas. Los parámetros `?view=` y
  `?host=` son los que ya lee `src/components/views/routes.ts`.

Una sola notificación por incidencia:

- En el alta se envía una vez; en la recuperación **no** se envía un mensaje nuevo (hoy
  `src/lib/collector.ts:53-57` manda `"Recuperado: …"`). Se puede editar el mensaje original para
  marcar `Resuelto` y quitar botones, o no tocarlo; lo que no se hace es crear otro mensaje.
- Si la incidencia escala de `warning` a `critical`, eso sí es un cambio de estado: se permite un
  mensaje nuevo con dedupe `alert:<id>:escalated`.
- Si el mensaje original se borró, `editMessageText` falla con 400; se ignora y se registra, no se
  reenvía.

Política de canales (una decisión por incidencia, dos adaptadores):

| `delivery` | Telegram | Web Push | Ejemplo |
|------------|----------|----------|---------|
| `immediate` | `sendMessage` al momento, con botones | `notify()` al momento, `tag = dedupeKey` | host caído, backup fallido, deploy fallido, disco lleno, servicio esperado parado |
| `digest` | una sola fila en el digest diario | no | CPU/memoria sostenidas, reinicio pendiente, release retenida, seguridad pendiente, WUD major |
| `silent` | no | no | avisos internos que solo se miran en el hub |

`delivery` se decide **una vez** al abrir la incidencia (`notification-policy.ts`), no en cada
muestra. Un mensaje por canal e incidencia; no se repite en el mismo canal. `src/lib/push.ts` sigue
siendo el adaptador Web Push; se le pasa el `dedupeKey` como `tag` para que el navegador colapse
duplicados. No se manda push de recuperación ni de digest. Esto reemplaza el `await notify(...)` en
las dos transiciones de `condition()` por una decisión de entrega y un encolado; la recuperación
solo actualiza `alerts.resolvedAt` y, como mucho, edita el mensaje de Telegram.

## Decisión de transporte

**Recomendación: long polling dentro de `src/worker.ts`.** Confianza: HIGH.

Por qué gana:

1. **Singleton real.** `src/worker.ts:15` toma `pg_try_advisory_lock(734921)` y sale si otro worker
   lo tiene. Varios pollers de `getUpdates` comparten el mismo offset y se pisan; el lock garantiza
   un solo consumidor sin una tabla de leases ni coordinación nueva.
2. **No exige ingress.** El hub puede estar detrás de Nginx Proxy Manager o de Tailscale Serve. Un
   webhook necesita que Telegram alcance `https://…` en 443/80/88/8443 con certificado válido; si
   el hub es privado, el webhook es imposible. El polling solo abre conexiones salientes.
3. **No añade una ruta no autenticada.** El webhook es un endpoint público que solo se protege con
   `secret_token`; el polling no amplía la superficie HTTP del hub.
4. **La lógica vive donde ya viven las decisiones.** El worker ya ejecuta collector, alertas,
   dedup y cleanup. El bot, el digest y el outbox comparten proceso, pool y transacciones; no hay
   dos despliegues que mantener sincronizados.
5. **Volumen ínfimo.** Un usuario, un chat, unos pocos callbacks al día. La conexión long-poll de
   ~25 s no consume nada relevante y simplifica la operación.

Costes y mitigaciones:

- Hay que añadir dos bucles pequeños al worker: `runBot()` (long polling) y
  `runNotifications()` (1 s, digest + outbox). El collector actual sigue igual; el cierre ordenado
  debe esperar a los tres antes de `pg_advisory_unlock` y `pool.end()`.
- El offset de `getUpdates` se persiste en PostgreSQL (`telegram_state.offset`) tras cada batch; si
  no hay fila todavía, se arranca en 0. Si el proceso cae entre procesar y guardar, el update se
  repite. Los callbacks usan tokens de un solo uso y las operaciones tienen `operationId`, así que
  el reproceso es inofensivo.
- Al arrancar, `getWebhookInfo`; si hay webhook, `deleteWebhook` una vez. Sin esto, `getUpdates`
  devuelve 409.
- Si el worker está caído, el bot también; es el mismo fallo que ya afecta a la recolección y al
  digest. Para un hub personal es aceptable.

Por qué pierden las otras:

| Opción | Veredicto | Por qué |
|--------|-----------|---------|
| Webhook en `src/app/api/telegram/webhook/route.ts` | Fallback válido, no primera opción | Requiere ingress público y certificado; añade una ruta no autenticada, comparación de `secret_token`, ack rápido y una cola durable porque Telegram reintenta los non-2xx. La réplica web única lo hace viable, pero no compensa con este volumen. Usarlo solo si el hub ya es público y se necesita latencia sub-segundo o escalar. |
| Proceso/contenedor de bot separado | No | Un contenedor más, otro `env_file`, otro deploy y otro pool; en un solo servidor no aporta HA ni aislamiento útil. Duplica la política y la conexión a PostgreSQL. |
| Long polling en la web (route handler) | No | Next.js no está pensado para mantener un poller de fondo; el webhook sería el equivalente natural, no el polling. |

Si en el futuro se elige webhook, los detalles que no se pueden olvidar son: `secret_token` de
1-256 chars, comparación con `timingSafeEqual`, `allowed_updates`, `drop_pending_updates` en el
primer `setWebhook`, `runtime = "nodejs"`, límite de body y respuesta 200 rápida tras persistir en
el outbox. `after()` de Next.js 16.4.6 existe y sirve para trabajo no crítico, pero **no** es una
cola durable: si el proceso muere tras el 200, el update se pierde. Para entrega, PostgreSQL.

## Decisión de librería

**Recomendación: cliente propio y pequeño en `src/lib/telegram.ts` sobre `fetch` nativo.** Confianza: HIGH.

Qué incluye:

- `createTelegramApi({ token, apiRoot, fetch })` con `sendMessage`, `editMessageText`,
  `editMessageReplyMarkup`, `answerCallbackQuery`, `getUpdates`, `getMe`, `getWebhookInfo`,
  `deleteWebhook`.
- Un `TelegramError` tipado con `method`, `errorCode`, `description` y `retryAfter`; nunca incluye
  el token en el mensaje.
- Tipos estrechos y locales: `TelegramUpdate`, `CallbackQuery`, `InlineKeyboardMarkup`; Zod valida
  solo los campos que se usan y deja pasar el resto (`.passthrough()`). No se modela todo el union
  de Update, que cambia con cada Bot API.
- Tipos de callback: un union cerrado `CallbackAction` (`ack-alert` | `check-health` | `backup-now`)
  y el token como único dato de `callback_data`; no hace falta el `CallbackData` flavor de grammY
  porque la acción no viaja en el payload.
- `apiRoot` configurable: tests con servidor falso y, si algún día se quiere, Bot API local.

Por qué:

- Son cinco métodos y JSON simple; un framework añade contexto, middleware, sesiones y plugins que
  no se usan. El repo ya prefiere módulos explícitos: `src/lib/github.ts` y `src/lib/nas.ts` son
  clientes HTTP propios, no SDKs.
- Control total del 429: `retry_after` se lee y se respeta; no hay reintentos ocultos que dupliquen
  un mensaje.
- Testabilidad: inyectar `fetch`/`apiRoot` y levantar un `node:http` en loopback es más simple que
  emular el framework. Sin `nock`, `msw` ni red.
- Cero dependencias nuevas y cero riesgo de que el bundle del servidor arrastre `node-fetch@2` en
  Node 26.

Qué reemplaza: los `sendMessage` ad-hoc de `media-stack` (`security-monitor/main.py:169`,
`stacks/backup/media-backup.sh:138`, `issue-automator/main.py:142`) y cualquier helper futuro. Un
solo cliente, un solo tratamiento de errores, un solo lugar donde se ofusca el token.

Comparativa:

| Opción | Versión verificada | Tamaño/forma | Testabilidad | Veredicto |
|--------|--------------------|--------------|--------------|-----------|
| `fetch` propio + Zod | n/a | 0 dependencias | Alta: fake server + inyección | **Recomendado** |
| grammY | 1.48.0 | `unpackedSize` 1.486.789 bytes; deps `node-fetch@^2.7.0`, `abort-controller@^3.0.0`, `@grammyjs/types@5.2.0`; paquete moderno con `exports` | Alta, pero hay que aprender `Bot`, `Context`, `webhookCallback` | Solo si el bot crece a conversaciones/menús/multi-paso |
| telegraf | 4.16.3 | `unpackedSize` 689.218 bytes; `"type": "commonjs"`; 168 archivos; deps antiguas (`node-fetch@^2.7.0`) | Media; API de callbacks/scenes | No |

No usar:

- **grammY 1.48.0** para este alcance. Es un framework excelente, pero resuelve problemas que no
  existen aquí (middleware, sesiones, menús, runner, adaptadores de webhook). Su `webhookCallback`
  es para la variante webhook; en polling se usaría `bot.start()`, que oculta el offset y el
  control de errores. Añade ~1,4 MB desempaquetados y una capa que el repo no necesita.
- **telegraf 4.16.3**. CommonJS, 168 archivos, `node-fetch@2`, `scenes`/`session`; fricción con
  ESM, TypeScript 7 y Next.js 16. No hay razón para meterlo.
- **`node-telegram-bot-api`** y similares de estilo callback: mantenimiento irregular y API vieja;
  no se justifican frente a un cliente propio pequeño.
- **Telegram Web Apps / Mini Apps** para “abrir vistas”: añaden `initData` que hay que validar,
  permisos y otro flujo de auth. Un `url` button al hub es suficiente; el navegador in-app pedirá
  login si no tiene la cookie de Better Auth.
- **`grammy` + `auto-retry`/`transformer-throttler`**: si se usara grammY, el throttler tendría
  sentido; con el cliente propio, el outbox ya serializa y respeta `retry_after`.

## Programación del digest

**Recomendación: tick del worker + `madridDay`/`madridTime` + dedupe en PostgreSQL.** Confianza: HIGH.

Reglas:

- Hora objetivo: `TELEGRAM_DIGEST_HOUR` (por defecto 8) en `Europe/Madrid`. No usar
  `new Date().getHours()`: el contenedor corre en UTC y el resultado cambiaría con el host.
- `madridDay(now)` ya devuelve `date`, `start`, `end` y `timeZone`, con días de 23/25 h. Añadir a
  `src/lib/madrid-day.ts` un `madridTime(date: string, hour: number, minute = 0): Date` que reutilice
  el mismo “offset settle” de `startOfMadridDay`. No duplicar la lógica en el worker.
- En el bucle de notificaciones (1 s), si `now >= madridTime(day.date, hour)` y aún no hay fila para
  `digest:<date>`, se construye y se inserta en `notifications` con
  `dedupeKey = "digest:" + day.date` y `onConflictDoNothing()`. La unicidad de `dedupeKey` es la
  verdad; el worker puede reiniciarse sin duplicar.
- La transacción incluye: leer los `alerts` no urgentes pendientes de digest, insertar la fila del
  digest y marcar `alerts.digestAt`. Si el insert no devuelve fila, otro tick ya lo hizo; salir.
- Si el worker estaba caído a las 08:00, en el primer tick del mismo día se envía tarde. Si el día
  ya pasó, no se hace backfill: no tiene sentido recibir el digest de ayer hoy.
- Si no hay items, no se inserta nada; no se manda un “todo bien” diario.
- `disable_notification: true` en el digest para que no suene; las incidencias críticas sí suenan.
- El envío lo hace el outbox; si Telegram falla, se reintenta la misma fila. No se reconstruye el
  digest ni se vuelven a marcar alerts.
- No `node-cron`, no `croner`, no `setInterval` persistente, no un contenedor cron. El worker ya es
  el único escritor y ya despierta cada segundo; añadir cron sería otra pieza que puede solaparse.

Bosquejo (pseudocódigo, no código de producción):

```ts
const day = madridDay(now);
if (now < madridTime(day.date, digestHour)) return;

await db.transaction(async (tx) => {
  const [row] = await tx
    .insert(notifications)
    .values({
      dedupeKey: `digest:${day.date}`,
      kind: "digest",
      chatId,
      text,
      replyMarkup,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!row) return;
  await tx
    .update(alerts)
    .set({ digestAt: new Date(now) })
    .where(/* warnings incluidas, digestAt is null */);
});
```

Contenido del digest:

- Solo incidencias no urgentes (`delivery = "digest"`) que sigan abiertas y no se hayan incluido
  antes (`digestAt is null`), más un contador de las que siguen abiertas de días anteriores.
- No repetir cada día la misma incidencia abierta: eso vuelve a ser ruido. Si se quiere un
  recordatorio, que sea un contador (“3 avisos siguen abiertos”) y un botón al hub.
- Resueltas: no aparecen. No hay mensaje de recuperación.
- Si una incidencia se abrió y resolvió entre dos digests, no se incluye; el histórico está en
  `alerts` y en la vista de eventos.

## Estado en PostgreSQL

Principio: **transactional outbox**. La decisión (`alerts`) y el mensaje (`notifications`) se
escriben en la misma transacción; el envío es un efecto posterior, reintentable. Esto reemplaza el
`await notify(...)` dentro de `condition()` (`src/lib/collector.ts:53-57`, `:66`), que hoy puede
perder el mensaje si el proceso cae entre el insert y el envío, y que no tiene dedup ni retry.
Confianza: HIGH en el outbox y los tokens; MEDIUM en la forma exacta de las columnas hasta generar
la migración y probarla contra PostgreSQL 18.

### `alerts` (columnas nuevas)

```ts
delivery: text().notNull().default("immediate"), // immediate | digest | silent
notifiedAt: timestamp({ withTimezone: true }),  // cuándo salió el mensaje único
digestAt: timestamp({ withTimezone: true }),    // cuándo entró en un digest
telegramMessageId: integer(),                   // para editar/retirar botones
```

- `key` + `hostId` ya son la clave de incidencia; no hace falta renombrar nada. Añadir un índice
  único parcial para garantizar una sola incidencia abierta por host/key:

```ts
uniqueIndex("alerts_host_key_open_idx")
  .on(t.hostId, t.key)
  .where(sql`resolved_at is null`)
```

- El collector ya comprueba `isNull(alerts.resolvedAt)` antes de insertar; el índice es una red de
  seguridad, no un cambio de contrato. Antes de crearlo, comprobar que no hay duplicados abiertos;
  si los hubiera, resolver el más antiguo.
- `severity` sigue siendo `warning`/`critical`; la política puede mapear `key` a `delivery`. No se
  añade un enum de severidad nuevo.
- No se hace backfill de `notifications` para alerts antiguos; las filas existentes no se envían.

### `notifications` (outbox)

```ts
export const notifications = pgTable(
  "notifications",
  {
    id: text().primaryKey(),                 // randomUUID()
    channel: text().notNull().default("telegram"),
    kind: text().notNull(),                  // incident | digest | action
    dedupeKey: text().notNull().unique(),    // alert:<id>:open | digest:<date> | action:<token>
    chatId: text().notNull(),
    alertId: integer().references(() => alerts.id, { onDelete: "set null" }),
    text: text().notNull(),
    replyMarkup: jsonb().$type<InlineKeyboardMarkup>(),
    status: text().notNull().default("pending"), // pending | sent | failed | suppressed
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    telegramMessageId: integer(),
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("notifications_pending_idx").on(t.status, t.nextAttemptAt),
    index("notifications_alert_idx").on(t.alertId),
  ],
);
```

Por qué:

- `dedupeKey` único es la garantía de “un mensaje por incidencia”: el collector puede reintentar
  el insert sin duplicar.
- `status`/`attempts`/`nextAttemptAt` permiten 429 y caídas sin perder el mensaje.
- `telegramMessageId` permite editar el mensaje al resolver o al ejecutar una acción.
- `channel` deja la puerta abierta a Web Push en el mismo outbox más adelante; en v1 solo se usa
  `telegram` y `src/lib/push.ts` sigue igual.

### `callback_tokens` (capacidades opacas)

```ts
export const callbackTokens = pgTable(
  "callback_tokens",
  {
    token: text().primaryKey(),              // 32 bytes base64url
    action: text().notNull(),                // ack-alert | check-health | backup-now | ...
    hostId: text().notNull(),
    target: text(),
    alertId: integer().references(() => alerts.id, { onDelete: "cascade" }),
    operationId: text(),                     // UUID para operations.id
    telegramUserId: text().notNull(),
    chatId: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("callback_tokens_expires_idx").on(t.expiresAt)],
);
```

Por qué:

- `callback_data` está limitado a 64 bytes y es manipulable. Se manda `a:<token>` (45 bytes); la
  autoridad es la fila, no el payload.
- Un solo uso: `UPDATE … SET used_at = now() WHERE token = $1 AND used_at IS NULL AND expires_at > now()
  RETURNING *`. Si no devuelve fila, se responde “caducado” y no se ejecuta nada.
- `action` es un enum cerrado en código, no un string libre del callback. Reutilizar
  `hostCommandIds` de `src/lib/host-command-contract.ts` para las acciones de host, y añadir
  `ack-alert` como única acción propia del bot.
- TTL: 10 minutos para acciones; 24 horas para `ack-alert`; cleanup en el bloque horario del worker.

### `telegram_state` (una fila)

```ts
export const telegramState = pgTable("telegram_state", {
  id: text().primaryKey().default("bot"),
  offset: bigint({ mode: "number" }).notNull().default(0),
  lastDigestDate: text(),          // YYYY-MM-DD Europe/Madrid (cache; la verdad es dedupeKey)
  linkedChatId: text(),
  linkedUserId: text().references(() => user.id, { onDelete: "set null" }),
  enabled: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
```

Por qué:

- `offset` sobrevive al reinicio; sin él, `getUpdates` reentrega lo no confirmado y se reprocesan
  mensajes.
- `lastDigestDate` evita consultar el outbox en cada tick; el `dedupeKey` único sigue siendo la
  verdad ante reinicios. Se actualiza en la misma transacción que el insert del digest; si el insert
  no ocurre, no se actualiza, para no saltarse el día.
- `linkedChatId`/`linkedUserId` permiten auditar y, si se quiere, mover la allowlist a DB sin
  cambiar el esquema. En v1 la autorización vive en `TELEGRAM_CHAT_ID`/`TELEGRAM_ALLOWED_USER_ID`;
  si algún día hay varios chats/usuarios, se añade `telegram_links` y se migra.

### `operations` (columnas nuevas)

```ts
channel: text().notNull().default("web"), // web | telegram | worker
requestedBy: text(),                      // p. ej. el id de Telegram, para auditoría
```

Por qué: `operations` ya es el registro de idempotencia y auditoría de acciones. Añadir `channel`
y `requestedBy` evita mezclar una acción de Telegram con una de la web. No se usa `operations` como
outbox: su semántica es “intento de acción”, no “mensaje pendiente”.

### Lo que NO se toca

- **`configuration`**: es `{hostId, id, value: Settings}` y está tipada para settings de host. Meter
  estado global del bot ahí rompe el tipo y el scope por host. Para el offset/digest va
  `telegram_state`.
- **`subscriptions`**: es una suscripción Web Push (`endpoint` + `keys`), no un canal genérico.
  Añadir columnas nullable de Telegram debilita sus invariantes. El chat del bot va en
  `telegram_state`/env.
- **`samples`**: no se toca.

### Dedup, tokens y autorización

- Dedup de incidencia: `alerts` abierto único por `(hostId, key)` + `notifications.dedupeKey`.
- Dedup de update: el offset persistido evita reprocesar; los tokens de un solo uso evitan repetir
  una acción aunque el update se repita.
- Autorización: `TELEGRAM_CHAT_ID` y `TELEGRAM_ALLOWED_USER_ID` en env. En cada callback:
  `String(callback_query.from.id) === TELEGRAM_ALLOWED_USER_ID` y
  `String(callback_query.message.chat.id) === TELEGRAM_CHAT_ID`; si falta cualquiera, se responde
  sin ejecutar. Si `TELEGRAM_ALLOWED_USER_ID` no está configurado, **fail closed**: no se autoriza
  nada.
- Verificación reciente: para acciones que mutan el host, comprobar `recent_verification` del
  `userId` vinculado (`expiresAt > now()`, de cualquier sesión activa). Si no hay, el botón debe ser
  `url` a la vista de acción sensible del hub, no un callback. Así se conserva Better Auth + passkey;
  no se inventa una segunda auth para Telegram.
- Acciones destructivas (`remove`, `reboot`, `deploy-now`, `update-container`): siempre `url` al
  hub, nunca `callback_data`. Las que ya pasan por `guardSensitiveAction` conservan esa puerta; el
  bot no crea una segunda auth ni la relaja.
- Acciones seguras v1: `ack-alert` (solo DB) y, como máximo, `check-health`/`backup-now` si se
  acepta ejecutarlas con `executeHostCommand` y timeout. Cualquier acción de minutos se queda en el
  hub.

## Testing

Enfoque: **Vitest + fake Bot API en loopback + base de datos desechable**, sin red y sin aserciones
sobre copy español (`CODING_STANDARD.md`). Confianza: HIGH; el repo ya tiene el harness de DB y el
patrón de fake server es directo.

| Test | Qué cubre | Cómo se asserta |
|------|-----------|-----------------|
| `tests/telegram-client.test.ts` | URL `/bot<token>/sendMessage`, body JSON, `reply_markup`, `link_preview_options`, 429 `retry_after`, 401/403 sin retry, token fuera de logs | Array de requests del servidor falso; `path`, `body.chat_id`, `text.length <= 4096`, `callback_data.length <= 64` |
| `tests/telegram-updates.test.ts` | `callback_query` válido, token caducado/reutilizado/desconocido/manipulado, `from.id` incorrecto, chat incorrecto, update duplicado | Filas de `callback_tokens`/`notifications`/`operations`; `answerCallbackQuery` llamado una vez; ninguna acción ejecutada en los casos inválidos |
| `tests/telegram-digest.test.ts` | `madridTime` invierno/verano/DST, 08:00, ejecución tardía, doble tick, tope de 3500, sin items | `madridDay`/`madridTime`; una sola fila `digest:<date>`; `text.length`; número de items; botón `url` |
| `tests/notifications.test.ts` | outbox: `pending` → `sent`, 429 → `nextAttemptAt`, 400 → `failed`, dedupe | Transiciones de `status`/`attempts`; requests enviados |
| `tests/migrations.test.ts` | tablas/columnas/índices nuevos | `information_schema`/`pg_indexes`; sin copys |

Fake server:

```ts
const server = createServer(async (req, res) => {
  requests.push({ url: req.url, body: JSON.parse(await read(req)) });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
```

- Inyectar `apiRoot`, `fetch`, `now` y `sleep`; nada de `vi.mock` global si se puede evitar.
- Para 429, responder una vez
  `{ ok:false, error_code:429, parameters:{ retry_after: 2 } }` y comprobar que no se reintenta
  antes de tiempo; usar fake timers o un `sleep` inyectado.
- Fixtures en `tests/fixtures/telegram/*.json`: `callback_query` con `message.chat.id`,
  `from.id`, `data`; `message` `/start`; `edited_message` ignorado. Validar con el mismo Zod que
  producción.
- Tests de DB: reutilizar `tests/database.ts` y `tests/migrations.test.ts`; se saltan si no hay
  `DATABASE_URL` local, como ya hace el repo.
- Playwright: **no** para el bot. Como mucho, un E2E de que `/?view=alerts&host=nas-home` abre la
  vista correcta (`data-view`, `aria-current`), porque el botón `url` no necesita más. No se
  asserta el texto del mensaje de Telegram.
- Regla de copy: si se quiere comprobar un toast, `expect(text.length).toBeGreaterThan(0)`, no el
  literal. Se asserta `show_alert`, el estado de la fila o la request enviada.

## Alternativas consideradas

| Recomendado | Alternativa | Cuándo usar la alternativa | Confianza |
|-------------|-------------|----------------------------|-----------|
| Long polling en worker | Webhook en `src/app/api/telegram/webhook/route.ts` | El hub ya es público, se quiere latencia sub-segundo o se escala; añadir `secret_token`, ack rápido y outbox durable | HIGH |
| Cliente `fetch` propio | grammY 1.48.0 | El bot crece a conversaciones, menús, sesiones o multi-paso; aceptar ~1,4 MB y middleware | MEDIUM |
| Outbox PostgreSQL | Redis/BullMQ/SQS | Varios workers o volumen alto; hoy viola “sin infraestructura nueva” y no aporta | HIGH |
| Tick del worker + `madridDay` | `node-cron`/`croner` | Varias schedule independientes fuera del worker; aquí solo hay una y ya hay bucle | HIGH |
| `editMessageText` para resolver | Mensaje nuevo de recuperación | Solo si se necesita un timeline inmutable; contradice “sin aviso de recuperación” | HIGH |
| Botón `url` al hub | Web App/Mini App | Se necesita UI dentro de Telegram y se acepta validar `initData`; no para v1 | HIGH |
| `disable_notification` en digest | Notificación normal | El digest debe interrumpir; por defecto no | HIGH |

## Qué NO usar

| Evitar | Por qué | Usar en su lugar |
|--------|---------|------------------|
| `telegraf@4.16.3` | CJS, 168 archivos, `node-fetch@2`, scenes/session; fricción con ESM/TS 7/Next 16 | Cliente `fetch` propio |
| `grammY` para v1 | Framework completo para 5 métodos; ~1,4 MB y capas que el repo no usa | Cliente `fetch` propio; grammY solo si crece |
| Proceso/contenedor de bot separado | Superficie y deploy extra; sin HA en un servidor; duplica DB y política | Worker existente |
| Webhook si el hub es Tailscale-only | Telegram no puede alcanzar una URL privada; requiere 443/80/88/8443 público | Long polling |
| `node-cron` / `setInterval` para el digest | No sobrevive reinicios; `setInterval` se solapa; TZ del contenedor en UTC | `madridDay` + `dedupeKey` |
| Redis / BullMQ / SQS | Infraestructura nueva para un solo worker y pocos mensajes; otro fallo y otra persistencia | Outbox PostgreSQL |
| `disable_web_page_preview` | Obsoleto en la Bot API actual; media-stack lo usa y se reemplaza | `link_preview_options: { is_disabled: true }` |
| `callback_data` con `action:host:id` | 64 bytes y manipulable; cualquiera puede inventar una acción | `a:<token>` + `callback_tokens` |
| Parsear `callback_data` para decidir la acción | El cliente controla el payload | Acción desde la fila `callback_tokens.action` (enum cerrado) |
| Mandar mensaje de recuperación | Es el ruido que se quiere eliminar | `editMessageText`/`editMessageReplyMarkup` o nada |
| `notify()` a todas las subscriptions para Telegram | `subscriptions` es Web Push; no hay filtros ni dedup | Chat explícito + outbox |
| `getHours()` o `TZ` del contenedor | Cambia con el host y con DST | `madridDay`/`madridTime` |
| Loguear el token o el `callback_data` completo | Son secretos/capacidades | Loggear `update_id`, `alertId`, `hostId`, nombre del método |
| `parse_mode: "Markdown"` con texto dinámico | Nombres de contenedor con `_`/`*` rompen el parseo | HTML escapado o texto plano |
| Bucle de `sendMessage` sin throttle | 429 y reintentos en cascada | Outbox, 1 msg/s, `retry_after` |

Confianza: HIGH en las filas de infraestructura y API; MEDIUM en “grammY no para v1”, porque depende
de cuánto crezca el bot. Si se adopta grammY, mantener el outbox y el cliente HTTP como capa de
entrega para no perder el control de `retry_after`.

## Patrones por variante

**Si el hub ya es público y se necesita webhook:**
- Usar `src/app/api/telegram/webhook/route.ts`, `runtime = "nodejs"`, `secret_token` y
  `timingSafeEqual`; responder 200 tras persistir en `notifications`.
- Verificar que la ruta estática gana al catch-all `src/app/api/[...path]/route.ts`; añadir un test
  que confirme que no pasa por el gate de sesión.
- `after()` solo para telemetría; nunca para la entrega.

**Si el bot crece a conversaciones o varios usuarios:**
- Añadir `telegram_links` (`telegramUserId`, `chatId`, `userId`, `enabled`) y `telegram_updates`
  (`updateId` PK) para dedup estricta.
- Migrar a grammY 1.48.0 solo si los flujos multi-paso lo justifican; mantener el outbox y el
  cliente HTTP como capa de entrega.

**Si media-stack sigue enviando mientras se migra:**
- No mantener dos políticas. Migrar primero backup y deploy, que ya se derivan de
  `maintenanceAlertSignals`/`deploymentAlertSignals` (`src/lib/maintenance-alerts.ts`).
- Security digest y WUD major-only: o se derivan de `maintenance.security` (pins/pending/review) o
  se añade un ingest estrecho y autenticado para media-stack. No se duplica el formateo.
- `issue-automator` no es urgente: digest o silencio.

**Si el worker se reinicia:**
- `telegram_state.offset` evita reprocesar; `notifications` pendientes se drenan; `dedupeKey` evita
  duplicar incidencias.

**Si Telegram está caído o el token es inválido:**
- El outbox reintenta con backoff; 401 → `telegram_state.enabled = false`, log una vez, el
  collector sigue. Web Push sigue funcionando.

## Compatibilidad de versiones

| Paquete / runtime | Compatible con | Notas | Confianza |
|-------------------|----------------|-------|-----------|
| Node.js 26 | `fetch`, `AbortSignal.timeout`, `node:crypto` | Runtime del `Dockerfile` y CI; no hay `engines` en `package.json` | HIGH |
| TypeScript 7.0.2 | Zod 4.6.7, Drizzle 0.45.4, Vitest 5.1.0 | Stack actual; el cliente propio no añade tipos exóticos | HIGH |
| Telegram Bot API 10.5 | `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getUpdates` | Los límites citados son de la documentación del 2026-11-24; la Bot API cambia a menudo | HIGH |
| grammY 1.48.0 | Node `^12.20.0 || >=14.13.1` | Compatible con Node 26, pero no se usa; `@grammyjs/types@5.2.0` es su dependencia | HIGH |
| telegraf 4.16.3 | Node `^12.20.0 || >=14.13.1` | CJS; no se usa | HIGH |
| PostgreSQL 18 | `timestamptz`, índices únicos parciales, `FOR UPDATE SKIP LOCKED` | Ya es la versión de `compose.yaml` y CI | HIGH |
| Drizzle 0.45.4 | `uniqueIndex(...).where(sql...)`, `onConflictDoNothing`, transacciones | Verificar la sintaxis exacta al generar la migración | MEDIUM |

## Fuentes

- Telegram Bot API 10.5 — <https://core.telegram.org/bots/api> (consultada 2026-11-24):
  `setWebhook`, `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`,
  `CallbackQuery`, `InlineKeyboardButton`.
- Telegram Bots FAQ — <https://core.telegram.org/bots/faq> (límites por chat/grupo/global y 429).
- grammY — <https://grammy.dev/guide/deployment-types> (webhook timeout de 10 s, entrega secuencial
  por chat, adaptador `next-js`) y <https://registry.npmjs.org/grammy/latest> (`1.48.0`,
  `unpackedSize`, dependencias).
- telegraf — <https://registry.npmjs.org/telegraf/latest> (`4.16.3`, `unpackedSize`, CJS).
- Next.js 16.4.6 — `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`
  (comportamiento de `after()`).
- Repo — `src/lib/push.ts`, `src/lib/collector.ts`, `src/lib/maintenance-alerts.ts`,
  `src/worker.ts`, `src/lib/schema.ts`, `src/lib/madrid-day.ts`, `tests/database.ts`,
  `tests/migrations.test.ts`, `CODING_STANDARD.md`, `compose.yaml`, `package.json`.
- media-stack — `stacks/monitoring/security-monitor/main.py`, `stacks/backup/media-backup.sh`,
  `stacks/extras/issue-automator/main.py`, `stacks/monitoring/compose.yaml` (WUD major-only).
- Contexto de planeación — `.planning/PROJECT.md`, `.planning/codebase/STACK.md`,
  `.planning/codebase/ARCHITECTURE.md`, `.planning/config.json`.

---

*Stack research para: notificaciones Telegram con inline actions y digest en hub.*
*Investigado: 2026-11-24.*
