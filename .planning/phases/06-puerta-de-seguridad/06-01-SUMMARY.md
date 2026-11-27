---
phase: 06-puerta-de-seguridad
plan: "01"
subsystem: api
tags: [verification, passkey, authorization, zod, nextjs, vitest, postgres]

# Dependency graph
requires:
  - phase: 05-bot-de-lectura-y-reconocimiento
    provides: acciones de incidencia exentas (D-05) y la tabla recent_verification
provides:
  - "src/lib/sensitive-actions.ts: manifiesto puro de acciones y comandos con política y motivo"
  - "Guard de verificación reciente en /api/action decidido por el manifiesto"
  - "Guard por comando en runHostCommand; check-health exento"
  - "tests/verified-session.ts: sesión y verificación sembradas para las suites de API"
affects: [06-03, 06-04, 06-05, fase-7-telegram]

# Actuals (#2632): chars/4 sobre el diff realizado, misma escala que el estimate.
actuals:
  tokens: 8640
  tasks: 3
  commits: 5
  plan_head_before: 3b543b0b2fdf4ec6e87e1589e94c9137bdefca14
  plan_head_after: 91cfb3d7b98582360ba0e0f64f0bf953137579ae

tech-stack:
  added: []
  patterns:
    - "Manifiesto único con satisfies Record<ActionId|HostCommand, Policy>: un id nuevo sin entrada no compila"
    - "Guard inyectable (store, now) colocado tras el replay idempotente, como lifecycle.ts"

key-files:
  created:
    - src/lib/sensitive-actions.ts
    - tests/verified-session.ts
    - tests/sensitive-actions.test.ts
  modified:
    - src/app/api/[...path]/route.ts
    - src/lib/host-commands.ts
    - src/components/dashboard.tsx
    - tests/api-host-commands.test.ts
    - tests/api-hosts.test.ts
    - tests/api-incidents.test.ts
    - tests/api-lifecycle.test.ts

key-decisions:
  - "El manifiesto decide: ni /api/action ni dashboard.tsx guardan una lista propia de protegidas"
  - "El guard de /api/action sustituye la condición de reboot en la misma posición: tras el replay, antes de la muestra reciente y del insert"
  - "runHostCommand amplía session a VerificationSession y recibe store/now, pero executeHostCommand queda sin guard porque su decisión pertenece a quien lo llama"
  - "El guard de host-command va después de validar cuerpo, host y Idempotency-Key: un 404 o un 400 nunca se disfrazan de 403"
  - "Un replay de un comando de host ya terminado exige verificación vigente; efecto menor aceptado en CONTEXT para no partir executeHostCommand"
  - "tests/verified-session.ts importa db y tables solo como tipos, porque cada suite fija DATABASE_URL antes de importar @/lib/db"

patterns-established:
  - "Una tabla de cuerpos con satisfies Record<ActionId, unknown> mantiene la matriz de acciones sincronizada con actionSchema"
  - "El guard se prueba por comportamiento: 403 con código, cero peticiones al agente falso y cero filas en operations"

requirements-completed: [SEC-01, SEC-02]

coverage:
  - id: D1
    description: "Un único módulo puro declara cada acción y cada comando como protegido o exento con un motivo, y la cobertura falla si el esquema y la tabla no coinciden"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "tests/sensitive-actions.test.ts#declares every action of the schema exactly once, with a reason"
        status: pass
      - kind: unit
        ref: "tests/sensitive-actions.test.ts#declares every host command of the closed list with a reason"
        status: pass
    human_judgment: false
  - id: D2
    description: "Stop, restart, update-container, reboot, purge y empty-trash responden 403 recent_verification_required sin verificación, sin llamar al agente y sin fila en operations; con verificación vigente ninguna de las diez acciones se bloquea"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#without verification %s answers 403 for protected actions only"
        status: pass
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#with a recent verification %s is not blocked by the gate"
        status: pass
    human_judgment: false
  - id: D3
    description: "Los siete comandos que cambian estado responden 403 sin verificación y no crean operación; check-health responde 200 y llega al agente una vez; con verificación los ocho responden 200"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#without verification the host command %s answers 403 only when it changes state"
        status: pass
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#with a recent verification the host command %s answers 200"
        status: pass
    human_judgment: false
  - id: D4
    description: "La UI abre el diálogo de passkey para stop, restart, update-container y reboot leyendo el manifiesto, y deja start, trash, move y restore en su diálogo propio"
    requirement: "SEC-01"
    verification: []
    human_judgment: true
    rationale: "La delegación en useSensitiveAction solo se ejerce en navegador; el e2e que la recorre llega en 06-03."
  - id: D5
    description: "La frontera del TTL cuenta como caducada una verificación con expiresAt igual o anterior a la petición, y el replay de una clave ya registrada devuelve su operación sin exigir verificación nueva"
    verification:
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#treats an expiresAt at the request instant as expired"
        status: pass
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#replays a registered operation without asking for a new verification"
        status: pass
    human_judgment: false
  - id: D6
    description: "Las suites de API siembran la verificación con el ayudante compartido y reconocer, silenciar y quitar silencio siguen exentos sin verificación (D-05)"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "tests/api-incidents.test.ts#keeps acknowledge, silence and unsilence exempt from recent verification"
        status: pass
      - kind: integration
        ref: "tests/api-hosts.test.ts, tests/api-incidents.test.ts, tests/api-lifecycle.test.ts, tests/api-host-commands.test.ts (verde con seedVerifiedSession)"
        status: pass
    human_judgment: false

duration: 10 min
completed: 2026-11-27
status: complete
---

# Phase 06 Plan 01: Parar un contenedor exige verificación reciente Summary

**Un manifiesto puro decide qué exige verificación reciente: `/api/action` y `runHostCommand` responden 403 sin llamar al agente ni registrar operación, la UI abre passkey solo para lo protegido y las acciones de incidencia siguen exentas.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-11-27T10:33:19Z
- **Completed:** 2026-11-27T10:43:17Z
- **Tasks:** 3
- **Files modified:** 10 (3 nuevos, 7 modificados) más los artefactos de planificación

## Accomplishments

- `src/lib/sensitive-actions.ts` es el único manifiesto: `actionPolicies` y `hostCommandPolicies` con `satisfies Record<…>` sobre `ActionId` y `HostCommand`, cada entrada con su motivo, y dos predicados que aceptan cualquier valor, usan `Object.hasOwn` y devuelven `false` ante un id desconocido. Un id nuevo en `actionSchema` o en `hostCommandIds` sin entrada rompe `tsc`, y la prueba de cobertura lo compara también en ejecución.
- El guard de `/api/action` ya no mira `reboot`: `requiresVerificationForAction(body.action)` decide en la misma posición (tras el replay idempotente, antes de la muestra reciente y del `insert`). Un 403 no escribe fila y no envía nada al agente, así que la UI reintenta con la misma clave.
- `runHostCommand` recibe `session: VerificationSession` y `store`/`now` inyectables, valida cuerpo, host y `Idempotency-Key`, y solo entonces aplica `requiresVerificationForCommand`. `executeHostCommand` se queda sin guard por diseño: lo invoca el merge de Renovate, que ya está protegido.
- En `dashboard.tsx`, `request()` delega en `useSensitiveAction` cuando el manifiesto marca la acción como protegida (salvo el reinicio bloqueado, que conserva su diálogo con el aviso), con la consecuencia `warn` del `detail`, confirmación tipada derivada de `phrase`, `destructive` solo para purga y vaciado, y un `onSettled` que reproduce el aviso, el `after` y el `refresh` de `execute`. `start`, `trash`, `move` y `restore` siguen en el diálogo propio con su ruta de destino.
- `tests/verified-session.ts` centraliza `testSession`, `seedVerifiedSession` y `clearVerification`; `api-hosts`, `api-incidents`, `api-lifecycle` y `api-host-commands` lo usan, y el último pasa a llevar `session.id` en el mock.
- Suite completa en verde con el guard activo: 52 archivos y 724 pruebas, sin ninguna omitida.

### Tabla de políticas

| Acción | Política | | Comando de host | Política |
| --- | --- | --- | --- | --- |
| `stop` | protegida | | `deploy-now` | protegido |
| `restart` | protegida | | `pause-follower` | protegido |
| `update-container` | protegida | | `resume-follower` | protegido |
| `reboot` | protegida | | `run-security` | protegido |
| `purge` | protegida | | `backup-now` | protegido |
| `empty-trash` | protegida | | `clean-images` | protegido |
| `start` | exenta | | `reconnect-apps` | protegido |
| `trash` | exenta | | `check-health` | exento |
| `move` | exenta | | | |
| `restore` | exenta | | | |

## Task Commits

Cada tarea se cometió por separado:

1. **Task 1: Parar un contenedor exige verificación reciente en el servidor y la UI abre el diálogo de passkey desde el manifiesto** — `aa3ec24` (feat, tracer)
2. **Task 2: Los siete comandos de host que cambian estado exigen verificación reciente** — `c448b12` (test, RED) y `5798418` (feat, GREEN)
3. **Task 3: Los tests de API existentes siembran la verificación con el ayudante compartido y D-05 queda probado** — `a446f5f` (test)
4. **Arreglo de lint del ayudante de introspección** — `91cfb3d` (fix)

**Plan metadata:** `docs(06-01): complete security gate plan`

## Files Created/Modified

- `src/lib/sensitive-actions.ts` — manifiesto puro: `Policy`, `ActionId`, `actionPolicies`, `hostCommandPolicies` y los dos predicados
- `src/app/api/[...path]/route.ts` — el guard de la rama `action` se decide por el manifiesto
- `src/lib/host-commands.ts` — `runHostCommand` con `VerificationSession`, `store`/`now` y guard tras la validación
- `src/components/dashboard.tsx` — `useSensitiveAction` montado y `request()` delegando en él para lo protegido
- `tests/verified-session.ts` — `testSession`, `seedVerifiedSession`, `clearVerification`
- `tests/sensitive-actions.test.ts` — cobertura del esquema, matriz por acción y por comando, TTL y replay
- `tests/api-host-commands.test.ts` — mock con `session.id` y siembra compartida
- `tests/api-hosts.test.ts`, `tests/api-incidents.test.ts`, `tests/api-lifecycle.test.ts` — siembra compartida y el caso D-05

## Decisions Made

- El manifiesto es la autoridad y la UI solo lee; ninguna ruta ni componente mantiene su propia lista (D-06, D-07).
- Se conserva la ventana de 5 minutos (`RECENT_VERIFICATION_TTL_MS`) y el replay idempotente sigue precediendo al guard, como en `lifecycle.ts`; el 403 reutiliza la clave.
- El guard de host-command va después de resolver host y clave para que 404 y 400 conserven su significado.
- Un replay de comando de host ya terminado exige verificación vigente: efecto menor aceptado para no fragmentar `executeHostCommand`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] El sondeo de zod con `any` no pasaba eslint**
- **Found during:** Task 3 (verificación de la tarea)
- **Issue:** el fragmento de introspección de RESEARCH usaba `def: any`; `tsc` lo acepta pero `eslint` lo rechaza (`no-explicit-any`), y `pnpm lint` forma parte del `<verify>` de la tarea.
- **Fix:** se tipó el `def` con una interfaz mínima (`type`, `entries`, `values`); el comportamiento de la cobertura no cambia.
- **Files modified:** `tests/sensitive-actions.test.ts`
- **Verification:** `eslint src tests` sale 0 y la matriz sigue en verde.
- **Committed in:** `91cfb3d`

---

**Total deviations:** 1 auto-fixed (1 bloqueo)
**Impact on plan:** sin cambios de alcance; el manifiesto y los guards son los del plan.

## Issues Encountered

- `DATABASE_URL` no estaba exportado en el shell de la sesión: las suites se ejecutaron contra el PostgreSQL 18 desechable de loopback documentado en las fases 2–5 (`127.0.0.1:55432`) con `HUB_REQUIRE_TEST_DB=1`, así que ninguna suite se omitió.
- `pnpm lint` sobre todo el repositorio falla por los directorios de herramienta no versionados (`.opencode/`, `.agents/`, `.claude/`, `.codex/`, `.gsd/`): 5570 errores, todos en rutas que empiezan por `.`, y `eslint src tests` sale 0. Es anterior a este plan y queda registrado en [`deferred-items.md`](./deferred-items.md).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- El manifiesto y `tests/verified-session.ts` están listos para que 06-02 (límite de cuerpo y manifiesto de rutas), 06-03 (resto de la UI y e2e), 06-04 y 06-05 los consuman; 06-03 debe migrar `maintenance-extras.tsx`, `command-search.tsx` y los e2e de `files-apps` y `hosts`.
- `executeHostCommand` sigue sin guard a propósito: cualquier llamador nuevo debe aplicar el manifiesto por su cuenta.
- Hasta 06-03, el e2e de purgar y reiniciar con el diálogo propio queda desfasado y no se ejecuta en este plan.

---
*Phase: 06-puerta-de-seguridad*
*Completed: 2026-11-27*

## Self-Check: PASSED

- Archivos creados: `src/lib/sensitive-actions.ts`, `tests/verified-session.ts`, `tests/sensitive-actions.test.ts` — todos presentes.
- Commits: `aa3ec24`, `c448b12`, `5798418`, `a446f5f`, `91cfb3d` — todos ancestros de HEAD.
- Suite completa: 52 archivos / 724 pruebas en verde con `HUB_REQUIRE_TEST_DB=1`.
- `pnpm typecheck` sin errores; `eslint src tests` sale 0.
