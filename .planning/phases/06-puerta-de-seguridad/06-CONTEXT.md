# Phase 6: Puerta de seguridad - Context

**Gathered:** 2026-11-27
**Status:** Ready for planning

<domain>
## Phase Boundary

El servidor exige verificación reciente (passkey o contraseña, ventana existente de 5 min por sesión) en toda acción destructiva, no solo la UI. La clasificación de cada mutación (protegida o exenta) vive en un único módulo y un test falla si una mutación nueva no se declara. Además se endurece la frontera HTTP del hub: CSP conservadora, HSTS, límite de cuerpo en mutaciones antes de parsear y tope de tamaño en lo que el hub lee del agente.

Requisitos: SEC-01, SEC-02, SEC-04. Fuera: acciones desde Telegram (fase 7), cambios en el agente Python, rotación del token (SEC-05).

</domain>

<decisions>
## Implementation Decisions

### Frontera de lo protegido (SEC-01)
- **D-01:** Contenedores: `stop`, `restart`, `update-container` y la eliminación (ya protegida) exigen verificación reciente. `start` queda exento: no pierde datos ni corta servicio.
- **D-02:** Archivos: solo lo irreversible se protege, `purge` y `empty-trash`. `trash`, `move` y `restore` quedan exentos (la papelera de 7 días es la red de seguridad).
- **D-03:** Comandos de host: se protegen los siete que cambian estado (`deploy-now`, `pause-follower`, `resume-follower`, `run-security`, `backup-now`, `clean-images`, `reconnect-apps`). `check-health` queda exento porque solo lee; la UI deja de pedir passkey para `check-health` para que UI y servidor coincidan.
- **D-04:** Se mantienen protegidas las que ya lo están: `reboot`, eliminación de contenedor, ajustes de releases retenidas (`deployments/settings`) y merge de Renovate.
- **D-05:** Reconocer, silenciar y quitar silencio desde el hub siguen exentos (decisión heredada de la fase 5, confirmada aquí).

### Declaración obligatoria (SEC-02)
- **D-06:** Toda mutación (cada `action` de `/api/action`, cada `host-command` y cada ruta mutante del catch-all) aparece en el módulo único como `protegida` o `exenta` con un motivo. Una mutación sin entrada hace fallar el test. Exentas explícitas esperadas: `start`, `trash`, `move`, `restore`, `check-health`, umbrales (`settings`), suscripción y prueba de push, acciones de incidencia, `setup`.
- **D-07:** La UI pide passkey exactamente para lo que el módulo marca como protegida; el servidor es la autoridad y la UI solo explica.

### Límite de cuerpo (SEC-04)
- **D-08:** Un helper compartido lee el cuerpo de toda mutación con un tope global pequeño (~16 KB) y responde 413 antes de parsear. Un `Content-Length` declarado por encima del tope se rechaza sin leer el cuerpo. Una ruta que necesite más (p. ej. ajustes de `.env` en `deployments/settings`) declara su propio tope explícito.
- **D-09:** El 413 solo responde con un mensaje en español; no crea operación, incidencia ni línea de log.

### Tope de respuesta (plan 06-03)
- **D-10:** El tope cubre lo que el hub lee del agente (logs, listados de directorio, journal de despliegues, etc.): el hub deja de leer al superar el tope en lugar de cargar la respuesta entera. El agente Python no se toca en esta fase.
- **D-11:** Al superar el tope, la vista muestra un error claro de respuesta demasiado grande y conserva el último dato válido; nunca se muestran datos parciales ni JSON truncado.

### Claude's Discretion
- CSP: forma concreta (nonce frente a `'self'` con lo mínimo que Next 16 requiera), si se arranca en Report-Only, y qué orígenes permite (`connect-src 'self'`, workers de push/PWA). Debe ser conservadora y no romper la PWA, las passkeys ni el service worker.
- HSTS: si lo emite la app, el proxy o ambos; `max-age` e `includeSubDomains` con criterio conservador, teniendo en cuenta el dominio principal (Nginx Proxy Manager) y el alternativo de Tailscale Serve. Documentar la decisión en el README.
- Fricción de la verificación: se mantiene la ventana de 5 min por sesión (`RECENT_VERIFICATION_TTL_MS`) salvo que el planner encuentre un motivo; la UX al recibir 403 `recent_verification_required` reutiliza el diálogo de acción sensible existente.
- Orden dentro de cada ruta: el replay idempotente puede seguir antes del guard como en `lifecycle.ts`, siempre que ninguna ejecución nueva ocurra sin verificación.
- Valor exacto de los topes de respuesta por tipo de lectura.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y requisitos
- `.planning/ROADMAP.md` §Phase 6 — objetivo, criterios de éxito y los tres planes 06-01..06-03
- `.planning/REQUIREMENTS.md` — SEC-01, SEC-02, SEC-04
- `.planning/phases/05-bot-de-lectura-y-reconocimiento/05-CONTEXT.md` — acciones de incidencia exentas por defecto; la fase 6 fija la lista

### Huecos conocidos
- `.planning/codebase/CONCERNS.md` — "Recent verification is UI-only for several destructive endpoints", "No Content-Security-Policy or HSTS from the app", "No request-body size limit at the Next.js boundary", "Log reads can allocate 64 MiB per request", listado de directorios sin paginar
- `.planning/codebase/ARCHITECTURE.md` — camino de mutación (origen → sesión → host → schema → guard) y "Recent verification"
- `.planning/codebase/INTEGRATIONS.md` — `recent_verification` y política de 5 minutos

### Normas
- `CODING_STANDARD.md` — los tests no se acoplan al copy; asertar estado, resultado (status HTTP) o estructura
- `AGENTS.md` — Next.js 16 difiere del conocido; leer `node_modules/next/dist/docs/` antes de tocar cabeceras, `next.config.ts` o proxy/middleware
- `README.md` — topología Nginx Proxy Manager + Tailscale Serve; dónde documentar HSTS/CSP

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/verification-api.ts` `guardSensitiveAction` — devuelve 403 `recent_verification_required` o `null`; solo confía en el registro del servidor.
- `src/lib/verification.ts` — `RECENT_VERIFICATION_TTL_MS` (5 min), `verificationStore`.
- `src/components/sensitive-action/sensitive-action.tsx` `useSensitiveAction` — diálogo que pide passkey y reintenta; usado por `command-search.tsx` y `views/maintenance.tsx`.
- `src/lib/validation.ts` `actionSchema` — unión discriminada de acciones de `/api/action`; base natural para enumerar acciones.
- `src/lib/host-command-contract.ts` / `src/lib/host-commands.ts` — lista cerrada de comandos de host.

### Established Patterns
- Llamadas actuales al guard: `route.ts:598` (solo `reboot`), `lifecycle.ts:212` (eliminar contenedor, tras el replay idempotente), `deployment-settings.ts:121`, `renovate-merge.ts:149`.
- Mutaciones con `request.json()` sin tope: `route.ts` (líneas ~146, 313, 548, 576, 783, 824, 852), `lifecycle.ts`, `verification-api.ts`, `host-commands.ts`.
- Cabeceras globales en `next.config.ts` `headers()` (nosniff, frame DENY, referrer, permissions); no hay `src/proxy.ts`/middleware.
- Origen comprobado antes de todo trabajo en el catch-all (`route.ts:112`).

### Integration Points
- `src/app/api/[...path]/route.ts` — dispatcher único de rutas mutantes; punto de enganche del módulo de acciones sensibles y del helper de cuerpo.
- `src/lib/nas.ts` y lectores de agente (`logs.ts`, `deployments.ts`, archivos) — donde aplicar el tope de lectura de respuestas.
- Fase 7 reutilizará este módulo para exigir verificación tras el handoff de Telegram.

</code_context>

<specifics>
## Specific Ideas

- El criterio de "destructiva" es: pierde datos de forma irreversible, corta servicio o cambia el estado del host. Lo recuperable (papelera) o de solo lectura queda exento.
- El servidor manda; la UI pide passkey para lo mismo y nada más.

</specifics>

<deferred>
## Deferred Ideas

- Bajar en `agent/` el tope de logs de 64 MiB y paginar el listado de directorios (CONCERNS, severidad media) — fase o tarea posterior.
- Pedir el nombre del elemento para confirmar `purge` (CONCERNS) — mejora de diseño, no incluida.

</deferred>

---

*Phase: 06-puerta-de-seguridad*
*Context gathered: 2026-11-27*
