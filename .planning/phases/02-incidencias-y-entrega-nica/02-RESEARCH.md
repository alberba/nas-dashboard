# Fase 2 · Incidencias y entrega única · Investigación

**Fecha:** 2026-11-24  
**Confianza:** alta en las primitivas de PostgreSQL, el código existente y la semántica de entrega. Media en el comportamiento visible de Web Push por dispositivo, pendiente de prueba física.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Envío sin confirmación

- **D-01.** Si Telegram pudo aceptar el envío inicial y el worker perdió la confirmación, registrar un resultado de entrega incierto y mostrar el motivo en el hub. Ese intento no se reenvía automáticamente y tampoco activa el push de respaldo, incluso para críticas. Una entrega incierta no equivale a un fallo definitivo.
- **D-02.** Se mantiene el push de respaldo para incidencias críticas cuando el fallo de Telegram es definitivo y está confirmado. Los rechazos 429 se reintentan según `retry_after`. Los 400, 403 y 404 se registran como fallos permanentes y visibles.

### Incidencias abiertas al migrar

- **D-03.** Conservar los avisos existentes en el hub al migrar de `alerts` a `incidents`. El backfill y el primer arranque no generan un nuevo aviso por las incidencias que ya estaban abiertas, aunque se confirme que sigan críticas. Las incidencias nuevas siguen la política de la fase 1.

### Escalada a crítica

- **D-04.** Recalcular la severidad en cada evaluación válida y reflejar la transición en el hub. Si la incidencia esperaba el resumen y todavía no se había enviado, la escalada a crítica activa su primer aviso inmediato según la política de críticas.
- **D-05.** Si ya llegó por push, actualizar la notificación existente en la bandeja con la misma etiqueta y sin volver a interrumpir. La escalada no abre un envío por Telegram. El plan debe comprobar cómo evitar que la actualización vuelva a mostrar un aviso descartado.
- **D-06.** Si ya hay mensaje en Telegram, editar ese mismo mensaje al cambiar la severidad. Cuando una incidencia se resuelve, usar el aviso original o su registro para el futuro resumen, sin emitir un nuevo mensaje de recuperación.

### Decisiones delegadas a la planificación

- Determinar cómo presentar el estado de entrega y su motivo en la vista existente de Avisos.
- Resolver el modelo de estados del outbox, los límites de reintento y el tratamiento de un lease vencido según conste si llegó a iniciarse la petición. Mantener la distinción entre rechazo confirmado y entrega incierta.
- Detallar la migración reversible y la resolución de duplicados abiertos conservando el histórico. No dar por hecho que un aviso previo tiene un identificador remoto disponible para editar.

### Ideas pendientes

La discusión no añadió ideas fuera del alcance de la fase.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Requisito | Evidencia propuesta |
|---|---|---|
| INCD-01 | Identidad estable por host y clave tras reiniciar | Renombrado y backfill de `alerts`, índice único parcial, fixture con dos hosts y varios episodios |
| INCD-02 | Una incidencia abierta no genera un segundo mensaje con estado estable | Comando transaccional y unicidad lógica del aviso inicial, probar evaluación reiterada y reinicio |
| INCD-03 | Resolver sin emitir un mensaje nuevo | Editar mensaje confirmado o conservar el cierre para el resumen, probar cierre antes y después del envío |
| INCD-04 | Recalcular severidad y reflejarla en incidencia y aviso | `disk-health` de `watch` a `fail`, con y sin entrega previa |
| INCD-05 | Envío mediante outbox transaccional | Rollback de transacción y recuperación de la fila pendiente tras reiniciar |
| INCD-06 | Envía el worker con lock y un reintento no duplica | Dos conexiones reales compiten por el advisory lock, prueba de leases e incertidumbre |
| INCD-07 | Respetar 429 y clasificar 400/403/404 | Proveedor HTTP simulado, reloj inyectado y verificación del siguiente intento |
| INCD-08 | Visibilidad de estado y motivo | Proyección autenticada por host, incluida la entrega incierta y los avisos heredados |
| BOT-01 | Entrega al chat configurado desde el bot del hub | Contrato `sendMessage` y prueba con bot/chat dedicados |
| BOT-03 | Botón al destino autenticado | Enlace de host e incidencia, conservar destino al iniciar sesión, consulta puntual |
| SEC-03 | Rechazar configuración obligatoria ausente o de ejemplo | Validación antes de `next start` y del lock del worker, pruebas de arranque aisladas |
| CONT-01 | Validar métricas, mantenimiento y despliegues | Decodificación en el cliente del agente, rechazo semántico y preservación de incidencias ante ausencia de evidencia |

</phase_requirements>

## Standard Stack

- **Persistencia.** Drizzle ORM `0.45.4`, Drizzle Kit `0.31.11`, `pg`, y PostgreSQL 18. Versiones ORM y Kit verificadas directamente en sus manifiestos instalados, también fijadas en el lockfile. Compose declara `image: postgres:18-bookworm` y el migrador usa `migrate(db, { migrationsFolder: "./drizzle" })`. [VERIFIED: compose.yaml:3-9; scripts/migrate.ts:1-8; pnpm-lock.yaml; paquetes instalados]
- **Decodificación.** Reutilizar Zod `4.6.7` y Effect `4.1.2`. `src/lib/nas.ts` ya encapsula `NasUnavailable`, `NasRejected` y `NasInvalidResponse`, pero devuelve `data as T` tras decodificar JSON. `src/lib/hosts.ts` ya usa `.safeParse` para entradas de configuración. [VERIFIED: src/lib/nas.ts:4-13,25-63; src/lib/hosts.ts:51-73; paquetes instalados]
- **Transportes.** Usar `fetch` para los dos métodos salientes de Telegram de esta fase. El adaptador existente usa `web-push`; conservar la limpieza de suscripciones ante `[404, 410].includes(error.statusCode)`. No instalar librerías nuevas. [VERIFIED: src/lib/push.ts:1-32] [CITED: https://core.telegram.org/bots/api#available-methods]
- **Aplicación.** Next.js `16.4.6`, Vitest `5.1.0` y Playwright. Consultar las guías locales del paquete antes de editar rutas o arranque, y `CODING_STANDARD.md` antes de tocar tests o copy. [VERIFIED: package.json; node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md; CODING_STANDARD.md]

## Architecture Patterns

### 1. Migración reversible y escritura atómica

- Mantener el `id` entero de cada fila, las columnas originales y el historial. La tabla actual tiene `id: integer().primaryKey().generatedAlwaysAsIdentity()`, `hostId: text().notNull().default("nas-home")`, `key: text().notNull()` y `resolvedAt: timestamp()`. Propuesta: `ALTER TABLE … RENAME TO …`, añadir columnas, completar valores antes de exigir `NOT NULL`, y mantener fingerprint y episodio separados. El fingerprint representa el par host/clave, y el ID identifica el episodio, sus eventos y su aviso. La unicidad canónica se expresa por columnas `(hostId, key)` entre filas abiertas; conservar timestamps legados y normalizar explícitamente la zona si alguna columna llega a convertirse. [VERIFIED: src/lib/schema.ts:134-151] [CITED: https://www.postgresql.org/docs/18/indexes-partial.html]
- Detectar duplicadas abiertas con `row_number()` por host/clave, ordenando por `at DESC, id DESC`. Conservar vigente la más reciente, cerrar las demás con la marca de la vigente y registrar que el cierre es sintético de migración. Guardar evidencia suficiente para invertir solo los cierres sintéticos, sin deshacer cierres reales posteriores. Backfill silencioso sin filas salientes; marcar los episodios heredados abiertos como tales y mantener su supresión durante la confirmación inicial, incluso si reaparece la misma severidad crítica. Un episodio nuevo tras un cierre válido vuelve a política normal.
- Usar el SQL ascendente versionado con su snapshot y journal. El migrador local crea `"__drizzle_migrations"` bajo `"drizzle"` y aplica migraciones pendientes dentro de `session.transaction`. Ejecutar el ensayo de rollback fuera de la carpeta de migraciones ascendentes: parada del app y del worker, copia/archivo de nuevos eventos y estados de entrega si hubo actividad real, reversión del esquema y reconciliación explícita del journal o restauración conjunta de una copia. Un retorno al código anterior requiere que la base ya haya revertido y puede reintroducir su política antigua, así que el ensayo no debe enviar a canales reales. [VERIFIED: node_modules/drizzle-orm/pg-core/dialect.js:44-71; scripts/migrate.ts:1-8; compose.yaml:17-40,51-58]
- Escribir la transición de incidencia, el evento y el trabajo necesario de outbox dentro de una única transacción. No llamar a la red dentro de esa transacción. Proteger también la clave lógica de cada primer aviso y su eventual push de respaldo, con unicidad real. Cada cambio significativo usa un `seq` creciente para impedir que una edición anterior sobrescriba una más reciente. Mantener la función del endpoint de prueba push en `/api/push/test`, trasladando el envío al outbox para que la ruta de usuario no llame al proveedor directamente. Encolar la prueba con ámbito del propietario de las suscripciones y reflejar en la interfaz si fue encolada. [VERIFIED: src/lib/collector.ts:25-67; src/app/api/[...path]/route.ts:626-659]
- El despliegue existente inicia app y worker después de completar `migrate`. Para el renombrado, detener de forma explícita las instancias antiguas antes de migrar, ya que un app o worker anterior aún vivo consulta `alerts`. Ensayar en PostgreSQL 18 desechable con filas equivalentes al esquema real. La fase 1 carece de un export de la tabla de producción; antes del despliegue, medir duplicados y volumen con lectura autorizada y usar una copia aislada si hay acceso. [VERIFIED: compose.yaml:17-40,51-58; .planning/phases/01-auditor-a-del-ruido/01-AUDIT.md §Columna de push]

#### Código de referencia · índice parcial

Propuesta verificada con el ORM instalado: `uniqueIndex(...).on(...).where(sql\`…\`)` produjo `config.unique === true` y el predicado SQL equivalente a `"incidents"."resolvedAt" is null`. Para un `ON CONFLICT` dirigido, alinear su predicado con el índice parcial o usar una escritura condicional más relectura; un índice parcial no tiene por qué corresponder a un constraint con nombre. Correr el SQL realmente generado y verificarlo en PostgreSQL. [VERIFIED: node_modules/drizzle-orm/pg-core/indexes.d.ts:62-78; prueba local con `getTableConfig` y `PgDialect.sqlToQuery`] [CITED: https://orm.drizzle.team/docs/indexes-constraints#unique-index] [CITED: https://www.postgresql.org/docs/18/sql-insert.html]

```ts
// Ejemplo del esquema propuesto, los campos reales deben coincidir con la migración.
uniqueIndex("incidents_open_host_key_idx")
  .on(t.hostId, t.key)
  .where(sql`${t.resolvedAt} is null`)
```

### 2. Observaciones válidas y política

- Seleccionar el esquema por método y pathname del agente, incluyendo `/deployments?lines=…`, y aplicarlo en el cliente del hub, tanto para el collector como para los lectores de la API del hub. Mantener tipados los rechazos HTTP aunque el JSON sea defectuoso: distinguir transporte, HTTP y esquema inválido en respuesta de éxito. No devolver un `ZodError` sin traducir a los route handlers: hoy su catch lo interpreta como entrada del usuario e informa 400. Conservar los nulos y campos opcionales reales de ambas clases de host y versiones anteriores. Ejemplos: `cpu: number | null`, `containers?: MaintenanceContainers` y `degraded: string[]`. No filtrar filas inválidas para fabricar una lista vacía que parezca sana. [VERIFIED: src/lib/nas.ts:25-63; src/app/api/[...path]/route.ts:676-708; src/lib/types.ts:96-132; src/lib/maintenance.ts:139-174; agent/server.py:452-498; agent/maintenance.py:801-858; agent/deployments.py:980-1020]
- La observación puede confirmar fallo, confirmar normalidad o no aportar evidencia. Un HTTP 200 malformado no abre `connection`, no inserta muestras y no toca episodios. Un fallo real de transporte conserva la política de desconexión y la gracia existente para un reinicio previsto. Un `degraded` legítimo solo anula la evidencia de las secciones afectadas. Un `cpu: null` válido es ausencia de medida, al igual que los estados desconocidos de sensores/SMART pertinentes. Si el agente usa una lista vacía como fallback indistinguible de una lectura válida, revisar el productor y conservar explícitamente la falta de evidencia antes de inferir salud o inventario. El `catch` general de `collectHost` hoy abre `connection` tras fallar el chequeo de forma. [VERIFIED: src/lib/collector.ts:106-176; src/lib/maintenance-alerts.ts:49-110,155-231; agent/maintenance.py:801-858; agent/deployments.py:650-682,980-1020]
- Preservar el mapa de la auditoría. En `disk-health`, el código fuente de la auditoría distingue `"critical en fail, warning en watch"` y añade `"watch se vigila en el resumen"` aunque la tabla muestre la fila familiar `immediate`. Usar `watch → fail` como recorrido principal. Las advertencias elegibles van al resumen por defecto y a Web Push únicamente con `pushWarnings=true`; una categoría silenciosa, por ejemplo `container:<name>`, sigue apareciendo en el hub sin envío. El resumen diario y el cutover de fuentes externas llegan en fases posteriores. [VERIFIED: scripts/audit/noise_audit.py:385-391; .planning/STATE.md:72; .planning/phases/01-auditor-a-del-ruido/01-AUDIT.md §Política de avisos]
- Persistir el estado del episodio abierto y sus transiciones. Conservar el debounce existente para observaciones todavía sin episodio y evitar que una observación ausente cierre un episodio ya abierto. Si una crítica se rebaja antes del envío, aplicar la política de la versión vigente antes de iniciar un envío que aún no salió. Un aviso ya entregado conserva canal y destino. Un cierre sin mensaje confirmado queda disponible para el futuro resumen y no crea un aviso de recuperación.

### 3. Outbox, entrega incierta y límite del lock

- El proceso existente llama `pg_try_advisory_lock(734921)` en un cliente dedicado, pero usa el pool general para el resto y solo desbloquea por el camino normal. Un advisory lock de sesión se pierde cuando termina esa sesión, con independencia de otras conexiones del pool. Bajo el mismo lock, verificar adquisición antes de reclamar, registrar pérdida de sesión/errores y cancelar el loop y nuevas peticiones; comprobar vigencia antes del despacho y usar un token de reclamación para que un dueño viejo no complete la fila. Mantener finitos los timeouts y liberar conexiones al arrancar con configuración inválida o al salir. Una solicitud HTTP ya enviada no se puede retirar de Telegram si la conexión de lock cae justo después. [VERIFIED: src/worker.ts:12-51; src/lib/db.ts:4-9] [CITED: https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS]
- Estados propuestos: pendiente, reclamado sin intento, intento iniciado, enviado, fallido, suprimido e incierto. Un lease caducado antes de fijar el intento permite recuperar la fila. Antes de ejecutar `fetch`, persistir la marca de intento iniciado y hacer el cambio condicional con el token de reclamación. Un lease caducado después de esa marca queda incierto en un envío inicial, incluso aunque un crash antes de ejecutar `fetch` en la estrecha ventana produzca un falso incierto. D-01 elige esta pérdida potencial de aviso confirmado frente al duplicado. Si la API confirmara éxito y falla la escritura posterior, aplicar la misma regla conservadora. El identificador de mensaje confirmado y el resultado local se guardan juntos.
- Telegram `sendMessage` devuelve `Message` con el resultado del envío. La tabla oficial documenta todo lo que se envía para ese método, sin un idempotency key de mensajería inicial. La garantía local es un único aviso lógico y ausencia de segundo envío automático si el primero pudo llegar. timeout, conexión cortada, body imposible de validar, éxito sin ID y 5xx sin constancia de rechazo son resultados iniciales inciertos. Reintentar un fallo previo al envío solo cuando conste inequívocamente que la solicitud no comenzó. No trasladar la excepción de duplicados para críticos del documento de arquitectura preliminar a la implementación. [CITED: https://core.telegram.org/bots/api#sendmessage] [VERIFIED: 02-CONTEXT.md D-01]
- Un rechazo verificable 429 conserva la fila con `nextAttemptAt` calculado desde `parameters.retry_after` en segundos. Limitar el presupuesto sin anticipar ese plazo. Proteger también la ráfaga de peticiones al mismo bot/chat mientras haya cooldown. Clasificar 400/403/404 confirmados como terminales; la transición y la creación de un solo respaldo push para críticas se hacen en la misma transacción. La UI refleja el rechazo de Telegram incluso si el push de respaldo fue aceptado por el servicio. [CITED: https://core.telegram.org/bots/api#responseparameters] [VERIFIED: 02-CONTEXT.md D-02]
- Para editar, guardar chat y `message_id` del aviso original, y ordenar o coalescer por `seq` sin editar un mensaje posterior con datos obsoletos. La edición específica es distinta de volver a llamar `sendMessage`; tras una edición incierta, solo puede reintentarse la misma edición vigente sobre el mismo ID. Si el mensaje original falta o es ineditable, registrar el motivo y actualizar el hub. Un fallo de edición no activa el push de respaldo. El cierre o downgrade que ocurre antes de iniciar un envío pendiente puede neutralizarlo sin producir recuperación. [CITED: https://core.telegram.org/bots/api#editmessagetext] [VERIFIED: 02-CONTEXT.md D-04–D-06]

### 4. Web Push tiene límites por dispositivo

- Usar una etiqueta estable **por episodio**, no solo por clave, para distinguir reapariciones reales. Una vez aceptado un push por su servicio, ese canal queda comprometido para el episodio. El `notify` previo resolvía incluso cuando faltaba VAPID o todos los endpoints fallaban. Devolver resultado explícito de aceptación, fallo confirmado, ausencia de suscripciones o incertidumbre. La aceptación del endpoint no demuestra que el operador la vio. [VERIFIED: src/lib/push.ts:6-33; public/sw.js:4-9]
- WHATWG define el reemplazo por etiqueta y `getNotifications({ tag })` sobre la misma registración. No ofrece una operación de reemplazo condicional atómico: entre consultar y reemplazar el usuario puede descartarla. En una actualización visible, usar la misma etiqueta con `silent: true` y `renotify: false`, y omitir `showNotification` cuando falta, no se puede consultar, o la revisión ya está aplicada. El hub siempre refleja el estado nuevo. [CITED: https://notifications.spec.whatwg.org/#replacing-a-notification] [CITED: https://notifications.spec.whatwg.org/#service-worker-api]
- **Límite material para D-05.** WebKit documenta que recibir un push tradicional sin presentar aviso puede revocar la suscripción. Enviar otro push de fondo y decidir no mostrarlo en el SW rompe `userVisibleOnly`; un push declarativo con un aviso de fallback tampoco garantiza no recrearlo. Mantener el envío remoto de apertura. Para cambios posteriores, recomendar refrescar el aviso de modo oportunista solo desde una sesión visible del hub al refrescar el estado de la incidencia, con comprobación local de la etiqueta. Sin navegador activo, API disponible o aviso todavía visible, conservar la escalada en el hub hasta el siguiente refresco local aplicable. El comportamiento físico con iOS y el intervalo entre comprobación y reemplazo deben figurar en la validación; no prometer reemplazo en segundo plano sin interrupción en todos los dispositivos. [CITED: https://webkit.org/blog/16535/meet-declarative-web-push/#challenge-1-silent-push-protection]

### 5. Arranque y navegación autenticada

- Reusar el parser de `NAS_HOSTS` y su pareja heredada `NAS_AGENT_URL`/`AGENT_TOKEN`; rechazar explícitamente los valores de ejemplos vigentes, incluido el password de `DATABASE_URL`, los secretos de auth/setup y los tokens de agentes. Revisar además URL/orígenes y coherencia de grupos opcionales; para Telegram validar token y chat como pareja cuando se habilita el canal, con modo explícito/definido para entornos que lo omiten y muestran esa supresión. Separar validación de forma de pruebas de conectividad externa. Emitir diagnósticos con nombres de variables, nunca URLs que incluyan credenciales, valores de secretos, cuerpos de Telegram ni errores crudos de `fetch` que puedan arrastrar su URL. El contenedor debe rechazar su configuración antes del arranque real, sin bloquear el `next build` que usa `BETTER_AUTH_SECRET=build-placeholder-never-used-at-runtime-32`. Una comprobación de arranque explícita en el entrypoint de servicio y en `main` del worker separa build y runtime. La sonda existente del app consulta `/api/setup`. El requisito de detección de un worker posteriormente bloqueado pertenece a CONT-03. [VERIFIED: .env.example:1-24; Dockerfile:7-19; compose.yaml:28-58; src/lib/hosts.ts:21-41,76-113; src/lib/auth.ts:9-38; src/app/api/[...path]/route.ts:115-135]
- Botón standard `InlineKeyboardButton.url` a una URL absoluta construida a partir del origen canónico confiable del hub, con ID de episodio y host validados. El enlace no lleva tokens ni otorga sesión. La pantalla raíz ya usa `auth.api.getSession`, pero `Login` hace `router.replace("/")` tanto para correo como passkey, cortando el destino. Preservar únicamente la ruta interna conocida al iniciar sesión y al expirar sesión. `overview` obtiene `limit(100)` por host, de modo que el destino autenticado debe incluir una consulta por host e ID aunque el episodio sea anterior al límite, con 404 cuando falte o el host no coincida. Añadir el resultado saliente y su razón al modelo de lectura actual sin exponer detalles del transporte o de otros hosts. [VERIFIED: src/app/page.tsx:8-14; src/components/login.tsx:35-56; src/components/views/routes.ts:23-47; src/components/dashboard.tsx:130-153; src/app/api/[...path]/route.ts:155-156,277-288] [CITED: https://core.telegram.org/bots/api#inlinekeyboardbutton]

## Don't Hand-Roll

- Usar constraints, transacciones y el lock existente de PostgreSQL. Evitar deduplicar en memoria el trabajo durable o generar una ventana de consistencia entre el episodio y el outbox.
- Reusar Zod, el límite de tiempo del cliente del agente, las lecturas autenticadas y los helpers de navegación. Evitar un SDK de Telegram, un nuevo servidor, callbacks en esta fase o reintentos ocultos de `sendMessage`.
- Entregar Web Push mediante el adaptador existente con resultados explícitos. Mantener el store propio de incidencias como fuente de verdad del estado; la bandeja del dispositivo es solo una proyección.

## Common Pitfalls

| Riesgo | Decisión para el plan |
|---|---|
| El test de migración anterior toma el último SQL y asume que es el de multi-host | Anclar el test previo a `0003_multi_host.sql` y añadir el ensayo de fase 2 con migrador, journal, datos legados, duplicados, reversa y avance de nuevo. `tests/migrations.test.ts` usa `migrations.at(-1)!` y `migrations.slice(0, -1)`. [VERIFIED: tests/migrations.test.ts:29-48] |
| Un parser convierte `retained` faltante en `[]`, restaura un disco con estado desconocido o convierte `cpu: null` en normalidad | Probar contrato y evolución del estado en la misma ruta de código que usa el collector y distinguir `degraded` de una observación sana. [VERIFIED: src/lib/maintenance-alerts.ts:77-103,168-181; src/lib/collector.ts:168-176] |
| Drenar fuera del lease o perder la sesión de lock sin detener el proceso | Renovación/timeout acotados, pérdida de sesión comprobable y guardas por token de reclamación. No reutilizar ciegamente el intento inicial vencido. |
| Un cierre o edición pisa el estado inicial en el hub | Proyectar el resultado inicial por canal y el último resultado de edición por separado. Mantener los motivos del rechazo, fallback o incertidumbre visibles. |
| Un chat cambió de configuración y la edición apunta al chat nuevo | Persistir el chat que confirmó el mensaje; no reinterpretarlo. En un 429 persistir plazo y respetar el límite incluso tras reinicio. |
| Registro o respuesta filtra token, credenciales o contenido de agentes | Emplear motivos finitos y anonimizar fallos de transporte. Texto plano acotado para Telegram, origen de enlace establecido por configuración validada y sin destinos abiertos. |
| Limpieza de 30 días borra un incidente que aún tiene trabajo o rompe un enlace | Mantener los límites existentes de lectura y el vínculo para todo episodio conservado, definir la coherencia entre limpieza y dependencias nuevas. El worker ya borra avisos con `lt(alerts.at, cutoff)` y `lt(alerts.resolvedAt, cutoff)`. [VERIFIED: src/worker.ts:32-40] |

## Validation Architecture

### Framework y entorno

Vitest añade `tests/**/*.test.ts`; CI ofrece `postgres:18`, aplica `pnpm db:migrate`, y después compila y ejecuta Playwright en Chromium. `tests/database.ts` solo admite URLs de loopback y crea una base desechable por test suite. Reutilizar sus fixtures y la idea del agente HTTP local de `tests/collector-alerts.test.ts`. No tomar el salto de tests sin DB como éxito de migración. En la estación de investigación se verificó el predicado con la copia instalada del ORM. No se ejecutó la migración propuesta: todavía no existe, `DATABASE_URL` no está configurada y el socket local de Docker respondió con permiso denegado. [VERIFIED: vitest.config.ts:3-8; .github/workflows/ci.yml:7-47; tests/database.ts:4-40; tests/collector-alerts.test.ts:35-83; prueba local de entorno]

| Cobertura | Comando focalizado propuesto | Comprobación |
|---|---|---|
| INCD-01, 02, 05 y D-03 | `pnpm test tests/migrations.test.ts tests/incident-store.test.ts` | PostgreSQL 18 desechable. Fixtures con duplicados abiertos empatados por fecha, una resolución previa y misma clave en dos hosts. IDs y filas preservados, canonicidad, siguiente ID, no avisos del backfill, rollback sin residuo, segundo avance y atomicidad al fallar entre transición y outbox. |
| INCD-03, 04 y CONT-01 | `pnpm test tests/agent-client.test.ts tests/collector-alerts.test.ts tests/maintenance-alerts.test.ts` | Recepción válida, tipo numérico/string incorrecto, snapshots `degraded`, pasos de severidad y ausencia de mutación ante error de forma; validación de no-abrir, no-resolver y no-escribir muestras. |
| INCD-02, 03, 05–08 y BOT-01 | `pnpm test tests/notification-dispatch.test.ts tests/telegram.test.ts` | Proveedor falso y reloj inyectado. Reclamación sin envío, proceso que cae entre el inicio y la confirmación, pérdida de lease/lock con dos clientes PostgreSQL, reintento de rechazo 429, 400/403/404, fallback único tras rechazo de crítica, cero peticiones tras incertidumbre, edición ordenada sobre ID original. |
| INCD-04 y D-05 | `pnpm test tests/incident-push.test.ts` | Si hubo push previo, cero Telegram. Con la misma etiqueta visible, reemplazar sin renotify; con etiqueta ausente o API ausente, no llamar a `showNotification`. Verificación física separada con aviso presente y descartado. |
| INCD-08 y BOT-03 | `pnpm test tests/api-incidents.test.ts` y `pnpm exec playwright test tests/e2e/incidents.spec.ts` | 401 sin sesión, host incorrecto, episodio anterior a los 100 recientes, URL tras login, estado de entrega visible por estado/estructura. |
| SEC-03 | `pnpm test tests/runtime-config.test.ts` | Entorno completo, ausente y placeholders por cada grupo, incluidas credenciales embebidas en URL. Agregar arranque aislado del app y el worker para demostrar salida no sana y que el build sigue compilando. |

**Wave 0:** ampliar los tests existentes de migración, cliente y collector, crear solo los targets nuevos que cubran interfaces sin equivalente, y configurar una base local/CI del mismo major sin servicios reales. Los nombres nuevos de la tabla son propuestas y pasan a existir en el plan que los use. Para el falso Telegram, inyectar `fetch` o un transporte, sin permitir una URL arbitraria del proveedor desde producción. Para el runner, ejecutar `pnpm typecheck`, `pnpm lint`, las suites focalizadas, `pnpm test:agent` si cambia el agente, y Playwright después de compilar. Aserciones por estado, estructura o efecto observable según `CODING_STANDARD.md`.

**Manual:** prueba con bot/chat de prueba y sesión válida/ausente desde el enlace en Telegram, incluida conectividad Tailscale. Comprobar comportamiento de la bandeja en la PWA real del operador con aviso presente y descartado; el Chromium de CI valida la lógica pero no la bandeja de iOS. Antes de migrar en producción, ejecutar el conteo de preflight y el ensayo de restauración previsto en el plan.
