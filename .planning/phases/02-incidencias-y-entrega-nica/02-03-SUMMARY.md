---
phase: 02-incidencias-y-entrega-nica
plan: "03"
subsystem: infra
tags:
  - next-env
  - startup-validation
  - telegram
  - vapid
  - push-warnings
  - worker
  - postgresql
  - deployment
  - rollback

requires:
  - phase: 02-incidencias-y-entrega-nica
    plan: "01"
    provides: "Migración 0004 reversible y ensayo 0003 → 0004 → reversa → 0004 que el procedimiento de despliegue referencia"
  - phase: 02-incidencias-y-entrega-nica
    plan: "02"
    provides: "Política auditada y PUSH_WARNINGS con default false que la configuración de arranque valida"

provides:
  - "readRuntimeConfig con entorno inyectable y diagnósticos por variable y motivo finito"
  - "scripts/check-runtime-config.ts encadenado antes de next start con la precedencia de @next/env"
  - "Validación del worker antes de pool.connect y del advisory lock"
  - "Contrato opcional completo de Telegram y VAPID, y PUSH_WARNINGS solo true/false"
  - "Procedimiento de despliegue y reversa conjunta en README"

affects: [02-04, 02-05, phase-3, phase-4]

actuals:
  tokens: 12384
  tasks: 2
  commits: 2
  plan_head_before: d585fdb7981cfacc293ae70379e167cffa549321
  plan_head_after: b3821cfb3be53938ca6dc1db275871d751c821d1

tech-stack:
  added:
    - "@next/env 16.4.6 como dependencia directa, ya resuelta por Next en el lockfile"
  patterns:
    - "Preflight de arranque con la misma resolución de entorno que usa next start"
    - "Diagnósticos de configuración por nombre de variable y motivo finito"
    - "Grupos opcionales todo-o-nada y VAPID validado como par P-256 coherente"

key-files:
  created:
    - src/lib/runtime-config.ts
    - scripts/check-runtime-config.ts
    - tests/runtime-config.test.ts
  modified:
    - src/worker.ts
    - package.json
    - pnpm-lock.yaml
    - .env.example
    - README.md

key-decisions:
  - "El preflight fuerza NODE_ENV=production antes de loadEnvConfig porque @next/env cambia a modo test cuando NODE_ENV=test y omitiría .env.local."
  - "La URL canónica se normaliza a origin y solo admite HTTPS o HTTP loopback, sin usuario, contraseña, ruta, query ni fragmento."
  - "Los valores de ejemplo se detectan sobre la URL decodificada hasta tres niveles, así change%2Dme no se disimula."
  - "Telegram es un grupo completo: chat numérico firmado y token con la forma del proveedor; omitir ambos desactiva el canal."
  - "VAPID solo es obligatorio con PUSH_WARNINGS=true y debe formar un par coherente: la pública se deriva de la privada y se compara."
  - "El worker valida antes de pool.connect y del lock; un RuntimeConfigError imprime variables y motivos, nunca valores."
  - "PUSH_WARNINGS solo acepta true/false en el contrato de arranque; el parser existente de notification-policy no se modificó porque el worker valida antes de recolectar."

patterns-established:
  - "Preflight de app: node --import tsx scripts/check-runtime-config.ts && next start; pnpm build no lo ejecuta."
  - "Diagnóstico finito: variable (reason), sin valores, URLs con credenciales ni cuerpos externos."
  - "Prueba de arranque del worker con un puerto TCP real que debe registrar cero conexiones."

requirements-completed: [SEC-03]

coverage:
  - id: D1
    description: "Preflight de la app con la precedencia real de Next, rechazo de valores de ejemplo y grupos obligatorios antes de que next start acepte tráfico"
    requirement: SEC-03
    verification:
      - kind: integration
        ref: "tests/runtime-config.test.ts#accepts a configuration supplied only by .env.local"
        status: pass
      - kind: integration
        ref: "tests/runtime-config.test.ts#lets the process environment win over .env.local"
        status: pass
      - kind: integration
        ref: "tests/runtime-config.test.ts#does not hide a higher-priority invalid value behind .env"
        status: pass
      - kind: integration
        ref: "tests/runtime-config.test.ts#fails pnpm start before Next starts when the environment is invalid"
        status: pass
      - kind: integration
        ref: "tests/runtime-config.test.ts#keeps forwarding start arguments to next start"
        status: pass
    human_judgment: false
  - id: D2
    description: "Contrato de canales opcionales: Telegram todo-o-nada con chat numérico, VAPID coherente y obligatorio con PUSH_WARNINGS=true, y worker que falla antes de tocar PostgreSQL"
    requirement: SEC-03
    verification:
      - kind: unit
        ref: "tests/runtime-config.test.ts#accepts a complete Telegram group with a signed numeric chat"
        status: pass
      - kind: unit
        ref: "tests/runtime-config.test.ts#rejects a partial Telegram group"
        status: pass
      - kind: unit
        ref: "tests/runtime-config.test.ts#rejects a mismatched VAPID pair"
        status: pass
      - kind: unit
        ref: "tests/runtime-config.test.ts#only accepts true and false for PUSH_WARNINGS"
        status: pass
      - kind: integration
        ref: "tests/runtime-config.test.ts#stops before the database when required configuration is missing"
        status: pass
      - kind: integration
        ref: "tests/runtime-config.test.ts#stops before the database on a partial Telegram group"
        status: pass
      - kind: integration
        ref: "tests/runtime-config.test.ts#stops before the database when PUSH_WARNINGS requires VAPID"
        status: pass
    human_judgment: false
  - id: D3
    description: "Procedimiento de despliegue conjunto después de la ola 5: parada de app y worker, copia restaurable, recuentos de preflight, activación de canales y reversa ensayada por 02-01"
    verification: []
    human_judgment: true
    rationale: "La parada de servicios, la copia real y la decisión de archivar outbox y eventos antes de una reversa dependen de la base de producción; ningún test puede ejecutar esa operación."

duration: 36min
completed: 2026-11-25
status: complete
---

# Phase 02 Plan 03: Configuración de arranque y despliegue conjunto

**Preflight de arranque con la precedencia real de Next, contrato todo-o-nada para Telegram y VAPID, y worker que falla antes de tocar PostgreSQL.**

## Performance

- **Duration:** 36 min
- **Started:** 2026-11-25T10:18:00+01:00
- **Completed:** 2026-11-25T10:54:00+01:00
- **Tasks:** 2
- **Files modified:** 8 (3 creados, 5 modificados)

## Accomplishments

- `readRuntimeConfig` valida `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SETUP_TOKEN`, `BETTER_AUTH_URL` y los hosts desde un entorno inyectable. Reutiliza `parseHosts` y conserva la pareja heredada `NAS_AGENT_URL`/`AGENT_TOKEN`.
- `BETTER_AUTH_URL` se normaliza al origen canónico de los avisos: HTTPS en producción o HTTP solo en loopback, sin credenciales, ruta, query ni fragmento. Los valores de ejemplo se detectan sobre la URL decodificada hasta tres niveles.
- `scripts/check-runtime-config.ts` carga el entorno con `loadEnvConfig` de `@next/env` en modo producción y se encadena antes de `next start`. La precedencia es proceso > `.env.production.local` > `.env.local` > `.env.production` > `.env`.
- `pnpm start` conserva los argumentos que Docker y Playwright envían a `next start`; un fallo del preflight impide el arranque. `pnpm build` no ejecuta el preflight y mantiene su secreto de build separado.
- El worker valida la configuración antes de `pool.connect` y del advisory lock. Un fallo imprime variables y motivos finitos, sin valores, y termina el proceso.
- Telegram es un grupo opcional completo (token con forma del proveedor y chat numérico firmado). VAPID es un par coherente P-256 y solo es obligatorio con `PUSH_WARNINGS=true`; `PUSH_WARNINGS` solo acepta `true`/`false`, con `false` por omisión.
- README documenta la activación conjunta tras la ola 5, los recuentos de preflight antes y después de 0004, la parada de app y worker antiguos, la copia restaurable, la reversa ensayada por 02-01 y el archivo de outbox y eventos si hubo actividad.

## Task Commits

Cada tarea se confirmó de forma atómica:

1. **Task 1: Resolver el entorno real de Next y validar antes del arranque HTTP** — `d619576` (feat)
2. **Task 2: Aplicar el mismo contrato al worker y documentar la configuración de despliegue** — `b3821cf` (feat)

**Plan metadata:** commit de documentación posterior con este SUMMARY.

_Nota: la tarea 2 llevaba `tdd="true"`. El encargo exige un único commit atómico por tarea, así que el caso de comportamiento se ejecutó contra la implementación y se confirmó en ese commit, sin un commit RED separado._

## Files Created/Modified

- `src/lib/runtime-config.ts` — validación de configuración obligatoria y canales opcionales, diagnósticos finitos y URL canónica.
- `scripts/check-runtime-config.ts` — preflight de `pnpm start` con `@next/env` en modo producción.
- `tests/runtime-config.test.ts` — pruebas unitarias, preflight en directorios temporales y arranque del worker con una base que no debe contactarse.
- `src/worker.ts` — validación antes de `pool.connect` y del lock; salida segura del error de configuración.
- `package.json` — `start` encadena el preflight y `@next/env` queda como dependencia directa exacta.
- `pnpm-lock.yaml` — entrada directa de `@next/env 16.4.6` sin cambiar la versión resuelta.
- `.env.example` — ejemplos de Telegram y `PUSH_WARNINGS` desactivados por defecto; aviso sobre secretos de ejemplo.
- `README.md` — validación de arranque y despliegue/reversa conjunta de la fase 2.

## Decisions Made

- El preflight fuerza `NODE_ENV=production` antes de `loadEnvConfig`: `@next/env` conmuta a modo test cuando `NODE_ENV=test` y dejaría de leer `.env.local`. El proceso de `next start` es independiente, así que el forzado no altera el arranque.
- `BETTER_AUTH_URL` se reduce a `url.origin`; así el enlace de los avisos no arrastra rutas ni credenciales. La misma validación se aplica a cada entrada de `TRUSTED_ORIGINS`.
- La detección de `change-me` decodifica hasta tres niveles para cubrir `change%2Dme` y dobles codificaciones, y también inspecciona los tokens de host.
- El par VAPID se comprueba derivando la clave pública P-256 de la privada con `createECDH`; las claves reales de `web-push` se aceptan (verificado con `generateVAPIDKeys`).
- Telegram se valida antes de que exista cualquier envío: chat `-?[1-9]\d{0,19}` y token `\d{5,12}:[A-Za-z0-9_-]{30,}`. Un grupo parcial se rechaza en vez de desactivarse en silencio.
- `PUSH_WARNINGS` se interpreta solo en el contrato de arranque. El parser de `notification-policy` conserva su compatibilidad histórica, pero el worker valida antes de recolectar, así que un valor distinto de `true`/`false` no llega a producción.

## Deviations from Plan

### Procesos ajustados al encargo

- La tarea 2 llevaba `tdd="true"`; el encargo exige un único commit atómico por tarea, así que no hay commit RED separado. El caso de comportamiento se ejecutó contra la implementación y es la puerta de la tarea.
- `pnpm add @next/env@16.4.6 --offline` no pudo completar la instalación con el store local y dejó `node_modules` vacío. Se comprobó que el registro era alcanzable y se restauró el árbol con `pnpm install --frozen-lockfile`; la promoción de `@next/env` ya estaba hecha a mano en `package.json` y `pnpm-lock.yaml`, manteniendo `16.4.6` exacto y sin introducir otra versión.
- No se actualizaron `ROADMAP.md` ni `STATE.md`; el orquestador es su único escritor tras la ola, según el encargo.

**Total deviations:** 0 auto-fixed de código y 3 ajustes de proceso.
**Impact on plan:** Ninguno sobre el alcance. El lockfile final coincide con la dependencia directa que el plan pedía y el árbol quedó restaurado.

## Issues Encountered

- `@next/env` es CommonJS y su bundle no expone exportaciones nombradas detectables por ESM; `import { loadEnvConfig }` fallaba en tiempo de ejecución. Se usa la exportación por defecto y se desestructura la función.
- TypeScript 7 declara `NODE_ENV` como propiedad de solo lectura en `process.env`; el preflight y el helper de pruebas usan una vista mutable del entorno.
- `pnpm build` imprime avisos de `BetterAuthError` por el secreto de build ausente en local, pero termina con exit 0; la imagen Docker sigue inyectando `BETTER_AUTH_SECRET=build-placeholder-never-used-at-runtime-32` para compilar.
- El lint completo del repositorio incluye directorios de entorno no versionados; no se ejecutó lint global. Las comprobaciones del plan fueron tests, typecheck y build.

## Threat Model Evidence

- **T-02-05 (Information Disclosure):** las pruebas de app y worker afirman que stdout y stderr no contienen secretos sintéticos, contraseñas de `DATABASE_URL`, tokens de Telegram ni claves VAPID. Los diagnósticos solo enumeran `variable (motivo)`.
- **T-02-06 (Spoofing):** se rechazan los valores de ejemplo del `.env.example`, el secreto de build en runtime, las URLs de ejemplo y los grupos parciales. Las pruebas de precedencia confirman que un valor de mayor prioridad no se disimula con un archivo válido de menor prioridad.

## Evidence

| Command | Result |
|---|---|
| `pnpm test tests/runtime-config.test.ts` | 61 tests passed (1 file) |
| `pnpm typecheck` | `tsc --noEmit` exit 0 |
| `pnpm build` | exit 0; Next.js 16.4.6; solo avisos de secreto de build ausente en local |
| `HUB_REQUIRE_TEST_DB=1 DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub pnpm test` | 36 files, 372 tests passed |
| `pnpm start` con entorno inválido (caso de test) | exit no cero antes de `next start`; sin `Ready`/`Local:` |
| `pnpm start --hostname 0.0.0.0` con entorno inválido (caso de test) | exit no cero; el argumento no rompe la cadena |
| Worker con configuración inválida y puerto TCP de prueba (3 casos) | exit no cero; 0 conexiones; sin secretos en la salida |
| `node --import tsx` con claves reales de `web-push.generateVAPIDKeys()` | par aceptado (pública 87, privada 43) |

## Next Phase Readiness

- La ola 4 puede leer `config.telegram`, `config.vapid`, `config.pushWarnings` y `config.betterAuthUrl` en vez de reinterpretar `process.env`.
- El worker valida antes de `pool.connect` y del lock, así que cualquier dispatcher de outbox de la ola 4 se ejecuta después de una configuración aceptada.
- `PUSH_WARNINGS` queda restringido a `true`/`false` en el arranque. La ola 4 debe consumir `config.pushWarnings` (o confiar en el preflight) y no el parser histórico de `notification-policy`, que sigue aceptando `1/yes/on` en llamadas directas.
- El entorno de CI sigue siendo válido sin Telegram, sin VAPID y sin `PUSH_WARNINGS`.
- `pnpm build` sigue generando la aplicación sin configuración real de producción; el despliegue de la fase 2 sigue siendo una unidad después de la ola 5.

## Self-Check: PASSED

- `src/lib/runtime-config.ts`, `scripts/check-runtime-config.ts` y `tests/runtime-config.test.ts` existen.
- `d619576` y `b3821cf` son ancestros de HEAD.
- `pnpm test tests/runtime-config.test.ts`, `pnpm typecheck`, `pnpm build` y la suite completa con PostgreSQL 18 terminaron correctamente.
