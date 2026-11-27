# Phase 7: Acciones verificadas desde Telegram - Research

**Researched:** 2026-11-27
**Domain:** Handoff de acciones de host desde un bot de Telegram (long polling) hacia el hub Next.js 16 con sesión y passkey; intents de un solo uso, outbox de ediciones, `operations` con canal y solicitante.
**Confidence:** HIGH en el código existente (leído esta sesión); MEDIUM en el comportamiento de passkeys dentro del navegador interno de Telegram.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Ya fijado por el roadmap y la research (no se vuelve a discutir)**
- **D-00a:** Sin ejecución en el callback: `TELEGRAM_DIRECT_ACTIONS=0`. La ejecución directa con passkey reciente que describe `ARCHITECTURE.md` no se implementa como camino activo.
- **D-00b:** Intent con token de un solo uso y TTL de 5 min, con solo el hash en la base. El token viaja en el **fragmento** de la URL del hub y la UI lo borra con `history.replaceState`. La confirmación del hub muestra el verbo y el objetivo ("Reiniciar `plex` en nas-home").
- **D-00c:** `src/lib/sensitive-actions.ts` es la autoridad de qué exige verificación reciente. El handoff no crea una segunda lista.

**Acciones por tipo de aviso**
- **D-01:** Un aviso de contenedor (`container:<nombre>`) ofrece **Arrancar** (`start`) y **Reiniciar** (`restart`). Actualizar imagen, Detener y Eliminar no se ofrecen desde el chat.
- **D-02:** Avisos que no son de contenedor y llevan acción, solo con comandos que ya existen:
  - `backup-failed` → **Copia ahora** (`backup-now`)
  - `deploy-failed` → **Desplegar ahora** (`deploy-now`)
  - `reboot-pending` → **Reiniciar host** (`reboot`)
- **D-03:** `services-down` (host caído) **no ofrece ninguna acción**: con el agente sin responder, el hub no puede ejecutar nada. Conserva Reconocer, Silenciar, Por qué y Abrir en el hub. El resto de claves (`disk-health`, `release-retained`, `helper-cleanup`, `stack-unit-failed`, umbrales…) tampoco ofrece acciones en esta fase.
- **D-04:** **Toda acción iniciada en el chat pasa por el hub**, también `start`, que está exento. El hub aplica su manifiesto: exige sesión y confirmación siempre, y passkey solo para lo protegido. Así el chat y el hub nunca discrepan sobre qué está protegido.
- **D-05:** Si la incidencia se resuelve mientras hay un intent pendiente, el intent **sigue valiendo** hasta que caduque. El diálogo del hub indica que la incidencia ya está resuelta y deja confirmar.
- **D-06:** Al resolverse la incidencia, los botones de acción desaparecen del aviso, igual que Reconocer y Silenciar (D-10 de la fase 5). Un intent ya emitido se rige por D-05.

**Botones en el mensaje**
- **D-07:** Las acciones van **detrás de un botón «Acciones…»**. Pulsarlo edita el teclado en silencio: muestra las acciones del aviso y **«Volver»**, que restaura el teclado normal. Solo aparece «Acciones…» en los avisos que tienen acciones según D-01..D-03. — **Reversibility:** reversible — es solo el render del teclado.
- **D-08:** Al pulsar una acción, el bot crea el intent y edita el **mismo aviso** en silencio: la acción pasa a ser un **botón url** «Confirmar en el hub: <verbo> <objetivo>», válido 5 min. No se envía un mensaje nuevo y no se usa `answerCallbackQuery.url`, que solo sirve para juegos o enlaces `t.me`.
- **D-09:** Al caducar el intent, **el worker restaura el teclado** con una edición silenciosa (vuelve «Acciones…»). El chat nunca deja a la vista un enlace muerto. Si alguien abre el enlace ya caducado antes de la edición, el hub muestra «caducado» y no ejecuta nada.
- **D-10:** **Un intent vivo por aviso.** Mientras está pendiente, el teclado muestra su botón url y **«Cancelar»**. Cancelar invalida el intent y restaura el teclado. Nunca hay dos enlaces vivos para el mismo aviso. Una acción nueva sobre el mismo aviso obliga a cancelar antes o a esperar a que caduque. — **Reversibility:** costly — la unicidad del intent vivo por incidencia es una restricción de esquema (índice único parcial), y la consultan el bot, el worker y el hub.

### Claude's Discretion
- **Pantalla del handoff** (sin discutir; seguir la research): diálogo en Avisos con verbo y objetivo, que reutiliza `useSensitiveAction` para la passkey. Hay que decidir si confirmar y verificar es un solo paso o dos. Sin sesión: login y volver sin perder el intent (el fragmento no llega al servidor, así que hay que conservarlo en el cliente durante el login). El método de verificación (solo passkey o también contraseña) lo decide lo que ya acepte `guardSensitiveAction`; no se inventa una política nueva.
- **Resultado en Telegram** (sin discutir): tras ejecutar, editar el aviso original en silencio con el resultado («Reiniciado plex 10:32» o fallo) y restaurar el teclado según el estado. Decidir si actuar reconoce la incidencia; por defecto, no.
- Forma del endpoint de ejecución (`/api/telegram/intents/execute` u otra rama del catch-all, declarada en el manifiesto de rutas de la fase 6) y si `guardIntentAction` envuelve o reutiliza `guardSensitiveAction`.
- Columnas de `operations` para el canal (`telegram`/`hub`) y el solicitante, y si el id del intent es el id de la operación, que es lo que propone la research para deduplicar el replay.
- Tokens de los botones «Acciones…», «Volver» y «Cancelar»: mismo modelo que la fase 5 (`v1:` + 128 bits, hash, de un solo uso) y nuevas entradas en `TELEGRAM_ACTIONS`. `callback_data` ≤ 64 bytes.
- Cómo descubre el worker los intents vencidos para D-09: barrido en el bucle o fila en el outbox con `nextAttemptAt`.

### Deferred Ideas (OUT OF SCOPE)
- Actualizar imagen, Detener y acciones para `stack-unit-failed` o `disk-health` desde el chat: fuera de esta fase.
- La ejecución directa con passkey reciente (`TELEGRAM_DIRECT_ACTIONS=1`) queda para cuando el handoff esté probado.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BOT-07 | El operador puede iniciar una acción de host desde Telegram y completarla en el hub con sesión y passkey | Callback crea el intent (sin ejecutar), botón url con token en fragmento, `inspect` + diálogo reutilizando `useSensitiveAction`, `execute` con `guardIntentAction`; secciones "Architecture Patterns" y "Pantalla del handoff" |
| BOT-08 | Ninguna acción destructiva iniciada desde Telegram se ejecuta sin verificación reciente en el servidor | `guardIntentAction` decide por la acción **almacenada** en el intent y consulta el manifiesto (`requiresVerificationForAction/Command`); 403 sin consumir el intent; tests de whole-route |
| BOT-09 | Cada acción iniciada desde Telegram queda en `operations` con canal y solicitante | Migración aditiva `operations.channel` + `requestedBy`; `operations.id` = `intent.id`; extracción de `operation-runner.ts` para que la ruta `/api/action` y el intent compartan el registro |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

No existe `./CLAUDE.md`; rigen `./AGENTS.md` y `./CODING_STANDARD.md` (más `claude_md_path: ./.agents/GEMINI.md` en la config, que solo contiene flujos GSD). Directivas accionables:

- **Next.js 16.4.6 difiere del conocido.** Leer `node_modules/next/dist/docs/` antes de tocar rutas, proxy o navegación cliente. Leído esta sesión: `01-app/02-guides/single-page-applications.md` (`history.replaceState` integrado en el router) y `01-app/03-api-reference/04-functions/use-router.md` (navegaciones solo de hash o de search no cambian `bfcacheId`). [CITED: node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md]
- **Los tests afirman comportamiento, nunca copy**: estado (`data-*`), resultado (URL, HTTP, fila guardada, petición enviada) o estructura (rol/label). Si un componente no expone el estado, añadir un `data-*`. Antes de editar texto de usuario, grep en `tests/` del texto antiguo. [VERIFIED: CODING_STANDARD.md:1-17]
- Toda ruta mutante nueva se declara en `routeManifest` o los escaneos de `tests/sensitive-actions.test.ts` fallan (06-05).
- Idioma: artefactos en español; identificadores de código en inglés.
- Shell (CLAUDE.md global del usuario): entrecomillar globs; BSD `sed -i ''`; llaves en `"${ref}:path"` en zsh.
- Hook de lectura de secretos: no leer `.env.local`; los nombres de variables salen de `.env.example`.

## Summary

La fase se reduce a cuatro piezas nuevas sobre cimientos que ya existen: (1) un intent persistido (`telegram_action_intents`) que el **carril de updates** crea dentro de la misma transacción que consume el token del botón, sin llamar jamás al agente; (2) una edición del aviso por el **outbox existente** que muestra el botón url con el token en el fragmento; (3) dos rutas del catch-all (`telegram/intents/inspect` y `telegram/intents/execute`) y un diálogo en Avisos que reutiliza `useSensitiveAction`; (4) la ejecución única a través de un `operation-runner.ts` extraído de `/api/action`, con `operations.channel` y `requestedBy`. El handoff por fragmento sí tiene un precedente parcial en el repo: `Login` ya lee `#setup=` y lo borra con `replaceState` (`src/components/login.tsx:19-24`), aunque no cruza un login.

Hay cuatro hallazgos que cambian el plan respecto a lo que CONTEXT.md da por supuesto. **(a)** Con la política actual, los avisos `container:*` son `silent` y `reboot-pending` va al resumen: **ninguno de los dos llega a Telegram con teclado**, así que D-01 y la fila `reboot-pending` de D-02 se implementan pero no tienen superficie real en el chat; solo `backup-failed` y `deploy-failed` (críticas inmediatas) la tienen (ver Pitfall 1 y Open Question 1). **(b)** `queueEdit` usa la clave `incident:<id>:edit:<seq>`, única por índice: las ediciones solo de teclado (Acciones…, Volver, intent, cancelar, caducar) no cambian `seq` y colisionarían, así que necesitan su propia clave y un estado de teclado persistido. **(c)** El token del handoff no se puede guardar en claro (D-00b) y el render del aviso ocurre en el worker, por lo que el token debe poder **recomputarse** en el render: se recomienda derivarlo con HMAC del id del intent, no generarlo al azar. **(d)** `useSensitiveAction` pide passkey siempre que no haya verificación reciente, incluso para una acción exenta como `start`; hay que añadirle un modo sin verificación o `start` quedaría bloqueado por una passkey que el manifiesto no exige.

**Primary recommendation:** Una migración `0008` aditiva con todo el esquema de la fase (tabla de intents con índice único parcial, columna de vista de teclado en el outbox, `operations.channel` y `requestedBy`); un módulo `src/lib/telegram-intents.ts` como única autoridad del ciclo de vida del intent; el carril solo crea/cancela intents y encola ediciones; `execute` es la única ruta que llama a `operation-runner.ts`, tras `guardIntentAction`, con reclamo atómico del intent antes de enviar nada al agente.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Aceptar la pulsación de «Acciones…», «Volver», una acción o «Cancelar» | Worker (carril de updates, long polling) | Database | Único consumidor de `getUpdates` con el lock; consume token + efecto + offset en una transacción |
| Crear/cancelar/caducar el intent | Database (tabla + índice único parcial) | Worker | La unicidad "un intent vivo por aviso" es una restricción de esquema (D-10) |
| Renderizar teclado y botón url del aviso | Worker (outbox, `dispatchEdit`) | Database | Las ediciones pasan siempre por el outbox, con `disable_notification`; el render es función del estado en BD |
| Caducidad visible en el chat (D-09) | Worker (fila de outbox con `nextAttemptAt`) | — | Reutiliza claim, lease, cooldown y reintento; sin barrido nuevo |
| Capturar el token del fragmento y sobrevivir al login | Browser / Client | — | El fragmento no llega al servidor; solo el cliente puede leerlo |
| Mostrar verbo/objetivo y estados del intent | API / Backend (`inspect`) | Browser | El fragmento solo trae un token opaco; verbo, objetivo y estado los sabe el servidor |
| Decidir si hace falta passkey | API / Backend (`guardIntentAction` → manifiesto) | Browser (solo explica) | D-00c: el servidor decide por la acción almacenada, nunca por el cuerpo |
| Ejecutar la acción y registrar la operación | API / Backend (`operation-runner.ts`) | Agente del host | Único punto que habla con el agente; `operations.id` = `intent.id` |
| Reflejar el resultado en el aviso | Worker (outbox) | Database | Edición silenciosa derivada del último intent terminal |

## Standard Stack

### Core

No se añade ninguna dependencia. Todo se construye con lo instalado. [VERIFIED: package.json:17-31]

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | 16.4.6 | Catch-all de rutas, página, cliente | Ya en uso; leer docs locales antes de tocar rutas |
| react / react-dom | 19.3.1 | Diálogo y panel del handoff | Ya en uso |
| drizzle-orm | ^0.45.4 | Tabla de intents, índice único parcial, migración `0008` | `uniqueIndex(...).where(sql...)` ya se usa en `incidents` (`schema.ts`, `incidents_open_host_key_idx`) |
| pg | ^8.23.1 | Transacción del carril y cliente del worker | Ya en uso |
| zod | ^4.6.7 | Cuerpos estrictos de `inspect` y `execute` | Patrón de las rutas existentes (`z.strictObject`) |
| better-auth + @better-auth/passkey | ^1.7.20 | Verificación con passkey (`authClient.signIn.passkey()`) | Ya graba `recent_verification` en `rememberPasskeyVerification` |
| node:crypto | built-in | `createHmac`/`timingSafeEqual` para el token del handoff | Sin dependencias nuevas |
| vitest / @playwright/test | ^5.1.0 / ^1.65.0 | Pruebas | Ya en uso |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | ^1.72.0 | Iconos del panel del handoff | Solo si el panel necesita icono (`ShieldCheck`, `Clock`, ya usados en el diálogo) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Token del handoff derivado por HMAC | Token aleatorio emitido al renderizar y hash sobrescrito (modelo de la fase 5) | Más simple, pero un render superado o fallido sobrescribe el hash y deja muerto el enlace del último mensaje entregado. Ver Pitfall 5 |
| Fila de outbox con `nextAttemptAt = expiresAt` | Barrido periódico en el bucle del worker | El barrido añade un consumidor nuevo con su lease; la fila reutiliza claim/reintento/cooldown |
| `sessionStorage` para conservar el token durante login/refresh | Conservar el fragmento en la URL durante el login y reañadirlo | `signInAgain()` y `go()` reescriben la URL y lo perderían; `sessionStorage` cubre login, refresh y 401 con un solo camino |

**Installation:** ninguna.

**Version verification:** no aplica; no se instala ningún paquete.

## Package Legitimacy Audit

No se instala ningún paquete externo en esta fase: el gate de legitimidad no aplica. Paquetes eliminados por veredicto SLOP: ninguno. Paquetes marcados SUS: ninguno.

## Architecture Patterns

### System Architecture Diagram

```
 Telegram (móvil)                       Worker (lock de recolección)                    PostgreSQL
 ----------------                       ----------------------------                    ----------
 [Acciones…] --callback--> getUpdates --> isAuthorizedCallback (allowlist)
 [Reiniciar] --callback-->               |
                                         v  UNA transacción (pool tx)
                                   consumeActionToken ──────────────────────────> telegram_action_tokens.usedAt
                                         |
                                   applyTokenAction
                                    ├─ menu_open/menu_close ───────────────────> notification_outbox(keyboardView)
                                    ├─ act_<verbo>: hostActionsFor(incident.key)
                                    │     ├─ no ofrecida / resuelta ─> "ignored"
                                    │     ├─ ya hay intent vivo ─────> índice único => "unchanged"
                                    │     └─ INSERT intent (pending, hash HMAC) ─> telegram_action_intents
                                    └─ intent_cancel ───────────────────────────> intent.status='cancelled'
                                         |   + INSERT outbox kind incident-edit (clave kb:…) 
                                         |   + (solo intent nuevo) INSERT outbox kb:…:expire, nextAttemptAt=expiresAt
                                         v  avanza offset (misma tx)  ✗ NUNCA llama a agente / host-commands / lifecycle
                                   answerCallbackQuery (toast)

 dispatchEdit (worker) ── lee incidente + intent vivo + keyboardView ──> render ──> editMessageText (silencioso)
        teclado: [Reconocer…] / [Acciones…] | [Arrancar][Reiniciar][Volver] | [Confirmar en el hub: … ↗ url][Cancelar]
        url = https://<hub>/?view=alerts&host=<h>&incident=<id>#intent=<token HMAC>

 Hub (navegador)                       API (catch-all)                                   Agente del host
 ---------------                       ---------------                                   ---------------
 abre el enlace
  ├─ sin sesión: server renderiza <Login>; Login captura #intent → sessionStorage, quita el hash
  └─ con sesión: Dashboard → TelegramHandoff captura #intent → sessionStorage, replaceState(sin hash)
 POST telegram/intents/inspect {token} ──> sesión → hash → intent (userId) ──> {state, verbo, objetivo, host, resolved, requiresVerification}
 diálogo (useSensitiveAction)
   confirmar: passkey (si requiresVerification) ──> POST telegram/intents/execute {token}
                                          sesión → intent → guardIntentAction (manifiesto, 403 sin consumir)
                                          → reclamo atómico pending→executing → operation-runner ──> POST /action | /command
                                          → operations(id=intent.id, channel='telegram', requestedBy) → intent.status final
                                          → outbox kb:…:done (resultado en el aviso)
```

### Recommended Project Structure

```
src/lib/
├── telegram-intents.ts        # ciclo de vida: crear, cancelar, caducar, reclamar, finalizar; hostActionsFor; token HMAC
├── operation-runner.ts        # extraído de /api/action: runAgentAction + wrapper de host-command; channel/requestedBy
├── telegram-keyboard.ts       # + acciones nuevas, KeyboardState ampliado, renderizado de filas con url button
├── telegram-updates.ts        # applyTokenAction ampliado (solo crea/cancela intents)
├── incident-actions.ts        # KNOWN_ACTIONS derivado de TELEGRAM_ACTIONS (hoy duplicado)
├── notification-dispatch.ts   # dispatchEdit: render de teclado por vista/intent y línea de resultado
├── sensitive-actions.ts       # + rutas telegram/intents/* y requiresVerificationForIntent
├── verification-api.ts        # + guardIntentAction
├── telegram.ts                # TelegramActionButton admite {text,url}
├── telegram-cleanup.ts        # + barrido de intents terminales viejos
└── runtime-config.ts          # + TELEGRAM_DIRECT_ACTIONS (solo "0" o ausente)
src/components/
├── views/telegram-handoff.tsx # panel de Avisos + apertura del diálogo; data-handoff-state
├── sensitive-action/…         # useSensitiveAction: requiresVerification?: false
└── login.tsx, dashboard.tsx   # capturan el fragmento (módulo cliente puro)
src/lib/telegram-handoff-client.ts  # parseHandoffFragment / captureHandoff / readStoredHandoff / clearHandoff (puro, testeable en Node)
drizzle/0008_acciones_telegram.sql
```

### Pattern 1: El carril solo registra la intención

**What:** `applyTokenAction` ya recibe `tx`. Las acciones nuevas crean, cancelan o abren menú dentro de esa misma transacción y encolan una edición del aviso; no importan `operation-runner`, `host-commands` ni `lifecycle`.
**When to use:** siempre; es D-00a.
**Código existente que se amplía:** [VERIFIED: src/lib/telegram-updates.ts:432-457]

```ts
const outcome = await db.transaction(async (tx) => {
  const consumed = await consumeActionToken(tx, {
    token: callback.data,
    chatId: String(callback.chatId),
    messageId: String(callback.messageId),
    now: clock(),
  });
  const result: TokenActionResult = consumed.ok
    ? await applyTokenAction(tx, consumed, { via: "telegram", now: clock() })
    : "ignored";
  // … avanza telegram_poll_state en la misma transacción
```

Prueba de que no ejecuta: (i) escaneo estático (patrón ya usado en `tests/sensitive-actions.test.ts`, `readFileSync` + regex) que falla si `telegram-updates.ts`, `telegram-intents.ts` (rama de creación) o `telegram-keyboard.ts` importan `operation-runner`, `host-commands`, `lifecycle` o `nas`; (ii) prueba de comportamiento con el agente falso: tras pulsar cada acción, `agent.requests` está vacío y `operations` sin filas.

### Pattern 2: Ediciones solo de teclado con clave propia y render derivado del estado

**What:** `dispatchEdit` ya vuelve a renderizar el aviso completo a partir del estado actual de la BD en cada envío (incidente, silencio) y emite tokens nuevos. Se amplía el render con dos entradas más: la **vista de teclado** del aviso (`normal` | `actions`) y el **intent vivo** del incidente. Como el render es una función del estado, cualquier edición que llegue a enviarse entrega el estado completo, y el orden entre ediciones no importa.
**Why:** `queueEdit` escribe la clave `incident:<id>:edit:<seq>` con índice único (`uniqueIndex("notification_outbox_key_idx").on(t.key)`) y `revision = seq`. Un cambio de teclado no mueve `seq`, así que reutilizar `queueEdit` chocaría o sería un no-op. [VERIFIED: src/lib/incident-store.ts:162-196; src/lib/schema.ts:265]
**Cómo:** nuevo helper `queueKeyboardEdit(tx, incidentId, discriminator, { notBefore? })` que inserta `kind: "incident-edit"`, `channel: "telegram"`, `revision = incidents.seq` actual, `chatId/messageId` copiados de la fila confirmada `incident:<id>:open`, y `key = incident:<id>:kb:<discriminador>`. Discriminadores únicos y deterministas:
- pulsación de menú/volver/cancelar: los 16 primeros hex del `tokenHash` consumido (único por pulsación, idempotente si la transacción se repite);
- intent creado: `…:kb:i<intentId>:open`;
- caducidad: `…:kb:i<intentId>:expire` con `nextAttemptAt = intent.expiresAt` (D-09);
- resultado: `…:kb:i<intentId>:done`.

Reutilizar `kind: "incident-edit"` evita tocar el `claimOutboxJob` (`kind IN ('incident-open','incident-edit','incident-why','incident-push','push-test')`, `notification-dispatch.ts:275`), `recoverOutbox` (que trata `incident-edit` como reintentable por ser idempotente) y el dispatcher. Efecto secundario aceptado: `lastUpdate` del hub (la última fila `incident-edit` por `revision`/`id`) reflejará también ediciones de teclado; es veraz (el mensaje se editó).

**Estado de la vista de teclado:** una columna `keyboardView text not null default 'normal'` en la fila `incident:<id>:open` de `notification_outbox` (la fila del mensaje confirmado; `dispatchEdit` ya la carga como `original`). Alternativa: columna booleana en `incidents`. Se recomienda el outbox porque es estado del mensaje, no del incidente, y no toca la proyección pública `projectRow`.

### Pattern 3: Ciclo de vida del intent (máquina de estados)

| Estado | Quién lo escribe | Condición de salida |
|--------|------------------|---------------------|
| `pending` | carril (callback de acción) | vivo mientras `expiresAt > now` |
| `cancelled` | carril («Cancelar») | terminal |
| `expired` | cualquier lector que lo detecte (creación de otro intent, `dispatchEdit` de la fila `:expire`, `inspect`, limpieza) con `UPDATE … SET status='expired' WHERE status='pending' AND expiresAt <= now` | terminal |
| `executing` | `execute` (reclamo atómico `UPDATE … WHERE status='pending' AND expiresAt > now RETURNING`) | `executed` / `failed` / `uncertain` |
| `executed`, `failed`, `uncertain` | `execute` tras el runner | terminal |

**Por qué hace falta un estado `expired` escrito:** el índice único parcial no puede usar `now()` en su predicado. D-10 ("un intent vivo por aviso") se impone con `UNIQUE (incidentId) WHERE status = 'pending'`; antes de insertar un intent nuevo, la transacción del carril marca como `expired` los `pending` de ese incidente con `expiresAt <= now`. Una violación del índice = hay un intent vivo ⇒ resultado `unchanged` ("Ya hay una acción pendiente").

**Columnas recomendadas de `telegram_action_intents`** (no se persiste el id numérico de Telegram; el allowlist ya lo garantiza y la fase 5 evitó guardarlo, ver `acknowledgedBy` en `incident-actions.ts`): `id uuid pk`, `incidentId` fk cascade, `hostId`, `action` (cerrado: `start|restart|reboot|backup-now|deploy-now`), `target` (nombre mostrado: contenedor o nombre del host), `userId` fk `user`, `handoffHash` (sha256 hex del token), `status`, `createdAt`, `expiresAt`, `usedAt`, `finishedAt`. `ARCHITECTURE.md` proponía además `telegramUserId` y `verifiedAt`: se descartan (sin ejecución directa no hay verificación previa que guardar; D-00a).

### Pattern 4: Token del handoff derivado por HMAC

**What:** `token = base64url(HMAC-SHA256(subkey, intentId))` con `subkey = HMAC-SHA256(BETTER_AUTH_SECRET, "hub:telegram-handoff:v1")`. La BD guarda solo `sha256(token)` (D-00b); el worker recomputa el token en cada render a partir del `intentId` y de `config.betterAuthSecret`, que ya llega al carril (`input.config`) y al dispatcher (`context.config`). `execute`/`inspect` buscan por `sha256(token recibido)` y comparan con `timingSafeEqual`.
**Why:** el render ocurre en otro proceso y a veces repetido; un token aleatorio no se puede reproducir desde un hash. Con HMAC el enlace del mensaje es estable entre reintentos y ediciones superadas, y no hay escritura en el render. Rotar `BETTER_AUTH_SECRET` solo invalida intents vivos (≤5 min).
**Formato del token en la URL:** 43 caracteres `[A-Za-z0-9_-]`; fragmento `#intent=<token>`.
**Fallback si el equipo prefiere el modelo de la fase 5:** generar el token al renderizar y sobrescribir `handoffHash` **justo antes** de `editTelegramMessage` (después de la comprobación de edición superada), aceptando la ventana descrita en Pitfall 5. [ASSUMED] — es una decisión de diseño que el usuario puede preferir.

### Pattern 5: `inspect` + `execute` como dos rutas del catch-all

`inspect` existe porque el fragmento solo trae un token: verbo, objetivo, host, si la incidencia ya está resuelta y si hace falta passkey los conoce solo el servidor, y la UI debe mostrar `caducado/cancelado/consumido` **antes** de pedir una passkey. Ambas llevan el token en el **cuerpo** (nunca en query string, que acaba en logs de proxy).

```ts
// src/lib/sensitive-actions.ts (extensión del manifiesto)  — [VERIFIED forma: sensitive-actions.ts:105-149]
"telegram/intents/inspect": {
  POST: exempt("Lee el estado de un intent del propio operador; no ejecuta nada"),
},
"telegram/intents/execute": {
  // Misma tabla que el manifiesto: la decisión se toma por la acción almacenada en el intent
  POST: perItem({ ...actionPolicies, ...hostCommandPolicies }),
},
```

Reglas del catch-all que condicionan el diseño [VERIFIED: tests/sensitive-actions.test.ts:272-278, 333-355]:
- cada ruta debe despacharse con un literal `route === "telegram/intents/inspect"` (el test compara el conjunto de literales con las claves del manifiesto; no se admiten `startsWith`);
- cada mutación del manifiesto necesita una fila en `bodyLimitCases` (413) o marcarse `readsBody: false`;
- el cuerpo solo puede leerse con `readJsonBody` (otro test prohíbe `request.json()` fuera de `request-body.ts`);
- el catch-all ya exige Origin permitido y sesión antes del despachador, y un 401 antes de 404/405 (`route.ts:206-212`).

**`guardIntentAction`** (en `verification-api.ts`, junto a `guardSensitiveAction`): recibe `{ request, session, store, intent: { userId, action }, now }`. (1) Si `session.user.id !== intent.userId` responde como intent desconocido (404). (2) Si `requiresVerificationForIntent(intent.action)` (nueva función del manifiesto que delega en `requiresVerificationForAction` / `requiresVerificationForCommand`) llama a `guardSensitiveAction` y devuelve su 403 `recent_verification_required`. No hay segunda lista de protegidos: `intent.action` solo se valida contra el tipo `IntentActionId = "start" | "restart" | "reboot" | "backup-now" | "deploy-now"`, que debe ser un subconjunto comprobado por compilador de `ActionId | HostCommand`. El método de verificación (passkey o contraseña) lo sigue decidiendo `verificationMethodForRequest` (Origin vs `BETTER_AUTH_URL`); no se crea política nueva.

### Pattern 6: Orden de `execute` (SC2 y SC4)

1. Sesión y Origin (ya los comprueba el catch-all). Cuerpo `z.strictObject({ token })` con el patrón del token; la cabecera `Idempotency-Key` del hook se **ignora**: el id de la operación lo fija el servidor (`intent.id`).
2. Buscar el intent por `sha256(token)`. Desconocido, de otro usuario → 404 genérico.
3. `status` terminal o `expiresAt <= now` → `410` con `code` (`intent_expired`, `intent_cancelled`); si ya se ejecutó (`executing/executed/failed/uncertain`) → **replay**: `200` con la operación existente, sin tocar el agente.
4. `guardIntentAction` → 403 `recent_verification_required` **sin consumir** el intent (el operador reintenta con passkey dentro del TTL). Esto es lo que cumple SC2.
5. Prechequeos que no consumen: frescura de la muestra del host (`CONNECTION_STALE_MS`, `hosts.ts:5`) → 503 sin enviar nada; resolver nombre → id de contenedor en la última muestra para `start|restart` → 409 si ya no existe.
6. **Reclamo atómico**: `UPDATE telegram_action_intents SET status='executing', usedAt=now WHERE id=$1 AND status='pending' AND expiresAt > now RETURNING`. Solo el que obtiene la fila continúa; es lo que cumple SC4 (doble clic, dos pestañas, reintento del hook).
7. `operation-runner` con `operationId = intent.id`, `channel='telegram'`, `requestedBy`. Un fallo de red tras enviar queda `pending` y **no se reenvía** (política existente).
8. Marcar el intent `executed|failed|uncertain` y encolar la edición `…:done` en la misma transacción que el resultado.

Un fallo entre 6 y 7 deja el intent consumido sin operación: se acepta (a lo sumo una vez, nunca dos) y debe quedar visible en el hub como `failed` con detalle.

### Pattern 7: Extracción de `operation-runner.ts`

`/api/action` ejecuta inline ~140 líneas (consulta de muestra, insert en `operations`, llamada al agente, `finalizeContainerOperation`, `bootAt` del reinicio). `executeHostCommand` ya es compartible pero su `insert` no admite canal ni solicitante, y si el id ya existe devuelve `replayed` sin ejecutar (por eso el intent **no** debe pre-insertar la fila). [VERIFIED: src/app/api/[...path]/route.ts:611-766; src/lib/host-commands.ts:104-216]

Recomendación: extraer a `operation-runner.ts` una función `runAgentAction({ host, userId, body, operationId, channel, requestedBy })` con el comportamiento actual de `route === "action"` (503 por muestra obsoleta con `> 75000` literal hoy; usar `CONNECTION_STALE_MS`, mismo valor), y añadir `channel`/`requestedBy` opcionales a `executeHostCommand` con valor por defecto `hub`. La ruta `/api/action` pasa a llamar a la función extraída con `channel: 'hub'`. **Riesgo:** es un refactor sobre una ruta con tests (`tests/api-lifecycle.test.ts`, `tests/sensitive-actions.test.ts`); hacerlo primero, sin cambio de comportamiento, con los tests actuales en verde antes de añadir el intent.

Parámetros por acción del intent:
- `start`/`restart`: `body = { action, id: <id de 64 hex resuelto por nombre en la última muestra> }`; `target` de la operación = el id (convención actual; Avisos ya lo recorta a 12 caracteres).
- `reboot`: `body = { action: "reboot", confirmation: "REINICIAR NAS" }` (el literal lo pone el servidor; el operador lo confirma en el diálogo, ver UI); `bootAt` como hoy.
- `backup-now` / `deploy-now`: `executeHostCommand({ command })`.

### Pattern 8: Teclado por estado (render)

| Estado del aviso | Filas |
|------------------|-------|
| Abierto, sin menú, sin intent, con acciones | estado (Reconocer / Silenciar o Quitar silencio) · `[Acciones…][Por qué me llegó esto]` · `Abrir en el hub` |
| Abierto, sin acciones posibles (`connection`, claves no listadas) | igual que hoy: sin «Acciones…» (D-03) |
| Menú abierto | acciones del aviso + `[Volver]` (más las filas de estado) |
| Intent vivo | `[Confirmar en el hub: <verbo> <objetivo> ↗ (url)] [Cancelar]` + filas de estado; sin «Acciones…» |
| Resuelto, sin intent vivo | solo `Por qué` (D-06) |
| Resuelto con intent vivo | además `[Confirmar en el hub …][Cancelar]` hasta caducar o cancelar (D-05: el enlace sigue valiendo, así que debe seguir siendo alcanzable) |

`hostActionsFor(key)` es una función pura y es la única fuente de qué se ofrece: `container:<nombre>` → `start`, `restart`; `backup-failed` → `backup-now`; `deploy-failed` → `deploy-now`; `reboot-pending` → `reboot`; cualquier otra clave (incluida `connection`) → ninguna. `callback_data` solo lleva el token `v1:` + 22 caracteres (25 bytes, bajo el límite de 64); el objetivo nunca viaja en el botón, se deduce de `incident.key` en el servidor. Nuevos valores de `TELEGRAM_ACTIONS`: `menu_open`, `menu_close`, `act_start`, `act_restart`, `act_reboot`, `act_backup_now`, `act_deploy_now`, `intent_cancel`. [VERIFIED: forma actual en src/lib/telegram-keyboard.ts:19-25]

```ts
// Valores actuales, verbatim (telegram-keyboard.ts:19-25)
export const TELEGRAM_ACTIONS = [
  "ack",
  "snooze_1h",
  "snooze_24h",
  "unsnooze",
  "why",
] as const;
```

Dos sitios que hoy repiten la lista y deben dejar de hacerlo: `KNOWN_ACTIONS` en `incident-actions.ts:220-226` (derivarlo de `TELEGRAM_ACTIONS`) y el reparto de filas hardcodeado en `renderActionRows` (`telegram-keyboard.ts:120-146`).

### Pantalla del handoff (sin UI-SPEC: decisiones para el planner)

El usuario eligió `--skip-ui`; esta sección es el único contrato de diseño. Reglas: reutilizar, no reinventar. `DESIGN.md` y `06-UI-SPEC.md` (tokens, tipografía 12.8/12/21 px, pesos 400/700, botones de 44 px, un solo diálogo modal nativo) siguen vigentes y **no se añade ningún token de color, tamaño ni peso nuevo**.

**Dónde vive.** Un componente cliente nuevo `src/components/views/telegram-handoff.tsx`, renderizado al principio de `AlertsView` (Avisos, como pide CONTEXT.md) y con su propia instancia de `useSensitiveAction()`; el enlace del aviso siempre lleva `view=alerts`. El componente **no** debe depender de que `/api/overview` haya cargado: se monta desde `AlertsView` pero captura el fragmento en un efecto propio; si `data` aún no existe, `Dashboard` ya muestra su estado de carga y el token queda a salvo en `sessionStorage`.

**Captura del token (cliente puro, testeable en Node).** Módulo `src/lib/telegram-handoff-client.ts`:
- `parseHandoffFragment(hash: string): string | null` — acepta solo `#intent=<43 chars base64url>`;
- `captureHandoff(location, history, storage)` — si hay token válido lo guarda en `sessionStorage` y llama a `history.replaceState(null, "", pathname + search)` (conserva `?view=alerts&host=…&incident=…`, a diferencia del `replaceState(null, "", pathname)` de `login.tsx:24`, que borra el search); **idempotente**: una segunda llamada (Strict Mode ejecuta los efectos dos veces en desarrollo) lee del almacenamiento;
- `readStoredHandoff(storage)` / `clearHandoff(storage)`.
`Login` y el componente del handoff llaman a `captureHandoff` en su efecto de montaje. Esto resuelve los tres caminos que borran la URL: el login (`router.replace(next)`), `signInAgain()` (`dashboard.tsx:148`, reconstruye la ruta sin hash) y `go()` (`dashboard.tsx:126`, `replaceState(null, "", routeHref(next))`).

**Sin sesión.** `page.tsx` renderiza `<Login>` (el servidor nunca ve el fragmento). `Login` captura el token y lo quita de la URL; tras el login `router.replace(next)` aterriza en Avisos y el componente lo lee del almacenamiento. No se cambia `next` (sigue reconstruido desde `readRoute`, sin hash). Para `start` basta con la sesión; para lo protegido, el diálogo pide passkey (o contraseña en el dominio alternativo, según `verificationMethodForRequest`).

**Un paso o dos: un solo paso.** Al llegar a `ready`, el componente abre el diálogo de `useSensitiveAction` directamente. El botón de confirmar del diálogo hace verificación + envío en un único `submit` (`confirm()` llama a `verify()` y luego a `fetch(endpoint)`, `sensitive-action.tsx:196-228`). Un panel con un botón previo añadiría un toque sin aportar seguridad: el diálogo ya nombra verbo y objetivo y exige un toque explícito.

**Extensión necesaria de `useSensitiveAction`.** Hoy el hook consulta `/api/verification` y, si `recent` es falso, pide passkey aunque la acción sea exenta; el botón queda deshabilitado mientras `verification` es nulo (`sensitive-action.tsx:125-147, 201-210, 459-464`). Añadir `requiresVerification?: boolean` (por defecto `true`) a `SensitiveActionRequest`: cuando es `false` no se hace el `fetch` de verificación, se inicializa `verification = { method: "passkey", recent: true, reason: null }`, no se muestra pista de passkey y se expone `data-verification-required="false"` en el `<dialog>`. Test de regresión: el camino por defecto no cambia (`tests/e2e/sensitive-action.spec.ts` ya cubre el diálogo con el arnés).

**Estados** (atributo `data-handoff-state` en el panel; los tests aseveran el estado, no el copy):

| `data-handoff-state` | Cuándo | Qué se ve | Acción |
|----------------------|--------|-----------|--------|
| `idle` | no hay token ni almacenado | nada renderizado | — |
| `loading` | `inspect` en vuelo | línea de estado discreta | — |
| `ready` | intent `pending` | diálogo abierto: título = verbo + objetivo, descripción = nombre del host; consecuencias: "se ejecutará una sola vez" (tono `warn`) y, si `incident.resolved`, "La incidencia ya está resuelta; puedes confirmar igualmente" (D-05); pista de passkey solo si `requiresVerification` | Confirmar / Cancelar |
| `executing` | `useSensitiveAction.phase` `verifying`/`executing` | el diálogo ya lo muestra (`Verificando…`, `Enviando…`) | inerte |
| `verification_failed` | fallo de passkey | el hook muestra `role="alert"` y vuelve a `ready` (reintento nativo del hook) | reintentar en el mismo diálogo |
| `succeeded` | `onSettled` `succeeded` | panel con resultado (`detail` de la operación); `clearHandoff`; refresca Avisos | cerrar |
| `pending` | respuesta incierta (502 o red) | aviso `peach` "no se pudo confirmar; no se repetirá sola" (copy ya existente del hook) | cerrar |
| `failed` | 4xx/503 sin envío | `role="alert"` con el error del servidor | **Reintentar** (re-`inspect`; el intent sigue vivo si no se consumió) o Cerrar |
| `expired` | `inspect` → `expired` o 410 | panel informativo: "Este enlace caducó; vuelve al aviso de Telegram" | `clearHandoff` |
| `cancelled` | `inspect` → `cancelled` | idem | `clearHandoff` |
| `consumed` | `inspect` → `executing/executed/failed/uncertain` | panel con el resultado de la operación existente; **no** reejecuta | `clearHandoff` |
| `invalid` | token desconocido / de otro usuario | mensaje genérico, sin distinguir el motivo | `clearHandoff` |
| `unauthenticated` | `inspect` 401 | el token queda en `sessionStorage`; el flujo existente `signInAgain()` devuelve al login | tras login se reanuda |

Notas de implementación de la tabla:
- `start` (exento): el hook se abre con `requiresVerification: false`; solo sesión + confirmación (D-04).
- `reboot`: usar `typedConfirmation: { label: "Escribe REINICIAR NAS", value: "REINICIAR NAS" }` igual que el flujo de Mantenimiento; así el hub no es más permisivo desde el chat que desde la pantalla. [ASSUMED: paridad con el reinicio del hub; anulado por D-12, ver Open Question 4 (RESOLVED): el handoff pide un toque y la passkey, sin la frase]
- `endpoint: "/api/telegram/intents/execute"`, `body: { token }`, `idempotencyKey` opcional (el servidor lo ignora).
- `onSettled` mapea a `data-handoff-state` como hace `06-03` con `applyResult`.
- Foco y teclado: lo gestiona el hook (`[data-initial-focus]`, devuelve el foco al abrir). Roles ya definidos en 06-UI-SPEC I-5 y I-7.
- Móvil: el enlace se abre desde Telegram en un teléfono; el diálogo ya cumple 360 px y 44 px de objetivo táctil.
- Copy en español, sin acentuar la urgencia; el título nombra verbo y objetivo ("Reiniciar plex"), la descripción el host.
- Tras éxito o fallo terminal, **mostrar la operación en «Acciones recientes»** con una marca de canal (`data-operation-channel="telegram"`): exige ampliar `Operation` (`types.ts:354-362`) con `channel` y exponerlo en `publicOperation`/`/api/overview`; las etiquetas de acción de esa lista no incluyen `backup-now`/`deploy-now` y caen al id crudo, conviene añadirlas.

### Anti-Patterns to Avoid

- **Pre-insertar `operations` en el reclamo y luego llamar a `executeHostCommand`:** este último ve la fila existente y devuelve `replayed` sin ejecutar nada.
- **Decidir "protegido" por el cuerpo de `execute`:** el cuerpo solo lleva el token; la acción sale de la fila del intent.
- **Poner el token en query string o en un `GET` de `inspect`:** acaba en logs de proxy; el fragmento existe precisamente para evitarlo.
- **Enviar un mensaje nuevo para avisar del intent/resultado:** viola "el aviso es la única superficie"; solo `editMessageText` silencioso vía outbox.
- **Guardar el id numérico de Telegram en `operations` o en el intent:** convención de la fase 5.
- **Una segunda lista de acciones protegidas** (D-00c).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Diálogo de confirmación con passkey y reintento | Un modal nuevo | `useSensitiveAction` (+ `requiresVerification:false`) | Foco, `aria-busy`, fases `pending/failed`, 403 → reabrir verificación ya resueltos |
| Decisión de qué exige verificación | Un `Set` de acciones del intent | `requiresVerificationForAction/Command` del manifiesto | D-00c y SEC-02 |
| Guard de verificación reciente | Comparar el `Origin` o inventar un método `telegram` | `guardSensitiveAction` | La grabación en `recent_verification` solo ocurre tras `verify-authentication` o `verifyPassword` |
| Entrega y reintento de ediciones | Un `fetch` directo a `editMessageText` desde el carril | outbox `incident-edit` | Claim, lease, `retry_after`, cooldown compartido, "message is not modified = éxito" |
| Caducidad visible del enlace | Un `setInterval` o barrido nuevo | fila de outbox con `nextAttemptAt = expiresAt` | Hereda lease y recuperación |
| Consumo único de callbacks | Comprobar `usedAt` en dos pasos | `consumeActionToken` (UPDATE condicional dentro de la tx) | Ya garantiza no-doble-efecto y enlaza el mensaje |
| Unicidad del intent vivo | Un `SELECT` previo en la aplicación | índice único parcial `WHERE status='pending'` | Condición de carrera entre callbacks; D-10 lo exige como esquema |
| Reclamo único de la ejecución | Un `SELECT` + `UPDATE` | `UPDATE … WHERE status='pending' AND expiresAt > now RETURNING` | Atómico; cubre doble clic y doble pestaña |
| Comparación de hashes | `===` | `timingSafeEqual` | Patrón de `setup` en el catch-all |
| Cuerpo de petición | `request.json()` | `readJsonBody` | Hay un test que lo prohíbe fuera de `request-body.ts` |

**Key insight:** la fase no inventa mecanismos; cada requisito se cumple reutilizando una pieza de las fases 2, 5 o 6 y añadiendo una restricción de esquema o una función pura. Lo que sí es nuevo (HMAC del token, vista de teclado, extracción del runner) existe porque las piezas actuales asumen un solo `seq` por edición y una ejecución inline en la ruta.

## Common Pitfalls

### Pitfall 1: Los avisos que D-01 y D-02 describen casi nunca llegan a Telegram
**What goes wrong:** se construye y prueba «Acciones…» para `container:<nombre>` y `reboot-pending`, y en producción nunca aparece.
**Why it happens:** `notificationPolicy` devuelve `channel: "silent"` para todo `container:*` y mete `reboot-pending` en `DIGEST_KEYS` (entrega por resumen, sin mensaje por incidencia ni teclado). Solo `connection`, `temperature`, `backup-failed`, `stack-unit-failed` y `deploy-failed` son críticas inmediatas por Telegram (`disk-health` solo si es crítica). [VERIFIED: src/lib/notification-policy.ts:25-31, 33-39, 41, 76-82]
**How to avoid:** implementar `hostActionsFor` completo (es una función pura probada), pero planificar la verificación real y el UAT con `backup-failed` y `deploy-failed`; para `container:*` y `reboot-pending` sembrar el incidente y la fila de outbox confirmada en el test. **No** cambiar la política de avisos en esta fase (la fijó la auditoría de la fase 1). Ver Open Question 1.
**Warning signs:** un UAT manual que busca «Acciones…» en un aviso de contenedor y no lo encuentra.

### Pitfall 2: Strict Mode, `go()`, `signInAgain()` y el hash
**What goes wrong:** el token desaparece antes de que el diálogo lo lea.
**Why it happens:** `go()` hace `replaceState(null, "", routeHref(next))` (`dashboard.tsx:126`); `signInAgain()` reconstruye la ruta desde `window.location.search` (`dashboard.tsx:148`); `Login` hace `replaceState(null, "", window.location.pathname)` cuando hay `#setup=` (`login.tsx:24`); en desarrollo los efectos corren dos veces y el segundo ya no ve el hash.
**How to avoid:** `captureHandoff` idempotente y respaldado por `sessionStorage` (Pattern en "Pantalla del handoff"); borrar el hash conservando `search`.
**Warning signs:** el diálogo no abre tras iniciar sesión o tras una expiración de sesión.

### Pitfall 3: `useSensitiveAction` bloquea una acción exenta
**What goes wrong:** `start` desde el chat exige passkey, contra D-04 y el manifiesto.
**Why it happens:** el hook no consulta el manifiesto; asume que todo lo que se le pasa es protegido.
**How to avoid:** `requiresVerification?: false` (ver arriba) y decidirlo con `requiresVerification` devuelto por `inspect`, que sale del manifiesto en el servidor.

### Pitfall 4: Las ediciones solo de teclado colisionan con `incident:<id>:edit:<seq>`
**What goes wrong:** «Acciones…» no actualiza el mensaje, o dos pulsaciones sobre el mismo `seq` violan el índice único.
**Why it happens:** `queueEdit` deriva la clave del `seq`, que un cambio de teclado no mueve. [VERIFIED: src/lib/incident-store.ts:162-196]
**How to avoid:** `queueKeyboardEdit` con clave `incident:<id>:kb:<discriminador>` (Pattern 2) y `revision = seq` actual. Cuidado con `markEditSuperseded`: solo se supera una edición con revisión **estrictamente menor** que otra pendiente o reclamada del mismo incidente; como el render es función del estado, una edición posterior entrega el estado completo.
**Warning signs:** `lastUpdate` del hub sin cambios tras pulsar «Acciones…»; error de clave duplicada en el outbox.

### Pitfall 5: Token del handoff no recuperable en el render
**What goes wrong:** el aviso muestra un botón url cuyo token no coincide con el hash guardado.
**Why it happens:** el carril crea el intent, pero el render ocurre después en el worker; con un token aleatorio solo hay hash. Si el worker genera uno nuevo en cada render y sobrescribe el hash, un render superado (`markEditSuperseded` tras emitir tokens, `notification-dispatch.ts:1065-1090`) o fallido deja el hash de un mensaje que nunca se entregó mientras el visible conserva otro.
**How to avoid:** token HMAC recomputable (Pattern 4). Con el fallback aleatorio, sobrescribir el hash solo después de la comprobación final de edición superada y justo antes del envío.

### Pitfall 6: El índice único parcial no ve el tiempo
**What goes wrong:** tras caducar un intent no se puede crear otro, o se crean dos vivos.
**Why it happens:** `WHERE status='pending'` no puede incluir `expiresAt > now()`.
**How to avoid:** marcar `expired` los pendientes vencidos del incidente dentro de la misma transacción de creación, antes del `INSERT`; y la fila de outbox `:expire` lo hace de forma proactiva al renderizar.

### Pitfall 7: `executeHostCommand` devuelve `replayed` si la fila ya existe
Ver Anti-Patterns. El reclamo atómico vive en la tabla de intents, no en `operations`; la fila de `operations` la inserta el runner con `id = intent.id`.

### Pitfall 8: Doble ejecución por reintento del hook o doble pestaña
**What goes wrong:** dos `POST execute` con el mismo token llegan casi a la vez.
**How to avoid:** reclamo atómico (Pattern 6, paso 6); el perdedor responde replay `200` con la operación existente. Test de concurrencia: `Promise.all` de dos `execute` → una sola petición al agente y una fila en `operations`. Además `operations.id` es clave primaria: segunda barrera.

### Pitfall 9: Passkeys dentro del navegador interno de Telegram
**What goes wrong:** el enlace se abre en el navegador interno de Telegram, la passkey falla o la sesión no existe en ese contexto, y el operador queda atascado en una acción protegida.
**Why it happens:** los webviews embebidos no siempre implementan WebAuthn completo; hay informes de passkeys que fallan en el navegador interno de Telegram y Telegram permite elegir abrir los enlaces en el navegador normal. [CITED: https://groups.google.com/a/fidoalliance.org/g/fido-dev/c/wRXe-oU5MZ4] No se encontró confirmación específica para botones url de teclados inline; el comportamiento en el dispositivo del operador es [ASSUMED].
**How to avoid:** no es un fallo del hub, pero hay que verlo en el UAT con el móvil real; el diálogo, si la passkey falla, debe indicar que se puede volver al aviso y abrir el botón en el navegador del sistema. Como `inspect` no consume el intent y el fragmento se borra de la barra pero el intent sigue vivo, reabrir el botón desde Telegram funciona dentro de los 5 minutos. En el dominio principal `verificationMethodForRequest` exige passkey (la contraseña solo vale en el origen alternativo), así que `start` (solo sesión) sigue siendo posible aunque la passkey falle.

### Pitfall 10: Aceptar silenciosamente `TELEGRAM_DIRECT_ACTIONS=1`
**What goes wrong:** alguien activa la variable creyendo que habilita la ejecución directa; no hace nada o, peor, un futuro cambio la lee.
**How to avoid:** `runtime-config.ts` acepta solo ausente o `0`; cualquier otro valor es un `RuntimeConfigIssue` (`reason: "invalid"`, ya existente) y el arranque falla (SEC-03). Documentar en `.env.example` (comentada: `# TELEGRAM_DIRECT_ACTIONS=0`) y en README. Test: `readRuntimeConfig({… TELEGRAM_DIRECT_ACTIONS: "1" })` lanza `RuntimeConfigError`. [VERIFIED forma: src/lib/runtime-config.ts:9-17, 296-322, 440-451]

### Pitfall 11: Dependencia de CR-01 de la fase 6 (RESOLVED)
`06-REVIEW-DISPOSITION.md` mantenía CR-01 (el factor passkey/contraseña se elige por la cabecera `Origin`, que fija el cliente) en `open`, aunque `06-UAT.md` marca la decisión de CR-01 como `pass`. Con un origen alternativo en `TRUSTED_ORIGINS`, quien conoce la contraseña podía pedir el método `password` contra el dominio principal y ejecutar acciones protegidas sin passkey, lo que habría dejado el handoff por debajo del criterio de éxito 1. **RESOLVED (D-13):** se corrige dentro de esta fase, en 07-06: el método se decide por el `Host` que fija el proxy y un `Origin` que no coincide con él cae a passkey. WR-01…WR-04 siguen `open` y quedan fuera de esta fase. [VERIFIED: .planning/phases/06-puerta-de-seguridad/06-REVIEW.md §CR-01; src/lib/verification.ts:85-142]

### Pitfall 12: Parámetros con `reboot` y contenedores recreados
`reboot` exige `confirmation: "REINICIAR NAS"` en `actionSchema` y el agente puede estar con `ALLOW_REBOOT=false`; `start|restart` necesitan el id de 64 hex que cambia si el contenedor se recrea entre el aviso y el clic. Resolver el id **al ejecutar**, no al crear el intent, y fallar con 409 sin consumir si el nombre no aparece. [VERIFIED: src/lib/validation.ts:14-23]

## Code Examples

### Manifiesto de intents (derivado, sin segunda lista)
```ts
// src/lib/sensitive-actions.ts — forma sugerida; los literales de policies son los existentes
export const intentActionIds = ["start", "restart", "reboot", "backup-now", "deploy-now"] as const;
export type IntentActionId = (typeof intentActionIds)[number];
// Compila solo si cada id está en el manifiesto de acciones o de comandos:
const _inManifest: Record<IntentActionId, Policy> = {
  start: actionPolicies.start,
  restart: actionPolicies.restart,
  reboot: actionPolicies.reboot,
  "backup-now": hostCommandPolicies["backup-now"],
  "deploy-now": hostCommandPolicies["deploy-now"],
};
export function requiresVerificationForIntent(id: IntentActionId): boolean {
  return id in actionPolicies
    ? requiresVerificationForAction(id)
    : requiresVerificationForCommand(id);
}
```
Valores citados verbatim del manifiesto actual [VERIFIED: src/lib/sensitive-actions.ts:31-42, 45-54]: `start: exempt("No pierde datos ni corta servicio")`, `restart: protectedBy("Interrumpe el servicio")`, `reboot: protectedBy("Reinicia el host")`, `"deploy-now": protectedBy("Despliega y recrea servicios")`, `"backup-now": protectedBy("Inicia una copia del host")`.

### Token HMAC del handoff
```ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const handoffKey = (secret: string) =>
  createHmac("sha256", secret).update("hub:telegram-handoff:v1").digest();

export function handoffToken(secret: string, intentId: string): string {
  return createHmac("sha256", handoffKey(secret)).update(intentId).digest("base64url"); // 43 chars
}
export const hashHandoffToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
```

### URL del botón (extiende `incidentHref`)
```ts
// Base: incidentHref valida BETTER_AUTH_URL y el patrón del host [VERIFIED: src/components/views/routes.ts:86-110]
export function handoffHref(base: string, hostId: string, incidentId: number, token: string) {
  const url = new URL(incidentHref(base, hostId, incidentId));
  url.hash = `intent=${token}`;
  return url.toString();
}
```

### Creación del intent dentro de la transacción del carril (esqueleto)
```ts
// Dentro de applyTokenAction(tx, consumed, ctx) — rama act_* ; el carril NO importa operation-runner
const [incident] = await tx.select().from(incidents)
  .where(eq(incidents.id, consumed.incidentId)).limit(1).for("update");
if (!incident || incident.resolvedAt) return "ignored";                 // D-06
const offered = hostActionsFor(incident.key);
const action = actionOfToken(consumed.action);                           // act_restart -> "restart"
if (!offered.includes(action)) return "ignored";
await tx.update(telegramActionIntents).set({ status: "expired" })
  .where(and(eq(telegramActionIntents.incidentId, incident.id),
             eq(telegramActionIntents.status, "pending"),
             lte(telegramActionIntents.expiresAt, new Date(ctx.now))));
const id = randomUUID();
const inserted = await tx.insert(telegramActionIntents).values({
  id, incidentId: incident.id, hostId: incident.hostId, action,
  target: targetNameOf(incident, action), userId: await soleOperatorId(tx),
  handoffHash: hashHandoffToken(handoffToken(ctx.secret, id)),
  expiresAt: new Date(ctx.now + HANDOFF_TTL_MS),
}).onConflictDoNothing().returning({ id: telegramActionIntents.id });  // índice único parcial
if (!inserted.length) return "unchanged";                               // ya hay un intent vivo (D-10)
await queueKeyboardEdit(tx, incident, `i${id}:open`);
await queueKeyboardEdit(tx, incident, `i${id}:expire`, { notBefore: expiresAt });
return "applied";
```
`soleOperatorId`: la instancia es de un solo operador (el alta `setup` se cierra con la primera cuenta, `route.ts:163-180`); resolver el único `user` y, si no hay exactamente uno, devolver `ignored` (falla cerrado). [ASSUMED: no existe hoy un mapeo Telegram→usuario; ver Open Question 3]

### Captura del fragmento (cliente)
```ts
// src/lib/telegram-handoff-client.ts — puro: recibe location/history/storage inyectados
const FRAGMENT = /^#intent=([A-Za-z0-9_-]{43})$/;
export const parseHandoffFragment = (hash: string) => FRAGMENT.exec(hash)?.[1] ?? null;
export function captureHandoff(loc: Pick<Location, "hash" | "pathname" | "search">,
  hist: Pick<History, "replaceState">, store: Pick<Storage, "getItem" | "setItem">): string | null {
  const token = parseHandoffFragment(loc.hash);
  if (token) {
    store.setItem("hub.handoff", token);
    hist.replaceState(null, "", loc.pathname + loc.search);   // conserva view/host/incident
    return token;
  }
  return store.getItem("hub.handoff");
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Webhook de Telegram con ejecución directa y passkey reciente (`ARCHITECTURE.md` pasos 4–7) | Long polling en el worker y handoff al hub sin ejecución en el callback | Fase 2 (polling) y D-00a | El callback solo crea intents; no existe `src/app/api/telegram/webhook` ni `telegram_updates` |
| `answerCallbackQuery.url` para abrir el hub | Botón url en el teclado editado | D-08 | La Bot API solo garantiza `url` en `answerCallbackQuery` para juegos o enlaces `t.me` [CITED: ARCHITECTURE.md:372] |
| `operations` sin origen | `channel` + `requestedBy` | Esta fase | Audita chat frente a hub (pitfall 15 pedía `actor`) |

**Deprecated/outdated en `ARCHITECTURE.md` para esta fase:** la tabla `telegram_action_intents` con `verifiedAt`/`telegramUserId`, `requireRecentVerificationForUser`, `TELEGRAM_DIRECT_ACTIONS` como camino activo y `operation-runner` invocado desde el webhook.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | La passkey puede fallar en el navegador interno de Telegram en el dispositivo del operador; mitigación por reabrir en el navegador del sistema | Pitfall 9 | UAT bloqueado en acciones protegidas; hay que documentar o cambiar el ajuste de Telegram |
| A2 | Derivar el token del handoff por HMAC de `BETTER_AUTH_SECRET` es aceptable frente a "token aleatorio + hash" de la fase 5 | Pattern 4 | Si el usuario exige token puramente aleatorio, usar el fallback (sobrescribir hash tardío) |
| A3 | El solicitante de `operations` es el id del usuario del hub (mismo valor para ambos canales) y nunca el id numérico de Telegram | Pattern 3 / Open Question 3 | Si se quiere el id de Telegram para auditoría, cambia la política de la fase 5 |
| A4 | `reboot` desde el chat conserva la frase tecleada `REINICIAR NAS` en el diálogo (anulada por D-12: un toque y passkey) | Pantalla del handoff | Si se prefiere un toque, el hub sería más permisivo desde el chat que desde Mantenimiento; el usuario lo aceptó en D-12 |
| A5 | Un solo usuario en la instancia: el intent se liga al único `user` | Código de creación | Con varios usuarios no hay mapeo Telegram→usuario y `soleOperatorId` falla cerrado |
| A6 | Reutilizar `kind: "incident-edit"` para ediciones solo de teclado (en vez de un `kind` nuevo) es aceptable aunque `lastUpdate` las refleje | Pattern 2 | Si se quiere un `lastUpdate` solo de cambios de estado, hace falta un `kind` nuevo y tocar claim, recover y dispatcher |
| A7 | Con `container:*` silenciosos y `reboot-pending` en el resumen, esas filas de D-01/D-02 no tienen superficie real en Telegram hoy | Pitfall 1 | Si el usuario espera verlas en el chat, hay que cambiar la política (fuera de esta fase) |
| A8 | Una operación `reboot` iniciada por intent no actualiza el aviso cuando el host vuelve; solo se edita con "reinicio solicitado" | Resultado en Telegram | Si se quiere confirmación final en el chat, el collector debería encolar una edición |

## Open Questions (RESOLVED)

Las cinco preguntas quedaron resueltas al planificar; cada una indica la decisión de `07-CONTEXT.md` o de los planes que la cierra.

1. **¿Se acepta que D-01 y la fila `reboot-pending` de D-02 no tengan superficie real en Telegram con la política actual? (RESOLVED)**
   - What we know: `container:*` es `silent` y `reboot-pending` va al resumen (`notification-policy.ts`); no hay mensaje por incidencia ni teclado.
   - What's unclear: si el usuario quiere cambiar la política (p. ej. contenedores críticos a Telegram) o lo asume.
   - Recommendation: implementar y probar la tabla completa con fixtures; no tocar la política; UAT real solo con `backup-failed` y `deploy-failed`. Confirmar con el usuario antes de planificar los tests de aceptación.
   - **RESOLVED (D-11):** el usuario lo acepta. La tabla de D-01..D-03 se implementa completa y se prueba con fixtures (`hostActionsFor` en 07-01 y los teclados de 07-03); el UAT real usa `backup-failed` y `deploy-failed`; la política de avisos no se toca en esta fase.

2. **¿Quién renderiza el resultado final de un `reboot`? (RESOLVED)**
   - What we know: la operación queda `pending` hasta que el collector confirma el arranque por `bootAt` (`collector.ts:542-556`).
   - What's unclear: si el chat debe enterarse de la confirmación.
   - Recommendation: editar el aviso con "reinicio solicitado" al ejecutar; la confirmación posterior se ve en el hub (A8).
   - **RESOLVED (P-18 de 07-04 y P-14 de 07-03):** un `reboot` aceptado deja la operación `pending` con el detalle de reinicio solicitado y el intent `executed`; el aviso se edita con «reinicio solicitado» y la confirmación final se ve en el hub (A8).

3. **Solicitante en `operations` y mapeo Telegram→usuario. (RESOLVED)**
   - What we know: no hay concepto de propietario; `userId` en `operations` es el usuario de la sesión que ejecuta; la fase 5 evitó persistir el id numérico de Telegram.
   - Recommendation: `channel` (`hub`|`telegram`) y `requestedBy` = id del usuario del hub en ambos casos; `intent.userId` = único usuario. Confirmar si el usuario quiere algo más.
   - **RESOLVED (P-02 y P-04 de 07-01, y el apartado de discreción de `07-CONTEXT.md`):** `operations.channel` (`hub` por defecto) y `operations.requestedBy` (id del usuario del hub, nunca el id numérico de Telegram); el intent se liga al único usuario de la instancia y falla cerrado si no hay exactamente uno (A3 y A5).

4. **¿`reboot` con frase tecleada o con un toque? (RESOLVED)** Recomendación original: frase tecleada (paridad con el hub).
   - **RESOLVED (D-12):** un toque y la passkey, sin la frase `REINICIAR NAS`. El usuario acepta que el handoff sea más permisivo que Mantenimiento en este punto; la recomendación de la frase queda anulada y con ella la suposición A4.

5. **¿Actuar reconoce la incidencia? (RESOLVED)** CONTEXT: por defecto no. Recomendación: no; si falla/éxito solo cambia la línea de resultado del aviso.
   - **RESOLVED (P-10 de 07-02 y P-14 de 07-03):** actuar no reconoce la incidencia; el resultado solo cambia la línea de resultado del aviso.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | tests, build | ✓ | v24.22.3 | — |
| pnpm | scripts | ✓ | 12.15.0 | — |
| Docker (cliente) | PostgreSQL de pruebas | ✓ | 29.8.2 | — |
| PostgreSQL 18 | tests con base (`HUB_REQUIRE_TEST_DB=1`) | ✓ (contenedor `hub-phase3-pg`, imagen `postgres:18`, en ejecución) | 18 | — |
| `DATABASE_URL` en el shell | `tests/database.ts` | ✗ (sin definir en esta sesión) | — | definirlo hacia el Postgres de loopback; sin él los tests con base se **omiten**; con `HUB_REQUIRE_TEST_DB=1` fallan en vez de omitirse |
| `psql`/`pg_isready` | inspección manual | ✗ (no en PATH) | — | `docker exec hub-phase3-pg psql …` |
| Navegadores Playwright | e2e | ✓ por dependencia (no verificado esta sesión) | ^1.65.0 | — |
| Dispositivo móvil con Telegram | UAT de handoff y passkey | no verificable desde aquí | — | UAT manual de fin de fase (`human_verify_mode: end-of-phase`) |

**Missing dependencies with no fallback:** ninguna bloqueante.
**Missing dependencies with fallback:** `DATABASE_URL` (definirlo); `psql` (vía `docker exec`).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^5.1.0 (Node, sin jsdom) + Playwright ^1.65.0 (Chromium) |
| Config file | `vitest.config.ts` (incluye `tests/**/*.test.ts`, alias `@`), `playwright.config.ts` (`testDir: tests/e2e`, `webServer: pnpm start`) |
| Quick run command | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts tests/sensitive-actions.test.ts && pnpm typecheck` |
| Full suite command | `HUB_REQUIRE_TEST_DB=1 pnpm test && pnpm typecheck && pnpm lint src tests && pnpm build && pnpm test:e2e` (cadena de `06-VALIDATION.md:26`) |

Como Vitest corre en Node sin DOM, la lógica del cliente se aísla en funciones puras con `location/history/storage` inyectados (`telegram-handoff-client.ts`); el comportamiento visual se cubre con Playwright.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BOT-07 | Pulsar una acción crea un intent `pending` con hash (no token), TTL 5 min, y edita el aviso con botón url; el agente no recibe nada | integration (BD + `telegram-fake`) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-updates.test.ts -t intent` | ❌ Wave 0 (ampliar fichero) |
| BOT-07 | `execute` con sesión (+ passkey sembrada) ejecuta una vez y devuelve la operación | integration (API + agente falso) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts` | ❌ Wave 0 |
| BOT-07 | El fragmento se captura, se quita de la URL y el diálogo abre; sin sesión pasa por el login y vuelve | e2e | `pnpm test:e2e tests/e2e/telegram-handoff.spec.ts` | ❌ Wave 0 |
| BOT-08 | `execute` de una acción protegida sin verificación reciente → 403 `recent_verification_required`, 0 peticiones al agente, 0 filas en `operations`, intent sigue `pending` | integration | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts -t verification` | ❌ Wave 0 |
| BOT-08 | `start` (exenta) se ejecuta solo con sesión; las protegidas salen del manifiesto, no del cuerpo | integration + unit | `pnpm test tests/sensitive-actions.test.ts` | ✅ (ampliar) |
| BOT-08 | El carril no importa runners (`operation-runner`, `host-commands`, `lifecycle`, `nas`) | static scan | `pnpm test tests/sensitive-actions.test.ts -t "lane"` | ❌ Wave 0 |
| BOT-09 | La operación queda con `channel='telegram'`, `requestedBy`, `id = intent.id`; las de `/api/action` con `channel='hub'` | integration | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts tests/api-lifecycle.test.ts` | ✅ parcial (lifecycle) / ❌ |
| BOT-09 | La migración 0008 no reescribe filas existentes y repetirla no aplica nada | migration | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | ✅ (ampliar, patrón de 0007) |
| SC4 | Dos `execute` concurrentes, un `execute` tras caducar, tras cancelar y tras consumir: una sola petición al agente | integration | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts -t "single use"` | ❌ Wave 0 |
| D-10 | Una segunda acción sobre el mismo aviso con intent vivo es `unchanged`; tras caducar se permite | integration | `… tests/telegram-intents.test.ts -t "one live intent"` | ❌ Wave 0 |
| D-09 | La fila `:expire` restaura el teclado (edición sin botón url) tras `expiresAt` | integration con reloj inyectado | `… tests/telegram-intents.test.ts -t expiry` | ❌ Wave 0 |
| D-06/D-05 | Aviso resuelto: sin «Acciones…»; intent vivo previo sigue y `inspect` marca `resolved` | pure + integration | `pnpm test tests/telegram-keyboard.test.ts` | ❌ Wave 0 |
| D-00a | `TELEGRAM_DIRECT_ACTIONS` solo `0` o ausente; `1` falla el arranque | unit | `pnpm test tests/runtime-config.test.ts` | ✅ (ampliar) |
| Rutas | `telegram/intents/*` declaradas en el manifiesto, con fila 413 | scan | `pnpm test tests/sensitive-actions.test.ts` | ✅ (ampliar) |
| `callback_data` | todo token de los botones nuevos ≤ 64 bytes y con formato `v1:` | unit | `pnpm test tests/telegram-keyboard.test.ts` | ❌ Wave 0 |

Las aserciones siguen `CODING_STANDARD.md`: filas guardadas, códigos HTTP, peticiones registradas por el agente falso, `callback_data`/`url` de los botones enviados a `editMessageText` y atributos `data-*` (`data-handoff-state`, `data-phase`, `data-verification-required`); nunca texto visible.

### Sampling Rate
- **Per task commit:** `HUB_REQUIRE_TEST_DB=1 pnpm test <ficheros de la tarea> && pnpm typecheck`
- **Per wave merge:** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts tests/telegram-keyboard.test.ts tests/api-telegram-intents.test.ts tests/sensitive-actions.test.ts tests/api-lifecycle.test.ts tests/api-host-commands.test.ts tests/migrations.test.ts tests/runtime-config.test.ts && pnpm typecheck && pnpm lint src tests`
- **Phase gate:** suite completa verde (con e2e) antes de `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `tests/telegram-intents.test.ts` — ciclo de vida, unicidad, caducidad, reclamo atómico (BOT-07/08, SC4, D-09, D-10)
- [ ] `tests/api-telegram-intents.test.ts` — `inspect`/`execute`, 403 sin consumir, `operations.channel` (BOT-07/08/09)
- [ ] `tests/telegram-keyboard.test.ts` — `hostActionsFor`, render por estado, tamaño de `callback_data` (D-01..D-07)
- [ ] `tests/telegram-handoff-client.test.ts` — `parseHandoffFragment`/`captureHandoff` idempotente (puro)
- [ ] `tests/e2e/telegram-handoff.spec.ts` — fragmento, login y estados con `page.route` para `execute` (precedente: `tests/e2e/sensitive-action.spec.ts`)
- [ ] Filas nuevas en `bodyLimitCases` y entradas del manifiesto en `tests/sensitive-actions.test.ts`
- [ ] Extender `tests/telegram-fake.ts` si hace falta registrar `editMessageText` con `url` buttons (ya registra `callback_data`)

## Security Domain

`security_enforcement` está activo (`workflow.security_enforcement: true`, `security_asvs_level: 1`). [VERIFIED: .planning/config.json]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Sesión de Better Auth + passkey con `guardSensitiveAction`; no se crea ningún método nuevo |
| V3 Session Management | yes | El intent se liga al `user.id` de la sesión; `sessionStorage` solo guarda el token efímero |
| V4 Access Control | yes | Allowlist del carril (`isAuthorizedCallback`) + `intent.userId === session.user.id` + manifiesto por acción almacenada |
| V5 Input Validation | yes | `z.strictObject({ token })` con patrón de 43 caracteres; acción solo de un conjunto cerrado; `callback_data` estricto |
| V6 Cryptography | yes | `node:crypto` HMAC-SHA256, SHA-256, `timingSafeEqual`; nada a mano |
| V7/V8 Errores y datos | yes | Respuestas genéricas ante token desconocido; ni el token ni el id de Telegram en logs, `operations` ni respuestas (BOT-10) |

### Known Threat Patterns for este stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Callback repetido o capturado | Replay / Repudiation | Token de botón de un solo uso (`consumeActionToken`) + intent de un solo uso con reclamo atómico + `operations.id` único |
| Ejecución desde el chat con el bot comprometido | Elevation of Privilege | El callback no ejecuta (D-00a); `execute` exige sesión y, si el manifiesto lo marca, passkey reciente |
| Enlace del handoff filtrado (historial, Referer, logs) | Information Disclosure | Token en fragmento (no se envía), borrado con `replaceState`, 5 min, un uso, solo hash en BD, token en cuerpo POST |
| Intent usado por otro usuario/sesión | Spoofing | `intent.userId` debe coincidir con la sesión; desconocido y ajeno responden igual (404) |
| Bajar la protección tocando el cuerpo | Tampering | La acción sale de la fila del intent, no del cuerpo; `IntentActionId` comprobado contra el manifiesto |
| Doble ejecución por carrera | Tampering | `UPDATE … WHERE status='pending' AND expiresAt > now RETURNING` |
| Enlace muerto o engañoso en el chat | Spoofing / UX | Fila `:expire` restaura el teclado (D-09); `inspect` muestra `caducado` |
| Fuerza bruta del token | Spoofing | 256 bits de HMAC, 5 min de vida, sesión obligatoria; sin enumeración (404 uniforme) |
| Downgrade del factor por `Origin` | Elevation of Privilege | CR-01 de la fase 6, corregido en esta fase por D-13 (plan 07-06): el factor sale del `Host` del proxy y un `Origin` que no coincide cae a passkey; el handoff lo hereda ya corregido |

## Sources

### Primary (HIGH confidence)
- Código del repo leído esta sesión: `src/lib/sensitive-actions.ts`, `verification-api.ts`, `verification.ts`, `telegram-keyboard.ts`, `telegram-updates.ts`, `incident-actions.ts`, `incident-store.ts` (`queueEdit`, `projectRow`), `notification-dispatch.ts` (claim, `dispatchEdit`, `dispatchTelegramOpening`), `notification-policy.ts`, `telegram.ts`, `telegram-cleanup.ts`, `host-commands.ts`, `lifecycle.ts`, `validation.ts`, `schema.ts`, `runtime-config.ts`, `src/app/api/[...path]/route.ts`, `src/components/sensitive-action/sensitive-action.tsx`, `src/components/dashboard.tsx`, `login.tsx`, `views/alerts.tsx`, `views/routes.ts`, `src/app/page.tsx`, `src/proxy.ts`, `tests/sensitive-actions.test.ts`, `tests/database.ts`, `tests/telegram-fake.ts`.
- Docs locales de Next 16: `node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md`, `…/03-api-reference/04-functions/use-router.md`.
- Artefactos del proyecto: `07-CONTEXT.md`, `REQUIREMENTS.md`, `STATE.md`, `ARCHITECTURE.md` (research), `SUMMARY.md`, `PITFALLS.md` (9, 12, 13, 15), `06-UI-SPEC.md`, `06-REVIEW-DISPOSITION.md`, `06-UAT.md`, `06-VALIDATION.md`.

### Secondary (MEDIUM confidence)
- FIDO Alliance dev group, "Passkey not working for telegram in-app browser and telegram mini-app": https://groups.google.com/a/fidoalliance.org/g/fido-dev/c/wRXe-oU5MZ4 (informe de usuario; no específico de botones url de teclados inline).

### Tertiary (LOW confidence)
- Resumen de búsqueda sobre webviews y WebAuthn (https://www.corbado.com/blog/passkeys-in-app-browsers): contexto general, no verificado contra Telegram.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no se añaden paquetes; todo es código existente.
- Architecture: HIGH — cada punto de integración se leyó en el código; las decisiones de diseño nuevas (HMAC, `keyboardView`, `kb:` keys) están marcadas como recomendación o `[ASSUMED]`.
- Pitfalls: MEDIUM-HIGH — los del código son verificados; el de passkeys en el navegador interno de Telegram depende del dispositivo.

**Research date:** 2026-11-27
**Valid until:** 2026-12-27 (código estable; revisar si cambian las fases 5/6 o la política de avisos)
