# Fase 03 · Revisión de interfaz

**Fecha** 2026-11-25

**Alcance** Avisos, inventario pendiente de Mantenimiento y estado de limpieza por host.

**Base** Seis criterios de GSD, con `DESIGN.md` como referencia visual del proyecto.

**Método** Inspección estática de JSX y CSS, sin capturas nuevas ni sesión de navegador. La UAT 2 está aprobada por el usuario y confirma la lectura de estados al cambiar de host en su recorrido. La validación previa registra 21 de 21 recorridos Playwright aprobados. La revisión de código comprueba también los casos de contenedor estrecho y los estados que comparten texto. [UAT](03-UAT.md#tests) · [Validación](03-VALIDATION.md#recorridos-de-navegador-y-revisión-manual)

## Puntuación

| Criterio | Puntos | Hallazgo |
| --- | --- | --- |
| Redacción | 2/4 | La fecha de inventario y la fecha de una muestra antigua llevan la misma etiqueta. |
| Jerarquía visual | 2/4 | Los bloques nuevos de Avisos tienen clases sin reglas de estilo y quedan al mismo nivel que el detalle de la fila. |
| Color | 2/4 | El estado de limpieza tras el primer fallo y el fallo persistente se distinguen solo por el color del punto. |
| Tipografía | 3/4 | Se conserva la escala compartida. La fecha del inventario hereda el estilo de metadato de la fila, a `0.65rem`. |
| Espaciado | 2/4 | El nombre y el estado del contenedor, y el rótulo y la fecha del inventario, se renderizan en elementos en línea adyacentes sin separación. |
| Experiencia | 2/4 | La tabla de vigilancia pierde estado, fecha y progreso en contenedores de menos de `36rem`. |
| **Total** | **13/24** | |

## Prioridades

1. **Bloqueante para consultar el progreso en móvil.** Mostrar estado, primera ausencia y minutos acreditados en la fila estrecha. Reutilizar `.row-meta` con etiquetas explícitas, o aplicar a esta tabla una regla local que preserve las celdas. Comprobar la visibilidad de esos datos con el ancho del contenedor por debajo de `36rem`. [Tabla de vigilancia](../../../src/components/views/maintenance.tsx#L324) · [Regla compartida de tablas](../../../src/app/globals.css#L1516)
2. **Advertencia de accesibilidad.** Dar textos distintos al primer fallo y al persistente en la franja de limpieza. Se puede incluir el recuento en la línea secundaria y usar «Fallo de limpieza» y «Fallo persistente» como valores principales. [Estados en Mantenimiento](../../../src/components/views/maintenance-status.tsx#L55) · [Punto de estado](../../../src/components/ui.tsx#L5)
3. **Advertencia de legibilidad.** Presentar el inventario de Avisos como un bloque con título y fecha separados, y dar a cada fila una separación explícita entre nombre y estado. Etiquetar la fecha según su fuente y proporcionar `dateTime` cuando se conoce. [Vista de Avisos](../../../src/components/views/alerts.tsx#L69) · [Origen de la observación](../../../src/lib/incident-store.ts#L119)

## Hallazgos por criterio

### Redacción · 2/4

- **Advertencia.** `inventoryContextFromSample` diferencia `observedFrom: "inventory"` y `"sample"`. Avisos expone esa distinción en un atributo y muestra «Último inventario conocido» en ambos casos. Cuando la fecha solo corresponde a la muestra guardada, mostrar «Fecha de la muestra» para precisar qué observación se puede fechar. Cuando falta la fecha, el mensaje de falta de lectura puede ocupar todo ese estado en vez de usar también un elemento `time`. [Proyección de inventario](../../../src/lib/incident-store.ts#L95) · [Detalle de inventario](../../../src/components/views/alerts.tsx#L69)

### Jerarquía visual · 2/4

- **Advertencia.** El inventario y los episodios inhibidos aparecen entre el detalle y la fecha general del aviso, cada uno en un contenedor con clases propias sin reglas CSS en el árbol de estilos. La entrega sí tiene un separador y espacios definidos. Usar el separador de filas y un rótulo de sección compartido daría límites claros al inventario y a los episodios inhibidos, especialmente cuando hay varias filas. [Orden de los bloques](../../../src/components/views/alerts.tsx#L260) · [Estilo de entrega](../../../src/app/globals.css#L1086)

### Color · 2/4

- **Advertencia.** `failing` y `persistent` comparten el rótulo «Limpieza», el valor de recuento, el texto alternativo «Pendiente» y el detalle horario. Solo cambia el punto de `peach` a `loss`. El punto lleva `aria-hidden`; ambos estados se leen igual con tecnología asistiva. Los cuatro estados reutilizan los tonos del proyecto. Hacer explícita con texto la distinción de los dos fallos conserva ese sistema de color. [Valores y tonos](../../../src/components/views/maintenance-status.tsx#L60) · [Renderizado](../../../src/components/views/maintenance-status.tsx#L298)

### Tipografía · 3/4

- **Advertencia.** La fecha del inventario hereda `.alert-row time`, concebida para el metadato general, y queda en el tamaño más pequeño de la fila. La fecha es un dato operativo de este bloque. Puede usar el tamaño secundario del detalle, con cifras tabulares como las de la tabla de Mantenimiento. [Fecha del inventario](../../../src/components/views/alerts.tsx#L86) · [Regla tipográfica](../../../src/app/globals.css#L1046) · [Cifras de tabla](../../../src/app/globals.css#L1444)

### Espaciado · 2/4

- **Advertencia.** Los pares `span`–`time` del rótulo y la fecha, `span`–`span` de cada contenedor y los equivalentes de los episodios inhibidos carecen de espacio literal o regla `gap`. JSX los deja adyacentes y el navegador puede componer los textos pegados. Aplicar un patrón local `flex-wrap` con el espacio de las filas de entrega permite separar los datos y acomodar nombres largos. [Inventario](../../../src/components/views/alerts.tsx#L86) · [Episodios inhibidos](../../../src/components/views/alerts.tsx#L150) · [Filas de entrega](../../../src/app/globals.css#L1092)

### Experiencia · 2/4

- **Bloqueante para la consulta completa en contenedor estrecho.** El panel usa `.table-scroll` como contenedor y `.data-table` activa las reglas compartidas por debajo de `36rem`. Esas reglas ocultan la cabecera y las celdas salvo la del nombre y la de acciones. Aquí estado, fecha y progreso están en celdas independientes sin una versión en `.row-meta`, por lo que solo queda visible el nombre. El título mantiene detectable que hay vigilancia pendiente. Los E2E de la fila validan visibilidad y estado mediante atributos, además del cambio de host, y la UAT aprobó el recorrido del usuario. Conviene ampliar la prueba con un ancho estrecho y comprobar el contenido de la fila que realmente queda visible. [Fila pendiente](../../../src/components/views/maintenance.tsx#L337) · [Regla estrecha](../../../src/app/globals.css#L1537) · [Prueba existente](../../../tests/e2e/maintenance.spec.ts#L480)

## Archivos inspeccionados

- [Avisos](../../../src/components/views/alerts.tsx), [Mantenimiento](../../../src/components/views/maintenance.tsx), [franja de estado](../../../src/components/views/maintenance-status.tsx) y [conexión con el dashboard](../../../src/components/dashboard.tsx#L716).
- [Estilos globales](../../../src/app/globals.css), [estilos de Mantenimiento](../../../src/components/views/maintenance-extra.module.css), [componentes compartidos](../../../src/components/ui.tsx) y [diseño del proyecto](../../../DESIGN.md).
- [Proyección del inventario](../../../src/lib/incident-store.ts), [plan 03-01](03-01-PLAN.md), [plan 03-02](03-02-PLAN.md), [plan 03-03](03-03-PLAN.md), [contexto](03-CONTEXT.md), [verificación](03-VERIFICATION.md) y [UAT](03-UAT.md).
