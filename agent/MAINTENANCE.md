# Instantánea de mantenimiento del agente

Contrato backend del ticket #17 para la franja **Mantenimiento · Estado** y la tabla de
**Automatismos** de `DESIGN.md`. El hub la consume con
`GET /api/maintenance?host=<id>`; el agente la publica en `GET /maintenance`.

## Configuración y montajes

El agente solo lee. No escribe en el checkout ni en el estado de media-stack.

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

El auxiliar es el mismo contenedor privilegiado con `nsenter` que usan las lecturas:
recibe un `argv` fijo y no hay endpoint para comandos arbitrarios. El contrato de tipos y
la lista cerrada para la interfaz están en `src/lib/host-command-contract.ts`; la lista
de Python, en `agent/host_commands.py`.

## Acciones de mantenimiento (ticket #20)

Las cuatro acciones nuevas usan el mismo `POST /command` del agente y la misma ruta
`POST /api/host-command` del hub: el cuerpo solo lleva el nombre de la acción, el hub
mantiene origen, sesión, host, `Idempotency-Key`, fila en `operations` y la regla de no
reintentar nunca una respuesta incierta. `agent/maintenance_actions.py` contiene las
líneas de órdenes fijas; no hay argumentos libres.

| Acción | Efecto | Rol |
| --- | --- | --- |
| `backup-now` | Ejecuta `media-backup run` con un `exec` fijo en el contenedor `backup` | Ambos |
| `clean-images` | Borra una a una las imágenes sin contenedor que no sean de rollback | Ambos |
| `check-health` | Lee la salud de la VPN y de las apps del proyecto Compose del rol | Ambos |
| `reconnect-apps` | Relanza la Wiring con el comando documentado | Solo `instance` |

### Copia ahora

No usa el auxiliar privilegiado: crea un `exec` de Docker con
`Cmd: ["media-backup", "run"]` en el contenedor de nombre fijo `backup` y lo arranca
sin adjuntarse. El contenedor debe existir y estar en ejecución. La respuesta incluye
`backup.started` y el `last-status` vigente, leído del mismo formato real que la
instantánea (`ok <ISO>` o `failed <ISO>`); la copia sigue en segundo plano y el estado
definitivo aparece en la siguiente instantánea.

### Limpiar imágenes

Antes de tocar Docker lee y valida **todo** el estado de rollback. Si falta un dato
obligatorio o un JSON no se puede leer, la acción falla con `400` y no borra ninguna
imagen (fail closed). Fuentes reales que se conservan:

| Ruta | Qué se conserva |
| --- | --- |
| `security-monitor/images.compose.json` | Todos los `services.*.image` (pins activos) |
| `security-monitor/active-update.json` | `old_id`, `old_pin` y todos los `before_pins.services.*.image` |
| `security-monitor/merged-releases/pending.json` | Todos los `images.*.id` y `images.*.reference` del seguidor |

También se conserva cualquier imagen usada por un contenedor, incluidos los detenidos
(`/containers/json?all=1`), y las que Docker marca con contenedores. Las imágenes
restantes se borran **por identificador** (`DELETE /images/<id>?force=0&noprune=1`),
nunca con `docker image prune` ni con un filtro global. Se ordenan de más reciente a
más antigua para que las capas hijas se borren antes que sus padres; un borrado
rechazado se cuenta en `imagesFailed` y no se reintenta.

```json
{
  "command": "clean-images",
  "status": "success",
  "cleanup": {
    "reclaimedBytes": 30000000000,
    "imagesRemoved": 12,
    "imagesPreserved": 4,
    "imagesFailed": 0
  }
}
```

`reclaimedBytes` suma el `Size` de las imágenes borradas, igual que la estimación de
`docker system df`; no es una promesa de bloques liberados. La validación de los ~30 GB
del NAS se hace en despliegue, nunca en los tests.

### Comprobar salud

Lee la lista de contenedores y su `State` con la API de Docker, limitada al proyecto
Compose del rol (`media-stack` en `instance`, `media-stack-apps` en `apps-server`):

- `vpn`: en `instance` busca el servicio `gluetun`; `connected` es cierto solo si está
  en ejecución y su healthcheck propio está `healthy`. En `apps-server` no aplica y
  `connected` es `null`. Si en `instance` falta gluetun, `connected` es `false`.
- `apps`: todos los servicios del proyecto menos `gluetun`, `wire` y `wire-seed`
  (los dos últimos son one-shot). Cada app lleva `name`, `service`, `state`, `health`
  y `healthy`; una app está sana si está en ejecución y su salud es `healthy` o no
  declara healthcheck. `healthy` global es cierto si lo están todas y la VPN no falla.

```json
{
  "command": "check-health",
  "status": "success",
  "health": {
    "vpn": { "applicable": true, "connected": true, "state": "running", "health": "healthy" },
    "apps": [
      { "name": "jellyfin", "service": "jellyfin", "state": "running", "health": "healthy", "healthy": true }
    ],
    "healthy": true
  }
}
```

### Reconectar apps

En `instance` ejecuta el comando documentado por media-stack, con la ruta del checkout
tomada de `MEDIA_STACK_CHECKOUT_PATH` y sin argumentos de la petición:

```text
docker compose --project-directory <checkout> --env-file <checkout>/.env up -d --no-deps wire
```

Se ejecuta en el auxiliar privilegiado con `argv` fijo y no se reintenta. En
`apps-server` no hay Wiring: la acción responde `400` sin ejecutar nada. Una salida
distinta de cero responde `502` y deja la operación pendiente de verificar.

```json
{ "command": "reconnect-apps", "status": "success", "wiring": { "started": true } }
```

## Fallos, caché y seguridad

- La instantánea se cachea `MAINTENANCE_CACHE_SECONDS` (60 s por defecto). Varias
  peticiones seguidas devuelven el mismo `timestamp` y no repiten las lecturas.
- Las lecturas de systemd, Docker y del estado se hacen en paralelo. Un fallo aislado no
  oculta el resto: la sección queda en su valor vacío y su nombre aparece en `degraded`.
- `404 Host no configurado` lo produce el hub antes de llamar al agente. Si el agente no
  responde o rechaza, el hub devuelve `503`. Las lecturas nunca se reintentan desde el
  hub.
- No se publican tokens, URLs de agentes, rutas del host, `.env`, `before_pins`,
  `snapshots` ni el contenido de `folder`/`environment` de una transacción.
- Las lecturas de systemd, unidades fallidas y reinicio usan un contenedor auxiliar
  privilegiado con `nsenter` y una línea de órdenes fija. No hay endpoint para comandos
  arbitrarios ni argumentos libres.

## Pruebas

- `agent/test_maintenance.py`: directorios temporales con los JSON reales, unidades y
  Docker inyectados, comprobación de caché, degradación, separación de unidades fallidas,
  reinicio disponible/no disponible, lista cerrada de unidades y ejecutor `nsenter`.
- `agent/test_host_commands.py`: nombres de unidad por rol, `argv` fijo para cada
  comando, rechazo de nombres y argumentos libres, código de salida del auxiliar, caché
  invalidada tras la acción y rutas HTTP del agente.
- `agent/test_maintenance_actions.py`: Docker y ejecutor falsos, archivos de estado
  temporales. Comprueba el `exec` fijo de la copia sin auxiliar, el borrado selectivo de
  imágenes sin contenedor, la conservación de todos los pins de rollback, el fallo
  cerrado ante JSON ilegible, la salud de VPN/apps por rol y el comando fijo de la
  Wiring con rechazo en `apps-server`.
- `tests/api-maintenance.test.ts`: agente HTTP falso por host, selección de host, ausencia
  de credenciales en la respuesta y no reintento cuando el agente falla.
- `tests/api-host-commands.test.ts`: comandos permitidos por host, origen, idempotencia,
  `operations`, resultado estructurado de las cuatro acciones nuevas, rechazo del agente
  y resultado incierto sin reintento.
