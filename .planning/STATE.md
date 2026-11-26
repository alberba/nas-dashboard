---
gsd_state_version: "1.0"
current_phase: 05
current_phase_name: Bot de lectura y reconocimiento
status: executing
stopped_at: Completed 05-03-PLAN.md
last_updated: "2026-11-26T14:44:33.019Z"
last_activity: 2026-11-26
last_activity_desc: Phase 05 execution started
state_head: 1865f44078104af32f89e9fcf19ff87833b67a92
progress:
  total_phases: 8
  completed_phases: 4
  total_plans: 20
  completed_plans: 18
  percent: 50
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-26)

**Core value:** Saber en segundos qué está pasando en los dos servidores y poder actuar sobre ellos sin abrir una consola.
**Current focus:** Phase 05 — Bot de lectura y reconocimiento

## Current Position

Phase: 05 (Bot de lectura y reconocimiento) — EXECUTING
Plan: 5 of 6
Status: Ready to execute
Last activity: 2026-11-26 — Phase 05 execution started

Progress: [█████░░░░░] 50%

## Performance Metrics

**Velocity:**
- Total plans completed: 14
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | - | - |
| 02 | 5 | - | - |
| 3 | 3 | - | - |
| 04 | 3 | - | - |

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

### Pending Todos

None yet.

### Blockers/Concerns

Ningún bloqueo para planificar la fase 5.
- [Fase 04] Para probar el healthcheck del worker hay que congelar el proceso `node`, no el contenedor: `docker kill -s SIGSTOP` solo para `pnpm` (PID 1).

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-26T14:44:32.719Z
Stopped at: Completed 05-03-PLAN.md
Resume file: None
