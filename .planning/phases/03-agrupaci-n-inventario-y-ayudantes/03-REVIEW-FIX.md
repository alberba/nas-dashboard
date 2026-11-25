# Fase 03 — Correcciones de la revisión de código

## Fixed Issues

### CR-01: Un nombre válido de Docker puede bloquear Mantenimiento

Los diccionarios de vigilancia se crean e hidratan sin prototipo. La proyección comprueba que la fecha de ausencia sea válida antes de enviarla a Mantenimiento. La prueba recoge la primera ausencia de `constructor` desde una configuración persistida y comprueba que una fecha fuera de rango queda excluida.

### WR-01: La API guarda el nombre del borrado pendiente y el colector compara el ID

El POST conserva el nombre confirmado y el ID en la columna de destino. El colector coteja el ID incluso si el contenedor cambia de nombre y admite las filas antiguas con solo el nombre. La API sigue publicando el nombre como destino. Las pruebas cubren ambas representaciones, incluida la pérdida de respuesta de un POST real seguida de dos recogidas.

### WR-02: Una lectura en curso puede reabrir una incidencia que el operador acaba de cerrar

La evaluación de los episodios comprueba la revisión del inventario y que el nombre siga vigilado bajo el bloqueo de configuración que protege la escritura. La prueba detiene el contenedor mediante el POST después de que el colector haya leído el episodio abierto y comprueba que no se crea otro.

### WR-03: Un contenedor que ya estaba en marcha confirma un reinicio sin evidencia de que se ejecutó

Los reinicios se confirman con la respuesta del agente. El inventario actual carece de una generación de ejecución, por lo que un reinicio con respuesta perdida sigue pendiente. El cierre verifica el estado pendiente bajo bloqueo y las escrituras de rechazo o incertidumbre respetan los resultados terminales. Las pruebas cubren el reinicio con respuesta perdida, el rechazo previo al cierre y las respuestas tardías tras una confirmación del colector.

### WR-04: Se retira la vigilancia antes de considerar un reemplazo probado en el mismo inventario

La reconciliación aplica las transferencias inequívocas antes de retirar las vigilancias vencidas. La prueba presenta un reemplazo detenido justo al alcanzar los 30 minutos y comprueba que la vigilancia y el episodio abierto pasan al nuevo nombre.

### WR-05: Un agente anterior deja pendientes indefinidamente las operaciones de inicio y parada

Sin marca de inventario, el inicio y la parada se confirman cuando tanto la recogida como la muestra superan la fecha de la operación más los 10 segundos de caché del agente. Las pruebas comprueban que una muestra anterior al límite sigue siendo insuficiente cuando se vuelve a servir después, y que un borrado sigue requiriendo la marca de inventario.

### WR-06: Una inspección sin estado permite borrar un ayudante

El barrido exige un estado de Docker que permita el borrado tanto en el inventario como en la inspección. Un estado ausente, desconocido o incompatible con los indicadores de la inspección deja el barrido indeterminado y conserva el ayudante. Las pruebas cubren un estado desconocido en el inventario y una inspección que mantiene el ID y las etiquetas con un estado ausente, desconocido o contradictorio.

### WR-07: El límite del barrido cuenta éxitos y puede acreditar una limpieza parcial

El barrido cuenta cada candidato que intenta procesar. Si el límite deja un candidato elegible pendiente, el resultado es indeterminado hasta un barrido completo. Las pruebas comprueban el máximo de cinco intentos ante seis borrados fallidos y el caso de cinco borrados correctos con un sexto ayudante pendiente que se retira en el siguiente barrido.

### WR-08: La retención puede dejar bloqueada una incidencia cuando reaparece el contenedor

La retención conserva los grupos referenciados por episodios abiertos. Si el grupo original ya falta, el colector usa el último grupo de conexión disponible como límite de frescura y revalida el episodio cuando reaparece el contenedor. Las pruebas cubren el grupo retenido, una referencia huérfana y la eliminación del grupo cuando el episodio deja de referenciarlo.

## Verificación de WR-06 y WR-07

- `python3 -m unittest discover -s agent -p 'test_maintenance.py'` pasó los 48 tests.
- `pnpm test:agent` ejecutó 203 tests en el primer intento y en el único reintento, con 200 correctos y 2 omitidos en cada ejecución. En ambos casos, el único error fue el fallo preexistente de `.env.lock` en `test_env_settings.EnvSettingsTest.test_serializes_concurrent_writes_without_losing_updated_bytes`.
