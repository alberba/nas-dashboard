---
gsd_state_version: "1.0"
current_phase: 02
current_phase_name: Incidencias y entrega única
status: executing
stopped_at: Contexto de la fase 2 acordado
last_updated: "2026-11-25T07:09:17.656Z"
last_activity: 2026-11-25
last_activity_desc: Phase 02 execution started
state_head: 11352daf78764610f1da488546b227757a0b63d0
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 8
  completed_plans: 3
  percent: 13
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-24)

**Core value:** Saber en segundos qué está pasando en los dos servidores y poder actuar sobre ellos sin abrir una consola.
**Current focus:** Phase 02 — Incidencias y entrega única

## Current Position

Phase: 02 (Incidencias y entrega única) — EXECUTING
Plan: 1 of 5
Status: Executing Phase 02
Last activity: 2026-11-25 — Phase 02 execution started

Progress: [█░░░░░░░░░] 13%

## Performance Metrics

**Velocity:**
- Total plans completed: 3
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | - | - |

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

### Pending Todos

None yet.

### Blockers/Concerns

Ningún bloqueo para planificar la fase 02.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-24T21:36:30.444Z
Stopped at: Contexto de la fase 2 acordado
Resume file: .planning/phases/02-incidencias-y-entrega-nica/02-CONTEXT.md
