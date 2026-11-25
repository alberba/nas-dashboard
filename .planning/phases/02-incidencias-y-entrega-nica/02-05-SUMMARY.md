---
phase: 02-incidencias-y-entrega-nica
plan: "05"
subsystem: incidents
tags:
  - incidents
  - web-push
  - outbox
  - authenticated-navigation
  - playwright
  - postgresql

requires:
  - phase: 02-incidencias-y-entrega-nica
    plan: "01"
    provides: "Episodios incidents, eventos y notification_outbox con seq y revisión"
  - phase: 02-incidencias-y-entrega-nica
    plan: "02"
    provides: "Política auditada y escalada D-04 con canales y motivos persistidos"
  - phase: 02-incidencias-y-entrega-nica
    plan: "04"
    provides: "Etiqueta hub:incident:<host>:<id>, entrypoint push-test y resultados por canal"

provides:
  - "GET /api/incidents/:id?host= autenticado, por pareja exacta y sin depender de los 100 recientes"
  - "Proyección pública común para overview y detalle con entrega inicial, fallback y última edición separadas"
  - "Cierre de una parada confirmada mediante el store, limitado al host y a container:<nombre>"
  - "Destino interno reconstruido con routeHref/readRoute tras correo, passkey y expiración de sesión"
  - "updatePresentIncidentNotification: reemplazo local con la misma etiqueta, silent y sin renotify"
  - "POST /api/push/test encolado en notification_outbox con ownerUserId de la sesión"
  - "Ajustes distingue la aceptación en cola de la entrega efectiva"

affects: [03, 04, 05]

actuals:
  tokens: 17442
  tasks: 2
  commits: 2
  plan_head_before: b9e684d3ae296cb78828f6d3678692835929b88c
  plan_head_after: 1eb638038cc92172e156d3a0796b04c7405fab0a

tech-stack:
  added: []
  patterns:
    - "Proyección pública finita: state + channel + un motivo de un conjunto cerrado, sin cuerpos ni destinos"
    - "Consulta puntual por (id, hostId) para episodios fuera de los 100 recientes; 404 sin fallback entre hosts"
    - "Cierre de episodio siempre a través de recordIncidentObservation, también desde la acción de stop"
    - "Destino de login reconstruido desde readRoute/routeHref, nunca desde una URL arbitraria"
    - "Reemplazo local de notificación con getNotifications({ tag }) + showNotification silencioso"
    - "La prueba push crea trabajo durable; el worker sigue siendo el único que contacta al proveedor"

key-files:
  created:
    - src/lib/incident-push.ts
    - tests/api-incidents.test.ts
    - tests/incident-push.test.ts
    - tests/e2e/incidents.spec.ts
  modified:
    - src/app/api/[...path]/route.ts
    - src/app/page.tsx
    - src/components/login.tsx
    - src/components/dashboard.tsx
    - src/components/settings.tsx
    - src/components/views/alerts.tsx
    - src/lib/incident-store.ts
    - src/lib/types.ts

key-decisions:
  - "El detalle exige host explícito y consulta por (id, hostId); un id de otro host devuelve 404, nunca el episodio ajeno"
  - "Overview y detalle comparten projectIncidents, de modo que alerts/openAlerts conservan su nombre y la entrega no se duplica"
  - "Los motivos públicos se limitan a legacy_open, digest_pending, policy_silent, telegram_disabled, permanent_rejection y uncertain"
  - "Una parada confirmada cierra en el store con closedBy lifecycle; un rechazo o un resultado incierto no toca ninguna incidencia"
  - "El login recibe un destino ya reconstruido en el servidor y el dashboard rehace la ruta conocida al recibir un 401"
  - "La actualización push no envía un push de fondo: solo reemplaza un aviso leído como presente y con revisión anterior"
  - "La prueba push se acepta como trabajo en cola (202) con el propietario de la sesión; la entrega queda para el worker"

patterns-established:
  - "Etiqueta estable por episodio en cliente, service worker y worker: hub:incident:<host>:<id>"
  - "data-delivery-part/state/reason y data-incident/selected para aserciones de comportamiento sin acoplarse al copy"
  - "Un fallo de bandeja nunca revierte el estado del hub; el cambio ya está persistido"

requirements-completed: [INCD-04, INCD-08, BOT-03]

coverage:
  - id: D1
    description: "El enlace abre el episodio histórico tras correo o passkey y vuelve al mismo episodio tras una sesión expirada"
    requirement: BOT-03
    verification:
      - kind: e2e
        ref: "tests/e2e/incidents.spec.ts#INC-E2E-01 opens an episode older than the 100 recent through email login"
        status: pass
      - kind: e2e
        ref: "tests/e2e/incidents.spec.ts#INC-E2E-02 keeps the episode link after signing in with a passkey"
        status: pass
      - kind: e2e
        ref: "tests/e2e/incidents.spec.ts#INC-E2E-03 returns to the same episode after a session expiry"
        status: pass
    human_judgment: false
  - id: D2
    description: "Overview y detalle publican estado y motivo finitos, con fallback y última actualización separadas y sin datos del transporte"
    requirement: INCD-08
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#projects finite delivery states and reasons for overview and detail"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#finds an episode older than the 100 recent ones"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#resolves the exact host and id pair without a cross-host fallback"
        status: pass
    human_judgment: false
  - id: D3
    description: "Una parada de contenedor confirmada cierra solo la incidencia del host y clave elegidos con seq, evento y outbox coherentes"
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#closes only the selected host's incident through the store after a confirmed stop"
        status: pass
      - kind: integration
        ref: "tests/api-incidents.test.ts#keeps both incidents open when the stop is rejected or uncertain"
        status: pass
    human_judgment: false
  - id: D4
    description: "Un aviso push presente y con revisión anterior se reemplaza en silencio; ausente, actual o sin API no se vuelve a presentar"
    requirement: INCD-04
    verification:
      - kind: unit
        ref: "tests/incident-push.test.ts#replaces a present older revision with the same tag without renotifying"
        status: pass
      - kind: unit
        ref: "tests/incident-push.test.ts#does not present a notification when none is still in the tray"
        status: pass
      - kind: unit
        ref: "tests/incident-push.test.ts#does not touch the API when the page is not visible"
        status: pass
    human_judgment: true
    rationale: "La lógica de bandeja está probada con una superficie inyectada; el reemplazo silencioso real en la PWA de iOS y el intervalo entre lectura y reemplazo solo se observan en un dispositivo físico."
  - id: D5
    description: "La prueba push encola un trabajo push-test para el propietario de la sesión sin contactar al proveedor"
    requirement: BOT-03
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#queues the push test for the session owner without contacting a provider"
        status: pass
      - kind: unit
        ref: "tests/incident-push.test.ts#never contacts the push provider"
        status: pass
    human_judgment: false
  - id: D6
    description: "Ajustes distingue que la prueba quedó en cola de la entrega efectiva"
    verification: []
    human_judgment: true
    rationale: "La distinción es de copy y no tiene test de interfaz; se comprueba visualmente en la PWA durante la prueba manual pendiente."

duration: 16min
completed: 2026-11-25
status: complete
---

# Phase 02 Plan 05: Enlace autenticado a la incidencia y refresco local del push

**Apertura autenticada de un episodio histórico por correo, passkey o sesión expirada, proyección pública de su entrega y reemplazo silencioso de la notificación presente sin un push de fondo.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-11-25T10:30:06Z
- **Completed:** 2026-11-25T10:45:37Z
- **Tasks:** 2
- **Files modified:** 12 (4 creados, 8 modificados)

## Accomplishments

- `GET /api/incidents/:id?host=` exige sesión, host explícito e id entero positivo seguro y resuelve exactamente la pareja `(id, hostId)`. Un host desconocido, un id ausente o una pareja discrepante devuelven 404 sin cargar el episodio de otro host.
- Overview y detalle comparten `projectIncidents`: conservan `alerts` y `openAlerts`, añaden `seq` y publican `delivery`, `fallback` y `lastUpdate` con estados pendiente/enviado/fallido/suprimido/incierto y los seis motivos finitos acordados.
- La rama de stop confirmado de `POST /api/action` ya no escribe `resolvedAt` directamente: cierra con `recordIncidentObservation` y `closedBy: "lifecycle"` solo el host y `container:<nombre>` elegidos, conservando `expectedContainers` y el contrato de la operación.
- `src/app/page.tsx` lee `searchParams` con la forma asíncrona de Next 16, reconstruye el destino con `readRoute`/`routeHref` y lo entrega a `Login`; correo y passkey lo usan en `router.replace`. El dashboard hace lo mismo al recibir el 401 real de un refresco.
- Avisos incluye el episodio solicitado aunque esté fuera de los 100 recientes, lo enfoca con `tabIndex=-1` y muestra la ausencia sin cambiar el host del enlace.
- `updatePresentIncidentNotification` consulta `getNotifications({ tag })`, exige una revisión anterior y reemplaza con la misma etiqueta, `silent: true` y `renotify: false`. Si falta, fue descartada, la API no está disponible, la página no es visible o la revisión ya es la vigente, no llama a `showNotification` y no envía ningún push.
- `POST /api/push/test` inserta un trabajo `push-test` con `ownerUserId` de la sesión y responde 202 con `queued: true`; no importa el propietario enviado por el cuerpo y no contacta al proveedor. Ajustes explica que la prueba está en cola.

## Task Commits

Cada tarea se confirmó de forma atómica:

1. **Task 1: Abrir desde su enlace una incidencia histórica y leer su estado de entrega** — `03976c9` (feat)
2. **Task 2: Actualizar el push visible en silencio y conservar la prueba en Ajustes** — `1eb6380` (feat)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: la tarea 2 llevaba `tdd="true"`. El encargo exige un único commit atómico por tarea, así que los casos de comportamiento se ejecutaron contra la implementación en ese mismo commit, sin un commit RED separado._

## Files Created/Modified

- `src/lib/incident-push.ts` — lectura por etiqueta, decisión de revisión y reemplazo silencioso, con superficie inyectable.
- `src/app/api/[...path]/route.ts` — consulta puntual autenticada, proyección compartida, cierre por store y prueba push en cola.
- `src/lib/incident-store.ts` — `projectIncidents` y mapeo de estados/motivos finitos.
- `src/lib/types.ts` — tipos públicos de entrega y campos `seq`, `delivery`, `fallback`, `lastUpdate` en `Alert`.
- `src/app/page.tsx` — `searchParams` asíncrono y destino interno reconstruido.
- `src/components/login.tsx` — destino recibido y aplicado en correo y passkey.
- `src/components/dashboard.tsx` — detalle puntual, 401 con ruta preservada y refresco de notificaciones presentes.
- `src/components/views/alerts.tsx` — detalle enlazado, foco, ausencia y estados de entrega con atributos `data-*`.
- `src/components/settings.tsx` — mensaje de prueba en cola.
- `tests/api-incidents.test.ts` — 7 casos de sesión, host, histórico, proyección, cierre, rechazo/incertidumbre y push en cola.
- `tests/incident-push.test.ts` — 10 casos de bandeja, revisión, visibilidad, API ausente y ausencia de red.
- `tests/e2e/incidents.spec.ts` — INC-E2E-01/02/03 con correo, passkey virtual y expiración real de sesión.

## Decisions Made

- El host es obligatorio en el detalle: ausencia de `host` devuelve 404 en vez de caer al primario, porque el enlace siempre lo incluye y un fallback ocultaría un enlace mal formado.
- `projectIncidents` vive en el store para que overview y detalle no puedan divergir; `fallbackResult` del trabajo inicial es la fuente del respaldo push y la última fila `incident-edit` la de la última actualización.
- Los motivos desconocidos se pliegan a un valor finito (`policy_silent`, `permanent_rejection` o `uncertain`) en lugar de propagar el motivo bruto.
- El refresco local solo comprueba una revisión cuando el `seq` cambió desde la última comprobación del montaje, para no lanzar una consulta de bandeja por cada aviso en cada sondeo de 5 s.
- La prueba push responde 202 porque la aceptación es del trabajo durable, no de la entrega remota; Ajustes separa ambos conceptos en el texto.

## Deviations from Plan

### Procesos ajustados al encargo

- La tarea 2 llevaba `tdd="true"`; el encargo exige un único commit atómico por tarea, así que no hay commit RED separado. Los tests de comportamiento se ejecutaron contra la implementación y son la puerta de la tarea.
- No se actualizaron `ROADMAP.md` ni `STATE.md`; el orquestador es su único escritor tras la ola, según el encargo.
- `pnpm lint` completo falla únicamente por los directorios de entorno no versionados (`.agents/`, `.opencode/`, etc.). El lint acotado a los archivos del plan y el lint de todos los archivos versionados terminan con exit 0.
- No se usaron credenciales reales de Telegram ni VAPID. La bandeja y el chat reales siguen siendo prueba manual de despliegue.

**Total deviations:** 0 auto-fixed de código y 2 ajustes de proceso.
**Impact on plan:** Ninguno sobre el alcance. Los dos commits cubren exactamente las dos tareas del plan.

## Evidence · PostgreSQL 18, Vitest and Playwright Chromium

| Command | Result |
|---|---|
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts` (Task 1) | 6 tests passed |
| `pnpm build` (Task 1 verify) | exit 0; Next.js 16.4.6 |
| `pnpm exec playwright test tests/e2e/incidents.spec.ts` (Task 1 verify) | 3 tests passed |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-push.test.ts tests/api-incidents.test.ts` (Task 2 verify) | 2 files, 17 tests passed |
| `pnpm typecheck` | exit 0 |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` | 40 files, 417 tests passed |
| Lint of all tracked source files | exit 0 |
| `pnpm exec playwright test tests/e2e/incidents.spec.ts` (final, after task 2) | 3 tests passed |
| `pnpm build` (final) | exit 0 |

La suite de API usa PostgreSQL 18 real. El detalle histórico se sirve con 105 incidencias más recientes en la base; overview devuelve 100 y la consulta puntual sigue encontrando la incidencia antigua. La parada confirmada se ejecuta contra un agente HTTP local y comprueba la fila, el evento y el outbox de ambos hosts. Los E2E usan una base dedicada, siembran el episodio y su outbox y no contactan servicios externos.

## Threat Model Evidence

- **T-02-09 (Elevation of Privilege):** el detalle exige sesión, host explícito y pareja exacta; el destino de login se reconstruye con los helpers de ruta y el propietario del trabajo push se deriva de la sesión, no del cuerpo. Un test comprueba que un `ownerUserId` distinto en el cuerpo no cambia el propietario.
- **T-02-11 (Information Disclosure):** la proyección solo publica canal, estado y motivos finitos. Los tests serializan overview y detalle y comprueban que no aparecen `chatId`, `messageId`, `api.telegram.org`, `endpoint` ni `token`.

## Browser and Delivery Limits

- Chromium sin interfaz valida URL, foco, estructura y el 401 real del refresco, pero no puede observar la bandeja del sistema operativo. La prueba de reemplazo silencioso con un aviso presente y otro descartado queda para una PWA física.
- No hay VAPID ni suscripción push real en este entorno; `getNotifications` puede no estar disponible y el código lo trata como `unsupported` sin presentar ni enviar nada.
- La prueba manual pendiente incluye un bot/chat de Telegram con Tailscale, abrir el enlace, provocar una escalada y un cierre, y comprobar el mensaje original; después, en la PWA de iOS, el aviso presente y el descartado.
- La Notifications API no ofrece un reemplazo condicional atómico: entre la lectura y `showNotification` el usuario puede descartar el aviso. El código nunca recrea lo que no leyó como presente, pero esa ventana estrecha no es observable.

## Issues Encountered

- El E2E necesitó citar `"chatId"`/`"messageId"` al sembrar el outbox porque las columnas son camelCase y PostgreSQL las pliega a minúsculas sin comillas. Fue un ajuste del arnés, no de producción.
- La prueba INC-E2E-03 tarda unos 12 s porque espera el sondeo visible del dashboard y su 401 real, tal como pide el plan, en lugar de forzar la navegación.

## User Setup Required

La prueba física de la bandeja push y el chat de Telegram con el enlace real siguen siendo comprobaciones de despliegue. No hay credenciales reales en este entorno y no bloquean la entrega del plan.

## Next Phase Readiness

- La fase 2 queda completa en código y tests: episodios, entrega única, enlaces autenticados, proyección pública y refresco local del push.
- El orquestador debe actualizar `ROADMAP.md`/`STATE.md` y decidir el despliegue conjunto de las cinco olas.
- Quedan las pruebas manuales de Telegram y de la PWA de iOS descritas en `02-VALIDATION.md`.

## Self-Check: PASSED

- `src/lib/incident-push.ts`, `tests/api-incidents.test.ts`, `tests/incident-push.test.ts` y `tests/e2e/incidents.spec.ts` existen.
- `03976c9` y `1eb6380` son ancestros de `HEAD`.
- PostgreSQL 18 ejecutó las 40 suites (417 tests) sin omisiones.
- `pnpm typecheck`, el lint de archivos versionados, `pnpm build` y los 3 E2E de incidencias terminaron con exit 0.
