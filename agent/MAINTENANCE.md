# Instantánea de mantenimiento del agente

Contrato backend de los tickets #17, #18 y #19 para la franja **Mantenimiento · Estado**,
la tabla de **Automatismos**, el panel **Discos** y las acciones de host de `DESIGN.md`.
El hub la consume con `GET /api/maintenance?host=<id>`; el agente la publica en
`GET /maintenance`.

## Configuración y montajes

Las lecturas del agente son de solo lectura: no escribe en el checkout ni en el estado de
media-stack. Las únicas acciones son los comandos cerrados de la sección «Comandos de
host».

| Variable del agente | Efecto | Valor del NAS |
| --- | --- | --- |
| `MEDIA_STACK_CHECKOUT_PATH` | Montaje de solo lectura del checkout en `/media-stack` | `/volume2/media-stack` |
| `MEDIA_STACK_APPDATA_PATH` | Montaje de solo lectura del estado en `/media-stack-appdata` | `/volume2/media-stack-appdata` |
| `HOST_ROLE` | `instance` o `apps-server`; decide las unidades por defecto | `instance` |
| `MAINTENANCE_UNITS` | Lista de unidades base separadas por comas; opcional | ver abajo |
| `MAINTENANCE_CACHE_SECONDS` | Vida de la caché en segundos; por defecto `60` | `60` |
| `MAINTENANCE_STACK_PREFIX` | Prefijo para separar unidades del stack de las ajenas | `media-stack` |

`agent/compose.yaml` y `agent/compose.apps.yaml` montan ambos directorios con `:ro` y
fijan dentro del contenedor `MEDIA_STACK_ROOT=/media-stack` y
`APPDATA_ROOT=/media-stack-appdata`. `scripts/configure.mjs` escribe las dos rutas del
host (`--stack-path`, `--appdata-path`, `--apps-stack-path`, `--apps-appdata-path`).

Unidades por defecto:

- `instance`: `media-stack-merged-updates`, `media-stack-security-updates`,
  `media-stack-evidence`, `media-stack-tdarr-hardlinks`, `media-stack-backup`.
- `apps-server`: `media-stack-apps-merged-updates`,
  `media-stack-apps-security-updates`.

Cada nombre se consulta como servicio y como temporizador. Si una unidad no existe, se
omite. Los nombres de `MAINTENANCE_UNITS` se validan: nunca llegan a la línea de órdenes
como opciones ni como argumentos libres.

## Formatos reales que se leen

No se inventan formatos: son los que escribe `media-stack`.

| Ruta (bajo `APPDATA_ROOT`) | Formato real | Uso |
| --- | --- | --- |
| `security-monitor/merged-releases/installed.json` | `{ "release": "v2.4.1", "commit": "<sha>", "bootstrap": false }` | Release instalada y `installedAt` (mtime) |
| `security-monitor/merged-releases/pending.json` | Transacción del seguidor: `release`, `status`, `previous_installed.release`, `changed`, `folder`, `environment`, `snapshots`… | Solo se publica `release`, `status`, `previousRelease`, `changed` y `since` |
| `security-monitor/merged-releases/failed-release.json` | `{ "release": "v2.5.0", "configuration": "<sha256>" }` | Último intento fallido; se publica solo `release` y `since` |
| `security-monitor/images.compose.json` | `{ "services": { "radarr": { "image": "ref@sha256:…" } } }` | Pins de seguridad |
| `security-monitor/active-update.json` | Transacción del actualizador (`service`, `status`, `candidate_ref`, `before_pins`, `snapshots`…) | Actualización pendiente; solo se publican campos seguros |
| `security-monitor/comparisons/*.json` | Plan del escáner con `names`, `local_ref`, `remote_ref`, `pinned_ref`, `semver_diff`, `fixed`, `new_severe`, `verified_at` | Correcciones verificadas para revisión (`cves` es el número de CVEs corregidas) |
| `security-monitor/attempted-updates.json` | `{ "<hash>": { "service", "candidate", "result" } }` | Excluye comparaciones ya aplicadas y da el `reason` de las manuales |
| `backup/last-status` | `ok <ISO>` o `failed <ISO>` | Última copia |

Los JSON ausentes, ilegibles o mal formados no rompen la instantánea: su sección queda en
el valor vacío documentado y `degraded` puede indicar el fallo de lectura.

## Respuesta

```json
{
  "host": { "id": "nas-home", "name": "NAS-HOME", "role": "instance" },
  "snapshot": {
    "timestamp": 1763040000,
    "role": "instance",
    "follower": {
      "available": true,
      "state": "idle",
      "installed": {
        "release": "v2.4.1",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "bootstrap": false,
        "installedAt": "2026-11-13T03:04:49Z"
      },
      "pending": null,
      "failed": null
    },
    "security": {
      "pins": [
        {
          "service": "radarr",
          "image": "lscr.io/linuxserver/radarr:5.27.0-ls325@sha256:…",
          "version": "5.27.0-ls325",
          "digest": "sha256:…"
        }
      ],
      "pending": null,
      "review": []
    },
    "backup": { "status": "ok", "at": "2026-11-13T03:04:49Z" },
    "disks": {
      "available": true,
      "devices": [
        {
          "device": "sda",
          "model": "WDC WD40EFRX-68N32N0",
          "serial": "WD-WCC7K0AAAAAA",
          "kind": "sata",
          "size": 4000787030016,
          "temperature": 34,
          "reallocatedSectors": 0,
          "wear": null,
          "status": "ok",
          "issues": []
        },
        {
          "device": "nvme0n1",
          "model": "Samsung SSD 970 EVO Plus 2TB",
          "serial": "S4EWNX0R000001",
          "kind": "nvme",
          "size": 2000398934016,
          "temperature": 41,
          "reallocatedSectors": null,
          "wear": 3,
          "status": "ok",
          "issues": []
        }
      ]
    },
    "units": [
      {
        "name": "media-stack-merged-updates",
        "kind": "follower",
        "service": "media-stack-merged-updates.service",
        "timer": "media-stack-merged-updates.timer",
        "activeState": "active",
        "subState": "waiting",
        "unitFileState": "enabled",
        "result": "success",
        "state": "active",
        "paused": false,
        "lastRun": "2026-11-13T17:01:00Z",
        "nextRun": "2026-11-13T17:06:00Z"
      }
    ],
    "failedUnits": {
      "stack": [{ "name": "media-stack-upgrade.service", "description": "…" }],
      "other": [{ "name": "logrotate.service", "description": "…" }]
    },
    "reboot": { "available": false, "required": null },
    "docker": {
      "available": true,
      "images": { "count": 42, "size": 42000000000, "reclaimable": 30000000000 },
      "containers": { "count": 17, "size": 1200000 },
      "volumes": { "count": 3, "size": 9000000 },
      "buildCache": { "count": 0, "size": 0 },
      "total": 42012000000,
      "reclaimable": 30000000000
    },
    "degraded": []
  }
}
```

`timestamp` es la hora de generación en segundos Unix. Las fechas son ISO 8601 en UTC.
Los tamaños de Docker son bytes y salen de `GET /system/df`; `reclaimable` es una
estimación (imágenes sin contenedor y caché no usada), no un borrado implícito.

### Franja de Mantenimiento · Estado

| Celda de `DESIGN.md` | Campo | Regla de presentación |
| --- | --- | --- |
| Release | `follower.installed.release` | Si es `null`, «Sin datos». `installedAt` permite «desde …». |
| Seguidor | `units` con `kind === "follower"` | `state`: `active` → Activo, `paused` → Pausado, `failed` → Fallo, `inactive` → Detenido. Mostrar `lastRun` y `nextRun`. |
| Seguridad | `security.pins`, `security.pending`, `security.review` | Pins activos; pendiente en curso; `review` son correcciones verificadas pendientes (las ya aplicadas se excluyen y `reason` explica las manuales). |
| Copia | `backup.status`, `backup.at` | `ok`/`failed`/`unknown`; `at` es la última ejecución. |
| VPN | Fuera de esta instantánea | La aporta «Comprobar salud» (otro ticket). |
| Reinicio | `reboot` | `available: false` → «No disponible»; `required: true` → «Pendiente»; `required: false` → «No hace falta». |
| Docker | `docker` | Mostrar `images.size` y `reclaimable`; `available: false` → «No disponible». |

### Automatismos

`units` es la tabla completa de automatismos del rol, en el orden configurado. `kind`
identifica las filas especiales:

- `follower`: seguidor de merges.
- `security`: actualizador de seguridad.
- `backup`: copia, si existe como unidad.
- `automation`: resto (`media-stack-evidence`, `media-stack-tdarr-hardlinks`, …).

`state` solo usa `active`, `paused`, `inactive` o `failed`. `paused` es cierto cuando la
unidad está deshabilitada. `lastRun` es el último arranque del servicio o disparo del
temporizador; `nextRun` es la próxima ejecución del temporizador, incluidos los
temporizadores monotónicos. Ambos pueden ser `null`.

`failedUnits.stack` contiene las unidades fallidas cuyo nombre empieza por
`MAINTENANCE_STACK_PREFIX`; `failedUnits.other` contiene el resto. Nunca se mezclan en la
misma lista.

### Discos (SMART)

`disks.devices` son los discos físicos que devuelve `smartctl --scan-open --json` en el
host: los tres WD Red de 4 TB y los dos NVMe del NAS aparecen automáticamente, sin que el
agente codifique modelos, cantidades ni nombres de dispositivo. La imagen `hub-agent`
incluye `smartmontools`; cada lectura se ejecuta dentro de esa imagen en un contenedor
auxiliar privilegiado con `/dev` y `/sys` montados en solo lectura. No se usa `nsenter`
para SMART y no se instala nada en el host. Solo se aceptan rutas `/dev/sdX`,
`/dev/nvmeX` y `/dev/nvmeXnY` (el escaneo real puede devolver el espacio de nombres
broadcast), con un tipo de dispositivo de una lista cerrada.

Las dos únicas órdenes son, con argumentos fijos:

```text
smartctl --scan-open --json
smartctl --json --all [-d <ata|sat|scsi|nvme>] <dispositivo>
```

Nunca se ejecutan autotests, ni `-t`, ni `-s`, ni operaciones de offline/guardado: la
lectura es estrictamente pasiva. No hay un endpoint para lanzar comandos SMART.

| Campo | Significado |
| --- | --- |
| `device` | Nombre corto del dispositivo (`sda`, `nvme0n1`). |
| `model`, `serial` | Modelo y número de serie; `null` si smartctl no los dio. |
| `kind` | `sata`, `nvme` u `other`. |
| `size` | Capacidad en bytes (`user_capacity.bytes`). |
| `temperature` | Grados Celsius (`temperature.current`, el log NVMe o el atributo 194). |
| `reallocatedSectors` | Raw del atributo ATA 5; `null` en NVMe. |
| `wear` | `percentage_used` del log NVMe; `null` en SATA. |
| `status` | `ok`, `watch`, `fail` o `unknown`. |
| `issues` | Claves estables que explican el estado; la UI las traduce. |

Clasificación:

- `unknown`: no hay estado SMART, atributos ni log NVMe, o falla la lectura de ese disco.
  El disco sigue en la lista con los campos que se hayan podido leer y el panel no se
  rompe. `issues` contiene `smart_unavailable` o `read_failed`.
- `fail`: `smart_status.passed` es `false`, hay `critical_warning` NVMe, la temperatura
  alcanza 65 °C en SATA u 85 °C en NVMe, o el desgaste llega al 100 %.
- `watch`: la temperatura alcanza 50 °C en SATA o 75 °C en NVMe; el desgaste llega al
  90 %; los sectores reasignados superan el umbral (0 por defecto) o aumentan respecto de
  la lectura anterior. Las claves son `temperature`, `wear`, `reallocated_threshold` y
  `reallocated_increase`.
- `ok`: ninguna de las condiciones anteriores.

La lectura anterior se guarda en memoria por número de serie (o por dispositivo si no lo
hay). Se actualiza en cada refresco de la instantánea; tras reiniciar el agente no existe
una base anterior y la primera lectura solo aplica el umbral. No se escribe ningún estado
en disco.

`disks.available` es `false` solo si falla el escaneo completo; entonces la sección queda
vacía y `disks` aparece en `degraded`. Un fallo de un disco concreto no oculta los demás.

## Comandos de host (ticket #19)

El panel Acciones de Mantenimiento · Estado solo puede ejecutar una lista cerrada de
comandos. Cada comando se identifica por su nombre; la petición nunca lleva unidades,
opciones ni argumentos libres.

| Comando | Efecto | Instancia | Servidor de apps |
| --- | --- | --- | --- |
| `deploy-now` | Lanza el seguidor sin esperar al timer | `systemctl start --no-block media-stack-merged-updates.service` | `systemctl start --no-block media-stack-apps-merged-updates.service` |
| `pause-follower` | Desactiva y para el timer del seguidor | `systemctl disable --now media-stack-merged-updates.timer` | `systemctl disable --now media-stack-apps-merged-updates.timer` |
| `resume-follower` | Activa y arranca el timer del seguidor | `systemctl enable --now media-stack-merged-updates.timer` | `systemctl enable --now media-stack-apps-merged-updates.timer` |
| `run-security` | Lanza el actualizador de seguridad | `systemctl start --no-block media-stack-security-updates.service` | `systemctl start --no-block media-stack-apps-security-updates.service` |

Los nombres salen de `HOST_ROLE` y de `MAINTENANCE_UNITS`: el agente toma la primera
unidad cuyo nombre contiene `merged-updates` o `security-updates`. Si el rol configurado
no tiene esa unidad, el comando se rechaza sin ejecutar nada. Los nombres se validan con
el mismo patrón que las lecturas y nunca se interpolan en una shell.

### Contrato HTTP

Agente: `POST /command` con `Authorization: Bearer <AGENT_TOKEN>` y cuerpo estricto
`{"command": "<nombre>"}`. Responde `200 {"command": "<nombre>", "status": "success"}`.
Un nombre desconocido, una unidad no configurada o un cuerpo con campos extra responde
`400`. Un fallo no confirmado del auxiliar responde `502`.

Hub: `POST /api/host-command?host=<id>` con `Idempotency-Key: <uuid>` y cuerpo
`{"command": "<nombre>"}`. Mantiene la comprobación de origen y de sesión actual. La
respuesta correcta es:

```json
{
  "ok": true,
  "status": "success",
  "operation": { "id": "…", "action": "pause-follower", "target": "NAS-HOME", "status": "success" },
  "result": { "command": "pause-follower", "status": "success" }
}
```

Reglas:

- Cada acción inserta una fila en `operations` con estado `pending` antes de llamar al
  agente y la actualiza a `success` o `failed`.
- La clave de idempotencia es por host: repetirla devuelve la operación existente sin
  ejecutar el comando; usarla en otro host responde `409`.
- Si el host no está conectado, responde `503` y no crea operación ni llama al agente.
- Si la respuesta se pierde o el agente responde `5xx`, la operación queda `pending` y
  se responde `502`. El hub no reintenta nunca; el Operador comprueba la franja antes de
  repetir con una clave nueva.
- Tras ejecutar (o intentar) un comando, el agente invalida su caché de instantánea. La
  siguiente lectura de `/maintenance` refleja la pausa o reanudación sin esperar los 60 s.
- Las respuestas, los errores y el registro de operaciones no contienen el token del
  agente, rutas del host ni la salida del auxiliar.

El auxiliar de los comandos es el mismo contenedor privilegiado con `nsenter` que usan
las lecturas de systemd: recibe un `argv` fijo y no hay endpoint para comandos
arbitrarios. SMART usa su propio contenedor de solo lectura, sin comandos de escritura.
El contrato de tipos y la lista cerrada para la interfaz están en
`src/lib/host-command-contract.ts`; la lista de Python, en `agent/host_commands.py`.

## Fallos, caché y seguridad

- La instantánea se cachea `MAINTENANCE_CACHE_SECONDS` (60 s por defecto). Varias
  peticiones seguidas devuelven el mismo `timestamp` y no repiten las lecturas.
- Las lecturas de systemd, Docker, SMART y del estado se hacen en paralelo. Un fallo
  aislado no oculta el resto: la sección queda en su valor vacío y su nombre aparece en
  `degraded`. Un fallo de lectura SMART de un solo disco se limita a ese disco.
- `404 Host no configurado` lo produce el hub antes de llamar al agente. Si el agente no
  responde o rechaza, el hub devuelve `503`. Las lecturas nunca se reintentan desde el
  hub.
- No se publican tokens, URLs de agentes, rutas del host, `.env`, `before_pins`,
  `snapshots` ni el contenido de `folder`/`environment` de una transacción.
- Las lecturas de systemd, unidades fallidas y reinicio usan un contenedor auxiliar
  privilegiado con `nsenter` y una línea de órdenes fija. SMART usa otro contenedor de la
  misma imagen con `/dev` y `/sys` en solo lectura y `smartctl` como entrada. No hay
  endpoint para comandos arbitrarios ni argumentos libres.
- El número de serie y el modelo son identificadores del hardware, no secretos; no se
  publican rutas completas del host ni el contenido de los comandos ejecutados.

## Pruebas

- `agent/test_smart.py`: JSON realistas de smartctl para SATA WD Red y NVMe, tres WD Red y
  dos NVMe en el mismo escaneo, umbrales de temperatura/desgaste, aumento de sectores
  reasignados entre lecturas, disco sin datos SMART, fallo de un disco aislado y lista
  cerrada de comandos de solo lectura.
- `agent/test_maintenance.py`: directorios temporales con los JSON reales, unidades y
  Docker inyectados, comprobación de caché, degradación, sección `disks`, separación de
  unidades fallidas, reinicio disponible/no disponible, lista cerrada de unidades,
  ejecutor `nsenter` y ejecutor SMART con `/dev` read-only.
- `agent/test_host_commands.py`: nombres de unidad por rol, `argv` fijo para cada
  comando, rechazo de nombres y argumentos libres, código de salida del auxiliar, caché
  invalidada tras la acción y rutas HTTP del agente.
- `tests/api-maintenance.test.ts`: agente HTTP falso por host, selección de host, extensión
  `disks` del contrato, ausencia de credenciales en la respuesta y no reintento cuando el
  agente falla.
- `tests/api-host-commands.test.ts`: comandos permitidos por host, origen, idempotencia,
  `operations`, rechazo del agente y resultado incierto sin reintento.
