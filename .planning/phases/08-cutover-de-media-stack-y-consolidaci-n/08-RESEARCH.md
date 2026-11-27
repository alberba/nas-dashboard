# Phase 8: Cutover de media-stack y consolidación - Research

**Researched:** 2026-11-27
**Domain:** Ingest firmado (HMAC) e idempotente de `media-stack` hacia el hub Next.js 16, cutover de los emisores de Telegram de `media-stack` (repo hermano, con CI y release propios), rollups del histórico en PostgreSQL con presupuesto medido sobre 500k muestras, guarda anti-bypass de envíos y runbook de rotación del token del bot.
**Confidence:** HIGH en el código de ambos repos (leído esta sesión) y en las cifras de rendimiento (medidas esta sesión en PostgreSQL 18 local); MEDIUM en el comportamiento de Seerr (eventos de resolución) y en la alcanzabilidad NAS → hub por Tailscale (se comprueba en el evento de prueba D-09).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Destino de cada familia tras el apagado**
- **D-01:** upgrade-script (`scripts/upgrade.sh`) y merged-updates (`scripts/merged_updates.py`) dejan de enviar a Telegram. Los fallos los cubren `deploy-failed` y `release-retained`, que el hub ya abre desde el snapshot. Las releases aplicadas con éxito no avisan: se ven en Despliegues, sin línea en el digest.
- **D-02:** security-updater y security-monitor dejan de enviar a Telegram, sin sustituto: ni incidencia ni línea en el digest. Las revisiones manuales siguen visibles en Mantenimiento, que el hub lee del agente.
- **D-03:** WUD pierde su trigger de Telegram (`WUD_TRIGGER_TELEGRAM_*` en `stacks/monitoring/compose.yaml`) sin sustituto. Solo queda la UI de WUD.
- **D-04:** issue-automator (`stacks/extras/issue-automator/main.py`) pasa al ingest con disposición **inmediata**. El hub decide y envía.
- **D-05:** Cada issue de Seerr es una incidencia con ciclo de vida. Se abre con `ISSUE_CREATED` y se cierra cuando el issue se cierra en Seerr: issue-automator publica también el evento de resolución y el hub edita el mensaje original en vez de enviar otro. La identidad es estable por issue de Seerr, así que un reintento del mismo evento no abre otra incidencia.
- **D-06:** La familia `smart` de Telegram (emisor sin identificar en la auditoría de la fase 1) se localiza y se apaga. La cubre el hub: si el hub aún no abre incidencia por un disco SMART en mal estado a partir del snapshot del agente, se añade esa clave con su disposición de política.
- **D-07:** Por las decisiones anteriores, el ingest solo tiene dos productores: issue-automator y la copia (`stacks/backup/media-backup.sh`). Ninguna otra familia publica en el ingest.

**Ritmo del cutover**
- **D-08:** El apagado se hace todo de golpe, en un solo despliegue de `media-stack`, cuando el ingest del hub ya está en producción y probado. No hay observación entre familias. — **Reversibility:** reversible — el despliegue es un release de media-stack y se puede revertir.
- **D-09:** Para aceptar el cutover, cada familia con ingest (issue-automator al abrir y al cerrar, y la copia) recibe un evento firmado de prueba, y se comprueba en el hub la incidencia y su mensaje. En las familias que solo se apagan, se comprueba que el emisor ya no tiene token ni trigger de Telegram.
- **D-10:** La vuelta atrás es revertir el commit de `media-stack`. Sin flags por familia ni código de doble camino.
- **D-11:** El usuario despliega `media-stack` en el NAS con su proceso de release normal. El plan deja commits, CI verde en `media-stack` y un checklist de pasos y verificación, y el ejecutor no aplica cambios en el NAS por SSH. El orden obligatorio es: hub con ingest desplegado → eventos de prueba → release de media-stack.

**Fallback de la copia**
- **D-12:** Cuando falla una copia, `media-backup.sh` publica el evento en el ingest y hace hasta 3 intentos en unos 2 minutos. Solo si ninguno recibe confirmación (2xx del ingest) envía directo a Telegram. La confirmación del ingest es el contrato; la salud genérica del hub no cuenta.
- **D-13:** El fallback solo envía `backup-failed`, nunca el éxito ni otras familias.
- **D-14:** El aviso directo lleva un prefijo visible y un texto fijo que lo distinguen de los avisos del hub, por ejemplo «Aviso directo de media-stack: el hub no confirmó», más el host y la hora. Usa el mismo bot que el hub, no un segundo bot.
- **D-15:** Se acepta el duplicado conocido de la copia: si el hub estaba caído o confirmó tarde, al volver puede abrir la misma incidencia. Hay que documentarlo; no es un defecto.

**Rotación del token y del secreto**
- **D-16:** La rotación conjunta del token del bot se documenta en un runbook y se prueba con una **rotación real en producción**: revocar el token en BotFather, actualizar el `.env` del hub y el de `media-stack`, reiniciar lo necesario y verificar con un aviso de prueba por cada camino (hub → Telegram y fallback de copia → Telegram). — **Reversibility:** one-way — revocar un token en BotFather lo invalida para siempre; si se olvida un `.env`, ese camino queda mudo hasta que se corrija.
- **D-17:** El secreto HMAC del ingest (`NOTIFY_INGEST_SECRET` según research) entra en el mismo runbook. Durante la rotación, el hub acepta el secreto actual y el anterior, así que no se pierde ningún evento. Cuando ambos lados usan el nuevo, el anterior se retira.

**Rollups y retención**
- **D-18:** Los rangos 7d y 30d se leen de un rollup de 15 min. 30d reagrega esos cubos a 1 h. Los rangos 1h, 6h y 24h siguen leyendo las muestras crudas con sus cubos actuales (30 s, 1 min y 2 min).
- **D-19:** El historial por contenedor (`container-history`) sigue la misma política, con un rollup por (host, contenedor).
- **D-20:** Las muestras crudas (`samples`) se retienen 48 h y los rollups 30 días. Antes de acortar la retención de crudas, hay que poblar los rollups con el histórico existente para que 7d y 30d no queden vacíos tras el despliegue. — **Reversibility:** one-way — las muestras crudas de más de 48 h que se borren no se recuperan; solo queda su agregado.
- **D-21:** Presupuesto del overview: p95 < 150 ms en servidor con 500k muestras sembradas en PostgreSQL real, para la consulta completa del overview con rango 30d. Se mide en una prueba repetible.

**Consolidación de `notify()`**
- **D-22:** `notify()` ya se retiró en la fase 2 (commit `4d15f3f`). Para el criterio 5 falta una guarda (test o lint) que falle si un envío a Telegram o Web Push nace fuera de `notification-dispatch.ts` y `digest-runs.ts` (y de la prueba de push del worker, si aplica).

### Claude's Discretion
- La forma exacta del contrato de ingest (campos, versión y códigos de respuesta) dentro de lo que fija research: `POST /api/notifications/ingest`, HMAC, ventana de 5 min, idempotencia por `source:eventId` y respuesta 202.
- Cómo llega `media-stack` al hub: la URL por Tailscale y dónde se configura en `.env`.
- El backoff exacto de los 3 intentos de la copia dentro de unos 2 minutos.
- El esquema de las tablas de rollup, el momento de agregar (worker, en cada ciclo de limpieza o al cerrar cada cubo) y la caché del overview, siempre que cumplan D-18 a D-21.
- La retención de `ingest_events`. Research propone 30 días.
- El texto exacto del prefijo del fallback, en español.

### Deferred Ideas (OUT OF SCOPE)
- Recuento de actualizaciones de WUD en el digest: descartado por ahora, si se quiere más adelante sería otra fase.
- Revisiones de seguridad de media-stack como incidencia o línea del digest: descartado (D-02). Si se echan de menos, sería una capacidad nueva.
- Backlog 999.1, un emoticono por tipo de mensaje del bot: sigue en el backlog y no se discutió en esta fase.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-05 | La rotación conjunta del token del bot (hub y `media-stack`) está documentada y probada | Tras el cutover solo dos lectores del token siguen vivos: el worker/app del hub y el contenedor `backup`. El runbook tiene una ventana ciega inevitable (BotFather no admite dos tokens), `docker compose restart` no relee `.env` (hace falta recrear) y hay un `checkpoint:human-action` para la rotación real. Sección «Rotación del token y del secreto». |
| SEC-06 | El fallback de copia solo envía `backup-failed`, solo si el ingest no confirma, y se marca con origen propio | `media-backup.sh` `alert()` es hoy el único `api.telegram.org` que debe sobrevivir. Reescribir `finish()` como publicar-con-3-intentos y solo entonces fallback con prefijo fijo; añadir `jq` y `openssl` a la imagen Alpine (verificado) y un test-guarda que impide otro `api.telegram.org` en el repo. |
| CONT-02 | El ingest de `media-stack` valida HMAC, ventana de 5 minutos e idempotencia por evento | Ruta `POST /api/notifications/ingest` fuera del catch-all, `readBodyText` con tope, HMAC sobre `timestamp.cuerpoCrudo`, `timingSafeEqual`, secreto actual + anterior, `ingest_events` insertado en la misma transacción que la incidencia. |
| PERF-01 | El histórico de 30 días se sirve desde rollups y no re-agrega cada muestra en cada poll | Rollup de 15 min (`sample_rollups`) y por contenedor (`container_rollups`), agregación idempotente por upsert en el worker, backfill por días, lectura ponderada 15 min → 1 h. Medido: 30d crudo 4,65 s; desde rollup 1,9 ms. |
| PERF-02 | La consulta del overview tiene un presupuesto medido y una prueba con 500k muestras | Prueba repetible `HUB_PERF=1` contra PostgreSQL real, siembra de 500k filas (≈33 s, ≈1 GB), p95 sobre N ejecuciones de la ruta real con auth simulada, más una aserción determinista de plan (sin Seq Scan sobre `samples` en 30d). |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

No existe `./CLAUDE.md` ni `./.claude/CLAUDE.md`. Las directivas viven en `AGENTS.md` y `CODING_STANDARD.md` (leídos esta sesión) y en `~/.claude/CLAUDE.md`. [VERIFIED: lectura de los tres ficheros]

- **AGENTS.md:** «This is NOT the Next.js you know»: consultar `node_modules/next/dist/docs/` antes de escribir código de framework. Hecho para Route Handlers (`01-app/03-api-reference/03-file-conventions/route.md`): `POST(request: Request)` estándar, `params` es una `Promise`, `OPTIONS` se autoimplementa. [CITED: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md]
- **AGENTS.md / CODING_STANDARD.md:** leer `CODING_STANDARD.md` antes de escribir o editar un test o cambiar texto visible. Los tests aseveran **estado, resultado o estructura**, nunca copy (títulos, mensajes, etiquetas). Antes de terminar un cambio que edita texto visible, `grep tests/` por la cadena vieja. Aplica a Vitest (`tests/`), Playwright (`tests/e2e/`) y `agent/test_*.py`. Consecuencia para esta fase: los tests del ingest comprueban códigos HTTP, filas (`incidents`, `notification_outbox`, `ingest_events`) y peticiones enviadas, no el texto del aviso ni el prefijo del fallback (eso sí: el fallback debe **contener** un marcador fijo comprobable por estructura, p. ej. que el cuerpo enviado empieza por la constante exportada, no por la frase en español).
- **Shell del usuario (`~/.claude/CLAUDE.md`):** entrecomillar globs; BSD sed con `-i ''` y `-E`; zsh no divide variables sin comillas; usar `"${ref}:path"`. Relevante para los comandos de verificación del plan (macOS).
- **Hook de lectura de secretos:** el entorno bloquea leer `.env`/`.env.local`. Los planes no deben pedir al ejecutor que los lea; usar `.env.example` para nombres de variables.

## Summary

La fase tiene tres frentes independientes que comparten un único requisito de orden: **el ingest del hub tiene que estar desplegado y probado antes de que `media-stack` llegue a `main`**. El hub se despliega solo al hacer push a `main` (workflow `Deploy`, que entra por Tailscale) y su `.env` vive solo en el servidor; `media-stack` se despliega solo al fusionarse en `main` (ADR-0007: «Merging to main is the Operator's approval to deploy»): CI verde, `auto-release.yml` publica una release y el seguidor del NAS la aplica cada cinco minutos. Por eso el trabajo de `media-stack` debe quedarse en una rama/PR sin fusionar hasta el `checkpoint:human-action` de D-09/D-11, o el cutover ocurre antes que las pruebas.

El hub ya tiene casi todo lo necesario para el ingest: `recordIncidentObservationIn(tx, …)` es la frontera transaccional, `notificationPolicy` ya trata `backup-failed` como inmediata, `readBodyText` ya acota cuerpos, y el manifiesto `routeFiles` ya modela rutas fuera del catch-all. Lo nuevo es el contrato (HMAC + ventana + idempotencia), una clave de política para los issues de Seerr, y **un hueco real de carrera** que no estaba en la CONTEXT: el colector resuelve `backup-failed` en cuanto un snapshot dice `ok`, y el snapshot puede ir hasta ~2 min por detrás (caché del agente de 60 s más el intervalo de 60 s del colector), así que un evento del ingest que abre la incidencia puede cerrarse solo a los pocos segundos y reabrirse como mensaje nuevo. Hay que protegerlo.

Rendimiento: medido esta sesión con 500k muestras sintéticas (≈2 KB de JSONB cada una, un host, una cada 5 s) en `postgres:18`, la consulta actual de 30d tarda **4,65 s** (Parallel Seq Scan con *spill* a disco) y la de `container-history` 30d **1,5 s**; leída de un rollup de 15 min la misma serie cuesta **1,9 ms**. El presupuesto de 150 ms es holgado para 30d; el riesgo está en lo que D-18 deja en crudo: **24h con muestreo de 5 s tarda ≈162 ms** (17k filas), por encima de los 150 ms aunque D-21 solo exija el rango 30d.

**Primary recommendation:** Ejecutar en este orden: (1) hub: migración, módulo `notification-ingest`, ruta, clave `issue:seerr:` en la política, protección del colector contra el `ok` obsoleto, todo con tests; (2) `media-stack` en rama/PR (sin fusionar): productores firmados, apagado de los demás emisores, guarda `api.telegram.org`, CI verde; (3) rollups + retención de 48 h protegida por «cubo ya agregado» + prueba de 500k; (4) guarda D-22 y runbook; (5) los pasos humanos (deploy del hub, secreto en `.env`, eventos de prueba, fusión de media-stack, rotación real) como `checkpoint:human-action` explícitos.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Verificar HMAC, ventana de 5 min e idempotencia del evento | API / Backend (Route Handler del hub) | Database (`ingest_events`) | Es la frontera de confianza pública; se decide antes de tocar la base y la unicidad la impone PostgreSQL en la misma transacción que la incidencia. |
| Decidir canal y formatear el aviso | API / Backend (política + dispatcher del hub) | — | El hub es el único decisor y formateador (STATE, decisión de la fase 8); el productor manda campos estructurados, nunca HTML ni texto final. |
| Enviar a Telegram / Web Push | Worker del hub (`notification-dispatch.ts`, `digest-runs.ts`) | — | INCD-06: solo el worker con el lock envía. La ruta del ingest solo escribe incidencia y outbox. |
| Fallback directo de la copia | Productor (`media-backup.sh`, repo `media-stack`) | — | Único camino de envío externo permitido, por diseño (PITFALLS #24); vive donde falla el hub. |
| Publicar eventos de issue de Seerr | Productor (`issue-automator`, repo `media-stack`) | Seerr (webhook) | Seerr solo habla con el contenedor; el contenedor traduce a evento firmado. |
| Agregar el histórico a 15 min | Worker del hub | Database | Escritor único con el lock; el cálculo es SQL (`date_bin`) idempotente por upsert. |
| Servir `overview` / `container-history` | API / Backend (catch-all) | Database (rollups o crudas) | La ruta elige tabla por rango; la caché en memoria vive en el único proceso web. |
| Guarda anti-bypass de envíos | CI / pruebas (Vitest sobre el árbol de fuentes) | — | Es una propiedad estática del código, no un comportamiento de runtime. |
| Rotación del token | Operación humana (BotFather + `.env` de dos repos) | Runbook en repo | No es automatizable: BotFather es interactivo y el `.env` es de operador. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | built-in (Node 26 en CI y `Dockerfile`; 24.22.3 en esta máquina) | `createHmac`, `timingSafeEqual`, `createHash` para firmar, comparar y fingerprint | Ya se usa en el hub para HMAC (`telegram-intents.ts`, subclave del handoff) y para `timingSafeEqual` en el catch-all; **no se hace HMAC a mano**. [VERIFIED: grep `createHmac\|timingSafeEqual` en `src/`] |
| `zod` | ^4.6.7 | Esquema estricto del cuerpo del ingest (`.strict()`, longitudes acotadas) | Ya es la librería de validación del hub (`validation.ts`, `runtime-config`). [VERIFIED: package.json] |
| `drizzle-orm` + `pg` | ^0.45.4 / ^8.23.1 | Tablas `ingest_events`, `sample_rollups`, `container_rollups`; SQL crudo para `date_bin` y el upsert | Estándar del repo; el histórico ya usa `db.execute(sql…)`. [VERIFIED: package.json, `route.ts:477-500`] |
| `vitest` | ^5.1.0 | Tests del ingest, rollups, guarda D-22 y presupuesto | Runner del repo (`vitest.config.ts`). [VERIFIED: package.json] |
| Python stdlib (`hmac`, `hashlib`, `urllib`) | Python 3.15-alpine (imagen de issue-automator) | Firmar y publicar desde `issue-automator` | La imagen es «one Python file, standard library only»; no se añade ninguna dependencia. [VERIFIED: `stacks/extras/issue-automator/Dockerfile`] |
| `openssl` + `jq` (apk de Alpine 3.24) | OpenSSL 3.5.9, jq 1.8.2 | Firmar (`openssl dgst -sha256 -hmac`) y construir JSON seguro en `media-backup.sh` | La imagen `backup` no los trae (`apk add … bash ca-certificates coreutils curl findutils rclone restic sqlite supercronic tzdata`). Instalados y ejecutados en `alpine:3.24` esta sesión; la firma coincide byte a byte con `createHmac` de Node. [VERIFIED: ejecución en `alpine:3.24`] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `date_bin` de PostgreSQL 18 | `postgres:18-bookworm` | Cubos de 15 min / 1 h anclados en `timestamp '2000-01-01'` | Rollups y reagregación; es lo que ya usa el overview. |
| Docker `ubuntu:24.04` + `apt` (`sqlite3 curl jq openssl util-linux findutils python3`) | — | Ejecutar los `tests/*.test.sh` de `media-stack` desde macOS | Los tests de `media-stack` exigen Linux GNU (`flock`, `stat -c`); en esta máquina (Bash 3.2) no corren. Con esa imagen: `backup.test.sh` 33 passed / 0 failed e `issue-automator.test.sh` 13 OK. [VERIFIED: ejecución esta sesión] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Rollup con `avg` + `n` y reagregación ponderada | Rollup con `sum` y `count` por métrica | `sum/count` por métrica es exacto aunque una métrica sea nula en parte de las muestras (`avg` de SQL ignora nulos); `avg`+`n` es más simple y exacto mientras los nulos sean todo-o-nada por cubo. Recomiendo `avg`+`n` y aceptar el error en cubos mixtos (latencias de disco ausentes en agentes antiguos). |
| Materialized views con `REFRESH` | Tablas de rollup con upsert incremental | Una MV refresca todo cada vez (cuesta lo mismo que re-agregar); el upsert de las últimas 2 h cuesta ≈12 ms medidos. |
| Caché HTTP (ETag / `If-None-Match`) | Caché en memoria por `host:range` con TTL | El hub tiene un solo proceso web (Out of Scope: múltiples réplicas), así que la caché en memoria es coherente y no añade protocolo. |
| Un HMAC por fuente | Un único `NOTIFY_INGEST_SECRET` | Dos productores del mismo operador; subclaves por fuente añaden configuración sin ganar aislamiento real. Se acota el daño de una filtración con una **lista de claves permitidas por fuente** (ver Seguridad). |

**Installation:**
```bash
# Hub: sin dependencias nuevas (node:crypto, zod, drizzle y pg ya están).
# media-stack, stacks/backup/Dockerfile: ampliar la línea apk existente
#   RUN apk add --no-cache bash ca-certificates coreutils curl findutils jq openssl rclone restic sqlite supercronic tzdata
```

**Version verification:** no se instala ningún paquete npm/PyPI/crates nuevo. `jq` y `openssl` son paquetes oficiales de Alpine 3.24, comprobados instalándolos y ejecutándolos (`openssl version` → OpenSSL 3.5.9; `jq --version` → jq-1.8.2). [VERIFIED: `docker run alpine:3.24 apk add jq openssl`]

## Package Legitimacy Audit

> El gate `package-legitimacy check` cubre `npm`, `pypi` y `crates`; esta fase **no instala ninguno**. Los dos paquetes `apk` provienen del repositorio oficial de Alpine y se verificaron instalándolos y ejecutándolos.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `jq` | Alpine 3.24 `main/community` | n/a (paquete de distro) | n/a | github.com/jqlang/jq | OK (instalado y ejecutado en `alpine:3.24`) | Approved |
| `openssl` | Alpine 3.24 `main` | n/a (paquete de distro) | n/a | github.com/openssl/openssl | OK (instalado y ejecutado en `alpine:3.24`) | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```text
            media-stack (NAS, repo ../media-stack)                         hub (webs, este repo)
 ┌───────────────────────────────────────────────┐   POST /api/notifications/ingest
 │ Seerr ──webhook──▶ issue-automator            │   X-Ingest-Timestamp, X-Ingest-Signature: v1=<hex>
 │   ISSUE_CREATED / ISSUE_RESOLVED              │        │ (Tailscale, http://<BIND_IP>:4323)
 │   (Radarr/Sonarr/Bazarr acciones intactas)    │────────┤
 │                                               │        ▼
 │ media-backup.sh (fallo de copia)              │   ┌──────────────────────────────────────────────┐
 │   ├─ escribe last-status=failed               │   │ route.ts (fuera del catch-all, sin sesión)   │
 │   ├─ publica evento (≤3 intentos, ~2 min)     │   │ 1 secreto configurado? ──no──▶ 503            │
 │   │     2xx ──▶ fin (no envía nada)           │   │ 2 readBodyText(tope) ──▶ 413                  │
 │   └─ sin 2xx ──▶ Telegram DIRECTO (prefijo)   │   │ 3 cabeceras + ventana ±5 min + HMAC           │
 │        solo backup-failed                     │   │      (actual o anterior, timingSafeEqual)     │
 └───────────────────────────────────────────────┘   │      ──no──▶ 401 (código único)               │
                                                     │ 4 zod .strict() + lista permitida por fuente  │
                                                     │      ──no──▶ 400 / 422                        │
                                                     │ 5 tx: INSERT ingest_events ON CONFLICT        │
                                                     │      conflicto + mismo fingerprint ─▶ 200 dup │
                                                     │      conflicto + otro fingerprint  ─▶ 409     │
                                                     │      nuevo ─▶ recordIncidentObservationIn(tx) │
                                                     │ 6 202 { accepted, action }                    │
                                                     └───────────────┬──────────────────────────────┘
                                                                     ▼
                            incidents + incident_events + notification_outbox (misma tx)
                                                                     ▼
              worker (lock de recolección) ─ notification-dispatch.ts ─▶ Telegram / Web Push
                                                                     ▲
      colector (cada 60 s) lee /maintenance del agente (caché 60 s) ─┘ reconcilia backup-failed
                                                                       (NO debe resolver con un ok anterior a la apertura)

 histórico:  samples (48 h) ──worker cada ~60 s: upsert de las últimas 2 h──▶ sample_rollups (15 min, 30 d)
                                                                         └──▶ container_rollups (host, contenedor, 15 min)
             overview/container-history:  1h/6h/24h ─▶ samples (cubos 30 s / 1 min / 2 min)
                                          7d ─▶ rollup 15 min   ·   30d ─▶ rollup reagregado a 1 h (media ponderada por n)
```

### Recommended Project Structure

```
src/
├── app/api/notifications/ingest/route.ts   # NUEVO: delgada; solo orquesta (declarar en routeFiles)
├── lib/
│   ├── notification-ingest.ts              # NUEVO: firma, esquema zod, lista permitida, mapeo a observación
│   ├── history-rollups.ts                  # NUEVO: rollupRecent, backfillRollups, readHistory, readContainerHistory
│   ├── notification-policy.ts              # + prefijo "issue:seerr:" (inmediata)
│   ├── runtime-config.ts                   # + ingestSecret / ingestSecretPrevious
│   ├── sensitive-actions.ts                # + routeFiles["src/app/api/notifications/ingest/route.ts"]
│   ├── incident-store.ts                   # + closedBy "ingest"; + guarda de evidencia obsoleta al resolver
│   └── schema.ts                           # + ingestEvents, sampleRollups, containerRollups
├── worker.ts                               # cleanup: samples 48 h (guardado), rollups 30 d, ingest_events 30 d; tick de rollup
drizzle/0009_*.sql, 0010_*.sql              # ingest_events; rollups (reversibles, con test sembrando la anterior)
scripts/rollback/0009_*.sql, 0010_*.sql     # precedente: scripts/rollback/0004_incidents.sql
tests/
├── notification-ingest.test.ts             # firma, ventana, idempotencia, 413, alcance por fuente, sin incidencia en rechazo
├── history-rollups.test.ts                 # agregación idempotente, backfill, lectura ponderada, retención guardada
├── overview-budget.test.ts                 # HUB_PERF=1: 500k, p95, aserción de plan
└── notification-senders.test.ts            # guarda D-22 (Telegram / Web Push solo en los dos módulos)
docs/ (o README)                            # runbook de rotación (hub); duplicado conocido de la copia (D-15)
```

`media-stack` (rama aparte): `stacks/backup/media-backup.sh`, `stacks/backup/Dockerfile`, `stacks/backup/compose.yaml`, `stacks/extras/issue-automator/main.py`, `stacks/extras/compose.yaml`, `stacks/monitoring/compose.yaml`, `stacks/monitoring/security-monitor/{main,updater}.py`, `scripts/upgrade.sh`, `scripts/merged_updates.py`, `env/catalog.json` (+ `python3 scripts/env_contract.py generate`), `docs/*`, `tests/*.test.sh`.

### Pattern 1: Ruta pública con HMAC fuera del catch-all

**What:** `src/app/api/notifications/ingest/route.ts` exporta solo `POST`. No pasa por sesión (la ruta estática gana al catch-all `[...path]`, y `proxy.ts` excluye `api` del matcher). Lee el cuerpo con `readBodyText` (el test «reads no request body outside request-body.ts» prohíbe `request.text()` en `src/app/api` y `src/lib`).
**When to use:** única ruta de entrada de máquinas al hub.
**Example:**
```typescript
// Propuesta de diseño (no existe aún). Patrón tomado de src/app/api/auth/[...all]/route.ts.
import { createHmac, timingSafeEqual } from "node:crypto";
import { BodyTooLarge, readBodyText } from "@/lib/request-body";

const INGEST_BODY_LIMIT = 8 * 1024;
const WINDOW_SECONDS = 300;

function sign(secret: string, timestamp: string, rawBody: string): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
}

function matches(secret: string, timestamp: string, rawBody: string, hex: string): boolean {
  const provided = Buffer.from(hex, "hex");               // 64 hex => 32 bytes; otra longitud falla abajo
  const expected = sign(secret, timestamp, rawBody);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
// Evaluar SIEMPRE actual y anterior (sin cortocircuito) antes de decidir: no filtra cuál coincidió.
```
La firma `HMAC-SHA256(secret, "<timestamp>.<cuerpoCrudo>")` en hex es la misma en Node (`createHmac`) y en `openssl dgst -sha256 -hmac` dentro de `alpine:3.24` (comprobado con el mismo vector: `49f24e53…1686` en ambos). [VERIFIED: ejecución esta sesión]

### Pattern 2: Idempotencia en la misma transacción que la incidencia

**What:** `INSERT INTO ingest_events … ON CONFLICT DO NOTHING RETURNING` y, solo si insertó, `recordIncidentObservationIn(tx, …)`, todo en `db.transaction`. Si la incidencia falla, la fila de idempotencia se revierte y el reintento del productor se procesa; si fuera una escritura previa e independiente, el reintento chocaría con «duplicado» y el aviso se perdería.
**When to use:** siempre; es el invariante de CONT-02.
**Example:**
```typescript
// Propuesta de diseño. recordIncidentObservationIn(tx, input) existe y acepta una transacción ajena.
// [VERIFIED: src/lib/incident-store.ts:674 `export async function recordIncidentObservationIn(`]
const outcome = await db.transaction(async (tx) => {
  const [inserted] = await tx.insert(ingestEvents)
    .values({ id: `${event.source}:${event.eventId}`, fingerprint })
    .onConflictDoNothing().returning({ id: ingestEvents.id });
  if (!inserted) {
    const [seen] = await tx.select().from(ingestEvents).where(eq(ingestEvents.id, id)).limit(1);
    return seen.fingerprint === fingerprint ? ({ kind: "duplicate" } as const) : ({ kind: "conflict" } as const);
  }
  const result = await recordIncidentObservationIn(tx, observation);   // abre, observa o resuelve
  return { kind: "accepted", result } as const;
});
```
`fingerprint` = `sha256(cuerpoCrudo)` hex: un reintento del productor con la misma carga y otra marca de tiempo conserva el hash.

### Pattern 3: Política de la clave de issue (inmediata a cualquier severidad)

**What:** ramas explícitas por prefijo en `notificationPolicy`, como ya se hace con `container:` y `helper-cleanup`. Sin la rama, una clave no auditada cae al digest y `pushWarnings` la convertiría en push.
**Example:**
```typescript
// Propuesta: añadir junto a SILENT_PREFIX = "container:" (notification-policy.ts:41)
const SEERR_ISSUE_PREFIX = "issue:seerr:";
if (key.startsWith(SEERR_ISSUE_PREFIX))
  return { channel: "telegram", reason: "policy_immediate", digest: false, immediate: true };
```
El nombre `issue:seerr:<id>` es compatible con la clave `issue:seerr` que ya usa el auditor de la fase 1 para la familia `issue-incident`. [VERIFIED: 01-01-PLAN.md `issue-incident` con `key = "issue:seerr"`]

### Pattern 4: Lectura de histórico por tabla según el rango

**What:** `ranges` pasa de `[segundos, cubo]` a incluir el origen. 1h/6h/24h: SQL actual sobre `samples`; 7d: rollup de 15 min directo; 30d: rollup reagregado a 1 h con media ponderada. Se conserva el `generate_series … LEFT JOIN` para los huecos y **las mismas columnas** (`cpu, memory, swap, rx, tx, ioRead, ioWrite, load1, load5, load15, readAwait, writeAwait, utilization`), de modo que la UI no cambia.
**Example (medido, 1,9 ms sobre 2.779 filas de rollup):**
```sql
WITH series AS (SELECT generate_series(
    date_bin(interval '1 hour', now() - interval '30 days', timestamp '2000-01-01'),
    date_bin(interval '1 hour', now(), timestamp '2000-01-01'), interval '1 hour') AS at),
g AS (SELECT date_bin(interval '1 hour', bucket, timestamp '2000-01-01') AS at,
        sum(cpu*n) / nullif(sum(n) FILTER (WHERE cpu IS NOT NULL), 0) AS cpu
      FROM sample_rollups WHERE "hostId" = $1 AND bucket > now() - interval '30 days' GROUP BY 1)
SELECT series.at, g.cpu FROM series LEFT JOIN g USING(at) ORDER BY series.at;
```

### Pattern 5: Tick de rollup en el worker, idempotente y recalculable

**What:** cada ~60 s (nueva dependencia opcional de `workerTurn`, como `updates`), recalcular con upsert los cubos desde `date_bin(15min, now() - 2h)` hasta ahora, **en una transacción que escribe `sample_rollups` y `container_rollups` a la vez**. Como las crudas viven 48 h, cualquier cubo reciente se puede recalcular sin pérdida; el cubo abierto se actualiza en cada tick y no hace falta unir crudas al rollup en lectura. Medido: 12 ms por tick.
**Why:** evita la ventana ciega de «agregar al cerrar el cubo» y no depende del ciclo de limpieza horario (`WORKER_CLEANUP_MS = 3_600_000`, `worker-loop.ts:15`), que dejaría el borde derecho del gráfico 7d hasta una hora atrasado.

### Pattern 6: Retención de crudas que se protege sola

**What:** borrar de `samples` solo filas con `at < now - 48 h` **cuyo cubo ya exista en `sample_rollups`** (`EXISTS (SELECT 1 FROM sample_rollups r WHERE r."hostId" = s."hostId" AND r.bucket = date_bin(…15min…, s.at))`), en lotes (p. ej. 20k filas por sentencia) y conservando siempre la última muestra de cada host. Así D-20 («poblar antes de acortar») se cumple por construcción: si el backfill no llegó, no se borra, sin marcadores ni orden de despliegue frágil. Como `container_rollups` se escribe en la misma transacción que el cubo de `sample_rollups`, la presencia del segundo implica la del primero.

### Anti-Patterns to Avoid
- **Escribir `ingest_events` fuera de la transacción de la incidencia:** un fallo entre ambas «quema» el evento y el reintento queda rechazado como duplicado.
- **Resolver `backup-failed` con cualquier `ok`:** el snapshot obsoleto cierra la incidencia recién abierta por el ingest (ver Pitfall 1).
- **Confiar en el texto del productor:** para la copia, el hub compone título y detalle desde la clave (como el colector); para Seerr, desde campos estructurados. Nunca reenviar HTML de issue-automator: el cliente de Telegram del hub no fija `parse_mode`. [VERIFIED: `src/lib/telegram.ts:5` «The client never sets `parse_mode`»]
- **Reutilizar `routeManifest` para el ingest:** el catch-all dispara un test que exige que cada `route === "…"` esté declarado; el ingest vive en `routeFiles`, no en el manifiesto.
- **Agregar el rollup solo en el ciclo de limpieza:** deja huecos y retraso de hasta 1 h.
- **Un `DELETE` único de ≈400k filas JSONB:** transacción larga y mucho WAL; borrar por lotes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Firma y comparación | Hash casero, `===` sobre hex | `createHmac` + `timingSafeEqual` (Node) y `hmac.compare_digest`/`hmac.new` (Python) | Evita ataques de temporización y errores de codificación; ya es el patrón del hub. |
| Escapar JSON en bash | `printf` con comillas a mano | `jq -n --arg …` | `errors[]` de la copia puede traer comillas, saltos de línea o rutas raras; un JSON malformado rompe la firma y cae al fallback sin motivo. |
| Cuerpo acotado | `request.text()` directo | `readBodyText(request, limit)` | Un test del repo prohíbe leer cuerpos fuera de `request-body.ts`; además cuenta bytes en streaming. |
| Idempotencia | Caché en memoria o «mira si existe y luego inserta» | `INSERT … ON CONFLICT DO NOTHING RETURNING` en la transacción | Carreras entre dos reintentos simultáneos y reinicios del proceso. |
| Unicidad de incidencia abierta | Lógica propia | `incidents_open_host_key_idx` (índice parcial) + `recordIncidentObservationIn` | Ya arbitra aperturas concurrentes (`onConflictDoNothing` + re-lectura). |
| Edición del mensaje al cerrar | Un segundo `sendMessage` | `closeEpisode` dentro de `recordIncidentObservationIn` con `failing: false` | D-05 e INCD-03: el outbox edita el original. [VERIFIED: `incident-store.ts:722` `const delivery = await closeEpisode(tx, open, seq, at);`] |
| Cubos de tiempo | Aritmética de epoch en JS | `date_bin(interval, ts, timestamp '2000-01-01')` | Mismo ancla que el overview; 15 min divide 1 h, así que los cubos alinean. |
| Percentiles del presupuesto | Media o máximo | p95 por rango ordenado (nearest-rank) sobre ≥50 ejecuciones tras calentar | D-21 pide p95; la media oculta la cola. |
| Retención por lotes | `DELETE` monolítico | Bucle de lotes con `LIMIT` sobre `id` | Tamaño de transacción y WAL con filas JSONB de ≈2 KB. |
| Reintentos del productor | Cola persistente en `issue-automator` | 2–3 intentos en proceso con el mismo `eventId` | El contenedor no tiene estado; una cola durable es un subsistema nuevo (ver Open Question 5). |

**Key insight:** casi toda la complejidad nueva es de **orden y de bordes** (qué se despliega antes, qué cierra qué incidencia, qué se borra antes de agregar), no de algoritmos. Reutilizar las fronteras transaccionales que el hub ya tiene es lo que mantiene el diseño pequeño.

## Runtime State Inventory

> Fase de cutover/retirada de emisores, no un rename; el inventario se limita a lo que sobrevive al apagado y que un grep no encuentra.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `media-stack` guarda colas de avisos persistentes en el appdata del monitor: `notifications.json` (`merged_updates.py:150`) y `update-notifications.json` (`updater.py:303`). Tras el cutover nadie las lee. Si se revierte (D-10), el código viejo las vaciaría y enviaría avisos antiguos. Hub: filas `samples` > 48 h (se borran, D-20), `ingest_events` nuevas. | Task: tras el cutover, borrar a mano las dos colas (checklist del operador). Task: pg_dump antes del primer despliegue con retención de 48 h (precedente `webs:~/hub-backups/pre-phase07-202611271945.dump`, STATE.md). |
| Live service config | Seerr: el webhook se configura **en la UI** (`docs/profiles.md:240`: «Seerr > Settings > Notifications > Webhook … notification type **Issue Reported**»), no en git. Hay que añadir «Issue Resolved». Seerr solo tiene una ranura de agente webhook. BotFather: el token vive allí. | Paso humano documentado en `docs/profiles.md` y en el checklist; verificar con una carga real (A3). |
| OS-registered state | NAS: temporizadores systemd del seguidor (`--follow-merges`) y de `upgrade.sh install` y de `security-update`. El seguidor es el que aplica la release; `pause-follower` es una acción protegida del hub. Posible emisor SMART fuera de los dos repos (A1). | Documentar `pause-follower` como palanca de espera. Paso humano: revisar `smartd`/cron/otras herramientas del NAS (A1). |
| Secrets/env vars | `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` hoy en: backup, issue-automator, security-monitor, WUD (`WUD_TRIGGER_TELEGRAM_TELEGRAM_BOTTOKEN/CHATID`) y los lee en el host `upgrade.sh` (`setting TELEGRAM_BOT_TOKEN`) y `merged_updates` (vía `docker exec … main.telegram`). Alcance `apps-server` del catálogo también los declara. Nuevos: `NOTIFY_INGEST_URL`, `NOTIFY_INGEST_SECRET`, `NOTIFY_INGEST_HOST_ID` en `media-stack`; `NOTIFY_INGEST_SECRET` (+ `_PREVIOUS` opcional) en el hub. | Task: tras el cutover solo `backup` conserva `TELEGRAM_*`; quitarlos de los otros servicios y del alcance `apps-server` del catálogo. Runbook: tres `.env` (hub en `webs`, Instance en el NAS, apps-server si conserva la variable). |
| Build artifacts / installed packages | Imagen local `media-stack-backup:local` (no incluye `jq`/`openssl` hasta reconstruir); imágenes `issue-automator` y `security-monitor` locales. El seguidor reconstruye y recrea solo los servicios afectados. | Task: el cambio de `Dockerfile` y de `compose.yaml` tiene que quedar en el manifiesto de servicios afectados; el test `backup-image.test.sh` ya construye la imagen. |

**Nothing found in category «Secrets del hub en runtime»:** el hub no persiste el token ni el secreto en la base; solo en `.env` y en memoria del proceso. [VERIFIED: `runtime-config.ts` lee `env.TELEGRAM_BOT_TOKEN`; ningún `insert` lo guarda]

## Common Pitfalls

### Pitfall 1: El colector resuelve con un `ok` obsoleto la incidencia que acaba de abrir el ingest
**What goes wrong:** `media-backup.sh` escribe `failed <fecha>` en `last-status` y luego publica el evento. El ingest abre `nas-home:backup-failed` y encola el mensaje. El colector lee `/maintenance` cada 60 s (`ALERT_SNAPSHOT_INTERVAL_MS = 60_000`, `collector.ts:42`) y el agente cachea 60 s (`os.getenv("MAINTENANCE_CACHE_SECONDS", "60")`, `agent/maintenance.py:795`): hasta ~2 min después puede llegar el `ok` de ayer, `maintenanceAlertSignals` emite `failing: false`, `recordIncidentObservationIn` cierra la fila (`closeEpisode` edita el mensaje a «resuelta») y, con el siguiente snapshot `failed`, **inserta una fila nueva** y un segundo mensaje.
**Why it happens:** antes de esta fase la apertura y el cierre salían de la misma fuente (el snapshot) y eran coherentes; el ingest añade una segunda fuente más rápida.
**How to avoid:** añadir a `IncidentObservation` una evidencia opcional (p. ej. `evidenceAt`) y, en la rama `!input.failing`, devolver `ignored` si `open.at` (hora de apertura, `incidents.at`) es posterior a esa evidencia. El colector pasa `backup.at` del snapshot. Alternativa equivalente: que `maintenanceAlertSignals` no emita `backup-failed` resuelto cuando `backup.at` es anterior a la apertura. Test: «ingest abre, snapshot `ok` con `at` anterior no cierra, snapshot `ok` con `at` posterior sí cierra».
**Warning signs:** dos mensajes de `backup-failed` con segundos de diferencia y uno editado a «resuelta».

### Pitfall 2: Fusionar `media-stack` en `main` despliega el cutover antes de probar el ingest
**What goes wrong:** ADR-0007: fusionar en `main` equivale a aprobar el despliegue; `auto-release.yml` publica tras CI verde (también a las 02:00 UTC) y el seguidor del NAS aplica la release en ≤5 min. Los emisores quedarían apagados con el ingest sin desplegar o sin probar.
**Why it happens:** el orden obligatorio de D-11 es una convención humana; el pipeline no la conoce.
**How to avoid:** el plan deja el trabajo de `media-stack` en una **rama con PR** (CI corre en `pull_request`: `.github/workflows/ci.yml` tiene `on: push, pull_request`), y la fusión es un `checkpoint:human-action` posterior a los eventos de prueba. Palanca adicional si hiciera falta: añadir `docs/releases/vX.Y.Z.md` hace que `auto-release.sh` salga con «release notes are already being prepared» y la release se publique a mano con `scripts/release.sh`. Un `BREAKING CHANGE:` en el mensaje **no** detiene el seguimiento de merges (solo sube el major).
**Warning signs:** una release `chore(release): vX` aparece tras fusionar antes del checkpoint.

### Pitfall 3: `issue-automator` reprocesa el issue (otra vez blocklist) al llegar «Issue Resolved»
**What goes wrong:** `process_webhook_payload` solo trata `TEST_NOTIFICATION`/`test`; **cualquier otro tipo** continúa y ejecuta el flujo completo (blocklist en Radarr/Sonarr + nueva búsqueda + comentario). Si el operador añade «Issue Resolved» al webhook de Seerr, el cierre dispararía otra vez la automatización. [VERIFIED: `main.py:307-313` y todo el cuerpo posterior sin filtro de tipo]
**How to avoid:** bifurcar por `notification_type` antes de cualquier acción: `ISSUE_CREATED` → flujo actual + evento `open`; `ISSUE_RESOLVED` → solo evento `resolved`; cualquier otro tipo → 200 sin efecto. Test en `tests/issue-automator.test.sh` (stdlib `unittest`).

### Pitfall 4: El tipo exacto del evento de resolución de Seerr y su `updatedAt`
**What goes wrong:** se asume `ISSUE_RESOLVED`; la documentación oficial de la plantilla solo muestra `ISSUE_COMMENT` como ejemplo y un issue del fork Jellyseerr muestra una carga `ISSUE_RESOLVED` con `issue.issue_id` y `issue_status`. [CITED: docs.seerr.dev/using-seerr/notifications/webhook/ ; github.com/fallenbagel/jellyseerr/issues/1474 (vía búsqueda)]
**How to avoid:** capturar una carga real en el evento de prueba D-09 antes de fijar el `eventId`. Diseño recomendado de `eventId` para issues: `issue:<id>:<estado>:<updatedAt de Seerr>` (se obtiene de `GET /api/v1/issue/<id>`, que issue-automator ya consulta): un reintento del mismo cambio repite el id; reabrir y resolver otra vez cambia `updatedAt` y no choca. Si Seerr no devuelve `updatedAt` (A4), usar un contador de transición.

### Pitfall 5: El 24h en crudo ya supera el presupuesto con muestreo de 5 s
**What goes wrong:** D-18 deja 1h/6h/24h en crudo. Con una pestaña visible el worker muestrea cada 5 s (17.280/día). Medido: 24h crudo = **162,5 ms** (17k filas). D-21 solo exige 30d, pero un reviewer que mida «el overview» a 24h verá un número mayor que el presupuesto.
**How to avoid:** no cambiar D-18; documentar la cifra, medirla en la prueba como **informativa** y proponer en Open Question 4 servir 24h desde el rollup si el operador lo pide.

### Pitfall 6: Tipos de tiempo distintos entre `samples` y la tabla de rollup
**What goes wrong:** `samples.at` es `timestamp` **sin zona** (`schema.ts:108-118`: `at: timestamp().notNull().defaultNow()`) y el overview une `series.at` (sin zona) con `grouped.at`. El borrador de ARCHITECTURE dice «las tablas nuevas usan `timestamptz`». Un `bucket timestamptz` unido con `series.at` sin zona depende de la zona de sesión y puede desplazar el gráfico.
**How to avoid:** declarar `bucket` como `timestamp` (sin zona), igual que `samples.at`, y mantener `date_bin(…, timestamp '2000-01-01')`; o convertir explícitamente con `AT TIME ZONE`. Test con una muestra a las 00:00 que verifique el cubo.

### Pitfall 7: La retención de 48 h borra la última muestra de un host caído
**What goes wrong:** todos los consumidores de `samples` salvo el overview leen **solo la última muestra** (`host-status.ts`, `deployment-settings.ts`, `host-commands.ts`, `operation-runner.ts`, `notification-dispatch.ts:827-830`, `renovateContainers`). Un host sin datos más de 48 h dejaría de tener «última muestra» y `hostStatuses` lo mostraría como «nunca visto».
**How to avoid:** el `DELETE` conserva la última fila por host (`NOT EXISTS` de una más reciente). [VERIFIED: grep `from(samples)` en `src/`]

### Pitfall 8: `docker compose restart` no relee `.env` (rotación del token)
**What goes wrong:** el hub declara `env_file: .env` y `media-stack` interpola `${TELEGRAM_BOT_TOKEN:-}` al **crear** el contenedor. Reiniciar no cambia el entorno; la rotación parece hecha y el camino sigue mudo (401).
**How to avoid:** el runbook usa `docker compose up -d --force-recreate worker app` (hub) y `docker compose up -d --force-recreate backup` (media-stack). [ASSUMED: comportamiento estándar de Compose para `env_file`/interpolación; la UAT de rotación lo confirma]

### Pitfall 9: La ventana ciega de la rotación y los avisos que fallan en ella
**What goes wrong:** BotFather sustituye el token sin solape (A5). Entre revocar y recrear los contenedores, cualquier envío del hub recibe 401 (`httpReason` → `telegram_401`, `telegram.ts:181`), que el hub registra como fallo visible y no reintenta indefinidamente; los avisos de esa ventana quedan en estado «fallido».
**How to avoid:** runbook: preparar ambos `.env` **antes** de revocar, revocar, editar y recrear en un solo paso, comprobar `getMe` con el token nuevo **sin ponerlo en argv** (`curl -K -` con la URL por stdin, como ya hace `upgrade.sh`), y revisar en el hub las entregas fallidas de la ventana.

### Pitfall 10: Quitar `notify` de `merged_updates` rompe el flujo si se deja el outbox a medias
**What goes wrong:** `merged_updates.py` encola en `notifications.json` y `updater.notify` hace `docker exec … main.telegram`; `security-monitor/main.py` `run()` llama a `notify(digest(updates))` y su fallo propaga excepción. Si se elimina `telegram()` pero quedan llamadores, `docker exec` falla en el seguidor («Notification pending; deployment state is retained») o el monitor termina con error.
**How to avoid:** eliminar de una vez `telegram`, `notify`, `flush_notifications`, `notify_outcome` y el parámetro `notify=` de `run()` y de los tests que lo parchean (`tests/merged-updates.test.sh:98,138`, `tests/security-update.test.sh:43-46`, `tests/security-monitor.test.sh:61-63`). El resto de la lógica (historial `notified-updates.json`, `attempted-updates.json`, estado `last-status.json`) no cambia.

### Pitfall 11: Los tests actuales de `media-stack` afirman la existencia de Telegram
**What goes wrong:** `tests/template.test.sh:229-236` exige `WUD_TRIGGER_TELEGRAM_*`; `tests/backup.test.sh:262-270` exige `api.telegram.org/bot123:abc/sendMessage` ante un fallo; `tests/issue-automator.test.sh` afirma `telegram` en `load_config`. Son los tests que hay que invertir/reescribir, y la guarda nueva (ningún `api.telegram.org` ni `TELEGRAM_` fuera de `backup`) es la que cierra D-09 para las familias que solo se apagan.

### Pitfall 12: El token en argv del fallback
**What goes wrong:** `alert()` pasa `https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage` como argumento de `curl` (`media-backup.sh`, línea 144): visible en la lista de procesos del contenedor. `upgrade.sh` ya evita eso con `curl -K -` (URL por stdin). Con `openssl dgst -hmac "$secret"` el secreto HMAC también queda en argv (no hay opción de fichero de clave).
**How to avoid:** en el fallback, mover la URL a `-K -`. El secreto HMAC en argv se acepta (contenedor aislado, un solo usuario, `RESTIC_PASSWORD` ya está en su entorno) y se documenta como riesgo residual bajo. El test existente captura `$*` de un `curl` falso; con `-K -` hay que capturar también stdin (cambio de test, no de comportamiento).

### Pitfall 13: Alcanzabilidad contenedor NAS → hub por Tailscale
**What goes wrong:** el hub publica `${BIND_IP:-127.0.0.1}:${PORT:-4323}:3000` (`compose.yaml:34-35`) y el README configura `BIND_IP` con la IP de Tailscale del servidor de apps. Un contenedor Docker del NAS sale por NAT del host; funciona si el host tiene ruta a esa IP de Tailscale, pero no se probó. La entrada pública (NPM de Oracle) también llega a la misma ruta: el ingest queda **expuesto a Internet** con solo HMAC como barrera.
**How to avoid:** `NOTIFY_INGEST_URL` apunta a `http://<IP Tailscale del servidor de apps>:4323/api/notifications/ingest`; el evento de prueba D-09 desde cada contenedor confirma la ruta (A2). Como la ruta es pública, la verificación HMAC/ventana/cuerpo ocurre **antes** de cualquier acceso a la base.

### Pitfall 14: Un secreto nuevo obligatorio puede impedir arrancar el hub en el deploy
**What goes wrong:** el `.env` del hub vive solo en el servidor; el workflow `Deploy` ejecuta `docker compose up -d --build` y espera la salud de la app. Si `NOTIFY_INGEST_SECRET` fuese obligatoria en `runtime-config.ts` y aún no estuviese en el `.env`, `check-runtime-config` rechazaría el arranque y el deploy fallaría.
**How to avoid:** secreto **opcional** en el arranque: ausente → la ruta responde 503 con código finito (el productor lo trata como «sin confirmación»); presente → se valida longitud ≥32 y que no sea un valor de ejemplo (reutilizar `isExampleValue` y `MIN_SECRET_LENGTH = 32`); `NOTIFY_INGEST_SECRET_PREVIOUS` sin la actual → `incomplete_pair`. El `.env` se edita **antes** de empujar el commit.

### Pitfall 15: Ingest «abre» sin que el colector conozca la clave de Seerr
**What goes wrong:** ninguna otra parte del hub cierra claves `issue:seerr:*`: no hay reconciliación por snapshot. Si el evento `resolved` se pierde (hub caído, Seerr sin tipo suscrito), la incidencia queda abierta indefinidamente (la limpieza solo borra resueltas antiguas) y ensucia «abiertas ahora».
**How to avoid:** ver Open Question 3 (cierre automático por antigüedad o sondeo de estado desde issue-automator).

## Code Examples

### Valores verificados del hub (citados literalmente)

```typescript
// src/lib/notification-policy.ts:25-31  [VERIFIED: leído esta sesión]
const CRITICAL_IMMEDIATE_KEYS = new Set([
  "connection",
  "temperature",
  "backup-failed",
  "stack-unit-failed",
  "deploy-failed",
]);
```
```typescript
// src/lib/incident-store.ts:44  [VERIFIED]
  closedBy?: "collector" | "lifecycle" | "reconciliation";
// src/lib/digest-content.ts:345 solo excluye cierres sintéticos de 'migration-dedup'; un closedBy "ingest" cuenta como resuelta.
```
```typescript
// src/app/api/[...path]/route.ts:93-99  [VERIFIED]
const ranges = {
  "1h": [3600, 30],
  "6h": [21600, 60],
  "24h": [86400, 120],
  "7d": [604800, 900],
  "30d": [2592000, 3600],
} as const;
```
```typescript
// src/worker.ts:166-167  [VERIFIED]  (cutoff común a samples, incidencias y operations)
            const cutoff = new Date(Date.now() - 30 * 86400000);
            await db.delete(samples).where(lt(samples.at, cutoff));
```
```typescript
// src/lib/sensitive-actions.ts:233-244  [VERIFIED]  routeFiles: la ruta nueva se declara aquí
export const routeFiles = {
  "src/app/api/[...path]/route.ts": { dispatch: "catch-all" },
  "src/app/api/auth/[...all]/route.ts": {
    dispatch: "better-auth",
    policy: exempt("Better Auth valida credenciales y limita intentos; el cuerpo se acota en su envoltorio de 32 KiB"),
  },
} satisfies Record<string, { dispatch: "catch-all" } | { dispatch: "better-auth"; policy: Policy }>;
// Hay que ampliar la unión con { dispatch: "hmac-ingest"; policy: Policy } y añadir la entrada;
// tests/sensitive-actions.test.ts:298-307 compara los route.ts reales con Object.keys(routeFiles).
```

### Valores verificados de `media-stack` (citados literalmente)

```bash
# stacks/backup/media-backup.sh:137-146 y 148-157  [VERIFIED]
alert() {
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log "Telegram is not configured, no alert sent"
    return
  fi
  curl -fsS --max-time 20 -o /dev/null \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$1" \
    "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    || log "could not send the Telegram alert"
}
# finish(): echo "failed $(date -Iseconds)" > "$STATE_DIR/last-status"  → luego alert "$(printf 'Backup of %s FAILED:\n' "$BACKUP_HOST"; …)"
```
```yaml
# stacks/monitoring/compose.yaml:92-96 (WUD)  [VERIFIED]
      WUD_TRIGGER_TELEGRAM_TELEGRAM_THRESHOLD: major-only
      WUD_TRIGGER_TELEGRAM_TELEGRAM_ONDIGEST: "false"
      # With these empty, WUD only logs that the trigger is off.
      WUD_TRIGGER_TELEGRAM_TELEGRAM_BOTTOKEN: ${TELEGRAM_BOT_TOKEN:-}
      WUD_TRIGGER_TELEGRAM_TELEGRAM_CHATID: ${TELEGRAM_CHAT_ID:-}
# También TELEGRAM_BOT_TOKEN/CHAT_ID en monitoring/compose.yaml:24-25 (security-monitor),
# extras/compose.yaml:30-31 (issue-automator) y backup/compose.yaml:25-26 (backup, el único que se queda).
```
```python
# stacks/extras/issue-automator/main.py:312-314  [VERIFIED]  (único filtro de tipo existente)
    # Handle test webhooks
    if notif_type in ("TEST_NOTIFICATION", "test"):
        send_telegram("🧪 <b>Test de conexión recibido</b>\n\n…")
```

### Firma en bash dentro de la imagen `backup` (verificada con Alpine 3.24)

```bash
# Propuesta; la firma es idéntica a createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")
sign() {  # $1 = timestamp, $2 = cuerpo
  printf '%s.%s' "$1" "$2" | openssl dgst -sha256 -hmac "$NOTIFY_INGEST_SECRET" -hex | sed 's/^.* //'
}
publish_ingest() {  # una vez por intento: mismo $body, marca de tiempo nueva
  local ts code
  ts="$(date +%s)"
  code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H 'Content-Type: application/json' -H "X-Ingest-Timestamp: $ts" \
    -H "X-Ingest-Signature: v1=$(sign "$ts" "$body")" \
    --data-binary "$body" "$NOTIFY_INGEST_URL")" || return 1
  [[ "$code" =~ ^2[0-9][0-9]$ ]]
}
# body="$(jq -nc --arg id "$event_id" --arg label "$BACKUP_HOST" … '{v:1,source:"backup",…}')"
# --data-binary con la MISMA cadena firmada: ni salto de línea final ni recodificación.
# Retrasos entre intentos sobreescribibles por entorno para que el test no duerma (p. ej. INGEST_RETRY_DELAYS="30 60").
```

### Firma en Python (`issue-automator`, solo stdlib)

```python
# Propuesta; mismo esquema.
import hashlib, hmac, json, time, urllib.request

def sign(secret: str, timestamp: str, body: bytes) -> str:
    return hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
# El eventId se calcula una vez por transición; el reintento en proceso reutiliza el cuerpo y cambia solo la marca de tiempo.
```

### Contrato de ingest propuesto (v1)

| Elemento | Valor |
|----------|-------|
| Ruta / método | `POST /api/notifications/ingest` (solo `POST`; `GET` → 405 por defecto de Next) |
| Cabeceras | `X-Ingest-Timestamp: <segundos Unix, 10 dígitos>`; `X-Ingest-Signature: v1=<64 hex>`; `Content-Type: application/json` |
| Firma | `HMAC-SHA256(secreto, "<timestamp>.<cuerpo crudo>")`; el hub prueba actual y anterior |
| Ventana | `|ahora − timestamp| ≤ 300 s` (pasado y futuro) |
| Cuerpo (≤ 8 KiB, `zod .strict()`) | `{ v: 1, source: "backup" \| "issue-automator", eventId: ≤128 [A-Za-z0-9._:-], hostId, key, state: "open" \| "resolved", data: {…acotados} }` |
| Lista permitida | `backup`: `key = "backup-failed"` (abrir y resolver); `issue-automator`: `key = /^issue:seerr:\d{1,9}$/` (abrir y resolver). Todo lo demás → 422. `hostId` debe existir en `getHosts()`. |
| Respuestas | `202 {status:"accepted", action}`; `200 {status:"duplicate"}` (mismo `source:eventId` y mismo hash: sin efectos); `409` (mismo id, otro contenido); `400` esquema/JSON; `401` firma/ventana/cabeceras (**un único código**); `413` cuerpo; `422` clave o fuente no permitida; `503` secreto no configurado o base no disponible |
| Formato del aviso | lo compone el hub. `backup-failed`: título y detalle como el colector (`Copia fallida en <host>`); `issue:seerr:`: título/detalle desde `data` en texto plano, sin HTML y con longitudes acotadas |

La respuesta a un duplicado es 2xx a propósito: el reintento de la copia (D-12) tras perder la respuesta del primer intento debe contar como confirmación, o caería al fallback y duplicaría el aviso. «Se rechaza sin crear incidencia» (criterio 1) se cumple: no hay fila nueva ni outbox nuevo. Ver Open Question 1.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Cada emisor de `media-stack` formatea y envía a Telegram | El hub decide y formatea; los productores publican eventos firmados | Esta fase (decisión de la fase 8 en STATE.md) | Una sola política; la copia conserva solo un fallback estrecho |
| Histórico re-agregado desde crudas en cada poll | Rollup de 15 min + lectura ponderada | Esta fase | 30d: 4,65 s → 1,9 ms medidos |
| Retención única de 30 días para todo | Crudas 48 h, rollups 30 d, `ingest_events` 30 d | Esta fase | La base deja de crecer ≈1 GB por host cada 30 d |
| `notify()` como camino de envío del hub | Solo `notification-dispatch.ts` y `digest-runs.ts` | Fase 2 (commit `4d15f3f`) | Falta la guarda estática (D-22) |

**Deprecated/outdated:**
- `media-stack` `scripts/upgrade.sh` `notify()`, `merged_updates.py` `notify` y `security-monitor` `telegram()`: se eliminan (D-01, D-02).
- Trigger de Telegram de WUD: se elimina (D-03).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | El emisor SMART («unknown-smart», 2 mensajes el 25 abr) no vive en ninguno de los dos repos (la auditoría lo anotó «sin código en ninguno de los dos repos» y esta sesión no encontró `smartctl`/`smartd` en `media-stack`); probablemente es `smartd`, un cron o una herramienta del NAS | Runtime State Inventory, Open Questions | Si sigue activo tras el cutover, llegará un aviso fuera del hub. Mitigación: el hub ya cubre SMART con `disk-health` (`fail` inmediata, `watch` digest), así que basta apagar la fuente en el NAS; es un paso humano, el ejecutor no entra por SSH (D-11) |
| A2 | Un contenedor del NAS alcanza `http://<IP Tailscale del servidor de apps>:4323` (NAT del host + `tailscale0`) | Pitfall 13, Architecture | El ingest nunca confirma y la copia cae siempre al fallback. El evento de prueba D-09 lo detecta antes del cutover; alternativa: URL pública por NPM (expone el ingest a Internet) |
| A3 | Seerr emite `ISSUE_RESOLVED` al webhook cuando se suscribe «Issue Resolved» y la carga trae `issue.issue_id` | Pitfall 4 | Si el tipo se llama distinto o no llega, las incidencias de Seerr nunca se cierran. Capturar una carga real en D-09 |
| A4 | El objeto issue de Seerr (`GET /api/v1/issue/<id>`) trae `updatedAt` | Pitfall 4 | Sin él, el `eventId` de reapertura necesita otro discriminante (contador) |
| A5 | BotFather invalida el token anterior en el momento de revocar y no hay solape de dos tokens | Pitfall 9, Rotación | Si hubiera solape, la ventana ciega desaparecería y el runbook se simplifica; la documentación de funciones de bots consultada no menciona `/revoke` (solo `/token`) |
| A6 | `docker compose restart` no relee `env_file`/interpolación y `up -d --force-recreate` sí | Pitfall 8 | Si fuese al revés el runbook sobra un paso; es inocuo recrear |
| A7 | Una respuesta 401 de Telegram termina en fallo visible no reintentado (como 400/403) | Pitfall 9 | Si se reintentara indefinidamente, los avisos de la ventana de rotación llegarían solos tras recrear; mejor aún |
| A8 | El `postgres:18` de producción tiene zona UTC por defecto (los `timestamp` sin zona de `samples` dependen de ello) | Pitfall 6 | Un desplazamiento de zona movería los cubos; el test de cubo a las 00:00 lo detecta |
| A9 | Las cifras de rendimiento (4,65 s / 1,5 s / 162 ms / 1,9 ms / 19,6 s / 33,9 s) de esta máquina son representativas en orden de magnitud del servidor `webs` | Summary, Validation | El servidor de producción puede ser más lento; el presupuesto de 150 ms tiene ~75× de margen en 30d desde rollup, no en 24h crudo |
| A10 | La imagen de `backup` basada en `alpine:3.24` mantiene `jq` y `openssl` disponibles en `apk` mientras Renovate sube la base | Standard Stack | Un cambio de Alpine que renombre paquetes rompería el build; `backup-image.test.sh` lo detecta |

## Open Questions

1. **¿Qué significa «evento repetido se rechaza» para el reintento de la copia?**
   - What we know: el criterio 1 pide que un evento repetido «se rechace sin crear incidencia»; D-12 exige 2xx para dar por confirmado.
   - What's unclear: si «rechazar» incluye un 4xx.
   - Recommendation: duplicado → `200 {status:"duplicate"}` (sin efectos), conflicto de contenido → `409`. Confirmar con el usuario si prefiere 409 también para el duplicado exacto; entonces el script debe tratar 409-duplicado como confirmación, lo que complica el contrato.

2. **¿Cómo se prueba la copia sin dejar `backup-failed` abierta?**
   - What we know: D-09 pide un evento firmado de prueba de la copia y ver incidencia y mensaje. Con la guarda del Pitfall 1, un `ok` anterior al evento no lo cierra; solo el siguiente backup real (04:00) lo haría.
   - Recommendation: permitir `state:"resolved"` de la fuente `backup` y un subcomando `media-backup notify-test` que publique abrir y resolver con `eventId` de prueba. Alternativa: aceptar que quede abierta hasta la copia de esa noche.

3. **¿Qué cierra una incidencia de Seerr si se pierde el evento de resolución?**
   - What we know: ningún snapshot reconcilia las claves `issue:seerr:*`; D-05 solo define el cierre por evento.
   - Recommendation: lo mínimo que cumple D-05 es nada más; si se quiere red de seguridad, un cierre por antigüedad (p. ej. 14 días, `closedBy: "ingest-expired"`) en el ciclo de limpieza, sin mensaje. Decisión del usuario.

4. **¿Se sirve 24h desde el rollup?**
   - What we know: 24h crudo mide ≈162 ms con 5 s de muestreo; D-18 lo deja en crudo.
   - Recommendation: no tocar D-18; medir y publicar la cifra; si el operador quiere el overview completo bajo 150 ms en todos los rangos, sería otra decisión.

5. **¿Reintentos de `issue-automator` si el hub está caído?**
   - Recommendation: 2–3 intentos en proceso con el mismo `eventId`; si fallan, se registra en log y se pierde el aviso (no hay reconciliación posible, a diferencia de la copia). Aceptar la pérdida; una cola durable es otra fase.

6. **¿Mantener o retirar el alcance `apps-server` de `TELEGRAM_BOT_TOKEN` en el catálogo?**
   - What we know: tras el cutover el apps-server no tiene lector del token (WUD, security-monitor, upgrade y merged-updates pierden Telegram; `backup` no está en su `compose.yaml`).
   - Recommendation: retirarlo del catálogo y de `apps-server/.env.example` y dejarlo anotado en el runbook; un `.env` que aún lo tenga solo genera un aviso «unknown setting» no bloqueante.

7. **¿Quién y cuándo ejecuta la reversión del hub si el ingest falla en producción?**
   - What we know: la migración `0009`/`0010` deben ser reversibles con script en `scripts/rollback/` (precedente 0004) y la retención de 48 h es unidireccional.
   - Recommendation: desplegar primero el ingest (migración `0009`) sin tocar la retención; desplegar rollups y la retención de 48 h en un despliegue posterior, tras el pg_dump.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | tests e implementación del hub | ✓ | 24.22.3 (CI y Dockerfile: 26) | ninguno necesario; usar `pnpm` |
| pnpm | scripts del hub | ✓ | 12.15.0 | — |
| Docker | PostgreSQL de pruebas, tests de `media-stack`, build de imágenes | ✓ | 29.8.2 | — |
| PostgreSQL de pruebas | tests con BD (`HUB_REQUIRE_TEST_DB=1`), siembra de 500k | ✓ (contenedor `hub-phase3-pg`, `127.0.0.1:55432`, `postgres:18`) | 18 | crear otro contenedor `postgres:18` |
| `psql` / `pg_isready` locales | inspección manual | ✗ | — | `docker exec hub-phase3-pg sh -c 'psql -U "$POSTGRES_USER" …'` (usado esta sesión sin leer credenciales) |
| Python 3 | `agent/` y tests de `issue-automator` | ✓ | 3.13.15 (CI: 3.14; imagen: 3.15) | — |
| ShellCheck | `scripts/check.sh fast` de `media-stack` | ✓ | instalado | imagen `koalaman/shellcheck:v0.10.0` |
| Linux GNU (Bash 4+, `flock`, `stat -c`) | `tests/*.test.sh` de `media-stack` | ✗ en macOS (Bash 3.2.57) | — | **Docker `ubuntu:24.04`** con `apt-get install sqlite3 curl jq openssl util-linux findutils python3`: `backup.test.sh` 33 passed, `issue-automator.test.sh` 13 OK (verificado). `scripts/check.sh ci` completo exige Linux: usar el CI de GitHub |
| `curl` | fallback y verificación manual | ✓ | 8.7.1 | — |
| Acceso SSH al NAS / `webs` | desplegar y probar en producción | n/a para el ejecutor (D-11) | — | `checkpoint:human-action` |
| `psql`/`pg_dump` en `webs` | backup previo a la retención de 48 h | n/a (paso humano) | — | `docker compose exec db pg_dump` |

**Missing dependencies with no fallback:**
- Ninguna para el ejecutor. Los despliegues y las rotaciones son pasos humanos explícitos.

**Missing dependencies with fallback:**
- Linux para los tests de `media-stack`: usar `ubuntu:24.04` en Docker; confiar en el CI del PR para `scripts/check.sh ci`.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^5.1.0 (hub), `unittest`/Bash (`media-stack`), Python `unittest` (`agent/`) |
| Config file | `vitest.config.ts` (`include: ["tests/**/*.test.ts"]`, alias `@`); `media-stack`: `tests/lib.sh` (runner propio) |
| Quick run command | `pnpm exec vitest run tests/notification-ingest.test.ts` (hub); `docker run --rm -v "$PWD":/repo:ro -w /repo ubuntu:24.04 bash -c 'apt-get update -qq >/dev/null; apt-get install -y -qq sqlite3 curl jq openssl util-linux findutils python3 >/dev/null; cp -r /repo /tmp/r && cd /tmp/r && bash tests/backup.test.sh'` (media-stack, desde `../media-stack`) |
| Full suite command | `pnpm typecheck && pnpm lint && pnpm test` (con `DATABASE_URL` de loopback y `HUB_REQUIRE_TEST_DB=1`), más `scripts/check.sh ci` en el CI de `media-stack` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONT-02 | HMAC inválido, cabeceras ausentes, ventana vencida (±5 min) → 401 y **cero** filas en `incidents`, `notification_outbox` e `ingest_events` | integration (BD) | `pnpm exec vitest run tests/notification-ingest.test.ts -t "rechaza"` | ❌ Wave 0 |
| CONT-02 | Mismo `source:eventId` y mismo cuerpo → 200 duplicado sin filas nuevas; mismo id con otro cuerpo → 409; carrera de dos peticiones simultáneas → una sola incidencia | integration (BD) | `pnpm exec vitest run tests/notification-ingest.test.ts -t "idempot"` | ❌ Wave 0 |
| CONT-02 | Secreto anterior aceptado, secreto desconocido rechazado; sin secreto configurado → 503 | unit + integration | `pnpm exec vitest run tests/notification-ingest.test.ts -t "secreto"` | ❌ Wave 0 |
| CONT-02 | Cuerpo > tope → 413 antes de verificar; clave/fuente fuera de la lista → 422 sin efectos | integration | `pnpm exec vitest run tests/notification-ingest.test.ts -t "alcance"` | ❌ Wave 0 |
| CONT-02 | `routeFiles` declara la ruta nueva; el test de rutas reales sigue verde | unit | `pnpm exec vitest run tests/sensitive-actions.test.ts` | ✅ (se amplía) |
| CONT-02 | Evento aceptado abre incidencia inmediata de Telegram (backup y issue) y `resolved` cierra y encola edición, sin mensaje nuevo | integration | `pnpm exec vitest run tests/notification-ingest.test.ts -t "ciclo"` | ❌ Wave 0 |
| CONT-02 (riesgo P1) | Snapshot `ok` con `at` anterior a la apertura no cierra `backup-failed`; con `at` posterior sí | integration | `pnpm exec vitest run tests/collector-alerts.test.ts -t "ingest"` | ✅ fichero existe, caso ❌ Wave 0 |
| SEC-06 | Fallo de copia: publica con ≤3 intentos y **no** llama a Telegram si hay 2xx | bash (fake `curl`) | `bash tests/backup.test.sh` (en Docker) | ✅ se reescribe |
| SEC-06 | Sin ningún 2xx: un único envío directo, solo `backup-failed`, con el prefijo fijo y sin enviar en éxito | bash | `bash tests/backup.test.sh` | ✅ se reescribe |
| SEC-06 | Ningún `api.telegram.org` ni `TELEGRAM_` fuera de `backup` en compose y fuentes de `media-stack` | bash | `bash tests/telegram-emitters.test.sh` | ❌ Wave 0 |
| CONT-02 / D-04,D-05 | `issue-automator`: `ISSUE_CREATED` publica abrir; `ISSUE_RESOLVED` publica cerrar **sin** blocklist ni búsqueda; otro tipo no hace nada; sin `send_telegram` | bash+unittest | `bash tests/issue-automator.test.sh` | ✅ se amplía |
| D-01..D-03 | upgrade/merged-updates/security-monitor/updater/WUD sin envío ni credenciales | bash | `bash tests/upgrade.test.sh && bash tests/merged-updates.test.sh && bash tests/security-update.test.sh && bash tests/security-monitor.test.sh && bash tests/template.test.sh` | ✅ se reescriben |
| PERF-01 | La salida de 7d y 30d desde rollup es equivalente (ponderada) a la agregación cruda sobre datos sembrados | integration (BD) | `pnpm exec vitest run tests/history-rollups.test.ts -t "equivale"` | ❌ Wave 0 |
| PERF-01 | Upsert idempotente: dos ticks seguidos no cambian el resultado; backfill por días sobre histórico existente | integration | `pnpm exec vitest run tests/history-rollups.test.ts -t "idempot\|backfill"` | ❌ Wave 0 |
| PERF-01 / D-20 | La retención no borra crudas cuyo cubo no esté agregado y conserva la última muestra por host | integration | `pnpm exec vitest run tests/history-rollups.test.ts -t "retención"` | ❌ Wave 0 |
| PERF-01 | Migración 0009/0010: sembrar versión anterior, `migrateAll` y `pnpm db:migrate` no reescriben; script de reversa | integration | `pnpm exec vitest run tests/migrations.test.ts` | ✅ se amplía |
| PERF-02 | p95 < 150 ms de `GET /api/overview?range=30d` (ruta real, auth simulada) con 500k muestras; informativo para 24h; plan sin Seq Scan sobre `samples` en 30d | perf (BD real) | `HUB_PERF=1 HUB_REQUIRE_TEST_DB=1 pnpm exec vitest run tests/overview-budget.test.ts` | ❌ Wave 0 |
| D-22 | Ningún módulo salvo `notification-dispatch.ts` y `digest-runs.ts` importa `sendTelegramMessage`, `editTelegramMessage`, `sendTelegramReply`, `deliverPush`, `web-push` ni contiene `api.telegram.org` | unit (estático) | `pnpm exec vitest run tests/notification-senders.test.ts` | ❌ Wave 0 |
| SEC-05 | Runbook presente y el hub lee el token en arranque (no persiste); redacción cubre el token nuevo | unit | `pnpm exec vitest run tests/telegram-redaction.test.ts tests/runtime-config.test.ts` | ✅ |
| SEC-05 | Rotación real en producción: aviso de prueba por hub y por fallback con el token nuevo | manual (one-way) | `checkpoint:human-action` con el runbook | manual-only: BotFather es interactivo y revocar es irreversible |

### Sampling Rate
- **Per task commit:** el fichero de test del área tocada (`pnpm exec vitest run tests/<área>.test.ts`; en `media-stack`, el `tests/<área>.test.sh` en Docker).
- **Per wave merge:** `pnpm typecheck && pnpm lint && pnpm test`; en `media-stack`, push de la rama y CI del PR (`scripts/check.sh ci`).
- **Phase gate:** suite completa verde en el hub, CI verde del PR de `media-stack`, `HUB_PERF=1` con p95 registrado, y la UAT humana de D-09 y D-16 antes de `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `tests/notification-ingest.test.ts` — cubre CONT-02 (firma, ventana, idempotencia, alcance, 413, ciclo de vida)
- [ ] `tests/history-rollups.test.ts` — cubre PERF-01 y D-20
- [ ] `tests/overview-budget.test.ts` — cubre PERF-02 (gated por `HUB_PERF=1`; script `test:perf` sugerido)
- [ ] `tests/notification-senders.test.ts` — cubre D-22
- [ ] `../media-stack/tests/telegram-emitters.test.sh` — cubre SEC-06 y D-09 para las familias que solo se apagan
- [ ] Casos nuevos en `tests/collector-alerts.test.ts` (evidencia obsoleta), `tests/sensitive-actions.test.ts` (`routeFiles`), `tests/migrations.test.ts` (0009/0010) y `tests/runtime-config.test.ts` (secreto del ingest)
- [ ] Reescritura de los tests de `media-stack` que afirman Telegram (Pitfall 11) y ampliación de `tests/issue-automator.test.sh`
- Framework install: ninguno (Vitest y el runner Bash ya existen); la imagen Docker de pruebas de `media-stack` es un comando, no una dependencia.

## Security Domain

> `security_enforcement` está activo (ASVS nivel 1, bloqueo en `high`, `.planning/config.json`).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (autenticación máquina a máquina) | HMAC-SHA256 con secreto compartido ≥32 caracteres, rotable con secreto anterior; `timingSafeEqual` |
| V3 Session Management | no | La ruta no usa sesión ni cookies; no debe heredar ni exigir sesión |
| V4 Access Control | yes | Lista de claves permitida por fuente y `hostId` validado contra `getHosts()`: un secreto filtrado no abre ni cierra claves arbitrarias (`connection`, `deploy-failed`…) |
| V5 Input Validation | yes | `zod .strict()` con longitudes acotadas; cuerpo ≤ 8 KiB con `readBodyText`; texto plano para Telegram (sin HTML, sin `parse_mode`) |
| V6 Cryptography | yes | `node:crypto` (`createHmac`, `timingSafeEqual`, `createHash`); `openssl`/`hmac` estándar en productores; nada hecho a mano |
| V7 Error Handling and Logging | yes | Códigos finitos en la respuesta, razón interna en log **sin** secreto, token ni cuerpo; reutilizar `redactToken` |
| V8 Data Protection | yes | Secretos solo en `.env` de servidor y en memoria; el secreto HMAC no se persiste |
| V13 API and Web Service | yes | Ruta pública con rechazo barato previo a la base (cabeceras, ventana y HMAC antes de cualquier consulta) |

### Known Threat Patterns for esta pila

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Falsificar un evento | Spoofing | HMAC sobre `timestamp.cuerpo`; 401 con código único (sin oráculo de qué falló) |
| Repetir una petición capturada | Tampering / Repudiation | Ventana ±300 s + `ingest_events` con PK `source:eventId`; conflicto de contenido → 409 |
| Temporización al comparar firmas | Information Disclosure | `timingSafeEqual` sobre buffers de igual longitud; evaluar actual y anterior sin cortocircuito |
| Inundar la ruta pública sin secreto | Denial of Service | Rechazo antes de la base; tope de cuerpo; sin trabajo de BD por petición no autenticada |
| Secreto filtrado abre o cierra incidencias reales | Elevation of Privilege | Lista permitida por fuente (backup solo `backup-failed`; issue solo `issue:seerr:<n>`); `hostId` validado |
| Inyección de contenido en el mensaje (texto de un Viewer de Seerr) | Tampering | Texto plano, saltos y longitud acotados, sin `parse_mode`, sin enlaces generados por el productor |
| Token del bot en logs o argv | Information Disclosure | `redactToken` en el hub; en `media-backup.sh`, URL por `curl -K -`; el secreto HMAC en argv del contenedor es riesgo residual bajo aceptado |
| Deriva de reloj del NAS rechaza eventos válidos | DoS (accidental) | Ventana de 5 min, log interno de `stale_timestamp` para diagnosticar; el productor cae al fallback si no hay 2xx |
| Fuga entre fuentes por `eventId` compartido | Tampering | PK incluye `source`; `eventId` con alfabeto acotado |
| Envío de Telegram nacido fuera de la política | Tampering | Guarda estática D-22 (hub) y test `telegram-emitters` (media-stack) |

## Sources

### Primary (HIGH confidence)
- Código del hub leído esta sesión: `src/lib/{notification-policy,incident-store,collector,maintenance-alerts,notification-dispatch,request-body,sensitive-actions,runtime-config,telegram,telegram-intents,worker-loop,schema,db,hosts}.ts`, `src/worker.ts`, `src/app/api/[...path]/route.ts`, `src/app/api/auth/[...all]/route.ts`, `src/proxy.ts`, `next.config.ts`, `compose.yaml`, `.github/workflows/{ci,deploy}.yml`, `tests/sensitive-actions.test.ts`, `tests/database.ts`, `scripts/migrate.ts`, `scripts/rollback/0004_incidents.sql`.
- Código de `media-stack` leído esta sesión: `stacks/backup/{media-backup.sh,Dockerfile,compose.yaml}`, `stacks/extras/{compose.yaml,issue-automator/main.py,issue-automator/Dockerfile}`, `stacks/monitoring/{compose.yaml,security-monitor/{main,updater}.py}`, `scripts/{upgrade.sh,merged_updates.py,auto-release.sh,release.sh,check.sh}`, `env/catalog.json`, `apps-server/compose.yaml`, `docs/{profiles,upgrading,backup}.md`, `docs/adr/0007-merged-release-deployment.md`, `docs/agents/{testing,navigation}.md`, `.github/workflows/{ci,auto-release}.yml`, `tests/{lib,backup,issue-automator}.test.sh`.
- Documentación del planning: `08-CONTEXT.md`, `REQUIREMENTS.md`, `STATE.md`, `01-AUDIT.md` (orden de apagado y mapa de claves), `.planning/research/{ARCHITECTURE,STACK,FEATURES,PITFALLS}.md`, `.planning/codebase/CONCERNS.md`.
- Next.js 16.4.6 local: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
- Mediciones propias en `postgres:18` (contenedor local, base temporal ya eliminada): siembra de 500k filas (32,7 s, 1.042 MB), consulta actual 30d (4.645 ms, Parallel Seq Scan con spill), 1h (4,7 ms, Index Scan), container-history 30d (1.503 ms), 24h crudo (162,5 ms), backfill de `sample_rollups` (19,6 s) y de `container_rollups` (33,9 s), lectura 30d desde rollup (1,9 ms), upsert incremental de 2 h (12,3 ms).
- Ejecución en `alpine:3.24` de `apk add jq openssl` y comparación de la firma con `createHmac`; ejecución de `tests/backup.test.sh` (33/0) y `tests/issue-automator.test.sh` (13 OK) en `ubuntu:24.04`.

### Secondary (MEDIUM confidence)
- docs.seerr.dev, página de webhook de notificaciones: variables de plantilla (`{{notification_type}}`, `{{issue_id}}`, `{{reportedBy_username}}`) y `ISSUE_COMMENT` como ejemplo; **no** lista los tipos seleccionables.
- WebSearch: un issue de Jellyseerr (fallenbagel/jellyseerr #1474) muestra una carga `ISSUE_RESOLVED` con `issue_id` e `issue_status`; Seerr tiene una sola ranura de agente webhook.

### Tertiary (LOW confidence)
- Comportamiento de BotFather (`/revoke` e invalidez inmediata) y de `docker compose restart`: conocimiento previo, marcados `[ASSUMED]` (A5, A6).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — sin dependencias nuevas; `jq`/`openssl` y la equivalencia de firma verificadas ejecutándolas.
- Architecture: HIGH — fronteras (`recordIncidentObservationIn`, `routeFiles`, `readBodyText`) leídas en código; el hueco de carrera del Pitfall 1 sale de dos constantes verificadas.
- Pitfalls: HIGH en los de código y de pipeline (ADR-0007, `auto-release.sh`, filtro de tipo de `issue-automator`); MEDIUM en Seerr y Tailscale hasta el evento de prueba.
- Performance: HIGH en el orden de magnitud (medido); el p95 real de producción lo fija la prueba repetible.

**Research date:** 2026-11-27
**Valid until:** 2026-12-27 para el hub y `media-stack` (30 días; ambos repos se mueven por fases y Renovate toca las bases de imagen cada pocos días)
