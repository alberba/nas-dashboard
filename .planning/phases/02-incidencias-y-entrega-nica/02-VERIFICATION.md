---
phase: 02-incidencias-y-entrega-nica
verified: 2026-11-25T11:42:31Z
status: passed
score: 22/22 must-haves verified
covered_files: [".env.example", ".planning/phases/02-incidencias-y-entrega-nica/02-01-PLAN.md", ".planning/phases/02-incidencias-y-entrega-nica/02-01-SUMMARY.md", ".planning/phases/02-incidencias-y-entrega-nica/02-02-PLAN.md", ".planning/phases/02-incidencias-y-entrega-nica/02-02-SUMMARY.md", ".planning/phases/02-incidencias-y-entrega-nica/02-03-PLAN.md", ".planning/phases/02-incidencias-y-entrega-nica/02-03-SUMMARY.md", ".planning/phases/02-incidencias-y-entrega-nica/02-04-PLAN.md", ".planning/phases/02-incidencias-y-entrega-nica/02-04-SUMMARY.md", ".planning/phases/02-incidencias-y-entrega-nica/02-05-PLAN.md", ".planning/phases/02-incidencias-y-entrega-nica/02-05-SUMMARY.md", "README.md", "drizzle/0004_incidents.sql", "drizzle/meta/0004_snapshot.json", "drizzle/meta/_journal.json", "package.json", "pnpm-lock.yaml", "public/sw.js", "scripts/check-runtime-config.ts", "scripts/rollback/0004_incidents.sql", "src/app/api/[...path]/route.ts", "src/app/globals.css", "src/app/page.tsx", "src/components/dashboard.tsx", "src/components/login.tsx", "src/components/settings.tsx", "src/components/views/alerts.tsx", "src/components/views/routes.ts", "src/lib/agent-snapshots.ts", "src/lib/collector.ts", "src/lib/incident-push.ts", "src/lib/incident-store.ts", "src/lib/lifecycle.ts", "src/lib/maintenance-alerts.ts", "src/lib/nas.ts", "src/lib/notification-dispatch.ts", "src/lib/notification-policy.ts", "src/lib/push.ts", "src/lib/runtime-config.ts", "src/lib/schema.ts", "src/lib/telegram.ts", "src/lib/types.ts", "src/worker.ts", "tests/agent-client.test.ts", "tests/api-events.test.ts", "tests/api-hosts.test.ts", "tests/api-incidents.test.ts", "tests/api-lifecycle.test.ts", "tests/collector-alerts.test.ts", "tests/database.ts", "tests/e2e/incidents.spec.ts", "tests/host-fixtures.ts", "tests/incident-push.test.ts", "tests/incident-store.test.ts", "tests/maintenance-alerts.test.ts", "tests/migrations.test.ts", "tests/notification-dispatch.test.ts", "tests/runtime-config.test.ts", "tests/service-worker.test.ts", "tests/telegram.test.ts"]
covered_digest: "v4:sha256:443c1c4ed5da6b4625da529f08b95760decefe3ab8c00156f0c1aeb0637c63fb"
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "El recuento en el resumen diario de los cierres que no tienen un mensaje editable"
    addressed_in: "Phase 4"
    evidence: "DIG-03 exige el contador de resueltas en el resumen diario; la fase 2 conserva el cierre y no envía un mensaje nuevo, que es su parte del contrato."
---

# Phase 2: Incidencias y entrega única — Verification Report

**Phase Goal:** Convertir cada condición vigilada en una incidencia con identidad y entregar exactamente un mensaje por incidencia, con outbox transaccional y estado de entrega visible.
**Verified:** 2026-11-25T11:42:31Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Roadmap Success Criteria

Las cinco criterios de `ROADMAP.md` se verificaron contra código y pruebas, no contra los SUMMARY. Se mapean a las verdades de los planes que los desarrollan; el recuento de la tabla de verdades no los duplica.

| # | Criterio de éxito | Estado | Evidencia | Verdades |
|---|---|---|---|---|
| 1 | Una incidencia por condición con identidad estable que sobrevive al reinicio y una abierta no genera un segundo mensaje | ✓ VERIFIED | `drizzle/0004_incidents.sql:7-55`; `src/lib/incident-store.ts:255-421`; tests `incident-store.test.ts#opens once…`, `#confirms a single opening…`, `collector-alerts.test.ts#reuses the open episode when the collector module is recreated` | T1, T2, T3, T12, T21 |
| 2 | Al resolverse se edita el original (o se cuenta en el resumen) y la severidad se refleja en ese mismo mensaje | ✓ VERIFIED | `src/lib/incident-store.ts:111-246`; `src/lib/notification-dispatch.ts:322-376, 743-841`; tests `notification-dispatch.test.ts#edits the original…`, `#queues the final edit…`; `collector-alerts.test.ts#escalates disk-health…` | T8, T15, T16, T18 |
| 3 | Un fallo entre decisión y envío no pierde el aviso, el reintento no duplica, 429 espera `retry_after` y 400/403/404 quedan fallidos visibles | ✓ VERIFIED | `src/lib/notification-dispatch.ts:134-188, 378-428, 434-585`; `src/lib/telegram.ts:142-254`; tests `#rolls back the episode…`, `#honours retry_after across a restart…`, `#fails permanently on 400, 403 and 404…` | T3, T13, T14, T16 |
| 4 | El operador ve el estado de entrega (enviado, fallido, suprimido y motivo) y llega a la vista desde el botón del mensaje | ✓ VERIFIED | `src/lib/incident-store.ts:452-551`; `src/components/views/alerts.tsx:13-67, 160-180`; `src/lib/telegram.ts:265-287`; `tests/e2e/incidents.spec.ts` (3/3) | T18, T19, T22 |
| 5 | Hub y worker no se declaran sanos con credenciales de ejemplo o configuración ausente, y un payload inválido no abre ni resuelve incidencias | ✓ VERIFIED | `scripts/check-runtime-config.ts`; `src/worker.ts:60-66`; `src/lib/runtime-config.ts:92-225, 397-431`; `src/lib/collector.ts:142-145`; tests `runtime-config.test.ts#fails pnpm start…`, `#stops before the database…`, `collector-alerts.test.ts#ignores an invalid maintenance payload…` | T6, T7, T10, T11 |

### Observable Truths

Verdades fusionadas de los cinco `PLAN.md` (las que repetían un criterio de ROADMAP se conservan una sola vez, con el criterio arriba). Todas tienen evidencia de código y prueba.

| # | Verdad (must-have) | Estado | Evidencia |
|---|---|---|---|
| T1 | Tras migrar, cada host y clave identifica a lo sumo un episodio abierto; ID y cierres preexistentes sobreviven y el fingerprint sobrevive al reinicio, al cierre y a otro episodio | ✓ VERIFIED | `drizzle/0004_incidents.sql:7-55` renombra tabla/secuencia, rellena fingerprint y crea el índice parcial; `src/lib/incident-store.ts:70-74` replica el md5; `tests/migrations.test.ts:188` comprueba ids, cierres, empates y unicidad; `tests/incident-store.test.ts:48` comprueba fingerprint igual entre episodios y `collector-alerts.test.ts:512` el reinicio del módulo |
| T2 | D-03: las incidencias abiertas heredadas no producen envíos iniciales al migrar, arrancar o revalidar; un episodio nuevo tras un cierre válido sigue la política normal | ✓ VERIFIED | `0004_incidents.sql:33-35` marca `origin='legacy'` sin outbox; `incident-store.ts:295-298, 330-338` suprimen cualquier aviso heredado; `tests/migrations.test.ts:188` no ve outbox ni eventos de backfill; `tests/incident-store.test.ts:244` recorre revalidación, escalada y cierre |
| T3 | Si se aborta la escritura del aviso, tampoco persisten la incidencia ni su evento; si se confirma, el aviso elegible sigue registrado tras reiniciar | ✓ VERIFIED | `src/lib/incident-store.ts:261-421` escribe episodio, evento y outbox en una transacción; `tests/incident-store.test.ts:185` fuerza el choque de clave del outbox y comprueba rollback total, y después la apertura correcta |
| T4 | La reversa ensayada con PostgreSQL 18 repone los cierres sintéticos y permite reaplicar 0004 sin repetir ni perder IDs | ✓ VERIFIED | `scripts/rollback/0004_incidents.sql:19-78` valida el journal, restaura solo `migration-dedup` y elimina columnas/tablas; `tests/migrations.test.ts:391` ensaya 0003→0004→reversa→0004; `:549` rechaza un journal incompatible |
| T5 | La eliminación confirmada de un contenedor cierra solo la incidencia de ese nombre en el host elegido, con el mismo seq, evento y decisión de outbox que el collector | ✓ VERIFIED | `src/lib/lifecycle.ts:71-76` delega en el store con `closedBy:'lifecycle'`; `src/app/api/[...path]/route.ts:540-581` hace lo mismo tras un stop confirmado; `tests/api-lifecycle.test.ts:…` y `tests/api-incidents.test.ts:599` comprueban host aislado, evento `closed` seq 2 y edición encolada |
| T6 | Una muestra válida se decodifica, se guarda y confirma su condición; un 200 con cuerpo inválido no crea muestras ni abre/cambia/resuelve incidencias, incluida `connection`; un fallo real de transporte mantiene la desconexión y la gracia del reinicio | ✓ VERIFIED | `src/lib/agent-snapshots.ts:409-419` selecciona el esquema Zod; `src/lib/nas.ts:84-93` devuelve `NasInvalidResponse`; `src/lib/collector.ts:137-173` no escribe muestra ni toca episodios ante un 200 ilegible; tests `collector-alerts.test.ts:537, 619, 631` y `agent-client.test.ts` |
| T7 | Una sección degradada, una medida nula o una lista que representa ausencia dejan intacta su condición; otra lectura válida e independiente sigue aportando evidencia | ✓ VERIFIED | `src/lib/maintenance-alerts.ts:54-89` solo emite señales de secciones legibles y no convierte `unknown` en salud; `src/lib/collector.ts:198-250` omite null/listas vacías; tests `collector-alerts.test.ts:580, 827, 858, 880, 924, 961` y `maintenance-alerts.test.ts:…` |
| T8 | D-04: `disk-health` pasa de watch a fail en el mismo episodio; si esperaba el resumen sin aviso remoto queda elegible para su primer Telegram inmediato; si ya tenía canal comprometido lo conserva y refleja la severidad | ✓ VERIFIED | `src/lib/notification-policy.ts:83-102`; `src/lib/incident-store.ts:160-246` reescribe la apertura pendiente o encola edición; tests `collector-alerts.test.ts:663, 712, 748` y `maintenance-alerts.test.ts:…` |
| T9 | La app valida después de cargar el mismo entorno que Next en producción, con precedencia proceso > `.env.production.local` > `.env.local` > `.env.production` > `.env` | ✓ VERIFIED | `scripts/check-runtime-config.ts:11-29` fuerza producción y usa `loadEnvConfig`; tests `runtime-config.test.ts:590-653` cubren cada precedencia y el valor de mayor prioridad inválido |
| T10 | El arranque de app y worker termina antes de quedar operativo ante configuración obligatoria ausente, inválida o de ejemplo; `pnpm build` sigue generando la app | ✓ VERIFIED | `package.json` encadena el preflight en `start`; `src/worker.ts:60-66` valida antes de `pool.connect`; tests `runtime-config.test.ts:697` (falla antes de Next), `:740-781` (cero conexiones a la base); `pnpm build` reejecutado en esta verificación: exit 0 |
| T11 | El entorno permite desactivar Telegram omitiendo el grupo y rechaza grupos de Telegram o VAPID parciales; los fallos identifican la variable sin revelar su valor | ✓ VERIFIED | `src/lib/runtime-config.ts:290-394, 397-431`; `RuntimeConfigError` solo emite `variable (motivo)`; tests `runtime-config.test.ts:409-580` y `:573, 661` comprueban que no aparecen secretos |
| T12 | El worker que posee el lock 734921 entrega la apertura elegible al chat configurado y registra chat y `message_id`; un competidor o token de lease obsoleto no puede iniciar otro envío | ✓ VERIFIED | `src/lib/notification-dispatch.ts:70-100, 191-257, 519-585`; `src/lib/telegram.ts:247-253` persiste la confirmación; tests `notification-dispatch.test.ts:194, 249`; dos conexiones reales compiten por el lock |
| T13 | D-01: un lease vencido antes del inicio se recupera; una confirmación perdida tras el inicio deja la apertura incierta visible, sin reenvío ni push de respaldo | ✓ VERIFIED | `notification-dispatch.ts:134-188, 487-517`; tests `notification-dispatch.test.ts:398, 432, 644` |
| T14 | D-02: un 429 no se reintenta antes de `retry_after`, incluso al reiniciar; 400/403/404 quedan visibles y pueden activar un único push de respaldo para una crítica | ✓ VERIFIED | `src/lib/telegram.ts:192-229`; `notification-dispatch.ts:378-428, 434-485`; tests `notification-dispatch.test.ts:523, 583` y `telegram.test.ts#treats 400, 403 and 404…` |
| T15 | D-05: si Web Push aceptó la apertura, el worker conserva el canal y no hace otro envío al cambiar la severidad; la etiqueta y la revisión por episodio quedan en el payload | ✓ VERIFIED | `notification-dispatch.ts:910-961, 843-866`; `src/lib/push.ts:92-160`; tests `notification-dispatch.test.ts:928` y `#persists the fallback result separately…` |
| T16 | D-06: resolver o cambiar la severidad de una incidencia entregada por Telegram edita chat y mensaje confirmados en orden de seq; sin mensaje para editar se conserva el cierre para el resumen, sin otro `sendMessage` | ✓ VERIFIED | `incident-store.ts:111-152, 160-246`; `notification-dispatch.ts:322-376, 743-841`; tests `notification-dispatch.test.ts:688, 791, 837, 870` y `incident-store.test.ts:342` |
| T17 | El resultado inicial, el fallback y el último intento de edición se conservan por separado; la prueba push del worker usa solo las suscripciones de `ownerUserId` | ✓ VERIFIED | `incident-store.ts:498-551` proyecta `delivery`, `fallback` y `lastUpdate`; `notification-dispatch.ts:868-908`; `src/lib/push.ts:99-104`; tests `notification-dispatch.test.ts:992, 1078` |
| T18 | La vista de Avisos muestra el resultado inicial y su motivo, incluido el incierto y el fallback, incluso si más tarde falla una edición | ✓ VERIFIED | `src/components/views/alerts.tsx:41-67, 160-180`; `src/lib/incident-store.ts:452-551`; `tests/api-incidents.test.ts:395`; `tests/e2e/incidents.spec.ts:100` afirma `sent`, fallback `failed` y última edición `uncertain` |
| T19 | El enlace abre el episodio del host tras correo, passkey o sesión vigente, aunque esté fuera de los 100 recientes; una sesión expirada regresa al mismo episodio | ✓ VERIFIED | `src/app/page.tsx`; `src/components/views/routes.ts:30-100`; `src/components/login.tsx`; `src/components/dashboard.tsx:300-355`; `tests/api-incidents.test.ts:296-349`; `tests/e2e/incidents.spec.ts:100, 133, 172` (3/3 passed) |
| T20 | D-05: con el hub visible y el aviso todavía en la bandeja se reemplaza con la misma etiqueta sin renotificar; descartado o sin API, el cambio queda solo en el hub | ✓ VERIFIED | `src/lib/incident-push.ts:87-154` (`getNotifications`, `silent:true`, `renotify:false`); tests `incident-push.test.ts:49, 82, 129, 141`; comportamiento físico de la bandeja queda en verificación humana |
| T21 | Una parada de contenedor confirmada cierra solo la incidencia del host y la clave elegidos, actualizando seq, timeline y outbox mediante el store | ✓ VERIFIED | `src/app/api/[...path]/route.ts:540-581`; `tests/api-incidents.test.ts:599, 669` (stop rechazado/incierto no cierra ninguna) |
| T22 | La prueba manual de push encola para el propietario autenticado de las suscripciones y muestra que quedó en cola | ✓ VERIFIED | `src/app/api/[...path]/route.ts:703-715` deriva `ownerUserId` de la sesión y responde 202; `src/components/settings.tsx:220-231`; test `api-incidents.test.ts:709`; captura de UI revisó el estado «en cola» |

**Score:** 22/22 truths verified (0 present, behavior-unverified)

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|---|---|---|
| 1 | El recuento en el resumen diario de los cierres que no tienen mensaje editable | Phase 4 | `ROADMAP.md` Phase 4, DIG-03: el resumen incluye el contador de resueltas. La fase 2 ya conserva el cierre y no envía un mensaje nuevo. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `drizzle/0004_incidents.sql` | Migración ascendente con backfill silencioso, timeline y outbox | ✓ VERIFIED | 98 líneas; renombra sin recrear, deduplica con marca reversible, crea índice parcial, `incident_events` y `notification_outbox`; alineado con snapshot/journal (`migrations.test.ts:339`) |
| `scripts/rollback/0004_incidents.sql` | Reversa revisada fuera del directorio del migrador | ✓ VERIFIED | Transaccional, guarda de journal, restaura solo cierres sintéticos, conserva ids; ensayada |
| `src/lib/incident-store.ts` | Transición de episodio, evento y outbox en una transacción | ✓ VERIFIED | 579 líneas; usado por collector, lifecycle, API y proyección; sin stubs |
| `src/lib/agent-snapshots.ts` | Decodificadores Zod de métricas, mantenimiento y despliegues | ✓ VERIFIED | 420 líneas; `agentSnapshotSchema` conectado desde `nas.ts` |
| `src/lib/notification-policy.ts` | Política de severidad y entrega | ✓ VERIFIED | Catálogo auditado y `PUSH_WARNINGS`; usado por el collector |
| `src/lib/runtime-config.ts` | Validación compartida de configuración y canales | ✓ VERIFIED | App (preflight) y worker; diagnóstico finito |
| `scripts/check-runtime-config.ts` | Preflight de app con resolución de entorno Next | ✓ VERIFIED | Encadenado en `pnpm start` |
| `src/lib/notification-dispatch.ts` | Reclamación, envío y resultado de cada trabajo | ✓ VERIFIED | 1007 líneas; lock, lease, reintento, edición, push y retención |
| `src/lib/telegram.ts` | Cliente saliente de apertura y edición | ✓ VERIFIED | Origen fijo, sin redirects ni `parse_mode`, texto acotado y respuesta validada |
| `src/components/views/alerts.tsx` | Estado de entrega y detalle de la incidencia enlazada | ✓ VERIFIED | Proyecta estado/motivo inicial, fallback y última edición |
| `src/lib/incident-push.ts` | Actualización local y condicional del push | ✓ VERIFIED | Superficie inyectable, sin contacto con el proveedor |
| `tests/e2e/incidents.spec.ts` | Enlaces bajo sesión ausente o expirada, correo y passkey | ✓ VERIFIED | 3/3 passed en esta verificación |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/lib/collector.ts` | `src/lib/incident-store.ts` | `recordIncidentObservation` por host y clave | ✓ WIRED | `collector.ts:71, 82`; todas las condiciones pasan por el store |
| `src/lib/lifecycle.ts` | `src/lib/incident-store.ts` | Cierre por `container:key` tras eliminación confirmada | ✓ WIRED | `lifecycle.ts:71-76`; probado en `api-lifecycle.test.ts` |
| `src/lib/incident-store.ts` | `src/lib/schema.ts` | Transacción con `incidents`, `incidentEvents`, `notificationOutbox` | ✓ WIRED | `incident-store.ts:261-420`; claves únicas en `schema.ts` |
| `drizzle/meta/_journal.json` | `drizzle/0004_incidents.sql` | Entrada aplicada por `scripts/migrate.ts` | ✓ WIRED | `migrations.test.ts:339` compara journal y snapshot |
| `src/lib/nas.ts` | `src/lib/agent-snapshots.ts` | Decodificación por método/pathname antes del límite Promise | ✓ WIRED | `nas.ts:84-93`; `agent-snapshots.ts:409-419` |
| `package.json` | `scripts/check-runtime-config.ts` | `start` valida antes de `next start` | ✓ WIRED | `package.json` script `start`; test `runtime-config.test.ts:697` |
| `src/worker.ts` | `src/lib/runtime-config.ts` | Validación antes del lock | ✓ WIRED | `worker.ts:60-66`; tests de cero conexiones |
| `src/worker.ts` | `src/lib/notification-dispatch.ts` | Loop bajo el lock de sesión | ✓ WIRED | `worker.ts:47-60` (drain), `notification-dispatch.ts:967-1007` |
| `src/lib/notification-dispatch.ts` | `src/lib/telegram.ts` | `sendMessage`, `editMessageText` y resultados clasificados | ✓ WIRED | `notification-dispatch.ts:545, 801` |
| `src/lib/notification-dispatch.ts` | `src/lib/push.ts` | Envío inicial, fallback y prueba por propietario | ✓ WIRED | `notification-dispatch.ts:939`; `push.ts:92` |
| `src/components/dashboard.tsx` | `src/app/api/[...path]/route.ts` | Lectura autenticada por host e ID | ✓ WIRED | `dashboard.tsx:324`; `route.ts:224-266`; e2e |
| `src/app/api/[...path]/route.ts` | `src/lib/incident-store.ts` | Cierre transaccional tras parada confirmada | ✓ WIRED | `route.ts:564-575`; `api-incidents.test.ts:599` |
| `src/components/login.tsx` | `src/components/views/routes.ts` | Destino interno conservado al autenticar | ✓ WIRED | `page.tsx` reconstruye; `login.tsx` aplica `next`; e2e 01/02/03 |
| `src/components/dashboard.tsx` | `src/lib/incident-push.ts` | Refresco visible con revisión vigente | ✓ WIRED | `dashboard.tsx:151-175`; `incident-push.test.ts` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| Avisos (`alerts.tsx`) | `alert.delivery`, `fallback`, `lastUpdate` | `projectIncidents` → `notification_outbox` | Sí; e2e siembra outbox real y la UI muestra `sent`/`failed`/`uncertain` | ✓ FLOWING |
| Detalle de incidencia | `result.incident` | `GET /api/incidents/:id` → `incidents` por `(id,hostId)` | Sí; e2e abre un episodio fuera de los 100 recientes | ✓ FLOWING |
| Mensaje Telegram | `incident.title/detail/severity` | `loadIncident` antes de cada envío (DB) | Sí; pruebas con transporte inyectado verifican el texto y el botón | ✓ FLOWING |
| Ajustes → prueba push | `queued`/`jobId` | `INSERT notification_outbox` con `ownerUserId` de sesión | Sí; 202 y trabajo durable que el worker reclama | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Suite completa | `HUB_REQUIRE_TEST_DB=1 pnpm test` | 41 archivos / 429 pruebas pasadas | ✓ PASS |
| Typecheck | `pnpm typecheck` | exit 0 | ✓ PASS |
| Build de producción | `pnpm build` | exit 0; Next 16.4.6 | ✓ PASS |
| E2E de incidencias | `pnpm exec playwright test tests/e2e/incidents.spec.ts` | 3/3 pasadas (email, passkey, sesión expirada) | ✓ PASS |
| Migración/reversa | incluida en la suite (`tests/migrations.test.ts`) | 5/5 pasadas contra PostgreSQL 18.7 | ✓ PASS |
| Proyección de reintento 429 | `incident-store.test.ts:472` | fila `pending` con último `failed` se publica `pending`/`null` | ✓ PASS |

### Probe Execution

La fase no declara sondas `probe-*.sh` y no existen en `scripts/`. No aplica.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| INCD-01 | 02-01 | Identidad estable por host y clave que sobrevive a reinicios | ✓ SATISFIED | Migración + fingerprint + índice parcial; `incident-store.test.ts:48`, `collector-alerts.test.ts:512` |
| INCD-02 | 02-01, 02-04 | Una incidencia abierta no genera un segundo mensaje mientras su estado no cambie | ✓ SATISFIED | `incident-store.ts:307-315` devuelve `observed` sin outbox; `notification-dispatch.test.ts:194, 249` |
| INCD-03 | 02-04 | Una incidencia resuelta no envía mensaje nuevo: edita el original o se cuenta en el resumen | ✓ SATISFIED | `closeEpisode` suprime/edita, nunca crea apertura; `notification-dispatch.test.ts:688, 791, 837`; recuento diferido a fase 4 |
| INCD-04 | 02-02, 02-04, 02-05 | La severidad se recalcula y el cambio se refleja en incidencia y mensaje | ✓ SATISFIED | `changeSeverity`; D-04 y D-05; `collector-alerts.test.ts:663, 712, 748`, `notification-dispatch.test.ts:928` |
| INCD-05 | 02-01, 02-04 | Todo envío pasa por outbox transaccional; un fallo entre decisión y envío no pierde el aviso | ✓ SATISFIED | `recordIncidentObservation` transaccional; rollback probado; despacho durable |
| INCD-06 | 02-04 | Solo el worker con el lock envía y un reintento no duplica | ✓ SATISFIED | `holdsCollectionLock` antes de reclamar y de cada request; `notification-dispatch.test.ts:249`; no hay envíos desde rutas web |
| INCD-07 | 02-04 | 429 respeta `retry_after`; 400/403/404 fallidos permanentes y visibles | ✓ SATISFIED | `telegram.ts:192-229`; `notification-dispatch.test.ts:523, 583`; proyección `failed`/`permanent_rejection` |
| INCD-08 | 02-05 | El operador ve el estado de entrega y llega a la vista desde el botón | ✓ SATISFIED | `alerts.tsx`; proyección finita; `incidents.spec.ts`; botón `inline_keyboard` en `telegram.ts:265-287` |
| BOT-01 | 02-04 | El operador recibe los avisos en el chat configurado desde el bot del hub | ✓ SATISFIED (automatizado con transporte inyectado) | `sendTelegramMessage` usa `telegram.chatId`; `notification-dispatch.test.ts:194`; recepción real en verificación humana |
| BOT-03 | 02-04, 02-05 | Cada mensaje incluye un botón que abre la vista autenticada | ✓ SATISFIED | `incidentHref` + `buttons`; e2e de enlace profundo; `telegram.test.ts#sends plain text with a URL button…` |
| SEC-03 | 02-03 | El arranque rechaza credenciales de ejemplo y configuración obligatoria ausente; el contenedor no se declara sano | ✓ SATISFIED | Preflight en `pnpm start`, worker antes de la base; `runtime-config.test.ts:697, 740-781`; el proceso termina, por lo que no sirve healthcheck |
| CONT-01 | 02-02 | Métricas, mantenimiento y despliegues validados en runtime; un payload inválido no resuelve incidencias | ✓ SATISFIED | Zod por pathname; `collector.ts:142-145`; `collector-alerts.test.ts:537, 827, 858, 880` |

**Cobertura:** 12/12 requirement IDs de la fase satisfechos. Sin IDs huérfanos: `REQUIREMENTS.md` asigna exactamente estos 12 a la fase 2.

### Previously Fixed Review Findings (WR-01…WR-04)

| Finding | Fix real | Prueba |
|---|---|---|
| WR-01 · un reintento 429 pendiente se publicaba como fallo permanente | `publicState` prioriza el estado persistido `pending`/`claimed` antes del último `result` (`incident-store.ts:452-463`) | `incident-store.test.ts:472` proyecta `pending` con `result.failed/rate_limited` |
| WR-02 · una confirmación de envío que compite con cierre/cambio podía perder la última edición | `recordTelegramSent` bloquea la fila de la incidencia con `FOR UPDATE` y encola la edición del `seq` vigente (`notification-dispatch.ts:329-374`) | `notification-dispatch.test.ts:296` reproduce la intercalación con dos conexiones, verifica la espera de lock y exactamente 1 edición |
| WR-03 · 429/5xx de push se registraban como fallo permanente | `transientStatus` 408/425/429/5xx → `uncertain` (`push.ts:76-82, 144-150`) | `notification-dispatch.test.ts:1041` (429 y 500 inciertos, 400 fallido) |
| WR-04 · los temporizadores sostenidos seguían contando a través de huecos de datos | `forgetHost`/`forget` limpian CPU, discos, temperaturas y snapshots inválidos sin tocar el episodio (`collector.ts:32-43, 142-145, 198-250`) | `collector-alerts.test.ts:1022, 1054, 1087` reinician la ventana y no abren hasta que la evidencia vuelve a ser contigua |

IN-01 (wrapper `notify` eliminado), IN-02 (`push_disabled` finito) e IN-03 (id acotado a `integer`) también están corregidos y probados. IN-04 queda diferido de forma explícita en la disposición; no bloquea la fase.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| — | — | Ningún `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` en los archivos de la fase | — | Sin deuda no auditables |
| `src/lib/incident-store.ts`, `src/lib/notification-dispatch.ts`, `src/lib/incident-push.ts` | 56-62 / 103-113 / 20-25 | Claves y etiquetas de protocolo duplicadas (IN-04) | ℹ️ Info | Riesgo de desincronización futura; diferido por la disposición, sin impacto en el objetivo actual |

La revisión de UI dejó avisos no bloqueantes (F1, severidad en inglés dentro del texto de Telegram; F2, «Sin envío» en heredados sin explicación; F13–F16). No afectan a ningún must-have ni a los criterios de éxito y no convierten la fase en `gaps_found`; quedan como pulido posterior.

### Human Verification Required

#### 1. Telegram real: una apertura, una escalada y un cierre

**Test:** Configurar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` reales en el worker, provocar una apertura, una escalada de severidad y un cierre. Pulsar el botón del mensaje.
**Expected:** Llega exactamente un mensaje por incidencia abierta; la escalada y el cierre editan ese mismo mensaje (sin un segundo `sendMessage`); el botón abre la vista de Avisos autenticada del episodio correcto.
**Why human:** El repositorio no tiene credenciales reales ni contacta `api.telegram.org`; el transporte se prueba con `fetch` inyectado.

#### 2. Bandeja de la PWA en iOS

**Test:** Con el hub visible y un aviso push todavía en la bandeja, escalar la incidencia. Repetir tras descartar el aviso. Probar también con la API de notificaciones no disponible.
**Expected:** El aviso presente se reemplaza con la misma etiqueta sin volver a notificar; si se descartó o la API no está disponible no reaparece y el cambio solo se ve en el hub.
**Why human:** `getNotifications`/`showNotification` reales dependen del sistema operativo; la lógica se prueba con una superficie inyectada.

#### 3. Migración y reversa sobre la base de producción

**Test:** Seguir `README.md`: parar app y worker, copia restaurable, recuentos de preflight antes/después de 0004, `pnpm db:migrate`, comprobar identidad de incidencias abiertas y ejecutar la reversa con archivo previo de `notification_outbox` e `incident_events`.
**Expected:** IDs y cierres se conservan, no se crea trabajo de notificación para heredados, la reversa restaura los duplicados sintéticos y el re-avance no repite ni pierde IDs. Con configuración de ejemplo o ausente el contenedor no queda `healthy`.
**Why human:** Exige servicios reales, copia y una base de producción; el ensayo sintético sí está automatizado.

#### 4. Ajustes distingue «en cola» de «entregado»

**Test:** Abrir Ajustes, lanzar la prueba push y comprobar el mensaje y el estado del hub.
**Expected:** La interfaz dice que la prueba quedó en cola (no que se entregó) y el estado de entrega del hub refleja el resultado real.
**Why human:** Es copy/experiencia de interfaz; el estándar prohíbe acoplar pruebas al texto y la captura existente no sustituye la comprobación del operador.

### Gaps Summary

No se encontró ningún must-have ausente, stub, huérfano ni enlace roto. Las cinco criterios de éxito de ROADMAP están cubiertos por código y pruebas que se reejecutaron en esta verificación: 41 archivos / 429 pruebas, typecheck, build y los 3 E2E de incidencias en verde. Los cuatro hallazgos de revisión (WR-01…WR-04) tienen corrección real y prueba de comportamiento. El estado es `human_needed` únicamente por las comprobaciones físicas y de despliegue que no pueden ejecutarse aquí (Telegram real, bandeja iOS, migración/reversa de producción y copy de Ajustes), no por funcionalidad faltante.

---

_Verified: 2026-11-25T11:42:31Z_
_Verifier: the agent (gsd-verifier)_
