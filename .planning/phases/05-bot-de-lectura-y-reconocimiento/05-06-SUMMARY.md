---
phase: 05-bot-de-lectura-y-reconocimiento
plan: "06"
subsystem: testing
tags: [vitest, postgres, drizzle, telegram, callbacks, migrations, idempotency]

# Dependency graph
requires:
  - phase: 05-bot-de-lectura-y-reconocimiento
    plan: "01"
    provides: applyIncidentAction, consumeActionToken, issueActionTokens y el fake de la Bot API
  - phase: 02-incidencias-y-entrega-nica
    provides: notification_outbox transaccional, cola de edición y resultado de envío con instante
  - phase: 04-resumen-diario
    provides: migración 0006_digest_runs como base de la cadena de snapshots
provides:
  - Pruebas de idempotencia del reconocimiento desde Telegram y desde el hub
  - Prueba de que reconocer no altera la política de entrega ante una escalada a crítica
  - Prueba de que acknowledgedAt es un instante con zona medible frente al envío de la apertura
  - Prueba de las seis razones de consumeActionToken sin quemar el token
  - Bloque de la migración 0007 aditiva, repetible y alineada con snapshot y journal
affects: [05-07, verify-work, migraciones futuras]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 6992
  tasks: 2
  commits: 2
  plan_head_before: a3f81e8720e73141aeea7a8115cb481234ff25c5
  plan_head_after: 6490668c55ef3f03a6fab510491cd4ef82f077ca

tech-stack:
  added: []
  patterns:
    - "Prueba del motivo inalcanzable dentro de una transacción revertida: la DDL de PostgreSQL también se deshace"
    - "El intervalo sentAt -> ackAt se calcula con las columnas existentes, sin migración posterior"

key-files:
  created:
    - tests/incident-actions.test.ts
  modified:
    - tests/migrations.test.ts

key-decisions:
  - "El reconocimiento repetido se prueba por el mismo canal y por el otro con un nombre de sesión, para cubrir BOT-04 sin tocar HTTP"
  - "incident_missing se provoca dentro de una transacción que suprime la FK, borra la incidencia y revierte, así la base queda con la misma forma"
  - "La medición D-05 compara el instante del reconocimiento con result.at de la fila incident-open enviada, no con una columna nueva"
  - "El bloque 0007 reutiliza los ayudantes existentes de migrations.test.ts y solo excluye también los índices *_pk al comparar con el snapshot"

patterns-established:
  - "Una prueba de migración siembra filas representativas en 0006 y demuestra que 0007 no las reescribe"
  - "Cada fallo del token se comprueba contra la fila completa, no solo contra usedAt"

requirements-completed: [BOT-04, BOT-06]

coverage:
  - id: D1
    description: "Reconocer dos veces, por Telegram y por el hub, deja un solo evento acknowledged, una sola edición y el seq de la primera llamada"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/incident-actions.test.ts#keeps one acknowledgement when it is repeated by either channel"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reconocer una incidencia resuelta devuelve resolved y un id inexistente devuelve not_found, sin escribir ninguna fila"
    requirement: "BOT-04"
    verification:
      - kind: integration
        ref: "tests/incident-actions.test.ts#reports a resolved or unknown episode without writing anything"
        status: pass
    human_judgment: false
  - id: D3
    description: "acknowledgedAt se lee como instante con zona y su diferencia con el envío de la apertura es la del reloj inyectado (median sentAt -> ackAt)"
    verification:
      - kind: integration
        ref: "tests/incident-actions.test.ts#measures the time to acknowledge against the sent opening"
        status: pass
    human_judgment: false
  - id: D4
    description: "Una incidencia reconocida desde el hub que escala a crítica deja su primer aviso pending por Telegram: reconocer no suprime la interrupción"
    verification:
      - kind: integration
        ref: "tests/incident-actions.test.ts#lets a later critical escalation interrupt an episode acknowledged from the hub"
        status: pass
    human_judgment: false
  - id: D5
    description: "consumeActionToken devuelve unknown, used, expired, chat_mismatch, message_mismatch e incident_missing sin lanzar y sin fijar usedAt salvo en el consumo correcto"
    requirement: "BOT-06"
    verification:
      - kind: integration
        ref: "tests/incident-actions.test.ts#returns every token failure without burning the token"
        status: pass
    human_judgment: false
  - id: D6
    description: "La migración 0007 se aplica sobre 0006 conservando filas y contenido, es repetible y su snapshot encadena con 0006_digest_runs"
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#adds acknowledgement, tokens, silences and the poll offset without rewriting history"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#applies 0007 to a new database and on top of 0006 with pnpm db:migrate"
        status: pass
    human_judgment: false

duration: 6 min
completed: 2026-11-26
status: complete
---

# Phase 05 Plan 06: Reconocer es seguro de repetir Summary

**El reconocimiento queda demostrado idempotente por ambos canales, medible frente al envío, neutro para la política de entrega, con seis razones de token que no lo queman, y la migración 0007 probada como aditiva y repetible.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-11-26T14:21:21Z
- **Completed:** 2026-11-26T14:27:41Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Reconocer dos veces —por Telegram y por el hub, con nombre de sesión— devuelve `unchanged` y deja un solo evento `acknowledged`, una sola fila `incident-edit` y el `seq` de la primera llamada; una incidencia resuelta devuelve `resolved` y un id inexistente `not_found` sin cambiar ningún recuento.
- `acknowledgedAt` se recupera como `Date` de una columna `timestamp with time zone` y su diferencia con el `result.at` de la apertura enviada coincide con el reloj inyectado (89 s), así que `median(sentAt -> ackAt)` se calcula con lo que ya existe.
- Una incidencia cuya primera entrega se retenía para el resumen, reconocida desde el hub, vuelve a abrir su primer aviso como `pending` por Telegram al escalar a crítica con canal inmediato (D-02, T-05-20).
- Las seis razones de `consumeActionToken` se devuelven como resultado, sin excepción y sin fijar `usedAt`; solo el consumo correcto marca el token y el replay devuelve `used`. `incident_missing` se alcanza en una transacción revertida que suprime la FK, así que la base queda intacta.
- La migración 0007 sobre 0006 conserva incidencias, eventos y el contenido exacto de la fila del outbox, deja nulas las columnas nuevas, impone la unicidad de silencios y de `telegram_poll_state`, borra los tokens en cascada, es repetible con `migrateAll` y `pnpm db:migrate`, y su snapshot encadena con `0006_digest_runs`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Reconocer es idempotente, medible y no altera la política de entrega, y el token devuelve un resultado por razón** — `6e6ac6c` (test)
2. **Task 2: La migración 0007 es aditiva, repetible y está alineada con su snapshot y su journal** — `6490668` (test)

**Plan metadata:** `docs(05-06): complete acknowledgement-behaviour plan`

## Files Created/Modified

- `tests/incident-actions.test.ts` — arnés con base desechable y fake de la Bot API; idempotencia desde los dos canales, `resolved`/`not_found`, medición D-05, neutralidad de la política de entrega (D-02) y las seis razones del token.
- `tests/migrations.test.ts` — bloque `bot migration 0007` (aditiva, repetible, snapshot y journal) y bloque `bot migration runner` con `pnpm db:migrate` sobre base nueva y sobre 0006.

## Decisions Made

- **El reconocimiento repetido se prueba a través de `applyIncidentAction`**, no del carril HTTP: el contrato es la acción compartida y así la prueba vale para los dos canales con el mismo estado.
- **`incident_missing` se provoca en una transacción que se revierte.** El borrado en cascada hace inalcanzable el motivo con datos reales; suprimir la FK dentro de una transacción y deshacerla deja la base con la misma forma y el token sin quemar.
- **La medición D-05 usa el `result.at` de la fila `incident-open` enviada**, porque es el instante de envío que ya se persiste; no se añade ninguna columna ni migración.
- **El bloque 0007 reutiliza los ayudantes existentes** (`migrateThrough`, `migrateAll`, `runMigrator`, `journal`, `snapshot`, `liveColumns`, `liveIndexes`) y solo excluye también los índices `*_pk` al comparar con el snapshot, porque la clave primaria de `incident_snoozes` se llama `incident_snoozes_hostId_key_pk`.

## Deviations from Plan

None - plan executed exactly as written. No production code, schema or `drizzle/` file was touched.

## Issues Encountered

- La comparación de índices del bloque 0007 excluía solo los nombres `*_pkey`; la clave compuesta de `incident_snoozes` se llama `incident_snoozes_hostId_key_pk`. Se ajustó el filtro de la prueba nueva (no del producto) para excluir también `*_pk`.
- No se encontró ningún defecto en el código de 05-01: las pruebas pasan contra la implementación existente y no hizo falta ninguna corrección mínima.

## Threat Flags

None. This plan only adds tests; no new surface, dependency or trust boundary is introduced (T-05-SC: sin paquetes nuevos).

## User Setup Required

None - no external service configuration required.

## Pending Human Verification (end-of-phase)

None for this plan: both tasks carry only `<automated>` verification and every acceptance criterion is asserted by the suite.

## Next Phase Readiness

- BOT-04 y BOT-06 quedan cubiertos por pruebas de comportamiento; el reconocimiento ya no depende de revisar el estado a mano.
- La migración 0007 tiene su propia prueba de aditividad y repetición; las migraciones siguientes pueden copiar el bloque `bot migration 0007` como plantilla.
- `tests/incident-actions.test.ts` es el sitio donde 05-03 (Por qué) y 05-05 (redacción) pueden añadir sus casos sin tocar la migración.

## Verification

- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-actions.test.ts tests/telegram-updates.test.ts` → 2 archivos, 14 pruebas, todas en verde.
- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` → 1 archivo, 10 pruebas, todas en verde.
- `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test tests/incident-actions.test.ts tests/migrations.test.ts` → 2 archivos, 15 pruebas, todas en verde.
- `pnpm typecheck` → sin errores.
- `DATABASE_URL=… HUB_REQUIRE_TEST_DB=1 pnpm test` completo → 45 archivos, 590 pruebas, todas en verde; ninguna suite de PostgreSQL omitida.
- `git diff --stat a3f81e8..HEAD` → solo `tests/incident-actions.test.ts` y `tests/migrations.test.ts`.

---

*Phase: 05-bot-de-lectura-y-reconocimiento*
*Completed: 2026-11-26*

## Self-Check: PASSED

- `tests/incident-actions.test.ts` y `tests/migrations.test.ts` existen en disco.
- Los commits `6e6ac6c` y `6490668` son ancestros de HEAD.
- `pnpm typecheck` sin errores y la suite completa en verde (45 archivos, 590 pruebas).
