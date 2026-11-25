# Fase 3 · Registro de la discusión

> El contexto de planificación está en [03-CONTEXT.md](03-CONTEXT.md).

**Fecha** 2026-11-25
**Áreas** Caída y recuperación del host, Inventario esperado, Limpieza de ayudantes

Primero se eligió la caída del host. Después se añadieron inventario y limpieza. Al terminar las tres áreas, se confirmó el guardado del contexto.

## Caída y recuperación del host

### ¿Qué muestra el aviso único de Telegram?

| Opción | Elegida |
| --- | --- |
| Host y enlace | ✓ |
| Host, recuento y enlace |  |
| Host, nombres y enlace |  |

El host que no responde y el enlace a la incidencia autenticada en el hub. El detalle queda en el hub.

### ¿Cómo se ven las incidencias de contenedor abiertas antes de la caída?

| Opción | Elegida |
| --- | --- |
| Abierta y marcada como inhibida | ✓ |
| En el detalle de la caída |  |

Siguen abiertas y visibles, marcadas como inhibidas. El motivo es que el host no responde y el estado actual del contenedor está sin verificar.

### ¿Cuándo se abre una incidencia nueva si un contenedor que estaba sano sigue detenido al volver el host?

| Opción | Elegida |
| --- | --- |
| Tras 30 segundos de observaciones válidas | ✓ |
| En la primera lectura válida |  |
| Tras dos minutos de observaciones válidas |  |

Tras 30 segundos de observaciones válidas desde la recuperación. El tiempo de caída no cuenta.

### ¿Qué pasa con una incidencia anterior en la primera lectura válida tras la caída?

| Opción | Elegida |
| --- | --- |
| Reanudar la misma incidencia con la primera lectura válida | ✓ |
| Esperar también 30 segundos para confirmar que sigue detenido |  |

Si el contenedor sigue detenido, se retira la inhibición y se reanuda la misma incidencia. Si está en marcha, se cierra.

## Inventario esperado

### ¿Cuánto tiempo se conserva un nombre ausente?

| Opción | Elegida |
| --- | --- |
| 5 minutos |  |
| 30 minutos | ✓ |
| 24 horas |  |

30 minutos de inventario válido. Si reaparece durante la espera, se conserva la vigilancia. Un contenedor presente pero detenido se sigue vigilando.

### ¿Qué muestra el hub durante la espera?

| Opción | Elegida |
| --- | --- |
| Indicar ausencia en el inventario | ✓ |
| Mostrar una incidencia durante la espera |  |

El inventario muestra el nombre pendiente de reconciliar. Si ya había una incidencia, se mantiene visible con el motivo de la espera. La ausencia no abre una incidencia nueva.

### ¿Cuándo se traslada la vigilancia a un nombre nuevo?

| Opción | Elegida |
| --- | --- |
| Cuando Docker confirma que es el mismo servicio | ✓ |
| Solo cuando conserva el mismo ID |  |
| Nunca entre nombres distintos |  |

Cuando Docker permite identificar el mismo servicio sin ambigüedad. El mismo ID confirma un renombrado. En Compose, proyecto y servicio deben identificar un único reemplazo.

### ¿Qué pasa con una incidencia abierta si se confirma el reemplazo?

| Opción | Elegida |
| --- | --- |
| Conservar la misma incidencia | ✓ |
| Cerrar la anterior y evaluar el reemplazo |  |

Se conserva la misma incidencia y se actualiza su referencia. Si el reemplazo funciona, se cierra con su historial. Si sigue detenido, continúa abierta.

## Limpieza de ayudantes

### ¿Dónde se ve un fallo de limpieza?

| Opción | Elegida |
| --- | --- |
| En Mantenimiento y en Avisos si persiste | ✓ |
| Solo en Mantenimiento |  |
| En Mantenimiento y en Avisos desde el primer fallo |  |

En Mantenimiento desde el primer fallo y en Avisos si persiste, con una sola incidencia por host.

### ¿Cuándo se abre la incidencia en Avisos?

| Opción | Elegida |
| --- | --- |
| Tras dos intentos de limpieza fallidos | ✓ |
| Si el problema sigue presente tras 15 minutos |  |
| Si el problema sigue presente tras una hora |  |

Tras dos intentos de limpieza fallidos del mismo ayudante o del conjunto pendiente. Leer el estado en el hub no cuenta como intento.

### ¿Aparece la incidencia fuera del hub?

| Opción | Elegida |
| --- | --- |
| Solo en el hub |  |
| En el resumen diario cuando esté disponible | ✓ |
| Aviso inmediato |  |

Se incluye en el resumen diario cuando esté disponible en la fase 4. Durante la fase 3 queda visible en el hub.

### ¿Qué confirma el cierre de la incidencia?

| Opción | Elegida |
| --- | --- |
| Que ya no queda ningún ayudante pendiente | ✓ |
| Que una ronda de limpieza terminó sin errores |  |

Ya no queda ningún ayudante pendiente de esa limpieza. Cada uno cuenta como resuelto tras eliminarlo o confirmar a través de Docker que ya no existe.

## Decisiones delegadas a la planificación

Se delegaron la transición entre claves de incidencia, la persistencia y presentación de los estados, y los detalles de identificación y recogida de ayudantes.

## Trabajo de fases posteriores

La entrega de la incidencia de limpieza por resumen diario corresponde a la fase 4.
