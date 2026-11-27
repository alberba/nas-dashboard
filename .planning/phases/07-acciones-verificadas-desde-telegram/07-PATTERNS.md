# Fase 7: Acciones verificadas desde Telegram - Mapa de patrones

**Mapeado:** 2026-11-27
**Archivos analizados:** 22 (nuevos y modificados)
**Analogos encontrados:** 21 / 22
**Fuente de lineas:** codigo vivo (el mapa `.planning/codebase/*.md` esta obsoleto). Todos los analogos son archivos rastreados por git (`src/`, `drizzle/`, `tests/`); ninguno es un espejo ignorado.

## Clasificacion de archivos

| Archivo nuevo/modificado | Rol | Flujo de datos | Analogo mas cercano | Calidad |
|---|---|---|---|---|
| `drizzle/0008_acciones_telegram.sql` | migracion | batch | `drizzle/0007_bot_reconocimiento.sql` | exacto |
| `src/lib/schema.ts` (+`telegramActionIntents`, `operations.channel/requestedBy`, `notificationOutbox.keyboardView`) | modelo | CRUD | `telegramActionTokens` (336-356) + `incidents_open_host_key_idx` (191-193) | exacto |
| `src/lib/telegram-intents.ts` | servicio | CRUD / transaccion | `src/lib/incident-actions.ts` (`consumeActionToken`, `applyIncidentAction`) | role-match |
| `src/lib/telegram-keyboard.ts` (ampliar) | utilidad | transform | el propio archivo | exacto |
| `src/lib/telegram-updates.ts` (`applyTokenAction`) | servicio | event-driven | el propio archivo (171-215) | exacto |
| `src/lib/incident-store.ts` (`queueKeyboardEdit`) | servicio | CRUD / outbox | `queueEdit` (162-196) | exacto |
| `src/lib/notification-dispatch.ts` (`dispatchEdit`) | servicio | event-driven | el propio archivo (1011-1100) | exacto |
| `src/lib/telegram.ts` (`TelegramActionButton` con url, `buttons`) | utilidad | request-response | el propio archivo (55-60, 349-363) | exacto |
| `src/lib/operation-runner.ts` | servicio | request-response | `route.ts` rama `action` (611-766) + `host-commands.ts` `executeHostCommand` | exacto (extraccion) |
| `src/lib/host-commands.ts` (channel/requestedBy) | servicio | request-response | el propio archivo (104-216) | exacto |
| `src/app/api/[...path]/route.ts` (+2 rutas) | controlador | request-response | rama `host-command` (249) y `action` (611) | exacto |
| `src/lib/sensitive-actions.ts` (+rutas, `requiresVerificationForIntent`) | config | request-response | el propio archivo (31-149) | exacto |
| `src/lib/verification-api.ts` (`guardIntentAction`) | middleware | request-response | `guardSensitiveAction` (94-113) | exacto |
| `src/lib/incident-actions.ts` (`KNOWN_ACTIONS`) | utilidad | transform | el propio archivo (220-226) | exacto |
| `src/lib/telegram-cleanup.ts` (+intents) | servicio | batch | el propio archivo (36-61) | exacto |
| `src/lib/runtime-config.ts` (`TELEGRAM_DIRECT_ACTIONS`) | config | transform | validacion de `TELEGRAM_*` (296-322) | role-match |
| `src/lib/telegram-handoff-client.ts` | utilidad (cliente) | transform | `useEffect` de `#setup=` en `login.tsx` (19-25) | partial |
| `src/components/views/telegram-handoff.tsx` | componente | request-response | `src/components/sensitive-action/sensitive-action.tsx` + uso en `alerts.tsx` | role-match |
| `src/components/sensitive-action/sensitive-action.tsx` (`requiresVerification?`) | componente | request-response | el propio archivo (30-80, 100-150, 196-228) | exacto |
| `src/components/login.tsx`, `dashboard.tsx` (captura de fragmento) | componente | event-driven | `login.tsx` 19-25 | exacto |
| `src/types.ts` (`Operation.channel`) y `publicOperation` | modelo | transform | `types.ts:354-362` | exacto |
| Tests nuevos (`telegram-intents`, `api-telegram-intents`, `telegram-keyboard`, `telegram-handoff-client`, `e2e/telegram-handoff`) | test | varios | `tests/telegram-updates.test.ts`, `tests/sensitive-actions.test.ts`, `tests/e2e/sensitive-action.spec.ts` | role-match |

## Asignaciones de patrones

### `drizzle/0008_acciones_telegram.sql` (migracion, batch)

**Analogo:** `drizzle/0007_bot_reconocimiento.sql`. Migracion aditiva: `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN` y FK en `--> statement-breakpoint`; indices al final. Comillas dobles en columnas camelCase.

```sql
CREATE TABLE "telegram_action_tokens" (
	"tokenHash" text PRIMARY KEY NOT NULL,
	"incidentId" integer NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"usedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledgedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_action_tokens" ADD CONSTRAINT "telegram_action_tokens_incidentId_incidents_id_fk" FOREIGN KEY ("incidentId") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_action_tokens_incident_idx" ON "telegram_action_tokens" USING btree ("incidentId");
```

Para el indice unico parcial, el snapshot de drizzle debe generar `CREATE UNIQUE INDEX ... WHERE "status" = 'pending'`. Las columnas nuevas de `operations` deben llevar `DEFAULT 'hub'` y `requestedBy` nullable (no reescribir filas; ver test de 0007 en `tests/migrations.test.ts`). Generar con drizzle-kit para actualizar `drizzle/meta`.

---

### `src/lib/schema.ts` (modelo, CRUD)

**Analogo de tabla:** `telegramActionTokens` (336-356): PK, FK con `onDelete: "cascade"`, `expiresAt`/`usedAt`/`createdAt` con `timestamp({ withTimezone: true })`.

**Analogo de indice unico parcial** (191-193):
```ts
uniqueIndex("incidents_open_host_key_idx")
  .on(t.hostId, t.key)
  .where(sql`${t.resolvedAt} is null`),
```
Aplicar como `uniqueIndex("telegram_action_intents_live_idx").on(t.incidentId).where(sql\`${t.status} = 'pending'\`)` (D-10). `telegram_action_intents.userId` como `text().references(() => user.id, ...)` igual que `notificationOutbox.ownerUserId` (`schema.ts:240`).

**`operations`** (397-411): hoy `id, hostId, userId, action, target, status, detail, at, bootAt`. Anadir `channel: text().notNull().default("hub")` y `requestedBy: text()`. **`notificationOutbox`** (234-270): anadir `keyboardView: text().notNull().default("normal")`; el indice `notification_outbox_key_idx` es unico sobre `key`, la razon por la que las ediciones de teclado necesitan clave propia.

---

### `src/lib/telegram-keyboard.ts` (utilidad, transform)

**Analogo:** el mismo archivo. Ampliar `TELEGRAM_ACTIONS` (19-25) con `menu_open`, `menu_close`, `act_start`, `act_restart`, `act_reboot`, `act_backup_now`, `act_deploy_now`, `intent_cancel`; extender `ACTION_LABELS: Record<TelegramAction, string>` (32-38, el tipo `Record` obliga a completar todas); `KeyboardState` (55-59) ampliado con vista, intent vivo y acciones ofrecidas.

**Core a conservar** (token y limite de 64 bytes, 41-53):
```ts
const CALLBACK_DATA_PATTERN = /^v1:[A-Za-z0-9_-]{22}$/;
export function generateActionToken(): string {
  return `v1:${randomBytes(16).toString("base64url")}`;
}
export function hashActionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

**Render que hay que refactorizar** (120-146): `renderActionRows` reparte filas con listas hardcodeadas (`action !== "ack" && ...`). Al anadir acciones, dejar de enumerar y modelar filas por vista (normal / actions / intent vivo). `keyboardActions` (67-75) es el patron para `hostActionsFor(key)` pura: `if (state.resolved) return ["why"]` y el resto acumulado en un array. Tras resolver, D-06: solo `why` (+ botones de intent vivo si D-05).

`issueActionTokens` (85-111) inserta un hash por accion al renderizar; las acciones `act_*` de la vista "Acciones" se emiten igual. El token url del handoff NO usa este camino (HMAC recomputable, Pattern 4 de la research).

---

### `src/lib/telegram-updates.ts` `applyTokenAction` (servicio, event-driven)

**Analogo:** el mismo archivo, 171-215. Recibe `tx`, un `switch` sobre `consumed.action`, devuelve `"applied" | "unchanged" | "ignored"` (157). Anadir ramas `menu_open`, `menu_close`, `act_*`, `intent_cancel`; el switch es exhaustivo por el tipo, el compilador senala las que falten.

```ts
export async function applyTokenAction(
  tx: Transaction,
  consumed: { incidentId: number; action: TelegramAction },
  context: { via: "telegram"; now: number },
): Promise<TokenActionResult> {
  ...
  switch (consumed.action) {
    case "why": {
      const outcome = await enqueueWhyReply(tx, { incidentId: consumed.incidentId });
      if (outcome === "queued") return "applied";
      if (outcome === "duplicate") return "unchanged";
      return "ignored";
    }
```

El contexto necesita `secret` (`config.betterAuthSecret`) para el HMAC; el call-site (440-442) esta dentro de `db.transaction(...)` junto al avance del offset (433-457): token consumido + efecto + offset en una transaccion. **El carril no debe importar `operation-runner`, `host-commands`, `lifecycle` ni `nas`** (D-00a; escaneo estatico de la research). Esqueleto de la creacion del intent: research, seccion "Creacion del intent dentro de la transaccion del carril". Resolver el pendiente vencido con `UPDATE ... status='expired'` antes del `INSERT ... onConflictDoNothing().returning()`.

---

### `src/lib/incident-store.ts` `queueKeyboardEdit` (servicio, CRUD/outbox)

**Analogo:** `queueEdit` (162-196). Copiar la busqueda de la fila confirmada y el `insert`; cambiar solo la clave y el `revision`.

```ts
function openKey(incidentId: number) { return `incident:${incidentId}:open`; }
function editKey(incidentId: number, seq: number) { return `incident:${incidentId}:edit:${seq}`; }
...
const [first] = await tx.select().from(notificationOutbox)
  .where(eq(notificationOutbox.key, openKey(incidentId))).limit(1);
if (!first || first.status !== "sent" || first.channel !== "telegram"
    || !first.chatId || !first.messageId) return "none";
await tx.insert(notificationOutbox).values({
  key: editKey(incidentId, seq),
  incidentId, kind: "incident-edit", channel: "telegram", status: "pending",
  revision: seq, chatId: first.chatId, messageId: first.messageId,
});
```

Nueva clave `incident:<id>:kb:<discriminador>`; para `:expire` anadir `nextAttemptAt: expiresAt` (columna existente, `schema.ts:245`). Escribir `keyboardView` en la fila `:open` dentro de la misma transaccion.

---

### `src/lib/notification-dispatch.ts` `dispatchEdit` (servicio, event-driven)

**Analogo:** el mismo archivo, 1011-1100. Ya carga `original` (fila `:open`) y vuelve a renderizar todo el aviso desde el estado de la BD:

```ts
const actionRows: TelegramActionButton[][] = renderActionRows(
  await issueActionTokens(workerDb(context.client), {
    incidentId: incident.id, chatId: original.chatId,
    actions: keyboardActions({ resolved: incident.resolvedAt !== null,
      acknowledged: incident.acknowledgedAt !== null, snoozed: snoozed !== null }),
    now: context.now,
  }),
);
...
const result = await editTelegramMessage({
  chatId: original.chatId, messageId: original.messageId,
  text: editText(incident, snoozed),
  buttonUrl: incidentHref(context.config.betterAuthUrl, incident.hostId, incident.id),
  actionRows, ...
```

Ampliar con: `original.keyboardView`, el intent vivo del incidente (marcar `expired` los vencidos al renderizar, Pitfall 6) y la linea de resultado de `:done`. Mantener el guard `job.revision < latestRevision()` (1050, 1087): las ediciones de teclado usan `revision = seq` actual. El loader de job (`claimOutboxJob`, 275) no cambia al reutilizar `kind: "incident-edit"`.

---

### `src/lib/telegram.ts` (utilidad, request-response)

**Analogo:** el mismo archivo. `TelegramActionButton` (57-60) es `{ text; callbackData }`; hacerlo union con `{ text; url }`, y en `buttons()` (349-363) emitir `{ text, url }` si trae `url` y `callback_data` si no:

```ts
rows.push(row.map((button) => ({ text: button.text, callback_data: button.callbackData })));
```
El boton url «Abrir en el hub» (351) es el precedente del boton url del handoff. La URL del handoff extiende `incidentHref` (`src/components/views/routes.ts:86-110`) con `url.hash = "intent=<token>"`.

---

### `src/lib/operation-runner.ts` (servicio, request-response) y `src/lib/host-commands.ts`

**Analogo A (acciones de agente):** rama `action` de `src/app/api/[...path]/route.ts`, 611-766: insert `operations` con `onConflictDoNothing().returning()`, `nasForHost`, rama `reboot` con `bootAt`, `finalizeContainerOperation` para start/stop/restart, manejo `NasRejected`:

```ts
const inserted = await db.insert(operations).values({
  id: operationId, hostId: host.id, userId: current.user.id,
  action: body.action, target, status: "pending",
  bootAt: body.action === "reboot"
    ? new Date((latest[0].data.timestamp - latest[0].data.uptime) * 1000) : null,
}).onConflictDoNothing().returning();
if (!inserted.length) return json({ status: "pending" });
...
if (error instanceof NasRejected && error.status < 500) { ...status: "failed"... }
// Un timeout puede ocurrir tras ejecutar: nunca reintentar.
```
Extraer sin cambio de comportamiento y con los tests de `api-lifecycle` en verde antes de anadir el intent. Sustituir el literal `75000` (642) por `CONNECTION_STALE_MS`.

**Analogo B (comandos):** `executeHostCommand` (`host-commands.ts:104-216`) ya es compartible; su `insert` (hacia 146-156) solo necesita `channel` y `requestedBy` opcionales con defecto `hub`. Atencion: si `operations.id` ya existe devuelve `replayed` sin ejecutar, por eso el intent NO pre-inserta la operacion.

---

### `src/app/api/[...path]/route.ts` (controlador, request-response)

**Analogo:** ramas literales `route === "..."` (p. ej. `host-command` 249, `action` 611). Cada ruta nueva se despacha con un literal exacto (no `startsWith`) y lee el cuerpo solo con `readJsonBody` (`route.ts:64` import):

```ts
if (route === "action" && mutation) {
  const raw = await readJsonBody(request);
  const body = actionSchema.parse(raw);
  ...
  if (requiresVerificationForAction(body.action)) {
    const denied = await guardSensitiveAction({ request, session: current, store: verificationStore });
    if (denied) return denied;
  }
```
Nuevas: `telegram/intents/inspect` y `telegram/intents/execute` con `z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })`. Orden de `execute`: research Pattern 6 (404 uniforme, 410 caducado/cancelado, replay 200, `guardIntentAction` 403 sin consumir, prechequeos, reclamo atomico `UPDATE ... WHERE status='pending' AND expiresAt > now RETURNING`, runner, cierre).

---

### `src/lib/sensitive-actions.ts` (config)

**Analogo:** el mismo archivo. Entradas del manifiesto con la forma de 105-149, y `perItem` (84) para la ruta `execute`:

```ts
"host-command": { POST: perItem(hostCommandPolicies) },
action: { POST: perItem(actionPolicies) },
...
"push/test": { POST: exempt("Encola una prueba de aviso al propietario") },
```
Anadir `"telegram/intents/inspect": { POST: exempt("...") }` y `"telegram/intents/execute": { POST: perItem({ ...actionPolicies, ...hostCommandPolicies }) }`. `intentActionIds` + `requiresVerificationForIntent` delegan en `requiresVerificationForAction` (64-67) / `requiresVerificationForCommand` (69-73); ninguna segunda lista (D-00c). Valores actuales: `start` exento; `restart`, `reboot`, `deploy-now`, `backup-now` protegidos (31-54). Cada mutacion nueva requiere fila en `bodyLimitCases` (`tests/sensitive-actions.test.ts:225`, comprobado en 339/348).

---

### `src/lib/verification-api.ts` `guardIntentAction` (middleware)

**Analogo:** `guardSensitiveAction` (94-113). `guardIntentAction` lo envuelve:

```ts
export async function guardSensitiveAction({ request, session, store, now = new Date() }) {
  const method = verificationMethodForRequest(request);
  const failure = await requireRecentVerification(store, session, method, now);
  return failure ? json(failure, 403) : null;
}
```
Pasos: (1) `session.user.id !== intent.userId` -> 404 como desconocido; (2) si `requiresVerificationForIntent(intent.action)` llamar a `guardSensitiveAction` y devolver su 403. Decide por la accion almacenada, nunca por el cuerpo. Reutilizar el helper `json` con `Cache-Control: no-store` (12-14). Tal como D-12: `reboot` solo exige passkey; el servidor ya pone `confirmation: "REINICIAR NAS"` en el cuerpo al agente (`validation.ts:14-23`), sin frase tecleada en el hub.

---

### `src/lib/incident-actions.ts`, `src/lib/telegram-cleanup.ts`, `src/lib/runtime-config.ts`

- **`KNOWN_ACTIONS`** (`incident-actions.ts:220-226`): derivar de `TELEGRAM_ACTIONS` en lugar de duplicar. `consumeActionToken` (233) es el modelo de "UPDATE condicional de un uso".
- **`cleanupTelegramState`** (`telegram-cleanup.ts:36-61`): copiar el bloque `delete(...).where(lt(...)).returning(...)` para intents terminales viejos y anadir `intents` a `TelegramCleanupCounts`:
```ts
const tokens = await executor.delete(telegramActionTokens)
  .where(lt(telegramActionTokens.expiresAt, new Date(at.getTime() - TOKEN_RETENTION_AFTER_EXPIRY_MS)))
  .returning({ tokenHash: telegramActionTokens.tokenHash });
```
- **`runtime-config.ts`** (296-322): patron `env.X?.trim()` + `issues.add("X", "invalid")`; `TELEGRAM_DIRECT_ACTIONS` solo `0` o ausente, cualquier otro valor es `invalid` (arranque falla). Anadirlo comentado a `.env.example`.

---

### `src/lib/telegram-handoff-client.ts` (utilidad cliente pura)

**Analogo:** `src/components/login.tsx:19-25`:
```tsx
useEffect(() => {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("setup");
  if (tokenRef.current && token) tokenRef.current.value = token;
  if (token) window.history.replaceState(null, "", window.location.pathname);
}, []);
```
Diferencias a respetar: el handoff debe conservar `search` (`pathname + search`, no solo `pathname`), ser idempotente por Strict Mode (respaldo en `sessionStorage`) y recibir `location/history/storage` inyectados para testearlo en Node. Forma: research, "Captura del fragmento". `Login` (efecto de montaje) y el componente del handoff llaman a `captureHandoff`; `dashboard.tsx` `go()` (~126) y `signInAgain()` (~148) reescriben la URL sin hash, por eso el almacenamiento es necesario.

---

### `src/components/views/telegram-handoff.tsx` (componente)

**Analogo:** `src/components/sensitive-action/sensitive-action.tsx`. Usar `useSensitiveAction()` y `request({...})`; campos del `SensitiveActionRequest` (43-60): `title`, `description`, `consequences: { tone: "ok"|"warn", text }[]`, `confirmLabel`, `destructive`, `endpoint`, `body`, `typedConfirmation`, `idempotencyKey`, `onSettled(outcome)` con `status: "succeeded" | "pending" | "failed"`.

El `confirm()` (196-228) ya encadena verificacion + envio en un solo submit (decision: un solo paso). Montaje desde `AlertsView` (`alerts.tsx:371`). Exponer `data-handoff-state` con los estados de la tabla de la research; los tests asertan el atributo, no el copy (CODING_STANDARD). **D-12:** NO pasar `typedConfirmation` para `reboot` (anula A4 de la research).

**Modificacion del hook** (`requiresVerification?: boolean`, defecto `true`): el efecto de 123-143 hace `fetch("/api/verification")` y deja `verification` en `null` hasta responder; con `false`, saltar el fetch, inicializar `{ method: "passkey", recent: true, reason: null }` y poner `data-verification-required="false"` en el `<dialog>`. `inspect` devuelve `requiresVerification` calculado en servidor desde el manifiesto (Pitfall 3).

---

### Tests

- **`tests/telegram-intents.test.ts`, `tests/api-telegram-intents.test.ts`:** analogo `tests/telegram-updates.test.ts` (cabecera 1-40: `createTestDatabase`, `testDatabaseUrl`, `createFakeBotApi` de `./telegram-fake`, `BOT_TOKEN`, `CHAT_ID`, reloj inyectado `START`, `BETTER_AUTH_URL`). Para sesion y passkey sembrada: `tests/verified-session.ts`. Aserciones sobre filas, codigos HTTP y `agent.requests`, nunca copy.
- **Escaneo estatico "lane"** y filas `bodyLimitCases`: `tests/sensitive-actions.test.ts` (225, 272-278, 333-355).
- **`tests/e2e/telegram-handoff.spec.ts`:** analogo `tests/e2e/sensitive-action.spec.ts` y `tests/e2e/login.ts`; `page.route` para `execute`.
- **Migracion:** ampliar `tests/migrations.test.ts` con el patron de 0007.
- **`tests/telegram-fake.ts`:** puede requerir registrar botones `url` en `editMessageText`.

## Patrones compartidos

### Transaccion unica "token + efecto + offset"
**Fuente:** `src/lib/telegram-updates.ts:433-457`
**Aplicar a:** toda rama nueva de `applyTokenAction`; un fallo antes del commit deja el token sin usar y el update se reentrega.

### Ediciones silenciosas por outbox
**Fuente:** `src/lib/incident-store.ts:162-196` (`queueEdit`) y `notification-dispatch.ts:1011-1100`
**Aplicar a:** menu, volver, intent creado, cancelar, caducidad y resultado. Nunca `editMessageText` directo desde el carril, nunca mensaje nuevo.

### Manifiesto como autoridad de lo protegido
**Fuente:** `src/lib/sensitive-actions.ts:31-73, 105-149`
**Aplicar a:** `guardIntentAction`, `inspect` (campo `requiresVerification`) y la ruta `execute`.

### Guard tras replay y antes del insert; 403 no registra operacion
**Fuente:** `route.ts:611-645` (idempotencia -> guard -> muestra -> insert)
**Aplicar a:** `execute` (403 sin consumir el intent; tope de una ejecucion con reclamo atomico).

### Cuerpos estrictos y limite de cuerpo
**Fuente:** `readJsonBody` + `z.strictObject` en `route.ts` (p. ej. 177, 349, 584); `BodyTooLarge` -> 413 (`verification-api.ts:67-69`)
**Aplicar a:** `inspect` y `execute`.

### Hash en base, token plano nunca
**Fuente:** `telegram-keyboard.ts:41-48` (SHA-256 hex); respuesta uniforme 404 para token desconocido o ajeno.

## Sin analogo

| Archivo/pieza | Rol | Flujo | Motivo |
|---|---|---|---|
| Token HMAC recomputable (`handoffToken`, `hashHandoffToken`, `sameHash`) en `telegram-intents.ts` | utilidad | transform | El repo solo tiene tokens aleatorios con hash (fase 5); usar el ejemplo "Token HMAC del handoff" de la research con `node:crypto` (`timingSafeEqual` ya se usa en `setup` del catch-all, ~163-180). |

## Notas para el planner

- Hoy `container:*` es silencioso y `reboot-pending` va al resumen: sin teclado en Telegram (D-11). Probar `hostActionsFor` con fixtures; UAT real con `backup-failed` y `deploy-failed`.
- `tests/` no debe acoplarse al copy de los botones; asertar `callback_data` (`v1:` + 22 caracteres, 25 bytes), `url` y `data-handoff-state`.
- Leer `node_modules/next/dist/docs/` antes de tocar rutas o navegacion cliente (AGENTS.md).
- Hacer primero la extraccion de `operation-runner.ts` sin cambio de comportamiento, con `tests/api-lifecycle.test.ts` y `tests/api-host-commands.test.ts` en verde.

## Metadatos

**Alcance de busqueda:** `src/lib`, `src/components`, `src/app/api`, `drizzle`, `tests`
**Archivos leidos:** CONTEXT, RESEARCH, CODING_STANDARD, `telegram-keyboard.ts`, `telegram-updates.ts` (290-492), `verification-api.ts`, `sensitive-actions.ts` (20-220), `login.tsx` (1-50), `sensitive-action.tsx` (1-230), `host-commands.ts` (100-277), `incident-store.ts` (150-200), `notification-dispatch.ts` (1011-1100), `schema.ts` (secciones), `route.ts` (611-766), `telegram-cleanup.ts`, `0007_bot_reconocimiento.sql`
**Fecha de extraccion:** 2026-11-27
