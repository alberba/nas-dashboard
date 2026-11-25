---
status: testing
phase: 02-incidencias-y-entrega-nica
source: [02-VERIFICATION.md]
started: 2026-11-25T11:44:20Z
updated: 2026-11-25T11:44:20Z
---

## Current Test

number: 1
name: Telegram real: una apertura, una escalada y un cierre
expected: |
  Llega exactamente un mensaje por incidencia abierta; la escalada y el cierre editan ese mismo mensaje (sin un segundo sendMessage); el botón abre la vista de Avisos autenticada del episodio correcto.
awaiting: user response

## Tests

### 1. Telegram real: una apertura, una escalada y un cierre
expected: Llega exactamente un mensaje por incidencia abierta; la escalada y el cierre editan ese mismo mensaje (sin un segundo sendMessage); el botón abre la vista de Avisos autenticada del episodio correcto. Configurar TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID reales en el worker, provocar una apertura, una escalada de severidad y un cierre, y pulsar el botón del mensaje.
result: [pending]

### 2. Bandeja de la PWA en iOS
expected: Con el hub visible y un aviso push todavía en la bandeja, la escalada reemplaza el aviso presente con la misma etiqueta sin volver a notificar; si el aviso se descartó o la API no está disponible, no reaparece y el cambio solo se ve en el hub.
result: [pending]

### 3. Migración y reversa sobre la base de producción
expected: IDs y cierres se conservan, no se crea trabajo de notificación para heredados, la reversa restaura los duplicados sintéticos y el re-avance no repite ni pierde IDs. Con configuración de ejemplo o ausente el contenedor no queda healthy. Seguir README.md: parar app y worker, copia restaurable, recuentos de preflight antes/después de 0004, pnpm db:migrate, comprobar identidad de incidencias abiertas y ejecutar la reversa con archivo previo de notification_outbox e incident_events.
result: [pending]

### 4. Ajustes distingue «en cola» de «entregado»
expected: La interfaz dice que la prueba push quedó en cola (no que se entregó) y el estado de entrega del hub refleja el resultado real.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
