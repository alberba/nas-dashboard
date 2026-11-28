---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "03"
subsystem: notifications
tags: [guard, static-scan, ingest, hmac, shell, runbook, cutover, rotation]

requires:
  - phase: 08-01
    provides: "Contrato v1 del ingest (signIngest, verifyIngest, ingestEnvelope) y su vector de firma"
provides:
  - "Guarda D-22: tests/notification-senders.test.ts falla si un emisor de Telegram o Web Push nace fuera de la lista permitida"
  - "scripts/ingest-test-event.sh: evento de prueba firmado desde cualquier equipo, con modo de ensayo"
  - "docs/media-stack-cutover.md: checklist del cutover con orden obligatorio, verificacion por familia y vuelta atras"
  - "docs/rotacion-token-y-secreto.md: runbook de rotacion conjunta del token del bot y del secreto HMAC"
affects: [08-10, 08-11, 08-15]

tech-stack:
  added: []
  patterns:
    - "Guarda estatica con lista permitida justificada, control negativo y comprobacion de que no esta vacia"
    - "Script sh POSIX con jq/openssl/curl cuya firma se verifica contra signIngest como oraculo independiente"
    - "Secreto solo por entorno; el script rechaza --secret y --secret=..."

key-files:
  created:
    - tests/notification-senders.test.ts
    - scripts/ingest-test-event.sh
    - tests/ingest-test-event.test.ts
    - docs/media-stack-cutover.md
    - docs/rotacion-token-y-secreto.md
  modified:
    - README.md

key-decisions:
  - "P-10: la guarda escanea src/ (.ts y .tsx), sin scripts/; quita comentarios antes de comparar (los de linea solo al inicio o tras un espacio)"
  - "P-11: script sh POSIX; INGEST_DRY_RUN=1 imprime cabeceras y cuerpo sin red; INGEST_TIMESTAMP fija la marca de tiempo solo para pruebas"
  - "P-12: documentos en espanol, sin secretos reales; los ejemplos usan read -rs, curl -K - y variables de entorno"

requirements-completed: [SEC-05, CONT-02]

coverage:
  - deliverable: "Guarda D-22: ningun modulo de src salvo los dos emisores y las dos definiciones envia a Telegram o por Web Push"
    verification:
      - kind: test
        ref: "tests/notification-senders.test.ts#finds no sender in src outside the allowed files"
        status: pass
      - kind: test
        ref: "tests/notification-senders.test.ts#flags every kind of sender in a synthetic source"
        status: pass
      - kind: test
        ref: "tests/notification-senders.test.ts#is not empty: every allowed file still uses or defines its senders"
        status: pass
    human_judgment: false
  - deliverable: "Script de evento de prueba: firma igual al vector de contrato y a signIngest, secreto solo por entorno, secuencia both"
    verification:
      - kind: test
        ref: "tests/ingest-test-event.test.ts#signs the contract vector byte for byte"
        status: pass
      - kind: test
        ref: "tests/ingest-test-event.test.ts#posts two requests the hub would verify and exits 0 on 2xx"
        status: pass
    human_judgment: false
  - deliverable: "Checklist del cutover y runbook de rotacion (existencia, identificadores y ausencia de secreto por argumento)"
    verification:
      - kind: test
        ref: "tests/ingest-test-event.test.ts#cutover and rotation documents"
        status: pass
    human_judgment: true
    rationale: "Que los pasos escritos sean correctos y suficientes solo se prueba ejecutandolos en las puertas humanas 08-10 y 08-11"

actuals:
  tokens: 24000
  tasks: 3
  commits: 3

plan_head_before: c79249642cec5473343512743b4c9d36a43475ee
plan_head_after: f764bcff4681949abd7b16843aa10d936623f365

duration: 25 min
completed: 2026-11-28
status: complete
---

# Phase 8 Plan 03: Guarda de emisores, script de prueba del ingest y documentos de cutover Summary

**Una guarda estatica impide que un modulo de `src/` envie a Telegram o por Web Push fuera de `notification-dispatch.ts` y `digest-runs.ts`; `scripts/ingest-test-event.sh` firma eventos de prueba con la firma exacta del vector de contrato; y el usuario dispone del checklist del cutover y del runbook de rotacion.**

## Lista permitida real de la guarda (P-10)

`ALLOWED` en `tests/notification-senders.test.ts`, cada entrada con su motivo:

| Fichero | Motivo |
| --- | --- |
| `src/lib/notification-dispatch.ts` | emisor D-22: entrega el outbox a Telegram y Web Push |
| `src/lib/digest-runs.ts` | emisor D-22: entrega el resumen diario a Telegram |
| `src/lib/telegram.ts` | define el transporte de Telegram y sus remitentes |
| `src/lib/push.ts` | define el transporte de Web Push y su remitente |

`FORBIDDEN` reune cuatro patrones: `sendTelegramMessage|editTelegramMessage|sendTelegramReply`, `deliverPush`, la cadena `"web-push"` o `'web-push'` y `api.telegram.org`. Seis pruebas: las ocho infracciones sinteticas se detectan, un comentario que nombra un remitente no se marca, un `//` dentro de una cadena (`https://`) no oculta lo que sigue, el arbol real de `src/` no tiene infracciones, la guarda no esta vacia (cada permitido sigue usando o definiendo sus remitentes) y cada permiso existe y lleva un motivo. `telegram-updates.ts` y `digest-content.ts` no necesitan permiso, como preveia el plan.

## Uso del script

```sh
read -rs NOTIFY_INGEST_SECRET && export NOTIFY_INGEST_SECRET
scripts/ingest-test-event.sh --url <URL-del-ingest> --source backup --host-id nas-home \
  --key backup-failed --state both --error "prueba"
```

- Banderas: `--url`, `--source` (`backup` | `issue-automator`), `--host-id`, `--key`, `--state` (`open` | `resolved` | `both`), `--event-id`, `--subject`, `--reported-by`, `--problem`, `--error`. `--secret` (y `--secret=...`) y cualquier bandera desconocida salen con 2; sin `NOTIFY_INGEST_SECRET` tambien.
- Entorno: `INGEST_DRY_RUN=1` imprime tres lineas por peticion (`X-Ingest-Timestamp`, `X-Ingest-Signature: v1=<hex>` y el cuerpo) sin red; `INGEST_TIMESTAMP` fija la marca de tiempo (10 digitos).
- Con la red: `curl -sS --max-time 10 --data-binary @-`, imprime `<estado> <codigo> <respuesta>` y sale con 0 solo si todas las respuestas son 2xx; `both` se detiene en la primera que no lo es.
- `--state both`: `<event-id>:open` y `<event-id>:resolved`; sin `--event-id` el valor por defecto es `test:<key>:<timestamp>`.
- El ensayo con las banderas del vector produce `4525b5167d3882979d6b063dde511c6c28d2bec94d65811d2f512581b76eada1` y el cuerpo byte a byte del vector de 08-01. Pasa `sh -n` y `shellcheck` sin avisos.

## Documentos

**`docs/media-stack-cutover.md`** (11 secciones): 1 resumen y orden obligatorio; 2 requisitos previos; 3 eventos de prueba por familia (copia y issue, desde el Mac y desde un contenedor `alpine`); 4 verificacion de emisores apagados; 5 Seerr «Issue Resolved»; 6 emisor SMART externo; 7 release y verificacion posterior (`notify-test ingest` y `fallback`); 8 limpieza de colas obsoletas; 9 bandeja de issue-automator (carpeta, `pending`, limites de 14 dias y 200 eventos, sin cierre por antiguedad en el hub); 10 duplicado conocido de la copia; 11 vuelta atras.

**`docs/rotacion-token-y-secreto.md`** (8 secciones): 1 alcance y sentido unico; 2 antes de empezar; 3 rotacion del token (BotFather, `.env`, `up -d --force-recreate`, `getMe` con `curl -K -`, aviso por cada camino); 4 ventana ciega y `telegram_401`; 5 rotacion del secreto con `NOTIFY_INGEST_SECRET_PREVIOUS`; 6 comprobacion por camino; 7 si algo sale mal; 8 «Resultado del ensayo real» con las preguntas que rellena 08-11.

**`README.md`**: apartado «Ingest de avisos de media-stack» dentro de «Configuracion y despliegue» (variables, 503 sin secreto, enlaces, duplicado aceptado) y una frase sobre la guarda en «Desarrollo y pruebas».

## Task Commits

1. Tarea 1 (tracer): `b87fa99` test(08-03): static guard keeps senders inside the policy path
2. Tarea 2: `2a09901` feat(08-03): signed test-event script with dry run matching the contract vector
3. Tarea 3: `f764bcf` docs(08-03): cutover checklist, rotation runbook and README section

## Decisions Made

P-10, P-11 y P-12 se aplicaron como estan en el plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Hechos de media-stack verificados contra la rama `phase-08-cutover`**
- **Found during:** Tarea 3
- **Issue:** El plan nombra `media-backup notify-test` sin la forma de invocarlo; una invencion habria dejado un paso del checklist roto.
- **Fix:** Se leyo (solo lectura) `docs/backup.md` de la rama y los comandos del checklist y del runbook son `docker compose exec backup media-backup notify-test ingest|fallback`, con el servicio `backup`. No se toco `media-stack`.
- **Files modified:** `docs/media-stack-cutover.md`, `docs/rotacion-token-y-secreto.md`
- **Commit:** `f764bcf`

**2. [Nota de proceso] Ciclo TDD de la tarea 2**
- El script se escribio antes que su prueba (el plan lo describe como una tarea `tdd` con la accion «script, luego prueba»); no hubo fase RED separada. La prueba contra el vector exacto y contra `signIngest` es un oraculo independiente, de modo que una firma distinta la haria fallar. El caso estructural de los documentos si fallo primero (el checklist no nombraba `NOTIFY_INGEST_SECRET_PREVIOUS`) y se corrigio el documento.

**Total deviations:** 1 auto-fixed (missing critical) y 1 nota de proceso. **Impact:** ninguno sobre el alcance.

## Issues Encountered

- `openssl dgst -hmac` recibe el secreto como argumento durante los milisegundos de la firma (visible para otros procesos del mismo equipo); es la limitacion que ya acepta 08-06 (T-08-19) y esta anotada en el encabezado del script. No hay alternativa en `openssl` sin ficheros intermedios con el secreto. El secreto nunca llega a `curl` ni al historial.
- `prettier --write` sobre `README.md` reformaba una tabla ajena a este plan; se revirtio y el apartado se anadio sin tocar el resto.

## Known Stubs

None. La seccion «Resultado del ensayo real» de la rotacion esta vacia a proposito (la rellena 08-11).

## Threat Flags

Ninguno. Sin superficie nueva: la guarda es una prueba estatica y el script solo envia al ingest ya cubierto por el threat model de 08-01. T-08-10 (guarda con lista permitida, control negativo y comprobacion de no vacia) y T-08-11 (secreto solo por entorno, rechazo de `--secret`, documentos con `read -rs` y `curl -K -`) estan aplicadas y cubiertas por pruebas; T-08-SC: sin paquetes nuevos.

## Verification

- `pnpm test tests/notification-senders.test.ts tests/ingest-test-event.test.ts`: 2 archivos, 17 pruebas pasan (6 de la guarda, 11 del script y los documentos), ninguna omitida.
- `pnpm typecheck` y `pnpm lint` (con los ignores del entorno): sin errores. `sh -n` y `shellcheck` sobre el script: limpios.
- Criterios: `test -x scripts/ingest-test-event.sh`, `test -f` de los dos documentos y de la prueba de la guarda, `grep -c NOTIFY_INGEST README.md` = 2; ningun `--secret` ni token con forma de valor real en `docs/` ni `README.md`.

## Next Phase Readiness

Listo para las puertas humanas 08-10 (cutover) y 08-11 (rotacion real), que usan los dos documentos y el script. No se tocaron STATE.md ni ROADMAP.md (los escribe el orquestador).

## Self-Check: PASSED

- FOUND: tests/notification-senders.test.ts, scripts/ingest-test-event.sh, tests/ingest-test-event.test.ts, docs/media-stack-cutover.md, docs/rotacion-token-y-secreto.md
- FOUND commits: b87fa99, 2a09901, f764bcf
