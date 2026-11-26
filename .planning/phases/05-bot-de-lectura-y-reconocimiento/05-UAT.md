---
status: testing
phase: 05-bot-de-lectura-y-reconocimiento
source: [05-VERIFICATION.md]
started: 2026-11-26T15:56:55.219Z
updated: 2026-11-26T15:56:55.219Z
---

## Current Test

number: 1
name: Reconocer desde Telegram persiste y media-stack no consume updates
expected: |
  El reconocimiento sigue guardado tras el reinicio con canal telegram. media-stack no consume updates ni configura webhook con ese token; si lo hiciera, el carril no se activa en producción hasta resolverlo.
awaiting: user response

## Tests

### 1. Reconocer desde Telegram persiste y media-stack no consume updates
how: Con el bot real y el worker arrancado, provocar o simular un aviso crítico inmediato, pulsar Reconocer en Telegram, comprobar que el mensaje se edita sin sonido y sin el botón, reiniciar el worker y abrir Avisos con la API. En el repositorio media-stack, buscar cualquier llamada a getUpdates o setWebhook que use el mismo token del bot.
expected: El reconocimiento sigue guardado tras el reinicio con canal telegram. media-stack no consume updates ni configura webhook con ese token; si lo hiciera, el carril no se activa en producción hasta resolverlo.
result: [pending]

### 2. Los cuatro botones con el bot real, logs sin token, Node 26
how: Con el bot real y el hub de pruebas, provocar un aviso crítico inmediato y pulsar los cuatro botones: Reconocer, Silenciar 1 h, Por qué me llegó esto y Quitar silencio. Comprobar que cada edición es silenciosa, que la respuesta de Por qué cita el aviso sin sonido, que Avisos muestra el estado de cada paso, que el resumen del día siguiente etiqueta el episodio y que docker compose logs worker no contiene el token. Ejecutar además la suite completa con Node 26 y pnpm build.
expected: Los cuatro botones funcionan una sola vez cada uno y se reflejan en el aviso, en Avisos y en el resumen; la respuesta de Por qué llega citando el aviso y sin sonido; ningún log contiene el token; la suite completa y el build pasan con Node 26. Si media-stack consumiera updates con el mismo token, el carril no se activa en producción hasta resolverlo.
result: [pending]

### 3. Silenciar 1 h / 24 h y Quitar silencio con el bot real
how: Con el bot real, pulsar Silenciar 1 h y Silenciar 24 h, comprobar que el mismo mensaje se edita sin sonido y muestra «Silenciada hasta HH:MM» con la hora de Madrid, y que el teclado ofrece Quitar silencio. Provocar una reapertura del mismo host y clave dentro del plazo, pulsar Quitar silencio y dejar vencer el plazo.
expected: Durante el plazo no llega ningún aviso por la reapertura y la incidencia sigue visible en Avisos y en el resumen; Quitar silencio restaura los dos botones; al vencer no llega ningún mensaje retenido.
result: [pending]

### 4. Por qué me llegó esto con el bot real
how: Con el bot real, provocar un aviso de temperatura por encima del umbral y pulsar «Por qué me llegó esto»; reconocer y volver a pulsar Por qué en el teclado nuevo; escalar a crítica y pulsar de nuevo; resolver y comprobar el teclado y el texto.
expected: El primer mensaje cita el aviso, llega sin sonido y muestra regla, umbral, valor leído y canal; una pulsación nueva del mismo estado avisa de que ya está respondido sin otro mensaje; la escalada permite otra respuesta con la severidad actual; tras resolver solo quedan Por qué y Abrir en el hub y no se muestra el dato leído.
result: [pending]

### 5. Avisos en escritorio y móvil, acción del hub edita el aviso
how: Abrir Avisos con una incidencia abierta y operar los controles reconocer, silenciar 1 h, silenciar 24 h y quitar el silencio en escritorio y en móvil; con un aviso enviado, reconocer desde el hub y mirar el mensaje de Telegram.
expected: El estado y los controles se leen y se pulsan sin solaparse; el mensaje de Telegram se edita en silencio, sin el botón Reconocer y con la hora de Madrid.
result: [pending]

### 6. SIGTERM con un long poll en vuelo
how: Arrancar el worker con el bot configurado, dejar un getUpdates de 3 s en vuelo y enviar SIGTERM.
expected: El proceso sale sin esperar al final del long poll y sin error no controlado.
result: [pending]

## Summary

total: 6
passed: 0
issues: 0
pending: 6
skipped: 0
blocked: 0

## Gaps
