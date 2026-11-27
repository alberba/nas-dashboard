---
status: complete
phase: 05-bot-de-lectura-y-reconocimiento
source: [05-VERIFICATION.md]
started: 2026-11-26T15:56:55.219Z
updated: 2026-11-27T08:28:42.620Z
---

## Current Test

[testing complete]

## Tests

### 1. Reconocer desde Telegram persiste y media-stack no consume updates
how: Con el bot real y el worker arrancado, provocar o simular un aviso crítico inmediato, pulsar Reconocer en Telegram, comprobar que el mensaje se edita sin sonido y sin el botón, reiniciar el worker y abrir Avisos con la API. En el repositorio media-stack, buscar cualquier llamada a getUpdates o setWebhook que use el mismo token del bot.
expected: El reconocimiento sigue guardado tras el reinicio con canal telegram. media-stack no consume updates ni configura webhook con ese token; si lo hiciera, el carril no se activa en producción hasta resolverlo.
result: pass
evidence: "Producción (webs, despliegue 654a147). Incidencia 144 (temperature, critical) reconocida desde Telegram 2026-11-27 08:05:58Z; tras reiniciar el worker acknowledgedVia=telegram y el evento acknowledged persisten. media-stack: sin getUpdates/setWebhook en el repo; getWebhookInfo sin webhook y pending_update_count a 0 consumido por el carril del hub." 

### 2. Los cuatro botones con el bot real, logs sin token, Node 26
how: Con el bot real y el hub de pruebas, provocar un aviso crítico inmediato y pulsar los cuatro botones: Reconocer, Silenciar 1 h, Por qué me llegó esto y Quitar silencio. Comprobar que cada edición es silenciosa, que la respuesta de Por qué cita el aviso sin sonido, que Avisos muestra el estado de cada paso, que el resumen del día siguiente etiqueta el episodio y que docker compose logs worker no contiene el token. Ejecutar además la suite completa con Node 26 y pnpm build.
expected: Los cuatro botones funcionan una sola vez cada uno y se reflejan en el aviso, en Avisos y en el resumen; la respuesta de Por qué llega citando el aviso y sin sonido; ningún log contiene el token; la suite completa y el build pasan con Node 26. Si media-stack consumiera updates con el mismo token, el carril no se activa en producción hasta resolverlo.
result: pass
evidence: "Producción, incidencia 144: Por qué enviado (outbox 3, 08:08:09Z), Silenciar 1 h hasta 09:08:22Z (evento snoozed), Quitar silencio (evento unsnoozed 08:08:28Z), Por qué repetido consumió el token sin mensaje nuevo; cada edición registrada como incident-edit enviada. El usuario confirmó ediciones silenciosas y la respuesta citada. Token ausente en los logs de worker y app. Node 26.13.1: typecheck, 679/679 tests (con PostgreSQL 18 en loopback, HUB_REQUIRE_TEST_DB=1), db:migrate y build OK. Pendiente de mirar: la etiqueta del episodio en el resumen del 2026-11-28." 

### 3. Silenciar 1 h / 24 h y Quitar silencio con el bot real
how: Con el bot real, pulsar Silenciar 1 h y Silenciar 24 h, comprobar que el mismo mensaje se edita sin sonido y muestra «Silenciada hasta HH:MM» con la hora de Madrid, y que el teclado ofrece Quitar silencio. Provocar una reapertura del mismo host y clave dentro del plazo, pulsar Quitar silencio y dejar vencer el plazo.
expected: Durante el plazo no llega ningún aviso por la reapertura y la incidencia sigue visible en Avisos y en el resumen; Quitar silencio restaura los dos botones; al vencer no llega ningún mensaje retenido.
result: pass
evidence: "Producción: Silenciar 24 h desde Telegram (snooze nas-home/temperature hasta 2026-11-28 08:17Z). Cierre de 144 y reapertura como 145 dentro del plazo: outbox incident-open suppressed, el usuario no recibió nada y vio 145 en Avisos como silenciada. Quitar silencio desde Avisos (evento unsnoozed 08:21:56Z) sin mensaje retenido posterior. No observado: restauración de botones en Telegram (la reapertura silenciada no tiene mensaje) y vencimiento natural del plazo." 

### 4. Por qué me llegó esto con el bot real
how: Con el bot real, provocar un aviso de temperatura por encima del umbral y pulsar «Por qué me llegó esto»; reconocer y volver a pulsar Por qué en el teclado nuevo; escalar a crítica y pulsar de nuevo; resolver y comprobar el teclado y el texto.
expected: El primer mensaje cita el aviso, llega sin sonido y muestra regla, umbral, valor leído y canal; una pulsación nueva del mismo estado avisa de que ya está respondido sin otro mensaje; la escalada permite otra respuesta con la severidad actual; tras resolver solo quedan Por qué y Abrir en el hub y no se muestra el dato leído.
result: pass
evidence: "Producción, incidencia 146: Por qué enviado (outbox 13) citando el aviso, en silencio, con regla, umbral 30 °C, valor y canal; Por qué repetido y tras Reconocer consumieron el token sin mensaje nuevo; al cerrar quedaron Por qué y Abrir en el hub y la respuesta (outbox 17) omitió el dato leído. Confirmado por el usuario. No observado: la escalada, porque temperature es siempre crítica." 

### 5. Avisos en escritorio y móvil, acción del hub edita el aviso
how: Abrir Avisos con una incidencia abierta y operar los controles reconocer, silenciar 1 h, silenciar 24 h y quitar el silencio en escritorio y en móvil; con un aviso enviado, reconocer desde el hub y mirar el mensaje de Telegram.
expected: El estado y los controles se leen y se pulsan sin solaparse; el mensaje de Telegram se edita en silencio, sin el botón Reconocer y con la hora de Madrid.
result: pass
evidence: "Producción, incidencia 147: el usuario operó silenciar 1 h, 24 h y quitar silencio en escritorio y móvil (eventos snoozed/unsnoozed 08:27-08:28Z) y reconoció desde el hub (acknowledgedVia=hub, 08:28:21Z); cada acción editó el mensaje de Telegram (incident-edit enviadas; las intermedias superseded por coalescencia). Confirmado por el usuario: controles legibles sin solaparse y edición silenciosa sin Reconocer, con hora de Madrid. Umbral de temperatura de nas-home restaurado a 85 °C al terminar." 

### 6. SIGTERM con un long poll en vuelo
how: Arrancar el worker con el bot configurado, dejar un getUpdates de 3 s en vuelo y enviar SIGTERM.
expected: El proceso sale sin esperar al final del long poll y sin error no controlado.
result: pass
evidence: "Producción: docker compose stop worker con el carril de updates en long poll, tres veces; parada en 340 ms medida (lejos del SIGKILL de 10 s), log 'Carril de updates: aborted', sin errores no controlados, exit 143 por la señal reenviada por pnpm, sin OOM; el worker vuelve a healthy al arrancar." 

## Summary

total: 6
passed: 6
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

## Deferred Follow-Ups

- test: 1
  idea: "Por cierto, molaría un emoticono en los mensajes para diferenciarlos y que no sea solo texto plano"
  deferred_at: 2026-11-27
