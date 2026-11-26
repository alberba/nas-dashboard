---
phase: 05-bot-de-lectura-y-reconocimiento
researched: 2026-11-26
status: complete
confidence: high
---

# Fase 5: Bot de lectura y reconocimiento - Investigación

**Researched:** 2026-11-26
**Domain:** Long polling de la Bot API dentro del worker de un solo escritor, tokens opacos de callback, estado de reconocimiento y silencio en PostgreSQL
**Confidence:** HIGH (Bot API contrastada con la documentación oficial y el código leído en esta sesión; los puntos que dependen de comportamiento del servidor de Telegram no documentado van marcados `[ASSUMED]`)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Reconocer y silenciar**

- **D-01:** "Silenciar 1 h / 24 h" actúa sobre el **host y la clave**, no solo sobre el episodio. Durante el plazo no interrumpen ni la escalada del episodio actual ni una reapertura del mismo host+clave (flapping), y eso incluye el push de respaldo. Esos eventos se siguen registrando en la incidencia, en Avisos y en el resumen, y el mensaje existente se puede editar en silencio. — **Reversibility:** costly — el silencio se guarda por `(hostId, key)` con vencimiento y lo consultan la política de entrega y el despacho, no una columna del episodio.
- **D-02:** Reconocer significa "lo he visto": registra quién, cuándo y por qué canal (`telegram` o `hub`), sin silenciar nada. Si una incidencia reconocida **escala a crítica, vuelve a interrumpir** según la política de críticas de la fase 2 (D-04 y D-05 de 02-CONTEXT). Para acallarla está Silenciar.
- **D-03:** Al vencer el silencio con la incidencia aún abierta y sin cambios, **no se envía nada**. Solo un evento nuevo posterior al vencimiento, como una escalada o una reapertura, vuelve a interrumpir. Esto mantiene la regla de no reenviar mientras el estado no cambie.
- **D-04:** El resumen diario de las 08:00 lista la incidencia abierta reconocida o silenciada como cualquier otra en "abiertas ahora" y le añade la etiqueta *Reconocida* o *Silenciada hasta HH:MM* (hora de Madrid). Los contadores no cambian. Esto aplica la decisión de la fase 4 de que las preferencias actuales nunca reclasifican un episodio.
- **D-05:** El reconocimiento alimenta la métrica `ackAt` que la fase 1 dejó definida y sin medir: `median(sentAt -> ackAt)` en `01-AUDIT.md`. Hay que persistir `ackAt` para que la métrica se pueda calcular. Mostrarla no entra en esta fase.

**"Por qué me llegó esto"**

- **D-06:** La explicación se envía como **respuesta en el chat** citando el aviso (`reply_parameters`) y con `disable_notification: true`. No se usa el popup de `answerCallbackQuery`. Aun así, el callback recibe su `answerCallbackQuery` para cerrar el spinner.
- **D-07:** El contenido incluye la **regla, el dato leído y el canal**. Ejemplo orientativo: "Temperatura > 70 °C en nas-home (leído 74 °C). Crítica: aviso inmediato por Telegram. Silenciar evita repeticiones." Se genera en el servidor a partir de la incidencia, la política y el registro de entrega, sin datos que viajen en el callback.
- **D-08:** Explica el **estado actual** del mensaje. Si el aviso se editó por una escalada o un cierre, la explicación lo refleja.
- **D-09:** Se envía **una respuesta por estado del aviso**. Una nueva pulsación solo genera otra respuesta si el aviso cambió desde la anterior (escalada o cierre). Si no cambió, recibe un toast "ya respondido" y no se envía otro mensaje. Un callback repetido por Telegram tampoco duplica la respuesta (BOT-06).
- **D-10:** Tras resolverse la incidencia, Silenciar y Reconocer desaparecen del mensaje. "Por qué me llegó esto" y "Abrir en el hub" siguen disponibles en modo de solo lectura.

**Chat, allowlist y hub**

- **D-11:** El `TELEGRAM_CHAT_ID` configurado es un **chat privado** con el bot, así que `chat.id` coincide con el user id del operador. La allowlist exige que `from.id` y `chat.id` sean ese valor, que el chat sea `private` y que el callback venga de un mensaje del propio bot. No se añade `TELEGRAM_OPERATOR_USER_ID`. Cualquier otro update se ignora **sin efecto observable**: no se ejecuta ninguna acción, no se responde al callback y no se registra el contenido del update. El offset sí avanza, para que el update no se reprocese.
- **D-12:** El bot **ignora** el texto y los comandos (`/start`, `/status`…) aunque vengan de la cuenta autorizada. Solo atiende los botones. No hay chatops de texto.
- **D-13:** En Telegram, Silenciar pasa a **"Quitar silencio"** mientras dura el silencio. Reconocer **no se deshace desde el chat**.
- **D-14:** La vista Avisos del hub muestra el estado (*Reconocida* con quién, cuándo y canal; *Silenciada hasta HH:MM*) y ofrece **acciones equivalentes**: reconocer, silenciar 1 h / 24 h y quitar el silencio. Hub y Telegram escriben el mismo estado. Una acción hecha en un canal se refleja en el otro, y el mensaje de Telegram se edita en silencio para mostrar el nuevo estado y sus botones.

### Claude's Discretion

- La respuesta visual en el mensaje tras pulsar: el texto del toast de `answerCallbackQuery`, cómo se marca en el aviso editado ("Reconocida 10:32", "Silenciada hasta 11:32") y la disposición de los botones. Se mantiene la regla de editar sin volver a notificar.
- Qué ve el operador con un botón caducado, ya usado o de una incidencia que ya no existe. Basta un toast genérico sin efecto, sin romper el bot y sin ejecutar dos veces (BOT-06).
- El modelo de tokens: aleatorios opacos de al menos 128 bits, `callback_data` ≤ 64 bytes y el TTL. Decidir si un token es de un solo uso por acción o reutilizable por estado, siempre que un replay no ejecute dos veces.
- La persistencia del offset de `getUpdates`, el `deleteWebhook` al arrancar y la deduplicación por `update_id`. También cómo convive el polling con el lock de recolección del worker y con su healthcheck de la fase 4.
- Si las acciones de reconocer o silenciar desde el hub exigen verificación reciente. Son de bajo impacto y no destructivas, así que por defecto no la exigen. La fase 6 fija la lista de acciones protegidas.
- La redacción del token en errores, logs y respuestas, por ejemplo en las URL de `fetch` que incluyen `/bot<token>/`.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope. Las ideas cercanas ya figuran en v2 (ESCAL-01 recordatorios, PUSH-01 reconocer desde el push) o en la fase 7 (acciones de host).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Descripción | Qué lo habilita en esta investigación |
|----|-------------|----------------------------------------|
| BOT-02 | El bot ignora cualquier update de un usuario o chat fuera de la allowlist | Allowlist doble en una función pura `isAuthorizedCallback`, offset avanzado sin efecto observable, `allowed_updates: ["callback_query"]` como primera barrera (Patrones 2 y 3) |
| BOT-04 | Abrir, silenciar 1 h o 24 h y reconocer desde los botones, con estado persistente | Tabla `incident_snoozes` por `(hostId, key)`, columnas de ack en `incidents`, eventos de línea temporal, edición por el outbox (Patrones 4, 5 y 6) |
| BOT-05 | "Por qué me llegó esto" desde el propio mensaje | Trabajo de outbox `incident-why` con clave única por estado del aviso; texto generado en servidor (Patrón 7) |
| BOT-06 | Un callback repetido o caducado no ejecuta dos veces ni rompe el bot | Token de un solo uso consumido con `UPDATE ... WHERE usedAt IS NULL RETURNING` en la misma transacción que el efecto y el offset; manejo de update veneno (Patrón 2, Pitfalls 1, 2 y 9) |
| BOT-10 | El token del bot nunca aparece en logs ni en respuestas | Un único punto de construcción de URL, resultados finitos sin texto de error, `redactToken` defensivo y prueba que captura toda la salida (Patrón 8) |
</phase_requirements>

## Summary

La fase añade al bot el único camino de entrada que no tenía: los `callback_query` de los botones. El diseño de `.planning/research/ARCHITECTURE.md` (webhook, `telegram_updates`, secreto de cabecera) ya no aplica como transporte, porque la fase 2 movió el bot a long polling dentro del worker. Lo que sigue valiendo de ese documento es la lógica: tokens opacos `v1:<id>`, consumo atómico, allowlist por `from.id` y `chat.id`, `answerCallbackQuery` siempre y la matriz de amenazas. Lo que desaparece es la ruta HTTP, el `secret_token`, el rate limit del webhook y la tabla `telegram_updates`: con long polling el offset persistido en la misma transacción que el efecto ya da deduplicación exacta.

El punto de encaje decisivo es que el polling debe ser **un carril secuencial del bucle que posee el lock**, no un segundo bucle concurrente. El worker comparte una única conexión `pg` (`lock`) con el dispatcher, que abre transacciones sobre ella; un consumidor concurrente sobre ese mismo `Client` entrelazaría sentencias dentro de una transacción ajena. Como además el `getUpdates` largo es el único bloqueo natural del proceso, conviene que **sustituya al reposo de 1 s** (`WORKER_IDLE_MS`) con una espera acotada al tiempo que falta para la siguiente recolección, y que no renueve la marca de salud si falla. Las mutaciones de estado (ack, silencio, consumo de token) usan el pool `db` en una transacción corta, igual que ya hace el recolector, y se comparten con las rutas del hub en un único módulo `incident-actions`.

El silencio por `(hostId, key)` se consulta en dos sitios: al escribir (apertura y escalada, para que el estado de entrega diga la verdad) y al despachar justo antes de la marca de intento (para cubrir lo ya encolado y el push de respaldo). Un silencio vencido no reenvía nada porque un trabajo suprimido es terminal. El resumen necesita dos cambios que el CONTEXT no nombra: etiquetar *Reconocida* y *Silenciada hasta HH:MM*, y **no perder del "abiertas ahora" a las incidencias suprimidas por silencio**, porque hoy ese listado solo admite `openReason = 'digest_pending'`.

**Primary recommendation:** Un carril `runUpdatesOnce` en el bucle del lock (long poll de 0 a 3 s que sustituye al reposo), con offset, consumo de token y efecto en una sola transacción; tokens de un solo uso regenerados en cada render del teclado, "por qué" como trabajo del outbox con clave única por estado, y silencio por `(hostId, key)` consultado al escribir y al despachar. Sin dependencias nuevas.

## Architectural Responsibility Map

| Capacidad | Nivel principal | Nivel secundario | Razón |
|-----------|-----------------|------------------|-------|
| Recibir updates (`getUpdates`, `deleteWebhook`) | Worker (dueño del lock) | — | Solo el dueño del lock consume updates, igual que solo él envía (INCD-06); dos consumidores darían 409 en Telegram |
| Allowlist y parseo del `Update` | Worker | — | Frontera no confiable; función pura sin transporte, testeable sin red |
| Consumo de token, ack, silencio | API / Backend (módulo `incident-actions`) | Base de datos | Una sola implementación compartida por el worker (Telegram) y la ruta del hub; la atomicidad la da PostgreSQL |
| Persistencia de offset, tokens, ack, silencio | Base de datos | — | Sobrevive a reinicios; el offset y el efecto comparten transacción |
| Edición silenciosa del aviso tras ack/silencio | Worker (dispatcher, outbox) | Base de datos | Toda salida a Telegram pasa por el outbox transaccional (INCD-05); las ediciones no notifican |
| `answerCallbackQuery` | Worker (carril de updates) | — | Efímero y de mejor esfuerzo; no se encola, se omite durante un cooldown |
| Respuesta "por qué" | Worker (dispatcher, outbox) | Base de datos | Es un `sendMessage`, así que respeta cooldown, intento incierto sin reenvío y clave única por estado |
| Acciones de Avisos (reconocer, silenciar, quitar) | API / Backend (catch-all existente) | Browser / Client | Sesión y `Origin` ya exigidos en mutaciones; el cliente solo dispara y refleja |
| Etiquetas en el resumen | API / Backend (`digest-content`) | Base de datos | El resumen es una proyección global congelada al preparar |
| Redacción del token | Worker y cliente de Telegram | — | Un único punto construye la URL con el token; el resto solo ve resultados finitos |

## Standard Stack

### Core

No se añade ninguna dependencia. Todo lo necesario ya está declarado y probado en las fases 2 a 4.

| Librería | Versión | Propósito | Por qué es el estándar aquí |
|----------|---------|-----------|------------------------------|
| `fetch` nativo de Node (cliente propio en `src/lib/telegram.ts`) | Node 24 local, Node 26 en CI y en la imagen | Llamadas a la Bot API con origen fijo, `redirect: "error"`, timeout y resultados finitos | Ya implementa el contrato que la fase exige; se amplía, no se reemplaza |
| `zod` | `^4.6.7` declarado, 4.6.7 en el registro | Validar la forma del `Update` y la respuesta de `getUpdates` | Ya es la librería de validación del hub; sirve para el test de contrato |
| `drizzle-orm` + `pg` | `^0.45.4`, `^8.23.1` | Esquema, migración `0007` y transacciones | Mismo patrón que `incident-store.ts` y `digest-runs.ts` |
| `vitest` | `^5.1.0` | Pruebas con transporte Telegram inyectado | Mismo arnés que `tests/telegram.test.ts` y `tests/notification-dispatch.test.ts` |

[VERIFIED: package.json] `"zod": "^4.6.7"`, `"drizzle-orm": "^0.45.4"`, `"pg": "^8.23.1"`, `"vitest": "^5.1.0"`, `"next": "16.4.6"`.
[VERIFIED: npm registry] `npm view zod version` devuelve `4.6.7`.

### Supporting

| Pieza | Propósito | Cuándo usarla |
|-------|-----------|---------------|
| `node:crypto` (`randomBytes`, `createHash`) | Token de 128 bits y hash SHA-256 del token almacenado | Siempre para tokens; nunca `Math.random` ni UUID v4 truncado |
| `AbortSignal.any` (ya usado en `telegram.ts`) | Combinar timeout y apagado del proceso en el long poll | El poll debe abortarse con SIGTERM sin esperar |
| `src/lib/madrid-day.ts` | Formatear "hasta HH:MM" en hora de Madrid | Etiquetas del resumen, de Avisos y del aviso editado |

### Alternatives Considered

| En lugar de | Alternativa | Compromiso |
|-------------|-------------|------------|
| Cliente propio con `fetch` | grammY (`npm view grammy version` devuelve 1.48.0, modificado 2026-11-22) | Añade una dependencia y un modelo de errores propio que habría que volver a envolver para conservar los resultados finitos y el bloqueo de redirecciones. El nombre del paquete salió de una búsqueda propia, no de documentación oficial: `[ASSUMED]`. No se recomienda |
| Carril secuencial en el bucle del lock | Bucle de polling concurrente en el mismo proceso | Menor latencia, pero comparte la conexión `lock` con transacciones del dispatcher; exige otra conexión y reproducir la comprobación del lock. No compensa con un solo operador |
| Offset + token en la misma transacción | Tabla `telegram_updates` con `processedAt` (propuesta del webhook) | La tabla resolvía reintentos HTTP del webhook; con polling la atomicidad ya cubre el caso y la tabla solo añade limpieza |

**Installation:**
```bash
# Ninguna. No hay paquetes nuevos en esta fase.
```

**Version verification:** `npm view zod version` confirmó 4.6.7 (coincide con el rango instalado). No se instala nada nuevo.

## Package Legitimacy Audit

Esta fase no instala paquetes externos. El único nombre ajeno al repo que aparece es grammY, listado solo como alternativa descartada y marcado `[ASSUMED]`; si el planificador lo reconsiderara, debe correr `gsd_run query package-legitimacy check --ecosystem npm grammy` y añadir un `checkpoint:human-verify` antes de instalarlo.

| Paquete | Registro | Edad | Descargas | Repo | Veredicto | Disposición |
|---------|----------|------|-----------|------|-----------|-------------|
| (ninguno) | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### Reconciliación con ARCHITECTURE.md (webhook a long polling)

| Elemento de ARCHITECTURE.md | Estado en la fase 5 | Detalle |
|------------------------------|---------------------|---------|
| `src/app/api/telegram/webhook/route.ts`, `secret_token`, límite de 64 KB, rate limit en memoria | **Se elimina** | No hay entrada HTTP. El hub sigue privado tras Tailscale (STATE.md, decisión de la fase 2) |
| `setWebhook` / `getWebhookInfo` / `scripts/telegram-webhook.ts` | **Se sustituye** | `deleteWebhook` al arrancar el carril, tras tomar el lock. `getWebhookInfo` solo como diagnóstico opcional |
| `handleTelegramUpdate` independiente del transporte | **Se conserva** | Es exactamente el módulo nuevo; el propio documento ya preveía llamarlo desde `getUpdates` |
| `telegram_action_tokens` con `v1:<id>` y `UPDATE ... WHERE used_at IS NULL RETURNING` | **Se conserva** con ajustes | Token almacenado como hash; regenerado en cada render (ver Patrón 4) |
| `telegram_updates` (dedupe por `update_id`, `processedAt`) | **Se sustituye** | Offset persistido en la misma transacción que el efecto |
| Allowlist `TELEGRAM_OPERATOR_USER_ID` / `TELEGRAM_OPERATOR_CHAT_ID` | **Se simplifica** | D-11: se usa `TELEGRAM_CHAT_ID`; no hay variables nuevas |
| `answerCallbackQuery` siempre | **Se conserva** | La documentación oficial lo exige para cerrar la barra de progreso |
| Acciones de host y handoff | **Fuera** | Fases 6 y 7 |

### System Architecture Diagram

```
 Operador (Telegram, chat privado)
        |  pulsa un botón inline
        v
 +--------------------+   getUpdates(offset, timeout<=3, allowed_updates=["callback_query"])
 | Bot API (Telegram) |<------------------------------------------------+
 +--------------------+                                                  |
        | Update[]                                                       |
        v                                                                |
 +-------------------------------- worker.ts: bucle que posee el lock (734921) --------------------------+
 |  workerTurn: lock? -> recolectar -> drain(dispatch, resumen) -> carril de updates -> renovar salud     |
 |                                                                  |                                    |
 |   carril de updates (runUpdatesOnce)                             |                                    |
 |   1. cooldown 429 activo? --si--> no llamar, volver al reposo    |                                    |
 |   2. deleteWebhook una vez por arranque                          |                                    |
 |   3. getUpdates ----------------------------------------------- -+                                    |
 |   4. por cada update:                                                                                 |
 |        parse zod --invalido--> avanzar offset (veneno), sin efecto                                    |
 |        allowlist (from.id, chat.id, private, message del bot, data v1:<22>)                           |
 |          --falla--> avanzar offset, SIN respuesta, SIN log del contenido                              |
 |        TX unica (pool db):                                                                            |
 |          SELECT token FOR UPDATE -> valida chat/message_id -> UPDATE usedAt                           |
 |          -> incident-actions (ack | snooze | unsnooze | why)                                          |
 |          -> incident_events(seq+1) + incidents/incident_snoozes                                       |
 |          -> INSERT outbox incident-edit (seq) o incident-why (clave por estado)                       |
 |          -> UPSERT telegram_poll_state(lastUpdateId)                                                  |
 |        despues del commit: answerCallbackQuery (mejor esfuerzo, finito)                               |
 +--------------------------------------------------------------------------------------------------------+
        |                                                    ^
        v (siguiente turno)                                  | misma transaccion compartida
 dispatcher: claim kind incident-edit | incident-why        API del hub (catch-all, sesion + Origin)
   - silencio activo? --si--> suppressJob("snoozed")          POST incidents/:id/acknowledge|snooze|unsnooze
   - tokens nuevos del teclado -> editMessageText / sendMessage(reply_parameters, disable_notification)
```

### Recommended Project Structure

```
src/lib/
├── telegram.ts              # + getUpdates, deleteWebhook, answerCallbackQuery, sendTelegramReply; un solo punto de URL
├── telegram-updates.ts      # schema zod del Update, isAuthorizedCallback, handleCallback, runUpdatesOnce
├── telegram-keyboard.ts     # estados del teclado (D-10, D-13), emisión de tokens, callback_data
├── incident-actions.ts      # acknowledge / snooze / unsnooze / consumo de token (Transaction compartida)
├── incident-why.ts          # texto "por qué" desde incidente + política + registro de entrega + muestra
├── notification-dispatch.ts # + kind incident-why, chequeo de silencio antes de la marca de intento
├── incident-store.ts        # + helper de silencio en apertura y changeSeverity; proyección con ack y silencio
├── digest-content.ts        # + etiquetas y digestOpen que acepta 'snoozed'
├── worker-loop.ts           # + carril de updates en workerTurn
├── schema.ts                # + telegram_action_tokens, incident_snoozes, telegram_poll_state, columnas ack
src/app/api/[...path]/route.ts   # + incidents/:id/(acknowledge|snooze|unsnooze)
src/components/views/alerts.tsx  # + estado y acciones (D-14)
drizzle/0007_*.sql               # migración aditiva
tests/                           # telegram-fake.ts, telegram-updates.test.ts, incident-actions.test.ts, ...
```

### Pattern 1: Carril secuencial en el bucle del lock; el poll sustituye al reposo

**What:** Añadir a `workerTurn` un último hito `updates` y, cuando Telegram está configurado y el chat es válido, usar su espera en lugar de `delay(WORKER_IDLE_MS)`.
**When to use:** Siempre que haya `config.telegram` con `chatId` positivo.

Hechos del código que fijan el diseño:

- El dispatcher abre transacciones sobre la conexión del lock: `workerDb(client)` es `drizzle(client, { schema })` y `recordTelegramSent` hace `db.transaction(...)` sobre ella. [VERIFIED: src/lib/notification-dispatch.ts:98-100] `function workerDb(client: Client) {` y `return drizzle(client, { schema });`. Un segundo consumidor concurrente sobre ese `Client` entrelazaría sentencias.
- El lock es de sesión: `export const COLLECTION_LOCK_KEY = 734921;` [VERIFIED: src/lib/notification-dispatch.ts:17]. Cada carril empieza con `holdsCollectionLock(client)` y lanza `CollectionLockLost`.
- El reposo actual es `if (!stopping) await delay(WORKER_IDLE_MS);` [VERIFIED: src/worker.ts:170] con `export const WORKER_IDLE_MS = 1_000;` [VERIFIED: src/lib/worker-loop.ts:15].
- La marca se considera vieja a los 90 s: `export const WORKER_STALE_MS = 90_000;` [VERIFIED: src/lib/worker-health.ts:22]. Un poll de unos segundos no la compromete; lo que no debe hacerse es renovar tras un poll fallido (decisión de la fase 4: la marca solo avanza tras hitos reales).
- El muestreo con una pestaña visible es de 5 s: `return hasVisibleTab ? 5000 : 30000;` [VERIFIED: src/lib/validation.ts:45-47]. Un long poll fijo de 25 s retrasaría la recolección; por eso la espera se acota.

Reglas de diseño:

1. `timeout` de `getUpdates` = `clamp(ceil((próximaRecolección - ahora) / 1000), 0, 3)` segundos. Un valor 0 es short polling; la documentación dice que `timeout` "Should be positive; short polling should be used for testing purposes only", así que el límite inferior práctico es 1 y se usa 0 solo cuando la recolección vence ya. [CITED: core.telegram.org/bots/api#getupdates]
2. El `timeoutMs` del `fetch` del poll es `timeout * 1000 + TELEGRAM_REQUEST_TIMEOUT_MS` (10 s de margen), nunca el timeout de 10 s fijo, o el poll se abortaría solo.
3. Se pasa la señal de apagado: SIGTERM aborta el poll y el bucle sale sin esperar.
4. Si el carril falla (red, 5xx, 409, cooldown), el bucle vuelve a `delay(WORKER_IDLE_MS)` con retroceso hasta unos 30 s. Sin esto, un fallo inmediato produce un bucle caliente contra la API.
5. Si el carril procesó updates, el siguiente turno empieza sin reposo para que la edición del aviso salga en el mismo ciclo.
6. Renovar la salud solo cuando el carril termina bien (incluido un poll vacío). Un fallo repetido no extiende la marca; las demás etapas del turno siguen renovándola como hoy.
7. Añadirlo como dependencia **opcional** de `WorkerTurnDeps` y `WorkerDrainDeps` para no romper `tests/notification-dispatch.test.ts` (suite "worker health").

**Example:**
```typescript
// Boceto propuesto. Los nombres son nuevos; los hitos existentes están en worker-loop.ts.
export async function workerTurn(deps: WorkerTurnDeps): Promise<void> {
  // ... lock, recolección, drain y limpieza como hoy ...
  if (deps.updates) {
    const outcome = await deps.updates(); // { handled: number; ok: boolean }
    if (outcome.ok) await deps.health.renew(); // un fallo no extiende la marca
  }
}
```

### Pattern 2: Offset, consumo del token y efecto en una sola transacción

**What:** Cada update válido y autorizado se procesa en **una** transacción del pool `db` que consume el token, aplica el efecto, encola el trabajo de salida y avanza `telegram_poll_state.lastUpdateId`. `answerCallbackQuery` va después del commit.
**Why:** Convierte la entrega "al menos una vez" de Telegram en efecto "exactamente una vez". Si el proceso muere antes del commit, el token queda sin usar y el update se reentrega; si muere después, el offset ya avanzó. No hace falta tabla de updates vistos.

**Offset a enviar:** `lastUpdateId + 1`, calculado tras cada respuesta. La documentación pide "recalculate offset after each server response" y define confirmado "as soon as getUpdates is called with an offset higher than its update_id". [CITED: core.telegram.org/bots/api#getupdates]

**Updates que no se procesan** (no autorizado, tipo no soportado, forma inválida): se avanza el offset con un `UPSERT` mínimo, sin tocar nada más. Es lo que pide D-11.

**Update veneno:** si el update es autorizado y válido pero el manejo lanza por error transitorio (conexión), no se avanza el offset y se reintenta en el siguiente turno; tras un número pequeño de intentos (3) se avanza con una línea de log finita que solo lleva el `update_id`. Sin esta cota, un fallo determinista bloquea la cola para siempre.

**Reinicio de ids de Telegram:** la documentación dice que los identificadores "increase sequentially" y que "If there are no new updates for at least a week, then the identifier of the next update will be chosen randomly instead of sequentially." [CITED: core.telegram.org/bots/api#update] Con `allowed_updates: ["callback_query"]` y un solo operador, una semana sin pulsaciones es normal. Que un id aleatorio menor que `lastUpdateId + 1` nunca se entregue con ese offset es una inferencia de la semántica de `offset`, no algo documentado: `[ASSUMED]`. Mitigación barata: guardar `lastUpdateAt` y, si han pasado más de 6 días, **omitir `offset`** (Telegram devuelve entonces el primer update sin confirmar) y no aplicar ninguna guarda monotónica sobre `update_id`. El token de un solo uso sigue protegiendo contra un replay.

### Pattern 3: Allowlist doble como función pura

**What:** `isAuthorizedCallback(update, config)` decide sin tocar la base de datos ni la red.

Condiciones (todas):

1. El update es un `callback_query` (con `allowed_updates: ["callback_query"]` ya es lo único que llega; se comprueba igualmente, defensa en profundidad y D-12).
2. `callback_query.from.id` es un entero seguro y `String(from.id) === config.chatId`, y `from.is_bot !== true`.
3. `callback_query.message.chat.id` es un entero seguro con `String(chat.id) === config.chatId` y `chat.type === "private"`.
4. `callback_query.data` es una cadena que cumple `^v1:[A-Za-z0-9_-]{22}$` (25 bytes; `callback_data` admite "1-64 bytes").
5. Si `message.date !== 0` (mensaje accesible), `message.from?.is_bot === true`.

`callback_query.message` es un `MaybeInaccessibleMessage`: puede ser un `InaccessibleMessage` cuyo campo `date` es "Always 0. The field can be used to differentiate regular and inaccessible messages." [CITED: core.telegram.org/bots/api#inaccessiblemessage] Un mensaje inaccesible sigue trayendo `chat` y `message_id` pero no `from`, así que la comprobación 5 no es posible y la prueba de que el botón es nuestro la aporta el token ligado a ese chat y mensaje (Patrón 4). Además `callback_query_mode` puede hacer que `message` desaparezca a favor de `inline_message_id`; un callback sin `message` se trata como no autorizado. [CITED: core.telegram.org/bots/api#setmysettings]

**El chat debe ser positivo.** `readRuntimeConfig` acepta ids negativos: `if (!/^-?[1-9]\d{0,19}$/.test(chatId)) {` [VERIFIED: src/lib/runtime-config.ts:317], precisamente "Supergroups and channels use negative numeric identifiers". D-11 supone un chat privado donde `from.id === chat.id`; con un grupo nunca coincidirían y el bot quedaría mudo sin avisar. El carril no debe arrancar si `chatId` empieza por `-`, y debe dejar **una** línea de log finita al arrancar. No hay que cambiar `runtime-config` para esto.

Un `from.id` de Telegram cabe en 52 bits significativos y "a signed 64-bit integer or double-precision float type is safe for storing this identifier" [CITED: core.telegram.org/bots/api#responseparameters]. Comparar como cadena tras `Number.isSafeInteger` es suficiente.

### Pattern 4: Tokens opacos de un solo uso, regenerados en cada render

**Decisión recomendada (cierra la discreción de CONTEXT):** un token por botón y por render del teclado, de un solo uso, **y** acciones idempotentes por estado. Reutilizar tokens por estado no aporta nada y rompe la garantía "token de un solo uso" del objetivo de la fase.

- `callback_data = "v1:" + base64url(randomBytes(16))`: 128 bits, 22 caracteres, 25 bytes en total. [CITED: core.telegram.org/bots/api#inlinekeyboardbutton] `callback_data` "1-64 bytes".
- En la base de datos se guarda `sha256(token)` en hexadecimal como clave; el token en claro solo existe en el mensaje.
- Tabla `telegram_action_tokens`: `tokenHash` (PK), `incidentId` (FK con `onDelete: "cascade"`), `action`, `chatId`, `expiresAt`, `usedAt`, `createdAt`.
- `action` es un conjunto cerrado: `ack`, `snooze_1h`, `snooze_24h`, `unsnooze`, `why`. El servidor deduce todo lo demás; en el callback no viaja ni el id de incidencia ni la duración.
- **Se emiten al renderizar**: `dispatchTelegramOpening` y `dispatchEdit` generan el juego de tokens justo antes de la llamada HTTP. El `messageId` no existe aún en la apertura, así que **no se guarda en el token**: se valida en el consumo comparando `callback_query.message.message_id` con el `messageId` de la fila `incident:<id>:open` del outbox.
- Consumo: `SELECT ... FOR UPDATE`, validar `chatId`/`message_id`/`expiresAt`, y `UPDATE ... SET usedAt = now WHERE tokenHash = $1 AND usedAt IS NULL AND expiresAt > now RETURNING`. Si la validación falla se aborta la transacción y el token queda intacto.
- TTL recomendado: 7 días desde el render (el valor de ARCHITECTURE.md). Un aviso de una incidencia larga se vuelve a renderizar en cada escalada y cierre, lo que renueva sus botones. El caso restante (incidencia abierta más de 7 días sin cambios) da el toast genérico de caducado y el hub sigue disponible.
- Limpieza: borrar caducados en el `cleanup` horario del worker. Los de incidencias borradas se van por cascada.
- Un token emitido y no usado porque el envío falló es inocuo; no hace falta compensarlo.

**Estados del teclado** (disposición de filas a discreción del planificador):

| Estado de la incidencia | Botones |
|-------------------------|---------|
| Abierta, sin ack, sin silencio | Abrir (URL), Reconocer, Silenciar 1 h, Silenciar 24 h, Por qué |
| Abierta, silenciada | Abrir, Reconocer (si no está reconocida), Quitar silencio, Por qué |
| Abierta, reconocida | Abrir, Silenciar 1 h, Silenciar 24 h (o Quitar silencio), Por qué. Sin Reconocer (D-13) |
| Resuelta | Abrir y Por qué únicamente (D-10) |

El botón de abrir es de tipo `url` y no genera callback. [VERIFIED: src/lib/telegram.ts:283] `inline_keyboard: [[{ text: "Abrir en el hub", url: buttonUrl }]],`.

### Pattern 5: Silencio por `(hostId, key)` consultado al escribir y al despachar

**What:** Tabla `incident_snoozes` con una fila por `(hostId, key)` (`until`, `setAt`, `setVia`, `setBy`). Quitar silencio borra la fila; el historial vive en `incident_events`.

Dónde se consulta, todo en una función `activeSnooze(client|tx, hostId, key, now)`:

1. **Apertura** con canal inmediato: en lugar de insertar la fila del outbox como `pending`, insertarla `suppressed` con motivo `snoozed` conservando el canal. [VERIFIED: src/lib/incident-store.ts:796-804] `if (isImmediate(input.delivery)) {` seguido de `kind: "incident-open",` y `status: "pending",`.
2. **Escalada** en `changeSeverity`: cuando un primer aviso aún no enviado pasaría a `pending`, debe quedar `suppressed` con motivo `snoozed`. [VERIFIED: src/lib/incident-store.ts:281-304] La rama `(first.status === "pending" && !first.attemptStartedAt) || ((first.status === "claimed" || first.status === "suppressed") && !first.attemptStartedAt && !first.messageId)`.
3. **Despacho**: justo antes de `beginOutboxAttempt` en `dispatchTelegramOpening` y `dispatchPushJob`, llamar a `suppressJob(context, job, "snoozed")`. Cubre lo ya encolado, el push de respaldo y la carrera entre el silencio y el reclamo. El push de respaldo lo crea `recordPermanentFailure` con `kind: "incident-push"` y `channel: "push"`. [VERIFIED: src/lib/notification-dispatch.ts:533-538]
4. Las **ediciones** no se suprimen: no notifican y D-01 dice explícitamente que el mensaje se puede editar en silencio.

D-03 (vencido = nada) sale gratis: `suppressed` es terminal y `activeSnooze` ignora `until <= now`. Un evento posterior sí vuelve a interrumpir porque `changeSeverity` convierte un primer aviso `suppressed` y sin mensaje en `pending`.

D-02 (reconocer no altera la entrega) también sale gratis: **el ack no se consulta en ningún punto de la política de entrega**. No hay que escribir código para que "escalar a crítica vuelva a interrumpir"; hay que *no* escribirlo, y cubrirlo con una prueba.

Límite que conviene dejar explícito: `changeSeverity` solo abre un envío nuevo cuando todavía no había mensaje. [VERIFIED: src/lib/incident-store.ts:252] `an edit; a push or an uncertain delivery is never re-sent.` Si el aviso ya salió por Telegram, una escalada posterior solo lo edita. Reconocer y Silenciar solo tienen botones en mensajes de Telegram, es decir, en incidencias inmediatas ya enviadas; el silencio protege sobre todo reaperturas (flapping) y los avisos aún no enviados.

### Pattern 6: Ack y silencio como eventos de la línea temporal que suben `seq`

**What:** Reconocer, silenciar y quitar silencio escriben una fila en `incident_events` con `seq = incidents.seq + 1`, incrementan `incidents.seq` y encolan una edición.
**Why:** La edición ya coalesce por `seq` y `editKey(incident.id, seq)` es único. [VERIFIED: src/lib/schema.ts:205] `primaryKey({ columns: [t.incidentId, t.seq] }),`. Los eventos existentes son `"opened"`, `"severity"`, `"closed"` y `"resumed"` [VERIFIED: src/lib/incident-store.ts:624,676,718,788]; los nuevos serían `"acknowledged"`, `"snoozed"` y `"unsnoozed"`.

Comprobaciones de que subir `seq` es seguro:

- La carga del resumen solo cuenta críticas con `WHERE e.kind IN ('opened', 'severity')`. [VERIFIED: src/lib/digest-content.ts:342] Los tipos nuevos no alteran contadores, como exige D-04.
- `recordTelegramSent` programa una edición final si `incident.seq > job.revision` [VERIFIED: src/lib/notification-dispatch.ts:417] `if (!incident || incident.seq <= job.revision) return;`. Un ack que llega mientras la apertura está en vuelo produce una edición correcta.
- Lo que sí hay que hacer: reutilizar la inserción de edición que hoy está duplicada en `closeEpisode` y `changeSeverity` (condición `first.status === "sent" && first.channel === "telegram" && first.chatId && first.messageId`) en un helper `queueEdit(tx, incident, seq, at)`.

**Dónde vive el estado:**

- Reconocimiento por episodio, en columnas nuevas de `incidents`: `acknowledgedAt` (`timestamp({ withTimezone: true })`, nulo), `acknowledgedVia` (`telegram` o `hub`) y `acknowledgedBy` (texto interno; no se publica el id de Telegram). `acknowledgedAt` es el `ackAt` de D-05. La métrica `sentAt -> ackAt` toma `sentAt` del `result.at` de la fila `incident-open` del outbox.
- Las columnas antiguas de `incidents` son `timestamp()` sin zona (`at`, `resolvedAt`) [VERIFIED: src/lib/schema.ts:150-151]; las tablas recientes usan `withTimezone: true`. Las columnas nuevas deben seguir el estilo reciente y las consultas del resumen deben mantener su `AT TIME ZONE 'UTC'` para las antiguas.
- Idempotencia: reconocer una incidencia ya reconocida no escribe evento ni sube `seq`; silenciar con silencio activo extiende solo si el nuevo `until` es posterior, y repetir la misma pulsación no cambia nada.
- Hay que bloquear la fila de la incidencia con `FOR UPDATE`, igual que `recordIncidentObservationIn`, porque el recolector y la acción compiten por `seq`. [VERIFIED: src/lib/incident-store.ts:594-606] `.limit(1)` seguido de `.for("update");`.

### Pattern 7: "Por qué" como trabajo del outbox con clave única por estado

**What:** Un trabajo `kind = "incident-why"`, `channel = "telegram"`, con clave `incident:<id>:why:<noticeSeq>`. `noticeSeq` es el mayor `seq` de eventos de tipo `opened`, `severity` o `closed` (los ack y silencios no cuentan).
**Why:**

- D-09 se cumple en la base de datos: la segunda pulsación sobre el mismo estado choca con la clave única (`onConflictDoNothing`) y recibe el toast "ya respondido"; una escalada o un cierre cambia `noticeSeq` y permite otra respuesta.
- Un `sendMessage` es una salida y debe respetar el cooldown 429, el intento incierto sin reenvío y el límite de 4096 que ya implementa el dispatcher. Hacerlo en línea desde el carril de updates duplicaría esa lógica.
- Un callback repetido por Telegram no duplica la respuesta ni la acción (BOT-06).

Cambios que obliga en el dispatcher:

- La lista de tipos reclamables está escrita a mano en SQL: [VERIFIED: src/lib/notification-dispatch.ts:259] `AND kind IN ('incident-open', 'incident-edit', 'incident-push', 'push-test')`. Hay que añadir `'incident-why'`. Sin ello el trabajo se queda `pending` para siempre sin error.
- El comentario del esquema también enumera los tipos. [VERIFIED: src/lib/schema.ts:230] `/** \`incident-open\`, \`incident-edit\`, \`incident-push\` or \`push-test\`. */`
- `runDispatchOnce` enruta por `job.kind`; añadir la rama `incident-why`.
- `recoverOutbox` ya trata cualquier tipo distinto de `incident-edit` con intento iniciado como incierto sin reenvío: es el comportamiento correcto para una respuesta.
- `projectRow` solo busca `incident-open` y `incident-edit`, así que la respuesta no contamina el estado de entrega de Avisos.

Contenido (D-07, D-08): se genera al despachar, con el estado vigente.

- **Regla:** `incident.detail`, que ya contiene el umbral. [VERIFIED: src/lib/collector.ts:518] `` `Algún sensor supera ${settings.temperature} °C.`, ``
- **Canal:** `notificationPolicy(incident.key, severity)` más el resultado real de la fila de apertura.
- **Dato leído:** **no está persistido** en la incidencia (el `detail` es texto fijo con el umbral). Recomendación: leer la última fila de `samples` del host y extraer la lectura de las claves `cpu`, `memory`, `disk` y `temperature`, y omitir esa parte con una frase neutra para el resto de claves. Es el único hueco entre D-07 y el código; ver Open Questions.
- Envío: `sendMessage` con `reply_parameters: { message_id, allow_sending_without_reply: true }` y `disable_notification: true`. `reply_parameters` existe en `sendMessage`; `allow_sending_without_reply` es "Pass True if the message should be sent even if the specified message to be replied to is not found." [CITED: core.telegram.org/bots/api#replyparameters] El cliente nunca fija `parse_mode`, así que el texto es plano.

### Pattern 8: Redacción del token en un único punto

**What:** El token solo debe tocar **un** sitio: la construcción de la URL en el cliente. El resto del código ve resultados finitos.

- Hoy ya es así para el envío: la URL se arma en `post()` con `${TELEGRAM_ORIGIN}/bot${context.botToken}/${context.method}` y los errores se mapean a `reason` finitos sin conservar el mensaje de excepción. [VERIFIED: src/lib/telegram.ts:172-192] El bloque `catch {` devuelve `{ state: "uncertain", reason: ... }`.
- Se probó en esta sesión que `fetch` de Node 24.22.3 no incluye el token en `message`, `cause` ni `util.inspect` ante `ENOTFOUND`, redirección con `redirect: "error"` y conexión cortada. CI usa Node 26, así que la prueba de redacción debe correr también allí `[VERIFIED: probe local, Node v24.22.3]`.
- Aun así hay que cubrir transportes inyectados y errores futuros: un `redactToken(text, token)` que sustituya el token literal y cualquier `/bot\d{5,12}:[A-Za-z0-9_-]{30,}/` por un marcador, aplicado a **toda** línea de log nueva del carril.
- Los nuevos métodos (`getUpdates`, `deleteWebhook`, `answerCallbackQuery`, respuesta) deben salir de un único `botRequest` que factorice lo que hoy hace `post()` (URL, `redirect: "error"`, `cache: "no-store"`, timeout, validación). No copiar `post()` cuatro veces.
- Registros: el carril no loguea el `Update`, ni `callback_data`, ni nombres, ni ids de usuario; solo `update_id` y la acción, y solo en transiciones (como hace el resumen). La clave del token tampoco se escribe en las filas de resultado.

### Anti-Patterns to Avoid

- **Bucle de polling concurrente sobre la conexión `lock`:** entrelaza sentencias con las transacciones del dispatcher.
- **`getUpdates` con timeout de 25-50 s dentro del turno:** retrasa la recolección con una pestaña abierta (5 s) y los trabajos que escribe el hub.
- **Silenciar solo con una columna del episodio:** rompe D-01 (reapertura y flapping).
- **Consultar el ack en la política de entrega:** contradice D-02.
- **Responder al callback antes de confirmar el efecto:** un toast de "hecho" sin commit miente. `answerCallbackQuery` va después del commit.
- **Responder a callbacks no autorizados, aunque sea con un toast genérico:** D-11 exige sin efecto observable; la arquitectura previa proponía un `answerCallbackQuery` genérico y esa propuesta queda revocada.
- **`drop_pending_updates: true` en `deleteWebhook`:** descartaría pulsaciones hechas durante una parada. Se llama sin él.
- **Encolar `sendMessage` desde el carril de updates fuera del outbox:** salta cooldown, intento incierto y reintentos.
- **Poner `callback_data` con id de incidencia o acción legible:** es un contrato de acción manipulable.

## Don't Hand-Roll

| Problema | No construir | Usar en su lugar | Por qué |
|----------|--------------|------------------|---------|
| Cliente de la Bot API | Otro `fetch` suelto por método | Ampliar `src/lib/telegram.ts` con un `botRequest` común | Origen fijo, `redirect: "error"`, timeout, truncado y resultados finitos ya están resueltos y probados |
| Reintento y pausa por 429 | Un temporizador propio | `telegram_cooldown` y `beginTelegramCooldown` | Es la pausa durable compartida; sobrevive a reinicios [VERIFIED: src/lib/notification-dispatch.ts:103] `export const TELEGRAM_COOLDOWN_CHANNEL = "telegram";` |
| Envío de la respuesta "por qué" | `sendMessage` directo | Trabajo del outbox `incident-why` | Cooldown, incierto sin reenvío y clave única ya existen |
| Edición del aviso tras ack/silencio | Llamada directa a `editMessageText` | `incident-edit` con `seq` | Coalescencia por revisión y edición sin notificar ya implementadas |
| Deduplicación de callbacks | Tabla de updates vistos con barrido | Offset en la misma transacción + token de un solo uso | La atomicidad de PostgreSQL ya lo garantiza |
| Aleatoriedad de tokens | `Math.random`, UUID v4 o un hash del id | `randomBytes(16)` | 128 bits de entropía criptográfica |
| Validación del `Update` | Comprobaciones `typeof` a mano repartidas | Un esquema `zod` tolerante a campos extra | Telegram añade campos sin aviso; el esquema debe ignorarlos |
| Hora de Madrid | Offsets fijos | `Intl` con `Europe/Madrid` o `src/lib/madrid-day.ts` | El cambio de hora rompe un offset fijo |
| Consumo de token | Leer, comprobar y escribir en pasos | `UPDATE ... WHERE usedAt IS NULL RETURNING` | La carrera entre dos pulsaciones solo la resuelve una sentencia atómica |

**Key insight:** casi todo lo que esta fase necesita ya existe como patrón en el repo (outbox, cooldown, edición por `seq`, lock). El trabajo es conectar el carril de entrada a esos mecanismos sin crear un segundo camino de salida.

## Runtime State Inventory

No aplica: no es una fase de renombrado ni de migración de datos existentes. La migración `0007` es aditiva: tablas nuevas y columnas nulas en `incidents`, sin reescribir historial ni entrega. Se verifica con una prueba análoga a las de `0005` y `0006` (ver Validation Architecture).

## Common Pitfalls

### Pitfall 1: Un update veneno bloquea el bot
**What goes wrong:** un update autorizado que provoca siempre una excepción se reentrega en cada poll y el offset no avanza; el bot deja de responder (viola BOT-06).
**Why it happens:** "no avanzar si falla" es correcto para errores transitorios y letal para los deterministas.
**How to avoid:** los casos de usuario (token usado, caducado, inexistente, forma inválida, no autorizado) nunca lanzan: devuelven un resultado y avanzan. Solo los errores de infraestructura reintentan, con tope de 3 y salto con log finito.
**Warning signs:** el mismo `update_id` aparece en logs más de tres veces.

### Pitfall 2: Reiniciar el offset de Telegram tras una semana sin actividad
**What goes wrong:** el siguiente callback no llega nunca porque su id aleatorio es menor que el offset guardado.
**Why it happens:** "If there are no new updates for at least a week, then the identifier of the next update will be chosen randomly" [CITED: core.telegram.org/bots/api#update].
**How to avoid:** guardar `lastUpdateAt` y omitir `offset` pasados 6 días; no usar guarda monotónica por `update_id`. Probar con el fake de Telegram. El efecto sobre el servidor es `[ASSUMED]`.
**Warning signs:** una pulsación tras un periodo largo no produce ni toast.

### Pitfall 3: Webhook residual o segundo consumidor (409)
**What goes wrong:** `getUpdates` falla con conflicto. La documentación dice "This method will not work if an outgoing webhook is set up." y "You will not be able to receive updates using getUpdates for as long as an outgoing webhook is set up." [CITED: core.telegram.org/bots/api#getupdates]
**Why it happens:** un webhook configurado antes, o un segundo proceso que consume con el mismo token (otro worker, `media-stack`, un script).
**How to avoid:** `deleteWebhook` (sin `drop_pending_updates`) al arrancar el carril, antes del primer poll; si falla, no sondear y reintentar con retroceso. Que el lock impida dos workers cubre el hub; confirmar que `media-stack` no consume updates con el mismo token. El texto exacto del error 409 de `getUpdates` es conocimiento previo, `[ASSUMED]`.
**Warning signs:** rechazos 409 constantes en el carril.

### Pitfall 4: `allowed_updates` heredado
**What goes wrong:** si se omite el parámetro, "the previous setting will be used", así que un valor antiguo del bot decide qué llega. [CITED: core.telegram.org/bots/api#getupdates]
**How to avoid:** enviar siempre `allowed_updates: ["callback_query"]` en **cada** llamada. Un valor vacío recibiría todo menos `chat_member` y reacciones.

### Pitfall 5: El silencio no llega a lo ya encolado ni al push de respaldo
**What goes wrong:** el operador silencia mientras hay una apertura `pending` o un `incident-push` encolado y sale igualmente.
**How to avoid:** comprobar el silencio también al despachar, antes de `beginOutboxAttempt`, en apertura y push. Prueba con la carrera: silencio entre el reclamo y la marca de intento.

### Pitfall 6: El resumen pierde las incidencias suprimidas por silencio
**What goes wrong:** D-01 dice que los eventos silenciados "se siguen registrando ... en el resumen", pero el listado "abiertas ahora" solo admite `openChannel = 'digest' AND openStatus = 'suppressed' AND openReason = 'digest_pending'`. [VERIFIED: src/lib/digest-content.ts:303-305] `(w."openChannel" = 'digest'` / `AND w."openStatus" = 'suppressed'` / `AND w."openReason" = 'digest_pending') AS "digestOpen"`. Una crítica suprimida con motivo `snoozed` queda fuera y desaparece del resumen.
**How to avoid:** ampliar `digestOpen` para aceptar `openStatus = 'suppressed' AND openReason = 'snoozed'`, sin cambiar los contadores (D-04), y añadir las etiquetas *Reconocida* y *Silenciada hasta HH:MM* al detalle. Prueba que fije que el contador `openNow` no se mueve por ack.
**Open point:** una crítica ya enviada y reconocida (`status = 'sent'`) hoy no sale en "abiertas ahora". D-04 dice "como cualquier otra"; el planificador debe confirmar que solo se etiqueta lo ya listado.

### Pitfall 7: Un tipo de trabajo nuevo que nadie reclama
**What goes wrong:** `incident-why` se inserta y queda `pending` para siempre.
**How to avoid:** actualizar la lista `kind IN (...)` de `claimOutboxJob`, la rama de `runDispatchOnce` y el comentario del esquema. Prueba de extremo a extremo: un `incident-why` encolado acaba `sent` con la petición capturada.

### Pitfall 8: Botones de un mensaje con entrega incierta
**What goes wrong:** si la apertura quedó `uncertain`, el aviso pudo llegar con botones, pero la fila del outbox no tiene `messageId`, así que la validación `message_id` del consumo falla.
**How to avoid:** el comportamiento correcto es el toast genérico sin efecto (CONTEXT lo admite) y dejar ack y silencio al hub. No relajar la validación para este caso.

### Pitfall 9: Doble pulsación con el teclado aún sin editar
**What goes wrong:** entre la pulsación y la edición (hasta unos segundos) el teclado viejo sigue visible; el operador pulsa otro botón y espera coherencia.
**How to avoid:** cada botón tiene su propio token, así que pulsar "Silenciar" tras "Reconocer" es válido e independiente. Reutilizar el mismo botón da el toast de ya usado. Las acciones son idempotentes por estado, no por token.

### Pitfall 10: Estado de Avisos y mensaje de Telegram desalineados
**What goes wrong:** el hub escribe ack/silencio pero no encola la edición, o la encola sin que haya mensaje.
**How to avoid:** la acción del hub y la de Telegram llaman a la **misma** función de `incident-actions`, que escribe evento, estado y `queueEdit` en la misma transacción. Prueba: acción desde el hub produce exactamente una fila `incident-edit` por `seq` y ninguna si la incidencia no tuvo mensaje de Telegram.

### Pitfall 11: Tests acoplados al copy
**What goes wrong:** romper `CODING_STANDARD.md` con aserciones sobre textos de toast o del aviso.
**How to avoid:** asertar estado, resultado y estructura: filas del outbox, `reply_parameters.message_id` y `disable_notification` de la petición capturada, `callback_data` de los botones, atributos `data-*` en Avisos. Nunca el texto. Antes de tocar texto visible, `grep` en `tests/` por la cadena antigua.

### Pitfall 12: Fecha y hora de Madrid en etiquetas
**What goes wrong:** "Silenciada hasta 11:32" calculado con offset fijo o con la zona del proceso.
**How to avoid:** formatear con `Intl` y `timeZone: "Europe/Madrid"`; probar con un `TZ` de proceso distinto y un silencio que cruza el cambio de hora.

## Code Examples

Los nombres de módulos y funciones son propuestas de esta investigación; los campos de la Bot API están citados de la documentación oficial.

### Parseo del update con esquema tolerante

```typescript
// Boceto propuesto. Campos según core.telegram.org/bots/api#callbackquery
import { z } from "zod";

const telegramUser = z.looseObject({ id: z.number().int(), is_bot: z.boolean().optional() });
const telegramMessage = z.looseObject({
  message_id: z.number().int(),
  date: z.number().int(), // 0 identifica un InaccessibleMessage
  chat: z.looseObject({ id: z.number().int(), type: z.string() }),
  from: telegramUser.optional(),
});
export const telegramUpdateSchema = z.looseObject({
  update_id: z.number().int(),
  callback_query: z
    .looseObject({
      id: z.string(),
      from: telegramUser,
      message: telegramMessage.optional(),
      inline_message_id: z.string().optional(),
      data: z.string().optional(),
    })
    .optional(),
});
```

### Llamada a `getUpdates` con el contrato de la documentación

```typescript
// Cada llamada fija allowed_updates: si se omite, Telegram reutiliza el valor anterior.
const body = {
  ...(offset !== null ? { offset } : {}), // se omite tras 6 días sin updates
  timeout: pollSeconds, // 0 a 3
  limit: 20,
  allowed_updates: ["callback_query"],
};
// POST https://api.telegram.org/bot<token>/getUpdates, construido solo dentro de botRequest
```

### Consumo atómico del token

```sql
-- Dentro de la transaccion unica; si la validacion posterior falla se hace rollback y el token queda intacto.
UPDATE telegram_action_tokens
   SET "usedAt" = $2
 WHERE "tokenHash" = $1
   AND "usedAt" IS NULL
   AND "expiresAt" > $2
RETURNING "incidentId", action, "chatId";
```

### Respuesta "por qué" citando el aviso sin notificar

```typescript
// Campos citados de sendMessage y ReplyParameters (Bot API).
const body = {
  chat_id: chatId,
  text: telegramText(text),
  disable_notification: true,
  reply_parameters: { message_id: Number(messageId), allow_sending_without_reply: true },
};
```

## State of the Art

| Enfoque antiguo | Enfoque actual | Cuándo cambió | Impacto |
|-----------------|----------------|---------------|---------|
| Webhook como transporte del bot (ARCHITECTURE.md) | Long polling dentro del worker | Fase 2 (STATE.md) | Sin ruta HTTP, sin `secret_token`, sin `telegram_updates` |
| `callback_query.message` siempre accesible | `MaybeInaccessibleMessage` con `date: 0` y `callback_query_mode` | Bot API reciente | La allowlist no puede exigir `message.from` en todos los casos |
| Offset solo en memoria | Offset persistido en la transacción del efecto | Esta fase | Entrega exactamente una vez |

**Deprecated/outdated:**
- La propuesta de responder con `answerCallbackQuery` genérico a updates no autorizados queda revocada por D-11.
- `TELEGRAM_OPERATOR_USER_ID` y `TELEGRAM_OPERATOR_CHAT_ID` no se crean (D-11).
- `01-AUDIT.md` dice que `ackAt` "se medirá en la fase 6"; el CONTEXT de esta fase lo asigna a la 5. Prevalece CONTEXT.

## Assumptions Log

| # | Afirmación | Sección | Riesgo si es falsa |
|---|------------|---------|--------------------|
| A1 | Un `update_id` aleatorio menor que el offset guardado no se entrega con ese `offset` | Patrón 2, Pitfall 2 | Si Telegram lo entregara igualmente, la omisión de `offset` tras 6 días es inocua; si no lo entrega y no se mitiga, se pierde una pulsación tras un periodo largo |
| A2 | `getUpdates` devuelve un conflicto (409) cuando hay otro consumidor o un webhook | Pitfall 3 | Solo cambia el texto del log; la mitigación (`deleteWebhook`, lock) no depende de ello |
| A3 | El `query_id` de un callback caduca pasado un tiempo y `answerCallbackQuery` tardío falla | Patrón 2 | La documentación no fija plazo; el diseño responde tras el commit y trata el fallo como mejor esfuerzo, así que no cambia el comportamiento |
| A4 | `editMessageText` sin `reply_markup` retira el teclado | Pattern 4 | El cliente ya envía siempre `reply_markup`; sin impacto mientras se mantenga |
| A5 | Un TTL de 7 días por render es suficiente para los botones | Patrón 4 | Una incidencia larga sin cambios pierde los botones; el hub los sustituye. Ajustable sin migración |
| A6 | Tomar el "dato leído" de la última muestra del host es aceptable en lugar de persistirlo al abrir | Patrón 7 | La lectura mostrada puede diferir de la del instante de apertura; si el operador lo exige, añadir una columna en `incidents` |
| A7 | `media-stack` no consume `getUpdates` ni configura webhook con el mismo token | Pitfall 3 | Un segundo consumidor rompería el polling del hub; se comprueba en el repositorio hermano |
| A8 | Las ediciones de mensaje no generan notificación en el cliente | Resumen | Es el supuesto del proyecto desde la fase 2 y D-01/D-14 lo dan por hecho; la documentación oficial leída no lo afirma |

## Open Questions

1. **¿De dónde sale el "dato leído" de D-07?**
   - Lo que sabemos: `incident.detail` guarda la regla con su umbral, no la lectura. [VERIFIED: src/lib/collector.ts:518] La lectura existe en `samples`.
   - Lo que falta: si basta la lectura actual (coherente con D-08, "estado actual") o debe fijarse la del instante de apertura.
   - Recomendación: leer la última muestra del host al despachar, omitir la parte de lectura para claves sin métrica y no tocar el esquema de `incidents`. Es la opción de menor coste.

2. **¿Se lista una crítica ya enviada y reconocida en "abiertas ahora"?**
   - Lo que sabemos: hoy el listado solo incluye disposiciones de resumen (Pitfall 6).
   - Lo que falta: si D-04 ("como cualquier otra") pide ampliar la inclusión o solo etiquetar lo ya listado.
   - Recomendación: etiquetar solo lo ya listado y añadir las suprimidas por silencio; no reclasificar nada más.

3. **¿Ejecuta `media-stack` `getUpdates` o un webhook con el mismo token?**
   - Lo que sabemos: es multi-repo y SEC-05 (fase 8) trata la rotación conjunta del token.
   - Recomendación: una comprobación manual en el otro repo antes de activar el carril en producción; el plan 05-01 debe dejar la comprobación como paso de verificación, no como código.

4. **Chat negativo configurado.**
   - Recomendación ya cerrada: el carril no arranca y deja una línea de log. No cambia `runtime-config`.

## Environment Availability

| Dependencia | Requerida por | Disponible | Versión | Alternativa |
|-------------|---------------|-----------|---------|-------------|
| Node | Todo | Sí | v24.22.3 local; CI e imagen en Node 26 | Correr la suite de redacción también bajo Node 26 |
| pnpm | Scripts | Sí | 12.15.0 | — |
| PostgreSQL local | Pruebas de integración (`HUB_REQUIRE_TEST_DB=1`) | No | `DATABASE_URL` sin definir, sin `pg_isready` | Contenedor desechable `postgres:18` con Docker |
| Docker | PostgreSQL desechable y sonda de salud | Sí | Servidor 29.8.2 | — |
| Bot real de Telegram | Verificación manual final | No necesario en CI | — | Transporte inyectado `fetchImpl`; verificación manual en UAT |
| Playwright | Avisos (`pnpm test:e2e`) | Declarado | `^1.65.0` | Pruebas de ruta con `vitest` |

[VERIFIED: ci.yml:12] `image: postgres:18`.

**Missing dependencies with no fallback:** ninguna.
**Missing dependencies with fallback:** PostgreSQL local (contenedor desechable con `DATABASE_URL` de loopback; `tests/database.ts` rechaza cualquier URL remota).

## Validation Architecture

### Test Framework

| Propiedad | Valor |
|-----------|-------|
| Framework | Vitest 5.1.0 (`tests/**/*.test.ts`), más Playwright 1.65 para e2e |
| Archivo de config | `vitest.config.ts` (alias `@` a `src`) |
| Comando rápido | `pnpm test tests/telegram.test.ts` (20 pruebas aprobadas en esta sesión) |
| Comando de integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` con `DATABASE_URL` local |
| Suite completa | `pnpm test`, `pnpm typecheck`, `pnpm lint` |

`HUB_REQUIRE_TEST_DB=1` convierte la falta de base de datos o una URL remota en fallo en vez de omitir. [VERIFIED: tests/database.ts:4-35]

### Phase Requirements → Test Map

| Req ID | Comportamiento | Tipo | Comando automatizado | Existe |
|--------|----------------|------|----------------------|--------|
| BOT-02 | Usuario o chat ajeno, chat de grupo, texto y comandos autorizados: sin filas, sin petición saliente y el offset avanza | unit + integración | `pnpm test tests/telegram-updates.test.ts` | Wave 0 |
| BOT-02 | `allowed_updates` y `offset` viajan en cada llamada; `deleteWebhook` antes del primer poll y sin `drop_pending_updates` | unit con fake | `pnpm test tests/telegram-updates.test.ts` | Wave 0 |
| BOT-04 | Ack, silencio 1 h y 24 h y quitar silencio persisten tras reinicio y generan evento y edición | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-actions.test.ts` | Wave 0 |
| BOT-04 | Silencio por host+clave suprime apertura, escalada, reapertura y push de respaldo; ediciones siguen; vencido no reenvía; ack no suprime | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts` | Ampliar |
| BOT-04 | Ruta del hub: sesión, `Origin`, cuerpo validado, mismo estado que Telegram | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts` | Ampliar |
| BOT-04 | Etiquetas del resumen y `ackAt` persistido | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts` | Ampliar |
| BOT-05 | Una respuesta por estado; segunda pulsación sin mensaje; escalada o cierre permiten otra; la petición lleva `reply_parameters` y `disable_notification` | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-why.test.ts` | Wave 0 |
| BOT-06 | Mismo `update_id` dos veces, token usado, caducado, inexistente, de otra incidencia o con `message_id` distinto: un solo efecto y sin excepción | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-actions.test.ts` | Wave 0 |
| BOT-06 | Caída entre efecto y confirmación: el reinicio con el fake no repite el efecto | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-updates.test.ts` | Wave 0 |
| BOT-10 | Con transportes que fallan por cada método, ninguna salida de consola, resultado ni cuerpo contiene el token | unit | `pnpm test tests/telegram.test.ts` | Ampliar |
| Contrato | Fixtures del `Update` (accesible, inaccesible con `date: 0`, `inline_message_id`, texto, tipo desconocido, campos extra, tipos erróneos) | unit | `pnpm test tests/telegram-updates.test.ts` | Wave 0 |
| Salud | El carril no renueva la marca si falla; el poll sustituye al reposo y se aborta con SIGTERM | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts` (suite "worker health") | Ampliar |
| Migración | `0007` aditiva, alineación SQL, snapshot y journal | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | Ampliar |
| Avisos | Estado y acciones con atributos `data-*`, sin depender del copy | e2e | `pnpm test:e2e tests/e2e/incidents.spec.ts` | Ampliar |

### Sampling Rate

- **Por tarea:** `pnpm test tests/telegram.test.ts tests/telegram-updates.test.ts` (sin base de datos, segundos).
- **Por ola:** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts tests/incident-actions.test.ts tests/api-incidents.test.ts tests/migrations.test.ts`, más `pnpm typecheck` y `pnpm lint`.
- **Cierre de fase:** suite completa con PostgreSQL desechable `postgres:18`, `pnpm build`, la suite de redacción bajo Node 26 y una verificación manual con el bot real (pulsar los cuatro botones y comprobar la edición silenciosa).

### Wave 0 Gaps

- [ ] `tests/telegram-fake.ts`: Bot API simulada con cola de updates que implemente la confirmación por `offset` (descarta `update_id` menores), `allowed_updates`, `deleteWebhook`, 429 con `retry_after`, y que capture cada petición. Es la pieza que hace posibles las pruebas de reinicio, replay y redacción.
- [ ] `tests/telegram-updates.test.ts`: contrato del `Update`, allowlist y carril.
- [ ] `tests/incident-actions.test.ts` y `tests/incident-why.test.ts`.
- [ ] Fixtures del `Update` copiadas de la forma documentada en la Bot API (accesible, inaccesible, `inline_message_id`).
- [ ] Migración `drizzle/0007_*.sql` generada con `drizzle-kit` y su snapshot, antes de las pruebas de integración.
- [ ] Sin dependencias nuevas que instalar.

## Security Domain

`security_enforcement` no está desactivado en la configuración consultada; la sección aplica.

### Applicable ASVS Categories

| Categoría ASVS | Aplica | Control estándar |
|----------------|--------|------------------|
| V2 Authentication | Parcial | El operador de Telegram se identifica por `from.id` y `chat.id` contra `TELEGRAM_CHAT_ID`; el hub reutiliza la sesión existente. Sin autenticación nueva |
| V3 Session Management | Sí (hub) | Las rutas de Avisos usan la sesión de `better-auth` ya exigida por el catch-all |
| V4 Access Control | Sí | Allowlist doble, token ligado a incidencia, acción, chat y mensaje, y lista cerrada de acciones |
| V5 Input Validation | Sí | `zod` para el `Update` y para el cuerpo de las rutas; `callback_data` con patrón estricto |
| V6 Cryptography | Sí | `randomBytes(16)` para tokens y `sha256` para almacenarlos; nunca criptografía propia |
| V7 Error Handling and Logging | Sí | Resultados finitos, `redactToken` y logs sin contenido del update (BOT-10) |
| V13 API and Web Service | Sí | Las mutaciones del hub ya exigen `Origin`. [VERIFIED: route.ts:127] `if (mutation && !origins.includes(request.headers.get("origin") ?? ""))` |

### Known Threat Patterns for Node + Telegram Bot API + PostgreSQL

| Patrón | STRIDE | Mitigación estándar |
|--------|--------|---------------------|
| Pulsación desde otro usuario o chat | Spoofing | Doble allowlist, chat `private`, sin respuesta ni log del contenido |
| Manipular `callback_data` | Tampering | Token opaco de 128 bits resuelto en servidor; el callback no lleva datos |
| Repetir un callback o una pulsación | Repudiation / Tampering | Token de un solo uso, consumo atómico y offset en la misma transacción |
| Reutilizar un token en otro mensaje o incidencia | Elevation of Privilege | El consumo valida `chat.id`, `message_id` y la incidencia del token |
| Fuga del token del bot en logs o respuestas | Information Disclosure | Un único punto de URL, resultados finitos, `redactToken` y prueba de captura total |
| Cola bloqueada por un update malformado | Denial of Service | Parseo tolerante, update veneno acotado y avance del offset |
| Segundo consumidor de updates | Tampering / DoS | Lock de recolección, `deleteWebhook` al arrancar y comprobación de `media-stack` |
| Respuesta a no autorizados que revela que el bot existe o qué hace | Information Disclosure | Ningún `answerCallbackQuery` ni mensaje a no autorizados (D-11) |
| Acción de bajo impacto sin verificación reciente | Elevation of Privilege | Aceptado por CONTEXT; la fase 6 decide la lista protegida. Documentar `acknowledge`, `snooze` y `unsnooze` como no protegidas para que SEC-02 las clasifique |

## Project Constraints (from CLAUDE.md)

No existe `CLAUDE.md` ni `.claude/CLAUDE.md` en el repositorio; las directrices vienen de `AGENTS.md` y del `CLAUDE.md` global del usuario.

- **Next.js con cambios incompatibles** (`AGENTS.md`): leer la guía relevante en `node_modules/next/dist/docs/` antes de prescribir cualquier API de Next. Esta fase **no introduce APIs nuevas de Next**: reutiliza el catch-all `src/app/api/[...path]/route.ts` (exports `GET`, `POST`, `DELETE`) y una vista cliente existente. [VERIFIED: route.ts:812-813] `export const GET = handle;` y `export const POST = handle;`. El planificador debe abrir `node_modules/next/dist/docs/01-app` si añade algo más que una rama a ese `handle`.
- **Estándar de código** (`AGENTS.md`): leer `CODING_STANDARD.md` antes de escribir o editar pruebas y antes de cambiar texto visible. Las pruebas asertan estado, resultado o estructura, nunca copy; con `data-*` cuando el componente no ofrezca gancho. Buscar en `tests/` la cadena antigua tras cualquier cambio de texto.
- **Shell** (`CLAUDE.md` global): entrecomillar los globs; en BSD `sed` usar `-i ''` y `-E`; zsh no divide variables sin comillas; llaves en `"${ref}:path"`.
- **Idioma:** artefactos de planificación en español, como las fases anteriores.
- **Proyecto:** un solo `app` y un solo `worker`; el worker es el escritor único y no se amplían privilegios del agente (PROJECT.md, citado en 04-RESEARCH.md).

## Sources

### Primary (HIGH confidence)
- Telegram Bot API, `https://core.telegram.org/bots/api`, descargado y leído en esta sesión: `getUpdates` (`offset`, `limit`, `timeout`, `allowed_updates`, confirmación por offset, 24 h de almacenamiento, "This method will not work if an outgoing webhook is set up"), `Update.update_id` (reinicio aleatorio tras una semana), `deleteWebhook`, `getWebhookInfo`, `CallbackQuery` (incluida la nota de `answerCallbackQuery`), `InaccessibleMessage` y `MaybeInaccessibleMessage`, `InlineKeyboardButton.callback_data` (1-64 bytes), `answerCallbackQuery`, `sendMessage` (`disable_notification`), `ReplyParameters`, `editMessageText`, `editMessageReplyMarkup`, `ResponseParameters.retry_after` y `setMySettings.callback_query_mode`.
- Código del repositorio leído en esta sesión: `src/lib/telegram.ts`, `src/lib/notification-dispatch.ts`, `src/lib/incident-store.ts` (líneas 140-1070), `src/lib/notification-policy.ts`, `src/lib/schema.ts`, `src/lib/worker-loop.ts`, `src/lib/worker-health.ts`, `src/worker.ts`, `src/lib/digest-content.ts` (270-380), `src/lib/collector.ts` (85-135, 440-530), `src/lib/runtime-config.ts` (30-60, 280-340), `src/app/api/[...path]/route.ts` (1-215), `src/components/views/alerts.tsx` (250-330), `src/lib/types.ts` (224-340), `tests/database.ts`, `compose.yaml`, `drizzle/0006_digest_runs.sql`.
- `.planning/` leídos: `05-CONTEXT.md`, `REQUIREMENTS.md`, `STATE.md`, `02-CONTEXT.md` (D-01 a D-06), `01-AUDIT.md` (contrato `ackAt`), `04-RESEARCH.md`, `research/ARCHITECTURE.md` (callback path, webhook y amenazas).
- Pruebas ejecutadas en esta sesión: `pnpm test tests/telegram.test.ts` (20 aprobadas) y dos sondas de `fetch` en Node v24.22.3 que muestran que el mensaje, la causa y `util.inspect` del error no contienen el token.

### Secondary (MEDIUM confidence)
- `npm view grammy version` (1.48.0): solo como alternativa descartada; el nombre no salió de documentación oficial.

### Tertiary (LOW confidence)
- Comportamiento no documentado del servidor de Telegram (A1 a A4), agrupado en el Assumptions Log y con mitigaciones que no dependen de ellos.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Sin dependencias nuevas; todo lo reutilizado está leído en el código y en `package.json`.
- Architecture: HIGH. El encaje con el lock, el dispatcher, el cooldown y la salud se apoya en código leído; el único punto sin precedente es el carril de updates, y se acotó con las restricciones de la fase 4.
- Pitfalls: MEDIUM-HIGH. Los de código están verificados; los de comportamiento del servidor de Telegram (A1 a A3) son inferencias con mitigación.

**Research date:** 2026-11-26
**Valid until:** 2026-12-26 (la Bot API cambia con frecuencia, y esta versión ya incluye `callback_query_mode`; revisar `getUpdates` y `CallbackQuery` si el plan se retrasa más de un mes)
