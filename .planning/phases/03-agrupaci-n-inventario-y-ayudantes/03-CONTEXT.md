# Fase 3 · Agrupación, inventario y ayudantes

**Fecha** 2026-11-25

**Estado** Lista para planificar

<domain>
## Alcance

Agrupar la caída de un host en una sola incidencia de servicios, reconciliar `expectedContainers` con el inventario de Docker y recoger los contenedores auxiliares huérfanos del agente. Cubre INCD-09, INCD-10 y CONT-04.

</domain>

<decisions>
## Decisiones

### Caída y recuperación del host

- **D-01:** La caída genera una sola incidencia de servicios por host. El aviso inicial de Telegram identifica el host que no responde y enlaza a su incidencia autenticada. El hub muestra el último inventario conocido con su fecha y las incidencias de contenedor inhibidas.
- **D-02:** Durante la caída, las incidencias de contenedor ya abiertas siguen visibles y marcadas como inhibidas. El motivo indica que el host no responde y el estado actual del contenedor está sin verificar.
- **D-03:** Para un contenedor que estaba sano y sigue detenido al volver el host, abrir una incidencia solo tras una nueva ventana de 30 segundos de observaciones válidas. La ventana empieza con la primera observación válida del fallo tras la recuperación.
- **D-04:** Para una incidencia previa, la primera lectura válida que confirme el estado del contenedor basta para retirar la inhibición. Si sigue detenido, reanudar el mismo episodio. Si está en marcha, cerrarlo según la política de la fase 2. Un nombre ausente sigue las reglas de reconciliación del inventario.

### Inventario esperado

- **D-05:** Conservar durante 30 minutos de inventario válido un nombre esperado que ya no aparece. Si reaparece durante ese plazo, conservar la vigilancia. Un contenedor presente pero detenido sigue sujeto a la evaluación normal.
- **D-06:** Mostrar el nombre como pendiente de reconciliar en el inventario y mantener visible cualquier incidencia previa con el motivo de la espera. La ausencia por sí sola no abre una incidencia. Agotado el plazo, retirar el nombre ausente de `expectedContainers` y resolver cualquier incidencia que quede abierta por ese nombre, conservando su historial.
- **D-07:** Trasladar la vigilancia al nuevo nombre si Docker confirma la identidad en el mismo host. El mismo ID confirma un renombrado. Para una recreación con otro nombre, el proyecto y el servicio de Compose deben identificar un único reemplazo. Una coincidencia ambigua sigue la espera de reconciliación.
- **D-08:** Conservar el episodio y el historial si hay una incidencia abierta al identificar el reemplazo. Actualizar la referencia al contenedor. Si el reemplazo está en marcha, cerrar el episodio. Si sigue detenido, continúa abierto.

### Limpieza de ayudantes

- **D-09:** Mostrar el primer fallo de limpieza en Mantenimiento. Si persiste, abrir una sola incidencia en Avisos por host.
- **D-10:** Abrir la incidencia tras dos intentos reales fallidos de limpiar el mismo ayudante o el mismo conjunto pendiente. Las lecturas del estado en el hub quedan fuera del recuento.
- **D-11:** Mantener la incidencia visible en el hub durante la fase 3 y prepararla para el resumen diario de la fase 4. La política de entrega de esta condición es de resumen, sin aviso inmediato.
- **D-12:** Cerrar la incidencia cuando no quede ningún ayudante pendiente de esa limpieza. Cada ayudante cuenta como resuelto al eliminarlo o al confirmar con Docker que ya no existe.

### Decisiones delegadas a la planificación

- Concretar la relación entre `connection` y `services-down`, incluida la transición de episodios abiertos que ya tengan un aviso asociado. Aplicar la política de entrega única y la distinción entre fallo de contrato y pérdida de conexión de las fases anteriores.
- Definir cómo persistir la reconciliación y la identidad del servicio, y cómo presentar el inventario y los motivos en las vistas existentes. La recolección y las operaciones de ciclo de vida deben conservar los cambios de vigilancia de cada host.
- Definir la identificación, antigüedad y cadencia de recogida de los ayudantes. La limpieza opera sobre ayudantes huérfanos del agente identificados con certeza, preserva los ayudantes en uso y respeta los permisos actuales.

</decisions>

<canonical_refs>
## Referencias para planificar

- `.planning/ROADMAP.md` — Alcance, criterios de éxito y tres planes previstos para la fase 3.
- `.planning/REQUIREMENTS.md` — INCD-09, INCD-10 y CONT-04. DIG-01 a DIG-06 corresponden al resumen de la fase 4.
- `.planning/PROJECT.md` — Alcance por host, escritor único y límites de privilegios del agente.
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` — Política auditada para `connection` y `container:<nombre>`.
- `.planning/phases/02-incidencias-y-entrega-nica/02-CONTEXT.md` — Entrega inicial única, continuidad del historial y tratamiento del cierre.
- `CODING_STANDARD.md` — Convenciones para validar cambios de comportamiento y texto.

</canonical_refs>

<code_context>
## Código existente

- `src/lib/collector.ts` evalúa `connection` y `container:<nombre>` por host. Ya distingue las respuestas inválidas del agente y contempla reinicios planificados.
- `src/lib/incident-store.ts`, `src/lib/notification-policy.ts` y `src/components/views/alerts.tsx` aportan persistencia, política de entrega y detalle de Avisos.
- `agent/server.py` obtiene el inventario de Docker, incluidos los contenedores detenidos. `src/lib/settings.ts`, `src/lib/lifecycle.ts` y `src/app/api/[...path]/route.ts` participan en la vigilancia y las operaciones de contenedores. `src/components/dashboard.tsx` conecta la lista esperada con el inventario.
- `agent/maintenance.py` contiene `HostExecutor` y `DiskExecutor`. Ambos intentan eliminar sus ayudantes al terminar. `agent/server.py` crea también un ayudante de reinicio con eliminación automática. `src/lib/maintenance-alerts.ts` conecta las señales de snapshots con el colector.

</code_context>

<specifics>
## Casos para planificar

- Tras volver el host, un contenedor sigue detenido y otro ya está en marcha. Cada episodio se trata según si estaba abierto antes de la caída.
- Una recreación temporal, un renombrado con el mismo ID, un reemplazo inequívoco de Compose y una coincidencia ambigua se resuelven con las reglas de inventario acordadas. Una lectura fallida, obsoleta o incompleta no acredita una ausencia.
- Tras dos fallos de limpieza del mismo pendiente, la incidencia sigue abierta hasta que se comprueba la eliminación o la ausencia de todos los ayudantes afectados.

</specifics>

<deferred>
## Trabajo de fases posteriores

- La entrega por resumen diario se implementa en la fase 4.

</deferred>
