---
status: complete
phase: 02-incidencias-y-entrega-nica
source: [02-VERIFICATION.md]
started: 2026-11-25T11:44:20Z
updated: 2026-11-25T12:28:14.662Z
---

## Current Test

[testing complete]

## Tests

### 1. Telegram real: una apertura, una escalada y un cierre
expected: Llega exactamente un mensaje por incidencia abierta; la escalada y el cierre editan ese mismo mensaje (sin un segundo sendMessage); el botón abre la vista de Avisos autenticada del episodio correcto. Configurar TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID reales en el worker, provocar una apertura, una escalada de severidad y un cierre, y pulsar el botón del mensaje.
result: pass

### 2. Bandeja de la PWA en iOS
expected: Con el hub visible y un aviso push todavía en la bandeja, la escalada reemplaza el aviso presente con la misma etiqueta sin volver a notificar; si el aviso se descartó o la API no está disponible, no reaparece y el cambio solo se ve en el hub.
result: pass

### 3. Migración y reversa con datos de producción
expected: En una copia restaurada de la base de producción, aplica la migración 0004, ensaya la reversa y vuelve a aplicar la migración. Deben conservarse los IDs y los cierres, las incidencias heredadas no deben generar avisos y la reversa debe recuperar el estado previo de los duplicados. Comprueba también que, con configuración obligatoria ausente o de ejemplo, el contenedor de prueba no se declara sano.
result: pass

### 4. Ajustes distingue «en cola» de «entregado»
expected: La interfaz dice que la prueba push quedó en cola (no que se entregó) y el estado de entrega del hub refleja el resultado real.
result: pass

## Summary

total: 4
passed: 4
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
