# Phase 1: Auditoría del ruido - Context

**Gathered:** 2026-11-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Esta fase **mide, no construye**. Entrega un informe que responde, con datos, qué avisos llegan, de qué emisor, con qué frecuencia y cuántos son recuperaciones, repeticiones o duplicados entre sistemas; y de ese informe sale el mapa definitivo de qué aviso es inmediato, cuál va al digest y cuál se silencia, más el orden de apagado de los emisores de `media-stack` y el objetivo numérico de éxito.

No entra en esta fase: implementar la incidencia, el outbox, el bot ni el digest (fases 2–8), ni cambiar `media-stack` (fase 8). La única escritura de producto permitida sería un contador temporal de push si se decide medir en vivo, y no es el camino por defecto.

</domain>

<decisions>
## Implementation Decisions

### Fuentes y acceso
- **D-01:** La fuente primaria es el **export HTML del chat** (`messages.html`, 148 mensajes entre el 25 abr y el 24 nov de 2026), facilitado por el usuario en `/Users/albertsalom/Downloads/ChatExport_NAS Monitor/`. Contiene fecha, remitente y texto de cada mensaje. — **Reversibility:** reversible
- **D-02:** La atribución por emisor (WUD, security-monitor, backup, issue-automator, upgrade) se hace por el texto y por los logs/archivos de estado de `media-stack`; el export solo identifica al bot `NAS Monitor`, no al job que envió.
- **D-03:** El histórico de push del hub (tabla `alerts`) queda como **fuente condicionada**: T3 Code deniega vincular el servidor Oracle desde este hilo (*"needs a live full-access/default calling thread"*) y no hay alias SSH configurado. El plan no puede bloquear la mitad de Telegram por esto; si se resuelve el acceso, el informe añade la columna de push.
- **D-04:** No se añade instrumentación al hub para medir push en vivo en esta fase salvo que falle D-03 y el usuario lo pida después; el export cubre el canal que hoy genera el ruido.

### Ventana histórica
- **D-05:** Se segmenta por **eras de cambio**, no por un periodo plano:

  | Era | Periodo | Mensajes | Ritmo |
  |---|---|---:|---:|
  | E1 pre-arreglos | 25 abr – 27 sep | 8 | 0,04/día |
  | E2 arreglo WUD | 28 sep – 2 nov | 105 | 2,92/día |
  | E3 auto-release | 3 – 12 nov | 20 | 2,00/día |
  | E4 actual | 13 – 24 nov | 15 | 1,15/día |

  La **era actual (E4)** es la línea base de la política; E2 y E3 son comparación; el export completo queda como tendencia. — **Reversibility:** reversible
- **D-06:** El informe debe marcar explícitamente qué mensajes preceden a los commits que cambiaron el comportamiento: `d6831af` (3 nov, silenciar rebuilds de linuxserver en WUD), `38061f0` (3 nov, releases y actualizaciones automáticas), `16d824e` (16 oct, arreglo de avisos de security-updates) y la actualización a WUD 9.8.0 (8 nov).

### Unidad de medida
- **D-07:** Siempre **doble cifra**: eventos reales y mensajes enviados. La política se juzga por mensajes (lo que el operador percibe); la reducción se explica por eventos.
- **D-08:** Un **evento WUD** es una pasada de escaneo con uno o más tags nuevos, no cada contenedor. El detalle por contenedor se queda en la UI de WUD y no vuelve a generar mensajes.
- **D-09:** El informe separa dos clases de ruido que no son lo mismo:
  - **duplicado entre sistemas**: el mismo hecho contado por WUD y por la auto-actualización (13 de 95 mensajes WUD tienen una actualización del mismo contenedor en ±2 días),
  - **repetición del mismo evento**: WUD reavisa del mismo tag pendiente en cada escaneo (11 eventos repetidos, `qbittorrent → ls478` hasta 4 veces).

### Política de canales decidida durante la discusión
- **D-10:** **WUD deja de notificar por Telegram.** Su UI se mantiene para consultar; el digest puede llevar el recuento de actualizaciones pendientes. — **Reversibility:** costly — deshacerlo toca `media-stack` (compose y docs), la política del hub y el digest; el token y los triggers volverían a estar activos en dos sitios.
- **D-11:** **Auto-actualizaciones**: el éxito ("actualizada; salud correcta") va al digest; el fallo y el `manual review` llegan al momento porque exigen acción del operador. — **Reversibility:** costly — cambia qué claves son inmediatas en `policy.ts` y la sección del digest; revertirlo reintroduce el chorro de mensajes de éxito.
- **D-12:** El **objetivo numérico de éxito** no se fija en la discusión: el informe lo propone a partir de E4 (1,15 mensajes/día hoy) y el usuario lo valida al leerlo. — **Reversibility:** reversible

### the agent's Discretion

- Formato exacto del informe (tablas, secciones, nombre del archivo dentro del directorio de la fase).
- Parser del HTML y tratamiento de mensajes sin hora o con fecha duplicada.
- Cómo atribuir emisor cuando el texto es ambiguo (preferir logs de `media-stack` antes que adivinar).
- Estructura de la comparación entre eras y redondeo de los ritmos.
- Si el acceso al Oracle aparece a mitad de fase, cómo incorporar la columna de push sin rehacer el informe.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Planificación
- `.planning/ROADMAP.md` §Phase 1 — objetivo, requisitos AUDT y criterios de éxito.
- `.planning/REQUIREMENTS.md` §Auditoría — AUDT-01 a AUDT-05.
- `.planning/research/SUMMARY.md` §"La auditoría primero: qué mide y qué desbloquea" — los siete números y las cuatro decisiones que desbloquea.
- `.planning/research/PITFALLS.md` — pitfall 24 (hub caído = silencio) y el checklist de emisores; útil para el orden de apagado.
- `.planning/codebase/CONCERNS.md` — claves de alerta existentes y su comportamiento actual.

### Código del hub (para saber qué se mide)
- `src/lib/collector.ts` — `condition()`, debounce en memoria y claves `container:<name>`, umbrales, `expectedContainers`.
- `src/lib/maintenance-alerts.ts` — claves `backup-failed`, `disk-health`, `reboot-pending`, `stack-unit-failed`, `release-retained`, `deploy-failed`.
- `src/lib/push.ts` — `notify()` sin severidad ni preferencias.
- `src/lib/schema.ts` — tabla `alerts` (`at`, `resolvedAt`, `hostId`, `key`), única fuente del histórico de push.
- `src/lib/madrid-day.ts` — calendario de Madrid, reutilizable para la distribución horaria.

### `media-stack` (emisores actuales; lectura, sin commits)
- `/Users/albertsalom/Proyectos/Servidores/media-stack/stacks/monitoring/compose.yaml` — configuración de WUD y del security-monitor, `TELEGRAM_*`.
- `/Users/albertsalom/Proyectos/Servidores/media-stack/stacks/arr/compose.yaml` (y `vo`, `vpn`, `jackett`) — labels `wud.tag.transform` añadidos en `d6831af`.
- `/Users/albertsalom/Proyectos/Servidores/media-stack/scripts/upgrade.sh` — mensajes de release y auto-actualización.
- `/Users/albertsalom/Proyectos/Servidores/media-stack/scripts/auto-release.sh` — flujo que introdujo el chorro de E3/E4.
- `/Users/albertsalom/Proyectos/Servidores/media-stack/stacks/monitoring/security-monitor/main.py` — texto y agrupación del digest de seguridad.
- `/Users/albertsalom/Proyectos/Servidores/media-stack/stacks/backup/media-backup.sh` — alerta de copia y fallback directo.
- `/Users/albertsalom/Proyectos/Servidores/media-stack/docs/profiles.md` — política documentada de avisos por perfil.

### Fuente externa (no versionada)
- `/Users/albertsalom/Downloads/ChatExport_NAS Monitor/messages.html` — export del chat, 148 mensajes, 25 abr – 24 nov 2026. Es el dataset de la fase; no se copia al repo.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/madrid-day.ts`: helpers de calendario de Madrid; sirven para agrupar la distribución horaria sin escribir un parser de fechas nuevo.
- `src/lib/maintenance-alerts.ts` y `src/lib/collector.ts`: catálogo real de claves de alerta que el informe debe mapear a inmediato/digest/silencio.
- Tabla `alerts` (`src/lib/schema.ts`): histórico de push con `at` y `resolvedAt`; es la única fuente para medir recuperaciones del hub si se consigue el Oracle.
- `media-stack/tests/*.sh`: patrones de test de shell y fixtures; útiles si el parser del export se prueba con muestras.

### Established Patterns
- El repo no acopla tests al copy (`CODING_STANDARD.md`); el informe es un documento, pero cualquier script de análisis que se añada debe probarse por salida/estructura, no por texto en español.
- Drizzle + PostgreSQL como único estado durable; no se introduce SQLite ni ficheros de estado nuevos.
- `media-stack` usa scripts Python/shell con tests propios; la fase solo los lee.

### Integration Points
- El informe vive en `.planning/phases/01-auditor-a-del-ruido/` y alimenta la política de la fase 2 (`policy.ts`) y el orden de apagado de la fase 8.
- El mapa de claves se convierte en la tabla de decisión que `src/lib/notifications/policy.ts` implementará en la fase 2.
- La lista de emisores de `media-stack` y sus familias es la entrada del cutover de la fase 8.

</code_context>

<specifics>
## Specific Ideas

- El usuario no quiere "menos información" sino **menos interrupciones**: un aviso por incidencia, sin recuperaciones, y lo no urgente en un resumen diario.
- "Todo lo que me llega de Telegram" es el canal que le molesta; el push del hub no se percibe como problema hoy.
- WUD "no pide nada": su aviso de tag nuevo no requiere acción y ya hay dos sistemas que actúan (security-monitor y Renovate/auto-release).
- El usuario cambió el comportamiento recientemente (commits del 16 oct y 3 nov); el informe debe mostrar el efecto de esos cambios, no un promedio que los oculte.

</specifics>

<deferred>
## Deferred Ideas

- **Vista de actualizaciones disponibles en el hub** — si WUD sale de Telegram, ver el detalle en una vista propia del hub es un candidato para una fase posterior; no está en el alcance de la fase 1 ni en el roadmap actual.
- **Medir push en vivo con un contador temporal** — solo si falla el acceso al Oracle y el usuario lo pide; no es el camino por defecto.
- **Silencio nocturno, presupuesto de supresión y escalado** — ya están en v2 de `REQUIREMENTS.md`; la fase 1 no los decide.

Ninguna idea de la discusión quedó fuera del alcance por error; las tres anteriores son capacidades de otras fases.

</deferred>

---

*Phase: 1-Auditoría del ruido*
*Context gathered: 2026-11-24*
