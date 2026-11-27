---
status: partial
phase: 06-puerta-de-seguridad
source: [06-VERIFICATION.md]
started: 2026-11-27T14:01:06Z
updated: 2026-11-27T15:25:45.860Z
---

## Current Test

[testing complete]

## Tests

### 1. Decidir sobre CR-01 (06-REVIEW.md, disposición 'open'): el factor de verificación (passkey o contraseña) se elige a partir de la cabecera Origin que envía el cliente
expected: Decisión explícita: corregir ahora (derivar el factor de Host/X-Forwarded-Host fijado por el proxy y exigir que Origin coincida), o diferir/aceptar con motivo por escrito. Mientras no se decida, con un origen alternativo en TRUSTED_ORIGINS quien conozca la contraseña y tenga sesión puede obtener una verificación 'password' enviando Origin del origen alternativo contra el dominio público y ejecutar acciones destructivas sin passkey.
result: pass

### 2. Comprobar las cabeceras reales por dominio: curl -sI https://<dominio-principal> y https://<entrada-alternativa-tailscale> | grep -i -E 'strict-transport-security|content-security-policy'
expected: Una sola Strict-Transport-Security: max-age=15552000 (sin includeSubDomains ni preload) y una CSP con nonce y 'strict-dynamic' en el documento; con el interruptor HSTS de Nginx Proxy Manager apagado.
result: blocked
blocked_by: third-party
reason: "Repetido por Claude el 2026-11-27 tras el despliegue (main = origin/main): https://hub.alberba.es ya sirve la CSP con nonce y 'strict-dynamic' y la HSTS de la app (max-age=15552000), pero sigue llegando una segunda strict-transport-security: max-age=63072000; preload que añade Nginx Proxy Manager. Falta apagar el interruptor HSTS de NPM en ese host. La entrada de Tailscale (ugreen-nas.tailf3703f.ts.net) no sirve el panel por HTTPS: :443 responde 400 o nada, y no parece haber un Tailscale Serve hacia 127.0.0.1:4324. Repetir el curl cuando estén las dos cosas."

### 3. Abrir el panel en Safari y Firefox, verificar con passkey y activar push; mirar la consola
expected: Ninguna violación de CSP. Playwright solo cubre Chromium.
result: pass
note: "Safari (manual, local): pidió la passkey y la consola no mostró violaciones de CSP. Firefox no está instalado: cubierto solo por tests/e2e/csp.spec.ts en Playwright Firefox y WebKit (10/10), sin passkey ni push reales."

### 4. Recorrer el diálogo de passkey en la tarjeta del host, la búsqueda Ctrl K y las filas de contenedor con una passkey real
expected: El diálogo se abre para lo protegido y no para check-health; foco, consecuencias y tono correctos según 06-UI-SPEC.md.
result: pass
note: "Probado en local con un agente de prueba (Docker local, ALLOW_REBOOT=false): tarjeta, Ctrl K y filas de contenedor con passkey real en Safari."

## Summary

total: 4
passed: 3
issues: 0
pending: 0
skipped: 0
blocked: 1

## Gaps
