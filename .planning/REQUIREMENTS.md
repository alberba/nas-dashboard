# Requirements: hub.

**Defined:** 2026-11-24
**Core Value:** Saber en segundos qué está pasando en los dos servidores y poder actuar sobre ellos sin abrir una consola.

## v1 Requirements

Alcance de este milestone: auditar el ruido, sustituir los emisores por una entrega única, añadir resumen diario y bot de Telegram con acciones verificadas, y cerrar los huecos de seguridad y consolidación que lo hacen posible.

### Auditoría

- [x] **AUDT-01**: El operador dispone de un informe con mensajes/día por emisor (WUD, security-monitor, copia, issue-automator, upgrade, hub) de los últimos 30–90 días
- [x] **AUDT-02**: El informe separa aperturas de recuperaciones y cuantifica los duplicados push + Telegram del mismo evento
- [x] **AUDT-03**: El informe incluye distribución horaria y el top 3 de claves por volumen
- [x] **AUDT-04**: El informe fija el mapa definitivo de alerta inmediata, digest o silenciosa, y el orden de apagado de emisores de `media-stack`
- [x] **AUDT-05**: El informe fija el objetivo de éxito medido (mensajes proactivos/día y tiempo hasta reconocer)

### Incidencias y entrega única

- [x] **INCD-01**: Cada condición vigilada produce una incidencia con identidad estable por host y clave que sobrevive a reinicios del worker
- [x] **INCD-02**: Una incidencia abierta no genera un segundo mensaje mientras su estado no cambie
- [x] **INCD-03**: Una incidencia resuelta no envía mensaje nuevo: actualiza el mensaje original o se cuenta en el resumen
- [x] **INCD-04**: La severidad se recalcula en cada evaluación y el cambio se refleja en la incidencia y en el mensaje
- [x] **INCD-05**: Todo envío pasa por un outbox transaccional; un fallo entre la decisión y el envío no pierde el aviso
- [x] **INCD-06**: Solo el worker con el lock de recolección envía, y un reintento no duplica el mensaje
- [x] **INCD-07**: Un 429 se reintenta respetando `retry_after`; 400/403/404 quedan fallidos de forma permanente y visible
- [x] **INCD-08**: El operador ve en el hub el estado de entrega de cada incidencia (enviado, fallido, suprimido y motivo)
- [x] **INCD-09**: Una caída de host se agrupa en una incidencia de servicios e inhibe las de contenedor durante la caída
- [x] **INCD-10**: `expectedContainers` se reconcilia con el inventario real y no deja incidencias fantasma

### Resumen diario

- [x] **DIG-01**: Lo no urgente se entrega en un único resumen diario a la hora configurada (08:00 `Europe/Madrid` por defecto)
- [x] **DIG-02**: El resumen se calcula por instante de Madrid y no se duplica ni se salta en los cambios de hora
- [x] **DIG-03**: El resumen incluye abiertas ahora, nuevas en el periodo, contador de críticas y de resueltas
- [x] **DIG-04**: Si no hay contenido, no se envía nada
- [x] **DIG-05**: Un reinicio alrededor de la hora del resumen no produce dos envíos ni lo pierde dentro de una ventana de 2 h
- [x] **DIG-06**: El resumen respeta el límite de 4096 caracteres con truncado explícito y "+N"

### Bot de Telegram

- [x] **BOT-01**: El operador recibe los avisos en el chat configurado desde el bot del hub
- [ ] **BOT-02**: El bot ignora cualquier update de un usuario o chat fuera de la allowlist
- [x] **BOT-03**: Cada mensaje incluye un botón que abre la vista correspondiente del hub autenticada
- [ ] **BOT-04**: El operador puede abrir la incidencia, silenciarla 1 h o 24 h y reconocerla desde los botones, y el estado persiste
- [ ] **BOT-05**: El operador puede consultar "por qué me llegó esto" desde el propio mensaje
- [ ] **BOT-06**: Un callback repetido o caducado no ejecuta dos veces la acción ni rompe el bot
- [ ] **BOT-07**: El operador puede iniciar una acción de host desde Telegram y completarla en el hub con sesión y passkey
- [ ] **BOT-08**: Ninguna acción destructiva iniciada desde Telegram se ejecuta sin verificación reciente en el servidor
- [ ] **BOT-09**: Cada acción iniciada desde Telegram queda en `operations` con canal y solicitante
- [ ] **BOT-10**: El token del bot nunca aparece en logs ni en respuestas

### Seguridad

- [ ] **SEC-01**: Toda ruta destructiva exige verificación reciente en el servidor (stop, restart, update, purge, empty-trash, clean-images, reconnect-apps, host-command, merge de Renovate)
- [ ] **SEC-02**: La lista de acciones protegidas vive en un único módulo y una ruta nueva no puede olvidarla sin que falle un test
- [x] **SEC-03**: El arranque rechaza credenciales de ejemplo y la falta de configuración obligatoria, y el contenedor no se declara sano
- [ ] **SEC-04**: Las respuestas incluyen CSP conservadora y HSTS, y las mutaciones tienen límite de cuerpo
- [ ] **SEC-05**: La rotación conjunta del token del bot (hub y `media-stack`) está documentada y probada
- [ ] **SEC-06**: El fallback de copia de `media-stack` solo envía `backup-failed`, solo si el ingest no confirma, y se marca con origen propio

### Contratos y operación

- [x] **CONT-01**: Métricas, mantenimiento y despliegues se validan en runtime en el borde del hub, y un payload inválido no resuelve incidencias
- [ ] **CONT-02**: El ingest de `media-stack` valida HMAC, ventana de 5 minutos e idempotencia por evento
- [ ] **CONT-03**: Agente y worker tienen healthcheck, y el worker puede reportar que el resumen no salió
- [x] **CONT-04**: Los contenedores auxiliares huérfanos del agente se recogen y los fallos de limpieza son visibles

### Rendimiento

- [ ] **PERF-01**: El histórico de 30 días se sirve desde rollups y no re-agrega cada muestra en cada poll
- [ ] **PERF-02**: La consulta del overview tiene un presupuesto medido y una prueba con 500k muestras

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

- **ACTN-01**: El operador puede deshacer una acción reversible iniciada desde Telegram
- **ESCAL-01**: Una incidencia crítica sin reconocer escala un recordatorio adicional
- **SUPP-01**: Presupuesto de supresión cuando el volumen agregado supera un umbral
- **ROUT-01**: Enrutado por host en topics separados de Telegram
- **PUSH-01**: Reconocer desde la notificación push del sistema
- **QUIET-01**: Ventana configurable de silencio nocturno

## Out of Scope

| Feature | Reason |
|---------|--------|
| Chatops de texto libre (`/restart plex`) | Superficie de ataque nueva y parseo frágil; las acciones van por botones con token opaco |
| Una alerta por contenedor de `expectedContainers` | Es una de las fuentes del ruido; se agrupa por host |
| Mensaje de recuperación por incidencia | Duplica cada incidencia; el cierre va en el mensaje o en el resumen |
| Reenviar mientras el estado no cambia | El olvido, no la falta de mensajes, es el problema |
| Logs o journal completo por Telegram | El hub ya los sirve bajo demanda |
| Email como tercer canal | Dos canales ya son suficientes; añadir uno multiplica la política |
| Un topic por categoría | Cosmético con un solo operador y dos hosts |
| "Todo es crítico" | Anula la severidad; el mapa de claves decide |
| Múltiples réplicas web o de worker | El diseño es de escritor único; exige rehacer rate limit y collector |
| Consola o shell remota arbitraria | El agente expone una lista cerrada de comandos y acciones |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUDT-01 | Phase 1 | Complete |
| AUDT-02 | Phase 1 | Complete |
| AUDT-03 | Phase 1 | Complete |
| AUDT-04 | Phase 1 | Complete |
| AUDT-05 | Phase 1 | Complete |
| INCD-01 | Phase 2 | Complete |
| INCD-02 | Phase 2 | Complete |
| INCD-03 | Phase 2 | Complete |
| INCD-04 | Phase 2 | Complete |
| INCD-05 | Phase 2 | Complete |
| INCD-06 | Phase 2 | Complete |
| INCD-07 | Phase 2 | Complete |
| INCD-08 | Phase 2 | Complete |
| BOT-01 | Phase 2 | Complete |
| BOT-03 | Phase 2 | Complete |
| SEC-03 | Phase 2 | Complete |
| CONT-01 | Phase 2 | Complete |
| INCD-09 | Phase 3 | Complete |
| INCD-10 | Phase 3 | Complete |
| CONT-04 | Phase 3 | Complete |
| DIG-01 | Phase 4 | Complete |
| DIG-02 | Phase 4 | Complete |
| DIG-03 | Phase 4 | Complete |
| DIG-04 | Phase 4 | Complete |
| DIG-05 | Phase 4 | Complete |
| DIG-06 | Phase 4 | Complete |
| CONT-03 | Phase 4 | Pending |
| BOT-02 | Phase 5 | Pending |
| BOT-04 | Phase 5 | Pending |
| BOT-05 | Phase 5 | Pending |
| BOT-06 | Phase 5 | Pending |
| BOT-10 | Phase 5 | Pending |
| SEC-01 | Phase 6 | Pending |
| SEC-02 | Phase 6 | Pending |
| SEC-04 | Phase 6 | Pending |
| BOT-07 | Phase 7 | Pending |
| BOT-08 | Phase 7 | Pending |
| BOT-09 | Phase 7 | Pending |
| SEC-05 | Phase 8 | Pending |
| SEC-06 | Phase 8 | Pending |
| CONT-02 | Phase 8 | Pending |
| PERF-01 | Phase 8 | Pending |
| PERF-02 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 43 total
- Mapped to phases: 43
- Unmapped: 0 ✅

*Inventario real del documento: 43 IDs v1 en 7 categorías; los 43 están mapeados.*

---
*Requirements defined: 2026-11-24*
*Last updated: 2026-11-24 after roadmap creation*
