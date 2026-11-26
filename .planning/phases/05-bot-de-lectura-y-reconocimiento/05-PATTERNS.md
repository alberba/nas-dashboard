# Fase 5 · Mapa de patrones del bot de lectura y reconocimiento

**Fecha** 2026-11-26
**Archivos analizados** 22 (11 nuevos, 11 modificados)
**Analogos encontrados** 21 / 22

Todas las rutas de analogo son fuente rastreada (`git ls-files` las lista). Los nombres de modulos nuevos vienen de 05-RESEARCH.md y son orientativos. Las lineas son del estado actual de `main`.

## File Classification

| Archivo nuevo o modificado | Rol | Flujo | Analogo mas cercano | Calidad |
| --- | --- | --- | --- | --- |
| `src/lib/telegram.ts` (mod: `botRequest`, `getUpdates`, `deleteWebhook`, `answerCallbackQuery`, `sendTelegramReply`, teclado) | servicio (cliente) | request-response | el mismo `post()` y `buttons()` | exacto |
| `src/lib/telegram-updates.ts` (nuevo: schema zod, `isAuthorizedCallback`, `handleCallback`, `runUpdatesOnce`) | servicio | event-driven (polling) | `src/lib/worker-loop.ts` + `src/lib/notification-dispatch.ts` (carril con lock) | parcial |
| `src/lib/telegram-keyboard.ts` (nuevo: estados, emision de tokens) | utilidad | transformacion | `buttons()` en `src/lib/telegram.ts:281` | parcial |
| `src/lib/incident-actions.ts` (nuevo: ack, snooze, unsnooze, consumo de token) | servicio | CRUD transaccional | `recordIncidentObservationIn` en `src/lib/incident-store.ts:587` | rol |
| `src/lib/incident-why.ts` (nuevo) | servicio | transformacion | `openingText` en `src/lib/notification-dispatch.ts:342` | parcial |
| `src/lib/notification-dispatch.ts` (mod: kind `incident-why`, silencio antes de la marca, tokens al renderizar) | servicio | cola persistente | el mismo archivo | exacto |
| `src/lib/incident-store.ts` (mod: silencio en apertura y `changeSeverity`, helper `queueEdit`, proyeccion) | servicio | CRUD transaccional | el mismo archivo | exacto |
| `src/lib/schema.ts` (mod: `telegram_action_tokens`, `incident_snoozes`, `telegram_poll_state`, columnas ack) | modelo | persistencia | `digestRuns` y `telegramCooldown` | exacto |
| `drizzle/0007_*.sql` | migracion | batch | `drizzle/0006_digest_runs.sql` | exacto |
| `src/lib/digest-content.ts` (mod: `digestOpen` + etiquetas) | servicio | lectura agregada | el mismo archivo | exacto |
| `src/lib/worker-loop.ts` (mod: carril `updates` en `workerTurn`) | servicio | orquestacion | el mismo archivo | exacto |
| `src/worker.ts` (mod: cablear el carril, poll en lugar de `delay`) | servicio | orquestacion | el mismo archivo | exacto |
| `src/app/api/[...path]/route.ts` (mod: `incidents/:id/(acknowledge\|snooze\|unsnooze)`) | ruta | request-response | rama `incidents/:id` del mismo archivo (l.235) | rol |
| `src/lib/types.ts` (mod: `Alert` con ack y silencio) | modelo | transformacion | `PublicDelivery` en el mismo archivo | exacto |
| `src/components/views/alerts.tsx` (mod: estado y acciones) | componente | request-response | `data-delivery-*` del mismo archivo | exacto |
| `src/components/dashboard.tsx` (mod: handlers de accion) | componente | request-response | handlers de mutacion existentes | rol |
| `tests/telegram-fake.ts` (nuevo) | test (arnes) | event-driven | `fakeFetch` en `tests/telegram.test.ts:23` | parcial |
| `tests/telegram-updates.test.ts` (nuevo) | test | event-driven | `tests/telegram.test.ts` + `tests/notification-dispatch.test.ts` | rol |
| `tests/incident-actions.test.ts`, `tests/incident-why.test.ts` (nuevos) | test | CRUD con BD | `tests/notification-dispatch.test.ts:64-122` | exacto |
| `tests/notification-dispatch.test.ts`, `tests/telegram.test.ts`, `tests/migrations.test.ts`, `tests/api-incidents.test.ts` (ampliar) | test | varios | los mismos | exacto |
| `tests/e2e/incidents.spec.ts` (ampliar) | test e2e | request-response | el mismo archivo | exacto |
| Parte de `README`/`.env.example` | config | n/a | sin cambios (D-11 no anade variables) | n/a |

## Pattern Assignments

### 05-01 · Polling, allowlist y offset

**`src/lib/telegram.ts` (cliente)**. Factorizar `post()` (l.158-270) en un `botRequest` unico. El token solo toca la construccion de URL (l.172-182) y los errores se mapean a `reason` finitos sin conservar el mensaje (l.183-192):

```typescript
response = await context.fetchImpl(
  `${TELEGRAM_ORIGIN}/bot${context.botToken}/${context.method}`,
  { method: "POST", redirect: "error", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(context.body), signal },
);
} catch {
  clearTimeout(timer);
  if (context.signal?.aborted) return { state: "uncertain", reason: "aborted" };
  return { state: "uncertain", reason: controller.signal.aborted ? "timeout" : "network" };
}
```

- Mantener tambien la guarda `BOT_TOKEN_PATTERN` (l.58, 159), `AbortSignal.any` (l.167-168) y el sobre `ok/result/description/parameters` (l.69-74). `RequestContext.method` (l.148) pasa a ser una union con los metodos nuevos.
- `getUpdates` usa `timeoutMs = pollSeconds * 1000 + TELEGRAM_REQUEST_TIMEOUT_MS` (no el 10 s fijo de l.277). Siempre `allowed_updates: ["callback_query"]`. `deleteWebhook` sin `drop_pending_updates`.
- Resultados nuevos siguen el estilo finito de `TelegramSendResult` (l.43-47): sin texto de error del proveedor. Anadir `redactToken(text, token)` defensivo (patron `/bot\d{5,12}:[A-Za-z0-9_-]{30,}/`).
- `buttons()` (l.281-285) hoy solo devuelve `[[{ text: "Abrir en el hub", url }]]`. Pasa a aceptar filas con `callback_data` (`v1:<22 base64url>`), que construye `telegram-keyboard.ts`. `sendTelegramMessage` y `editTelegramMessage` (l.288-328) reciben el teclado ya montado; siguen enviando siempre `reply_markup`.
- La respuesta "por que" (D-06): `sendMessage` con `reply_parameters: { message_id, allow_sending_without_reply: true }` y `disable_notification: true`, mismo cuerpo que l.295-300.

**`src/lib/telegram-updates.ts` (carril de updates)**. No hay analogo de polling; el patron de encaje es el del lock. Copiar de `notification-dispatch.ts`:

```typescript
// runDispatchOnce, l.1050-1058: cada carril comprueba el lock al entrar
const client = options.client;
if (!(await holdsCollectionLock(client))) throw new CollectionLockLost();
```

- Las mutaciones usan el pool `db` en transaccion corta (como `recordIncidentObservationIn(tx, ...)`, `incident-store.ts:587`), nunca la conexion `lock` (`workerDb(client)`, `notification-dispatch.ts:98`). Una transaccion unica: consumir token, aplicar efecto, encolar outbox y `UPSERT telegram_poll_state`. `answerCallbackQuery` despues del commit y de mejor esfuerzo.
- Consumo atomico (de 05-RESEARCH.md, patron 2): `SELECT ... FOR UPDATE`, validar `chatId`/`message_id`/`expiresAt` contra la fila `incident:<id>:open` del outbox, y `UPDATE ... SET "usedAt" = $2 WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > $2 RETURNING ...`.
- Allowlist como funcion pura (D-11): `String(from.id) === chatId`, `String(chat.id) === chatId`, `chat.type === "private"`, `data` con `^v1:[A-Za-z0-9_-]{22}$`, `message.from.is_bot === true` si `date !== 0`. No autorizado: avanzar offset, sin respuesta y sin log del contenido.
- Schema zod tolerante (`z.looseObject`, zod `^4.6.7`) segun el boceto de 05-RESEARCH.md l.470-493.
- El carril no arranca si `chatId` empieza por `-` (una linea de log finita). `runtime-config.ts:317` acepta ids negativos:

```typescript
if (!/^-?[1-9]\d{0,19}$/.test(chatId)) {
```

**`src/lib/worker-loop.ts` y `src/worker.ts`**. Anadir `updates?: () => Promise<{ handled: number; ok: boolean }>` como dependencia **opcional** de `WorkerTurnDeps` (l.41-52) para no romper la suite "worker health". Hito final en `workerTurn` con el estilo de l.71-72:

```typescript
await deps.drain();
await deps.health.renew();
```

- Renovar solo si `outcome.ok` (un fallo no extiende la marca, ver el comentario de cabecera l.4-11).
- En `worker.ts:164-170` el poll sustituye a `delay(WORKER_IDLE_MS)`; la espera se acota a lo que falta para la siguiente recoleccion (`sampleInterval`, 5 s con pestana, `validation.ts:45`), maximo 3 s. Tras un fallo, retroceso hasta ~30 s. `lock.on("error")` y `stop()` (l.118-125) ya cubren el aborto: pasar `stopping` como `AbortSignal` al poll.
- Los fallos que no son `CollectionLockLost` se registran con la linea finita de l.166-168; copiar esa redaccion (sin detalle del error).

### 05-02 · Tokens, ack/snooze y "por que"

**`src/lib/schema.ts` (modelo)**. Analogos de estilo (tablas recientes con `withTimezone: true`, indices con el callback `(t) => [...]`, comentarios JSDoc):

```typescript
// telegramCooldown, l.308-314 (PK textual, until/updatedAt con zona)
export const telegramCooldown = pgTable("telegram_cooldown", {
  channel: text().primaryKey(),
  until: timestamp({ withTimezone: true }).notNull(),
  reason: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
```

- `telegram_action_tokens`: PK `tokenHash`; `incidentId` con `.references(() => incidents.id, { onDelete: "cascade" })` (patron de `incidentEvents`, l.191-203); `action`, `chatId`, `expiresAt`, `usedAt`, `createdAt`.
- `incident_snoozes`: clave `(hostId, key)` con `uniqueIndex` como `incidents_open_host_key_idx`; `until`, `setAt`, `setVia`, `setBy`.
- `telegram_poll_state`: una fila (`lastUpdateId`, `lastUpdateAt`), PK textual como `telegram_cooldown`.
- Columnas nuevas en `incidents` (l.141-186): `acknowledgedAt`, `acknowledgedVia`, `acknowledgedBy`, nulas y con `timestamp({ withTimezone: true })`. Las antiguas `at`/`resolvedAt` son `timestamp()` sin zona (l.150-151); las consultas del resumen mantienen `AT TIME ZONE 'UTC'`.
- Actualizar el comentario de `notificationOutbox.kind` (l.230): anadir `incident-why`.
- **Migracion** `drizzle/0007_*.sql`: aditiva, generada con drizzle-kit (snapshot y journal en `drizzle/meta`). Analogo `0006_digest_runs.sql`: `CREATE TABLE` seguido de `--> statement-breakpoint` y `CREATE INDEX`. Ampliar `tests/migrations.test.ts` como en 0005/0006.

**`src/lib/incident-actions.ts`**. Patron de bloqueo de fila y evento de linea temporal, de `recordIncidentObservationIn`:

```typescript
// incident-store.ts:595-606
const [open] = await tx.select().from(incidents)
  .where(and(eq(incidents.hostId, input.hostId), eq(incidents.key, input.key), isNull(incidents.resolvedAt)))
  .limit(1)
  .for("update");
// l.610-630: seq = open.seq + 1; update incidents; insert incidentEvents { kind, severity, title, detail, at }
```

- Eventos nuevos `"acknowledged"`, `"snoozed"`, `"unsnoozed"` (los existentes: `opened`, `severity`, `closed`, `resumed`). `digest-content.ts:342` solo cuenta `kind IN ('opened','severity')`: los nuevos no tocan contadores.
- Idempotencia por estado: ack repetido no escribe evento ni sube `seq`; snooze solo extiende si el nuevo `until` es posterior.
- Una unica funcion usada por Telegram (carril) y por la ruta del hub, con `queueEdit` en la misma transaccion (Pitfall 10).

**`src/lib/incident-store.ts` (helper `queueEdit` y silencio)**. La insercion de edicion esta duplicada en `closeEpisode` (l.226-243) y `changeSeverity` (l.320-337); extraerla:

```typescript
if (first.status === "sent" && first.channel === "telegram" && first.chatId && first.messageId) {
  await tx.insert(notificationOutbox).values({
    key: editKey(incident.id, seq), incidentId: incident.id,
    kind: "incident-edit", channel: "telegram", status: "pending",
    revision: seq, chatId: first.chatId, messageId: first.messageId,
  });
  return "queued";
}
```

- Silencio al escribir: apertura inmediata (l.796-804, hoy `status: "pending"`) pasa a `suppressed` con motivo `snoozed` conservando el canal; la rama `status: "pending"` de `changeSeverity` (l.287-303) igual. Usar `suppressed(reason, at)` (l.821-824). `activeSnooze(client|tx, hostId, key, now)` ignora `until <= now` (D-03 sale gratis). El ack no se consulta en ningun punto de la politica (D-02).
- Las ediciones (`incident-edit`) no se suprimen.

**`src/lib/notification-dispatch.ts`**:
- `claimOutboxJob` l.259: anadir `'incident-why'` a `kind IN (...)`; sin esto el trabajo queda `pending` para siempre.
- `runDispatchOnce` l.1077-1081: anadir `if (job.kind === "incident-why") return await dispatchWhy(context, job);` con el mismo cuerpo que `dispatchTelegramOpening` (l.583-657): `loadIncident`, `holdsCollectionLock`, `beginOutboxAttempt`, envio, y el `switch (result.state)` hacia `recordTelegramSent/Retry/PermanentFailure/Uncertain`.
- Silencio al despachar: justo antes de `beginOutboxAttempt` en `dispatchTelegramOpening` (l.594-600) y en `dispatchPushJob` (l.990+), siguiendo el patron de supresion de l.594-596:

```typescript
if (incident.resolvedAt) return suppressJob(context, job, "resolved_before_send");
const telegram = context.config.telegram;
if (!telegram) return suppressJob(context, job, "telegram_disabled");
// + if (await activeSnooze(...)) return suppressJob(context, job, "snoozed");
```

- Tokens nuevos se emiten antes de la llamada HTTP en `dispatchTelegramOpening` y `dispatchEdit` (l.823+); el `buttonUrl` sigue saliendo de `incidentHref(context.config.betterAuthUrl, incident.hostId, incident.id)` (l.613-617).
- Clave del "por que": `incident:<id>:why:<noticeSeq>` con `onConflictDoNothing()` (patron de `incident-store.ts:759`). `projectRow` solo busca `incident-open` e `incident-edit`, asi que la respuesta no contamina el estado de entrega de Avisos.
- `recoverOutbox` ya trata el tipo no `incident-edit` con intento iniciado como incierto sin reenvio: correcto para una respuesta.

**`src/lib/incident-why.ts`**: la regla sale de `incident.detail` (umbral); el canal, de `notificationPolicy(incident.key, severity)` (`notification-policy.ts:70`) y de la fila de apertura; la lectura, de la ultima fila de `samples` del host (Open Question 1; omitir para claves sin metrica). Texto plano, sin tests sobre el copy.

### 05-03 · Resumen, hub y verificacion

**`src/lib/digest-content.ts`**. `digestOpen` (l.303-305) ampliar a `suppressed` con `openReason = 'snoozed'`, sin cambiar `totals` (l.309-316) ni los contadores:

```sql
(w."openChannel" = 'digest'
  AND w."openStatus" = 'suppressed'
  AND w."openReason" = 'digest_pending') AS "digestOpen"
```

- El `detail` (l.322+) filtra con `f."openNow" AND f."digestOpen"` (l.326, 334). Anadir `acknowledgedAt` y el `until` de `incident_snoozes` y etiquetar *Reconocida* / *Silenciada hasta HH:MM* con `Intl` y `timeZone: "Europe/Madrid"` (o `src/lib/madrid-day.ts`). Solo se etiqueta lo ya listado (Open Question 2).

**`src/app/api/[...path]/route.ts`**. Rama existente, copiar la validacion de id:

```typescript
// l.235-249
const incidentRoute = /^incidents\/([^/]+)$/.exec(route);
const id = z.string().regex(/^[1-9]\d{0,9}$/).safeParse(incidentRoute[1]);
if (!id.success) return json({ error: "No encontrado" }, 404);
const incidentId = Number(id.data);
if (!Number.isSafeInteger(incidentId) || incidentId > 2_147_483_647) return json({ error: "No encontrado" }, 404);
```

- Nueva rama `^incidents/([^/]+)/(acknowledge|snooze|unsnooze)$` para `POST`. `Origin` ya se exige en toda mutacion (l.127); la sesion en `handle` (`auth.api.getSession`, l.170). Cuerpo de `snooze` validado con zod (`{ hours: 1 | 24 }`). Llama a `incident-actions` con `via: "hub"`. No exigir verificacion reciente (fase 6 fija la lista).
- `export const GET/POST = handle;` ya existe (l.812-813). No hay API nueva de Next; no hace falta abrir `node_modules/next/dist/docs` salvo que se anada algo mas que una rama.

**`src/components/views/alerts.tsx`**. Atributos `data-*` como gancho de test (ver `data-delivery-part` y `data-delivery-state`, l.135-137, y `data-digest-*`, l.104-109). Anadir `data-ack-state`, `data-snooze-until` y botones con `data-action="acknowledge|snooze-1h|snooze-24h|unsnooze"`. Los mapas de etiquetas finitas (l.13-47) se amplian con el mismo estilo `Record<..., string>`.

## Shared Patterns

- **Un solo escritor.** Solo el dueno del lock consume updates y envia (INCD-06). Cada carril entra con `holdsCollectionLock` (`notification-dispatch.ts:1051`) y propaga `CollectionLockLost`. Las mutaciones de estado usan el pool `db`, no `lock`.
- **Salida a Telegram solo por el outbox.** Cooldown 429 (`telegram_cooldown`, `TELEGRAM_COOLDOWN_CHANNEL`, `notification-dispatch.ts:103`), intento incierto sin reenvio y truncado 4096 ya viven en el dispatcher. `answerCallbackQuery` es la unica excepcion (efimero, omitido en cooldown).
- **Resultados finitos y sin token.** Ninguna linea de log lleva `Update`, `callback_data`, ids de usuario ni texto de error. Solo `update_id` y accion, en transiciones.
- **Ediciones silenciosas por `seq`.** `editKey(incidentId, seq)` + PK `(incidentId, seq)` de `incident_events` (`schema.ts:205`) dan coalescencia; `recordTelegramSent` programa la edicion final si `incident.seq > job.revision` (`notification-dispatch.ts:~417`).
- **Tests.** `describe.skipIf(!baseUrl)` con `createTestDatabase`, `migrate(db, { migrationsFolder: "./drizzle" })`, import dinamico tras fijar `DATABASE_URL` y limpieza en `beforeEach` (`tests/notification-dispatch.test.ts:64-122`). Anadir `tokens`, `snoozes` y `telegramPollState` a esa limpieza. Transporte inyectado con `fakeFetch` (`tests/telegram.test.ts:23-39`). Ejecutar con `HUB_REQUIRE_TEST_DB=1` y `DATABASE_URL` de loopback (`tests/database.ts:11-35`).
- **CODING_STANDARD.md.** Asertar estado y estructura (filas del outbox, `reply_parameters.message_id`, `disable_notification`, `callback_data`, `data-*`), nunca el texto de toasts ni avisos. Ejecutar la suite de redaccion tambien bajo Node 26.

## No Analog Found

| Pieza | Rol | Flujo | Motivo |
| --- | --- | --- | --- |
| `getUpdates` con offset persistido, `deleteWebhook` y `telegram_poll_state` | servicio | polling | No existe ningun consumidor entrante; usar el encaje del lock de `worker-loop.ts` y el boceto de 05-RESEARCH.md (patrones 1 y 2). |
| `tests/telegram-fake.ts` con cola de updates y confirmacion por `offset` | test (arnes) | event-driven | `fakeFetch` solo captura peticiones; hay que implementar offset, `allowed_updates`, 429 y reinicio. |
| Consumo de token (`UPDATE ... WHERE usedAt IS NULL RETURNING`) | servicio | CRUD | Sin tokens de un solo uso previos; el patron mas cercano es el reclamo con `claimToken` de `claimOutboxJob` (l.244-287). |

## Metadata

**Ambito de busqueda** `src/lib`, `src/worker.ts`, `src/app/api`, `src/components/views`, `drizzle`, `tests`.
**Archivos leidos** 12 (lecturas dirigidas con rangos; ninguno releido).
**Verificacion de rastreo** `git ls-files` confirma todos los analogos como fuente rastreada; ningun espejo `.gsd/capabilities` aparece.
**Fecha de extraccion** 2026-11-26
