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
- `tests/api-maintenance.test.ts`: agente HTTP falso por host, selección de host, ausencia
  de credenciales en la respuesta y no reintento cuando el agente falla.

## Despliegues (#23)

Contrato de lectura para **Mantenimiento · Despliegues**. El hub lo consume con
`GET /api/deployments?host=<id>&lines=<1..500>`; el agente lo publica en
`GET /deployments?lines=<1..500>`. Por defecto devuelve las últimas 100 líneas del
registro. No existe ningún endpoint de escritura: los ajustes de una release retenida
llegan en el ticket #24.

La instantánea se cachea `DEPLOYMENTS_CACHE_SECONDS` (30 s por defecto), porque cada
petición ejecuta Git y lee el journal. Un fallo aislado deja su sección vacía y añade
el nombre a `degraded`; no oculta el resto.

### Respuesta

```json
{
  "timestamp": 1763040000,
  "role": "instance",
  "available": true,
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
  "blocker": {
    "code": "dirty-checkout",
    "release": null,
    "files": [
      { "status": "M", "path": "stacks/wire/compose.yaml", "from": null }
    ],
    "missingSettings": []
  },
  "history": [
    {
      "release": "v2.4.1",
      "outcome": "success",
      "at": "2026-11-13T03:04:49Z",
      "previousRelease": "v2.4.0",
      "services": ["radarr", "sonarr"]
    }
  ],
  "retained": [
    {
      "release": "v2.5.0",
      "reason": "missing-configuration",
      "blockedBy": null,
      "breaking": false,
      "manualSteps": ["Fill NEW_SETTING in .env."],
      "missingSettings": ["NEW_SETTING"],
      "services": ["radarr"],
      "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
      "at": "2026-11-12T02:00:00Z"
    }
  ],
  "journal": {
    "entries": [
      {
        "at": "2026-11-13T17:01:00Z",
        "unit": "media-stack-merged-updates.service",
        "priority": 6,
        "level": "info",
        "message": "v2.4.1: radarr, sonarr"
      }
    ]
  },
  "degraded": []
}
```

`follower` usa el mismo contrato que #17. `blocker` puede ser `null`. Los códigos son
estables para la interfaz; los textos visibles se escriben en el hub. La celda
**Seguridad** de la franja se lee de la instantánea #17 (`GET /api/maintenance`); este
contrato no duplica pins, actualización pendiente ni revisión. El **último fallo** es
`follower.failed`.

### Historia del seguidor

| Origen real | Campo | Regla |
| --- | --- | --- |
| `security-monitor/merged-releases/<uuid>/result.json` | `history[]` | Una entrada por transacción terminada |
| `status: "updated"` | `outcome` | `success` |
| `status: "rolled_back"` | `outcome` | `rolled-back` |
| mtime de `result.json` | `at` | Fecha ISO 8601 en UTC |
| `changed` | `services` | Servicios recreados por el seguidor |
| `previous_installed.release` | `previousRelease` | Release anterior |

`follower` reutiliza la sección ya documentada de #17 (`installed`, `pending`,
`failed`). Nunca se publican `folder`, `environment`, `snapshots`, `pins` ni
`previous_commit`. Las entradas se ordenan de más reciente a más antigua y se limitan
a 20.

### Bloqueo y releases retenidas

`blocker` explica por qué el seguidor no puede desplegar ahora. Se elige por este
orden: transacción pendiente, recuperación de seguridad pendiente, checkout no
disponible, checkout sucio y, por último, ajuste que falta en la siguiente release.
`files` solo se rellena con el checkout sucio: cada entrada lleva `status`, `path` y
`from` (ruta original de un rename/copia). Los archivos se listan con
`git status --porcelain=v1 -z --untracked-files=all`, hasta 200.

Cada release posterior a la instalada que no puede aplicarse aparece en `retained`:

| `reason` | Cuándo | Campos útiles |
| --- | --- | --- |
| `release-recovery-pending` | Existe `pending.json` | `follower.pending` |
| `security-recovery-pending` | Existe `security-monitor/active-update.json` | — |
| `checkout-unavailable` | No se puede leer el checkout | `available: false` |
| `dirty-checkout` | `git status` no está limpio | `blocker.files` |
| `missing-manifest` | La etiqueta no tiene `docs/releases/<tag>.deploy.json` o no autoriza este rol | `sourceCommit: null` |
| `invalid-manifest` | El `source_commit` no es ancestro de la etiqueta, o la etiqueta queda fuera de `origin/main` | `sourceCommit: null` |
| `missing-configuration` | Claves de `.env.example` de la release ausentes en el `.env` | `missingSettings` |
| `previously-failed` | `failed-release.json` coincide con release y configuración actual | — |
| `blocked-by-previous-release` | Una release anterior necesita ajustes o tiene un manifiesto inválido | `blockedBy` |

El manifiesto se considera válido con `schema: 1`, `approved_merge: true`, el rol del
host en `roles` y un `source_commit` SHA-1 de 40 hex. Si existe
`refs/remotes/origin/main`, la etiqueta debe estar dentro de esa rama; además, el
`source_commit` debe ser ancestro de la etiqueta. El seguidor repite estas mismas
comprobaciones al aplicar.

`manualSteps` son los bullets de `## Manual steps` de
`docs/releases/<tag>.md`; los placeholders `None` de las releases automáticas se
descartan. `breaking` refleja `Breaking changes: yes`.

`missingSettings` son solo nombres de variables, nunca valores. Para la Instancia se
lee `.env`; para el servidor de apps, `apps-server/.env`. La lista respeta el orden de
`.env.example`.

`services` son los servicios que la release recreará. Si una transacción ya intentó esa
release, se usa su `changed` real. Si no, se comparan las definiciones efectivas de
Compose entre el commit instalado y la etiqueta: se excluyen los perfiles no activos en
`COMPOSE_PROFILES` y los servicios con `restart: "no"`, y se añaden los consumidores de
un espacio de red (`network_mode: service:<gateway>`) cuando cambia su gateway. Es una
previsión para la fila expandible; el seguidor confirma la lista al aplicar.

### Registro

`journal.entries` solo puede contener unidades del rol cuyo tipo sea `follower`,
`security` o `backup` (los mismos nombres por defecto o `MAINTENANCE_UNITS` de #17),
tanto `.service` como `.timer`. Se leen con una orden fija en el auxiliar privilegiado:

```
journalctl --no-pager --output=json --utc --lines <N> --unit=<permitida>...
```

No hay parámetro para elegir unidad ni argumentos libres. Cada entrada publica solo
`at`, `unit`, `priority`, `level` (`error`, `warning`, `info`, `debug`) y `message`.
Se eliminan códigos ANSI y caracteres de control, se limita el tamaño y se redactan
valores tras `token`, `password`, `secret`, `api_key`, `authorization` o `Bearer`.
Los mensajes del journal nunca se copian a `operations` ni a los logs del hub.

### Lectura de Git

`GitReader` ejecuta una lista cerrada de órdenes sin shell (`status`, `tag`, `show`,
`diff`, `ls-tree`, `log`, `rev-parse`, `merge-base`), siempre con
`--no-optional-locks`, `safe.directory=<checkout>`, `core.hooksPath=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0` y un tiempo máximo. Las revisiones se
validan contra un patrón cerrado y las rutas son constantes del contrato. El checkout
se monta en solo lectura; esta lectura no crea worktrees, índices ni etiquetas.

### Pruebas

`agent/test_deployments.py`: repositorio Git temporal con etiquetas y manifiestos,
estado real del seguidor, checkout sucio con rename y archivos sin seguimiento,
bloqueos pendientes, configuración ausente, release fallida con la misma configuración,
servicios por definición y por espacio de red, journal simulado con unidades ajenas y
secretos, degradación y caché. La ruta `/deployments` se prueba con un agente HTTP real
y un doble del módulo.

`tests/api-deployments.test.ts`: agente HTTP falso, host seleccionado, cola del journal,
validación de `lines`, host desconocido y ausencia de reintentos.
