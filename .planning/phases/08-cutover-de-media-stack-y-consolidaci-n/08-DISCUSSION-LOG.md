# Phase 8: Cutover de media-stack y consolidación - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-27
**Phase:** 08-cutover-de-media-stack-y-consolidación
**Areas discussed:** Destino de cada familia, Ritmo del cutover, Fallback de copia y token, Rollups y retención

---

## Destino de cada familia

**security-updater y security-monitor**

| Option | Description | Selected |
|--------|-------------|----------|
| Snapshot → digest | El hub abre una incidencia de digest desde las revisiones del agente | |
| Ingest → digest | media-stack publica el evento y el hub lo pone en el resumen | |
| Solo Mantenimiento | Ni aviso ni línea en el resumen | ✓ |

**WUD**

| Option | Description | Selected |
|--------|-------------|----------|
| Nada, solo la UI de WUD | Se quita el trigger | ✓ |
| Recuento en el digest | Línea «N actualizaciones disponibles» | |

**issue-automator**

| Option | Description | Selected |
|--------|-------------|----------|
| Ingest → digest | Se cuenta en el resumen | |
| Ingest → inmediato | Aviso en el momento, enviado por el hub | ✓ |
| Apagar sin sustituto | Se ve en Seerr | |

**SMART**

| Option | Description | Selected |
|--------|-------------|----------|
| Que lo cubra el hub | Se apaga el emisor y se añade la clave si falta | ✓ |
| Dejarlo como está | Queda como deuda | |

**Cierre de la incidencia de issue-automator**

| Option | Description | Selected |
|--------|-------------|----------|
| Se cierra al cerrar el issue en Seerr | Evento de resolución y edición del mensaje original | ✓ |
| Nace cerrada | Mensaje informativo | |
| Abierta hasta Reconocer | La cierra el operador | |

**Releases aplicadas con éxito**

| Option | Description | Selected |
|--------|-------------|----------|
| Silencio, se ven en Despliegues | Solo fallos y retenidas avisan | ✓ |
| Línea en el digest | «Release vX aplicada» | |

---

## Ritmo del cutover

| Question | Options | Selected |
|----------|---------|----------|
| Ritmo | Por familias con observación / Dos tandas / Todo de golpe | Todo de golpe |
| Prueba | Evento real o provocado / Solo revisar la configuración | Evento real o provocado |
| Rollback | Revertir el commit de media-stack / Flag por familia en .env | Revertir el commit |
| Despliegue | Lo aplica el usuario con un checklist / Lo aplica el agente por SSH | El usuario, con un checklist |

---

## Fallback de copia y token

| Question | Options | Selected |
|----------|---------|----------|
| Espera de confirmación | 3 intentos en unos 2 min / 1 intento de 20 s / Reintentos durante 15 min | 3 intentos en unos 2 min |
| Origen propio | Prefijo visible y texto fijo / Bot distinto | Prefijo visible y texto fijo |
| Prueba de la rotación | Rotación real en producción / Ensayo con un bot de pruebas | Rotación real en producción |
| Secreto HMAC | Sí, con ventana de dos secretos / Sí, cambio en seco / No en esta fase | Sí, con ventana de dos secretos |

---

## Rollups y retención

| Question | Options | Selected |
|----------|---------|----------|
| Rangos | 7d y 30d desde rollups / Todo desde rollups / Solo 30d | 7d y 30d desde rollups |
| Historial de contenedor | Misma política / Solo el host | Misma política |
| Muestras crudas | 48 h y rollups 30 d / 7 d / 30 d como hoy | 48 h y rollups 30 d |
| Presupuesto | p95 < 150 ms / p95 < 300 ms / Lo fija el research | p95 < 150 ms |

## Claude's Discretion

- La forma exacta del contrato de ingest, cómo llega media-stack al hub, el backoff de los reintentos, el esquema de los rollups y la caché, la retención de `ingest_events` y el texto del prefijo.

## Deferred Ideas

- Recuento de WUD en el digest.
- Revisiones de seguridad como incidencia o línea del digest.
- Backlog 999.1 (emoticono por tipo de mensaje).
