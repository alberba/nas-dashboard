---
gsd_state_version: "1.0"
current_phase: 05
current_phase_name: Bot de lectura y reconocimiento
status: executing
stopped_at: Completed 05-01-PLAN.md
last_updated: "2026-11-26T13:40:19.666Z"
last_activity: 2026-11-26
last_activity_desc: Phase 05 execution started
state_head: b117d7aa775f4e9ca3d5e9b3353873212f860a72
progress:
  total_phases: 8
  completed_phases: 4
  total_plans: 20
  completed_plans: 15
  percent: 50
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-26)

**Core value:** Saber en segundos qué está pasando en los dos servidores y poder actuar sobre ellos sin abrir una consola.
**Current focus:** Phase 05 — Bot de lectura y reconocimiento

## Current Position

Phase: 05 (Bot de lectura y reconocimiento) — EXECUTING
Plan: 2 of 6
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

Last session: 2026-11-26T13:40:19.348Z
Stopped at: Completed 05-01-PLAN.md
Resume file: None
