# Cobertura de API · Telegram Bot API

La fase usa las operaciones de envío directo y edición de texto de [Telegram Bot API](https://core.telegram.org/bots/api#available-methods). El alcance se limita al aviso saliente por incidencia y su enlace al hub.

| capability | decision | reason |
|---|---|---|
| sendMessage | INTEGRATE | Abre el aviso de una incidencia en el chat configurado mediante el outbox. |
| editMessageText | INTEGRATE | Actualiza severidad y resolución en el mismo mensaje confirmado. |
| InlineKeyboardButton.url | INTEGRATE | Abre la incidencia en el hub con autenticación. |
| ResponseParameters.retry_after | INTEGRATE | Fija el plazo durable de reintento tras un 429. |
| getMe | OPT-OUT | El arranque valida la configuración local y evita depender de conectividad con Telegram. |
| getUpdates | OPT-OUT | La recepción mediante long polling se planifica en la fase 5. |
| setWebhook, deleteWebhook, getWebhookInfo | OPT-OUT | La fase es saliente. La configuración del transporte entrante corresponde a la fase 5. |
| answerCallbackQuery e InlineKeyboardButton.callback_data | OPT-OUT | El reconocimiento y los callbacks pertenecen a la fase 5, y las acciones autenticadas posteriores a las fases 6 y 7. |
| editMessageReplyMarkup, editMessageCaption, editMessageMedia | OPT-OUT | El único contenido de la notificación es texto y su botón URL se incluye en la edición prevista. |
| deleteMessage, deleteMessages, pinChatMessage, unpinChatMessage | OPT-OUT | El registro del mensaje original se conserva y solo se cambia su estado. |
| Métodos de envío de medios, archivos y otros contenidos | OPT-OUT | Los avisos de esta fase se representan en texto. |
| Administración de chats, miembros, temas, servicios empresariales y pagos | OPT-OUT | El bot entrega exclusivamente avisos de incidencias en el chat ya configurado. |

El cliente agente conserva sus rutas y autenticación actuales. La fase añade validación de las respuestas de GET /metrics, GET /maintenance y GET /deployments sin añadir operaciones de agente. Web Push conserva su suscripción actual y se usa para apertura elegible, respaldo confirmado y prueba encolada. El reemplazo de aviso se intenta localmente en el navegador durante un refresco visible.
