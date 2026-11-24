# Feature Research

**Domain:** Notificaciones operativas e interactivas para un dashboard de homelab de un solo operador (hub. + Telegram)
**Researched:** 2026-11-24
**Confidence:** MEDIUM — el paisaje de features se apoya en el código leído y en las decisiones ya tomadas; el volumen real de mensajes no se ha medido todavía, así que el corte v1 vs. después debe refinarse con la auditoría.

## Punto de partida (evidencia del repo)

| Hecho | Archivo | Consecuencia para el diseño |
|---|---|---|
| Cada resolución de una incidencia envía un push "Recuperado: …" | `src/lib/collector.ts:53` | Es la mitad del volumen: cada incidencia produce al menos dos mensajes. |
| Cada `expectedContainers` que no corre genera su propia alerta y su propio push | `src/lib/collector.ts:209` | Una caída del host con 10 contenedores = 10 incidencias y 10 mensajes. |
| `notify(title, body, tag)` no conoce severidad, categoría ni id de incidencia | `src/lib/push.ts:6` | No hay política de entrega posible por debajo; el `tag` es lo único que agrupa. |
| El push siempre abre `/?view=alerts`; el service worker ignora `data.url` | `src/lib/push.ts:19`, `public/sw.js` | No existe deep link a la vista concreta, ni acciones en la notificación. |
| La tabla `alerts` solo identifica por `(hostId, key)`; sin ack, sin mute, sin severidad mutable | `src/lib/schema.ts:134` | Faltan las columnas/estados que sostienen dedup, ack y explicación. |
| La severidad se fija al insertar y nunca se actualiza | `.planning/codebase/CONCERNS.md:263` | Un disco que pasa de `watch` a `fail` sigue avisando como warning. |
| Ya existen tres emisores de Telegram independientes en media-stack: `upgrade.sh`, `media-backup.sh` y `security-monitor`, más el trigger de WUD | `media-stack/scripts/upgrade.sh:42`, `media-stack/stacks/backup/media-backup.sh:138`, `media-stack/stacks/monitoring/security-monitor/main.py:168`, `media-stack/stacks/monitoring/compose.yaml:92` | No hay una política única: cada emisor decide su formato, su frecuencia y su dedup. |
| Verificación reciente de 5 min ya existe, pero solo protege `reboot`, `containers/remove`, deployments settings y merge de Renovate | `src/lib/verification.ts:5`, `src/app/api/[...path]/route.ts:438`, `src/lib/lifecycle.ts:116` | `start`/`stop`/`restart`/`update-container` no la exigen; cualquier botón inline debe arreglar eso antes de existir. |
| `operations` ya es idempotente por `idempotency-key` y ya se lista en la vista de avisos | `src/app/api/[...path]/route.ts:425`, `src/components/views/alerts.tsx:36` | Hay base para auditoría de acciones, pero no para auditoría de notificaciones. |

**Lectura:** el ruido no viene de una sola decisión, viene de cuatro: recuperación por evento, alerta por contenedor, tres emisores en paralelo y ausencia de política por severidad. Cualquier feature que no ataque una de esas cuatro no reduce el ruido.

## Decisión de arquitectura que condiciona el resto

Un solo dueño del envío. Hoy el hub tiene push y media-stack tiene Telegram, con políticas separadas; eso es exactamente el anti-feature "dos notificadores". La propuesta:

- El **hub** es el único que decide y envía (push y Telegram). El bot de Telegram vive en el `worker` (una réplica, ya hay advisory lock) y usa **long polling** contra la Bot API: no hace falta exponer un webhook público, lo que encaja con un hub detrás de Tailscale.
- media-stack deja de enviar: sus scripts (`upgrade.sh`, `media-backup.sh`, `security-monitor`, WUD) publican un evento a un endpoint interno del hub (`POST /api/notifications/ingest`) firmado con un secreto compartido, o escriben en el snapshot que el hub ya lee. Preferible lo primero: el evento llega con `key`, `severity`, `host` y `dedupKey`, y el hub aplica la misma política que al resto.
- Esto no viola el constraint multi-repo: media-stack conserva sus commits y su CI; solo cambia el destino de su emisión.
- Consecuencia: el primer release no puede ser "features del bot" sin resolver antes el router. El botón inline es la última capa, no la primera.

## Feature Landscape

### Table Stakes (Users Expect These)

Sin estas, el sistema sigue siendo ruidoso o directamente está roto. No dan crédito, pero su ausencia se penaliza.

| ID | Feature | Why expected | Complexity | Dependencies | Notes |
|---|---|---|---|---|---|
| TS-1 | Una notificación por incidencia (máquina de estados `open → acknowledged → resolved`) | Es la queja literal: hoy una incidencia abierta puede producir mensaje inicial, mensaje de recuperación y reapertura al siguiente ciclo | MEDIUM | TS-2, TS-3 | El estado vive en `alerts` (nuevas columnas `acknowledgedAt`, `acknowledgedBy`, `mutedUntil`, `closedAt`) y no en memoria del worker. |
| TS-2 | Identidad de incidencia y dedup (`incidentId` estable + `dedupKey` + cooldown de reapertura) | Sin identidad no se puede silenciar, ackear ni explicar; el `tag` de push solo deduplica visualmente en el dispositivo | LOW | — | `incidentId` determinista por `(hostId, key, occurrence)`. Cooldown de 10 min contra flapping: un host que oscila no debe generar un par recuperación/reapertura por ciclo. |
| TS-3 | Severidad con efecto real (`critical`, `warning`, `info`) | Hoy solo existe en el insert y no cambia la entrega; sin tiers no hay forma de decidir qué interrumpe | LOW | TS-2 | La severidad se recalcula en cada evaluación (arregla `CONCERNS.md:263`) y la política de entrega se deriva de ella, no del copy. |
| TS-4 | Deep link a la vista correcta (`/?view=…&host=…&incident=…`) | El mensaje debe llevar al sitio donde se resuelve, no a una lista genérica | LOW | TS-2 | `routeHref()` ya soporta `view`/`tab`/`host`; falta un ancla por incidencia y que el service worker respete `data.url`. |
| TS-5 | Ack / mute / snooze con estado persistido | Sin esto, "no volver a avisar" se implementa apagando el canal, que es peor | MEDIUM | TS-1, TS-12 | Ack ≠ resolve: ack silencia pero la incidencia sigue abierta y visible en el hub. Mute 1 h / 24 h / hasta que cambie el estado. |
| TS-6 | "¿Por qué he recibido esto?" (regla, valor, primera vez, canal) | Un aviso sin contexto se percibe como ruido aunque sea correcto; es la diferencia entre confiar y silenciar todo | LOW | TS-1, TS-3 | Dos líneas al pie: `host · key · valor actual vs umbral · abierta desde · canal`. Reutiliza `detail` y añade metadatos estructurados, no prosa generada. |
| TS-7 | Opt-out por categoría (`connection`, `backup`, `disks`, `containers`, `deployments`, `thresholds`, `security`, `renovate`) | El operador quiere decidir qué le interrumpe; hoy solo puede desactivar todo el push | LOW | TS-3 | Persistido en `configuration` (ya existe por host). El opt-out es por categoría y por severidad mínima, no por texto libre. |
| TS-8 | Un solo canal por evento, sin duplicado push + Telegram | Recibir lo mismo dos veces es el ruido más visible y el más fácil de arreglar | MEDIUM | TS-9 | El hub decide un canal primario por evento: `critical` → Telegram, `warning` → push, `info` → digest. "Ambos" solo como opción explícita, con un único `deliveryId` y ack compartido (ackear en un canal descarta el otro). |
| TS-9 | Router único de entrega con adaptadores (`push`, `telegram`, `digest`) | Es la pieza que hace posible TS-8 y D-3; sin ella cada feature inventa su `notify()` | MEDIUM | TS-2, TS-3 | `dispatch(incident, event)` con una tabla de política; los adaptadores solo transportan. Reemplaza las llamadas directas a `notify()` de `collector.ts` y `route.ts:654`. |
| TS-10 | Estado de entrega visible y sin pérdida silenciosa (sent / failed / suppressed + motivo) | Si Telegram falla o el mensaje se suprime, el operador debe poder verlo; "no me llegó" no puede ser indistinguible de "no pasó" | MEDIUM | TS-9 | Tabla `notification_events` (incidentId, channel, status, reason, at). La vista de avisos muestra el último estado por incidencia. |
| TS-11 | Notificación de prueba que atraviesa el pipeline real | Un botón que llama a `notify()` directamente no prueba nada y da falsa confianza | LOW | TS-9 | `POST /api/notifications/test` genera una incidencia sintética `test`, recorre política, dedup, render y ambos canales, y se marca como test en el historial. |
| TS-12 | Autorización del operador para todo lo que llega de Telegram | El bot ejecuta acciones sobre dos servidores; el chat id no es un secreto y un bot puede añadirse a grupos | LOW | — | `TELEGRAM_OPERATOR_CHAT_ID` + `TELEGRAM_OPERATOR_USER_ID`; rechazar cualquier `callback_query.from.id` distinto, chats desconocidos y mensajes reenviados. Ver sección de seguridad. |

### Differentiators (Competitive Advantage)

No son obligatorias, pero separan este hub de "un script que manda mensajes". Ordenadas por valor real para un solo operador.

| ID | Feature | Value Proposition | Complexity | Dependencies | Notes |
|---|---|---|---|---|---|
| D-1 | Botones inline de estado, sin tocar el host ("Abrir", "Ack", "Silenciar 1 h") | Convierte el mensaje en punto de entrada sin riesgo; es el 80 % del valor del bot con el 20 % del riesgo | LOW | TS-5, TS-9 | `callback_data` ≤ 64 bytes: llevar un id opaco, nunca el nombre del contenedor ni una ruta. |
| D-2 | Botones inline con acciones (`start`, `stop`, `restart`, `update-container`, reintentar deploy, merge Renovate) | El usuario quiere resolver desde el móvil, no solo enterarse (PROJECT.md) | HIGH | D-1, D-9, TS-12, verificación reciente | Ninguna acción destructiva se ejecuta desde el callback: el botón abre el hub con un token de acción y allí se exige passkey. Ver matriz de seguridad. |
| D-3 | Resumen diario con tabla de lo no urgente | Evita interrumpir por lo informativo sin perderlo; es la otra mitad de la decisión ya tomada | MEDIUM | TS-9, TS-1 | Una sola tabla (máx. 10 filas + "+N"), a las 08:00 Europe/Madrid, solo si hay contenido. Botón "Ver todo". No reenvía ni se edita. |
| D-4 | Timeline de incidencia en el hub | Explica qué pasó, cuándo se ackó, qué se hizo y quién; convierte el historial en depuración | MEDIUM | TS-1, TS-10 | Append-only sobre `notification_events` + `operations`, renderizado en `alerts.tsx`. Sin tabla nueva si se reutilizan eventos. |
| D-5 | Quiet hours | Un homelab no debería despertar a las 03:00 por un `reboot-pending` | LOW | TS-3, TS-9 | Ventana configurable (por defecto 23:00–08:00). `critical` sí pasa; `warning`/`info` se acumulan para el digest. |
| D-6 | Escalado si no hay ack | Un `backup-failed` sin leer durante 2 h es un problema distinto | MEDIUM | TS-5 | Máximo dos nudges (15 min y 60 min), editando el mismo mensaje + un ping corto; nunca reenviar el contenido completo. Se pausa en quiet hours salvo `critical`. |
| D-7 | Enrutado por host | Separa NAS de apps-server en el móvil y en Telegram (topic/thread distinto) sin mirar el texto | MEDIUM | TS-9 | `message_thread_id` en foros de Telegram o `tag` distinto en push; requiere configuración, no código nuevo de política. |
| D-8 | Undo para acciones reversibles | `stop`/`restart` desde el móvil con 60 s de arrepentimiento reduce el miedo a tocar botones | MEDIUM | D-2, D-4 | Solo para acciones con inversa segura (`start`↔`stop`, `restart` no); una sola vez, con la misma idempotencia. Destructivas no tienen undo: por eso exigen confirmación. |
| D-9 | Agrupación de alertas correlacionadas (una incidencia por host caído, no N contenedores) | El mayor reductor de volumen en un host con 15 contenedores | MEDIUM | TS-1, TS-2 | Inhibición: si `connection` está abierta, se suprimen `container:*`, `stack-unit-failed` y `deploy-failed` de ese host. Si 2+ contenedores caen en 5 min sin caída de host, una sola incidencia "Servicios caídos en X" con lista. |
| D-10 | Ack desde la notificación push | Cierra el bucle sin abrir la app | HIGH | TS-5 | `showNotification({ actions })` no está soportado igual en iOS/Safari; necesita fallback al deep link y un endpoint con token de un solo uso. |
| D-11 | Presupuesto de supresión (rate cap por hora/día) | Evita que un bug de agrupación vuelva a inundar; es el seguro del sistema | LOW | TS-9, TS-10 | Contador por canal y por hora; al superarlo, se agrupa en un solo mensaje "N avisos suprimidos" y se registra el motivo. |
| D-12 | Puente de verificación reciente (Telegram → passkey en el hub) | Permite acciones destructivas desde el móvil sin inventar autenticación en el chat | MEDIUM | TS-4, `src/lib/verification.ts` | Un solo uso, TTL 5 min, ligado a `(userId, incidentId, action, target)`. Es el habilitador de D-2 y la alternativa correcta a "escribe el código". |

### Anti-Features (Commonly Requested, Often Problematic)

| Anti-feature | Why requested | Why problematic | Alternative |
|---|---|---|---|
| Chatops de texto libre (`/restart plex`, "reinicia el nas") | Parece cómodo y demo-friendly | Superficie de inyección, ambigüedad de intención, sin confirmación, sin auditoría fiable, y el parser se convierte en un segundo lenguaje de acciones que hay que mantener y testear | Botones inline con token opaco + confirmación en el hub. Cero comandos de texto; el bot solo acepta `/start` y `/ayuda`. |
| Una alerta por contenedor de `expectedContainers` | Es lo que ya hace el código y es fácil | Multiplica por N el volumen y fragmenta una sola causa (host caído, Docker caído) en N incidencias | D-9: una incidencia por host, con los contenedores como hijos. `container:<name>` silencioso salvo contenedor marcado crítico. |
| Mensaje de recuperación para cada incidencia | Cierra el bucle psicológicamente | Duplica los mensajes y no aporta acción; con flapping genera un bucle recuperación/reapertura | Editar el mensaje original a "resuelta" y cerrar la incidencia; sin mensaje nuevo. El digest diario puede contar recuperaciones. |
| Reenviar mientras el estado no cambia ("por si acaso") | Miedo a que se pierda el aviso | Es el ruido que el usuario denuncia; los reenvíos no arreglan un canal roto, lo esconden | TS-10: estado de entrega visible + un único nudge de escalado (D-6) si es crítico. |
| Empujar cada línea de log o cada evento de contenedor | Sensación de control total | Volumen no accionable, coste en Telegram, y entierra lo importante | Logs bajo demanda en la vista de contenedor (`container-logs.tsx`); al canal solo el cambio de estado. |
| Botones de acción destructiva sin confirmación | Menos taps | Un toque accidental en el móvil puede parar un servicio o reiniciar el host; el callback se puede repetir | D-2 + D-12: dos pasos, verificación reciente, confirmación con verbo y objetivo explícitos, idempotencia. |
| Dos notificadores independientes (push del hub + Telegram de media-stack) con políticas separadas | Cada repo ya tenía lo suyo y es el camino de menor resistencia | Duplica avisos, las políticas divergen, no hay un único sitio donde silenciar ni auditar | TS-9: el hub es el único emisor; media-stack publica eventos firmados. |
| Email como tercer canal | "Por si Telegram falla" | Tercera política, tercer formato, tercer sitio donde mirar; ya está en Out of Scope de PROJECT.md | Estado de entrega visible + test end-to-end + fallback push. Si Telegram falla, se ve en el hub. |
| Topic/canal de Telegram por categoría | Organización aparente | Multiplica los sitios donde mirar y rompe la regla de "una incidencia, un mensaje"; el operador acaba silenciando topics enteros | Un solo chat, digest + severidad como únicos ejes. D-7 como mucho separa por host. |
| Adjuntar el journal o el stack trace completo al mensaje | "Así lo veo sin abrir nada" | Supera el límite de 4096 caracteres, filtra rutas y secretos, y nadie lo lee en el móvil | Primeras 2 líneas + botón "Ver detalle" al hub. |
| Prioridad máxima para todo | Miedo a perderse algo | Si todo es crítico, nada lo es; entrena al operador a ignorar | TS-3 con tres niveles y política explícita por clave (ver mapa). |

## Feature Dependencies

```
[TRANSPORTE Y ESTADO]
TS-2 Identidad + dedup  (fundamento: no depende de nada)
    ├──> TS-1 Una notificación por incidencia
    │       └──> TS-5 Ack / mute / snooze
    ├──> TS-3 Severidad con efecto
    │       └──> TS-7 Opt-out por categoría
    └──> TS-9 Router único
TS-9 ──requires──> TS-2, TS-3
    ├──> TS-8 Un canal por evento
    ├──> TS-10 Estado de entrega
    ├──> TS-11 Test end-to-end
    ├──> D-3 Resumen diario
    ├──> D-5 Quiet hours
    ├──> D-7 Enrutado por host
    └──> D-11 Presupuesto de supresión

[LECTURA]
TS-4 Deep link ──requires──> TS-2
TS-6 "Por qué me llegó" ──requires──> TS-1, TS-3
D-1 Botones inline de estado ──requires──> TS-4, TS-5, TS-9
D-4 Timeline ──requires──> TS-1, TS-10

[ACCIÓN]
TS-12 Autorización del operador ──requires──> nada (env + allowlist)
D-12 Puente de verificación ──requires──> TS-4, verificación reciente existente
D-2 Acciones inline ──requires──> D-1, D-12, TS-12, TS-10
D-8 Undo ──requires──> D-2, D-4
D-10 Ack desde push ──requires──> TS-5, TS-10

[VOLUMEN]
D-9 Agrupación ──requires──> TS-1, TS-2
D-6 Escalado ──requires──> TS-5
D-5 ──conflicts──> D-6   (quiet hours retrasa el nudge; solo critical se salta la ventana)
D-9 ──enhances──> TS-3   (permite subir severidad del padre y bajar la de los hijos)
D-2 ──conflicts──> anti-feature "chatops de texto libre"
TS-9 ──conflicts──> anti-feature "dos notificadores"
```

### Dependency Notes

- **TS-9 requiere TS-2:** sin identidad estable, el router no puede deduplicar ni decidir si un evento es "el mismo incidente otra vez"; el `tag` actual solo agrupa visualmente.
- **TS-5 requiere TS-1:** el estado `acknowledged` es lo que permite que una incidencia abierta deje de notificar sin cerrarse; sin el modelo de incidencia, "una notificación por incidencia" y "sigue visible en el hub" no se pueden sostener a la vez.
- **D-2 requiere D-12 y TS-12:** la acción más simple (`restart`) no debe ejecutarse desde un callback; sin puente de verificación, el botón o es inseguro o no existe. Esto también obliga a extender `guardSensitiveAction` a `start`/`stop`/`restart`/`update-container` en `route.ts` (hoy solo `reboot` lo exige).
- **D-3 requiere TS-9:** el digest no puede ser otro `notify()`; necesita la misma cola y el mismo registro para no duplicar lo que ya se entregó al momento.
- **D-9 requiere TS-2:** agrupar exige saber que `container:plex` y `container:sonarr` pertenecen a la misma causa; la inhibición por `connection` es la regla más barata y la de mayor impacto.
- **D-5 choca con D-6:** un escalado a las 03:00 contradice quiet hours. Resolución: la ventana silencia `warning`/`info` y pausa el timer de escalado; `critical` escala igual.
- **D-2 choca con chatops:** si se acepta texto libre, la matriz de autorización deja de ser verificable y el 64-byte `callback_data` deja de ser el contrato de acción.

## El problema del ruido, feature por feature

| Fuente de ruido (hoy) | Feature que la corrige | Efecto esperado |
|---|---|---|
| Mensaje de recuperación en cada resolución (`collector.ts:53`) | TS-1 + anti-feature "recovery messages" | Se pasa de ~2 mensajes por incidencia a 1. |
| N contenedores = N incidencias y N pushes (`collector.ts:209`) | D-9 agrupación + `container:<name>` silencioso | Una caída de host con 10 contenedores pasa de 10 mensajes a 1. |
| Push y Telegram con políticas separadas (hub + 3 emisores en media-stack) | TS-9 router único + TS-8 un canal por evento | Cero duplicados entre canales; un solo sitio donde silenciar. |
| Todo llega al momento, incluido `reboot-pending` | TS-3 + D-3 digest + mapa de claves | Los no urgentes bajan a 1 mensaje al día. |
| Flapping: resolver y reabrir cada minuto | TS-2 cooldown de reapertura | Un host que oscila no genera un par de mensajes por ciclo. |
| Avisos sin contexto que se ignoran o se silencian enteros | TS-6 "por qué me llegó" + TS-7 opt-out por categoría | Menos silenciamientos totales; el operador afina en vez de apagar. |

**Métrica de éxito propuesta para la auditoría:** ≤ 3 mensajes proactivos al día fuera del digest, 0 mensajes de recuperación, 0 duplicados push/Telegram en 7 días, y mediana de tiempo hasta ack < 15 min en `critical`. Sin la línea base de la auditoría, estas cifras son un objetivo, no un hecho.

## Seguridad de las acciones inline

Base común a todas: el bot solo responde al `chat_id` y `user_id` del operador; `callback_data` es un id opaco (≤ 64 bytes) que el servidor resuelve a `(incidentId, action, target, nonce, exp)`; el token va firmado con HMAC y ligado a `(chatId, messageId, userId)`; el callback se responde en < 10 s con `answerCallbackQuery`.

| Acción | Riesgo | Autorización | Verificación reciente | Idempotencia | Auditoría |
|---|---|---|---|---|---|
| Abrir vista / detalle | Ninguno (solo lectura) | Allowlist de chat y usuario | No | N/A (no muta) | No requiere |
| Ack | Bajo: silencia una incidencia real | Allowlist | No | `incidentId` + `ack` único; repetir es no-op | `notification_events` (`ack`, userId, at) |
| Silenciar 1 h / 24 h | Bajo: puede ocultar un fallo | Allowlist + rate limit | No | `(incidentId, until)`; extender actualiza, no duplica | `notification_events` (`mute`, until) + visible en la incidencia |
| Descartar / resolver a mano | Medio: cierra sin que la causa desaparezca | Allowlist | No, pero pide confirmación explícita | `(incidentId, dismiss)` único | `operations` o `notification_events` con motivo |
| Reiniciar contenedor | Medio: corta servicio en uso | Allowlist + host permitido | Sí (passkey en el hub) | `operations.id` derivado del token; replay devuelve el resultado previo | Fila en `operations` + evento `action` |
| Detener contenedor | Alto: deja el servicio caído | Allowlist + host permitido | Sí | Igual; el token es de un solo uso | `operations` (`stop`, target, userId) |
| Iniciar contenedor | Bajo | Allowlist | No (reversible) | Igual | `operations` |
| Actualizar imagen | Alto: cambio de versión no verificada | Allowlist | Sí | Igual; no reintento automático | `operations` + release resultante |
| Reintentar deploy / rollback | Alto: puede mover la release activa | Allowlist | Sí | Igual | `operations` + estado del deploy |
| Merge de Renovate | Alto: cambia producción | Allowlist + repo permitido | Sí (`renovate-merge.ts` ya lo exige) | Igual | `operations` + PR mergeado |
| Reiniciar host | Crítico: corta todo | Allowlist | Sí (ya exigido en `route.ts:438`) | Igual | `operations` + `bootAt` |

Reglas que no se negocian:

- **Nunca ejecutar en el callback.** El callback solo responde con un deep link de acción (`/?view=…&action=…&token=…`); la ejecución ocurre en el hub, con sesión y passkey. Así el bot no necesita ni guarda credenciales.
- **Nunca pedir un código por el chat.** Es texto libre disfrazado y entrena al operador a escribir secretos en Telegram.
- **Token de un solo uso con TTL** (5 min para destructivas, 24 h para solo lectura) y `usedAt`; replayed callback = respuesta idempotente, no segunda ejecución.
- **Destructivas: confirmación con verbo y objetivo** ("Detener `plex` en nas-home"), no "¿Seguro?".
- **Auditoría en dos capas:** `operations` (efecto) y `notification_events` (decisión y mensaje). La vista de avisos ya lista operaciones; solo hay que añadir el origen `telegram`.
- **Secretos fuera del mensaje y del log:** el token del bot y el HMAC viven en env; no se loguea `callback_data` crudo.

## Mapa de claves de alerta → política de entrega

Claves reales del código (`collector.ts`, `maintenance-alerts.ts`) más las de media-stack. `connection` no estaba en la lista del encargo pero es la que gobierna la inhibición.

| Clave | Severidad actual | Política propuesta | Categoría | Notas |
|---|---|---|---|---|
| `connection` | critical | **Inmediato**, con debounce de 60 s y cooldown de reapertura | `connection` | Padre de la agrupación: mientras esté abierta, inhibe `container:*`, `stack-unit-failed` y `deploy-failed` del mismo host. |
| `backup-failed` | critical | **Inmediato**, una vez | `backup` | El evento de media-stack entra por el ingest, no por un sendMessage propio. |
| `disk-health` (`fail`) | critical | **Inmediato** | `disks` | Escalar severidad si ya estaba abierta como `watch` (arregla `CONCERNS.md:263`). |
| `disk-health` (`watch`) | warning | **Digest** | `disks` | Un disco "a vigilar" no justifica interrumpir. |
| `reboot-pending` | warning | **Digest** | `maintenance` | Puede durar semanas; notificarlo al momento es ruido puro. |
| `stack-unit-failed` | critical | **Inmediato** | `containers` | Si el host no responde, se inhibe y queda dentro de `connection`. |
| `release-retained` | warning | **Digest** | `deployments` | Informativo: hay una release retenida, no un fallo. |
| `deploy-failed` | critical | **Inmediato** | `deployments` | Incluye `rolled-back`; el mensaje debe decir qué release quedó activa. |
| `cpu`, `memory` | warning | **Digest** (resumen "umbrales superados"), inmediato solo si se mantiene > 15 min | `thresholds` | Con `sustainedSeconds` ya hay histéresis; el digest evita el aviso de las 02:00. |
| `disk` (ocupación) | warning | **Digest**, inmediato a partir del 95 % | `thresholds` | La escalada por porcentaje es más útil que la severidad fija. |
| `temperature` | critical | **Inmediato** | `thresholds` | Riesgo físico; no admite digest. |
| `container:<name>` | warning | **Silencioso por defecto**; entra en la incidencia agrupada `services-down:<host>` | `containers` | Excepción: contenedores marcados `critical` en settings (lista corta) sí generan incidencia propia inmediata. |
| `expectedContainers` | (no es alerta, es fuente) | **Silencioso**; la deriva se muestra como sugerencia en el hub, nunca como aviso | `containers` | Arregla el bucle de `CONCERNS.md:51`: un contenedor renombrado deja de avisar para siempre. |
| `security-monitor` (media-stack) | none (texto) | **Inmediato** si hay actualización verificada; si no, silencio | `security` | Hoy ya no avisa sin hallazgos (`main.py:261`); conservar esa regla al migrar al ingest. |
| WUD / actualizaciones de imagen | none | **Digest** | `renovate` | `major-only` ya está configurado; el digest lo hace visible sin interrumpir. |
| Merge de Renovate / operaciones | — | **Digest** | `renovate` | El resultado de una acción se edita en el mensaje que la originó, no se reenvía. |

Regla transversal: el digest nunca repite una incidencia `critical` ya entregada al momento; cuenta las suprimidas y las resueltas.

## MVP Definition

### Launch With (v1) — el corte que ataca el ruido

Seis entregables; sin ellos el sistema sigue siendo el de hoy.

- [ ] **TS-2 + TS-1 — identidad y una notificación por incidencia**, con cooldown de reapertura y sin mensaje de recuperación (se edita el mensaje a "resuelta"). Es la corrección literal de la queja.
- [ ] **TS-9 + TS-8 — router único y un canal por evento**, con Telegram como adaptador del hub y media-stack publicando eventos firmados. Elimina duplicados y unifica la política.
- [ ] **D-9 — agrupación por host** (inhibición por `connection` + `services-down` para 2+ contenedores). Es el mayor reductor de volumen en el caso real.
- [ ] **TS-3 — severidad con efecto** y **TS-7 — opt-out por categoría**, con `container:<name>` silencioso por defecto.
- [ ] **D-3 — resumen diario** con tabla, porque al mover warning/info al digest esos avisos necesitan un destino.
- [ ] **TS-4 + TS-6 — deep link y "por qué me llegó"**: barato, y convierte cada mensaje restante en accionable y comprensible.

### Add After Validation (v1.x)

- [ ] **TS-5, D-1 y TS-10** — ack/mute/snooze, botones de solo lectura y estado de entrega visible. Trigger: la auditoría confirma que quedan < 5 mensajes/día y se quiere dejar de mirar el móvil.
- [ ] **D-5 quiet hours** — LOW y muy visible para un solo operador; trigger: primer aviso nocturno tras v1.
- [ ] **TS-11 test end-to-end y D-4 timeline** — confianza y depuración; trigger: primer "no me llegó".
- [ ] **TS-12 y D-12** — autorización explícita del operador y puente de verificación; son el prerequisite de cualquier acción inline, así que pueden adelantarse si el bot se planifica ya.

### Future Consideration (v2+)

- [ ] **D-2 acciones inline, D-8 undo** — solo después de que TS-12, D-12 y la verificación en todas las rutas destructivas estén hechos y testeados.
- [ ] **D-6 escalado y D-11 presupuesto de supresión** — cuando haya historial de ack real que calibrar.
- [ ] **D-7 enrutado por host** — solo si el volumen por host lo justifica; con dos hosts es cosmético.
- [ ] **D-10 ack desde push** — depende de soporte de `actions` en iOS; hasta entonces, deep link.

### Lo que la auditoría debe decidir

La auditoría no valida features: mide y ajusta el corte. Debe producir:

1. Mensajes/día por emisor (`upgrade.sh`, `media-backup.sh`, `security-monitor`, WUD, hub) y por clave.
2. Proporción recuperación : incidencia (esperado ~1:1 hoy; objetivo 0).
3. Nº de incidencias `container:*` simultáneas por caída de host (dimensiona D-9).
4. Duplicados push + Telegram por evento y latencia entre ambos.
5. Distribución horaria (decide la ventana de quiet hours y la hora del digest).
6. Top 3 claves por volumen (decide qué es digest-only y qué se queda silencioso).
7. Tiempo hasta apertura/ack por severidad (decide si D-6 tiene sentido).

Con esos siete números, este documento se corrige en dos sitios: el mapa de claves y el corte v1.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---|---|---|---|
| TS-1 Una notificación por incidencia | HIGH | MEDIUM | P1 |
| TS-2 Identidad + dedup | HIGH | LOW | P1 |
| TS-3 Severidad con efecto | HIGH | LOW | P1 |
| TS-4 Deep link | HIGH | LOW | P1 |
| TS-6 "Por qué me llegó" | HIGH | LOW | P1 |
| TS-7 Opt-out por categoría | HIGH | LOW | P1 |
| TS-8 Un canal por evento | HIGH | MEDIUM | P1 |
| TS-9 Router único | HIGH | MEDIUM | P1 |
| D-3 Resumen diario | HIGH | MEDIUM | P1 |
| D-9 Agrupación | HIGH | MEDIUM | P1 |
| TS-5 Ack / mute / snooze | HIGH | MEDIUM | P2 |
| TS-10 Estado de entrega | MEDIUM | MEDIUM | P2 |
| TS-11 Test end-to-end | MEDIUM | LOW | P2 |
| TS-12 Autorización del operador | HIGH | LOW | P2 (P1 si hay bot) |
| D-1 Botones solo lectura | HIGH | LOW | P2 |
| D-4 Timeline | MEDIUM | MEDIUM | P2 |
| D-5 Quiet hours | MEDIUM | LOW | P2 |
| D-12 Puente de verificación | HIGH | MEDIUM | P2 (P1 si hay acciones) |
| D-2 Acciones inline | HIGH | HIGH | P3 |
| D-8 Undo | MEDIUM | MEDIUM | P3 |
| D-6 Escalado | MEDIUM | MEDIUM | P3 |
| D-11 Presupuesto de supresión | MEDIUM | LOW | P3 |
| D-7 Enrutado por host | LOW | MEDIUM | P3 |
| D-10 Ack desde push | LOW | HIGH | P3 |

## Competitor Feature Analysis

| Feature | ntfy | Grafana Alertmanager / OnCall | Uptime Kuma | Healthchecks.io | Nuestro enfoque |
|---|---|---|---|---|---|
| Agrupación | No nativa (tags) | Sí: `group_by`, `inhibit_rules` | No | No | D-9 con inhibición por `connection`, adaptada a dos hosts |
| Silencios | No | Sí (`silences`) | Mute por monitor | Pausas | TS-5 (ack/mute/snooze) por incidencia |
| Escalado | No | Sí (OnCall) | Reintentos fijos | Recordatorios | D-6, máximo dos nudges, sin reenvío íntegro |
| Acciones desde el aviso | Botones `view`/`http` | Enlaces | Enlaces | Enlaces | D-1/D-2 con verificación en el hub |
| Digest | No (delayed) | No | No | No | D-3, tabla diaria |
| Recuperación | Mensaje aparte | `resolved` | Mensaje de "up" | "up" | Editar el original; sin mensaje nuevo |
| Dedup por incidente | `tag`/`deduplication` | Fingerprint | No | `unique_id` + grace | TS-2 con `incidentId` y cooldown |

Conclusión: ninguna herramienta del mercado resuelve a la vez agrupación, digest y acciones verificadas para un solo operador; el hub tiene la ventaja de conocer el estado real (snapshots) y las operaciones idempotentes. Lo que hay que copiar es la semántica de Alertmanager (fingerprint, inhibición, silencio) y no su interfaz.

## Sources

Leídas para este documento:

- `.planning/PROJECT.md`, `.planning/codebase/CONCERNS.md` (alertas, severidad, `expectedContainers`, verificación)
- `src/lib/collector.ts`, `src/lib/maintenance-alerts.ts`, `src/lib/push.ts`, `src/lib/schema.ts`, `src/lib/verification.ts`, `src/lib/lifecycle.ts`
- `src/components/views/alerts.tsx`, `src/components/views/routes.ts`, `src/components/settings.tsx`, `public/sw.js`
- `src/app/api/[...path]/route.ts` (dispatch de acciones, `idempotency-key`, `guardSensitiveAction`)
- `media-stack`: `scripts/upgrade.sh`, `stacks/backup/media-backup.sh`, `stacks/monitoring/security-monitor/main.py`, `stacks/monitoring/compose.yaml`

Referencias externas (semántica, no copiadas):

- Telegram Bot API — límite de 64 bytes en `callback_data`, 4096 caracteres por mensaje, `answerCallbackQuery`: <https://core.telegram.org/bots/api>
- Prometheus Alertmanager — `group_by`, `inhibit_rules`, `silences`, `repeat_interval`: <https://prometheus.io/docs/alerting/latest/alertmanager/>
- ntfy — prioridades, tags y action buttons: <https://docs.ntfy.sh/>
- Uptime Kuma y Healthchecks.io — reintentos, grace periods y avisos de recuperación: <https://github.com/louislam/uptime-kuma>, <https://healthchecks.io/docs/>

---
*Feature research for: notificaciones de un dashboard de homelab de un solo operador*
*Researched: 2026-11-24*
