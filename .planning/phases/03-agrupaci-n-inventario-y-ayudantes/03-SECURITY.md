---
phase: "03"
slug: "agrupaci-n-inventario-y-ayudantes"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-25"
---

# Phase 03 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Agente privado → colector | Las métricas y su procedencia se validan antes de cambiar un episodio. | Estado de contenedores, marca Docker y fecha de muestra. |
| PostgreSQL → Avisos o proveedor externo | La proyección autenticada y el texto del proveedor son superficies con datos distintos. | Inventario y entrega interna viven en PostgreSQL; el proveedor solo recibe título, detalle estático, host, severidad y enlace. |
| Inventario Docker → vigilancia | La calidad de la evidencia gobierna la retirada y la reasignación. | Lista Docker completa y fechada; estado durable por host. |
| API autenticada y colector → configuración e incidencias | Dos procesos pueden modificar el mismo estado durable. | Fila de configuración por host, operaciones y transiciones de episodio. |
| Agente → Docker local | Las etiquetas y la identidad confirmada limitan una operación privilegiada de eliminación. | ID Docker, etiquetas de propiedad e inspección previa al DELETE. |
| Estado de limpieza → API y Avisos | El contrato opcional y sus comprobaciones determinan estados visibles y cierres. | Recuentos, tipo, fecha y estado; nunca comandos ni respuestas crudas. |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-03-01 | Tampering | Colector y proyección por host | high | mitigate | Transiciones por `hostId` y clave exacta con bloqueo de fila (`src/lib/incident-store.ts:595`), consultas de episodios abiertos filtradas por host (`src/lib/collector.ts:49`, `:246`) y descarte de listas repetidas/obsoletas (`src/lib/collector.ts:239`). Tests: `tests/collector-alerts.test.ts:441` (dos hosts independientes), `:563` (200 inválido), `:1085` (lista repetida o anterior), `:1282` (mismo nombre en otro host). | closed |
| T-03-02 | Information Disclosure | Avisos y mensajes | high | mitigate | La sesión se exige antes de cualquier ruta y el detalle puntual exige host configurado más ID seguro (`src/app/api/[...path]/route.ts:167`, `:232-257`). El texto de Telegram se construye solo con título, detalle estático, host y severidad (`src/lib/notification-dispatch.ts:283-288`, `:727-734`); el inventario queda en la proyección autenticada (`src/lib/incident-store.ts:908-948`). Logs sin rutas ni cuerpos: `agent/server.py:467-469`, `agent/helper_cleanup.py:248-253`, `src/lib/collector.ts:583`. Tests: `tests/api-incidents.test.ts:357` (401 sin sesión, 404 sin host), `:388` (sin cruce de host), `:660` (proyección y enlace autenticado), `tests/collector-alerts.test.ts:2267` (payload sin inventario ni nombres). | closed |
| T-03-03 | Tampering | Migración y outbox | high | mitigate | Migración 0005 estrictamente aditiva y nullable, sin reescritura de filas (`drizzle/0005_incident_context.sql:1-5`), con snapshot y journal alineados (`drizzle/meta/_journal.json`, entrada `0005_incident_context`) y tipos en `src/lib/schema.ts:164-177`. Tests: `tests/migrations.test.ts:339` (SQL/snapshot/journal), `:380` (conserva IDs, fingerprints, `resolvedAt`, `seq`, `origin` y outbox), `:468` (el binario anterior sigue insertando). Reejecutado en esta auditoría: 6/6. | closed |
| T-03-04 | Tampering | Evidencia de inventario y asignación | high | mitigate | Solo una marca `containersObservedAt` nueva, válida y no repetida entra en la reconciliación; la cadena exige worker y tramo válidos y descarta huecos (`src/lib/container-watch.ts:102-107`, `:270-284`). La ausencia y las reasignaciones exigen correspondencia unívoca por ID o pareja Compose (`src/lib/container-watch.ts:292-330`, `:139-171`, `:180-250`). Tests: `tests/collector-alerts.test.ts:857` (listas nuevas, completas y consecutivas), `:1085` (marca repetida/anterior), `:1212` (ID bajo otro nombre), `:1362` (Compose único), `:1409` (escalado ambiguo), `:1455` (dos orígenes), `:1502` (destino duplicado); `tests/api-incidents.test.ts:866` (enlace original tras renombrar). | closed |
| T-03-05 | Tampering | Mutación concurrente de vigilancia | high | mitigate | `mutateSettings` crea o bloquea la fila por host y comparte transacción con las transiciones (`src/lib/settings.ts:51-85`); la confirmación de operación bloquea su fila y verifica host (`src/lib/lifecycle.ts:91-143`). La revisión se lee antes de pedir métricas (`src/lib/collector.ts:355`) y se comprueba bajo bloqueo en la reconciliación (`src/lib/container-watch.ts:272`); la promoción de operaciones exige una marca Docker posterior a la operación (`src/lib/collector.ts:536-569`). Tests: `tests/api-incidents.test.ts:1001` (edición concurrente de umbral), `:1062` (lectura anterior a parada confirmada), `:1105` (start perdido), `:1214` (stop perdido), `:1288` (eliminación sin confirmar); `tests/api-lifecycle.test.ts:363` (aislamiento por host). | closed |
| T-03-06 | Elevation of Privilege | Selección y eliminación de ayudantes | high | mitigate | Solo es candidato un contenedor con marcador, propietario de la instalación, familia, instancia válida, edad suficiente y estado no activo; se preservan protegidos y en ejecución (`agent/helper_cleanup.py:445-473`). Antes del DELETE se revalida por inspección (`:475-491`) y se emite `DELETE /containers/{id}?v=0` (`:511-523`); una lista incompleta o una inspección incoherente dejan el barrido indeterminado (`:417-443`). Los ayudantes se excluyen del inventario de vigilancia y el reinicio se protege mientras corre (`agent/server.py:353-357`, `:436-450`). Tests: `agent/test_maintenance.py:1093` (ajeno con la misma imagen), `:1134` (activo y antiguo en ejecución), `:1075` (huérfano anterior con `?v=0`), `:1110` (etiquetas incompletas), `:1164` (reinicio protegido), `:1189`, `:1205`, `:1223`. Reejecutado: 44/44. | closed |
| T-03-07 | Tampering | Resultado de limpieza | high | mitigate | Contrato Zod con coherencia de estados y recuentos (`src/lib/agent-snapshots.ts:247-284`); la señal solo nace con un ID persistente y el cierre solo con `clean` acreditado por un barrido completo sin IDs afectados (`src/lib/maintenance-alerts.ts:158-203`, `agent/helper_cleanup.py:307-327`, `:390-392`). El colector conserva el último `checkedAt` acreditado y descarta respuestas anteriores (`src/lib/collector.ts:165-184`). `helper-cleanup` mantiene disposición digest explícita aunque `PUSH_WARNINGS` esté activo (`src/lib/notification-policy.ts:83-91`). Tests: `tests/collector-alerts.test.ts:2418`, `:2480`, `:2509`, `:2531`, `:2556`; `tests/maintenance-alerts.test.ts:724`, `:740`; `agent/test_maintenance.py:1022`, `:1040`, `:1313`. | closed |
| T-03-08 | Information Disclosure | Logs y Mantenimiento | high | mitigate | El snapshot autenticado solo publica disponibilidad, estado, fecha y recuentos acotados (`src/lib/maintenance.ts:146-155`, `agent/helper_cleanup.py:307-327`) y se calcula fuera de la caché (`agent/maintenance.py:799-825`). Los logs del agente se limitan a familia e ID truncado (`agent/helper_cleanup.py:248-253`), el servidor no registra peticiones (`agent/server.py:467-469`) y los errores de Docker solo conservan el estado HTTP (`agent/maintenance.py:421-432`). El esquema rechaza estados y recuentos incoherentes (`src/lib/agent-snapshots.ts:247-284`). Tests: `tests/api-maintenance.test.ts:298`, `:320`, `:344`, `:382`; `agent/test_maintenance.py:1003`, `:1358`. | closed |
| T-03-SC | Tampering | Dependencias | high | mitigate | No se añadieron dependencias ni se modificó el lockfile: `git log b7dfffa..HEAD -- pnpm-lock.yaml package.json agent/requirements.txt` no devuelve commits y el diff de la fase no toca esos archivos. `agent/Dockerfile` solo añade `helper_cleanup.py` al `COPY` existente. El módulo nuevo usa la biblioteca estándar y el cliente Docker inyectado (`agent/helper_cleanup.py:23-24`). | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

No accepted risks.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-25 | 9 | 9 | 0 | gsd-secure-phase (review subagent) |

### Verification Evidence

| Command | Result |
|---------|--------|
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | 6/6 pasados |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-incidents.test.ts tests/maintenance-alerts.test.ts` | 45/45 pasados |
| `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/api-maintenance.test.ts` | 53/53 pasados |
| `python3 -m unittest discover -s agent -p test_maintenance.py` | 44/44 OK |
| `pnpm build` (evidencia de fase) | exit 0 |
| `HUB_REQUIRE_TEST_DB=1 pnpm test` (evidencia de fase) | 41 archivos, 473 tests |
| `pnpm test:agent` (evidencia de fase) | 199 tests, 1 flake preexistente de `test_env_settings` |
| `CI=1 pnpm test:e2e ...` (evidencia de fase) | 21/21 |

La verificación se hizo contra el código y las pruebas del repositorio, no contra lo declarado en los SUMMARY. Las reejecuciones focalizadas se hicieron sobre PostgreSQL 18 de loopback con `HUB_REQUIRE_TEST_DB=1`; no se usó el Docker operativo del host.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-25
