# hub.

Dashboard personal para supervisar y administrar un NAS desde otro servidor. Interfaz en español, adaptable a móvil, con aplicación web instalable.

## Funciones

- CPU, memoria, red, actividad de discos, temperaturas, capacidad y contenedores con datos reales.
- Varios hosts con estado de conexión independiente: el NAS y el Servidor de apps. Mantenimiento cambia de host sin perder el resto del panel.
- Recogida cada 5 segundos con alguna pestaña visible y cada 30 segundos en segundo plano; historial de 30 días.
- Cuenta personal con Better Auth: correo/contraseña y passkeys. Registro público cerrado después del alta inicial.
- Inicio, parada y reinicio de contenedores; reinicio del NAS con confirmación explícita.
- Explorador limitado a dos carpetas: renombrar, mover, enviar a papelera, restaurar y vaciar. Caducidad de 7 días.
- Avisos internos y Web Push al móvil, con notificación de recuperación y umbrales editables.
- Accesos a servicios y registro de las acciones realizadas.

## Stack

TypeScript 7, React 19, Next.js 16 App Router, Effect 4, PostgreSQL 18, Drizzle, Zod, Tailwind CSS 4, Better Auth, Vitest y Playwright. El agente del NAS usa Python 3.14 y la API de Docker. Las fuentes Manrope y Unbounded se sirven desde la propia aplicación.

Effect gestiona los errores tipados, la cancelación y los tiempos de espera de la comunicación con el NAS. Las acciones de administración no se reintentan automáticamente.

## Arquitectura

```mermaid
flowchart LR
  Browser[Navegador / PWA] --> Proxy[Nginx Proxy Manager en NAS]
  Proxy --> App[Next.js en servidor remoto]
  Private[Entrada HTTPS privada] --> App
  App --> DB[(PostgreSQL)]
  Worker[Recolector] --> DB
  Worker --> Agent[Agente privado en NAS]
  Worker --> AppsAgent[Agente privado en Servidor de apps]
  App --> Agent
  App --> AppsAgent
  Agent --> Docker[Docker / recursos / carpetas permitidas]
  AppsAgent --> AppsDocker[Docker / recursos del Servidor de apps]
  Worker --> Push[Web Push]
```

Conecta ambos servidores mediante una red privada, por ejemplo Tailscale. El agente valida un token y una lista explícita de IP de origen. No publiques su puerto en Internet. El navegador solo se comunica con Next.js.

El hub lee la lista de agentes de `NAS_HOSTS`: identificador, nombre, rol (`instance` o `apps-server`), URL y token. Cada host tiene su propio historial, avisos, operaciones y umbrales. Las instalaciones de un solo agente siguen funcionando con `NAS_AGENT_URL` y `AGENT_TOKEN`; en ese caso el host se llama `nas-home`. Conserva ese identificador en el NAS para que la migración encuentre el historial existente.

## Configuración y despliegue

Requiere Docker y Compose en ambos servidores. El agente del NAS necesita Linux, acceso al socket de Docker y montajes de las dos carpetas autorizadas; el del Servidor de apps solo necesita el socket y los recursos del sistema. Estos permisos permiten administrar los servidores: conserva los tokens exclusivamente en ellos.

```sh
pnpm install --frozen-lockfile
node scripts/configure.mjs \
  --url https://hub.example.com \
  --nas NAS_TAILSCALE_IP \
  --bind APP_SERVER_TAILSCALE_IP \
  --media /path/to/media \
  --torrents /path/to/torrents \
  --apps-url http://hub-agent-apps:9450
```

Se generan `.env`, `agent/.env` y `agent/.env.apps` con permisos 0600. No los subas a Git. Omite `--apps-url` para un único host. Puedes configurar un PostgreSQL externo cambiando `DATABASE_URL` y adaptando la dependencia del servicio `db` en Compose.

En el NAS, copia `agent/` y su `.env` y ejecuta:

```sh
cd agent
docker compose up -d --build
```

En el servidor de la aplicación, copia el proyecto y el `.env` de la aplicación:

```sh
docker compose up -d --build
```

El agente del Servidor de apps comparte máquina con el hub. Usa su propio `.env.apps`, se une a la red privada `nas-dashboard_default` y no publica puertos. No monta las carpetas multimedia, no permite reiniciar la máquina y protege los contenedores del hub:

```sh
cd agent
docker compose --env-file .env.apps -f compose.apps.yaml up -d --build
```

La instantánea de Mantenimiento monta en solo lectura el checkout y el estado de media-stack. Configura `MEDIA_STACK_CHECKOUT_PATH` y `MEDIA_STACK_APPDATA_PATH` en el NAS; en el Servidor de apps usa `--apps-stack-path` y `--apps-appdata-path` al generar la configuración. La imagen del agente incluye `smartctl` y lee los discos del host a través del contenedor auxiliar, sin instalar nada en el NAS ni ejecutar acciones sobre los discos. El contrato completo está en `agent/MAINTENANCE.md`.

El agente del NAS también escribe los ajustes que faltan de una release retenida. Para hacerlo sin montar el checkout con escritura, el `.env` real vive en un directorio dedicado (`MEDIA_STACK_ENV_PATH`, `/volume2/media-stack-env` por defecto) y el checkout lo enlaza:

```sh
sudo install -d -m 0700 /volume2/media-stack-env
sudo mv /volume2/media-stack/.env /volume2/media-stack-env/.env
sudo ln -s /volume2/media-stack-env/.env /volume2/media-stack/.env
```

El agente monta solo ese directorio con `:rw`, donde crea la copia previa y reemplaza el `.env` con `rename` atómico. El Servidor de apps no monta este directorio y rechaza la escritura.

Compose aplica las migraciones antes de iniciar la aplicación y el recolector. PostgreSQL utiliza un volumen persistente y no publica su puerto. La aplicación escucha en la IP configurada, puerto 4323, y en `127.0.0.1:4324` para una entrada HTTPS privada alternativa. Mantén una sola réplica web y un solo recolector; un bloqueo de PostgreSQL impide recolectores simultáneos. La migración de varios hosts asigna las muestras, avisos, operaciones y ajustes existentes al host `nas-home`.

Configura Nginx Proxy Manager para dirigir el dominio HTTPS a `APP_SERVER_TAILSCALE_IP:4323`. Conserva la ruta anterior para poder revertir el cambio. Cambiar la ruta no requiere borrar el hub anterior.

Para el alta inicial, abre el dominio con `/#setup=VALOR_DE_SETUP_TOKEN`. El navegador retira el fragmento al cargarlo y el token deja de permitir altas tras crear la primera cuenta. Introduce tu correo y contraseña en la interfaz; después añade las passkeys desde Ajustes.

## Entrada privada alternativa

Puedes publicar `127.0.0.1:4324` mediante Tailscale Serve. Añade la URL HTTPS resultante a `TRUSTED_ORIGINS`, separada por una coma, y recrea la aplicación. Better Auth admite los dominios exactos configurados. Las passkeys pertenecen al dominio principal; en el dominio alternativo utiliza correo y contraseña.

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4324
```

Si el NAS está caído, la entrada privada permite consultar el historial en el servidor remoto. Los datos muestran su antigüedad y los controles se desactivan. El NAS puede tardar hasta 75 segundos en aparecer desconectado.

## Móvil y notificaciones

Añade hub. a la pantalla de inicio. En Ajustes, activa los avisos y envía una prueba. El permiso debe concederse en cada dispositivo. En iPhone se requiere una aplicación añadida a la pantalla de inicio; en Android depende del navegador y sus permisos.

Las claves VAPID se generan con la configuración inicial. La PWA no almacena páginas autenticadas ni respuestas de la API en caché.

## Archivos y operaciones

La papelera se guarda dentro de cada raíz autorizada, en `.hub-trash`, para evitar transferir archivos entre servidores. Su contenido sigue ocupando espacio. El agente elimina los elementos caducados cada hora y al arrancar. Nunca sobrescribe un destino al mover o restaurar, y bloquea rutas absolutas, escapes con `..` y enlaces simbólicos. El agente del Servidor de apps se configura con `FILES_ENABLED=false`: Mantenimiento muestra sus contenedores y recursos, pero Archivos sigue usando el NAS.

Los movimientos se realizan dentro de la raíz seleccionada. No se permiten transferencias entre las dos raíces, subidas ni comandos arbitrarios. NPM, Tailscale y los agentes están protegidos frente a paradas desde la interfaz. Añade nombres de contenedores a `PROTECTED_CONTAINERS` si quieres bloquear otros servicios.

Si se pierde una respuesta durante una operación, queda pendiente de verificar. Comprueba el estado antes de repetirla. El reinicio del NAS utiliza un contenedor auxiliar privilegiado con un comando fijo; no se expone una consola remota.

## PR de Renovate

El hub puede leer las PR abiertas de Renovate en `alberba/media-stack` sin modificar GitHub. El servidor guarda un token *fine-grained* limitado a ese repositorio con permisos de lectura de *Pull requests*, *Contents* y *Checks*; el token nunca llega al navegador ni a los agentes. Configúralo en el `.env` del servidor:

```sh
GITHUB_TOKEN=github_pat_...
GITHUB_REPOSITORY=alberba/media-stack
```

Si falta `GITHUB_TOKEN`, la sección de Renovate se desactiva sin llamar a GitHub y sin mostrar errores. Solo se listan PR de autor Renovate en ramas `renovate/*` que cambian imágenes de Compose. Cada actualización se relaciona con los contenedores por las etiquetas `com.docker.compose.project` y `com.docker.compose.service` que envía el agente, no por la cadena de la imagen: los pins de seguridad, las versiones retenidas, las imágenes locales y las imágenes sin etiqueta siguen apuntando a su servicio. Las PR agrupadas de Tdarr incluyen el nodo del Worker y se marcan como «requiere Worker». Esta fase es de solo lectura: no fusiona PR ni modifica GitHub.

## Desarrollo y pruebas

Crea `.env.local` con un PostgreSQL local y las variables del ejemplo. Usa `BETTER_AUTH_URL=http://localhost:3000` y el mismo valor en `TRUSTED_ORIGINS`. Puedes configurar `NAS_HOSTS` con uno o varios agentes, o mantener `NAS_AGENT_URL` y `AGENT_TOKEN` para un único NAS.

```sh
pnpm db:migrate
pnpm dev
# En otro terminal:
pnpm worker

pnpm typecheck
pnpm lint
pnpm test
pnpm test:agent
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Playwright usa una base de datos de desarrollo/pruebas, crea una cuenta de prueba cuando está vacía y comprueba acceso, registro cerrado, origen de peticiones, navegación, móvil y passkeys con un autenticador virtual. No apuntes estas pruebas a producción. Los tests del agente utilizan archivos temporales; las operaciones `renameat2` requieren Linux.

TypeScript 7 compila la aplicación. ESLint todavía requiere la API JavaScript de TypeScript 6, instalada mediante el alias `typescript-api` y cargada solo en el proceso de lint. Se puede retirar ese adaptador cuando typescript-eslint admita TypeScript 7.

Dependabot revisa paquetes, Docker y GitHub Actions semanalmente. CI ejecuta tipos, lint, tests, migraciones, build y Playwright.

## Copias y recuperación

Haz copias del PostgreSQL, del `.env` de ambos servidores y de las carpetas del NAS. La papelera no sustituye a una copia de seguridad. Para recuperar el acceso si pierdes contraseña y passkeys, accede por SSH al servidor y usa el comando administrativo documentado en `scripts/reset-password.ts`; las sesiones existentes se revocan.
