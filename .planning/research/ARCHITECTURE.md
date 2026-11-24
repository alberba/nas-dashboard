# Architecture Research

**Domain:** subsistema de notificaciones, incidencias y bot interactivo dentro de un hub-and-agent de un solo operador
**Researched:** 2026-11-24
**Confidence:** HIGH en límites de componentes y dirección de los flujos (derivados del código); MEDIUM en umbrales de política y volumen (la auditoría real de Telegram todavía no existe)

## Resumen de decisiones

| # | Decisión | Razón corta |
|---|---|---|
| 1 | El **hub decide y envía**; `media-stack` observa y publica eventos; única excepción: el fallo de copia conserva un envío directo de último recurso si el ingest al hub falla | Una sola política, un solo dedup, un solo sitio donde silenciar y auditar; el fallback cubre la caída del hub |
| 2 | `incidents` (rename de `alerts`) con `fingerprint` estable, `status`, `severity` mutable y un índice único parcial; `incident_events` y `notifications` como timeline y outbox | Una condición no es una incidencia; hacen falta identidad, estado y transiciones durables |
| 3 | `callback_query` por **webhook dedicado**; allowlist de operador en env; ack/snooze y `start` en el webhook; destructivas solo con **passkey reciente**, si no handoff al hub con passkey y `operations` | El webhook no tiene sesión; la única prueba que puede consultar es un passkey reciente del operador, y las acciones lentas no caben en el timeout de Telegram |
| 4 | **Outbox transaccional** en PostgreSQL; solo el worker con `pg_try_advisory_lock(734921)` drena; la web solo escribe filas y el webhook escribe filas o ejecuta acciones permitidas, pero ninguno envía mensajes | Evita doble envío, pérdida al reiniciar y dependencia de una cola externa |
| 5 | Digest en el **loop del worker**, hora local `Europe/Madrid` calculada por instante, clave única por día, catch-up de 2 h y semántica at-most-once | Sobrevive reinicios y DST; dos workers no pueden producir dos digests |
| 6 | Web Push **se queda**, pero como adaptador de la misma política; deja de ser un broadcast con `notify()` | El móvil sigue recibiendo avisos; Telegram es el canal primario de `critical` y push el fallback |
| 7 | Flujo `agent → collector → incident → outbox → Telegram → callback → hub → operation → audit` | El diagrama completo está en [Data Flow](#data-flow) |
| 8 | El hub **lee** `maintenance` y `deployments` por el agente; `media-stack` solo cambia para publicar eventos y para el fallback; el hub no escribe estado de `media-stack` salvo las acciones fijas existentes | Mantiene al agente como capa read-only y el contrato multi-repo |

---

## Standard Architecture

### System Overview

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Superficie del operador                                                      │
│  PWA / navegador            Telegram (móvil)                                 │
└──────────┬───────────────────────────┬───────────────────────────────────────┘
           │ HTTPS + session           │ callback_query / message
           ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Next.js 16 — una réplica web                                                 │
│                                                                              │
│  Frontera browser (una sola):  src/app/api/[...path]/route.ts                │
│    · origin guard · sesión Better Auth · host scope · Zod · verificación     │
│    · /api/incidents, /api/incidents/:id/ack, /api/incidents/:id/snooze       │
│    · /api/telegram/intents/execute                                          │
│                                                                              │
│  Fronteras máquina-a-máquina (no-browser, autenticación propia):             │
│    · src/app/api/telegram/webhook/route.ts        (secret_token de Telegram) │
│    · src/app/api/notifications/ingest/route.ts    (HMAC de media-stack)      │
└──────────┬───────────────────────────────────────────────────────────────────┘
           │ SQL (pg Pool)
           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL 18 — único estado durable                                         │
│  incidents · incident_events · notifications (outbox) · operations           │
│  telegram_updates · telegram_action_tokens · telegram_action_intents         │
│  digest_runs · ingest_events · samples · configuration · subscriptions       │
└──────────┬───────────────────────────────────────────────────────────────────┘
           │ SQL
           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ worker.ts — un proceso, lock 734921                                          │
│  collectAll → señales → incidents.apply → outbox.drain → digest.maybeRun     │
│  cleanup 30 días                                                             │
└──────────┬───────────────────────────────────────────────────────────────────┘
           │ HTTP + Bearer, solo el hub inicia
           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Python agent por host (NAS y apps-server, detrás de Tailscale)               │
│  /metrics · /maintenance · /deployments · /logs · /action · /command         │
│  Docker socket, /proc, /sys, SMART, systemd, mounts read-only de media-stack │
└──────────────────────────────────────────────────────────────────────────────┘
```

`media-stack` no aparece como capa de escritura: sus scripts publican eventos al hub y, si el ingest falla, conservan el envío directo de último recurso. El agente sigue siendo la única capa que lee el host.

### Component Responsibilities

| Componente | Responsabilidad | Implementación propuesta |
|---|---|---|
| `src/lib/notifications/signals.ts` | Convertir `Metrics` + `MaintenanceSnapshot` + `DeploymentsSnapshot` en señales puras (`key`, `failing`, `severity`, `category`, `duration`, `groupKey`, `title`, `detail`) | Funciones puras, sin DB ni red; reutiliza `maintenance-alerts.ts` |
| `src/lib/incidents.ts` | Máquina de estados: `pending → open → acknowledged/snoozed → resolved`; agrupación e inhibición | Transacciones Drizzle; índice único parcial por `fingerprint` |
| `src/lib/notifications/policy.ts` | Decidir canal y momento por `(category, severity, status)`; opt-out y quiet hours | Tabla de política testeable, sin efectos |
| `src/lib/notifications/outbox.ts` | Encolar, reclamar con lease, marcar `sent/failed/suppressed`, recuperar leases vencidos | SQL `FOR UPDATE SKIP LOCKED`; `dedupe_key` único |
| `src/lib/notifications/dispatcher.ts` | Drenar el outbox del worker, ordenar dependencias, aplicar reintentos | Solo se ejecuta bajo el lock 734921 |
| `src/lib/notifications/telegram.ts` | Cliente de la Bot API: `sendMessage`, `editMessageText`, `answerCallbackQuery`, `setWebhook`, `getWebhookInfo` | `fetch` con timeout 10 s; parsea `retry_after`; nunca loguea el token |
| `src/lib/notifications/render.ts` | Render HTML de Telegram, teclados inline, truncado a 4096 y `callback_data` ≤ 64 bytes | Funciones puras; escapa HTML; fallback a texto plano |
| `src/lib/notifications/telegram-webhook.ts` | `handleUpdate`: dedupe `update_id`, allowlist, despacho a estado, ejecución directa o handoff | Sin dependencia del transporte; reusable si algún día se usa long polling |
| `src/lib/notifications/telegram-tokens.ts` | Tokens opacos de botón, intents de handoff, hash, TTL y single-use | Tokens aleatorios de 128 bits; la DB es la autoridad |
| `src/lib/notifications/digest.ts` | Calcular si toca, construir el resumen, reclamar el día, marcar incluidos | `madridInstant` + `digest_runs` |
| `src/lib/notifications/ingest.ts` | Verificar HMAC de `media-stack`, traducir evento a señal, idempotencia | Ventana de 5 min; mismo `fingerprint` que el snapshot |
| `src/lib/operation-runner.ts` | Runner único de operaciones (hoy duplicado en `route.ts`, `lifecycle.ts`, `host-commands.ts`) | Extracción del patrón de `executeHostCommand` (`src/lib/host-commands.ts:96`) |
| `src/lib/push.ts` | Adaptador Web Push sin política: lee suscripciones, envía, poda 404/410 | `sendPush(payload)` devuelve resultado; ya no se llama desde el collector |
| `src/worker.ts` | Colección, drenaje del outbox, digest y retención | Loop actual + `drainOutbox()` + `maybeRunDigest()` |
| `src/app/api/telegram/webhook/route.ts` | Transporte del webhook: secreto, tamaño, JSON, 200 tras el trabajo corto | Frontera no-browser, separada del catch-all |
| `src/app/api/notifications/ingest/route.ts` | Transporte del ingest de `media-stack` | Frontera no-browser, HMAC |

### Dirección de los flujos

| Flujo | Dirección | Quién inicia | Notas |
|---|---|---|---|
| Métricas, mantenimiento, despliegues | hub → agent | worker / app | Solo GET; el agente nunca empuja al hub |
| Acciones de host | hub → agent | app (sesión + verificación) | Solo `/action` y `/command` con listas cerradas |
| Eventos de `media-stack` | media-stack → hub | script de backup/security/upgrade | `POST /api/notifications/ingest`, HMAC, respuesta 202 |
| Fallback de `media-stack` | media-stack → Telegram | script, solo si el ingest falla | Último recurso; no decide política |
| Notificaciones | hub → Telegram / push | worker | Solo el worker; web y webhook encolan |
| Callbacks | Telegram → hub | usuario en Telegram | Webhook con `secret_token`; sin sesión de navegador |
| Acción desde Telegram | hub → agent | hub (webhook con passkey reciente o UI tras handoff) | El webhook solo ejecuta `start` o destructivas con passkey ≤ 5 min; si no, handoff |

---

## Ownership: el hub decide, `media-stack` observa

### La regla

**El hub es el único componente que convierte una observación en una decisión de notificación y el único que formatea y envía.** `media-stack` conserva la observación local de lo que solo él sabe (resultado de la copia, comparaciones de seguridad, upgrades desatendidos) y la publica como evento. No decide severidad, no decide canal, no decide si se envía.

La única excepción deliberada es el **fallback de último recurso**: si el ingest al hub falla (hub o PostgreSQL caídos), el script de `media-stack` envía su mensaje directo por Telegram. Es el único camino que sobrevive a la caída del hub, y se limita a la familia que no admite silencio: la copia fallida. El resto de familias acepta el silencio durante una caída del hub; el hub no puede avisar de su propia caída sin un dead-man's switch externo, que está fuera de alcance.

Ventana de duplicado aceptada: si el hub estaba caído cuando la copia falló, `media-stack` envía directo y, al volver, el snapshot abre la misma incidencia y el hub puede enviar otro mensaje. También puede duplicarse si el ingest confirma tarde (el script agota su timeout pero el hub ya hizo commit). Es el precio de no perder la única alarma irreversible; se documenta y se cuenta en la auditoría. La alternativa —silencio total durante la caída— se rechaza.

Por qué no "ambos":

- Dos políticas, dos dedups, dos formatos y dos sitios donde silenciar. El operador no puede saber por qué recibió algo ni acallarlo de una vez.
- El audit de volumen se vuelve imposible: no se puede atribuir un mensaje a una decisión.
- Un evento que el hub decide mandar al digest se enviaría igualmente por `media-stack`, rompiendo la regla "una notificación por incidencia".

Por qué no "`media-stack` siempre en silencio":

- Si el hub está caído, la copia fallida no avisa a nadie. Es la única familia con consecuencias irreversibles y con un emisor local que ya existe (`stacks/backup/media-backup.sh:138`).
- El fallback no duplica cuando el hub está sano: el script solo envía si el ingest no confirma. La confirmación es el contrato, no la salud genérica del hub.

### Reparto por familia (una línea por familia)

| Familia | Clave(s) reales | Decisor | Regla de una línea |
|---|---|---|---|
| Conexión | `connection` | hub | Inmediato tras 60 s; es el padre que inhibe `container:*`, `stack-unit-failed` y `deploy-failed` del mismo host |
| Umbrales | `cpu`, `memory`, `disk`, `temperature` | hub | `temperature` inmediato; CPU/mem/disk al digest, con escalada a inmediato si el disco llega al 95 % o el umbral se mantiene > 15 min |
| Contenedores | `container:<name>` | hub | Silencioso por defecto; 2+ contenedores caídos en 5 min se agrupan en `services-down:<host>`; solo los marcados críticos generan incidencia propia inmediata |
| Unidades | `stack-unit-failed` | hub | Inmediato, inhibido mientras `connection` esté abierta |
| Mantenimiento | `reboot-pending` | hub | Solo digest; puede durar semanas y no justifica interrumpir |
| Copia | `backup-failed` | hub, con fallback de `media-stack` | Inmediato una vez; `media-stack` solo envía directo si el ingest al hub falla |
| Discos | `disk-health` | hub | `fail` inmediato; `watch` al digest; la severidad se recalcula en cada evaluación |
| Despliegues | `deploy-failed`, `release-retained` | hub | `deploy-failed` inmediato (incluye `rolled-back`); `release-retained` al digest |
| Seguridad | `security-review` | hub | Un mensaje agregado si hay actualizaciones verificadas; si no, silencio. Sin fallback directo: si el hub está caído, espera a la reconciliación del snapshot |
| Renovate / WUD | `renovate`, `wud` | hub / excepción WUD | Renovate al digest; WUD conserva su trigger `major-only` hasta que el agente lea su store; se cuenta aparte en la auditoría |
| Test | `test` | hub | Solo desde el hub, marcado como test, nunca entra en métricas |

La tabla de claves se implementa en `src/lib/notifications/policy.ts` y se testea sin DB. La severidad se recalcula en cada evaluación, no se congela al insertar (hoy `src/lib/collector.ts:65` y `src/lib/maintenance-alerts.ts:102` la fijan al abrir; ver `CONCERNS.md:263`).

### Caída del hub, del worker o del NAS

| Escenario | Efecto | Mitigación |
|---|---|---|
| Hub/Next.js caído | Webhook e ingest fallan; no hay estado nuevo | `media-stack` envía directo la copia fallida; Telegram reintenta el webhook cuando vuelva; el outbox sigue en PostgreSQL. Al recuperar, el aviso de copia puede duplicarse: se acepta |
| PostgreSQL caído | El hub responde 503; el ingest falla | Fallback directo de `media-stack` para copia; al volver, el snapshot reconcilia las incidencias |
| Worker caído, app y DB sanos | El ingest acepta y encola; nadie drena; no hay mensajes | El outbox persiste y se envía al volver; el hub muestra el heartbeat del worker como stale; el digest tiene catch-up de 2 h |
| Telegram caído o 429 | El outbox reintenta; `critical` puede caer a push | Backoff con `retry_after`; estado de entrega visible en el hub |
| NAS caído (agente inalcanzable) | No hay muestra; se abre `connection` tras 60 s | No se inventan señales desde snapshots degradados; al volver, se edita el mensaje a resuelta |
| `media-stack` caído | Sus scripts no publican; los snapshots llegan degradados | `maintenance-alerts` ignora las secciones degradadas y no resuelve por ausencia; no hay churn |

Aceptado y explícito: **hub caído = silencio para todo excepto la copia fallida**. No se añade un heartbeat de Telegram ni un dead-man's switch externo en este milestone.

---

## Modelo de incidencia

### De condición a incidencia

Hoy `condition()` (`src/lib/collector.ts:25`) mezcla evaluación, debounce en memoria (`started`, línea 16), inserción en `alerts`, resolución y `notify()` (líneas 53 y 66). El estado de debounce se pierde en cada reinicio y una condición no tiene identidad estable más allá de `(hostId, key)`.

El modelo propuesto:

1. `signals.ts` evalúa todas las condiciones y devuelve `IncidentSignal[]` sin tocar la DB. `maintenance-alerts.ts` ya tiene la forma correcta (`AlertSignal`, línea 11) y se conserva como fuente pura.
2. `incidents.apply(host, signals, now)` abre una transacción y, por cada señal, hace un upsert por `fingerprint = hostId:key`.
3. Si la señal falla y no hay incidencia activa, se crea en `pending` con `firstSeenAt = now`. El debounce es durable: no hay mapa en memoria. Cuando `now - firstSeenAt >= duration`, pasa a `open` y encola la notificación.
4. Si la señal deja de fallar y la incidencia está `pending`, se descarta sin avisar. Si está `open/acknowledged/snoozed`, pasa a `resolved` y encola una **edición** del mensaje, nunca un mensaje nuevo.
5. Si la incidencia ya está abierta y el fallo continúa, solo se actualizan `lastSeenAt`, `title` y `detail`; no se notifica. Un cambio de severidad a `critical` es un cambio de estado y sí encola una escalada.
6. Reapertura: si la misma `fingerprint` vuelve a fallar después de `resolved`, se crea una nueva fila con `occurrence + 1`. Dentro de `REOPEN_COOLDOWN_MS` (10 min) se reabre la misma fila sin notificar, para que un host que oscila no genere un par resolución/reapertura por ciclo.

Invariante de una sola incidencia activa por condición: índice único parcial en PostgreSQL. No hace falta un lock de aplicación ni una transacción con `SELECT ... FOR UPDATE` para el caso normal; la restricción es la autoridad.

### Identidad, agrupación e inhibición

- **Identidad estable:** `fingerprint = hostId + ":" + key`. Es la misma para la evaluación de métricas, el snapshot y el evento de `media-stack`, así que las tres fuentes convergen en la misma incidencia.
- **Identidad de mensaje:** `incidents.id` (integer) y, para el botón, un token opaco en `telegram_action_tokens`; el `id` nunca viaja en `callback_data`.
- **Ocurrencia:** `occurrence` distingue reaperturas; el historial no se pierde.
- **Agrupación:** `groupKey` y `parentId`. La regla v1 es la inhibición por `connection` y una incidencia `services-down:<host>` cuando 2+ contenedores caen en 5 min. Los hijos se registran pero no notifican; el padre es el único mensaje.
- **Inhibición:** `policy.ts` consulta si el padre `connection` está activo. Si lo está, los hijos se abren igualmente como `open` para que el hub los muestre, pero la política **no encola envío**: se registra `incident_events(kind='suppressed', reason='inhibited_by_connection')`. Al resolverse el padre, se re-evalúan: si siguen fallando, se agrupan en un único `services-down`.

### Esquema Drizzle (sketch)

`user` es la tabla de Better Auth que ya existe; `NotificationPayload` es el tipo del payload ya renderizado (texto, botones, deep link) y no se serializa desde el colector.

```ts
import {
  pgTable, text, integer, bigint, timestamp, jsonb, uuid,
  index, uniqueIndex, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Renombrada desde `alerts`; conserva el id entero y la columna `at`. */
export const incidents = pgTable("incidents", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  hostId: text().notNull().default("nas-home"),
  key: text().notNull(),
  fingerprint: text().notNull(),                    // `${hostId}:${key}`
  category: text().notNull(),                       // connection|thresholds|containers|...
  severity: text().notNull(),                       // critical|warning|info (mutable)
  status: text().notNull().default("pending"),      // pending|open|acknowledged|snoozed|resolved
  title: text().notNull(),
  detail: text().notNull().default(""),
  occurrence: integer().notNull().default(1),
  transitionSeq: integer().notNull().default(0),       // se incrementa en cada transición
  groupKey: text(),                                 // services-down:<host>, etc.
  parentId: integer("parent_id").references((): AnyPgColumn => incidents.id, {
    onDelete: "set null",
  }),
  firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp({ withTimezone: true }),
  acknowledgedBy: text(),                           // userId del hub o `telegram:<id>`
  snoozedUntil: timestamp({ withTimezone: true }),
  resolvedAt: timestamp({ withTimezone: true }),
  digestDay: text(),                                // YYYY-MM-DD Europe/Madrid
  telegramMessageId: bigint({ mode: "number" }),
  at: timestamp().notNull().defaultNow(),           // compatibilidad con `alerts`
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("incidents_active_fingerprint_idx")
    .on(t.fingerprint)
    .where(sql`${t.status} in ('pending','open','acknowledged','snoozed')`),
  index("incidents_host_status_idx").on(t.hostId, t.status),
  index("incidents_opened_idx").on(t.openedAt),
]);

/** Timeline append-only: estado, entrega y acciones. */
export const incidentEvents = pgTable("incident_events", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  incidentId: integer().notNull().references(() => incidents.id, { onDelete: "cascade" }),
  kind: text().notNull(),                           // opened|escalated|acked|snoozed|resolved|delivery|action
  actor: text().notNull(),                          // system|telegram:<id>|web:<userId>
  channel: text(),                                  // telegram|push|null
  status: text(),                                   // sent|failed|suppressed|null
  reason: text(),
  data: jsonb().$type<Record<string, unknown>>(),
  at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("incident_events_incident_idx").on(t.incidentId, t.at)]);

/** Outbox transaccional. La cola es una tabla, no Redis. */
export const notifications = pgTable("notifications", {
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),                           // incident_open|incident_update|incident_resolve|digest|test
  incidentId: integer().references(() => incidents.id, { onDelete: "cascade" }),
  channel: text().notNull(),                        // telegram|push
  dedupeKey: text().notNull().unique(),             // incident:<id>:open:<seq>, digest:<day>, ...
  dependsOn: uuid("depends_on"),                    // orden open → resolve
  payload: jsonb().$type<NotificationPayload>().notNull(),
  status: text().notNull().default("pending"),      // pending|sending|sent|failed|suppressed
  attempts: integer().notNull().default(0),
  nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp({ withTimezone: true }),
  telegramMessageId: bigint({ mode: "number" }),
  lastError: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp({ withTimezone: true }),
}, (t) => [
  index("notifications_due_idx").on(t.status, t.nextAttemptAt),
  index("notifications_incident_idx").on(t.incidentId),
]);

/** Dedupe de reintentos del webhook de Telegram. */
export const telegramUpdates = pgTable("telegram_updates", {
  updateId: bigint({ mode: "number" }).primaryKey(),
  receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp({ withTimezone: true }),   // null = a medias; se reprocesa
  outcome: text(),
});

/** Token opaco de un botón; `callback_data` solo lleva este id. */
export const telegramActionTokens = pgTable("telegram_action_tokens", {
  id: text().primaryKey(),                          // 16 bytes base64url
  incidentId: integer().notNull().references(() => incidents.id, { onDelete: "cascade" }),
  action: text().notNull(),                         // ack|snooze_1h|snooze_24h|stop|restart|...
  target: text(),
  operationId: uuid("operation_id"),                // estable para `operations`; null en ack/snooze
  chatId: text().notNull(),
  messageId: bigint({ mode: "number" }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
});

/** Handoff de una acción de host; su id es también `operations.id`. */
export const telegramActionIntents = pgTable("telegram_action_intents", {
  id: uuid().primaryKey().defaultRandom(),          // = token.operationId = operations.id
  incidentId: integer().notNull().references(() => incidents.id, { onDelete: "cascade" }),
  hostId: text().notNull(),
  action: text().notNull(),
  target: text().notNull(),
  userId: text().notNull().references(() => user.id, { onDelete: "cascade" }),
  telegramUserId: text().notNull(),
  handoffHash: text().notNull(),                    // sha256 del token del fragmento
  verifiedAt: timestamp({ withTimezone: true }),    // passkey reciente ya comprobado en el webhook
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  status: text().notNull().default("pending"),      // pending|executed|failed|expired
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Idempotencia de eventos de media-stack. */
export const ingestEvents = pgTable("ingest_events", {
  id: text().primaryKey(),                          // `${source}:${eventId}`
  fingerprint: text().notNull(),
  receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Un digest por día local; segunda barrera además de `dedupe_key`. */
export const digestRuns = pgTable("digest_runs", {
  day: text().primaryKey(),                         // YYYY-MM-DD Europe/Madrid
  status: text().notNull().default("pending"),      // pending|sending|sent|failed|skipped
  notificationId: uuid().references(() => notifications.id, { onDelete: "set null" }),
  incidentCount: integer().notNull().default(0),
  startedAt: timestamp({ withTimezone: true }),
  sentAt: timestamp({ withTimezone: true }),
  error: text(),
});
```

Migración: `ALTER TABLE alerts RENAME TO incidents`, añadir columnas, backfill de `fingerprint`, `category`, `status` (`resolvedAt IS NULL ? 'open' : 'resolved'`), `openedAt = at`, `firstSeenAt = at`, `lastSeenAt = coalesce(resolvedAt, at)`, `occurrence` con `row_number() over (partition by hostId, key order by at)`, y crear el índice parcial. Si hubiera dos abiertas para la misma clave (no debería), se resuelve la más antigua a `resolvedAt = at` de la más nueva antes de crear el índice. `src/lib/schema.ts`, `src/lib/types.ts` (`Alert` → `Incident`), `src/app/api/[...path]/route.ts` (`/api/overview`) y `src/components/views/alerts.tsx` se actualizan en el mismo cambio. `samples.at` y otros timestamps existentes no se tocan; las tablas nuevas usan `timestamptz`.

### Transiciones

| Desde | Evento | Hacia | Efecto en outbox |
|---|---|---|---|
| — | señal falla, `duration=0` | `open` | `incident:<id>:open:<seq>` |
| — | señal falla, `duration>0` | `pending` | ninguno |
| `pending` | se cumple la duración | `open` | `incident:<id>:open:<seq>` |
| `pending` | señal se recupera | se descarta | ninguno |
| `open` | ack | `acknowledged` | `incident:<id>:ack:<seq>` |
| `open`/`acknowledged` | snooze | `snoozed` | `incident:<id>:snooze:<seq>` |
| `open`/`acknowledged`/`snoozed` | señal se recupera | `resolved` | `incident:<id>:resolve:<seq>` |
| `open`/`acknowledged` | severidad sube a `critical` | mismo estado | `incident:<id>:escalate:<seq>` |
| `resolved` | señal vuelve a fallar dentro del cooldown | `open` (misma fila) | ninguno (evita flapping) |
| `resolved` | señal vuelve a fallar pasado el cooldown | nueva fila, `occurrence+1` | `incident:<newId>:open:<seq>` |

Snooze no programa un recordatorio temporizado en v1: silencia hasta que la incidencia se resuelva o cambie de severidad. Un recordatorio a las 24 h sería otro mensaje no solicitado; si se quiere, entra en la fase de escalado (D-6 de `FEATURES.md`), no en el núcleo.

### Relación entre digest e incidencias

El digest **no es una incidencia**. Es una vista diaria de incidencias no críticas:

- `digestDay` guarda el último día local en que la incidencia se incluyó. La consulta selecciona las que tienen `digestDay IS DISTINCT FROM hoy` y actividad en las últimas 24 h (`lastSeenAt` o `resolvedAt`), excluyendo `critical` y las que ya tienen un `notifications(channel='push', status='sent')` para esa incidencia.
- Las incidencias abiertas desde antes de la ventana se resumen en una línea ("N abiertas desde antes"), no se repiten una por una.
- Al confirmar el envío, se actualiza `digestDay = hoy` para las incluidas; si el envío falla, no se marcan y el reintento del mismo payload las cubre.
- `notifications(kind='digest', dedupeKey='digest:<day>')` guarda el payload renderizado; `digest_runs(day)` es la segunda barrera y el registro de "hubo/ no hubo".

---

## Callback path

### Flujo

1. El operador pulsa un botón inline. Los botones de **abrir** son `url` buttons, no callbacks: abren `https://<hub>/?view=alerts&incident=<id>&host=<id>` y no necesitan token. Los botones de **ack/snooze** y de **acción** son `callback_query` y llegan a `https://<hub>/api/telegram/webhook` con `X-Telegram-Bot-Api-Secret-Token`.
2. `src/app/api/telegram/webhook/route.ts` valida el header en tiempo constante, limita el cuerpo (64 KB), parsea el JSON y registra `update_id` en `telegram_updates` con `processedAt = null`. Si ya está procesado (`processedAt` no nulo), responde 200 sin reprocesar; si quedó a medias, lo reprocesa (las acciones son idempotentes). Si el procesamiento falla, responde 5xx para que Telegram reintente y deja `processedAt` nulo. Responde 200 después del trabajo corto (estado o handoff); las acciones lentas no bloquean la respuesta.
3. `handleTelegramUpdate` (`src/lib/notifications/telegram-webhook.ts`) comprueba allowlist: `from.id === TELEGRAM_OPERATOR_USER_ID`, `callback_query.message.chat.id === TELEGRAM_OPERATOR_CHAT_ID`, `message.from.is_bot === true`. Cualquier otro chat, usuario, mensaje reenviado o modo inline se rechaza con `answerCallbackQuery` genérico y sin detalle.
4. Resuelve `callback_data` contra `telegram_action_tokens` (`v1:<id>`), comprueba `expiresAt` y `usedAt`, y consume el token con un `UPDATE ... WHERE used_at IS NULL RETURNING *`. Un replay devuelve la misma respuesta, no una segunda ejecución. TTL del token de botón: 7 días o hasta que la incidencia se resuelva; el del handoff, 5 min.
5. Acciones de estado (`ack`, `snooze`): llaman a `src/lib/incidents.ts` (`ack`, `snooze`), escriben `incident_events` y encolan la edición del mensaje. `answerCallbackQuery({ text: "Hecho" })` da feedback inmediato. No requieren verificación.
6. Acciones de host (`start`, `stop`, `restart`, `reboot`, `remove-container`, `deploy-now`, merge Renovate, `update-container`):
   - **Iniciar contenedor** es reversible: se ejecuta en el webhook con la allowlist y el token, sin passkey.
   - **Destructivas** (`stop`, `restart`, `reboot`, `remove-container`, `deploy-now`, merge): se ejecutan en el webhook **solo si existe un registro de passkey del operador con menos de 5 minutos** (`requireRecentVerificationForUser(userId, "passkey")`, nuevo en `src/lib/verification.ts`; toma la fila más reciente del usuario en `recent_verification` y exige `method='passkey'`). Es la "verificación reciente opcional" del encargo, consultada por `userId` y no por sesión. Si existe, se responde `answerCallbackQuery("Ejecutando…")` y se llama a `operation-runner` con `operationId = token.operationId`; `operations` deduplica el replay. Si no existe, **no se ejecuta**: se crea una fila en `telegram_action_intents` ligada a `(userId, id, action, target)`, `handoffHash = sha256(token)` y `expiresAt = now + 5 min`, y se encola una edición del mensaje que añade un `url` button "Verificar en el hub".
   - **Actualizar imagen** siempre hace handoff, incluso con passkey reciente: el runner puede tardar 300 s y el webhook de Telegram no debe quedarse colgado; la UI del hub ya muestra el progreso.
   - El handoff usa un `url` button (fiable) hacia `https://<hub>/?view=alerts&incident=<id>#intent=<id>&token=<token>`. El token va en el **fragmento**: no se envía al servidor, no aparece en `Referer` ni en logs de proxy. La UI lo lee, lo borra con `history.replaceState` y muestra el diálogo con verbo y objetivo ("Detener `plex` en NAS-HOME").
   - La UI exige sesión del `userId` del intent y, si no hay verificación reciente registrada en el intent, passkey con `guardIntentAction`. `POST /api/telegram/intents/execute` (rama del catch-all) verifica sesión, hash, expiración, estado y verificación; llama a `operation-runner` con el mismo `operationId`; marca el intent `executed` y devuelve la operación. Un replay devuelve la operación existente.
7. El worker drena el outbox y edita el mensaje original con `editMessageText`: "Reconocida", "Silenciada hasta HH:MM", "Resuelta", "Ejecutando…" o el resultado de la operación. Si el mensaje ya no se puede editar, se marca `suppressed` y el hub muestra el estado; no se envía un mensaje nuevo.

No se usa `answerCallbackQuery.url`: la Bot API solo garantiza ese parámetro para URLs de juegos o enlaces `t.me/<bot>?start=…`; para abrir el hub se usan `url` buttons, que siempre funcionan.

### Módulos exactos

| Módulo | Responsabilidad |
|---|---|
| `src/app/api/telegram/webhook/route.ts` | Transporte: `secret_token`, tamaño, JSON, `update_id`, 200 |
| `src/lib/notifications/telegram-webhook.ts` | Allowlist, resolución de token, estado, ejecución directa o handoff |
| `src/lib/notifications/telegram.ts` | Bot API: `sendMessage`, `editMessageText`, `answerCallbackQuery`, `setWebhook`, `getWebhookInfo` |
| `src/lib/notifications/telegram-tokens.ts` | Tokens de botón, `operationId` estable, intents, hash, TTL, single-use |
| `src/lib/incidents.ts` | `ack`, `snooze`, `resolve`, `escalate`; transacciones y eventos |
| `src/lib/verification.ts` | `requireRecentVerificationForUser(userId, "passkey")`, hermano del chequeo por sesión |
| `src/lib/verification-api.ts` | `guardSensitiveAction` (browser) y `guardIntentAction` (handoff: sesión + `intent.verifiedAt` o passkey) |
| `src/lib/operation-runner.ts` | Runner único; `operations` idempotente y auditoría |
| `src/app/api/[...path]/route.ts` | Ramas browser: `telegram/intents/execute`, `incidents/:id/ack`, `incidents/:id/snooze`, `notifications/test` |
| `scripts/telegram-webhook.ts` | `setWebhook` / `deleteWebhook` manual; no se ejecuta en cada arranque |

### Matriz de acciones

| Acción | ¿La ejecuta el webhook? | Autorización | Verificación reciente | Idempotencia | Auditoría |
|---|---|---|---|---|---|
| Abrir vista / detalle | No (es un `url` button) | El hub exige sesión; el bot solo lo envía al chat permitido | No | N/A | — |
| Ack | Sí | Allowlist + token de botón | No | `UPDATE` idempotente | `incident_events` |
| Snooze 1 h / 24 h | Sí | Allowlist + token | No | `(incidentId, until)` idempotente | `incident_events` |
| Iniciar contenedor | Sí | Allowlist + token | No (reversible) | `operations.id = token.operationId` | `operations` + evento |
| Detener / reiniciar | Sí, solo con passkey ≤ 5 min; si no, handoff | Allowlist + token (+ sesión en el handoff) | **Sí (passkey)** | `operations.id = token.operationId` | `operations` + evento |
| Actualizar imagen | Handoff siempre | Allowlist + token + sesión | **Sí (passkey)** | `operations.id = token.operationId` | `operations` + evento |
| Reiniciar host | Sí, solo con passkey ≤ 5 min; si no, handoff | Allowlist + token (+ sesión) | **Sí** (ya lo exige `route.ts:438`) | `operations.id = token.operationId` | `operations` + `bootAt` |
| Deploy / rollback / merge | Sí, solo con passkey ≤ 5 min; si no, handoff | Allowlist + token (+ sesión) | **Sí** | `operations.id = token.operationId` | `operations` |
| Test de notificación | Solo desde el hub | Sesión | No | `dedupeKey=test:<uuid>` | `notifications` |

`start`/`stop`/`restart`/`update-container` hoy no exigen verificación en `route.ts:438`; **extender `guardSensitiveAction` a todas las destructivas es un prerequisite de la fase de acciones**, no un extra. Sin eso, el botón "Detener" sería más seguro que la propia UI, lo cual es absurdo. `TELEGRAM_DIRECT_ACTIONS=0` desactiva la ejecución directa y deja solo el handoff; es el valor por defecto hasta que la verificación por usuario esté desplegada y testeada.

### Amenazas y mitigaciones

| Amenaza | Mitigación |
|---|---|
| Añadir el bot a un grupo o reenviar un mensaje | Allowlist estricta de `chat.id` y `from.id`; se ignoran grupos, canales y mensajes reenviados |
| Adivinar o manipular `callback_data` | Token aleatorio de 128 bits; solo el id viaja en el botón; el servidor resuelve acción y target |
| Repetir un callback | `telegram_updates.update_id` + `used_at` + `operations.id`; el replay es no-op |
| Robo del token del bot | El token solo permite enviar mensajes; ejecutar exige allowlist de Telegram y, para destructivas, passkey reciente (o sesión + passkey en el handoff) |
| Robo del móvil o de la cuenta de Telegram | Ack/snooze/`start` son de bajo impacto; detener, reiniciar, actualizar, desplegar y reiniciar el host exigen un passkey de los últimos 5 min o el hub con passkey |
| Webhook falso | `secret_token` en tiempo constante sobre TLS; sin secreto se responde 401 y no se procesa |
| Enlace de handoff reenviado | Token de un solo uso, TTL 5 min, ligado a `(userId, intentId, action, target)`, en el fragmento y con sesión + passkey |
| Acción destructiva sin passkey | Fail-closed: sin registro de passkey reciente no hay ejecución directa; el handoff exige passkey |
| Fuga en logs | Nunca se loguea `callback_data`, el token de handoff ni el body; solo `update_id`, acción e id de incidencia |
| Fuerza bruta de callbacks | Rate limit en memoria por usuario (la réplica web es única, igual que el rate limit de auth en `src/lib/auth.ts:67`) |

Por qué la ejecución directa es la excepción y no la regla: el webhook no tiene sesión de navegador; su única prueba es el registro de passkey del operador, consultado por `userId`. Eso basta para acciones rápidas e idempotentes cuando además se posee la cuenta de Telegram, pero no para acciones lentas ni para la primera vez sin passkey. El handoff mantiene la regla existente ("la única fuente de verdad es el registro server-side", `src/lib/verification-api.ts:86`), no inventa autenticación en el chat y es el camino por defecto. `FEATURES.md` propone handoff siempre; este documento acepta la excepción acotada porque el encargo pide ejecutar desde Telegram y porque el passkey reciente es un segundo factor real, no un campo del callback. Si se prefiere la regla estricta, el flag `TELEGRAM_DIRECT_ACTIONS=0` ya la implementa.

### Webhook o long polling

Se elige webhook porque el hub se despliega con `BETTER_AUTH_URL` HTTPS detrás de un proxy inverso y el móvil ya lo alcanza; si esa premisa se cumple, Telegram reintenta las entregas y la latencia de `answerCallbackQuery` es menor. `handleTelegramUpdate` no depende del transporte: si el hub no fuera alcanzable desde Internet, `worker.ts` puede llamar a la misma función desde `getUpdates` sin cambiar la lógica de autorización, tokens ni acciones. La alternativa de long polling en el worker se descarta para v1 porque acopla recepción y envío en el mismo proceso, complica el backoff y no elimina la necesidad de autorizar al usuario.

### Configuración y secretos

| Variable | Uso | Validación |
|---|---|---|
| `NOTIFICATIONS_MODE` | `legacy` \| `shadow` \| `incidents` | Default `legacy`; el worker falla al arrancar si el valor no es válido |
| `TELEGRAM_ENABLED` | `0`/`1`; apaga el bot sin apagar el hub | Si `incidents` y `1`, el worker exige el resto de variables |
| `TELEGRAM_BOT_TOKEN` | Bot API | Secreto; no se loguea; rotación documentada |
| `TELEGRAM_WEBHOOK_SECRET` | `secret_token` del webhook | 32+ caracteres; el webhook responde 503 si falta, nunca acepta |
| `TELEGRAM_OPERATOR_USER_ID` | Allowlist de `from.id` | Numérico; sin él, todo callback se rechaza |
| `TELEGRAM_OPERATOR_CHAT_ID` | Allowlist de `chat.id` | Numérico; sin él, todo callback se rechaza |
| `HUB_OPERATOR_USER_ID` | `user.id` de Better Auth para `operations` e intents | Debe existir y ser el único operador; se valida al arrancar |
| `TELEGRAM_DIRECT_ACTIONS` | `0`/`1`; permite ejecución directa de destructivas con passkey reciente | Default `0` hasta que `requireRecentVerificationForUser` esté probado |
| `NOTIFY_INGEST_SECRET` | HMAC de `media-stack` | 32+ caracteres; ventana de 5 min y `eventId` único |
| `DIGEST_HOUR` | Hora local del digest | 0–23; default 8; se puede sobrescribir en `configuration` |

La validación ocurre al arrancar (`instrumentation.ts` o el `main()` del worker), no en la primera petición: un hub "sano" con el bot mal configurado es peor que un hub que no arranca. Si `TELEGRAM_ENABLED=0`, el hub funciona con push y sin webhook; el ingest sigue aceptando eventos y el outbox los guarda.

---

## Delivery guarantees

### Outbox transaccional

La decisión de notificar y la transición de la incidencia se escriben en la **misma transacción** PostgreSQL:

```text
BEGIN
  upsert incidents (fingerprint, status, severity, ...)
  insert incident_events (kind='opened')
  insert notifications (dedupe_key='incident:<id>:open:<seq>', payload=...)
COMMIT
```

Si el worker muere después del commit, la fila sigue ahí y se envía al reiniciar. Si muere antes, no se envió nada y la evaluación siguiente vuelve a intentarlo. No hay ventana en la que la incidencia exista y la notificación se haya perdido sin rastro.

El envío real ocurre fuera de la transacción; nunca se llama a Telegram con una transacción abierta.

### Quién envía

**Solo el proceso que tiene `pg_try_advisory_lock(734921)` drena el outbox.** Hoy ese lock lo toma `src/worker.ts:15`; se conserva el número y no se añade otro. Consecuencias:

- La web solo inserta filas; el webhook inserta filas y, para las acciones permitidas, llama a `operation-runner` y `answerCallbackQuery`. Ninguno de los dos llama a `sendMessage` ni a `sendPush`: los mensajes los escribe el worker.
- No puede haber doble envío entre worker y web porque la web no tiene camino de envío.
- `/api/push/test` y `/api/notifications/test` dejan de llamar a `notify()` y encolan una fila; el worker la entrega. El test atraviesa el pipeline real.
- El worker comprueba que su conexión de lock sigue viva (`SELECT 1` sobre el cliente del lock). Si el lock se perdió por una conexión rota, el proceso sale en vez de seguir drenando sin ser el singleton.

### Reclamación y leases

```sql
UPDATE notifications n
SET status = 'sending',
    lease_until = now() + interval '60 seconds',
    attempts = attempts + 1
WHERE n.id = (
  SELECT c.id FROM notifications c
  WHERE c.status = 'pending'
    AND c.next_attempt_at <= now()
    AND (c.depends_on IS NULL OR EXISTS (
      SELECT 1 FROM notifications p
      WHERE p.id = c.depends_on
        AND p.status IN ('sent','suppressed')
    ))
  ORDER BY c.next_attempt_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

Al arrancar, `UPDATE notifications SET status='pending' WHERE status='sending' AND lease_until < now() AND kind <> 'digest'` recupera lo que dejó un crash. Las filas `kind='digest'` **no** se recuperan: se marcan `failed` con `last_error='crash_before_ack'` y no se reenvían (at-most-once). `SKIP LOCKED` es cinturón y tirantes: hoy hay un solo drenador, pero protege si algún día se añade un segundo proceso o si un worker pierde el lock sin darse cuenta.

`dependsOn` mantiene el orden `open → resolve`: una edición de resolución no puede reclamarse antes de que el mensaje original tenga `telegram_message_id`. Si el padre falla definitivamente, la edición dependiente se marca `suppressed` (no hay mensaje que editar).

### Telegram caído, 429 y errores permanentes

| Respuesta | Acción | Estado |
|---|---|---|
| 200 `ok:true` | Guardar `telegram_message_id`, `sentAt`, `status='sent'`; evento `delivery/sent` | `sent` |
| 429 con `parameters.retry_after` | `next_attempt_at = now + retry_after`; **no consume** el presupuesto de fallos; techo de 24 h | `pending` |
| 5xx, timeout, error de red | Backoff exponencial con jitter (30 s, 2 min, 10 min, 30 min, 2 h), máximo 6 intentos | `pending` → `failed` |
| 400 (HTML inválido, mensaje demasiado largo) | Reintentar una vez en texto plano; si vuelve a fallar, `failed` permanente; log con `error_code` | `failed` |
| 403 (bot bloqueado) / 404 (chat no encontrado) | `failed` permanente; no reintentar; visible en el hub | `failed` |
| `message is not modified` al editar | Tratar como `sent`; el estado ya es el correcto | `sent` |
| `message to edit not found` | `suppressed`; el hub conserva la incidencia | `suppressed` |

Un `critical` que agota reintentos de Telegram cae a **Web Push** (una sola vez) y se registra `channel='push'`, `reason='telegram_failed'` en `incident_events`. El ack es compartido: ackear en el hub o en Telegram resuelve la misma incidencia. Esto es la única excepción a "un canal primario por evento"; está justificada porque el fallback solo se activa cuando el primario falló, no en paralelo.

### Dedupe

Tres capas, de dentro hacia fuera:

1. **Máquina de estados:** una condición que sigue fallando no genera una transición nueva; una recuperación solo se emite si había una incidencia activa.
2. **`dedupe_key` único:** `incident:<id>:open:<seq>`, `incident:<id>:resolve:<seq>`, `incident:<id>:escalate:<seq>`, `digest:<YYYY-MM-DD>`, `test:<uuid>`. `seq` es `incidents.transitionSeq`, que se incrementa en la misma transacción; así una reapertura dentro del cooldown y una segunda resolución no colisionan con la primera. `INSERT ... ON CONFLICT DO NOTHING` antes de encolar.
3. **`telegram_updates.update_id`:** los reintentos del webhook no reprocesan un callback completo; uno que quedó con `processedAt` nulo se reprocesa y el `operations.id`/`used_at` evita repetir el efecto.

No se usa el `tag` de Web Push como dedupe de negocio: `tag` solo reemplaza la notificación en la bandeja del dispositivo. La identidad es la incidencia.

### At-least-once vs at-most-once

| Tipo | Garantía | Por qué |
|---|---|---|
| `critical` inmediato | At-least-once | Un fallo de red no puede perder el aviso; el `dedupe_key` evita duplicados normales y el replay es aceptable |
| Ediciones de estado | At-least-once idempotente | `editMessageText` con el mismo texto es inocuo; `message is not modified` se trata como éxito |
| Digest | At-most-once | Un digest duplicado es más molesto que uno perdido; si el proceso muere en `sending`, se marca `failed` y no se reenvía automáticamente; el hub lo muestra |

Telegram no ofrece claves de idempotencia en `sendMessage`; la ventana de duplicado existe y se acepta solo para `critical`. No se promete exactamente-una-vez.

### Interacción con el lock y la réplica única

- `734921` sigue siendo el lock del colector y ahora también del drenaje y del digest. No se crea `734923` para el digest: sería otro singleton que puede desincronizarse.
- La web no adquiere el lock. Si la web pudiera enviar, dos procesos podrían mandar el mismo `dedupe_key` a la vez; por eso no lo hace.
- El rate limit del webhook es en memoria y asume una réplica web, igual que `src/lib/auth.ts:67`. Escalar la web exigiría moverlo a PostgreSQL o a un almacén compartido; está fuera de alcance y se documenta como restricción.
- Un solo worker es una decisión, no una limitación accidental: el lock, el outbox y el digest dependen de ella.

---

## Digest scheduling

### Dónde y cuándo

En `worker.ts`, dentro del loop que ya existe, no en la web:

1. Cada tick (1 s) llama a `drainOutbox()`.
2. Cada 30 s llama a `maybeRunDigest(now)`; la comprobación es barata y no consulta la DB si el día ya está resuelto en memoria.
3. `maybeRunDigest` calcula la hora objetivo con `madridInstant(day, digestHour)` y comprueba:
   - `now >= target` y `now < target + 2 h` (ventana de catch-up).
   - `digest_runs` no tiene fila `sent`/`sending` para `day`.
4. Si toca, reclama el día con `INSERT ... ON CONFLICT (day) DO NOTHING RETURNING day` y un `UPDATE digest_runs SET status='sending' WHERE day=$1 AND status='pending' RETURNING *`. Solo el ganador construye el payload y encola `notifications(kind='digest', dedupeKey='digest:<day>')`.
5. El payload se renderiza una vez y se guarda; un reintento envía exactamente el mismo texto, no una versión recalculada.

Al arrancar, una fila `digest_runs` en `sending` (o `pending` de un proceso anterior) sin `sentAt` se marca `failed` con `error='crash_before_ack'` y **no se reenvía**: es la semántica at-most-once del digest. La recuperación genérica de leases del outbox excluye `kind='digest'` por la misma razón. El hub lo muestra como digest no entregado.

La hora por defecto es 08:00 `Europe/Madrid` y se guarda en `configuration` con `hostId='global'` e `id='notifications'` para poder cambiarla sin desplegar. Se añade un tipo `NotificationSettings` (`digestHour`, `quietHours`, `pushWarnings`, opt-out por categoría) leído de esa fila; no se mezcla con `Settings` (`src/lib/types.ts:134`), que es por host y contiene umbrales, no preferencias globales.

### DST y persistencia

No se usa `start + 8 h`: en el día de cambio de hora la jornada tiene 23 o 25 horas y las 08:00 locales no están a 8 horas del inicio. Se añade a `src/lib/madrid-day.ts`:

```ts
export function madridInstant(day: string, hour: number, minute = 0): Date {
  const [year, month, date] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  let instant = wall - zoneOffset(new Date(wall));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = wall - zoneOffset(new Date(instant));
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}
```

El día del digest es la fecha `Europe/Madrid`, no UTC. Un día de 25 horas sigue teniendo una sola clave `YYYY-MM-DD`; un día de 23 horas también. El chequeo usa instantes, no diferencias de reloj de pared, así que un salto de hora no produce dos ejecuciones.

Persistencia:

- `digest_runs.day` es la fuente de verdad; el `lastDigestDay` en memoria es solo una optimización.
- Si el worker estaba caído a las 08:00 y arranca a las 09:30, envía (dentro de la ventana de 2 h).
- Si arranca a las 12:00, marca `skipped` con `error='missed_window'`; no envía un resumen a medianoche. Las incidencias siguen visibles en el hub y las abiertas aparecerán en el digest siguiente.
- Si el operador cambia la hora después de que el digest ya se envió, `digest_runs` impide un segundo ese día.

### Un digest por día

Tres barreras:

1. `pg_try_advisory_lock(734921)`: solo un worker ejecuta el scheduler.
2. `digest_runs.day` como primary key y `INSERT ... ON CONFLICT DO NOTHING`: solo un intento reclama el día.
3. `notifications.dedupe_key='digest:<day>'` único: aunque se colara un segundo intento, no se encola dos veces.

Si el proceso muere en `sending`, al arrancar se ve la fila con `startedAt` y sin `sentAt`. Para el digest se elige **no reintentar** (at-most-once): se marca `failed`, se registra y el hub lo muestra. Para `critical` se elige lo contrario. La asimetría es deliberada.

### Contenido

- Solo `warning`/`info`; `critical` ya se entregó al momento y se cuenta en el pie ("3 críticas entregadas"). Los `warning` entregados por push (si `pushWarnings=true`) también se cuentan, no se repiten.
- Una tabla de máximo 10 filas + "+N"; columnas: host, categoría, título, estado, desde.
- Incidencias abiertas de días anteriores: una línea agregada, no una fila por incidencia.
- Botón "Ver todo" con deep link `/?view=alerts&digest=<day>`.
- Si no hay contenido, **no se envía nada**. No hay mensaje "todo bien".
- Texto máximo 4096; el renderer trunca por filas y añade "+N" antes de partir una línea.

---

## Web Push

### Decisión

Web Push se queda, pero **no como está**. Hoy `notify()` (`src/lib/push.ts:6`) hace broadcast a todas las suscripciones y el collector lo llama en cada apertura y cada recuperación (`src/lib/collector.ts:53`, `:66`). Eso es exactamente la política que se quiere eliminar.

La política única decide el canal; `push.ts` pasa a ser un adaptador:

| Severidad | Canal primario | Fallback | Digest |
|---|---|---|---|
| `critical` | Telegram inmediato | Push tras agotar reintentos de Telegram (una vez) | No; se cuenta en el pie |
| `warning` | Digest; si `pushWarnings=true`, push inmediato **en lugar** del digest | — | Sí, salvo que `pushWarnings` lo mueva a push |
| `info` | Digest | No | Sí |
| `test` | El que elija el operador en el test | — | No |

`pushWarnings` cambia el canal primario de los `warning`; no los envía por los dos. El digest no repite lo ya entregado por push: lo cuenta en el pie.

Así el móvil sigue recibiendo avisos: Telegram es la notificación de phone por defecto y push cubre el caso en que Telegram falle o el operador prefiera la PWA. No se pierde la función existente; se elimina el broadcast sin política. Si `TELEGRAM_ENABLED=0`, push pasa a ser el canal primario de `critical` y el digest se desactiva (no hay canal para él); el hub sigue mostrando las incidencias.

### Qué cambia en `push.ts` y `sw.js`

- `src/lib/push.ts`: `sendPush(payload): Promise<{ sent: number; pruned: number; failed: number }>`; lee `subscriptions`, envía con `TTL: 3600`, poda 404/410 y devuelve el resultado. No decide nada.
- `public/sw.js`: respeta `data.url` y `data.tag` en lugar de hardcodear `/?view=alerts`; `notificationclick` navega al deep link de la incidencia. Para una resolución, el mismo `tag` reemplaza la notificación en la bandeja con `silent: true`, sin un mensaje nuevo.
- `subscriptions` no cambia. El endpoint `/api/push` sigue validando el host del endpoint y la sesión.
- El test `POST /api/push/test` se sustituye por `POST /api/notifications/test`, que encola y atraviesa política, render y entrega.

---

## Data Flow

### Flujo completo

```text
agent /metrics, /maintenance, /deployments
        │  (GET, solo el hub inicia)
        ▼
worker.ts · collector.collectHost
        │  señales puras (signals.ts + maintenance-alerts.ts)
        ▼
incidents.apply ──────────────── transacción PostgreSQL
        ├── incidents            (fingerprint, status, severity)
        ├── incident_events      (opened / escalated)
        └── notifications        (outbox, dedupe_key)
                │
                ▼
        outbox.drain (solo worker con 734921)
                ├── policy.ts ──► push.ts (fallback / opt-in)
                └── render.ts + telegram.sendMessage
                        │
                        ▼
                   Telegram (móvil)
                        │ callback_query
                        ▼
        POST /api/telegram/webhook
                ├── secret_token + update_id + allowlist
                ├── ack/snooze ──► incidents + incident_events ──► outbox edit
                ├── open ────────► (url button; no llega callback)
                ├── start ───────► operation-runner (sin passkey)
                └── destructiva
                        ├── passkey ≤ 5 min ──► operation-runner
                        └── sin passkey ──────► telegram_action_intents
                                                        │
                                                        ▼
                                              hub UI: sesión + passkey
                                                        │
                                                        ▼
                                              operation-runner
                                                        │
                                                        ├── operations (pending → success/failed)
                                                        └── agent /action o /command
                                                        │
                                                        ▼
                                              incident_events + operations (auditoría)
                                                        │
                                                        ▼
                                              outbox editMessageText (resultado)
```

### Ingest de `media-stack` y fallback

```text
media-backup.sh / security-monitor / upgrade.sh
        │
        ├── POST /api/notifications/ingest   (HMAC, 5 min, eventId)
        │        │
        │        ├── 202 ──► el script no envía nada
        │        │            hub: incident (mismo fingerprint) + outbox
        │        └── error/5xx/timeout
        │                 ├── backup: Telegram directo (último recurso)
        │                 └── security/upgrade: no envían; el snapshot reconcilia
        │
        └── el snapshot del agente sigue siendo la reconciliación:
            si el evento se perdió, la siguiente lectura de /maintenance
            o /deployments abre la misma incidencia por fingerprint
```

El evento sirve para latencia; el snapshot sirve para reconciliar. Ambos comparten `hostId:key`, así que no se duplican. El ingest es idempotente por `ingest_events.id = source:eventId`: un reintento del script no abre una segunda incidencia. El fallback directo de Telegram es exclusivo de la copia fallida: es la única familia irreversible que no puede esperar a que vuelva el hub.

### State management

- **PostgreSQL:** todo el estado durable: incidencias, timeline, outbox, operaciones, tokens, digest, suscripciones. No hay Redis ni cola externa.
- **Worker:** memoria solo para el último tick, el pacing de Telegram (1 msg/s por chat) y la optimización del día de digest. Se pierde al reiniciar y no importa.
- **Web:** memoria solo para el rate limit del webhook y el rate limit de auth. La autorización real está en la DB y en la sesión.
- **Agente:** cachés con TTL de `maintenance` (60 s) y `deployments` (30 s); el hub no las escribe.
- **Cliente:** el estado de la UI sigue viviendo en React y la URL; el fragmento de la intent se borra en cuanto se lee.
- **Retención:** `incidents` resueltas > 30 días, `notifications` `sent`/`failed` > 30 días, `telegram_updates` > 7 días, `ingest_events` > 30 días, `digest_runs` > 90 días. Las incidencias abiertas, `sending` y `pending` no se borran nunca por antigüedad; requieren intervención o reconciliación.
- **Heartbeat:** el worker escribe `configuration(hostId='global', id='worker')` con `lastTickAt` en cada tick; `GET /api/health` lo lee y lo expone junto al estado del webhook (`getWebhookInfo`). Si el heartbeat envejece, el hub lo muestra y el operador sabe que las notificaciones están retenidas, no perdidas.

---

## Recommended Project Structure

```text
src/
├── app/api/
│   ├── [...path]/route.ts              # frontera browser (una sola)
│   ├── telegram/webhook/route.ts       # Telegram → hub (secret_token)
│   └── notifications/ingest/route.ts   # media-stack → hub (HMAC)
├── lib/
│   ├── incidents.ts                    # máquina de estados + consultas
│   ├── operation-runner.ts             # runner único de operaciones
│   ├── push.ts                         # adaptador Web Push (sin política)
│   ├── madrid-day.ts                   # + madridInstant(day, hour)
│   ├── notifications/
│   │   ├── signals.ts                  # Metrics/Snapshots → IncidentSignal[]
│   │   ├── policy.ts                   # (category, severity) → canal + momento
│   │   ├── render.ts                   # HTML, teclados, 4096/64 bytes
│   │   ├── outbox.ts                   # enqueue/claim/mark + leases
│   │   ├── dispatcher.ts               # drenaje del worker
│   │   ├── telegram.ts                 # Bot API client
│   │   ├── telegram-webhook.ts         # updates: allowlist, tokens, dispatch
│   │   ├── telegram-tokens.ts          # tokens de botón + intents
│   │   ├── digest.ts                   # due, build, claim, mark
│   │   └── ingest.ts                   # HMAC + evento → señal
│   └── ...
├── worker.ts                           # collect + drain + digest + cleanup
└── ...
scripts/telegram-webhook.ts             # setWebhook / deleteWebhook manual
tests/notifications/                    # unit + integración con fake Telegram
```

### Structure Rationale

- **`src/lib/notifications/`:** el subsistema tiene estado, transporte, render y política; meterlo plano en `src/lib` añadiría ocho archivos más a un directorio que ya mezcla 40 dominios. Es la única subcarpeta nueva y agrupa lo que se testea junto.
- **`src/lib/incidents.ts` fuera de `notifications/`:** la incidencia es dominio del hub (la UI, la API y el collector la usan), no un detalle del canal.
- **`operation-runner.ts` en la raíz:** no es notificación; es la pieza que comparten la web, el handoff de Telegram y los comandos de host.
- **Dos rutas no-browser:** hacen explícita la excepción. El catch-all sigue siendo la única frontera del navegador y no hay que meter ramas de autenticación máquina-a-máquina antes del origin guard, donde un futuro cambio podría saltárselas.
- **`telegram-webhook.ts` separado de la ruta:** la lógica es testeable sin HTTP y el transporte (webhook o long polling) es reemplazable.

---

## Architectural Patterns

### Pattern 1: Transactional outbox

**What:** la transición de estado y la intención de notificar se escriben en la misma transacción; el envío ocurre después, desde una tabla.
**When to use:** siempre que un efecto externo (Telegram, push) deba corresponder a un cambio durable.
**Trade-offs:** introduce latencia (el worker drena cada segundo), una tabla más y la necesidad de leases; a cambio elimina la pérdida por crash y el doble envío.

**Example:**

```ts
const [incident] = await db.transaction(async (tx) => {
  const [created] = await tx.insert(incidents).values({
    hostId: signal.hostId,
    key: signal.key,
    fingerprint: `${signal.hostId}:${signal.key}`,
    category: signal.category,
    severity: signal.severity,
    status: "open",
    transitionSeq: 1,
    title: signal.title,
    detail: signal.detail,
  }).returning();
  await tx.insert(incidentEvents).values({
    incidentId: created.id,
    kind: "opened",
    actor: "system",
  });
  await tx.insert(notifications).values({
    kind: "incident_open",
    incidentId: created.id,
    channel: "telegram",
    dedupeKey: `incident:${created.id}:open:${created.transitionSeq}`,
    payload: { title: signal.title, body: signal.detail, incidentId: created.id },
  }).onConflictDoNothing();
  return [created];
});
```

### Pattern 2: State machine with a partial unique index

**What:** una sola fila activa por `fingerprint`, garantizada por PostgreSQL, no por un lock de aplicación.
**When to use:** condiciones que podem oscilar y que no deben abrir dos incidencias a la vez.
**Trade-offs:** el índice parcial no cubre las resueltas (correcto: el historial se conserva); el upsert debe declarar el predicado o usar una transacción con `SELECT ... FOR UPDATE`.

**Example:**

```sql
CREATE UNIQUE INDEX incidents_active_fingerprint_idx
ON incidents (fingerprint)
WHERE status IN ('pending', 'open', 'acknowledged', 'snoozed');
```

### Pattern 3: Ports and adapters for channels

**What:** `policy.ts` decide `{ channel, when }`; `telegram.ts` y `push.ts` solo transportan. Añadir un canal no toca la máquina de estados.
**When to use:** más de un canal o sospecha de que habrá más.
**Trade-offs:** una indirección más; el render es específico del canal y no se puede fingir que es genérico.

### Pattern 4: Capability token + intent

**What:** el botón lleva un id opaco; el servidor lo resuelve a una capacidad concreta, con TTL y un solo uso. Para acciones de host, la capacidad es una intent que el hub ejecuta tras passkey.
**When to use:** cualquier acción que llegue por un canal no autenticado (Telegram, email, webhook).
**Trade-offs:** una tabla y limpieza; a cambio, `callback_data` deja de ser un contrato de acción y se puede revocar.

### Pattern 5: Two machine-to-machine boundaries with their own auth

**What:** webhook (secret header) e ingest (HMAC) viven fuera del catch-all; el catch-all sigue exigiendo Origin y sesión.
**When to use:** integraciones servidor-a-servidor que no pueden presentar una cookie.
**Trade-offs:** dos archivos de ruta y dos verificaciones que mantener; evita relajar el guard del navegador.

---

## Build Order

Cada fase es desplegable y reversible. Lo que debe existir antes se indica en la columna derecha.

| Fase | Entrega | Debe existir antes | Por qué |
|---|---|---|---|
| 0 | Auditoría de mensajes reales (emisor, clave, hora, recuperación/incidencia) | — | Decide el corte de política y el volumen; no bloquea el código, pero sí los umbrales |
| 1 | Migración: `incidents` (rename + columnas + índice), `incident_events`, `notifications`, `telegram_updates`, tokens, intents, `digest_runs`, `ingest_events` | Fase 0 para validar el mapa de claves | Sin tablas no hay escritor ni outbox |
| 2 | `signals.ts` + `incidents.apply` en modo `shadow`; el collector escribe incidencias y outbox, pero **no** drena; el push legado sigue enviando | Fase 1 | Permite comparar decisiones nuevas contra el comportamiento actual sin riesgo |
| 3 | `outbox.ts` + `dispatcher.ts` + `telegram.ts`; el worker drena; se activa solo `connection` y luego el resto de `critical`; `notify()` deja de usarse para lo migrado | Fase 2 | El primer envío real necesita outbox y adapter |
| 4 | Digest: `madridInstant`, `digest.ts`, `digest_runs`, render y botón "Ver todo" | Fase 3 (usa el mismo outbox) | El digest no puede ser otro `notify()` |
| 5 | Webhook + tokens + ack/snooze + `url` buttons de apertura; `scripts/telegram-webhook.ts`; rate limit y allowlist | Fase 3 (necesita el mensaje con botones) | El botón nace del mensaje ya enviado |
| 6 | `operation-runner.ts` + `requireRecentVerificationForUser` + extender `guardSensitiveAction` a todas las destructivas + `telegram/intents/execute` + handoff; `TELEGRAM_DIRECT_ACTIONS` empieza en 0 | Fase 5 y la verificación existente | La ejecución directa solo se activa cuando el segundo factor está probado |
| 7 | `media-stack`: ingest HMAC; fallback directo solo para copia; apagar emisores directos familia por familia; WUD al final | Fase 3 y una ventana de observación | Cambio en otro repo, con commits y CI propios |
| 8 | Retirada del `notify()` legado, limpieza de tablas, documentación y rotación de secretos | Fases 3–7 | Cierra la deuda y deja una sola política |

`NOTIFICATIONS_MODE=legacy|shadow|incidents` permite las fases 2–3 sin big bang. `TELEGRAM_ENABLED=0` deja el hub funcionando con push y sin bot si falta configuración.

---

## Failure Modes

| Fallo | Comportamiento esperado | Dónde se ve |
|---|---|---|
| Agente inalcanzable | `connection` se abre a los 60 s; no se evalúan snapshots; no se resuelven hijos por ausencia | Incidencia abierta en el hub; mensaje con botón "Abrir" |
| Snapshot `degraded` | Las señales de esa sección no se emiten; las incidencias existentes no se resuelven ni se actualizan | `degraded` visible en la vista de mantenimiento |
| Webhook con secreto inválido | 401, sin parsear el cuerpo, sin escribir `telegram_updates` | Log con `update_id` ausente; alerta de seguridad si se repite |
| Update duplicado | Si `processedAt` no es nulo, 200 sin reprocesar; si quedó a medias, se reprocesa de forma idempotente | `telegram_updates.outcome` |
| Token de botón expirado/usado | `answerCallbackQuery("Este botón ya no es válido")`; no muta | Sin cambio de estado |
| Acción destructiva sin passkey reciente | No se ejecuta; se crea una intent y se ofrece "Verificar en el hub"; si no se verifica, expira | Intento `expired`; mensaje con el botón |
| `answerCallbackQuery` falla o llega tarde | Se registra y se continúa; el cambio de estado ya está en la DB | `incident_events`; el mensaje se edita igualmente |
| Ejecución directa excede el presupuesto | La operación queda `pending` como en la UI; no se reintenta sola | `operations.status='pending'` |
| Telegram 429 | Reintento según `retry_after`; no se pierde la fila | `notifications.status='pending'`, `attempts` |
| Telegram 403/404 | `failed` permanente; `critical` cae a push | Estado de entrega en la incidencia |
| Worker caído | El outbox se acumula; no hay envíos; el heartbeat envejece | `/api/health` o cabecera del hub; digest catch-up |
| PostgreSQL caído | 503 en la web; el ingest falla y `media-stack` usa el fallback de copia | Logs; el estado se reconcilia al volver |
| Digest perdido por crash en `sending` | Se marca `failed`; no se reenvía; el hub lo muestra | `digest_runs.status='failed'` |
| Edición de mensaje imposible | `suppressed`; la incidencia sigue en el hub | `incident_events` con motivo |

---

## Scaling Considerations

| Escala | Ajustes |
|---|---|
| 1 operador, 2 hosts, ~30 contenedores | Diseño actual: un worker, un outbox, un chat. El cuello no son las notificaciones |
| 2–5 hosts, ~100 contenedores | La agrupación por host y la inhibición por `connection` dejan de ser opcionales; índices por `(hostId, status)` y `(status, nextAttemptAt)`; digest con límite de filas |
| 10+ hosts, ~300 contenedores | Particionar `samples` por tiempo (ya pendiente en `PROJECT.md`); lotes de outbox; presupuesto de mensajes por hora; el digest resume por host, no por incidencia |
| Más de una réplica web | **Fuera de alcance.** Exigiría mover el rate limit y la dedupe del webhook a PostgreSQL y revisar el lock; el diseño es de escritor único |

### Scaling Priorities

1. **Primer cuello:** la consulta de histórico de `/api/overview` (30 días de `samples`), no el outbox. Los rollups y la caché ya están en `PROJECT.md`; el subsistema de notificaciones no los empeora.
2. **Segundo cuello:** el límite de Telegram (4096 caracteres y ~1 msg/s por chat). Se resuelve con digest y agrupación, no con más workers.
3. **Tercer cuello:** el crecimiento del outbox si el worker está caído mucho tiempo. Retención de `sent` a 30 días y alerta de heartbeat; no se guarda para siempre.

---

## Anti-Patterns

### Anti-Pattern 1: Dos notificadores con dos políticas

**What people do:** el hub manda push y `media-stack` manda Telegram; cada uno decide severidad y dedup.
**Why it's wrong:** duplica avisos, las políticas divergen y no hay un sitio único para silenciar o auditar. Es el estado actual y la causa principal del ruido.
**Do this instead:** el hub decide y envía; `media-stack` publica eventos firmados y solo conserva el fallback de copia cuando el ingest falla.

### Anti-Pattern 2: Llamar a `notify()` desde una ruta HTTP

**What people do:** `/api/push/test` o una acción llama a `notify()` directamente.
**Why it's wrong:** el envío ocurre fuera de la transacción, la web puede duplicar lo que hace el worker y un crash después del commit pierde el aviso.
**Do this instead:** encolar en `notifications` y dejar que el worker drene. El test también pasa por el pipeline.

### Anti-Pattern 3: Dedup y debounce en memoria

**What people do:** un `Map` de `started` o de mensajes enviados en el proceso.
**Why it's wrong:** se pierde al reiniciar, no funciona con dos procesos y no explica por qué no se envió.
**Do this instead:** `incidents.status` + `firstSeenAt` para el debounce; `dedupe_key` único para el envío; `incident_events` para la explicación.

### Anti-Pattern 4: Un mensaje de recuperación por incidencia

**What people do:** al resolver, `notify("Recuperado: …")`.
**Why it's wrong:** duplica el volumen y, con flapping, genera un bucle recuperación/reapertura.
**Do this instead:** editar el mensaje original a "Resuelta" y, en push, reemplazar la notificación con el mismo `tag` y `silent: true`. Nunca un mensaje nuevo.

### Anti-Pattern 5: Ejecutar acciones de host en el webhook sin un segundo factor

**What people do:** el callback llama a `nasForHost` porque el usuario está en el chat del operador.
**Why it's wrong:** el chat no es una credencial; el webhook no tiene sesión; un callback repetido o un móvil comprometido puede parar un servicio.
**Do this instead:** ejecución directa solo para `start` o para destructivas con un passkey del operador de los últimos 5 minutos; en cualquier otro caso, handoff al hub con sesión + passkey y `operations` idempotente. `TELEGRAM_DIRECT_ACTIONS=0` elimina la excepción.

### Anti-Pattern 6: Un mensaje por contenedor

**What people do:** `expectedContainers` genera `container:<name>` y un aviso por cada uno.
**Why it's wrong:** una caída de host con 15 contenedores produce 15 incidencias y 15 mensajes; la causa es una.
**Do this instead:** `container:<name>` silencioso por defecto, agrupado en `services-down:<host>` e inhibido por `connection`.

### Anti-Pattern 7: Reintentar para siempre un 400 o un 403

**What people do:** el outbox reintenta cualquier error.
**Why it's wrong:** un HTML mal formado o un bot bloqueado nunca se arreglan solos; el outbox se llena y el operador no lo ve.
**Do this instead:** 400/403/404 son `failed` permanente y visibles; solo 429/5xx/red se reintentan con backoff.

### Anti-Pattern 8: Añadir Redis o una cola externa "por si acaso"

**What people do:** meter BullMQ/Redis para el outbox.
**Why it's wrong:** rompe la regla PostgreSQL-only, añade un servicio que puede caerse y duplica la fuente de verdad.
**Do this instead:** la tabla `notifications` con `FOR UPDATE SKIP LOCKED` es la cola; el lock 734921 es el único consumidor.

### Anti-Pattern 9: Un lock nuevo para el digest

**What people do:** `pg_try_advisory_lock(734923)` para el scheduler del digest.
**Why it's wrong:** dos singletons pueden desincronizarse; un worker puede tener el lock del digest y otro el del colector.
**Do this instead:** el mismo worker y el mismo lock; el digest es una fase del loop.

---

## Integration Points

### External Services

| Servicio | Patrón de integración | Notas |
|---|---|---|
| Telegram Bot API | Webhook HTTPS con `secret_token`; `sendMessage`, `editMessageText`, `answerCallbackQuery` | 4096 caracteres; `callback_data` ≤ 64 bytes; 429 con `retry_after`; nunca loguear el token |
| Web Push | `web-push` con VAPID; suscripciones en PostgreSQL | Poda 404/410; `tag` por incidencia; `data.url` respetado por el service worker |
| GitHub | Ya existente para Renovate (`src/lib/github.ts`) | El botón de merge usa el mismo `mergeRenovatePullRequest` y la misma verificación |
| PostgreSQL | `pg` Pool + Drizzle; outbox y locks | Único estado durable; sin Redis; `SKIP LOCKED` para el outbox |

### Internal Boundaries

| Boundary | Comunicación | Notas |
|---|---|---|
| app ↔ worker | PostgreSQL (tablas), no HTTP | La web encola; el worker drena bajo lock; no hay RPC |
| worker ↔ agent | HTTP GET/POST con Bearer | También el webhook para acciones permitidas; solo el hub inicia, el agente no empuja |
| hub ↔ `media-stack` | `POST /api/notifications/ingest` (HMAC) y fallback Telegram de copia | El hub no lee ficheros de `media-stack`; lo hace el agente |
| Telegram ↔ hub | Webhook `POST /api/telegram/webhook` | Segunda frontera no-browser; allowlist y token |
| hub ↔ push service | HTTPS saliente | Adaptador sin política; el worker es el único emisor |
| UI ↔ API | `fetch` same-origin con sesión | El intent de Telegram se ejecuta por la misma frontera browser |

### `media-stack`: qué se lee y qué requiere cambio

**Se lee sin cambiar `media-stack`** (a través del agente, que ya lo hace):

- `maintenance.backup.lastStatus` — `agent/maintenance.py:245`, desde `APPDATA_ROOT/backup/last-status`.
- `maintenance.disks`, `failedUnits`, `reboot`, `units` — el snapshot existente.
- `maintenance.security.review` — `agent/maintenance.py:163`, desde `security-monitor/comparisons/*.json`; incluye CVEs corregidas, versión y fecha.
- `deployments.follower`, `retained`, `blocker`, `history`, `journal` — `agent/deployments.py`.
- `deployments.settings` (lectura) y las acciones fijas de `hostCommandIds` (`src/lib/host-command-contract.ts:4`).

**Requiere cambio en `media-stack`** (fase 7, repo y CI propios):

- `stacks/backup/media-backup.sh`: publicar `backup-failed` al ingest antes del `sendMessage`; enviar directo solo si el ingest falla. El `eventId` debe ser estable y derivado del hecho (p. ej. `backup:<last-status.at>`), no un UUID nuevo por reintento.
- `stacks/monitoring/security-monitor/main.py`: publicar `security-review` verificado; silencio si no hay hallazgos; si el ingest falla, no envía directo (el hub reconcilia desde el snapshot).
- `scripts/upgrade.sh`: publicar el resultado del upgrade desatendido y dejar de enviar directo; el hub ya tiene el snapshot, pero el evento reduce la latencia.
- `stacks/monitoring/compose.yaml`: apagar `WUD_TRIGGER_TELEGRAM_*` cuando el hub lea su store; hasta entonces se queda como excepción contada.
- Añadir `HUB_INGEST_URL` y `HUB_INGEST_SECRET` al `.env`; el secreto se rota con el resto.

**No se propone:**

- Que el hub lea `media-stack` por SSH, por ficheros montados o por su base de datos. El agente es la única capa de lectura.
- Que el hub escriba estado de `media-stack` fuera de `/action`, `/command` y `/deployments/settings`, que ya existen y tienen listas cerradas.
- Un servidor webhook o una cola en `media-stack`; sus scripts son de un solo uso y deben seguir siéndolo.
- Un token de Telegram distinto por emisor; el mismo bot puede enviar el fallback de copia y recibir el webhook. Lo que se separa es la **decisión**, no el bot.

---

## Sources

Leídas para este documento:

- `.planning/PROJECT.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`, `.planning/research/FEATURES.md`
- `src/lib/collector.ts`, `src/lib/push.ts`, `src/lib/schema.ts`, `src/worker.ts`
- `src/app/api/[...path]/route.ts` (origin, sesión, `/api/action`, `/api/push`)
- `src/lib/verification.ts`, `src/lib/verification-api.ts`, `src/lib/host-commands.ts`, `src/lib/lifecycle.ts`
- `src/lib/maintenance-alerts.ts`, `src/lib/events.ts`, `src/lib/madrid-day.ts`, `src/lib/types.ts`
- `agent/maintenance.py`, `agent/deployments.py`, `agent/maintenance_actions.py`, `agent/host_commands.py`
- `media-stack`: `stacks/backup/media-backup.sh`, `stacks/monitoring/security-monitor/main.py`, `stacks/monitoring/compose.yaml`, `scripts/upgrade.sh`
- `public/sw.js`, `src/components/views/alerts.tsx`, `src/components/views/summary.tsx`

Referencias externas (semántica, no copiadas):

- Telegram Bot API — webhooks y `secret_token`, `callback_query`, `answerCallbackQuery`, `editMessageText`, límites y `retry_after`: <https://core.telegram.org/bots/api>
- PostgreSQL — `FOR UPDATE SKIP LOCKED`, índices únicos parciales: <https://www.postgresql.org/docs/current/sql-select.html>, <https://www.postgresql.org/docs/current/indexes-unique.html>
- Prometheus Alertmanager — fingerprint, inhibición y silencios (semántica adoptada): <https://prometheus.io/docs/alerting/latest/alertmanager/>
- Web Push — `web-push` y VAPID: <https://github.com/web-push-libs/web-push>

---

*Architecture research for: subsistema de notificaciones e incidencias de hub.*
*Researched: 2026-11-24*
