# Cobertura de API · Telegram Bot API

> Cobertura completa por defecto. Cada exclusión es una decisión razonada. Esta fase amplía la integración de la fase 2 (envío y edición) con la vía de entrada: los botones de un aviso llegan al worker por long polling. Los OPT-OUT de la fase 2 que esta fase sí necesita se vuelven a decidir aquí y no se arrastran.

La fase usa los métodos y campos de [Telegram Bot API](https://core.telegram.org/bots/api#available-methods) necesarios para recibir la pulsación de un botón, cerrarla en el cliente, explicar la regla de un aviso y reflejar el estado en el mismo mensaje. El alcance es el chat privado ya configurado y el operador de la allowlist.

| capability | decision | reason |
|---|---|---|
| getUpdates | INTEGRATE | Transporte de entrada por long polling dentro del worker que posee el lock, con `offset` persistido y `allowed_updates` fijo en cada llamada. |
| Update y CallbackQuery | INTEGRATE | Único tipo de update que el bot atiende; la forma se valida con un esquema tolerante y una allowlist doble de `from.id` y `chat.id`. |
| deleteWebhook | INTEGRATE | Se llama al arrancar el carril y sin `drop_pending_updates`, para que un webhook residual no bloquee `getUpdates` ni se pierdan pulsaciones. |
| answerCallbackQuery | INTEGRATE | Cierra el indicador de progreso del botón tras confirmar el efecto; solo con texto breve y nunca a un update no autorizado. |
| InlineKeyboardButton.callback_data | INTEGRATE | Lleva el token opaco de un solo uso (prefijo `v1:` del formato más 22 caracteres base64url, 25 bytes) de Reconocer, Silenciar 1 h, Silenciar 24 h, Quitar silencio y Por qué. |
| sendMessage (reply_parameters, disable_notification) | INTEGRATE | La explicación "por qué me llegó esto" cita el aviso y no notifica, por el outbox. |
| editMessageText con reply_markup | INTEGRATE | Cada edición vuelve a enviar el teclado completo con tokens nuevos y el estado (Reconocida, Silenciada hasta HH:MM). |
| ResponseParameters.retry_after | INTEGRATE | Un 429 de `getUpdates` o de `answerCallbackQuery` abre la misma pausa durable compartida con avisos, ediciones y resumen. |
| setWebhook | OPT-OUT | El transporte decidido en la fase 2 es long polling; el hub es privado y no expone una ruta HTTP de Telegram. |
| getWebhookInfo | OPT-OUT | El carril corrige un webhook residual con `deleteWebhook`; no hace falta diagnóstico adicional. |
| getMe | OPT-OUT | La configuración se valida localmente al arrancar y no depende de conectividad con Telegram. |
| editMessageReplyMarkup | OPT-OUT | Cada cambio de teclado acompaña a un cambio de texto, así que `editMessageText` con `reply_markup` cubre ambos. |
| answerCallbackQuery con show_alert, url o cache_time | OPT-OUT | El resultado se comunica con un aviso breve en el cliente; no se abren ventanas ni enlaces desde el callback. |
| Mensajes de texto, comandos y setMyCommands | OPT-OUT | D-12: el bot solo atiende botones; no hay chatops de texto. |
| setMySettings y callback_query_mode | OPT-OUT | Un callback sin mensaje accesible se valida por el token ligado a chat y mensaje, o se trata como no autorizado. |
| Modo inline, pagos, juegos y Web Apps | OPT-OUT | El bot solo avisa y reconoce incidencias en un chat privado. |
| copyMessage, forwardMessage, deleteMessage, pinChatMessage | OPT-OUT | El aviso original se conserva y solo se edita su estado. |
| Métodos de envío de medios y archivos | OPT-OUT | Los avisos y las explicaciones se representan en texto plano. |
| Administración de chats, miembros, temas y negocios | OPT-OUT | El bot opera únicamente en el chat privado ya configurado. |
