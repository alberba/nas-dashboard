# Diseño de hub.

Dirección visual de la interfaz: **panel de estado dentro de la identidad del hub**. Información operativa densa (tablas, franjas de estado, listas de acciones y eventos) servida con la barra lateral, la tipografía y la paleta que ya tiene la aplicación.

Referencia visual: lienzo «hub. Mantenimiento», fila «B adaptada al hub» (privado, del autor): https://claude.ai/artifact/Jj3E5Gi9UgpcjgahxyM7yR

Este documento manda sobre el lienzo cuando discrepen. Lee también `CODING_STANDARD.md` antes de tocar textos o tests.

## Principios

1. **Primero el estado, después el detalle.** Cada página abre con una franja que responde «¿va todo bien?» sin desplazarse. El detalle va debajo, en tablas.
2. **Filas, no tarjetas.** Un elemento repetido (contenedor, release, PR, archivo, app) es una fila de tabla. Los paneles agrupan secciones; nunca envuelven un único dato.
3. **Cada acción, junto a lo que afecta.** Las acciones de un contenedor van en su fila; las globales, en la lista «Acciones». Nada de barras de botones sueltas.
4. **El color nunca va solo.** Todo estado lleva punto de color **y** texto (`sana`, `falla · 12 min`, `retenida`).
5. **Lo destructivo pide confirmación explícita.** Eliminar exige escribir el nombre; merge y rollback, passkey. Nunca se reintenta solo.
6. **Sin consola.** El hub muestra logs y ejecuta comandos fijos; jamás abre una shell.

## Tokens

Los colores existen ya en `src/app/globals.css` (`:root`). No se añaden tonos nuevos salvo los neutros de esta tabla.

| Token | Valor | Uso |
| --- | --- | --- |
| `--bg` | `oklch(21.9% 0.005 75)` | Fondo de página, campos de texto |
| `--side` | `oklch(20.1% 0.005 75)` | Barra lateral |
| `--panel` | `oklch(25.1% 0.005 75)` | Paneles |
| `--panel2` | `oklch(28.7% 0.006 75)` | Elemento seleccionado, segmento activo |
| `--line` | `oklch(31.6% 0.007 75)` | Bordes de panel, separadores de franja, cabeceras de tabla |
| `--ctrl-line` | `oklch(39% 0.01 75)` | Bordes de controles |
| `--row-line` *(nuevo)* | `oklch(28.5% 0.006 75)` | Separador entre filas de tabla y listas |
| `--row-hover` *(nuevo)* | `oklch(27% 0.006 75)` | Hover de fila |
| `--code-bg` *(nuevo)* | `oklch(17.5% 0.004 75)` | Visor de logs y registro |
| `--text` / `--soft` / `--muted` | existentes | Texto principal / secundario / etiquetas y metadatos |

### Semántica del color

| Token | Significa | Ejemplos |
| --- | --- | --- |
| `--accent` | Acción disponible, actualización, en curso | botón primario, pastilla `v1.104.7 · #94`, `desplegando` |
| `--gain` | Sano, correcto, completado | `sana`, `Correcta`, `Conectado`, pin de seguridad aplicado |
| `--loss` | Fallo o acción destructiva | `falla · 12 min`, `Fallida · restaurada`, Eliminar, Reiniciar NAS |
| `--peach` | Requiere atención, retenido, vigilar | `v3.0.0 retenida`, `requiere Worker`, disco `Vigilar` |
| `--lilac` | Informativo o decisión del Operador | `huérfano`, `retenido` por ti, reinicio pendiente |
| `--muted` | Detenido, sin dato | `detenido · 41 d`, `—` |

Barras de progreso y rellenos de gráficas usan el color de su serie; las áreas, ese color al 14 % de opacidad.

## Tipografía

- **Manrope** para todo. Cuerpo denso a `13.5px`, interlineado `1.5`.
- **Unbounded** solo para la marca `hub.` y el `h1` de página: `32px`, peso 650, `letter-spacing: -0.05em` (móvil `26px`).
- Títulos de panel (`h2`): Manrope `14px`, peso 800.
- Etiquetas (cabeceras de tabla, claves de la franja): `10.5px`, peso 800, mayúsculas, `letter-spacing: .07em`, color `--muted`.
- Cifras siempre con `font-variant-numeric: tabular-nums`. Formato español: `21,8 GB`, `12,4 %`, `52 °C`.
- **Monoespaciada solo** para versiones e imágenes (`v1.104.4`, `5.3.0_v2.1.2-ls484`), rutas, nombres de variables de entorno y logs. Nunca para cifras ni nombres de servicio.

## Estructura de página

```
┌ sidebar 248px ┬──────────────────────────────────────────────┐
│ hub.          │ topbar 72px: migas · buscador Ctrl K · En directo │
│ navegación    ├──────────────────────────────────────────────┤
│               │ fecha / contexto                 [segmentados] │
│               │ H1 Unbounded                                   │
│               │ ┌ franja de estado ───────────────────────────┐ │
│ Hosts         │ └─────────────────────────────────────────────┘ │
│  NAS-HOME     │ ┌ columna principal ─────┐ ┌ columna lateral ┐ │
│  Servidor apps│ │ tabla(s)               │ │ Acciones        │ │
│               │ │                        │ │ Eventos         │ │
└───────────────┴─┴────────────────────────┴─┴─────────────────┴─┘
```

- Contenedor: `max-width: 1280px`, padding `28px 36px 48px`, separación entre bloques `18px`.
- Columnas: principal `flex: 999 1 620px`, lateral `flex: 1 1 320px`, ambas `min-width: 0`, dentro de un `flex-wrap`. En pantallas estrechas la lateral cae debajo sin media queries.
- La barra lateral y el contenido forman un `flex-wrap` (`1 1 248px` / `999 1 560px`): en móvil la barra pasa arriba.
- Cabecera de página: a la izquierda, línea de contexto (`Viernes, 13 de noviembre`, `NAS-HOME · media-stack`) y el `h1`; a la derecha, los controles segmentados de la página (sección, host, periodo).
- La barra lateral muestra los hosts conectados abajo. La sección Mantenimiento lleva un contador con los elementos que requieren atención.

## Componentes

### Franja de estado
Un único panel con segmentos en fila (`flex-wrap`), separados por `--line`. Cada segmento: etiqueta, valor (`14–16px`, peso 750, con punto si es un estado) y una línea secundaria opcional (`12px`, `--muted` o el color de su estado). Un segmento que lleva a otra página es un enlace. Entre 5 y 8 segmentos.

### Panel
Fondo `--panel`, borde `--line`, radio `18px`, `overflow: hidden`. Cabecera de `56px` mínimo con el `h2` a la izquierda (y un contador en `--muted`) y a la derecha un enlace o controles (filtros, selector). El contenido llega al borde del panel: las tablas no llevan margen propio.

### Tabla
- Filas de `50px` (`54px` si llevan avatar), separadas por `--row-line`; hover `--row-hover`.
- Primera y última columna con `18px` de padding lateral para alinear con la cabecera del panel.
- Cabeceras con el estilo de etiqueta. La columna de acciones tiene cabecera solo para lectores de pantalla.
- Cifras alineadas a la derecha.
- Envuelta en una caja `overflow-x: auto` con `min-width` en la tabla: en móvil se desplaza la tabla, no la página.
- Una fila puede **expandirse en línea** (release retenida): el botón de la primera celda lleva `aria-expanded`, la fila se tiñe con `--peach` muy suave y la fila siguiente ocupa todas las columnas con el detalle y su formulario.

### Punto de estado
`7px`, `currentColor`. Siempre acompañado de texto. Primera columna de filas de contenedor y eventos.

### Pastilla de actualización
Píldora con borde `--accent` y texto `--accent`: `nueva versión · #PR`. Es un enlace a la PR en la sección Despliegues.

### Etiquetas de estado
Píldora de `11px`, peso 800, borde `--line`, texto en el color semántico: `patch`, `requiere Worker`, `Instalada`, `Retenida`, `Fallida · restaurada`.

### Progreso de actualización
Seis segmentos de `14×5px` en este orden fijo: **PR · Merge · CI en main · Release · Desplegando · Sano**. Hechos en `--gain`, actual en `--accent`, pendientes en neutro. Siempre con texto al lado (`esperando merge`, `desplegando · 40 s`) y `aria-label` con el paso.

### Lista de acciones
Panel con filas-botón de `46px`: icono en su color semántico, etiqueta y, a la derecha, atajo de teclado (`kbd`) o dato útil (`7,4 GB`). Las destructivas, en `--loss`. Orden: desplegar, comprobar salud, reconectar apps, copia, limpiar, reiniciar NAS.

### Feed de eventos
Rejilla `hora · punto · texto`, filas separadas por `--row-line`. Solo eventos del día; enlace «Registro» en la cabecera.

### Controles segmentados y filtros
- Segmentados (sección, host, raíz, periodo): contenedor píldora `--panel` con borde; opción activa `--panel2` + borde `--ctrl-line`; `aria-pressed` o `aria-current`.
- Filtros de tabla: píldoras con borde; la activa se invierte (fondo `--text`, texto `--bg`). Muestran el recuento.

### Botones
- Primario: píldora `--accent` con texto `--bg`, peso 850. Uno por zona como máximo.
- Secundario: píldora `--panel2` con borde `--ctrl-line`. Fantasma: sin fondo.
- Pequeño (dentro de filas): `36px` de alto. Normal: `44px`.
- Botón de icono: `44×44px`, radio `12px`, `aria-label` con verbo y objeto (`Reiniciar bazarr`).

### Buscador global
En la topbar, píldora con icono de lupa y `Ctrl K`. Busca contenedores y ejecuta acciones de la lista.

### Visor de logs y registro
Fondo `--code-bg`, monoespaciada `12px`, interlineado `1.75`, `role="log"`. Hora en `--muted`; nivel o mensaje coloreado por gravedad (`ERROR` `--loss`, `WARN` `--peach`). Controles: filtrar, número de líneas, seguir en vivo (`aria-pressed`), descargar. Debajo: «Solo lectura».

### Formularios de ajustes
Etiqueta con el nombre de la variable en monoespaciada, campo de `44–46px`, ayuda debajo. Los secretos son `type="password"` y llevan la nota «se escribe en .env y no se vuelve a mostrar». Si hay pasos manuales, casilla «He leído los pasos manuales» antes del botón primario.

### Diálogos de confirmación
Icono en su color, título en Unbounded `21px`, lista de consecuencias con iconos (✓ `--gain`, ⚠ `--peach`), y botones a la derecha: Cancelar (fantasma) y la acción.
- **Merge y desplegar, rollback**: botón «Confirmar con passkey».
- **Eliminar**: escribir el nombre exacto habilita el botón destructivo.
- **Rollback**: avisa de que no deshace migraciones de base de datos.

### Gráficas
Línea de `2px` con área al 14 %, dos o tres líneas guía en `--line`, eje temporal en `--muted`. Cada panel de gráfica muestra en su cabecera el punto de la serie, el nombre y un valor resumen (`media 13 %`, `pico 38 MB/s`). Selector de periodo `1h · 6h · 24h · 7d · 30d`. `role="img"` con una descripción de lo que muestra.

## Vocabulario de estados

Usar siempre estas palabras para que todas las páginas digan lo mismo:

| Objeto | Estados |
| --- | --- |
| Contenedor | `Activo`, `Detenido`, `sana`, `falla · N min`, `huérfano`, `protegido`, `desplegando vX` |
| Release | `Instalada`, `Retenida`, `Correcta`, `Fallida · restaurada`, `Sin reinicios` |
| PR de Renovate | `patch` / `minor` / `major`, `automerge`, `requiere Worker`, `esperando merge` |
| Automatismos | `Activo`, `Pausado`, `hace N min`, `próxima en N min` |
| Disco (SMART) | `Correcto`, `Vigilar`, `Fallo` |
| Pin de seguridad | `pin · CVE HIGH`, `retenido`, `revisar` |

## Páginas

| Página | Franja | Columna principal | Columna lateral |
| --- | --- | --- | --- |
| Resumen | Estado general, en marcha, servicios, CPU, memoria, red, temperatura | Actividad reciente (gráfica) · Lo que más está trabajando | Avisos · Almacenamiento · Accesos |
| Recursos | Valores actuales de CPU, memoria, red, discos y tiempo en marcha | Cuatro gráficas en rejilla `auto-fit` | Temperaturas · Actividad de discos · Volúmenes (fila inferior) |
| Mantenimiento · Estado | Release, seguidor, seguridad, copia, VPN, reinicio, Docker | Contenedores (filtros: Todos, Actualizaciones, Problemas, Detenidos) | Acciones · Eventos de hoy · Discos |
| Mantenimiento · Despliegues | Instalada, seguidor, retenidas, seguridad, último fallo | PR de Renovate abiertas · Releases (con retenida expandible) | Seguridad · Registro |
| Archivos | — | Ruta + contenido de la carpeta | Papelera |
| Aplicaciones | — | Accesos (filtro por categoría, estado del servicio) | — |
| Ajustes | Pendiente de diseñar con este sistema | | |

Mantenimiento lleva en la cabecera el selector de host (`NAS-HOME` / `Apps`): todo el contenido de la página es del host elegido.

**Estado** no repite el detalle de las automatizaciones ni los pins: la franja ya responde si el host está sano y el detalle vive en Despliegues. Si una unidad del sistema falla, aparece un aviso plegable entre la franja y los contenedores; las unidades que funcionan no ocupan espacio. La tabla de contenedores muestra nombre, estado y acciones: la imagen y el consumo de CPU/RAM pertenecen a Recursos.

**Despliegues** muestra el panel de bloqueos solo cuando hay un bloqueo; sin él, la franja del seguidor lo dice en una línea. Cada PR de Renovate es una fila con servicios, estado y su acción de fusionar; el tipo y el CI viven en esa misma columna de estado.

## Móvil

- La navegación principal pasa a una fila con desplazamiento horizontal bajo la marca.
- Los segmentados ocupan todo el ancho (rejilla de columnas iguales).
- La franja de estado se convierte en una rejilla de 2 columnas.
- Las tablas se convierten en **filas compactas** de `56px`: punto, nombre, línea secundaria (versión o estado) y, al final, la pastilla de actualización o un chevron.
- La lista de acciones mantiene su formato y pierde los atajos de teclado.

## Accesibilidad

- Objetivos táctiles de `44px` como mínimo, también los botones de icono de las filas.
- Contraste de texto ≥ 4,5:1 sobre `--panel`, incluidas las etiquetas pequeñas.
- `aria-current` en navegación, `aria-pressed` en segmentados y filtros, `aria-expanded` en filas expandibles, `role="log"` en logs.
- Los estados de los componentes que comprueban los tests se exponen con atributos (`data-*`, `aria-*`), según `CODING_STANDARD.md`.

## Qué no hacer

- Tarjetas grandes con un solo dato o elemento por tarjeta.
- Degradados, sombras decorativas, bordes laterales de color, emojis.
- Monoespaciada para cifras o como estética general.
- Colores nuevos fuera de los tokens.
- Más de un botón primario por zona.
