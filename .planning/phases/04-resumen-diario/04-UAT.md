---
status: testing
phase: 04-resumen-diario
source: [04-VERIFICATION.md]
started: 2026-11-26T10:45:00.000Z
updated: 2026-11-26T10:45:00.000Z
---

## Current Test

number: 1
name: Resumen real por Telegram
expected: |
  Llega un único mensaje «Resumen diario · <fecha>» con abiertas ahora, nuevas en el periodo, el pie de críticas y resueltas y el botón que abre Avisos con sesión. Un reinicio del worker dentro de la ventana no produce un segundo mensaje.
awaiting: user response

## Tests

### 1. Resumen real por Telegram
expected: Llega un único mensaje «Resumen diario · <fecha>» con abiertas ahora, nuevas en el periodo, el pie de críticas y resueltas y el botón que abre Avisos con sesión. Un reinicio del worker dentro de la ventana no produce un segundo mensaje.
result: [pending]

### 2. Worker unhealthy con el proceso vivo
expected: Tras construir la imagen y levantar el worker con compose.yaml en entorno desechable, Docker lo marca unhealthy al congelarlo con SIGSTOP mientras el proceso vive sin progresar, y vuelve a healthy con SIGCONT.
result: [pending]

### 3. Agente unhealthy con el LOCK ocupado o el proceso congelado
expected: Los dos servicios de agente (agent/compose.yaml y agent/compose.apps.yaml) heredan el HEALTHCHECK, pasan a unhealthy con el proceso vivo y bloqueado, recuperan healthy al liberar el LOCK, y la purga de la papelera no los vuelve unhealthy.
result: [pending]

### 4. Panel «Último resumen diario» en Avisos
expected: Con un resumen sembrado como fallido y otro como incierto, el panel es global, se mantiene al cambiar de host y distingue con claridad fallo, vencimiento e incertidumbre.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
