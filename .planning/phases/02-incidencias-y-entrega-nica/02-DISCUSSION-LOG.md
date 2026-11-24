# Fase 2 · Registro de la discusión

**Fecha:** 2026-11-24

Las decisiones para la planificación están en `02-CONTEXT.md`.

## Envío sin confirmación

- **A (elegida).** Mostrar la entrega incierta en el hub y evitar un segundo aviso automático. El push de respaldo sigue disponible ante un fallo definitivo confirmado de Telegram en una crítica.
- **B.** Enviar un push de respaldo en el caso incierto, con posibilidad de que lleguen ambos avisos.

## Incidencias abiertas al migrar

- **A (elegida).** Conservar las incidencias abiertas en el hub y activar Telegram sin reenviar los avisos previos.
- **B.** Enviar un Telegram por cada crítica previa que el agente confirme tras el arranque.

## Escalada a crítica

- **A (elegida).** Reflejar la severidad en el hub y actualizar en silencio el push existente.
- **B.** Enviar un Telegram adicional cuando la incidencia pase a crítica.

Una incidencia que esperaba el resumen activa su primer aviso inmediato al escalar a crítica.

## Cierre

El operador eligió los tres temas anteriores y confirmó el cierre. La presentación del estado de entrega quedó para la planificación. No surgieron ideas fuera del alcance.
