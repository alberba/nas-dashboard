# Phase 8: Cutover de media-stack y consolidación - Pattern Map

**Mapped:** 2026-11-27
**Files analyzed:** 27 (13 hub nuevos o modificados, 14 media-stack)
**Analogs found:** 25 / 27

Rutas del hub relativas a `/Users/albertsalom/Proyectos/Servidores/nas-dashboard`; rutas de media-stack relativas a `/Users/albertsalom/Proyectos/Servidores/media-stack`. Todos los analogs están en git (tracked); ninguno es espejo de runtime.

## File Classification

### Hub

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/app/api/notifications/ingest/route.ts` | route (HMAC, sin sesión) | request-response | `src/app/api/auth/[...all]/route.ts` | role-match |
| `src/lib/notification-ingest.ts` | service (firma, zod, mapeo) | request-response / transform | `src/lib/telegram-intents.ts` (HMAC, líneas 108-127) | role-match |
| `src/lib/notification-policy.ts` (mod) | utility | transform | sí mismo (ramas `helper-cleanup`, `container:`) | exact |
| `src/lib/runtime-config.ts` (mod) | config | validación en arranque | sí mismo (`isExampleValue`, `MIN_SECRET_LENGTH`) | exact |
| `src/lib/sensitive-actions.ts` (mod) | config (manifiesto) | declarativo | sí mismo, `routeFiles` (líneas 233-244) | exact |
| `src/lib/incident-store.ts` (mod: `closedBy "ingest"`, `evidenceAt`) | service | CRUD transaccional | sí mismo, `recordIncidentObservationIn` (línea 674) | exact |
| `src/lib/schema.ts` (mod: `ingestEvents`, `sampleRollups`, `containerRollups`) | model | CRUD | `samples` (línea 108) | exact |
| `drizzle/0009_*.sql`, `0010_*.sql` | migration | batch | `drizzle/0008_acciones_telegram.sql` | exact |
| `scripts/rollback/0009_*.sql`, `0010_*.sql` | migration (reversa) | batch | `scripts/rollback/0004_incidents.sql` | exact |
| `src/lib/history-rollups.ts` | service | batch / transform (SQL `date_bin`) | `src/app/api/[...path]/route.ts` 93-99 y 484-515 | role-match |
| `src/app/api/[...path]/route.ts` (mod: overview y container-history) | route | request-response | sí mismo | exact |
| `src/worker.ts` (mod: tick de rollup, cleanup 48 h) | worker | event-driven / batch | sí mismo, `cleanup` (líneas 165-173) y `updates:` opcional | exact |
| `tests/notification-ingest.test.ts`, `history-rollups.test.ts`, `overview-budget.test.ts` | test (BD real) | request-response / batch | `tests/collector-alerts.test.ts` | exact |
| `tests/notification-senders.test.ts` (guarda D-22) | test estático | transform | `tests/sensitive-actions.test.ts` (líneas 285-315, lee fuentes del árbol) | role-match |

### media-stack

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `stacks/backup/media-backup.sh` (mod: publicar + fallback) | script | request-response con reintentos | sí mismo (`alert`, `finish`, líneas 137-157) + `scripts/upgrade.sh` 38-49 (`curl -K -`) | exact |
| `stacks/backup/Dockerfile`, `compose.yaml` (mod) | config | — | sí mismos | exact |
| `stacks/extras/issue-automator/main.py` (mod) | service | event-driven (webhook a ingest) | sí mismo (`send_telegram`, `process_webhook_payload`) | exact |
| `stacks/extras/compose.yaml`, `stacks/monitoring/compose.yaml` (mod) | config | — | sí mismos | exact |
| `stacks/monitoring/security-monitor/{main,updater}.py`, `scripts/merged_updates.py`, `scripts/upgrade.sh` (mod: retirada) | service | — | sí mismos | exact |
| `env/catalog.json` + `.env.example` regenerados | config | — | sí mismo (`python3 scripts/env_contract.py generate`) | exact |
| `tests/telegram-emitters.test.sh` (nuevo) | test (guarda) | transform | `tests/lib.sh` + estructura de `tests/backup.test.sh` | role-match |
| `tests/{backup,issue-automator,template,upgrade,merged-updates,security-update,security-monitor}.test.sh` (reescritura) | test | — | sí mismos | exact |

### Runbook y docs

| File | Role | Closest Analog | Match Quality |
|---|---|---|---|
| Runbook de rotación (hub, `docs/` o README) | docs | `scripts/rollback/0004_incidents.sql` (precondiciones operativas en cabecera) | partial |
| `../media-stack/docs/profiles.md` (webhook de Seerr: añadir Issue Resolved), `docs/backup.md` (duplicado D-15) | docs | sí mismos | exact |

## Pattern Assignments

### `src/app/api/notifications/ingest/route.ts` (route, request-response)

**Analog:** `src/app/api/auth/[...all]/route.ts`

**Cuerpo acotado y 413** (líneas 20-31): copiar tal cual, con `INGEST_BODY_LIMIT = 8 * 1024`. El límite de auth vive en `request-body.ts` porque un `route.ts` solo puede exportar verbos; **la constante del ingest tiene que ir en `request-body.ts` o en `notification-ingest.ts`**, no exportada desde la ruta.
```typescript
import { AUTH_BODY_LIMIT, BodyTooLarge, readBodyText } from "@/lib/request-body";
export async function POST(request: Request) {
  let text: string;
  try {
    text = await readBodyText(request, AUTH_BODY_LIMIT);
  } catch (error) {
    if (error instanceof BodyTooLarge)
      return Response.json(
        { error: "La solicitud es demasiado grande." },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    throw error;
  }
```
Diferencias: solo exporta `POST`; la ruta es delgada (orquesta, lógica en `notification-ingest.ts`); `request.text()` está prohibido por un test, usar siempre `readBodyText`. Orden: secreto configurado (503) → cuerpo (413) → cabeceras y ventana y HMAC (401 único) → zod (400) → lista permitida (422) → transacción. Cero acceso a BD antes de HMAC. Texto de errores en español, sin copy asertado en tests (CODING_STANDARD.md).

**Declaración en el manifiesto** (`src/lib/sensitive-actions.ts:233-244`): ampliar la unión y añadir la entrada, o `tests/sensitive-actions.test.ts` ("lists every route.ts under src/app/api, and nothing stale", líneas ~298-307) falla.
```typescript
export const routeFiles = {
  "src/app/api/[...path]/route.ts": { dispatch: "catch-all" },
  "src/app/api/auth/[...all]/route.ts": {
    dispatch: "better-auth",
    policy: exempt("Better Auth valida credenciales y limita intentos; el cuerpo se acota en su envoltorio de 32 KiB"),
  },
  // NUEVO: "src/app/api/notifications/ingest/route.ts": { dispatch: "hmac-ingest", policy: exempt("HMAC ...") },
} satisfies Record<string, { dispatch: "catch-all" } | { dispatch: "better-auth"; policy: Policy }>;
```
El test también comprueba "exports exactly the verbs the manifest declares": revisar que acepte un `route.ts` con solo `POST`.

---

### `src/lib/notification-ingest.ts` (service, request-response)

**Analog (HMAC):** `src/lib/telegram-intents.ts` líneas 16 y 108-127
```typescript
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
  return createHmac("sha256", secret).update("hub:telegram-handoff:v1").digest();
  ...
  return a.length === b.length && timingSafeEqual(a, b);
```
Copiar: comparar buffers de igual longitud con `timingSafeEqual`; la firma del ingest es `HMAC-SHA256(secreto, "<ts>.<cuerpoCrudo>")`, hex `v1=<64 hex>`; evaluar secreto actual y anterior **sin cortocircuito**. Otro precedente de `timingSafeEqual`: `src/app/api/[...path]/route.ts:178`.

**Analog (idempotencia + incidencia):** `recordIncidentObservationIn(tx, input)` en `src/lib/incident-store.ts:674` y tipo `IncidentObservation` (líneas 33-54). El ingest construye:
```typescript
{ hostId, key, failing: state === "open", severity, title, detail, delivery: { channel: "telegram" }, closedBy: "ingest" }
```
Y todo en `db.transaction` junto al `INSERT INTO ingest_events ... ON CONFLICT DO NOTHING RETURNING` (patrón de RESEARCH, Pattern 2, líneas 255-265). El hub compone título y detalle (nunca HTML del productor; el cliente de Telegram no fija `parse_mode`).

**Validación:** zod `.strict()` como en `src/lib/validation.ts`; `hostId` contra `getHosts()` (`src/lib/hosts.ts`).

**Cambios en `incident-store.ts` (Pitfall 1):** añadir `closedBy?: ... | "ingest"` (línea 44) y `evidenceAt?: number` a `IncidentObservation`; en la rama `!input.failing` (cerca de línea 722, `closeEpisode(tx, open, seq, at)`) devolver `ignored` si `open.at` es posterior a `evidenceAt`. El colector pasa `backup.at` del snapshot (ver `maintenance-alerts.ts`, `collector.ts:42`). Test nuevo en `tests/collector-alerts.test.ts`.

---

### `src/lib/notification-policy.ts` (mod, transform)

**Analog:** sí mismo, ramas explícitas por prefijo (líneas 41 y 76-91)
```typescript
const SILENT_PREFIX = "container:";
...
  if (key.startsWith(SILENT_PREFIX))
    return { channel: "silent", reason: "policy_silent", digest: false, immediate: false };
  if (key === "helper-cleanup") return { channel: "digest", reason: "digest_pending", digest: true, immediate: false };
```
Añadir antes del fallback "not audited": `const SEERR_ISSUE_PREFIX = "issue:seerr:"` devolviendo `{ channel: "telegram", reason: "policy_immediate", digest: false, immediate: true }` (misma forma que líneas 102-108), para cualquier severidad. Test junto a los de política existentes. SMART (D-06): ya cubierto por `disk-health` (líneas 92-101); solo verificar con un test, no añadir clave.

---

### `src/lib/runtime-config.ts` (mod, config)

**Analog:** sí mismo (471 líneas). Reutilizar `isExampleValue` y `MIN_SECRET_LENGTH = 32` y el código `incomplete_pair` ya presentes (grep antes de editar; no leí el cuerpo). Diseño: `NOTIFY_INGEST_SECRET` **opcional** en el arranque (Pitfall 14: obligatorio rompe el deploy); `NOTIFY_INGEST_SECRET_PREVIOUS` sin la actual da `incomplete_pair`. Los mensajes nombran variables y razones finitas, nunca valores (patrón de `main().catch` en `src/worker.ts:202-206`). Casos en `tests/runtime-config.test.ts`.

---

### `src/lib/schema.ts`, `drizzle/0009_*.sql`, `drizzle/0010_*.sql`, `scripts/rollback/*` (model + migration)

**Analog (tabla):** `samples` (`src/lib/schema.ts:108-120`)
```typescript
export const samples = pgTable(
  "samples",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    hostId: text().notNull().default("nas-home"),
    at: timestamp().notNull().defaultNow(),
    data: jsonb().$type<Metrics>().notNull(),
  },
  (t) => [
    index("samples_at_idx").on(t.at),
    index("samples_host_at_idx").on(t.hostId, t.at),
  ],
);
```
`sample_rollups.bucket` debe ser `timestamp()` **sin zona**, igual que `samples.at` (Pitfall 6). Clave primaria compuesta `(hostId, bucket)`; `container_rollups` `(hostId, container, bucket)`; `ingest_events` PK `id = "source:eventId"` + `fingerprint` + `createdAt` (con zona, como las tablas de incidencias).

**Analog (SQL generado):** `drizzle/0008_acciones_telegram.sql` (CREATE TABLE con comillas dobles y `--> statement-breakpoint`; `timestamp with time zone DEFAULT now() NOT NULL`). Se genera con drizzle-kit; actualizar `drizzle/meta`.

**Analog (reversa):** `scripts/rollback/0004_incidents.sql`: cabecera con precondiciones operativas (parar app y worker, copia restaurable, `psql -v ON_ERROR_STOP=1 -f`), `BEGIN;`, aborta si no es la última migración aplicada. Copiar la estructura de cabecera y la guarda. Test que siembra la versión anterior: ampliar `tests/migrations.test.ts`.

---

### `src/lib/history-rollups.ts` y `src/app/api/[...path]/route.ts` (service/route, batch + request-response)

**Analog:** `src/app/api/[...path]/route.ts` líneas 93-99 y 484-515. Mantener **las mismas 13 columnas** y el `generate_series ... LEFT JOIN`.
```typescript
const ranges = {
  "1h": [3600, 30], "6h": [21600, 60], "24h": [86400, 120],
  "7d": [604800, 900], "30d": [2592000, 3600],
} as const;
```
```sql
WITH series AS (SELECT generate_series(
  date_bin(make_interval(secs => ${bucket}), now() - make_interval(secs => ${seconds}), timestamp '2000-01-01'),
  date_bin(make_interval(secs => ${bucket}), now(), timestamp '2000-01-01'), make_interval(secs => ${bucket})) AS at),
grouped AS (SELECT date_bin(make_interval(secs => ${bucket}), at, timestamp '2000-01-01') AS at,
  avg((data->>'cpu')::float) AS cpu,
  avg((data->'memory'->>'used')::float / nullif((data->'memory'->>'total')::float, 0) * 100) AS memory,
  ... FROM samples WHERE "hostId" = ${host.id} AND at > now() - make_interval(secs => ${seconds}) GROUP BY 1)
SELECT series.at, grouped.cpu, ... FROM series LEFT JOIN grouped USING(at) ORDER BY series.at
```
Cambio: 1h/6h/24h siguen aquí; 7d lee `sample_rollups` directo; 30d reagrega a 1 h con `sum(cpu*n) / nullif(sum(n) FILTER (WHERE cpu IS NOT NULL), 0)` (RESEARCH Pattern 4). Extraer la consulta a `history-rollups.ts` (`readHistory`, `readContainerHistory`, `rollupRecent`, `backfillRollups`) y que la ruta solo orqueste. Las rutas `container-history` están alrededor de la línea 536 (no leídas; el planner debe leerlas antes de tocar). Despacho del catch-all por nombre exacto o patrón declarado (test "dispatches only by exact name"): no añadir `startsWith`.

---

### `src/worker.ts` (mod, event-driven)

**Analog:** sí mismo, líneas 148-178. El `workerTurn` recibe lanes opcionales (`updates: updatesLane ? ... : undefined`) y `cleanup`:
```typescript
cleanup: async () => {
  const cutoff = new Date(Date.now() - 30 * 86400000);
  await db.delete(samples).where(lt(samples.at, cutoff));
  await cleanupExpiredIncidents(cutoff);
  await db.delete(operations).where(lt(operations.at, cutoff));
  await db.delete(presence).where(lt(presence.expiresAt, new Date()));
  await cleanupTelegramState(db, new Date());
},
```
Cambios: el borrado de `samples` pasa a 48 h, por lotes, con `EXISTS` sobre `sample_rollups` y conservando la última muestra por host (Pitfall 7); retención de rollups e `ingest_events` a 30 d; el cutoff de 30 d sigue para incidencias y operaciones. El tick de rollup (~60 s) es una dependencia opcional nueva de `workerTurn` en `src/lib/worker-loop.ts` (`WORKER_CLEANUP_MS = 3_600_000` en línea 15; lee ese fichero entero antes de planificar). El backfill inicial se ejecuta antes de que la retención de 48 h pueda borrar; la guarda `EXISTS` lo garantiza por construcción.

---

### `tests/notification-ingest.test.ts`, `history-rollups.test.ts` (test con BD real)

**Analog:** `tests/collector-alerts.test.ts`

**Imports y esqueleto** (líneas 1-15, 103, 165-203):
```typescript
import { Client } from "pg";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDatabase, dropTestDatabase, testDatabaseUrl, type TestDatabase } from "./database";
const baseUrl = testDatabaseUrl();
describe.skipIf(!baseUrl)("...", () => {
  beforeAll(async () => {
    context = await createTestDatabase(baseUrl!);
    process.env.DATABASE_URL = context.url;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const database = await import("@/lib/db");
    db = database.db; pool = database.pool;
    await migrate(db, { migrationsFolder: "./drizzle" });
    store = await import("@/lib/incident-store");
  });
  afterAll(async () => { await pool.end(); await dropTestDatabase(context); });
```
Importes dinámicos tras fijar `DATABASE_URL`; `NAS_HOSTS` en `process.env` para `getHosts()`. Para la ruta: importar `POST` de `@/app/api/notifications/ingest/route` y llamarlo con un `Request`. Asertar estado (códigos, filas de `incidents`, `notification_outbox`, `ingest_events`), nunca copy (CODING_STANDARD.md).

`tests/overview-budget.test.ts`: mismo esqueleto, `describe.skipIf(process.env.HUB_PERF !== "1")`, siembra de 500k, p95 nearest-rank sobre >=50 ejecuciones, más aserción de plan (`EXPLAIN` sin Seq Scan sobre `samples` en 30d).

---

### `tests/notification-senders.test.ts` (guarda D-22, test estático)

**Analog:** `tests/sensitive-actions.test.ts` (líneas 285-315): lee ficheros reales con `readdirSync(..., { recursive: true })`, `path.join(repoRoot, ...)` y aserta sobre estructura.
```typescript
const files = readdirSync(path.join(repoRoot, "src/app/api"), { recursive: true })
  .map((entry) => String(entry).split(path.sep).join("/"))
  .filter((entry) => /(^|\/)route\.(ts|tsx|js|jsx|mjs)$/.test(entry));
```
Adaptar: recorrer `src/**/*.ts`, y fallar si un módulo distinto de `notification-dispatch.ts` y `digest-runs.ts` importa de `./telegram` (`sendTelegramMessage`, `editTelegramMessage`, `sendTelegramReply`), importa `web-push`/`deliverPush`, o contiene `api.telegram.org`. **Excepciones reales ya presentes que el planner debe resolver con una lista explícita y justificada** (grep `from "./telegram"` en `src/`):
- `src/lib/telegram.ts` (el cliente, define los senders)
- `src/lib/digest-content.ts:4` (solo `TELEGRAM_TEXT_LIMIT, telegramText`: constantes, no envío; distinguir por símbolo importado)
- `src/lib/telegram-updates.ts:46` y `telegram-keyboard.ts:13` (revisar qué importan; updates es el carril del bot, posible envío de respuestas)
- `src/lib/push.ts` (cliente de push) y la prueba de push del worker (D-22 la permite)
Excluir comentarios al buscar cadenas.

---

### `stacks/backup/media-backup.sh` (script, request-response con reintentos)

**Analog:** sí mismo, líneas 137-157, más el patrón `curl -K -` de `scripts/upgrade.sh:38-49`.

**Actual** (a reemplazar) `alert()`/`finish()`:
```bash
alert() {
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log "Telegram is not configured, no alert sent"; return
  fi
  curl -fsS --max-time 20 -o /dev/null \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$1" \
    "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" || log "could not send the Telegram alert"
}
finish() {
  if [ "${#errors[@]}" -eq 0 ]; then echo "ok $(date -Iseconds)" > "$STATE_DIR/last-status"; ...; return 0; fi
  echo "failed $(date -Iseconds)" > "$STATE_DIR/last-status"
  alert "$(printf 'Backup of %s FAILED:\n' "$BACKUP_HOST"; printf -- '- %s\n' "${errors[@]}")"
  return 1
}
```
**Token fuera de argv** (`scripts/upgrade.sh:46-48`), para el fallback:
```bash
printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
  curl -fsS -o /dev/null --max-time 30 -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=..."
```
**Nuevo:** `finish()` mantiene la escritura de `last-status`, llama `publish_ingest` (hasta 3 intentos, retrasos sobreescribibles `INGEST_RETRY_DELAYS`, mismo cuerpo `jq -nc --arg`, marca de tiempo nueva por intento, `curl ... -w '%{http_code}'`, éxito = `^2..$`) y solo si ninguno confirma llama a `alert` con prefijo fijo y solo `backup-failed`. Firma con `printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$NOTIFY_INGEST_SECRET" -hex | sed 's/^.* //'` y `--data-binary "$body"`. El éxito nunca envía (D-13). Convenciones: `log`, `die`, `add_error` ya existen en el script; pasar shellcheck (`scripts/check.sh fast`). Añadir `jq openssl` al `apk add` de `stacks/backup/Dockerfile`; añadir `NOTIFY_INGEST_URL/SECRET/HOST_ID` a `stacks/backup/compose.yaml` y `env/catalog.json` (luego `python3 scripts/env_contract.py generate`).

**Test analog:** `tests/backup.test.sh`. Fixture de `curl` falso (líneas 38-42) que registra `$*` en `$FAKE_LOG`; aserciones `calls | grep '^curl'`. Reescribir `test_failed_backup_alerts_on_telegram` (líneas 262-270): ahora con 2xx no hay llamada a `api.telegram.org`; sin 2xx hay una. Con `-K -` capturar también stdin en el `curl` falso. El `curl` falso debe poder devolver código HTTP según `FAKE_INGEST_STATUS`. Asertar por estructura (constante del prefijo, no la frase).

---

### `stacks/extras/issue-automator/main.py` (service, event-driven)

**Analog:** sí mismo. `send_telegram(text_html)` (líneas 134-145, urllib, `CONFIG.get("telegram")`) se sustituye por un publicador firmado. Las llamadas a retirar están en líneas 314, 411 y 446. `api_request(url, method, headers, data)` (líneas ~120-130) devuelve `(cuerpo, status)` y captura `HTTPError`/`Exception`: **reutilizar su estilo** para el POST firmado.

**Bifurcar por tipo antes de cualquier acción** (Pitfall 3), partiendo de líneas 306-314:
```python
def process_webhook_payload(payload):
    notif_type = payload.get("notification_type") or payload.get("event")
    if notif_type in ("TEST_NOTIFICATION", "test"):
        send_telegram(...)   # ELIMINAR; responder 200 sin Telegram
        return {"status": "ok", "detail": "Test notification handled"}
    issue_data = payload.get("issue", {})
    issue_id = issue_data.get("id") or issue_data.get("issue_id") or payload.get("issue_id")
```
`ISSUE_CREATED` conserva el flujo (blocklist, búsqueda, comentario) y publica `open`; `ISSUE_RESOLVED` solo publica `resolved` sin tocar Radarr/Sonarr; otro tipo, 200 sin efecto. Firma solo stdlib: `hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()`. `eventId = issue:<id>:<estado>:<updatedAt>`; reintento en proceso (2-3) con mismo cuerpo. `load_config(env)` valida y agrega errores (tests `LoadConfig`): añadir `NOTIFY_INGEST_*` ahí y quitar el bloque `telegram`.

**Test analog:** `tests/issue-automator.test.sh`: Bash que lanza `PYTHONPATH=... python3 -B - <<'EOF'` con `unittest`, `main.load_config(env(...))` y `env(**overrides)`. Quitar el assert de `telegram` en `load_config`; añadir clases `Ingest` que parchean el transporte y comprueban que `ISSUE_RESOLVED` no llama a las funciones de Radarr/Sonarr.

---

### Apagado de emisores (D-01, D-02, D-03)

Sin analog nuevo: retirar de golpe, sin código de doble camino (D-10).
- `scripts/upgrade.sh:38-49` `notify()` y `die()` (que llama a `notify`): eliminar la función y sus llamadas; `die` conserva `echo error` y `exit 1`.
- `scripts/merged_updates.py`: `notify`, `flush_notifications`, `notify_outcome`, cola `notifications.json` (línea ~150).
- `stacks/monitoring/security-monitor/{main,updater}.py`: `telegram()`, `notify`, parámetro `notify=` de `run()`, cola `update-notifications.json` (updater línea ~303).
- `stacks/monitoring/compose.yaml:92-96` (`WUD_TRIGGER_TELEGRAM_*`) y `TELEGRAM_*` en monitoring (24-25) y extras (30-31); `backup/compose.yaml:25-26` se queda.
- Tests a reescribir (Pitfall 10 y 11): `tests/template.test.sh:229-236`, `tests/merged-updates.test.sh:98,138`, `tests/security-update.test.sh:43-46`, `tests/security-monitor.test.sh:61-63`, `tests/upgrade.test.sh`.

### `tests/telegram-emitters.test.sh` (guarda, media-stack)

**Analog:** estructura de `tests/lib.sh` (`run_tests`, `assert_file_not_contains`, `fail`):
```bash
. "$REPO/tests/lib.sh"
assert_file_not_contains() { ! grep -qF -- "$2" "$1" 2>/dev/null || fail "expected $1 not to contain '$2'"; }
```
Cabecera de test como `tests/backup.test.sh:1-9` (`set -uo pipefail`, `REPO=...`). Falla si `api.telegram.org` o `TELEGRAM_` aparecen en compose y fuentes salvo `stacks/backup/*` (usar `git ls-files` + `grep`, excluyendo `tests/`, `docs/` y el catálogo si procede). Los tests de media-stack requieren Linux GNU (`flock`, `stat -c`): ejecutar con `ubuntu:24.04` en Docker; CI de GitHub corre `scripts/check.sh ci`.

## Shared Patterns

### Texto visible y tests (CODING_STANDARD.md, AGENTS.md del hub)
**Apply to:** todo test nuevo y todo mensaje nuevo. Los tests aseveran estado, resultado o estructura, nunca copy. Antes de acabar, `grep tests/` por cualquier cadena de usuario cambiada. Leer `CODING_STANDARD.md` antes de escribir tests.

### Frontera transaccional de incidencias
**Source:** `src/lib/incident-store.ts:674` (`recordIncidentObservationIn(tx, input)`)
**Apply to:** `notification-ingest.ts`. El ingest nunca llama a Telegram; solo escribe incidencia y outbox, y el worker (`notification-dispatch.ts`) envía.

### Límite y errores de cuerpo
**Source:** `src/lib/request-body.ts` (`readBodyText`, `BodyTooLarge`, líneas 21-76)
**Apply to:** la ruta del ingest. Un test prohíbe leer cuerpos fuera de ese módulo.

### Validación de configuración sin valores en mensajes
**Source:** `src/lib/runtime-config.ts`, `src/worker.ts:202-206` (`RuntimeConfigError`: nombra variables y razones finitas, jamás valores)
**Apply to:** secreto del ingest; redacción con `redactToken` en logs de fallo.

### Migraciones reversibles probadas sembrando la versión anterior
**Source:** `drizzle/0008_*.sql`, `scripts/rollback/0004_incidents.sql`, `tests/migrations.test.ts`
**Apply to:** 0009 (ingest) y 0010 (rollups). Per RESEARCH Open Question 7: ingest en un despliegue y rollups con retención de 48 h en otro, tras `pg_dump`.

### Convenciones propias de media-stack
**Source:** `../media-stack/AGENTS.md` (no leído en esta pasada; el planner debe leerlo), `tests/lib.sh`, ADR-0007: fusionar en `main` despliega. El trabajo de media-stack queda en rama y PR; la fusión es un `checkpoint:human-action` posterior a los eventos de prueba (D-11).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `tests/overview-budget.test.ts` (parte de siembra de 500k y p95) | test de rendimiento | batch | No hay pruebas gated por `HUB_PERF`; solo se reutiliza el esqueleto de BD de `collector-alerts.test.ts` |
| Tick de rollup en `src/lib/worker-loop.ts` | worker | batch | Existe el patrón de lane opcional (`updates`) pero no un tick temporizado propio; seguir RESEARCH Pattern 5 |
| Runbook de rotación del token y secreto | docs | — | Solo hay precedente de precondiciones operativas (cabecera de `0004_incidents.sql`); contenido según RESEARCH (Pitfalls 8 y 9) |
| Checklist de cutover (D-11) | docs | — | No existe un checklist de release equivalente en el hub |

## Metadata

**Analog search scope:** `src/app/api`, `src/lib`, `src/worker.ts`, `tests/`, `drizzle/`, `scripts/rollback/` (hub); `stacks/`, `scripts/`, `tests/` (media-stack).
**Files scanned:** ~25 leídos total o parcialmente. Sin leer a fondo: `runtime-config.ts`, `worker-loop.ts`, `container-history` en el catch-all, `AGENTS.md` de media-stack, `telegram-updates.ts`, `push.ts`.
**Pattern extraction date:** 2026-11-27
