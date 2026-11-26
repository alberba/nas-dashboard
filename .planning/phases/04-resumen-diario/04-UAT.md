---
status: complete
phase: 04-resumen-diario
source: [04-VERIFICATION.md]
started: 2026-11-26T10:45:00.000Z
updated: 2026-11-26T11:18:50.893Z
---

## Current Test

[testing complete]

## Tests

### 1. Resumen real por Telegram
expected: Llega un único mensaje «Resumen diario · <fecha>» con abiertas ahora, nuevas en el periodo, el pie de críticas y resueltas y el botón que abre Avisos con sesión. Un reinicio del worker dentro de la ventana no produce un segundo mensaje.
result: pass

### 2. Worker unhealthy con el proceso vivo
expected: Tras construir la imagen y levantar el worker con compose.yaml en entorno desechable, Docker lo marca unhealthy al congelarlo con SIGSTOP mientras el proceso vive sin progresar, y vuelve a healthy con SIGCONT.
result: pass
source: executed-by-claude
evidence: |
  Imagen construida desde el repo (hub-uat04:local) y stack db+migrate+worker levantado desde una copia de compose.yaml con nombre de proyecto y env desechables (healthcheck idéntico). healthy a los ~6 s.
  SIGSTOP al node del worker (PID 35 en el contenedor, estado T): fails=1 a los 1:40, unhealthy (fails=3) a los 2:42, salida del probe «Marca de salud del worker no válida (stale)», RestartCount=0, proceso vivo.
  SIGCONT: healthy a los 20 s. Entorno eliminado (down -v --rmi local).
note: "El procedimiento `docker kill -s SIGSTOP <contenedor>` NO sirve: congela solo el PID 1 (pnpm) y el node hijo sigue refrescando la marca (10 min healthy). Hay que congelar el proceso node: `docker exec <c> sh -c 'kill -STOP <pid>'` (la imagen no trae /bin/kill)."


### 3. Agente unhealthy con el LOCK ocupado o el proceso congelado
expected: Los dos servicios de agente (agent/compose.yaml y agent/compose.apps.yaml) heredan el HEALTHCHECK, pasan a unhealthy con el proceso vivo y bloqueado, recuperan healthy al liberar el LOCK, y la purga de la papelera no los vuelve unhealthy.
result: pass
source: executed-by-claude
evidence: |
  Imagen construida desde agent/Dockerfile; HEALTHCHECK de imagen `python server.py --health-check` (30s/5s/start 30s/3 reintentos). agent/compose.yaml y agent/compose.apps.yaml construyen la misma imagen (hub-agent:1) y ninguno sobrescribe healthcheck, así que ambos lo heredan.
  Contenedor desechable con los flags de compose (read_only, tmpfs /tmp, no-new-privileges), sin docker.sock ni montajes del host; /nas/media en directorio temporal.
  Purga: caja de papelera caducada con 2M ficheros sembrada antes de arrancar. El borrado duró ~4 min tras renombrar la caja a .purge; el agente estuvo healthy todo el tiempo (fails máx. 1, un timeout puntual del probe bajo carga de I/O, recuperado).
  SIGSTOP a python (PID 1, estado T): unhealthy (fails=3) a los 162 s, salida «Marca de salud del agente no válida (stale)», RestartCount=0. SIGCONT: healthy a los 30 s. Entorno eliminado.
note: "Se probó la variante «proceso congelado». La variante «LOCK ocupado» no se puede provocar desde fuera sin inyectar código; queda cubierta por la suite unitaria y por la purga larga que demuestra que el borrado ya no retiene el LOCK."


### 4. Panel «Último resumen diario» en Avisos
expected: Con un resumen sembrado como fallido y otro como incierto, el panel es global, se mantiene al cambiar de host y distingue con claridad fallo, vencimiento e incertidumbre.
result: pass
source: reviewed-by-claude
evidence: "El usuario delegó el juicio. Revisión de src/components/views/alerts.tsx: el panel vive en su propia sección «Resumen diario», fuera de la vista por host (data-digest-scope=global, ya afirmado por Playwright INC-E2E-04). Estados con texto propio: «No entregado» (rojo), «Vencido» y «Sin confirmación» (melocotón), cada uno con su motivo en una frase."
note: "Cosmético, no bloqueante: Vencido y Sin confirmación comparten color y se distinguen solo por el texto; los motivos dicen «el proveedor» en vez de «Telegram»."


## Summary

total: 4
passed: 4
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
