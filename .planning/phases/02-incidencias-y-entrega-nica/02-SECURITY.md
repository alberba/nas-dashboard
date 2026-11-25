---
phase: "02"
slug: "incidencias-y-entrega-nica"
status: verified
threats_open: 0
threats_total: 11
threats_closed: 11
asvs_level: 1
created: "2026-11-25"
---

# Seguridad de la fase 02

> Contrato de seguridad de la fase 02: registro de amenazas de los cinco planes,
> evidencia de mitigación a nivel ASVS 1, riesgos aceptados y registro de revisión.
> El registro se redactó en tiempo de planificación (`register_authored_at_plan_time: true`):
> los cinco `PLAN.md` contienen un bloque `<threat_model>` parseable.

## Límites de confianza

| Límite | Descripción | Datos que cruzan |
|---|---|---|
| Collector y lifecycle → PostgreSQL | Observaciones, cierres confirmados y límites de episodio pasan a estado y trabajo durable. | Estado de incidencias, timeline, outbox y decisiones de entrega. |
| Migrador → base operativa | El avance y la reversa cambian el esquema y el journal. | Esquema `public`, tablas nuevas y `drizzle.__drizzle_migrations`. |
| Agente Python → cliente Effect | Respuestas de red alimentan las muestras, las vistas y el estado de incidencias. | Snapshots `/metrics`, `/maintenance` y `/deployments` (solo lectura). |
| Archivos dotenv y entorno → app y worker | Las fuentes de configuración incluyen credenciales y orígenes de confianza. | Secretos de auth, URL canónica, tokens de host, Telegram y VAPID. |
| Worker → Telegram / Web Push | Una solicitud sale de PostgreSQL y puede perder su confirmación. | Texto del aviso, chat y `message_id`, payload push acotado. |
| Outbox → suscripciones | El worker restringe una prueba push a las suscripciones de su propietario. | `ownerUserId` y endpoints push del usuario autenticado. |
| Enlace y navegador → hub autenticado | Host e ID pasan de la URL a la lectura por sesión. | Ruta interna `/?view=alerts&host=…&incident=…`, sin tokens. |
| Usuario autenticado → prueba push | La ruta crea trabajo dirigido únicamente a las suscripciones de esa cuenta. | Trabajo `push-test` con el propietario derivado de la sesión. |

## Método y profundidad ASVS

La configuración activa es `workflow.security_asvs_level: 1` y
`workflow.security_block_on: high`. La verificación se hizo a profundidad ASVS 1
(presencia de la mitigación en el archivo citado y en las pruebas que la
ejercitan), no a nivel L2/L3 de colocación de límites ni de traza extremo a
extremo.

- Se leyeron los cinco `PLAN.md` y sus `SUMMARY.md`. Ningún `SUMMARY.md` contiene
  una sección `## Threat Flags`; las notas `## Threat Model Evidence` de 02-03,
  02-04 y 02-05 se incorporaron a este registro. No hay superficie nueva sin
  mapear.
- Las 11 amenazas tienen disposición `mitigate`; no hay disposiciones `accept`
  ni `transfer`.
- No quedó ninguna amenaza abierta, así que no se aplica la compuerta de usuario
  del paso 4 ni la selección de aceptar riesgos. Con `threats_open: 0`,
  registro creado en planificación y ASVS 1, el workflow permite cerrar en el
  paso 6 sin auditor adicional; aun así, esta revisión comprobó cada mitigación
  contra código y pruebas en lugar de firmar solo por ausencia de hallazgos.

## Registro de amenazas

| Threat ID | Categoría | Componente | Severidad | Disposición | Mitigación verificada | Estado |
|---|---|---|---|---|---|---|
| T-02-01 | Tampering | Backfill y reversa | high | mitigate | Identidad y cierres originales conservados; deduplicación marcada y reversible; reversa transaccional con verificación del journal y copia restaurable documentada; ensayo completo con datos sintéticos. | Cerrada |
| T-02-02 | Tampering | Transición y encolado | high | mitigate | Consultas parametrizadas, índice parcial de episodio abierto, clave lógica única de trabajo, transacción compartida y pruebas de concurrencia y fallo parcial. | Cerrada |
| T-02-03 | Information Disclosure | Ensayo de migración | high | mitigate | Conexión de pruebas solo loopback con fallo duro, fixtures sintéticos, preflight operativo de solo lectura y copias bajo procedimiento del operador. | Cerrada |
| T-02-04 | Tampering | Decodificación de snapshots | high | mitigate | Esquemas Zod por destino antes del límite Effect/Promise, sin coerción a salud y con distinción entre observación válida, degradada y fallo de contrato. | Cerrada |
| T-02-05 | Information Disclosure | Validación del entorno | high | mitigate | Diagnósticos por nombre de variable y motivo finito, sin valores; pruebas sobre stdout/stderr con secretos sintéticos. | Cerrada |
| T-02-06 | Spoofing | Arranque y origen canónico | high | mitigate | Rechazo de valores de ejemplo y grupos incompletos antes del arranque, HTTPS con excepción loopback y precedencia real de las fuentes de entorno. | Cerrada |
| T-02-07 | Tampering | Lease y resultado | high | mitigate | Lock de sesión, reclamación con token y lease, marca durable antes de la red y escrituras condicionadas por el token vigente; prueba con dos clientes. | Cerrada |
| T-02-08 | Information Disclosure | Cliente Telegram y Web Push | high | mitigate | Origen Telegram fijo sin redirects, secretos solo en entorno, errores clasificables sin cuerpos, URL de hub canónica, texto y payload acotados. | Cerrada |
| T-02-09 | Elevation of Privilege | Deep link y prueba push | high | mitigate | Sesión obligatoria, consulta por pareja host e ID sin fallback, destino reconstruido con helpers internos y propietario del trabajo derivado de la sesión. | Cerrada |
| T-02-10 | Denial of Service | Reintentos y revisión de mensajes | medium | mitigate | Timeout menor que el lease, cooldown durable por bot/chat, presupuesto finito de intentos y edición agrupada por `seq`; pruebas con reloj. | Cerrada |
| T-02-11 | Information Disclosure | Modelo público de Avisos | high | mitigate | Proyección de estados y motivos finitos, sin tokens, destinos del proveedor, cuerpos crudos ni errores del transporte. | Cerrada |

*Severidad: critical > high > medium > low. Solo las amenazas abiertas con
severidad igual o superior a `high` cuentan para `threats_open`.*

## Evidencia de mitigación (ASVS L1)

### 02-01 · Migración, backfill y outbox (T-02-01, T-02-02, T-02-03)

- **T-02-01 — identidad, cierres y reversa.** `drizzle/0004_incidents.sql:7-8`
  renombra la tabla y la secuencia en lugar de recrearlas; `:33-47` cierra solo
  duplicados abiertos con `closedBy = 'migration-dedup'` y conserva el
  `resolvedAt` original en `previousResolvedAt`; `:49-55` impone el fingerprint y
  el índice parcial. `scripts/rollback/0004_incidents.sql:19` abre una
  transacción, `:21-46` aborta si 0004 no es el último avance o si falta su
  entrada en `drizzle.__drizzle_migrations`, y `:51-58` restaura únicamente los
  cierres sintéticos. `scripts/migrate.ts:4` usa el migrador de Drizzle, que
  ejecuta el avance dentro de una transacción
  (`node_modules/drizzle-orm/pg-core/dialect.js:60`). La copia restaurable y el preflight están
  documentados en `README.md:111-136`. Pruebas:
  `tests/migrations.test.ts#keeps history, closes duplicates and leaves the legacy backfill silent`,
  `#rehearses 0003 → 0004 → rollback → 0004 without repeating or losing ids` y
  `#refuses a journal where 0004 is not the last applied advance`.
- **T-02-02 — transición y encolado atómicos.** `src/lib/incident-store.ts:261`
  abre la transacción que abarca episodio, evento y outbox; `:273` bloquea la
  fila abierta con `FOR UPDATE`; `:348-362` usa `onConflictDoNothing` sobre el
  índice parcial; `:385-410` inserta evento y trabajo en la misma transacción.
  El índice parcial está en `src/lib/schema.ts:166-168` y
  `drizzle/0004_incidents.sql:55`; la clave única del trabajo en
  `src/lib/schema.ts:240` y `drizzle/0004_incidents.sql:95`. Las consultas son
  parametrizadas por Drizzle o con marcadores `$n`, como en
  `src/lib/notification-dispatch.ts:199-219`. Pruebas:
  `tests/incident-store.test.ts#confirms a single opening when several observations race`
  y `#rolls back the episode and its event when the outbox cannot be written`;
  `tests/api-lifecycle.test.ts#closes only the selected host's container incident after a confirmed removal`.
- **T-02-03 — ensayo sin datos reales.** `tests/database.ts:29-35` rechaza
  cualquier host que no sea `localhost`, `127.0.0.1`, `::1` o `[::1]` cuando
  `HUB_REQUIRE_TEST_DB=1`, y `:11-20` convierte la ausencia de base en fallo en
  lugar de omisión. `tests/migrations.test.ts:196-206` siembra filas sintéticas.
  El preflight de solo lectura y la copia previa están en `README.md:111-126`;
  la reversa advierte sobre archivar outbox y timeline antes de eliminar tablas
  (`README.md:130-136`).

### 02-02 · Contratos de snapshots y política (T-02-04)

- **T-02-04 — decodificación por destino.** `src/lib/agent-snapshots.ts:1-12`
  declara el contrato estructural y la ausencia de coerción a salud; `:409-419`
  selecciona el esquema por pathname (`/metrics`, `/maintenance`,
  `/deployments`). `src/lib/nas.ts:84-93` aplica `safeParse` dentro del Effect y
  devuelve `NasInvalidResponse` en vez de datos sin tipar. Las secciones
  degradadas y la ausencia de evidencia se conservan, no se convierten en
  recuperación (`src/lib/maintenance-alerts.ts:54-56`, `:78-89`, `:251`).
  Pruebas:
  `tests/collector-alerts.test.ts#persists a valid sample and ignores a malformed 200 without touching incidents`,
  `#treats a wrong shape in a 200 as a contract failure, not a disconnect`,
  `#ignores an invalid maintenance payload without resolving its episodes`,
  `#ignores an invalid deployments payload without resolving its episodes` y
  `tests/maintenance-alerts.test.ts#keeps the disk condition when a carrier reports an unknown status`.

### 02-03 · Configuración de arranque y origen canónico (T-02-05, T-02-06)

- **T-02-05 — diagnósticos sin valores.** `src/lib/runtime-config.ts:25-33`
  construye el error con `variable (motivo)` y nunca con el valor;
  `scripts/check-runtime-config.ts:18-29` imprime ese mensaje o un texto
  genérico. Pruebas:
  `tests/runtime-config.test.ts#never includes rejected values in the diagnostic`,
  `#never prints channel credentials or keys` y `#does not print rejected values`;
  los casos de worker comprueban que stdout/stderr no contienen secretos.
- **T-02-06 — arranque y origen canónico.** `src/lib/runtime-config.ts:205-224`
  rechaza usuario, contraseña, query, fragmento y ruta; solo acepta HTTPS o HTTP
  loopback. `:290-315` exige el grupo completo de Telegram y la forma del token;
  `:397-418` valida todo antes de devolver la configuración y lanza
  `RuntimeConfigError` antes de que la app o el worker operen.
  `scripts/check-runtime-config.ts:16-19` carga el entorno con `@next/env` y la
  precedencia de producción; `src/worker.ts:60-66` valida antes de
  `pool.connect` y del lock. Pruebas:
  `tests/runtime-config.test.ts#rejects example host tokens and URLs`,
  `#rejects a partial Telegram group`, `#rejects a mismatched VAPID pair`,
  `#fails pnpm start before Next starts when the environment is invalid` y
  `#stops before the database when required configuration is missing`.

### 02-04 · Despacho, leases y transporte (T-02-07, T-02-08, T-02-10)

- **T-02-07 — lease y resultado.** `src/lib/notification-dispatch.ts:72-90`
  adquiere y comprueba el lock de sesión; `:190-219` reclama con token y lease
  usando `FOR UPDATE SKIP LOCKED`; `:236-256` fija `attemptStartedAt` de forma
  condicional antes de cualquier `fetch`; las escrituras de resultado se
  condicionan por `claimToken` (`:301-308`, `:595-602`, `:627-634`). Pruebas:
  `tests/notification-dispatch.test.ts#does not let a competing session send the same opening`,
  `#keeps an attempt-started lease uncertain without a resend or fallback` y
  `#keeps an ambiguous attempt uncertain without a resend or fallback`.
- **T-02-08 — superficie saliente acotada.** `src/lib/telegram.ts:11-13` fija el
  origen y el límite de texto; `:50-55` trunca sin romper pares surrogados;
  `:154-165` usa `redirect: "error"`; `:275-287` no envía `parse_mode`. Los
  resultados son un conjunto finito de estados y motivos (`:16-31`), sin
  reenviar cuerpos del proveedor. `src/lib/push.ts:50-53` acota TTL, timeout,
  título y cuerpo; `:99-105` serializa solo título, cuerpo, etiqueta, URL y
  `seq`. `src/components/views/routes.ts:72-95` valida host e ID y construye el
  enlace interno sin credenciales. Pruebas:
  `tests/telegram.test.ts#sends plain text with a URL button to the fixed provider origin`,
  `#truncates plain text to the provider limit`,
  `tests/notification-dispatch.test.ts#suppresses the notice when Telegram is disabled and never calls the provider`.
- **T-02-10 — reintentos y edición.** `src/lib/notification-dispatch.ts:19-21`
  fija el lease de 30 s, el timeout de 10 s y el presupuesto de 5 intentos;
  `:404-416` persiste un cooldown compartido por bot/chat antes de reintentar;
  `:735-738` agrupa ediciones por el `seq` más alto y documenta que una revisión
  vieja no pisa a una nueva. Pruebas:
  `tests/notification-dispatch.test.ts#honours retry_after across a restart and shares the cooldown`,
  `#fails permanently on 400, 403 and 404 and creates one fallback per critical` y
  `#edits the original Telegram message in seq order without a second send`.

### 02-05 · Deep link, proyección y push local (T-02-09, T-02-11)

- **T-02-09 — deep link y prueba push.** `src/app/api/[...path]/route.ts:224-248`
  exige host explícito, valida el ID con `^[1-9]\d{0,9}$` y consulta por la
  pareja exacta `id + hostId`, devolviendo 404 sin fallback entre hosts.
  `:701-713` encola la prueba push con `ownerUserId: current.user.id`, nunca con
  un propietario del cuerpo. `src/app/page.tsx:18-29` reconstruye el destino de
  login solo con `readRoute`/`routeHref`, y `src/components/views/routes.ts:30-66`
  valida host e ID antes de construir la URL. Pruebas:
  `tests/api-incidents.test.ts#requires a session and an explicit configured host`,
  `#resolves the exact host and id pair without a cross-host fallback` y
  `#queues the push test for the session owner without contacting a provider`.
- **T-02-11 — proyección pública.** `src/lib/incident-store.ts:423-444` limita
  canales y motivos a conjuntos cerrados; `:476-482` construye la entrega con
  `channel`, `state` y `reason`; `:491-548` proyecta overview y detalle sin
  `chatId`, `messageId`, `endpoint`, tokens ni cuerpos crudos. Pruebas:
  `tests/api-incidents.test.ts#projects finite delivery states and reasons for overview and detail`
  y
  `tests/api-incidents.test.ts#finds an episode older than the 100 recent ones`.

## Amenazas abiertas

Ninguna. Las 11 amenazas están cerradas; `threats_open: 0` (0 bloqueantes con
severidad ≥ `high`). La única amenaza de severidad `medium` (T-02-10) también
está cerrada con evidencia, no se limita a quedar por debajo del umbral.

## Riesgos aceptados

No hay riesgos aceptados.

## Evidencia ejecutada

| Comando | Resultado |
|---|---|
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts tests/incident-store.test.ts tests/collector-alerts.test.ts tests/api-events.test.ts tests/api-lifecycle.test.ts tests/notification-dispatch.test.ts tests/telegram.test.ts tests/api-incidents.test.ts tests/incident-push.test.ts tests/service-worker.test.ts` | 10 archivos, 93 pruebas aprobadas |
| `pnpm test tests/agent-client.test.ts tests/maintenance-alerts.test.ts tests/api-hosts.test.ts tests/api-maintenance.test.ts tests/api-deployments.test.ts tests/events.test.ts tests/runtime-config.test.ts` | 7 archivos, 108 pruebas aprobadas |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 41 archivos, 422 pruebas aprobadas |
| `pnpm typecheck` | `tsc --noEmit` exit 0 |
| `pnpm build` | exit 0; Next.js 16.4.6 |

La suite completa se ejecutó contra PostgreSQL 18.7 desechable en
`postgresql://hub:hub@127.0.0.1:55432/hub`, con `HUB_REQUIRE_TEST_DB=1` para que
la ausencia de base o un destino no loopback fueran fallo duro.

## Registro de revisión

| Fecha | Amenazas | Cerradas | Abiertas | Ejecutado por |
|---|---|---|---|---|
| 2026-11-25 | 11 | 11 | 0 | gsd-security-review (subagente de revisión) |

## Security Audit 2026-11-25

| Metric | Count |
|---|---|
| Threats found | 11 |
| Closed | 11 |
| Open | 0 |

## Firma

- [x] Todas las amenazas tienen disposición (`mitigate` / `accept` / `transfer`).
- [x] Los riesgos aceptados están documentados (no hay).
- [x] `threats_open: 0` confirmado.
- [x] `status: verified` establecido en el frontmatter.

**Aprobación:** verified 2026-11-25
