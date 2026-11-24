# Fase 2 · Incidencias y entrega única · Patrones del repositorio

**Fecha:** 2026-11-24

Los nombres de archivos nuevos son orientativos. Las referencias son a código versionado.

## Clasificación

| Archivos previstos | Rol y flujo de datos | Referencia principal |
|---|---|---|
| `src/lib/schema.ts`, siguiente SQL y metadatos de `drizzle/`, migración inversa | Modelo y migración por lotes | `drizzle/0003_multi_host.sql`, `drizzle/meta/_journal.json`, `scripts/migrate.ts` |
| Módulo de persistencia de incidencias, eventos y outbox | Servicio, escritura transaccional | Consulta por host/clave de `src/lib/collector.ts` y exclusión de operaciones de `src/lib/host-commands.ts`, coincidencia parcial |
| `src/worker.ts`, dispatcher y cliente Telegram | Worker, cola y solicitud HTTP | `src/worker.ts`, `src/lib/github.ts`, sin dispatcher equivalente |
| `src/lib/nas.ts`, contratos de snapshots, `src/lib/collector.ts`, `src/lib/maintenance-alerts.ts` | Cliente HTTP y transformación de observaciones | `src/lib/nas.ts`, `src/lib/logs.ts`, `src/lib/host-command-contract.ts` |
| Validador de configuración, `.env.example`, `Dockerfile`, `compose.yaml` | Configuración y arranque | `src/lib/hosts.ts` y arranque actual de app y worker |
| `src/lib/push.ts`, `public/sw.js`, `src/components/settings.tsx` | Adaptador y presentación de notificación | Implementación existente de Web Push y suscripciones |
| `src/app/api/[...path]/route.ts`, `src/lib/types.ts`, `src/components/views/routes.ts`, `src/components/views/alerts.tsx`, `src/components/dashboard.tsx`, `src/components/login.tsx` | Lectura autenticada y navegación | API y vista actual por host, con consulta puntual nueva para una incidencia |
| Pruebas de persistencia, agente, arranque, entrega y navegación | Pruebas de integración y contratos | `tests/{database,migrations.test,collector-alerts.test,agent-client.test}.ts`, `tests/e2e/hosts.spec.ts` |

## Patrones por área

### Migración, persistencia y worker

- `src/lib/schema.ts:134-151` define `alerts` con identidad entera generada, timestamps existentes y los índices por clave y por host. Mantener la identidad y migrar el par `hostId`/clave. `drizzle/0003_multi_host.sql:1-10` muestra el precedente de remapear filas existentes antes de apoyarse en las nuevas claves y el separador `--> statement-breakpoint`.
- `drizzle/meta/_journal.json:26-31` apunta a `0003_multi_host`; `scripts/migrate.ts:1-8` aplica la secuencia usando `migrate(db, { migrationsFolder: "./drizzle" })` y cierra el pool. Mantener SQL, snapshot y journal coherentes. La reversa operativa necesita un procedimiento y un ensayo propios.
- `src/lib/collector.ts:35-45` localiza el episodio abierto mediante `and(eq(alerts.hostId, host.id), eq(alerts.key, key), isNull(alerts.resolvedAt))`. Conserva este alcance, pero materializa unicidad en el índice parcial y agrupa transición, evento y outbox en una sola transacción. El `onConflictDoNothing().returning()` de `src/lib/host-commands.ts:136-156` es precedente de arbitraje en base de datos. El selector actual de avisos seguido de escritura y envío visible en `collector.ts:46-67` no aporta las garantías nuevas.
- `src/worker.ts:12-31,49-62` adquiere el advisory lock 734921 en un cliente dedicado, recoge dentro del loop y procesa señales del proceso. Adjuntar drenado y vigilancia de la sesión a ese mismo ciclo. `src/app/api/[...path]/route.ts:135-153` muestra liberación de un cliente dedicado en `finally` alrededor de su propio lock de bootstrap. Revisar también la limpieza de incidencias resueltas de `src/worker.ts:32-40` junto con las nuevas dependencias de entrega.
- `tests/database.ts:8-40` admite únicamente loopback y crea una base temporal. `tests/migrations.test.ts:15-48` usa divisiones por breakpoint y siembra filas anteriores. Su prueba multi-host elige el último archivo de la carpeta, por lo que debe fijarse explícitamente a `0003_multi_host.sql` antes de añadir otro. `.github/workflows/ci.yml:10-27,39-47` ya proporciona PostgreSQL 18, migrador y Vitest/Playwright.

### Cliente del agente y arranque

- `src/lib/nas.ts:4-13,31-63,74-85` tipa por separado `NasUnavailable`, `NasRejected` y `NasInvalidResponse`, pasa `signal` a `fetch`, aplica `Effect.timeoutOrElse` y devuelve el mismo error en el límite Promise. Reusar esos tipos al decodificar respuestas exitosas. `src/lib/logs.ts:28-42` combina esquema Zod e inferencia de tipos. `src/lib/host-commands.ts:173-181` muestra `safeParse` de la respuesta HTTP como paso propio. La captura de `ZodError` del router actual lo trata como inválido de entrada del usuario, por lo que la decodificación de lo que devuelve el agente debe traducir su fallo.
- `src/lib/collector.ts:75-103` permite que mantenimiento y despliegues fallen por separado y omite señales del snapshot rechazado. `src/lib/maintenance-alerts.ts:49-103` excluye secciones degradadas y ya distingue `disk-health` en `watch` y `fail`. Corregir el tratamiento de ausencia de evidencia de `collector.ts:106-176` y los defaults de `maintenance-alerts.ts:168-181` al validar contratos. `tests/collector-alerts.test.ts:35-103` usa un agente HTTP local configurable; extender ese recorrido para comprobar que un HTTP 200 inválido no causa transición ni escritura de muestras.
- `src/lib/hosts.ts:27-41,51-73,76-112` usa `safeParse` y acepta un objeto de entorno inyectable. Conservar la compatibilidad de `NAS_HOSTS` y el par `NAS_AGENT_URL`/`AGENT_TOKEN`. El orquestador de configuración puede seguir ese límite de entrada y devolver diagnósticos sin datos sensibles. `src/lib/auth.ts:9-38` identifica las variables que consumen los orígenes y la autenticación.
- `Dockerfile:7-19` separa el build con secreto de compilación del comando de runtime. `compose.yaml:28-58` arranca app y worker tras migrar y comprueba app con `/api/setup`. Verificar la configuración antes de iniciar cada servicio y proteger el build. Usar los ejemplos de `.env.example` como casos directos de rechazo.

### Entrega, Web Push y navegación

- `src/lib/github.ts:80-104` muestra un cliente de servicio externo acotado por timeout y con un error HTTP tipado. En Telegram, los resultados deben distinguir envío incierto, rechazo confirmado y 429 con plazo; el patrón HTTP aporta el límite de petición, mientras que `02-RESEARCH.md` define el protocolo del outbox.
- `src/lib/push.ts:6-33` ya transmite la etiqueta y elimina suscripciones caducadas para 404/410. Exponer el resultado de los intentos en vez de perderlo en `Promise.allSettled`. `public/sw.js:4-21` presenta la etiqueta y prioriza una ventana del mismo origen al pulsar. Usar el destino interno del episodio y mantener el cierre y enfoque observables. Para D-05, aplicar la comprobación local de la etiqueta vigente durante el refresco autenticado que describe `02-RESEARCH.md`.
- `src/app/api/[...path]/route.ts:626-659` guarda la suscripción bajo la cuenta de la sesión y hoy llama al proveedor directo en `push/test`. Conservar la prueba manual y su ámbito de cuenta al pasarla por el worker. `src/components/settings.tsx:220-232` es el punto de feedback de esa prueba.
- `src/app/api/[...path]/route.ts:155-156,267-288` aplica sesión y filtra por host; el límite reciente de 100 requiere un acceso al episodio concreto por host e ID. `src/app/page.tsx:8-14` decide si se muestra la vista autenticada. `src/components/views/routes.ts:18-46` es el parser/formateador de la URL, `src/components/login.tsx:35-56` redirige a la raíz en ambos flujos y `src/components/dashboard.tsx:130-153` hace lo mismo al expirar la sesión. Hacer que los tres recorridos preserven un destino interno validado y mantener el estado de entrega en `src/components/views/alerts.tsx:4-48`.
- `tests/e2e/hosts.spec.ts:114-176` prepara sesión y verifica alcance por URL y atributos `data-view` y `data-host`. Complementar con navegación al episodio tras iniciar sesión y comprobaciones de estado y motivo en la API y la vista.

## Casos sin análogo directo

El registro durable de un intento saliente incierto, la actualización de un mensaje Telegram ya confirmado y el reemplazo condicional de un aviso Web Push no tienen una implementación equivalente en el repositorio. Sus contratos y escenarios de fallo están en `02-RESEARCH.md`.
