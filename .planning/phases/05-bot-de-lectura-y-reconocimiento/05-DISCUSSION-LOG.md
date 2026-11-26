# Phase 5: Bot de lectura y reconocimiento - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-26
**Phase:** 05-bot-de-lectura-y-reconocimiento
**Areas discussed:** Reconocer vs silenciar, "Por qué me llegó", Chat y estado en el hub

---

## Reconocer vs silenciar

**¿Qué silencia "Silenciar 1 h / 24 h"?**

| Option | Description | Selected |
|--------|-------------|----------|
| Host y clave | La escalada y las reaperturas del mismo host+clave no interrumpen durante el plazo | ✓ |
| Solo este episodio | Suprime la escalada y el push de respaldo de este episodio; una reapertura avisa | |

**Tras reconocer, ¿una escalada a crítica vuelve a interrumpir?**

| Option | Description | Selected |
|--------|-------------|----------|
| Sí, la crítica avisa | Reconocer = "lo he visto"; para acallar está Silenciar | ✓ |
| No, solo edita | La escalada edita en silencio | |

**¿Cómo trata el resumen una incidencia reconocida o silenciada?**

| Option | Description | Selected |
|--------|-------------|----------|
| Aparece marcada | Sigue en "abiertas ahora" con etiqueta; cifras sin cambios | ✓ |
| Fuera del detalle | Solo cuenta en el total | |
| Sin cambios | Sin etiqueta | |

**¿Qué pasa al vencer el silencio con la incidencia abierta?**

| Option | Description | Selected |
|--------|-------------|----------|
| Nada | Sin reenvío; solo eventos nuevos interrumpen | ✓ |
| Un aviso al vencer | Mensaje nuevo si sigue abierta | |

---

## "Por qué me llegó"

**¿Dónde se muestra?**

| Option | Description | Selected |
|--------|-------------|----------|
| Popup de Telegram | `answerCallbackQuery` con `show_alert`, ~200 caracteres | |
| Respuesta en el chat | Mensaje nuevo citando el aviso | ✓ |
| Ampliar el aviso | Edita el propio mensaje | |

**¿Qué explica?**

| Option | Description | Selected |
|--------|-------------|----------|
| Regla + dato + canal | Umbral, valor leído, severidad y canal | ✓ |
| Solo la política | Clave, severidad y por qué interrumpe | |
| Trazado completo | Incluye intentos de entrega | |

**Si el aviso se editó, ¿qué explica?**

| Option | Description | Selected |
|--------|-------------|----------|
| El estado actual | Incluye escalada o cierre | ✓ |
| El envío original | Por qué interrumpió al abrirse | |

**¿Funciona con la incidencia resuelta?**

| Option | Description | Selected |
|--------|-------------|----------|
| Sí, solo lectura | Silenciar y Reconocer desaparecen; "Por qué" y "Abrir" se quedan | ✓ |
| No, quitar botones | Solo queda "Abrir en el hub" | |

**¿La respuesta suena?**

| Option | Description | Selected |
|--------|-------------|----------|
| Silenciosa | `disable_notification` | ✓ |
| Normal | Notifica | |

**¿Qué pasa al pulsar otra vez?**

| Option | Description | Selected |
|--------|-------------|----------|
| Una por estado | Nueva respuesta solo si el aviso cambió; si no, toast | ✓ |
| Una por pulsación | Cada pulsación responde | |
| Solo una vez | El botón deja de responder | |

---

## Chat y estado en el hub

**¿Qué tipo de chat es `TELEGRAM_CHAT_ID`?**

| Option | Description | Selected |
|--------|-------------|----------|
| Chat privado con el bot | `chat.id` = user id; basta `TELEGRAM_CHAT_ID` | ✓ |
| Grupo solo mío | Requiere `TELEGRAM_OPERATOR_USER_ID` | |
| Grupo con más gente | Requiere `TELEGRAM_OPERATOR_USER_ID` | |

**¿Qué muestra y permite Avisos?**

| Option | Description | Selected |
|--------|-------------|----------|
| Estado + acciones | Reconocer, silenciar y quitar silencio también desde el hub | ✓ |
| Solo estado | Acciones solo en Telegram | |

**¿Texto o comandos de la cuenta autorizada?**

| Option | Description | Selected |
|--------|-------------|----------|
| Ignorarlo | Solo botones | ✓ |
| Respuesta fija | Una línea fija | |

**¿Se puede deshacer desde Telegram?**

| Option | Description | Selected |
|--------|-------------|----------|
| Quitar silencio sí | Reconocer no se deshace desde el chat | ✓ |
| Ambos | También "Quitar reconocimiento" | |
| Solo en el hub | Acciones de una dirección | |

---

## Claude's Discretion

- Respuesta visual en el mensaje tras pulsar (toast, marca en el aviso editado, disposición de botones).
- Tratamiento de botones caducados, usados o de incidencias inexistentes.
- Modelo y TTL de tokens, offset de `getUpdates`, `deleteWebhook`, deduplicación por `update_id`.
- Verificación reciente para ack/snooze desde el hub (por defecto no).
- Redacción del token del bot.

## Deferred Ideas

Ninguna nueva.
