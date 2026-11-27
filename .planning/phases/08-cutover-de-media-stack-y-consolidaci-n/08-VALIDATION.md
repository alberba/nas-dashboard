---
phase: "08"
slug: "cutover-de-media-stack-y-consolidaci-n"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-27"
---

# Fase 8 · Estrategia de validación

> Contrato de validación de la fase para muestrear el resultado durante la ejecución. Sale de la [investigación](08-RESEARCH.md#validation-architecture).

---

## Infraestructura de pruebas

| Propiedad | Valor |
|-----------|-------|
| **Framework** | Hub: Vitest ^5.1.0 (Node, sin jsdom). `media-stack`: runner Bash propio (`tests/lib.sh`) y `unittest` de Python |
| **Configuración** | `vitest.config.ts` (alias `@` a `src`, `include: ["tests/**/*.test.ts"]`); en `../media-stack`, `tests/lib.sh` y `scripts/check.sh` |
| **Comando rápido (hub)** | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-ingest.test.ts && pnpm typecheck` |
| **Comando rápido (`media-stack`)** | Desde `../media-stack`: `docker run --rm -v "$PWD":/repo:ro -w /repo ubuntu:24.04 bash -c 'apt-get update -qq >/dev/null; apt-get install -y -qq sqlite3 curl jq openssl util-linux findutils python3 >/dev/null; cp -r /repo /tmp/r && cd /tmp/r && bash tests/backup.test.sh'` |
| **Suite completa** | Hub: `HUB_REQUIRE_TEST_DB=1 pnpm test && pnpm typecheck && pnpm lint`. `media-stack`: `scripts/check.sh ci` en el CI del PR (exige Linux) |
| **Presupuesto** | `HUB_PERF=1 HUB_REQUIRE_TEST_DB=1 pnpm test tests/overview-budget.test.ts` (500k muestras en PostgreSQL real) |
| **Base de datos** | PostgreSQL 18 desechable de loopback, como en CI (contenedor `hub-phase3-pg`, `127.0.0.1:55432`). `HUB_REQUIRE_TEST_DB=1` impide que se omitan los casos con base |
| **Duración estimada** | Vitest completo, de 20 a 32 s (observado en las fases 6 y 7). Los tests de `media-stack` en Docker suman la instalación de paquetes de la imagen. La siembra del presupuesto incluye el backfill de rollups (19,6 s global y 33,9 s por contenedor, medidos en la investigación) |

Los tests de `media-stack` no corren en macOS (Bash 3.2, sin `flock` ni `stat -c`): se ejecutan en `ubuntu:24.04` con Docker, y `scripts/check.sh ci` completo se confía al CI del PR.

---

## Frecuencia

- **Tras cada tarea:** el fichero de test del área tocada. En el hub, `HUB_REQUIRE_TEST_DB=1 pnpm test tests/<área>.test.ts && pnpm typecheck`; en `media-stack`, el `tests/<área>.test.sh` en Docker.
- **Tras cada ola:** `HUB_REQUIRE_TEST_DB=1 pnpm test && pnpm typecheck && pnpm lint`; en `media-stack`, push de la rama y CI del PR (`scripts/check.sh ci`).
- **Antes de `/gsd-verify-work`:** suite completa del hub en verde, CI verde del PR de `media-stack`, `HUB_PERF=1` con el p95 registrado y la UAT humana de D-09 y D-16.
- **Latencia máxima de respuesta:** 120 s por comando focalizado (el presupuesto con 500k muestras queda fuera de este límite y corre solo con `HUB_PERF=1`).

---

## Matriz de verificación por tarea

Se completa al cerrar la planificación, con una fila por tarea de los PLAN.md de la fase.

| Task ID | Plan | Ola | Requisito | Amenaza | Comportamiento seguro | Tipo | Comando automático | Fichero existe | Estado |
|---------|------|-----|-----------|---------|-----------------------|------|--------------------|----------------|--------|

*Estado: ⬜ pendiente · ✅ verde · ❌ rojo · ⚠️ inestable*

### Requisitos → pruebas (de la investigación)

| Req | Comportamiento | Tipo | Comando | ¿Existe? |
|-----|----------------|------|---------|----------|
| CONT-02 | HMAC inválido, cabeceras ausentes o ventana vencida (±5 min) → 401 y cero filas en `incidents`, `notification_outbox` e `ingest_events` | integración (BD) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-ingest.test.ts -t "rechaza"` | ❌ Ola 0 |
| CONT-02 | Mismo `source:eventId` y mismo cuerpo → 200 duplicado sin filas nuevas; mismo id con otro cuerpo → 409; dos peticiones simultáneas → una sola incidencia | integración (BD) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-ingest.test.ts -t "idempot"` | ❌ Ola 0 |
| CONT-02 | Secreto anterior aceptado y secreto desconocido rechazado; sin secreto configurado → 503 | unitario + integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-ingest.test.ts -t "secreto"` | ❌ Ola 0 |
| CONT-02 | Cuerpo por encima del tope → 413 antes de verificar; clave o fuente fuera de la lista → 422 sin efectos | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-ingest.test.ts -t "alcance"` | ❌ Ola 0 |
| CONT-02 | `routeFiles` declara la ruta nueva y el test de rutas reales sigue verde | unitario | `pnpm test tests/sensitive-actions.test.ts` | ✅ (ampliar) |
| CONT-02 | Un evento aceptado abre una incidencia inmediata de Telegram (copia e issue) y `resolved` la cierra y encola la edición, sin mensaje nuevo | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/notification-ingest.test.ts -t "ciclo"` | ❌ Ola 0 |
| CONT-02 (riesgo P1) | Un snapshot `ok` con `at` anterior a la apertura no cierra `backup-failed`; con `at` posterior sí | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts -t "ingest"` | ✅ fichero, caso ❌ Ola 0 |
| SEC-06 | Fallo de copia: publica con ≤3 intentos y no llama a Telegram si hay 2xx | Bash (`curl` falso) | `bash tests/backup.test.sh` (en Docker) | ✅ (reescribir) |
| SEC-06 | Sin ningún 2xx: un único envío directo, solo `backup-failed`, con el prefijo fijo, y ningún envío en éxito | Bash | `bash tests/backup.test.sh` (en Docker) | ✅ (reescribir) |
| SEC-06 | Ningún `api.telegram.org` ni `TELEGRAM_` fuera de `backup` en los compose y fuentes de `media-stack` | Bash | `bash tests/telegram-emitters.test.sh` (en Docker) | ❌ Ola 0 |
| CONT-02 / D-04, D-05 | `issue-automator`: `ISSUE_CREATED` publica la apertura; `ISSUE_RESOLVED` publica el cierre sin blocklist ni búsqueda; otro tipo no hace nada; sin `send_telegram` | Bash + `unittest` | `bash tests/issue-automator.test.sh` (en Docker) | ✅ (ampliar) |
| D-01 a D-03 | upgrade, merged-updates, security-monitor, security-updater y WUD sin envío ni credenciales de Telegram | Bash | `bash tests/upgrade.test.sh && bash tests/merged-updates.test.sh && bash tests/security-update.test.sh && bash tests/security-monitor.test.sh && bash tests/template.test.sh` (en Docker) | ✅ (reescribir) |
| PERF-01 | La salida de 7d y 30d desde rollup equivale (ponderada) a la agregación cruda sobre datos sembrados | integración (BD) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/history-rollups.test.ts -t "equivale"` | ❌ Ola 0 |
| PERF-01 | Upsert idempotente: dos ticks seguidos no cambian el resultado; backfill por días sobre el histórico existente | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/history-rollups.test.ts -t "idempot\|backfill"` | ❌ Ola 0 |
| PERF-01 / D-20 | La retención no borra crudas cuyo cubo no esté agregado y conserva la última muestra por host | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/history-rollups.test.ts -t "retención"` | ❌ Ola 0 |
| PERF-01 | Migraciones nuevas: sembrar la versión anterior, `migrateAll` y `pnpm db:migrate` no reescriben filas; hay script de reversa | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | ✅ (ampliar) |
| PERF-02 | p95 < 150 ms de `GET /api/overview?range=30d` (ruta real, auth simulada) con 500k muestras; 24h solo informativo; el plan de 30d no hace Seq Scan sobre `samples` | rendimiento (BD real) | `HUB_PERF=1 HUB_REQUIRE_TEST_DB=1 pnpm test tests/overview-budget.test.ts` | ❌ Ola 0 |
| D-22 | Ningún módulo salvo `notification-dispatch.ts` y `digest-runs.ts` importa `sendTelegramMessage`, `editTelegramMessage`, `sendTelegramReply`, `deliverPush` o `web-push`, ni contiene `api.telegram.org` | unitario (estático) | `pnpm test tests/notification-senders.test.ts` | ❌ Ola 0 |
| SEC-05 | El hub lee el token al arrancar y no lo persiste; la redacción cubre el token nuevo | unitario | `pnpm test tests/telegram-redaction.test.ts tests/runtime-config.test.ts` | ✅ |

Los tests aseveran estado, resultado o estructura, nunca copy (`CODING_STANDARD.md`): códigos HTTP, filas guardadas en `incidents`, `notification_outbox` e `ingest_events`, peticiones registradas por el `curl` falso de `media-stack` y planes de consulta. El prefijo del aviso directo de la copia se comprueba por su presencia como valor configurado, no por su redacción.

---

## Ola 0

- [ ] `tests/notification-ingest.test.ts`: firma, ventana, idempotencia, alcance, 413 y ciclo de vida (CONT-02).
- [ ] `tests/history-rollups.test.ts`: equivalencia, idempotencia, backfill y retención (PERF-01, D-20).
- [ ] `tests/overview-budget.test.ts`: presupuesto p95 con 500k muestras, solo con `HUB_PERF=1` (PERF-02, D-21).
- [ ] `tests/notification-senders.test.ts`: guarda estática de emisores (D-22).
- [ ] `../media-stack/tests/telegram-emitters.test.sh`: ningún emisor de Telegram fuera de la copia (SEC-06, D-09).
- [ ] Casos nuevos en `tests/collector-alerts.test.ts` (evidencia obsoleta), `tests/sensitive-actions.test.ts` (`routeFiles`), `tests/migrations.test.ts` (migraciones nuevas) y `tests/runtime-config.test.ts` (secreto del ingest y secreto anterior).
- [ ] Reescritura de los tests de `media-stack` que afirman Telegram (Pitfall 11 de la investigación) y ampliación de `tests/issue-automator.test.sh`.
- Sin dependencias nuevas: Vitest y el runner Bash ya existen; la imagen Docker de pruebas de `media-stack` es un comando, no una dependencia.

---

## Verificaciones solo manuales

| Comportamiento | Requisito | Por qué es manual | Pasos |
|----------------|-----------|-------------------|-------|
| Cada familia con ingest recibe un evento firmado de prueba en producción y el hub muestra la incidencia y su mensaje | CONT-02 (D-09) | Necesita el hub desplegado en `webs` y la ruta NAS → hub por Tailscale, que solo se confirma en producción | Con el ingest ya desplegado y antes del release de `media-stack`: enviar un evento de prueba de issue-automator (apertura y cierre) y de la copia, y comprobar en el hub la incidencia, su mensaje y la edición al cerrar |
| Las familias que solo se apagan ya no tienen token ni trigger de Telegram en el NAS, y el emisor SMART está localizado y apagado | SEC-06 (D-06, D-09) | El emisor SMART no está en ninguno de los dos repos y el despliegue de `media-stack` lo hace el usuario (D-11) | Tras el release de `media-stack`, revisar los `.env` y compose desplegados y confirmar que no llega ningún aviso de esas familias fuera del hub |
| Rotación real del token del bot y del secreto HMAC con aviso de prueba por cada camino | SEC-05 (D-16, D-17) | BotFather es interactivo y revocar un token es irreversible | Seguir el runbook: revocar en BotFather, actualizar los `.env` del hub y de `media-stack`, recrear lo necesario y verificar un aviso por el hub y otro por el fallback de la copia |

---

## Aprobación de la validación

- [ ] Todas las tareas tienen verificación `<automated>` o dependen de la Ola 0
- [ ] Continuidad del muestreo: nunca tres tareas seguidas sin verificación automática
- [ ] La Ola 0 cubre todas las referencias marcadas como inexistentes
- [ ] Sin opciones de modo vigilancia (`--watch`)
- [ ] Latencia de respuesta < 120 s
- [ ] `nyquist_compliant: true` en el frontmatter

**Aprobación:** pendiente
