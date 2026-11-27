---
gsd_state_version: "1.0"
current_phase: 06
current_phase_name: Puerta de seguridad
status: executing
stopped_at: Completed 06-05-PLAN.md
last_updated: "2026-11-27T12:14:48.921Z"
last_activity: 2026-11-27
last_activity_desc: Phase 06 execution started
state_head: 59f9ae7641124a33cb436224ab89263e28fde747
progress:
  total_phases: 8
  completed_phases: 5
  total_plans: 26
  completed_plans: 25
  percent: 63
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-27)

**Core value:** Saber en segundos qué está pasando en los dos servidores y poder actuar sobre ellos sin abrir una consola.
**Current focus:** Phase 06 — Puerta de seguridad

## Current Position

Phase: 06 (Puerta de seguridad) — EXECUTING
Plan: 6 of 6
Status: Ready to execute
Last activity: 2026-11-27 — Phase 06 execution started

Progress: [██████░░░░] 63%

## Performance Metrics

**Velocity:**
- Total plans completed: 20
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

### Pending Todos

None yet.

### Blockers/Concerns

Ningún bloqueo para planificar la fase 6.
- [Fase 05] Las fases 2–5 se desplegaron en producción el 2026-11-27 (copia previa en `~/hub-deploy/20261127-074705` del servidor); `main` local sigue 160+ commits por delante de `origin/main` sin push.
- [Fase 05] Pendiente de observar: la etiqueta del episodio reconocido en el resumen del 2026-11-28 y la escalada con Por qué (temperature es siempre crítica).
- [Fase 05] `05-VALIDATION.md` sigue en draft: `/gsd-validate-phase 5` no se completó.
- [Fase 04] Para probar el healthcheck del worker hay que congelar el proceso `node`, no el contenedor: `docker kill -s SIGSTOP` solo para `pnpm` (PID 1).

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-27T12:14:48.557Z
Stopped at: Completed 06-05-PLAN.md
Resume file: None
