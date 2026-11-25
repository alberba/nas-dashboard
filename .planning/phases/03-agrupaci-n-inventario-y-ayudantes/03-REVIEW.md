---
phase: 03-agrupaci-n-inventario-y-ayudantes
reviewed: 2026-11-25T14:54:01Z
depth: standard
files_reviewed: 34
files_reviewed_list:
  - 'agent/Dockerfile'
  - 'agent/helper_cleanup.py'
  - 'agent/maintenance.py'
  - 'agent/server.py'
  - 'agent/test_host_commands.py'
  - 'agent/test_maintenance.py'
  - 'drizzle/0005_incident_context.sql'
  - 'drizzle/meta/0005_snapshot.json'
  - 'drizzle/meta/_journal.json'
  - 'src/app/api/[...path]/route.ts'
  - 'src/components/dashboard.tsx'
  - 'src/components/views/alerts.tsx'
  - 'src/components/views/maintenance-status.tsx'
  - 'src/components/views/maintenance.tsx'
  - 'src/lib/agent-snapshots.ts'
  - 'src/lib/collector.ts'
  - 'src/lib/container-watch.ts'
  - 'src/lib/incident-store.ts'
  - 'src/lib/lifecycle.ts'
  - 'src/lib/maintenance-alerts.ts'
  - 'src/lib/maintenance.ts'
  - 'src/lib/notification-dispatch.ts'
  - 'src/lib/notification-policy.ts'
  - 'src/lib/schema.ts'
  - 'src/lib/settings.ts'
  - 'src/lib/types.ts'
  - 'src/lib/validation.ts'
  - 'tests/api-incidents.test.ts'
  - 'tests/api-maintenance.test.ts'
  - 'tests/collector-alerts.test.ts'
  - 'tests/e2e/maintenance-status.spec.ts'
  - 'tests/e2e/maintenance.spec.ts'
  - 'tests/maintenance-alerts.test.ts'
  - 'tests/migrations.test.ts'
findings:
  critical: 1
  warning: 8
  info: 0
  total: 9
  necessity: 0
status: issues_found
---

# Fase 03 — Informe de revisión de código

**Revisión:** 2026-11-25T14:54:01Z

**Profundidad:** standard

**Archivos revisados:** 34

**Estado:** issues_found

## Resumen

Revisión de `b7dfffa..a2972bb`, incluidas las desviaciones de los tres planes, las pruebas y la proyección hacia el despachador de notificaciones. La fase tiene un fallo bloqueante en Mantenimiento y ocho advertencias sobre la reconciliación y la evidencia de limpieza. La proyección de inventario se limita a nombre y estado. Los mensajes del despachador usan título, detalle y referencia de la incidencia.

Pasaron las 133 pruebas focalizadas de Vitest de incidencias, colector, mantenimiento, migraciones, acciones de contenedores y despacho, y las 44 pruebas Python de mantenimiento. Se usó PostgreSQL local y un Docker simulado. Los casos adicionales descritos abajo se contrastaron con el código y, cuando se indica, con comprobaciones aisladas.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Un nombre válido de Docker puede bloquear Mantenimiento

**File:** `src/lib/container-watch.ts:294-305`

**Issue:** Para un contenedor vigilado llamado `constructor`, la primera ausencia lee el constructor heredado de `Object.prototype` cuando aún no hay una entrada propia en `watch.entries`. La rama de actualización deja `absentSince` ausente y produce `NaN` en `accreditedMs`, que se persiste como `null`. La fila pendiente llega sin fecha y `toISOString()` lanza `RangeError` al renderizar Mantenimiento. Una comprobación aislada confirmó la serialización y la excepción. Véase `src/components/views/maintenance.tsx:353-355`.

**Fix:** Usar búsquedas de propiedades propias o diccionarios sin prototipo para `entries` e `identities`, también al hidratar JSONB. Validar la fecha proyectada y cubrir la primera ausencia de `constructor` con una prueba de reconciliación.

## Warnings

### WR-01: La API guarda el nombre del borrado pendiente y el colector compara el ID

**File:** `src/lib/lifecycle.ts:202-210`

**Issue:** El POST guarda `input.confirmation` en `operations.target`. Ante una respuesta perdida, el colector busca ese valor como ID tanto en Docker como en `watch.identities`. Un contenedor ordinario queda pendiente incluso después de que un inventario acreditado confirme su ausencia. La prueba fabrica una fila con el ID y omite la escritura real del POST. Véanse `src/lib/collector.ts:540-555` y `tests/api-incidents.test.ts:1288-1295`.

**Fix:** Persistir el ID junto al nombre confirmado, usar ambos en el cierre y contemplar las filas antiguas que solo tienen nombre. Probar un POST con respuesta perdida seguido de una recogida real del colector.

### WR-02: Una lectura en curso puede reabrir una incidencia que el operador acaba de cerrar

**File:** `src/lib/collector.ts:316-347`

**Issue:** El chequeo de revisión protege `reconcileContainers`, mientras que la evaluación de episodios sigue usando los nombres esperados y las incidencias leídos fuera de esa transacción. Si el colector lee una incidencia abierta para un contenedor detenido, y el POST de parada quita su vigilancia y cierra la incidencia antes de `condition()`, el colector aún aplica el umbral cero del episodio que vio y abre otro. La prueba de concurrencia llama directamente a `reconcileContainers`, por lo que no pasa por esta escritura. Véanse `src/lib/lifecycle.ts:125-141` y `tests/api-incidents.test.ts:1062-1086`.

**Fix:** Verificar la revisión y la pertenencia del nombre bajo el mismo bloqueo de configuración que protege la escritura del episodio. Cubrir el intercalado con el colector completo.

### WR-03: Un contenedor que ya estaba en marcha confirma un reinicio sin evidencia de que se ejecutó

**File:** `src/lib/collector.ts:530-548`

**Issue:** Una lectura fechada después de insertar la operación basta para convertir un reinicio pendiente en éxito si el contenedor figura como `running`. La fila se inserta antes de enviar la acción al agente, así que una lectura posterior puede observar el mismo proceso de siempre. Si el POST luego se pierde, queda un éxito falso y se aplica la intención de vigilancia. El cierre compartido también admite filas `failed` si el colector las leyó como pendientes antes del rechazo. Véanse `src/app/api/[...path]/route.ts:517-544` y `src/lib/lifecycle.ts:94-104`.

**Fix:** Confirmar los reinicios mediante el resultado del agente o un cambio comprobable en la generación de ejecución. Validar que la fila sigue pendiente bajo bloqueo y condicionar las escrituras de rechazo o incertidumbre al estado que esperan encontrar.

### WR-04: Se retira la vigilancia antes de considerar un reemplazo probado en el mismo inventario

**File:** `src/lib/container-watch.ts:316-337`

**Issue:** Cuando un inventario lleva un nombre ausente al umbral de 30 minutos y a la vez muestra un reemplazo único por ID o Compose, el primer bucle retira el nombre y cierra su episodio. `planTransfers` recibe la lista ya reducida y no puede reasignar la vigilancia. Si el reemplazo sigue detenido, el servicio queda sin episodio abierto ni vigilancia. Las pruebas de expiración y transferencia ejercitan los caminos por separado.

**Fix:** Evaluar primero las transferencias inequívocas con el inventario actual. Retirar después solo los nombres que alcanzaron el umbral y siguen sin reemplazo verificado.

### WR-05: Un agente anterior deja pendientes indefinidamente las operaciones de inicio y parada

**File:** `src/lib/collector.ts:536-539`

**Issue:** El colector anterior podía completar un inicio o una parada pendiente cuando volvía a observar el estado esperado. La fase exige `containersObservedAt` para toda confirmación y ese campo es opcional. Tras una respuesta perdida, un agente anterior puede seguir mostrando el estado correcto en cada lectura sin que cambien la operación o la vigilancia.

**Fix:** Para inicio y parada, admitir evidencia del agente anterior después de una espera conservadora basada en su caché y con una muestra posterior a la operación. Mantener el requisito de evidencia específica para reinicios y borrados.

### WR-06: Una inspección sin estado permite borrar un ayudante

**File:** `agent/helper_cleanup.py:475-493`

**Issue:** `_state_of` devuelve una cadena vacía para un estado ausente o ilegible. La revalidación solo comprueba que el valor no pertenezca a `ACTIVE_STATES`, así que una respuesta parcial con ID y etiquetas correctos pasa y produce un DELETE. El Docker simulado confirmó el intento y el estado final `clean`. Docker conserva la última barrera frente a contenedores en marcha porque el DELETE carece de `force`.

**Fix:** Para el listado y la inspección, exigir un estado de Docker reconocido y elegible, y declarar la comprobación indeterminada ante un estado ausente, desconocido o contradictorio. Probar específicamente una inspección que conserva el ID y las etiquetas pero omite `State`.

### WR-07: El límite del barrido cuenta éxitos y puede acreditar una limpieza parcial

**File:** `agent/helper_cleanup.py:394-412`

**Issue:** Con un máximo de cinco candidatos y seis DELETE fallidos, el barrido hace seis intentos. Si los primeros cinco tienen éxito, deja el sexto sin revisar y llama a `finish_sweep` con `complete=True`. El Docker simulado confirmó ambos resultados. El segundo caso publica `clean` con un candidato elegible todavía presente y el hub puede cerrar una incidencia previa tras haber perdido los contadores por reinicio. Véanse `agent/helper_cleanup.py:299-320` y `src/lib/maintenance-alerts.ts:190-197`.

**Fix:** Contar los candidatos examinados o intentados, incluidos los fallos. Si quedan candidatos elegibles tras agotar el presupuesto, publicar un estado parcial que impida cerrar la incidencia hasta una comprobación completa.

### WR-08: La retención puede dejar bloqueada una incidencia cuando reaparece el contenedor

**File:** `src/lib/incident-store.ts:1045-1055`

**Issue:** La retención puede borrar un grupo resuelto aunque lo referencie un episodio abierto. Es alcanzable con un agente anterior: tras la recuperación, el contenedor sigue ausente y el inventario sin marca no cambia su estado bloqueado. Si reaparece después de 30 días, el colector no encuentra el grupo, omite la revalidación y vuelve a omitir el nombre en la evaluación normal por seguir inhibido. Véase `src/lib/collector.ts:270-282` y `src/lib/collector.ts:316-320`.

**Fix:** Mantener el grupo mientras lo referencien episodios abiertos y gestionar las referencias huérfanas ya persistidas. Probar la retención con un episodio inhibido que vuelve a ser observable.

---

_Revisado: 2026-11-25T14:54:01Z_

_Revisor: gsd-code-reviewer_

_Profundidad: standard_
