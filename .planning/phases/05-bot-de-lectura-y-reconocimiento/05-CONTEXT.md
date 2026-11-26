# Phase 5: Bot de lectura y reconocimiento - Context

**Gathered:** 2026-11-26
**Status:** Ready for planning

<domain>
## Phase Boundary

El bot del hub deja de ser solo emisor. Los avisos de Telegram de una incidencia ganan botones de **silenciar 1 h / 24 h**, **reconocer** y **"por qué me llegó esto"**, junto al botón "Abrir en el hub" que ya existe. El worker recibe los callbacks por long polling con offset persistido. Solo atiende al operador de la allowlist y consume cada token opaco una única vez. El estado de reconocimiento y silencio persiste en PostgreSQL y aparece en Avisos y en el resumen diario. El token del bot nunca aparece en logs ni en respuestas.

Requisitos: BOT-02, BOT-04, BOT-05, BOT-06, BOT-10.

Fuera de esta fase quedan las acciones de host desde Telegram (fase 7), la puerta de verificación reciente (fase 6), los recordatorios y escaladas por falta de reconocimiento (ESCAL-01, v2) y el chatops de texto.

</domain>

<decisions>
## Implementation Decisions

### Reconocer y silenciar

- **D-01:** "Silenciar 1 h / 24 h" actúa sobre el **host y la clave**, no solo sobre el episodio. Durante el plazo no interrumpen ni la escalada del episodio actual ni una reapertura del mismo host+clave (flapping), y eso incluye el push de respaldo. Esos eventos se siguen registrando en la incidencia, en Avisos y en el resumen, y el mensaje existente se puede editar en silencio. — **Reversibility:** costly — el silencio se guarda por `(hostId, key)` con vencimiento y lo consultan la política de entrega y el despacho, no una columna del episodio.
- **D-02:** Reconocer significa "lo he visto": registra quién, cuándo y por qué canal (`telegram` o `hub`), sin silenciar nada. Si una incidencia reconocida **escala a crítica, vuelve a interrumpir** según la política de críticas de la fase 2 (D-04 y D-05 de 02-CONTEXT). Para acallarla está Silenciar.
- **D-03:** Al vencer el silencio con la incidencia aún abierta y sin cambios, **no se envía nada**. Solo un evento nuevo posterior al vencimiento, como una escalada o una reapertura, vuelve a interrumpir. Esto mantiene la regla de no reenviar mientras el estado no cambie.
- **D-04:** El resumen diario de las 08:00 lista la incidencia abierta reconocida o silenciada como cualquier otra en "abiertas ahora" y le añade la etiqueta *Reconocida* o *Silenciada hasta HH:MM* (hora de Madrid). Los contadores no cambian. Esto aplica la decisión de la fase 4 de que las preferencias actuales nunca reclasifican un episodio.
- **D-05:** El reconocimiento alimenta la métrica `ackAt` que la fase 1 dejó definida y sin medir: `median(sentAt -> ackAt)` en `01-AUDIT.md`. Hay que persistir `ackAt` para que la métrica se pueda calcular. Mostrarla no entra en esta fase.

### "Por qué me llegó esto"

- **D-06:** La explicación se envía como **respuesta en el chat** citando el aviso (`reply_parameters`) y con `disable_notification: true`. No se usa el popup de `answerCallbackQuery`. Aun así, el callback recibe su `answerCallbackQuery` para cerrar el spinner.
- **D-07:** El contenido incluye la **regla, el dato leído y el canal**. Ejemplo orientativo: "Temperatura > 70 °C en nas-home (leído 74 °C). Crítica: aviso inmediato por Telegram. Silenciar evita repeticiones." Se genera en el servidor a partir de la incidencia, la política y el registro de entrega, sin datos que viajen en el callback.
- **D-08:** Explica el **estado actual** del mensaje. Si el aviso se editó por una escalada o un cierre, la explicación lo refleja.
- **D-09:** Se envía **una respuesta por estado del aviso**. Una nueva pulsación solo genera otra respuesta si el aviso cambió desde la anterior (escalada o cierre). Si no cambió, recibe un toast "ya respondido" y no se envía otro mensaje. Un callback repetido por Telegram tampoco duplica la respuesta (BOT-06).
- **D-10:** Tras resolverse la incidencia, Silenciar y Reconocer desaparecen del mensaje. "Por qué me llegó esto" y "Abrir en el hub" siguen disponibles en modo de solo lectura.

### Chat, allowlist y hub

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y requisitos
- `.planning/ROADMAP.md` §Phase 5 — Objetivo, cinco criterios de éxito y los tres planes previstos (05-01 polling + allowlist, 05-02 tokens + ack/snooze + "por qué", 05-03 contrato del `Update` + redacción + replays).
- `.planning/REQUIREMENTS.md` — BOT-02, BOT-04, BOT-05, BOT-06, BOT-10, y la tabla Out of Scope (chatops de texto, reenvíos sin cambio de estado).
- `.planning/PROJECT.md` — Un solo `app` y un solo `worker`, idioma español, multi-repo.

### Diseño previo del bot
- `.planning/research/ARCHITECTURE.md` — Tokens opacos (`telegram_action_tokens`, `v1:<id>`, consumo con `UPDATE … WHERE used_at IS NULL RETURNING`), allowlist, deduplicación por `update_id`, `answerCallbackQuery` y la matriz de amenazas. **Ojo:** el documento describe un webhook. La fase 2 lo sustituyó por **long polling en el worker** (STATE.md). La lógica de `handleUpdate` vale igual, pero el transporte cambia.
- `.planning/STATE.md` §Decisions — Long polling en el worker, un canal primario por incidencia, `TELEGRAM_DIRECT_ACTIONS=0`.

### Decisiones heredadas
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` — Mapa de claves inmediato/resumen/silencioso que explica "por qué me llegó", y el contrato de la métrica `ackAt`.
- `.planning/phases/02-incidencias-y-entrega-nica/02-CONTEXT.md` — D-01 a D-06: entrega incierta sin reenvío, escalada a crítica y edición del mismo mensaje.
- `.planning/phases/04-resumen-diario/04-VERIFICATION.md` y `.planning/phases/04-resumen-diario/04-03-SUMMARY.md` — El contenido del resumen, la proyección global y el healthcheck del worker.
- `CODING_STANDARD.md` — Los tests no dependen del copy. Consultarlo antes de tocar texto visible.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/telegram.ts` — Cliente saliente con origen fijo, sin redirecciones, timeout de 10 s, resultados finitos (`sent`/`retry`/`rejected`/`uncertain`) y truncado a 4096. Hay que añadir `getUpdates`, `answerCallbackQuery`, `deleteWebhook` y el envío de respuestas. `buttons()` hoy solo crea "Abrir en el hub".
- `src/lib/notification-policy.ts` — `notificationPolicy(key, severity)` y el catálogo auditado de claves. Es la fuente de la regla para "por qué me llegó" y el punto donde aplicar el silencio por host+clave.
- `src/lib/notification-dispatch.ts` y la tabla `notification_outbox` — Outbox transaccional con `incident-open`/`incident-edit`/`incident-push`. Las ediciones silenciosas del mensaje tras ack/snooze deben pasar por aquí.
- `src/lib/incident-store.ts` y `incident_events` (`src/lib/schema.ts`) — Episodios con `seq` y línea temporal inmutable. Reconocer, silenciar y quitar silencio son eventos de la línea temporal.
- `src/lib/digest-content.ts` — Contenido del resumen, donde se añaden las etiquetas de D-04.
- `src/components/views/alerts.tsx` — Vista Avisos, donde van el estado y las acciones de D-14.
- `src/lib/runtime-config.ts` — Valida `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` como pareja y rechaza los valores de ejemplo.
- `src/lib/worker-loop.ts` y `src/lib/worker-health.ts` — Bucle dueño del lock y marca de progreso. El polling no debe congelar la marca ni duplicar consumidores.

### Established Patterns
- Un solo worker con lock de recolección. Solo el dueño envía (INCD-06), y lo mismo debe valer para consumir updates.
- Una entrega incierta nunca se reenvía. Las ediciones no notifican.
- `telegram_cooldown` es la pausa durable compartida ante un 429. Las llamadas nuevas a la Bot API deben respetarla.
- Tests de comportamiento, nunca de copy (`CODING_STANDARD.md`).

### Integration Points
- Ruta API del hub (`src/app/api/[...path]/route.ts`) para las acciones de Avisos (reconocer, silenciar, quitar silencio).
- Migración Drizzle (`drizzle/`) para el estado de ack, el silencio por host+clave, los tokens, el offset y los `update_id` vistos.

</code_context>

<specifics>
## Specific Ideas

- La respuesta "por qué" debe leerse como una explicación de una o dos frases: la regla con su umbral, el valor leído, la severidad con su canal, y una pista de que Silenciar evita repeticiones.
- El aviso editado debe dejar claro su estado sin abrir el hub ("Reconocida 10:32", "Silenciada hasta 11:32").

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. Las ideas cercanas ya figuran en v2 (ESCAL-01 recordatorios, PUSH-01 reconocer desde el push) o en la fase 7 (acciones de host).

</deferred>

---

*Phase: 05-bot-de-lectura-y-reconocimiento*
*Context gathered: 2026-11-26*
