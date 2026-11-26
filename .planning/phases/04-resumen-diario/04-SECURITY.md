---
phase: "04"
slug: "resumen-diario"
status: verified
threats_open: 0
asvs_level: 1
created: "2026-11-26"
---

# Phase 04 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Entorno → arranque | La hora del resumen se valida junto a los datos del bot y la URL canónica. | Configuración no secreta y valores de entorno validados. |
| Worker → PostgreSQL y Telegram | La sesión propietaria reclama una fecha y el acuse remoto se valida antes de marcarla enviada. | Texto del resumen, token y chat ID quedan en el servidor. |
| Episodios → Telegram | Solo los episodios elegibles y los campos necesarios llegan al chat existente. | Títulos y contadores acotados; sin cuerpos internos. |
| PostgreSQL → overview autenticado | El navegador recibe un estado finito y fechas, independiente del host seleccionado. | Estado y motivo finito; nunca payload, token ni destino. |
| Proceso → probe local | Docker solo lee la marca privada de progreso de su propio contenedor. | Marca local de progreso; sin red ni privilegios nuevos. |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-04-01 | Tampering | Claim diario y marca de inicio | high | mitigate | Clave única por fecha, token de reclamación, lease y fencing; marca durable antes del POST. Tests: `does not let a competing session deliver the same date`, `recovers a claim that expired before the attempt started`, `expires when the clock crosses the deadline during the start mark`. | closed |
| T-04-02 | Denial of service | Pausa Telegram y hora operativa | medium | mitigate | `DIGEST_TIME` validado con formato HH:mm; cooldown durable compartido; ventana de recuperación y límite de intentos. Tests: `defaults the daily digest to 08:00 Europe/Madrid`, `honours retry_after across a restart and shares the cooldown`, `delays a new digest while a confirmed Telegram 429 is active`, `shares the pause from a confirmed edit 429 with the digest`. | closed |
| T-04-03 | Information disclosure | Selección y texto del resumen | medium | mitigate | Selección por apertura durable y hosts configurados; texto plano acotado y enlace autenticado. Tests: `builds the daily cohorts and counters from the durable disposition`, `sends a footer-only digest when there is activity but no eligible row`. | closed |
| T-04-04 | Tampering | Inclusión de episodios y reintento | medium | mitigate | Payload congelado al preparar; el agregado nunca escribe una entrega individual. Tests: `repeats the frozen digest after an authorized retry even when the episodes change`, `sends one digest per Madrid date with frozen content and keeps it after a restart`. | closed |
| T-04-05 | Information disclosure | Overview y eventos del worker | high | mitigate | Proyección autenticada con motivos públicos finitos; el log de transición no incluye token, chat ID, texto ni cuerpo remoto. Tests: `keeps the digest projection behind a session`, `projects the latest digest target globally with a finite reason`, `drops an unknown digest reason, keeps a prepared claim pending and reports zero history`, `reports one bounded failure transition for a confirmed rejection` (asserta ausencia de `BOT_TOKEN`, `CHAT_ID` y del texto). | closed |
| T-04-06 | Spoofing | Señal sana de proceso bloqueado | medium | mitigate | Marca renovada solo tras hitos del bucle dueño del lock, revalidación del lock tras cada await, identidad de arranque y antigüedad acotada. Tests: `marks a stopped loop unhealthy while the process is still alive and recovers`, `rejects a fresh mark from a reused PID with another start identity`, `rejects missing, malformed, future, unsafe, dead and unreadable marks`, `test_a_stopped_loop_is_unhealthy_while_the_process_is_still_alive`, `test_a_lock_held_by_another_thread_blocks_progress_and_recovery`. | closed |
| T-04-07 | Elevation of privilege | Probe del agente | high | mitigate | Probe local de solo lectura que no inicia servidor, hebras, socket Docker ni comandos del host; sin puertos, volúmenes ni privilegios nuevos. Tests: `test_the_probe_exit_code_does_not_start_the_server`, `test_health_mode_exits_before_the_token_check`; ambos Compose validados sobre la misma imagen. | closed |
| T-04-SC | Tampering | Dependencias | high | mitigate | Sin paquetes nuevos: `package.json`, `pnpm-lock.yaml` y `agent/requirements.txt` sin cambios en el rango de la fase; se conservan Drizzle, Intl y el cliente Telegram existentes. | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

No accepted risks.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-26 | 8 | 8 | 0 | gsd-execute-phase orchestrator (L1 grep-depth, ASVS 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-26

## Security Audit 2026-11-26

| Metric | Count |
|---|---|
| Threats found | 8 |
| Closed | 8 |
| Open | 0 |
