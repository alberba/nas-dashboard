# Rotación del token del bot y del secreto del ingest

Runbook para rotar de forma conjunta el token del bot de Telegram y el secreto HMAC del ingest (`NOTIFY_INGEST_SECRET`). Ningún ejemplo contiene valores reales: los secretos se leen con `read -rs` o se editan en los `.env`, nunca van como argumento de un comando ni quedan en el historial del shell.

## 1. Alcance y por qué es de un solo sentido

Hay dos rotaciones independientes:

- **Token del bot (D-16).** Lo usan el hub (envía todos los avisos) y la copia de `media-stack` (aviso directo de `backup-failed` cuando el hub no confirma). Revocar el token en BotFather lo invalida para siempre y **no hay solapamiento**: el token anterior deja de funcionar en el acto. Si se olvida un `.env`, ese camino queda mudo hasta que se corrija.
- **Secreto HMAC del ingest (D-17).** Lo comparten el hub y `media-stack` (copia e issue-automator). Aquí sí hay solapamiento: el hub acepta el secreto actual y el anterior (`NOTIFY_INGEST_SECRET_PREVIOUS`), de modo que no se pierde ningún evento mientras ambos lados cambian.

Haz primero la del secreto (sin riesgo) y después la del token, o al revés, pero nunca las dos a la vez: así un fallo se atribuye a una sola causa.

## 2. Antes de empezar

- Localiza **todos** los `.env` que tienen el token: el del hub (en `webs`, `/opt/nas-dashboard`), el de la Instancia de `media-stack` (en el NAS, que alimenta la copia) y el del Servidor de apps solo si aún conserva `TELEGRAM_BOT_TOKEN`. El secreto del ingest está en el del hub y en el de la Instancia.
- Guarda una copia de cada `.env` antes de tocarlo, con permisos 0600, para poder volver si algo sale mal.
- Ten a mano el comando para ver el estado: `docker compose ps` en el hub y en la Instancia.
- Ten `scripts/ingest-test-event.sh` disponible (necesita `curl`, `openssl` y `jq`).

## 3. Rotación del token del bot

El orden importa porque no hay solapamiento: minimiza el tiempo entre revocar y recrear.

1. **Obtén el token nuevo.** En BotFather, `/revoke` sobre el bot genera el token nuevo y anula el anterior en ese momento. Cópialo en un gestor de contraseñas, no en un chat. A partir de aquí empieza la ventana ciega (sección 4).
2. **Actualiza los `.env`.** Edita `TELEGRAM_BOT_TOKEN` en el `.env` del hub y en el de `media-stack` (Instancia, y el del Servidor de apps si lo conserva). Hazlo con el editor, no con `echo` ni `sed` con el valor en la línea de comandos. `TELEGRAM_CHAT_ID` no cambia.
3. **Recrea los servicios afectados.** `restart` no relee el `.env`; hace falta recrear:

   ```sh
   # Hub (carpeta del proyecto en webs)
   docker compose up -d --force-recreate app worker

   # media-stack: la copia (carpeta del stack de la copia en el NAS)
   docker compose up -d --force-recreate backup
   ```

   Recrea también cualquier otro servicio que siga declarando el token.

4. **Verifica el token con `getMe`.** La URL contiene el token, así que se pasa por entrada estándar a `curl -K -` en lugar de por argumento:

   ```sh
   read -rs TELEGRAM_BOT_TOKEN
   printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$TELEGRAM_BOT_TOKEN" | curl -sS -K -
   unset TELEGRAM_BOT_TOKEN
   ```

   Debe responder `"ok":true` con el nombre del bot. Un `401` significa que copiaste mal el token.

5. **Aviso de prueba por cada camino.**
   - Hub a Telegram: genera un aviso de prueba por el ingest y comprueba que llega al chat (`scripts/ingest-test-event.sh`, véase la sección 5, paso 4).
   - Fallback de la copia a Telegram: `docker compose exec backup media-backup notify-test fallback`, desde la carpeta del stack de la copia. Debe llegar un aviso directo de prueba con el prefijo fijo.

## 4. La ventana ciega

Entre revocar el token (paso 1) y recrear los servicios (paso 3) los dos caminos están mudos:

- El hub recibe `401` de Telegram y registra el motivo `telegram_401`. Los avisos pendientes se reintentan con espera creciente; si se agotan los intentos antes de recrear, el aviso queda como fallido.
- La copia no puede hacer el aviso directo.

Después de la verificación, revisa lo que pasó durante la ventana: incidencias abiertas cuyo aviso quedó fallido (motivo `telegram_401`) y el estado del resumen diario si cayó en la ventana. Reenvía o cierra a mano lo que haga falta. Si ocurrió un fallo de copia real durante la ventana, el evento llegó al ingest (el ingest no usa el token), así que la incidencia existe aunque el mensaje no saliera.

Para acortar la ventana, deja los `.env` editados abiertos antes de revocar y ejecuta el recreado nada más guardar.

## 5. Rotación del secreto HMAC del ingest

Sin ventana ciega: el hub acepta ambos secretos durante la transición.

1. **Genera el secreto nuevo** (al menos 32 caracteres; el arranque rechaza el valor de ejemplo):

   ```sh
   openssl rand -hex 32
   ```

   Guárdalo en el gestor de contraseñas y escríbelo directamente en los `.env`.

2. **Hub: nuevo y anterior.** En el `.env` del hub pon el valor nuevo en `NOTIFY_INGEST_SECRET` y el valor que había hasta ahora en `NOTIFY_INGEST_SECRET_PREVIOUS`. Recrea el hub: `docker compose up -d --force-recreate app worker`. El hub arranca con ambos y verifica cada firma contra los dos.
3. **`media-stack`.** Pon el secreto nuevo en `NOTIFY_INGEST_SECRET` del `.env` de la Instancia y recrea los servicios que lo leen (`docker compose up -d --force-recreate` en la copia y en issue-automator). issue-automator firma cada intento con el secreto vigente, así que los eventos que tuviera pendientes en su bandeja se entregan con el nuevo.
4. **Verifica con el script** y el secreto nuevo (debe responder `202`, y la incidencia de prueba debe aparecer y cerrarse):

   ```sh
   read -rs NOTIFY_INGEST_SECRET && export NOTIFY_INGEST_SECRET
   scripts/ingest-test-event.sh --url "$NOTIFY_INGEST_URL" \
     --source backup --host-id nas-home --key backup-failed --state both \
     --error "prueba de rotación"
   ```

   Repite con el secreto anterior: mientras `NOTIFY_INGEST_SECRET_PREVIOUS` siga puesto debe seguir respondiendo `202`.

5. **Retira el anterior.** Cuando ambos lados usan el nuevo y `curl http://localhost:5056/health` en issue-automator muestra `pending` a 0, quita `NOTIFY_INGEST_SECRET_PREVIOUS` del `.env` del hub y recrea `app worker`. Comprueba que el secreto anterior ya recibe `401` y que el nuevo sigue recibiendo `202`.

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

Esta sección se rellena tras la rotación real en producción (puerta 08-11). No contiene valores secretos, solo observaciones.

- Fecha y hora de la revocación y de la última verificación correcta:
- Duración de la ventana ciega, de revocar a recrear:
- ¿Hubo avisos fallidos por `telegram_401` en el hub? ¿Cuántos y cómo se resolvieron?
- ¿`getMe` respondió bien a la primera? ¿Qué `.env` se tocaron?
- ¿Llegó el aviso de prueba del hub? ¿Y el del fallback de la copia?
- ¿La rotación del secreto con `NOTIFY_INGEST_SECRET_PREVIOUS` funcionó sin perder eventos? ¿El secreto anterior recibe `401` tras retirarlo?
- ¿Qué paso de este runbook estaba mal, incompleto o en otro orden? Corrígelo aquí:
