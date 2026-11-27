---
status: complete
phase: 07-acciones-verificadas-desde-telegram
source: [07-VERIFICATION.md]
started: 2026-11-27T19:41:02Z
updated: 2026-11-27T20:22:09.725Z
---

## Current Test

[testing complete]

## Tests

### 1. Provocar un backup-failed o deploy-failed reales, pulsar «Acciones…» y la acción en Telegram, abrir el botón url en el móvil, completar la passkey y comprobar la fila en operations y la edición del aviso
expected: El hub abre Avisos con el diálogo «Copia ahora» / «Desplegar ahora», la acción se ejecuta una vez, operations tiene channel=telegram y requestedBy del usuario del hub, y el aviso se edita en silencio con el resultado
result: pass
evidence: |
  backup-failed provocado escribiendo `failed` en appdata/backup/last-status del NAS (incidencia 153).
  Intención 9cb72e80 executed a las 19:54:57Z; una sola fila en operations: backup-now, channel=telegram,
  requestedBy=usuario del hub, «Copia iniciada». Edición :done enviada. El usuario confirmó el diálogo y la edición silenciosa.

### 2. Pulsar una acción en un aviso real, no abrir el enlace y esperar 5 min con el worker en marcha
expected: El teclado se restaura en silencio con «Acciones…» y no queda un enlace muerto a la vista
result: pass
evidence: |
  Incidencia 155 (backup-failed provocado de nuevo). Intención 9c27ca7f creada 20:08:09Z, expired 20:13:09Z,
  edición :expire enviada 20:13:11Z. El usuario confirmó «Acciones…» restaurado, sin enlace y sin sonido.
  last-status restaurado a su valor real después.

### 3. En el despliegue real (Nginx Proxy Manager y Tailscale Serve), con sesión iniciada por contraseña, POST a /api/verification/password en el dominio principal con Origin del origen alternativo y aparte con cabecera de host reenviada alternativa; después, por la entrada alternativa, verificar con contraseña y completar una acción
expected: En el dominio principal ambos dan 403 password_not_allowed; la entrada alternativa sigue ofreciendo contraseña y la acción se ejecuta
result: pass
evidence: |
  2026-11-27T19:5xZ, tras desplegar la fase 7 en webs (migración 0008 aplicada), con sesión de contraseña real:
  - GET hub.alberba.es/api/verification → method=passkey
  - GET oracle-web.tailf3703f.ts.net/api/verification → method=password (Tailscale Serve reenvía el Host)
  - POST principal con Origin alternativo → 403 password_not_allowed
  - POST principal con Origin + X-Forwarded-Host alternativos → 403 password_not_allowed
  - POST alternativo con contraseña errónea → 403 invalid_password (se ofrece contraseña)
  Entrada alternativa: verificación method=password a las 20:18:02Z y backup-now success a las 20:18:02Z (confirmado por el usuario).

### 4. Al recuperarse un aviso con una intención viva, se aplica D-05
expected: Si la incidencia se resuelve con una intención pendiente, la intención sigue valiendo hasta caducar (D-05): el aviso recuperado conserva el enlace «Confirmar en el hub» y «Cancelar», y la edición :expire lo retira al caducar
result: pass
note: |
  Registrada primero como incidencia («vi el enlace en el aviso de Copia recuperada hasta que caducó»). El diagnóstico
  (.planning/debug/resolved-notice-shows-intent-link.md) mostró que es el comportamiento decidido en D-05/D-06 de 07-CONTEXT.md.
  El usuario decidió mantener D-05 el 2026-11-27, así que el criterio se reescribió para reflejarlo.
evidence: |
  Incidencia 153 resuelta 20:02:47Z con la intención 18a7eac0 pending; edición de recuperación 20:02:49Z con el enlace;
  :expire enviada 20:04:02Z y el enlace desapareció.

## Summary

total: 4
passed: 4
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none — G-07-4 se retiró: comportamiento conforme a D-05, mantenido por decisión del usuario]
