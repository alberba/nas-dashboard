---
status: testing
phase: 07-acciones-verificadas-desde-telegram
source: [07-VERIFICATION.md]
started: 2026-11-27T19:41:02Z
updated: 2026-11-27T19:53:08Z
---

## Current Test

number: 1
name: Provocar un backup-failed o deploy-failed reales, pulsar «Acciones…» y la acción en Telegram, abrir el botón url en el móvil, completar la passkey y comprobar la fila en operations y la edición del aviso
expected: |
  El hub abre Avisos con el diálogo «Copia ahora» / «Desplegar ahora», la acción se ejecuta una vez, operations tiene channel=telegram y requestedBy del usuario del hub, y el aviso se edita en silencio con el resultado
awaiting: user response

## Tests

### 1. Provocar un backup-failed o deploy-failed reales, pulsar «Acciones…» y la acción en Telegram, abrir el botón url en el móvil, completar la passkey y comprobar la fila en operations y la edición del aviso
expected: El hub abre Avisos con el diálogo «Copia ahora» / «Desplegar ahora», la acción se ejecuta una vez, operations tiene channel=telegram y requestedBy del usuario del hub, y el aviso se edita en silencio con el resultado
result: [pending]

### 2. Pulsar una acción en un aviso real, no abrir el enlace y esperar 5 min con el worker en marcha
expected: El teclado se restaura en silencio con «Acciones…» y no queda un enlace muerto a la vista
result: [pending]

### 3. En el despliegue real (Nginx Proxy Manager y Tailscale Serve), con sesión iniciada por contraseña, POST a /api/verification/password en el dominio principal con Origin del origen alternativo y aparte con cabecera de host reenviada alternativa; después, por la entrada alternativa, verificar con contraseña y completar una acción
expected: En el dominio principal ambos dan 403 password_not_allowed; la entrada alternativa sigue ofreciendo contraseña y la acción se ejecuta
result: [pending]
evidence: |
  2026-11-27T19:5xZ, tras desplegar la fase 7 en webs (migración 0008 aplicada), con sesión de contraseña real:
  - GET hub.alberba.es/api/verification → method=passkey
  - GET oracle-web.tailf3703f.ts.net/api/verification → method=password (Tailscale Serve reenvía el Host)
  - POST principal con Origin alternativo → 403 password_not_allowed
  - POST principal con Origin + X-Forwarded-Host alternativos → 403 password_not_allowed
  - POST alternativo con contraseña errónea → 403 invalid_password (se ofrece contraseña)
  Falta: verificar con la contraseña real en la entrada alternativa y completar una acción.

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
