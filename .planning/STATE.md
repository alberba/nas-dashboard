---
gsd_state_version: "1.0"
current_phase: 08
current_phase_name: Cutover de media-stack y consolidación
status: executing
stopped_at: Completed 08-10-PLAN.md
last_updated: "2026-11-28T10:07:33.474Z"
last_activity: 2026-11-28
last_activity_desc: Phase 08 execution started
state_head: 1439f6e332ae54edc6c69723b797fc0c696b2d8e
progress:
  total_phases: 8
  completed_phases: 7
  total_plans: 47
  completed_plans: 43
  percent: 88
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-27)

**Core value:** Saber en segundos qué está pasando en los dos servidores y poder actuar sobre ellos sin abrir una consola.
**Current focus:** Phase 08 — Cutover de media-stack y consolidación

## Current Position

Phase: 08 (Cutover de media-stack y consolidación) — EXECUTING
Plan: 8 of 15
Status: Ready to execute
Last activity: 2026-11-28 — Phase 08 execution started

Progress: [█████████░] 88%

## Performance Metrics

**Velocity:**
- Total plans completed: 32
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | - | - |
| 02 | 5 | - | - |
| 3 | 3 | - | - |
| 04 | 3 | - | - |
| 05 | 6 | - | - |
| 06 | 6 | - | - |
| 07 | 6 | - | - |

**Recent Trend:**
- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 9 | 3 tasks | 8 files |
| Phase 01 P02 | 10 | 3 tasks | 4 files |
| Phase 01 P03 | 8min | 3 tasks | 4 files |
| Phase 04 P04-01 | 24 min | 3 tasks | 16 files |
| Phase 04 P04-02 | 17 min | 2 tasks | 4 files |
| Phase 04 P04-03 | 45 min | 3 tasks | 16 files |
| Phase 05 P01 | 48 min | 2 tasks | 17 files |
| Phase 05 P02 | 68 min | 2 tasks | 10 files |
| Phase 05 P06 | 6 min | 2 tasks | 2 files |
| Phase 05 P03 | 9 min | 2 tasks | 10 files |
| Phase 05 P04 | 23 min | 3 tasks | 9 files |
| Phase 05 P05 | 11 min | 3 tasks | 7 files |
| Phase 06 P01 | 10 min | 3 tasks | 10 files |
| Phase 06 P02 | 13 min | 3 tasks | 8 files |
| Phase 06 P03 | 7 min | 2 tasks | 7 files |
| Phase 06 P04 | 12 min | 3 tasks | 10 files |
| Phase 06 P05 | 6 min | 3 tasks | 7 files |
| Phase 06 P06 | 9 min | 3 tasks | 14 files |
| Phase 07 P01 | 8 min | 3 tasks | 13 files |
| Phase 07 P06 | 10 min | 3 tasks | 5 files |
| Phase 07 P02 | 10 min | 3 tasks | 7 files |
| Phase 07 P03 | 5 min | 3 tasks | 10 files |
| Phase 07 P04 | 10 min | 3 tasks | 9 files |
| Phase 07 P05 | 25 min | 3 tasks | 8 files |
| Phase 08 P06 | 25 min | 3 tasks | 9 files |
| Phase 08 P07 | 25 min | 3 tasks | 4 files |
| Phase 08 P08 | 25 min | 3 tasks | 8 files |
| Phase 08 P09 | 3 min | 2 tasks | 7 files |
| Phase 08 P12 | 3 min | 2 tasks | 9 files |
| Phase 08 P15 | 5 min | 3 tasks | 7 files |
| Phase 08 P10 | puerta humana 2026-11-28 | 3 tasks | 0 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Fase 2]: Long polling en el worker en vez de webhook; el hub es privado tras Tailscale y el singleton ya existe.
- [Fase 8]: El hub es el único decisor y formateador; `media-stack` conserva solo el fallback de copia estrechado (`backup-failed`, solo si el ingest no confirma, con origen propio).
- [Fases 2–4]: Un solo canal primario por incidencia; push es fallback de `critical` y primario de `warning` solo con `pushWarnings=true`.
- [Fases 6–7]: Las acciones de host desde Telegram van por handoff al hub con sesión y passkey; `TELEGRAM_DIRECT_ACTIONS=0`.
- [Fase 2]: Renombrar `alerts` a `incidents` con `fingerprint`, timeline y `seq`, con backfill y migración inversa.
- [Phase 01]: El rate se mide sobre días inclusivos declarados (E1 8/156, E4 15/12), no sobre días con mensajes — CONTEXT publicó 0,04 y 1,15 con denominador no declarado; el informe debe declarar el denominador
- [Phase 01]: El duplicado entre sistemas cuenta una vez por mensaje WUD (14), con 12 tags idénticos, 1 actualización real y 13 revisiones manuales
- [Phase 01]: Las recuperaciones no se suman entre canales: Telegram queda en 0 por construcción y el hub se publica como no medido hasta que exista alerts.resolvedAt
- [Phase 01]: El histograma usa la hora de pared del export sin convertir y las ventanas 30/60/90 se anclan al último mensaje con días inclusivos
- [Phase 04]: digest_runs es la única autoridad por fecha; el agregado nunca escribe un resultado de entrega sobre un episodio — Evita duplicar la entrega y mantiene historial individual intacto
- [Phase 04]: La ventana de recuperación se congela al preparar, así un cambio posterior de DIGEST_TIME no reabre ni mueve una fecha
- [Phase 04]: Solo el dueño vivo del claim registra el vencimiento cierto tras cruzar dueAt
- [Phase 04]: Un intento iniciado sin confirmación pasa a incierto y nunca se reenvía
- [Phase 04]: La apertura durable decide el detalle del resumen; las preferencias actuales y el booleano digest de la política nunca reclasifican un episodio
- [Phase 04]: Nuevas cuenta disposiciones visibles (digest, telegram, push); silenciosas y legacy quedan fuera de toda cohorte; resueltas excluye cierres sintéticos
- [Phase 04]: Omitidas se calcula como abiertas-ahora menos episodios representados, cubriendo la consulta acotada y los grupos descartados en una sola cifra
- [Phase 04]: El resumen es una proyección global del hub: el mismo estado responde para todos los hosts y sobrevive al cambio de host
- [Phase 04]: Solo las transiciones durables registradas por el tick emiten log; releer una fila terminal no repite el aviso
- [Phase 04]: Ambas sondas rechazan marcas ausentes, futuras, obsoletas, de PID muerto o reutilizado; la marca del worker solo avanza tras hitos del bucle dueño del lock
- [Phase 05]: El token de callback se consume, el efecto se aplica y el offset avanza en una sola transacción del pool; solo vive el hash en la base
- [Phase 05]: El carril de updates solo arranca con chat privado positivo y sustituye el reposo del worker; un fallo no renueva la marca de salud
- [Phase 05]: El silencio se guarda por (hostId, key) con vencimiento cerrado de 1 h o 24 h y se consulta en la escritura de la incidencia y antes de la marca de intento del despacho
- [Phase 05]: La idempotencia de Silenciar compara la duración pedida con la del silencio vivo, así que repetir el mismo botón no escribe un segundo evento ni acorta el plazo
- [Phase 05]: Una fila suprimida por silencio es terminal: al vencer no se reenvía y solo un evento posterior vuelve a interrumpir; las ediciones del mensaje existente nunca se suprimen
- [Phase 05]: La idempotencia del reconocimiento se prueba sobre applyIncidentAction desde los dos canales, no sobre el carril HTTP: el contrato es la acción compartida
- [Phase 05]: incident_missing se provoca en una transacción revertida que suprime la FK: la DDL de PostgreSQL se deshace y la base queda con la misma forma
- [Phase 05]: median(sentAt -> ackAt) se calcula con acknowledgedAt y el result.at de la fila incident-open, sin columna ni migración posterior
- [Phase 05]: La prueba de la migración 0007 siembra filas en 0006 y demuestra con migrateAll y pnpm db:migrate que no las reescribe y que repetir no aplica nada
- [Phase 05]: El estado del aviso es el mayor seq de opened, severity y closed; reconocer, silenciar y quitar silencio no lo mueven
- [Phase 05]: La respuesta de Por qué es trabajo del outbox con clave única por estado; la base impide el duplicado y recordReplySent no reescribe el mensaje citado ni programa una edición
- [Phase 05]: El texto de Por qué se compone al enviar con la incidencia, la última muestra y el canal de la apertura; una incidencia resuelta no muestra dato leído
- [Phase 05]: Una acción del hub es la misma applyIncidentAction con via hub y el nombre de sesión, sobre la pareja id/host y con un cuerpo estricto
- [Phase 05]: El resumen admite la apertura suprimida por silencio en la cohorte de abiertas ahora y etiqueta la línea sin tocar los contadores
- [Phase 05]: El 409 re-arma el deleteWebhook para el siguiente run y aplica el retroceso, en lugar de reintentar el poll sobre el conflicto
- [Phase 05]: La limpieza horaria borra tokens vencidos desde hace más de un día y silencios vencidos desde hace más de 7 días y nunca toca telegram_poll_state
- [Phase 05]: La cota del update veneno y la omisión del offset tras seis días se nombran POISON_MAX_ATTEMPTS y OFFSET_RESET_AFTER_MS; el descarte no imprime el update_id
- [Phase 06]: El manifiesto puro src/lib/sensitive-actions.ts es la única autoridad de lo protegido: /api/action y la UI lo leen y un id nuevo sin entrada no compila
- [Phase 06]: El guard de /api/action se decide por la acción del cuerpo tras el replay idempotente y antes de la muestra reciente y del insert; un 403 no registra operación
- [Phase 06]: runHostCommand valida cuerpo, host y clave antes del guard por comando; executeHostCommand queda sin guard porque la decisión pertenece a quien lo invoca
- [Phase 06]: Un replay de un comando de host ya terminado exige verificación vigente: efecto menor aceptado para no partir executeHostCommand
- [Phase 06]: La CSP de documentos vive solo en src/proxy.ts; next.config.ts no emite CSP para HTML, asi que no hay dos politicas que se pisen
- [Phase 06]: style-src conserva unsafe-inline por los atributos style dependientes de datos y no se anade upgrade-insecure-requests porque Playwright y el desarrollo van por localhost
- [Phase 06]: HSTS se emite en la aplicacion con max-age=15552000 sin includeSubDomains ni preload para no arrastrar a otros servicios del dominio ni adoptar una decision casi irreversible
- [Phase 06]: zod se ejecuta jitless en el cliente para que su sonda de eval no cuente como violacion de CSP; la validacion sigue siendo del servidor
- [Phase 06]: 06-03: la UI decide con requiresVerificationForCommand; check-health se envía directo con sendHostCommand y el resto pasa por useSensitiveAction
- [Phase 06]: 06-03: onSettled del diálogo reconstruye el estado HTTP (502 pendiente, 400 fallo, 200 éxito) para reutilizar un único applyResult en la tarjeta
- [Phase 06]: 06-04: readBodyText cuenta bytes en streaming y decodifica una sola vez; Content-Length solo es un atajo de rechazo
- [Phase 06]: 06-04: deployments/settings declara su propio tope de 64 KiB alineado con MAX_REQUEST_BYTES del agente
- [Phase 06]: 06-04: return await de handlePasswordVerification para que BodyTooLarge llegue al 413 del catch-all
- [Phase 06]: 06-05: routeVerdict compara el nombre exacto con Object.hasOwn y el catch-all lo consulta tras la sesión (401 antes de 404 y 405); setup comprueba el método antes de la sesión
- [Phase 06]: 06-05: las expresiones regulares de incidencias viven en el manifiesto y el despachador las importa; ProtectedPostRoute se deriva del tipo y exige un fixture por ruta protegida
- [Phase 06]: 06-05: el envoltorio de Better Auth acota el POST a 32 KiB, reconstruye la petición sin content-length y deja pendiente confirmar las exenciones presence, verification/password y DELETE push (A10)
- [Phase 06]: 06-06: un exceso de respuesta del agente es NasInvalidResponse(ResponseTooLarge), o NasRejected con su estado si la respuesta ya era un error, para que colector y deploy-progress lo traten como contrato roto sin cambios
- [Phase 06]: 06-06: el listado de archivos solo conserva las entradas cuando el fallo es de la misma raiz y carpeta que las cargadas
- [Phase 07]: P-01: handoff token = HMAC-SHA256 of the intent id under a subkey of BETTER_AUTH_SECRET; only its SHA-256 is stored
- [Phase 07]: P-03: keyboard-only edits use outbox key incident:<id>:kb:<discriminator> because queueEdit keys on seq
- [Phase 07]: P-04: an intent binds to the sole user of the instance; zero or several users fail closed
- [Phase 07]: P-06: TELEGRAM_ACTIONS gains eight values at once; menu_open, menu_close and intent_cancel stay ignored until 07-03
- [Phase 07]: P-26: decide Host, not forwarded host or protocol, because the client can set those and the proxy need not overwrite them
- [Phase 07]: P-27: Origin and Host compared by hostname without the port
- [Phase 07]: P-28: no Host header falls back to the request.url hostname; a Host list, empty or unreadable value falls to passkey
- [Phase 07]: P-30: login host not stored in the session; the method is decided per request
- [Phase 07]: 07-02: el guard de intent va antes del 501, así restart y reboot sin verificación responden 403 y start responde 501 sin pedir passkey
- [Phase 07]: 07-02: execute decide lo protegido por la acción almacenada y el manifiesto de la fase 6; 403, 503 y 501 responden antes del reclamo y no consumen el intent
- [Phase 07]: P-12: la vista del teclado vive en notification_outbox.keyboardView de la fila :open; cada edición de menú usa m<hash16 del token consumido>
- [Phase 07]: P-13: la caducidad visible se descubre con una fila :expire con nextAttemptAt = expiresAt y caducidad perezosa en cada render, sin barrido nuevo
- [Phase 07]: P-14: la línea de resultado usa un Record<IntentActionId,string> privado; reboot se redacta como reinicio solicitado; actuar no reconoce la incidencia
- [Phase 07]: P-15: los intents se retienen 24 h tras expiresAt y la limpieza los cuenta como intents
- [Phase 07]: 07-04: runAgentAction devuelve un resultado neutro y cada llamador lo traduce; el id del contenedor se resuelve por nombre al ejecutar (409 sin consumir si ya no existe)
- [Phase 07]: 07-04: un reboot aceptado cierra el intent executed y deja la operación pending hasta que el colector confirma bootAt; la confirmación la aporta el servidor (D-12)
- [Phase 07]: 07-04: TELEGRAM_DIRECT_ACTIONS solo se valida (0 o ausente) y no añade campo a RuntimeConfig
- [Phase 07]: P-20 a P-24: confirmar y verificar son un solo paso; el token del handoff vive en sessionStorage (hub.handoff) hasta un estado terminal y captureHandoff es idempotente; un 401 de inspect recarga la página; cerrar el diálogo deja dismissed; useSensitiveAction gana requiresVerification
- [Phase 07]: 07-05: pending borra el token y no ofrece reintento; failed lo conserva y reintenta solo con inspect, sin llamar a execute
- [Phase 08]: 08-06: backup-failed se publica firmado en el ingest con 3 intentos (0 30 60) y mismo eventId; solo sin 2xx cae a un unico aviso directo de Telegram con prefijo fijo y token por curl -K -
- [Phase 08]: 08-06: media-stack phase-08-cutover lleva 3 commits (1e5666c, dc6a4f1, 7cba1ae) y no se integra en main hasta la puerta 08-10
- [Phase 08]: 08-07 P-22: issue-automator routes by notification type; ISSUE_RESOLVED only publishes the closing, other explicit types are ignored
- [Phase 08]: 08-07 P-23: build_issue_event/deliver_issue_event are the seam 08-15 replaces with the durable outbox; delivery is one attempt, 2xx only
- [Phase 08]: 08-07 P-24: NOTIFY_INGEST_URL/SECRET/HOST_ID go together or none; load_config returns ingest instead of telegram
- [Phase 08]: 08-08 P-25: upgrade.sh notify() pasa a notice(), solo escribe notice: <texto> con UNATTENDED=1; sin lectura de Telegram ni curl
- [Phase 08]: 08-08 P-26: merged_updates.py y updater.py pierden envios y colas; los avisos pasan a print y los outcomes solo fijan el codigo de salida; main.py pierde telegram y digest y conserva notified-updates.json
- [Phase 08]: 08-08: media-stack phase-08-cutover lleva 8 commits (ultimo 907369e) y no se integra en main hasta la puerta 08-10
- [Phase 08]: P-27: WUD queda sin trigger de notificacion (WUD_TRIGGER_TELEGRAM_* eliminadas); estado en su UI y en security-monitor
- [Phase 08]: P-28: TELEGRAM_BOT_TOKEN/CHAT_ID solo en el alcance instance; apps-server los pierde en catalogo, plantilla y .env.example (claves sobrantes solo advierten)
- [Phase 08]: P-29: guarda estatica de emisores de Telegram como tests/*.test.sh (find y grep sin git, controles negativos sobre copia alterada); la ejecuta check.sh ci sin cambios
- [Phase 08]: P-30: comentarios wud.tag.transform de arr, jackett, vo y vpn sin mencion a Telegram ni al umbral de WUD
- [Phase 08]: 08-15 P-42/P-43: issue-automator outbox is one atomic JSON file per event in APPDATA_ROOT/issue-automator mounted on /outbox (run as PUID:PGID, folder declared in PROFILE_DIRS[extras]); SQLite, a broker and in-memory retries rejected
- [Phase 08]: 08-15 P-44/P-45: retry on any non-2xx with backoff 15s doubling to 900s, same body and eventId, fresh signature with the current secret; limits 14 days and 200 events; a closing never leaves before its opening is confirmed
- [Phase 08]: 08-15 P-46: issue-automator exits 1 at start, naming the folder and scripts/init.sh, when the outbox cannot be written; last phase-08-cutover commit ab88c11
- [Phase 08]: P-31: pasos de produccion de la puerta 1 como checkpoint:human-action (D-11); PR de media-stack abierto en borrador hasta probar el ingest
- [Phase 08]: 08-10: NOTIFY_INGEST_URL = http://100.74.226.92:4323/api/notifications/ingest (Tailscale), probada desde un contenedor del NAS; emisor SMART externo no encontrado

### Pending Todos

None yet.

### Blockers/Concerns

Ningún bloqueo para planificar la fase 8.
- [Fase 07] Desplegada en producción el 2026-11-27 (migración 0008; copia previa en webs:~/hub-backups/pre-phase07-202611271945.dump). UAT real 4/4: handoff con passkey, caducidad a 5 min, Host de NPM y Tailscale Serve. `main` local va por delante de `origin/main` (sin push). Se mantiene D-05: una intención pendiente sigue valiendo si la incidencia se resuelve.
- [Fase 06] CR-01 corregido en la fase 7 (D-13) y validado en producción por la UAT 07 test 3; actualizar su estado en `06-REVIEW-DISPOSITION.md`. WR-01 a WR-04 siguen `open`.
- [Fase 06] La entrada pública pasó al NPM de Oracle el 2026-11-27; el NPM del NAS se retiró y el cron de DonDNS del NAS está desactivado.
- [Fase 05] Pendiente de observar: la etiqueta del episodio reconocido en el resumen del 2026-11-28 y la escalada con Por qué (temperature es siempre crítica).
- [Fase 05] `05-VALIDATION.md` sigue en draft: `/gsd-validate-phase 5` no se completó.
- [Fase 04] Para probar el healthcheck del worker hay que congelar el proceso `node`, no el contenedor: `docker kill -s SIGSTOP` solo para `pnpm` (PID 1).

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-28T10:07:33.017Z
Stopped at: Completed 08-10-PLAN.md
Resume file: None
