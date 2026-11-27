# Phase 7: Acciones verificadas desde Telegram - Context

**Gathered:** 2026-11-27
**Status:** Ready for planning

<domain>
## Phase Boundary

El operador inicia una acción de host desde un aviso de Telegram y la completa en el hub con sesión, y con passkey cuando el manifiesto de la fase 6 la protege. El callback nunca ejecuta nada: solo crea un intent de un solo uso con TTL de 5 minutos y deja en el aviso un botón url hacia el hub. Cada acción iniciada queda en `operations` con canal y solicitante, y un intent caducado, cancelado o ya consumido no ejecuta dos veces (BOT-07, BOT-08, BOT-09).

Fuera del alcance: ejecución directa desde el chat (`TELEGRAM_DIRECT_ACTIONS=0`), acciones nuevas en el agente y acciones de host para avisos que no estén en la tabla de D-01..D-04.

</domain>

<decisions>
## Implementation Decisions

### Ya fijado por el roadmap y la research (no se vuelve a discutir)
- **D-00a:** Sin ejecución en el callback: `TELEGRAM_DIRECT_ACTIONS=0`. La ejecución directa con passkey reciente que describe `ARCHITECTURE.md` no se implementa como camino activo.
- **D-00b:** Intent con token de un solo uso y TTL de 5 min, con solo el hash en la base. El token viaja en el **fragmento** de la URL del hub y la UI lo borra con `history.replaceState`. La confirmación del hub muestra el verbo y el objetivo ("Reiniciar `plex` en nas-home").
- **D-00c:** `src/lib/sensitive-actions.ts` es la autoridad de qué exige verificación reciente. El handoff no crea una segunda lista.

### Acciones por tipo de aviso
- **D-01:** Un aviso de contenedor (`container:<nombre>`) ofrece **Arrancar** (`start`) y **Reiniciar** (`restart`). Actualizar imagen, Detener y Eliminar no se ofrecen desde el chat.
- **D-02:** Avisos que no son de contenedor y llevan acción, solo con comandos que ya existen:
  - `backup-failed` → **Copia ahora** (`backup-now`)
  - `deploy-failed` → **Desplegar ahora** (`deploy-now`)
  - `reboot-pending` → **Reiniciar host** (`reboot`)
- **D-03:** `services-down` (host caído) **no ofrece ninguna acción**: con el agente sin responder, el hub no puede ejecutar nada. Conserva Reconocer, Silenciar, Por qué y Abrir en el hub. El resto de claves (`disk-health`, `release-retained`, `helper-cleanup`, `stack-unit-failed`, umbrales…) tampoco ofrece acciones en esta fase.
- **D-04:** **Toda acción iniciada en el chat pasa por el hub**, también `start`, que está exento. El hub aplica su manifiesto: exige sesión y confirmación siempre, y passkey solo para lo protegido. Así el chat y el hub nunca discrepan sobre qué está protegido.
- **D-05:** Si la incidencia se resuelve mientras hay un intent pendiente, el intent **sigue valiendo** hasta que caduque. El diálogo del hub indica que la incidencia ya está resuelta y deja confirmar.
- **D-06:** Al resolverse la incidencia, los botones de acción desaparecen del aviso, igual que Reconocer y Silenciar (D-10 de la fase 5). Un intent ya emitido se rige por D-05.

### Botones en el mensaje
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y requisitos
- `.planning/ROADMAP.md` §Phase 7: objetivo, criterios de éxito y planes 07-01..07-03.
- `.planning/REQUIREMENTS.md`: BOT-07, BOT-08 y BOT-09.

### Diseño previo del handoff
- `.planning/research/ARCHITECTURE.md`: tabla `telegramActionIntents` (~línea 289) y flujo del callback, pasos 4 a 7 (~líneas 360-372). Fragmento, `replaceState`, `url` button y motivo para no usar `answerCallbackQuery.url`. Ojo: su ejecución directa en el webhook queda **desactivada** por D-00a, y ya no hay webhook, sino long polling (fase 5).
- `.planning/research/SUMMARY.md` §4 y §"Phase 8: Acciones verificadas" (~líneas 98 y 174-180): resolución de "sin ejecución directa en v1" y entregables (`operation-runner.ts`, `guardIntentAction`, `operations.channel` y `requestedBy`).
- `.planning/research/PITFALLS.md`: pitfall 9 (callback repetido y ejecución doble) y pitfall 15 (verificación reciente de las destructivas).

### Decisiones heredadas
- `.planning/phases/05-bot-de-lectura-y-reconocimiento/05-CONTEXT.md`: allowlist (D-11), botones al resolverse (D-10), edición silenciosa y modelo de tokens.
- `.planning/phases/06-puerta-de-seguridad/06-CONTEXT.md`: frontera de lo protegido (D-01..D-05), declaración obligatoria (D-06, D-07) y límite de cuerpo.

### Normas
- `CODING_STANDARD.md`: los tests no se acoplan al copy.
- `AGENTS.md`: Next.js 16 difiere del conocido; leer `node_modules/next/dist/docs/` antes de tocar rutas o el proxy.
- `.planning/codebase/ARCHITECTURE.md` y `.planning/codebase/CONCERNS.md`: camino de mutación y huecos conocidos.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/telegram-keyboard.ts`: tokens `v1:` de 128 bits con hash SHA-256, `TELEGRAM_ACTIONS`, `keyboardActions(state)` y `parseCallbackData`. Hay que ampliarlo con «Acciones…», las acciones de host, «Volver» y «Cancelar».
- `src/lib/telegram-updates.ts`: `parseCallbackUpdate`, `isAuthorizedCallback` (allowlist) y `applyTokenAction`, que consume el token en una sola transacción con el offset. Ahí se engancha la creación del intent.
- `src/lib/telegram.ts:351`: botón url «Abrir en el hub», el precedente del botón url del handoff.
- `src/lib/sensitive-actions.ts`: manifiesto de acciones y rutas. `start` exento; `restart`, `reboot`, `deploy-now` y `backup-now` protegidos.
- `src/lib/verification-api.ts` `guardSensitiveAction`, `src/lib/verification.ts` (ventana de 5 min, métodos `passkey` y `password`).
- `src/components/sensitive-action/sensitive-action.tsx` `useSensitiveAction`: diálogo de passkey con reintento.
- `src/lib/lifecycle.ts` (`finalizeContainerOperation`, `publicOperation`) y `src/lib/host-commands.ts` (`executeHostCommand` sin guard; `runHostCommand` con guard): los ejecutores que debe llamar el intent.

### Established Patterns
- El token se consume, el efecto se aplica y el offset avanza en una sola transacción. En la base solo vive el hash (fase 5).
- Las ediciones del aviso pasan por el outbox con `disable_notification`, y nunca se envía un mensaje nuevo por un cambio de estado.
- El guard de `/api/action` se aplica tras el replay idempotente y antes del insert, y un 403 no registra operación (fase 6).
- Toda ruta mutante nueva se declara en el manifiesto de rutas, o los escaneos fallan (06-05).

### Integration Points
- `operations` (`src/lib/schema.ts:397`): hoy tiene `userId`, `action`, `target` y `status`, pero no `channel` ni solicitante. Hace falta una migración aditiva.
- `src/components/views/alerts.tsx`: vista Avisos, donde se abre el diálogo del handoff a partir del fragmento.
- El catch-all `src/app/api/[...path]/route.ts` y el manifiesto de rutas para el endpoint de ejecución.
- La limpieza horaria de `telegram-cleanup.ts` también puede barrer los intents vencidos.

</code_context>

<specifics>
## Specific Ideas

- Teclado esperado de un aviso de contenedor:
  ```
  ⚠ plex caído en nas-home
  [ Reconocer ] [ Silenciar 1 h ] [ Silenciar 24 h ]
  [ Acciones… ] [ Por qué me llegó esto ]
  [ Abrir en el hub ]
  → tras «Acciones…»:  [ Arrancar ] [ Reiniciar ]  [ Volver ]
  → tras «Reiniciar»:  [ Confirmar en el hub: Reiniciar plex ↗ ]  [ Cancelar ]
  ```
- El aviso es la única superficie del chat: ni mensajes nuevos ni enlaces muertos.

</specifics>

<deferred>
## Deferred Ideas

- Actualizar imagen, Detener y acciones para `stack-unit-failed` o `disk-health` desde el chat: fuera de esta fase.
- La ejecución directa con passkey reciente (`TELEGRAM_DIRECT_ACTIONS=1`) queda para cuando el handoff esté probado.

</deferred>

---

*Phase: 07-acciones-verificadas-desde-telegram*
