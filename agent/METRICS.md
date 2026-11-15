# Métricas nativas del agente

`GET /metrics` es la instantánea que el hub guarda cada 5 o 30 segundos. No
depende de Beszel ni de otro servicio: CPU, memoria, red, discos, RAID,
temperaturas y contenedores salen del host y de la API de Docker. La ruta usa el
mismo `AGENT_TOKEN` y la misma lista de IP permitidas que el resto del agente.

El agente solo lee `/host/proc`, `/host/sys` y los montajes de solo lectura que
declara `agent/compose.yaml`. No escribe en el host ni publica rutas completas.

## Respuesta

Los campos anteriores se conservan. Se añaden:

| Campo | Unidades | Origen |
| --- | --- | --- |
| `cpuCores` | % por hilo | `/host/proc/stat` |
| `cpuBreakdown` | % | `user`, `system`, `iowait`, `steal`, `idle`, `irq`, `softirq`, `nice` |
| `load` | — | `/host/proc/loadavg` (1, 5 y 15 min) |
| `memory.cache` | bytes | `Buffers + Cached + SReclaimable` |
| `memory.swap` | bytes | `SwapTotal` y `SwapTotal - SwapFree` |
| `network.interfaces` | bytes/s y bytes | `/host/proc/net/dev`; `rx`/`tx` y totales desde el arranque |
| `io.latency` | ms y % | `/host/proc/diskstats`; `readMs`, `writeMs`, `utilization`, `weightedMs` y `devices` |
| `filesystems` | bytes | `statvfs` de cada volumen; `total`, `used`, `free` |
| `raid` | bytes y texto | `/host/proc/mdstat` y `/sys/block/md*/md/*` |
| `temperatures` | °C | `hwmon`; conserva la etiqueta del sensor |

`cpu`, `cpuCores`, `cpuBreakdown`, `network.rx`, `network.tx` e `io` son `null`
en la primera muestra o tras reiniciar el agente, porque necesitan una lectura
anterior para calcular la tasa. `memory.total` sigue siendo la suma de
`MemTotal`; `memory.used` es `MemTotal - MemAvailable`.

### Volúmenes

`filesystems` incluye:

- `media` y `torrents` con los nombres «Volumen de películas» y «Descargas».
- `APPDATA_ROOT` como «Datos de apps».
- Los pares de `EXTRA_FILESYSTEMS`, con formato `Nombre=/ruta,Nombre=/ruta`.

Se eliminan los volúmenes que comparten dispositivo para no repetir la misma
capacidad. `agent/compose.yaml` monta la raíz del host en `/host/root:ro` y fija
`EXTRA_FILESYSTEMS=Sistema=/host/root`, así que el volumen del sistema aparece
como «Sistema». Si se cambia el montaje, el agente omite el volumen que no
pueda leer en vez de fallar.

### RAID

`raid` sale de `mdstat` y de `sysfs`. Cada entrada tiene `name`, `level`,
`state`, `disks`, `capacity`, `degraded`, `syncAction`, `syncCompleted` y
`syncSpeed`. Los valores que el kernel no publica (por ejemplo, en un RAID 0)
quedan en `null`.

### Temperaturas

Se mantienen las etiquetas de `hwmon` (`Composite`, `Sensor 1`, `Core 0`). Dos
sensores de distinto dispositivo pueden compartir etiqueta; unificarlas es una
mejora pendiente.

## Límites

- `/metrics` no lee el historial: el hub guarda cada muestra en `samples`.
- Las cifras de tasa dependen de que el agente tenga una muestra anterior; el
  hub las recibe como `null` al arrancar y no las inventa.
- `/` solo aparece si el montaje de solo lectura está presente. El agente no
  recorre el árbol montado: solo consulta su capacidad.
- Un archivo obligatorio ausente (`stat`, `meminfo`, `net/dev`, `diskstats`)
  mantiene el comportamiento anterior: la petición falla y el hub no guarda una
  muestra vacía.
