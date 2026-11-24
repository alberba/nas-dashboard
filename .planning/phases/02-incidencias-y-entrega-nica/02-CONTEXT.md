# Fase 2 · Incidencias y entrega única

**Fecha:** 2026-11-24
**Estado:** Lista para planificar

<domain>
## Alcance

Convertir las observaciones del agente en incidencias persistentes por host y clave. Cada incidencia tiene un solo aviso inicial, gestionado mediante un outbox transaccional por el worker que posee el lock de recolección. El hub muestra el estado de entrega y el mensaje de Telegram incluye un enlace autenticado a la vista correspondiente. La fase incluye la validación de las respuestas del agente y de la configuración de arranque.

La agrupación por caída de host, el envío del resumen diario, los callbacks del bot y el cambio de emisores de `media-stack` corresponden a fases posteriores.

</domain>

<decisions>
## Decisiones de implementación

### Envío sin confirmación

- **D-01:** Si Telegram pudo aceptar el envío inicial y el worker perdió la confirmación, registrar un resultado de entrega incierto y mostrar el motivo en el hub. Ese intento no se reenvía automáticamente y tampoco activa el push de respaldo, incluso para críticas. Una entrega incierta no equivale a un fallo definitivo.
- **D-02:** Se mantiene el push de respaldo para incidencias críticas cuando el fallo de Telegram es definitivo y está confirmado. Los rechazos 429 se reintentan según `retry_after`. Los 400, 403 y 404 se registran como fallos permanentes y visibles.

### Incidencias abiertas al migrar

- **D-03:** Conservar los avisos existentes en el hub al migrar de `alerts` a `incidents`. El backfill y el primer arranque no generan un nuevo aviso por las incidencias que ya estaban abiertas, aunque se confirme que sigan críticas. Las incidencias nuevas siguen la política de la fase 1.

### Escalada a crítica

- **D-04:** Recalcular la severidad en cada evaluación válida y reflejar la transición en el hub. Si la incidencia esperaba el resumen y todavía no se había enviado, la escalada a crítica activa su primer aviso inmediato según la política de críticas.
- **D-05:** Si ya llegó por push, actualizar la notificación existente en la bandeja con la misma etiqueta y sin volver a interrumpir. La escalada no abre un envío por Telegram. El plan debe comprobar cómo evitar que la actualización vuelva a mostrar un aviso descartado.
- **D-06:** Si ya hay mensaje en Telegram, editar ese mismo mensaje al cambiar la severidad. Cuando una incidencia se resuelve, usar el aviso original o su registro para el futuro resumen, sin emitir un nuevo mensaje de recuperación.

### Decisiones delegadas a la planificación

- Determinar cómo presentar el estado de entrega y su motivo en la vista existente de Avisos.
- Resolver el modelo de estados del outbox, los límites de reintento y el tratamiento de un lease vencido según conste si llegó a iniciarse la petición. Mantener la distinción entre rechazo confirmado y entrega incierta.
- Detallar la migración reversible y la resolución de duplicados abiertos conservando el histórico. No dar por hecho que un aviso previo tiene un identificador remoto disponible para editar.

</decisions>

<canonical_refs>
## Referencias para planificar

- `.planning/ROADMAP.md` (§ Phase 2) recoge el alcance y los criterios de éxito.
- `.planning/REQUIREMENTS.md` recoge INCD-01 a INCD-08, BOT-01, BOT-03, SEC-03 y CONT-01.
- `.planning/PROJECT.md` y `.planning/STATE.md` recogen las restricciones de despliegue y las decisiones previas sobre los canales y la migración.
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` fija qué claves se entregan al momento, van al resumen o quedan silenciosas.
- `.planning/research/ARCHITECTURE.md` aporta antecedentes del outbox y los canales. D-01 prevalece sobre su propuesta de aceptar duplicados para críticas cuando el envío queda incierto.
- `.planning/codebase/ARCHITECTURE.md` y `.planning/codebase/INTEGRATIONS.md` describen el worker, el cliente del agente y Web Push.
- `CODING_STANDARD.md` define cómo comprobar los resultados sin acoplar los tests al texto de la interfaz.

</canonical_refs>

<code_context>
## Código existente

- `src/worker.ts` ya adquiere el advisory lock de PostgreSQL. Es el punto de integración para despachar el outbox.
- `src/lib/collector.ts` evalúa condiciones y actualmente llama al envío directo al abrir o resolver. `src/lib/maintenance-alerts.ts` traduce los snapshots en señales de mantenimiento y despliegue.
- `src/lib/schema.ts` define `alerts`. `src/app/api/[...path]/route.ts` sirve los avisos en el overview y `src/components/views/alerts.tsx` los presenta.
- `src/lib/nas.ts` centraliza las llamadas al agente y sus errores. Es el punto de validación de las respuestas antes de evaluar condiciones.
- `src/lib/push.ts` y `public/sw.js` ya pasan la etiqueta de notificación. El service worker apunta actualmente a la lista general y no distingue una actualización silenciosa.
- `src/components/views/routes.ts` contiene los helpers de navegación del dashboard. El plan debe ampliar el destino del enlace para localizar la incidencia tras iniciar sesión.

</code_context>

<specifics>
## Casos que debe cubrir el plan

- Telegram recibe el aviso inicial y el worker pierde la respuesta.
- Una crítica abierta antes de la migración sigue abierta tras el primer ciclo del worker.
- Una advertencia que esperaba el resumen pasa a crítica por primera vez.
- Una advertencia entregada por push pasa a crítica con el aviso todavía en la bandeja, y también después de que el operador lo haya descartado.

</specifics>

<deferred>
## Ideas pendientes

La discusión no añadió ideas fuera del alcance de la fase.

</deferred>
