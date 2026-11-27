---
status: testing
phase: 06-puerta-de-seguridad
source: [06-VERIFICATION.md]
started: 2026-11-27T14:01:06Z
updated: 2026-11-27T14:01:06Z
---

## Current Test

number: 1
name: Decidir sobre CR-01 (06-REVIEW.md, disposición 'open'): el factor de verificación (passkey o contraseña) se elige a partir de la cabecera Origin que envía el cliente
expected: |
  Decisión explícita: corregir ahora (derivar el factor de Host/X-Forwarded-Host fijado por el proxy y exigir que Origin coincida), o diferir/aceptar con motivo por escrito. Mientras no se decida, con un origen alternativo en TRUSTED_ORIGINS quien conozca la contraseña y tenga sesión puede obtener una verificación 'password' enviando Origin del origen alternativo contra el dominio público y ejecutar acciones destructivas sin passkey.
awaiting: user response

## Tests

### 1. Decidir sobre CR-01 (06-REVIEW.md, disposición 'open'): el factor de verificación (passkey o contraseña) se elige a partir de la cabecera Origin que envía el cliente
expected: Decisión explícita: corregir ahora (derivar el factor de Host/X-Forwarded-Host fijado por el proxy y exigir que Origin coincida), o diferir/aceptar con motivo por escrito. Mientras no se decida, con un origen alternativo en TRUSTED_ORIGINS quien conozca la contraseña y tenga sesión puede obtener una verificación 'password' enviando Origin del origen alternativo contra el dominio público y ejecutar acciones destructivas sin passkey.
result: [pending]

### 2. Comprobar las cabeceras reales por dominio: curl -sI https://<dominio-principal> y https://<entrada-alternativa-tailscale> | grep -i -E 'strict-transport-security|content-security-policy'
expected: Una sola Strict-Transport-Security: max-age=15552000 (sin includeSubDomains ni preload) y una CSP con nonce y 'strict-dynamic' en el documento; con el interruptor HSTS de Nginx Proxy Manager apagado.
result: [pending]

### 3. Abrir el panel en Safari y Firefox, verificar con passkey y activar push; mirar la consola
expected: Ninguna violación de CSP. Playwright solo cubre Chromium.
result: [pending]

### 4. Recorrer el diálogo de passkey en la tarjeta del host, la búsqueda Ctrl K y las filas de contenedor con una passkey real
expected: El diálogo se abre para lo protegido y no para check-health; foco, consecuencias y tono correctos según 06-UI-SPEC.md.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
