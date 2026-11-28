# Cutover de media-stack al ingest del hub

Checklist para dejar de enviar avisos desde `media-stack` y pasarlos al ingest firmado del hub (`POST /api/notifications/ingest`). Lo ejecuta el usuario: nadie aplica nada en el NAS por SSH en su nombre. Los ejemplos no contienen secretos y el secreto nunca va como argumento de un comando.

## 1. Resumen y orden obligatorio

Tras el cutover solo dos familias publican en el ingest: la copia (`backup-failed`) e issue-automator (aperturas y cierres de issues de Seerr). El resto de emisores de Telegram de `media-stack` se apagan sin sustituto (upgrade, merged-updates, security-updater, security-monitor y el trigger de Telegram de WUD). El fallback directo de la copia queda limitado a `backup-failed`.

El orden es obligatorio, porque un `media-stack` nuevo con el hub viejo dejaría la copia y las issues sin camino de aviso:

1. **Hub con el ingest desplegado**, con `NOTIFY_INGEST_SECRET` en su `.env`. Mientras no haya secreto, el ingest responde 503.
2. **Eventos de prueba** con `scripts/ingest-test-event.sh` (sección 3) y comprobación en el hub.
3. **Release de `media-stack`** con el proceso normal del usuario (sección 7).

No pases al paso siguiente sin haber comprobado el anterior.

## 2. Requisitos previos

- Un secreto generado una vez con `openssl rand -hex 32`. El mismo valor va en `NOTIFY_INGEST_SECRET` del `.env` del hub y en `NOTIFY_INGEST_SECRET` del `.env` de `media-stack` (Instancia). Escríbelo directamente en los `.env`, no en la línea de comandos, y no lo pegues en chats ni tickets. `NOTIFY_INGEST_SECRET_PREVIOUS` se deja sin definir en el cutover: solo sirve durante una rotación (véase `docs/rotacion-token-y-secreto.md`).
- `NOTIFY_INGEST_URL` en el `.env` de `media-stack`: la URL completa del ingest, alcanzable **desde los contenedores** del NAS (por ejemplo `http://<IP-Tailscale-del-hub>:4323/api/notifications/ingest`). Que el Mac llegue al hub no prueba que un contenedor llegue: se comprueba en la sección 3.
- `NOTIFY_INGEST_HOST_ID` en el `.env` de `media-stack`: un identificador de host que exista en `NAS_HOSTS` del hub (por defecto `nas-home`). Un host desconocido recibe 422.
- La carpeta `<APPDATA_ROOT>/issue-automator`. La crea `scripts/init.sh` con el propietario de la Instancia al aplicar la release; sin ella issue-automator no arranca y el servicio falla con un mensaje que nombra la carpeta.
- Herramientas para el script de pruebas: `curl`, `openssl` y `jq`. En un contenedor Alpine: `apk add --no-cache curl openssl jq`.

## 3. Eventos de prueba por familia

Cada familia con ingest recibe un evento firmado de prueba y se comprueba el resultado en el hub (D-09). El script firma con el secreto leído del entorno:

```sh
read -rs NOTIFY_INGEST_SECRET && export NOTIFY_INGEST_SECRET
export NOTIFY_INGEST_URL='http://<IP-Tailscale-del-hub>:4323/api/notifications/ingest'
```

`INGEST_DRY_RUN=1` imprime las cabeceras y el cuerpo sin enviar nada: úsalo antes de la primera vez para ver lo que se firmaría.

**Copia: abrir y cerrar.** `--state both` envía `open` y después `resolved` con identificadores distintos, de modo que la prueba no deja nada abierto:

```sh
scripts/ingest-test-event.sh --url "$NOTIFY_INGEST_URL" \
  --source backup --host-id nas-home --key backup-failed --state both \
  --error "prueba de ingest"
```

**Issue de Seerr: abrir y cerrar.** La clave es `issue:seerr:<número>`; usa un número que no sea de una issue real:

```sh
scripts/ingest-test-event.sh --url "$NOTIFY_INGEST_URL" \
  --source issue-automator --host-id nas-home --key issue:seerr:900001 --state both \
  --subject "Prueba de ingest" --reported-by prueba --problem "Prueba"
```

Cada petición imprime el estado (`open` o `resolved`), el código HTTP y la respuesta; el script sale con 0 solo si todas son 2xx. Esperado: `202` en cada una.

**Qué comprobar en el hub, por familia:**

- Aparece una incidencia de la familia (copia fallida o issue) y llega su aviso a Telegram.
- Al cerrar, la incidencia queda resuelta y el mensaje original se **edita**; no llega otro mensaje.
- Repetir exactamente el mismo comando con el mismo `--event-id` fijo responde `200` (duplicado) y no abre otra incidencia. Un `--event-id` repetido con otro contenido responde `409`.
- Una respuesta `401` es firma, ventana de tiempo o cabecera incorrectas (compara el secreto de ambos lados y la hora del equipo); `422` es una clave o un host fuera de alcance; `503` es un hub sin `NOTIFY_INGEST_SECRET`.

**Desde el Mac y desde un contenedor.** Ejecuta las pruebas desde el Mac y repite una desde un contenedor del NAS para probar la alcanzabilidad contenedor a hub. El contenedor recibe el secreto y la URL del entorno, no por argumento:

```sh
docker run --rm -e NOTIFY_INGEST_SECRET -e NOTIFY_INGEST_URL \
  -v "$PWD/scripts/ingest-test-event.sh:/ingest-test-event.sh:ro" \
  alpine:3.24 sh -c '
    apk add --no-cache curl openssl jq >/dev/null &&
    sh /ingest-test-event.sh --url "$NOTIFY_INGEST_URL" \
      --source backup --host-id nas-home --key backup-failed --state both \
      --error "prueba desde contenedor"'
```

Si el contenedor no llega al hub pero el Mac sí, arréglalo antes de seguir (ruta de red, `NOTIFY_INGEST_URL`); la release no lo resolverá.

## 4. Verificación de emisores apagados

Para las familias que solo se apagan (D-09), el emisor ya no debe tener token ni trigger de Telegram en el `.env` ni en el compose desplegados. Tras el release, lista los contenedores que aún reciben el token (solo imprime nombres, no valores):

```sh
docker ps -a --format '{{.Names}}' | while read -r c; do
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" \
    | grep -q '^TELEGRAM_BOT_TOKEN=' && echo "$c"
done
```

Debe aparecer únicamente la copia (el contenedor `backup`). Y para el trigger de WUD, que no debe aparecer ninguno:

```sh
docker ps -a --format '{{.Names}}' | while read -r c; do
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" \
    | grep -q '^WUD_TRIGGER_TELEGRAM_' && echo "$c"
done
```

Por familia:

| Familia                             | Qué debe ocurrir                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| upgrade-script y merged-updates     | Sin envío a Telegram. Los fallos los cubren `deploy-failed` y `release-retained` del hub; las releases correctas no avisan. |
| security-updater y security-monitor | Sin token de Telegram en el contenedor y sin sustituto. Las revisiones manuales siguen en Mantenimiento.                    |
| WUD                                 | Sin `WUD_TRIGGER_TELEGRAM_*`. Solo queda su interfaz.                                                                       |
| issue-automator                     | Sin token de Telegram; publica en el ingest.                                                                                |
| copia                               | Conserva el token solo para el fallback directo de `backup-failed`.                                                         |

## 5. Seerr: activar «Issue Resolved»

issue-automator solo publica el cierre si Seerr lo notifica. En la interfaz de Seerr, abre la notificación por webhook que apunta a issue-automator y activa el tipo **Issue Resolved**, además de los que ya estén activos para la apertura. Prueba con una issue real de prueba: ábrela, comprueba la incidencia en el hub, ciérrala en Seerr y comprueba que el mensaje se edita.

## 6. Emisor SMART externo

La auditoría encontró avisos de disco SMART que no salen de ningún repositorio: probablemente `smartd`, un cron o una herramienta del propio NAS. Esto no se puede buscar desde el ejecutor, así que lo haces tú:

1. Busca en el NAS cualquier tarea que envíe a Telegram: `smartd` y su `smartd.conf` (directivas `-m` o `-M exec`), tareas programadas del panel del NAS, `crontab -l` de cada usuario y `/etc/cron*`, y las notificaciones de la propia herramienta de gestión de discos.
2. Apaga ese emisor (quita la directiva, la tarea o la notificación).
3. El hub cubre los discos con `disk-health`: un disco en `fail` abre un aviso inmediato y `watch` va al resumen diario, a partir de la instantánea del agente. No hace falta sustituto.

Anota dónde estaba el emisor y cómo lo apagaste.

## 7. Release de media-stack y verificación posterior

Despliega `media-stack` con tu proceso de release normal, con el hub y los eventos de prueba ya comprobados. Después:

- Con `media-backup notify-test ingest` (abre y cierra una incidencia de prueba de la copia por el ingest) y `media-backup notify-test fallback` (envía un aviso directo de prueba al mismo bot), comprueba cada camino desde el contenedor de la copia:

  ```sh
  docker compose exec backup media-backup notify-test ingest
  docker compose exec backup media-backup notify-test fallback
  ```

  Ejecútalos desde la carpeta del stack de la copia (el servicio se llama `backup`). El segundo debe llegar a Telegram con el prefijo fijo de aviso directo, distinguible de los avisos del hub.

- Abre y cierra una issue real de prueba en Seerr y comprueba la incidencia y la edición del mensaje.
- Repite la comprobación de la sección 4 sobre lo que quedó desplegado.

## 8. Limpieza de colas obsoletas

Los seguidores de release y security-monitor guardaban avisos pendientes en `notifications.json` y `update-notifications.json` dentro de su directorio de estado. Ya nadie los lee con el código nuevo y un fichero antiguo conservaría avisos viejos. Localízalos y bórralos tras la release:

```sh
find <APPDATA_ROOT> <carpeta-del-checkout-de-media-stack> \
  \( -name notifications.json -o -name update-notifications.json \) -print
```

Revisa la lista antes de borrar nada.

## 9. Bandeja de issue-automator

issue-automator no entrega los eventos en línea. Guarda cada apertura y cada cierre de issue en `<APPDATA_ROOT>/issue-automator` (montada en `/outbox`, un fichero JSON por evento) y lo reintenta hasta que el hub responde 2xx. Una caída del hub o un reinicio del contenedor no pierden un cierre. Los reintentos usan esperas crecientes (de 15 s hasta un máximo de 15 minutos), el mismo identificador de evento y una firma nueva en cada intento, y el cierre de una issue nunca se entrega antes de que su apertura esté confirmada.

Qué comprobar:

```sh
curl http://localhost:5056/health
```

La respuesta incluye `pending`: el número de eventos sin confirmar. Debe volver a 0 en cuanto el hub responde. Si se queda por encima de 0, mira el estado del hub y el registro del contenedor (registra identificadores de evento, nunca cuerpos ni secretos).

Límites: se descarta un evento con más de 14 días y, por encima de 200 pendientes, el más antiguo. El hub no cierra incidencias por antigüedad ni sondea Seerr: lo que se descartó por límite se cierra a mano en el hub.

## 10. Duplicado conocido de la copia (comportamiento aceptado)

Si el hub estaba caído o tardó en confirmar, la copia envía el aviso directo a Telegram y, cuando el hub vuelve, el evento reintentado puede abrir la misma incidencia. Verás un aviso directo (con prefijo propio) y después el aviso del hub. **No es un defecto**: se acepta a cambio de no perder nunca un fallo de copia. Cierra la incidencia del hub como cualquier otra.

## 11. Vuelta atrás

La vuelta atrás es revertir el commit de `media-stack` y desplegar la release resultante. No hay interruptores por familia ni código de doble camino. Antes de hacerlo, ten en cuenta:

- Una cola antigua (`notifications.json`, `update-notifications.json`) que sigas teniendo puede reenviarse al volver el código antiguo. Revísala y bórrala si no quieres avisos viejos.
- Los ficheros pendientes de `<APPDATA_ROOT>/issue-automator` los dejaría sin leer el código antiguo. Si no vas a reaplicar el cutover enseguida, bórralos: un evento viejo se entregaría más tarde, cuando vuelva a aplicarse, y abriría o cerraría una issue que ya no corresponde.
- El hub no necesita cambios: el ingest simplemente deja de recibir eventos.
- Si apagaste el emisor SMART externo, vuelve a activarlo solo si también revierte el hub la cobertura de `disk-health`.
