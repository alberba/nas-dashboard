# Rotación del token del bot y del secreto del ingest

Runbook para rotar de forma conjunta el token del bot de Telegram y el secreto HMAC del ingest (`NOTIFY_INGEST_SECRET`). Ningún ejemplo contiene valores reales: los secretos se leen con `read -rs` o se editan en los `.env`, nunca van como argumento de un comando ni quedan en el historial del shell.

## 1. Alcance y por qué es de un solo sentido

Hay dos rotaciones independientes:

- **Token del bot (D-16).** Lo usan el hub (envía todos los avisos) y la copia de `media-stack` (aviso directo de `backup-failed` cuando el hub no confirma). Revocar el token en BotFather lo invalida para siempre y **no hay solapamiento**: el token anterior deja de funcionar en el acto. Si se olvida un `.env`, ese camino queda mudo hasta que se corrija.
- **Secreto HMAC del ingest (D-17).** Lo comparten el hub y `media-stack` (copia e issue-automator). Aquí sí hay solapamiento: el hub acepta el secreto actual y el anterior (`NOTIFY_INGEST_SECRET_PREVIOUS`), de modo que no se pierde ningún evento mientras ambos lados cambian.

Haz primero la del token (es de un solo sentido y tiene ventana ciega) y, cuando los dos caminos de salida funcionen con el token nuevo, la del secreto (con solape, sin ventana). Nunca las dos a la vez: así un fallo se atribuye a una sola causa y, si el token falla, el secreto sigue intacto. Elige un momento sin copia nocturna ni actualización de `media-stack` en curso: durante la ventana ciega el hub recibe `401` de Telegram y el aviso directo de la copia tampoco enviaría.

## 2. Antes de empezar

- Localiza **todos** los `.env` que tienen el token: el del hub (servidor de webs, SSH `ubuntu@oracle-web`, `/opt/nas-dashboard/.env`), el de la Instancia de `media-stack` (en el NAS, que alimenta la copia: el `.env` de la carpeta de la Instancia es un enlace a un directorio solo de `root`, así que se edita con `sudo`) y el del Servidor de apps solo si aún conserva `TELEGRAM_BOT_TOKEN`. El secreto del ingest está en el del hub y en el de la Instancia.
- Guarda una copia de cada `.env` antes de tocarlo, con permisos 0600, para poder volver si algo sale mal.
- En el NAS, averigua con qué ficheros de compose se levantó la Instancia, porque hay que recrear con los mismos (y con el perfil `extras`): `sudo docker inspect backup --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'`. El comando de recreación de los pasos siguientes usa ese valor en `<ficheros -f>`.
- Apunta la hora de cada hito (revocación, recreación del hub, recreación de la copia): la sección 4 las necesita.
- Ten a mano el comando para ver el estado: `docker compose ps` en el hub y en la Instancia.
- Ten `scripts/ingest-test-event.sh` disponible (necesita `curl`, `openssl` y `jq`).

## 3. Rotación del token del bot

El orden importa porque no hay solapamiento: minimiza el tiempo entre revocar y recrear.

1. **Obtén el token nuevo.** En BotFather, `/revoke` sobre el bot genera el token nuevo y anula el anterior en ese momento. Cópialo en un gestor de contraseñas, no en un chat. A partir de aquí empieza la ventana ciega (sección 4).
2. **Actualiza los `.env`.** Edita `TELEGRAM_BOT_TOKEN` en el `.env` del hub y en el de `media-stack` (Instancia, y el del Servidor de apps si lo conserva). Hazlo con el editor, no con `echo` ni `sed` con el valor en la línea de comandos. `TELEGRAM_CHAT_ID` no cambia.
3. **Recrea los servicios afectados.** `restart` no relee el `.env`; hace falta recrear:

   ```sh
   # Hub (en /opt/nas-dashboard, servidor de webs)
   docker compose up -d --force-recreate app worker

   # media-stack: la copia (en el NAS, con los mismos ficheros y perfil con los que
   # se levantó la Instancia, y con sudo)
   sudo docker compose -p media-stack <ficheros -f> --profile extras up -d --force-recreate backup
   ```

   `backup` es el único servicio de `media-stack` con credenciales de Telegram; recrea también cualquier otro que siga declarando el token.

4. **Verifica el token con `getMe`.** La URL contiene el token, así que se pasa por entrada estándar a `curl -K -` en lugar de por argumento:

   ```sh
   read -rs TELEGRAM_BOT_TOKEN
   printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$TELEGRAM_BOT_TOKEN" | curl -sS -K -
   unset TELEGRAM_BOT_TOKEN
   ```

   Para ver solo lo que importa, encadena `| jq '{ok, username: .result.username}'` al `curl`. Debe responder `"ok":true` con el nombre del bot. Un `401` significa que copiaste mal el token.

5. **Aviso de prueba por cada camino.**
   - Hub a Telegram: firma un evento de prueba con `scripts/ingest-test-event.sh` y el secreto vigente (véase la sección 5, paso 4) con `--state both`: dos `202`, el mensaje llega al chat y se edita al cerrar, ya con el token nuevo.
   - Fallback de la copia a Telegram: `sudo docker exec backup media-backup notify-test fallback` en el NAS (sin `sudo` si tu usuario está en el grupo docker). Debe salir con 0 y llegar un aviso directo de prueba con el prefijo fijo.

## 4. La ventana ciega

Entre revocar el token (paso 1) y recrear los servicios (paso 3) los dos caminos están mudos:

- El hub recibe `401` de Telegram y registra el motivo `telegram_401`. Los avisos pendientes se reintentan con espera creciente; si se agotan los intentos antes de recrear, el aviso queda como fallido.
- La copia no puede hacer el aviso directo.

Mide la ventana con las horas apuntadas: de la revocación a la recreación del hub, y de la revocación a la recreación de la copia. Después de la verificación, revisa lo que pasó durante la ventana: en la pantalla de alertas, las entregas rechazadas con «El proveedor rechazó la credencial» (`telegram_401`) entre esas dos horas (cuántas fueron), las incidencias abiertas cuyo aviso quedó fallido y el estado del resumen diario si cayó en la ventana. Reenvía o cierra a mano lo que haga falta. Si ocurrió un fallo de copia real durante la ventana, el evento llegó al ingest (el ingest no usa el token), así que la incidencia existe aunque el mensaje no saliera.

Para acortar la ventana, deja los `.env` abiertos en el editor antes de revocar y ejecuta el recreado nada más guardar. Guarda el token nuevo en el gestor de contraseñas antes de tocar ningún `.env`: si se pierde, BotFather permite volver a leer el token vigente.

## 5. Rotación del secreto HMAC del ingest

Sin ventana ciega: el hub acepta ambos secretos durante la transición.

1. **Genera el secreto nuevo** (al menos 32 caracteres; el arranque rechaza el valor de ejemplo):

   ```sh
   openssl rand -hex 32
   ```

   Guárdalo en el gestor de contraseñas y escríbelo directamente en los `.env`.

2. **Hub: nuevo y anterior.** En el `.env` del hub pon el valor nuevo en `NOTIFY_INGEST_SECRET` y el valor que había hasta ahora en `NOTIFY_INGEST_SECRET_PREVIOUS`. Recrea el servicio que verifica las firmas: `docker compose up -d --force-recreate app` (el `worker` no verifica firmas del ingest; recrearlo también es inofensivo). El hub verifica cada firma contra los dos.
3. **`media-stack`.** Pon el secreto nuevo en `NOTIFY_INGEST_SECRET` del `.env` de la Instancia y recrea los servicios que lo leen, `backup` e `issue-automator`, con el mismo comando de la sección 3 (`sudo docker compose -p media-stack <ficheros -f> --profile extras up -d --force-recreate backup issue-automator`). issue-automator firma cada intento con el secreto vigente, así que los eventos que tuviera pendientes en su bandeja se entregan con el nuevo.
4. **Verifica con el script** y el secreto nuevo (debe responder `202`, y la incidencia de prueba debe aparecer y cerrarse):

   ```sh
   read -rs NOTIFY_INGEST_SECRET && export NOTIFY_INGEST_SECRET
   scripts/ingest-test-event.sh --url "$NOTIFY_INGEST_URL" \
     --source backup --host-id nas-home --key backup-failed --state both \
     --error "prueba de rotación"
   ```

   Comprueba el solape repitiendo el comando con un `--event-id` distinto cada vez (un identificador repetido responde `200` de duplicado): con el secreto anterior debe responder `202` mientras `NOTIFY_INGEST_SECRET_PREVIOUS` siga puesto, con el nuevo `202` y con un valor cualquiera equivocado `401`. Después, desde el NAS, `sudo docker exec backup media-backup notify-test ingest` debe salir con 0 y abrir y cerrar su incidencia de prueba en el hub.

5. **Retira el anterior.** Cuando ambos lados usan el nuevo y `curl http://localhost:5056/health` en issue-automator muestra `pending` a 0, quita `NOTIFY_INGEST_SECRET_PREVIOUS` del `.env` del hub y recrea `app`. Comprueba que el secreto anterior ya recibe `401` y que el nuevo sigue recibiendo `202`.

## 6. Qué comprobar en cada camino

| Camino                      | Comprobación                                                   | Resultado esperado                                       |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Hub a Telegram              | Aviso de prueba por el ingest                                  | Llega al chat y, al cerrar, el mensaje se edita          |
| Copia a Telegram (fallback) | `docker compose exec backup media-backup notify-test fallback` | Llega un aviso directo con prefijo fijo                  |
| Copia al ingest             | `docker compose exec backup media-backup notify-test ingest`   | `202` y una incidencia de prueba que se abre y se cierra |
| issue-automator al ingest   | Una issue de prueba en Seerr                                   | Incidencia en el hub y `pending` a 0                     |
| Secreto anterior retirado   | El script con el secreto viejo                                 | `401`                                                    |

## 7. Si algo sale mal

- **Se olvidó un `.env` del token.** Ese camino queda mudo (`401` de Telegram). Edita el `.env` que faltaba, recrea el servicio y repite la verificación de la sección 3.
- **El token nuevo se copió mal.** `getMe` responde `401`. Corrige el `.env` y recrea. Revocar otra vez genera otro token y vuelve a abrir la ventana.
- **El ingest responde `401` tras cambiar el secreto.** Un lado tiene el valor viejo: compara los dos `.env` y confirma que el servicio se **recreó** (con `restart` conserva el entorno anterior). Con `NOTIFY_INGEST_SECRET_PREVIOUS` puesto en el hub no se pierde nada mientras corriges `media-stack`. La hora desviada de un equipo (más de 5 minutos) también da `401`.
- **El ingest responde `503`.** El hub no tiene un secreto válido (falta, es de ejemplo o es demasiado corto).
- **Volver al secreto anterior.** Mientras `NOTIFY_INGEST_SECRET_PREVIOUS` esté en el hub, restaura el `.env` de `media-stack` desde la copia y recrea. El token del bot no se puede restaurar: el anterior está revocado.

## 8. Resultado del ensayo real

Esta sección se rellena tras la rotación real en producción (puerta 08-13). No contiene valores secretos, solo observaciones.

- Fecha y hora de la revocación y de la última verificación correcta:
- Duración de la ventana ciega, de revocar a recrear:
- ¿Hubo avisos fallidos por `telegram_401` en el hub? ¿Cuántos y cómo se resolvieron?
- ¿`getMe` respondió bien a la primera? ¿Qué `.env` se tocaron?
- ¿Llegó el aviso de prueba del hub? ¿Y el del fallback de la copia?
- ¿La rotación del secreto con `NOTIFY_INGEST_SECRET_PREVIOUS` funcionó sin perder eventos? ¿El secreto anterior recibe `401` tras retirarlo?
- ¿Qué paso de este runbook estaba mal, incompleto o en otro orden? Corrígelo aquí:
