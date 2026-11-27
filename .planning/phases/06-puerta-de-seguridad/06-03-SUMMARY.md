---
phase: 06-puerta-de-seguridad
plan: "03"
subsystem: ui
tags: [verification, passkey, sensitive-action, host-commands, playwright, react]

requires:
  - phase: 06-puerta-de-seguridad
    provides: "Manifiesto sensitive-actions (hostCommandPolicies, requiresVerificationForCommand) y guards del servidor de 06-01"
provides:
  - "src/lib/host-command-client.ts: sendHostCommand, envío directo de un comando exento con Idempotency-Key nueva"
  - "La tarjeta Acciones del host y la búsqueda Ctrl K piden passkey exactamente para los comandos que el manifiesto protege"
  - "Prop onNotice de CommandSearch y ganchos data-command-option y data-toast"
  - "e2e de archivos y de host adaptados al diálogo de acción sensible"
affects: [06-04, 06-05, 06-06, fase-7-telegram]

actuals:
  tokens: 5666
  tasks: 2
  commits: 2
  plan_head_before: b982f7f105b4c5c56d004e562623c0ec06f251a4
  plan_head_after: 538a63517620cca085d47a00107c673e3e80c7f8

tech-stack:
  added: []
  patterns:
    - "La UI decide con requiresVerificationForCommand: ninguna lista propia de comandos protegidos en src/components"
    - "Un solo camino para pintar el resultado de un comando, enviado directo o por el diálogo (applyResult)"
    - "El e2e recorre hostCommandPolicies y asserta estado y peticiones, nunca copy"

key-files:
  created:
    - src/lib/host-command-client.ts
  modified:
    - src/components/views/maintenance-extras.tsx
    - src/components/command-search.tsx
    - src/components/dashboard.tsx
    - tests/e2e/maintenance-workflows.spec.ts
    - tests/e2e/files-apps.spec.ts
    - tests/e2e/hosts.spec.ts

key-decisions:
  - "check-health se envía directo con sendHostCommand; el resto de comandos pasa por useSensitiveAction, que genera y reutiliza la Idempotency-Key"
  - "commandConsequence se exporta desde maintenance-extras y lo comparten la tarjeta y la búsqueda para no duplicar el texto de consecuencias"
  - "El diálogo no informa del estado HTTP: onSettled reconstruye el que necesita la tarjeta (502 si pendiente, 400 con error si falló, 200 si terminó) y reutiliza el mismo applyResult"
  - "Se añade data-command-option junto al data-search-command existente, tal y como pide el plan, y data-toast al aviso del panel para poder aseverar el aviso sin copy"

patterns-established:
  - "Cliente de comando exento: sendHostCommand deja propagar el error de red para que el llamador lo trate como pendiente"
  - "Prueba de paridad UI y manifiesto: iterar las opciones presentes y comparar con hostCommandPolicies, exigiendo al menos un protegido y check-health"

requirements-completed: [SEC-01]

coverage:
  - id: D1
    description: "Desde la tarjeta Acciones del host cada comando protegido abre el diálogo de acción sensible sin enviar nada hasta confirmar, y check-health se envía directo con Idempotency-Key y sin diálogo"
    requirement: "SEC-01"
    verification:
      - kind: e2e
        ref: "tests/e2e/maintenance-workflows.spec.ts#the host actions card asks for verification exactly for the protected commands"
        status: pass
    human_judgment: false
  - id: D2
    description: "Lo mismo desde la búsqueda Ctrl K, y un fallo de check-health desde la búsqueda se comunica con el aviso del panel"
    requirement: "SEC-01"
    verification:
      - kind: e2e
        ref: "tests/e2e/maintenance-workflows.spec.ts#the Ctrl K search asks for verification exactly for the protected commands"
        status: pass
      - kind: e2e
        ref: "tests/e2e/maintenance-workflows.spec.ts#a check-health rejected from the search is reported in the panel notice"
        status: pass
    human_judgment: false
  - id: D3
    description: "Confirmar clean-images en el diálogo envía una sola petición con cuerpo { command } y clave UUID, la tarjeta muestra el resultado y no aparece ningún diálogo nativo"
    requirement: "SEC-01"
    verification:
      - kind: e2e
        ref: "tests/e2e/maintenance-workflows.spec.ts#confirming clean-images in the dialog sends one request and the card shows the outcome"
        status: pass
    human_judgment: false
  - id: D4
    description: "Purgar y vaciar la papelera abren el diálogo de acción sensible (vaciar exige la frase), restaurar y mover conservan el diálogo simple y el reinicio mantiene host=apps"
    requirement: "SEC-01"
    verification:
      - kind: e2e
        ref: "tests/e2e/files-apps.spec.ts#the trash panel sits beside the folder and shows when each item expires"
        status: pass
      - kind: e2e
        ref: "tests/e2e/files-apps.spec.ts#rename, move and trash are confirmed actions on the selected root"
        status: pass
      - kind: e2e
        ref: "tests/e2e/hosts.spec.ts#actions are sent to the selected host"
        status: pass
    human_judgment: false
  - id: D5
    description: "El aspecto y la ergonomía del diálogo de passkey en la tarjeta y la búsqueda (foco, consecuencias, tono) conforme al contrato de diseño de la fase"
    verification: []
    human_judgment: true
    rationale: "El e2e asserta estado y peticiones, no la calidad visual ni el flujo con una passkey real; se revisa al cierre de la fase con 06-UI-SPEC."

duration: 7 min
completed: 2026-11-27
status: complete
---

# Phase 06 Plan 03: La interfaz pide passkey solo para lo que el servidor protege Summary

**La tarjeta Acciones del host y la búsqueda Ctrl K delegan en useSensitiveAction los siete comandos que el manifiesto protege y envían check-health directo con Idempotency-Key nueva, sin window.confirm; los e2e de archivos y host usan el diálogo de acción sensible para purgar, vaciar y reiniciar.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-11-27T11:45:51Z
- **Completed:** 2026-11-27T11:52:26Z
- **Tasks:** 2
- **Files modified:** 7 (1 nuevo, 6 modificados)

## Accomplishments

- `sendHostCommand` (`src/lib/host-command-client.ts`) hace el POST de un comando exento con `crypto.randomUUID()` como clave, devuelve `{ ok, status, data }` y deja propagar el error de red para que el llamador lo trate como pendiente.
- `HostCommands.run()` decide con `requiresVerificationForCommand`: lo protegido abre `sensitive.request` con `endpoint: withHost("/api/host-command")` y un `onSettled` que aplica el resultado por el mismo `applyResult` que la respuesta directa (detalle, "Pendiente de verificar" para 5xx distinto de 503, `maintenance-refresh`). `window.confirm` de `clean-images` desaparece: su consecuencia `warn` es el texto del diálogo.
- `CommandSearch` hace lo mismo: los protegidos conservan `sensitive.request`; `check-health` cierra la paleta, se envía con `sendHostCommand`, emite `maintenance-refresh` y comunica el resultado con la nueva prop `onNotice`, que `Dashboard` conecta a `setToast`.
- `dashboard.tsx` pasa `description: hostLabel` en las peticiones de acción sensible y el aviso del panel gana `data-toast`.
- `tests/e2e/maintenance-workflows.spec.ts` gana cuatro casos que recorren `hostCommandPolicies` en la tarjeta y en la búsqueda, el aviso de un fallo de `check-health` desde la búsqueda, y la confirmación de `clean-images`; un diálogo nativo hace fallar la prueba.
- `files-apps.spec.ts` y `hosts.spec.ts` verifican que purgar, vaciar y reiniciar abren el diálogo de acción sensible (vaciar con el botón deshabilitado hasta escribir la frase), que restaurar y mover siguen en el simple, y que la petición de reinicio lleva `host=apps`.

## Task Commits

1. **Task 1 (tracer): La tarjeta y la búsqueda piden passkey para los comandos protegidos y envían check-health directo** — `4dee4a3` (feat)
2. **Task 2: Los e2e de archivos y de host usan el diálogo de acción sensible para purgar, vaciar y reiniciar** — `538a635` (test)

**Plan metadata:** `docs(06-03): complete host command UI gate plan`

El tracer se verificó de extremo a extremo antes de expandir: `pnpm test tests/maintenance-ui.test.ts`, `pnpm typecheck`, `pnpm lint src tests`, `pnpm build` y `pnpm test:e2e tests/e2e/maintenance-workflows.spec.ts` (7 pruebas).

## Files Created/Modified

- `src/lib/host-command-client.ts` — `sendHostCommand`, envío directo de un comando exento con clave nueva
- `src/components/views/maintenance-extras.tsx` — `HostCommands` decide por el manifiesto, `applyResult`/`applyPending` compartidos, `commandConsequence` exportada
- `src/components/command-search.tsx` — decisión por el manifiesto, `check-health` directo con `onNotice`, `data-command-option`
- `src/components/dashboard.tsx` — `onNotice={setToast}`, `description` con el host y `data-toast` en el aviso
- `tests/e2e/maintenance-workflows.spec.ts` — paridad UI y manifiesto en tarjeta y búsqueda, aviso de fallo y confirmación de `clean-images`
- `tests/e2e/files-apps.spec.ts` — papelera con diálogo de acción sensible para purgar y vaciar; simple para restaurar y mover
- `tests/e2e/hosts.spec.ts` — reinicio de `seerr` confirmado en el diálogo de acción sensible con `host=apps`

## Decisions Made

- La UI solo lee las tablas de `sensitive-actions.ts`; no existe ninguna lista de comandos protegidos en `src/components`.
- `commandConsequence` se comparte entre la tarjeta y la búsqueda en lugar de duplicar el texto; el texto de la búsqueda no cambia.
- El diálogo no expone el estado HTTP, así que `onSettled` lo reconstruye (502 pendiente, 400 con el error si falló, 200 si terminó) para reutilizar un único camino de pintado.
- Se añadió `data-command-option` junto a `data-search-command` (ya existía y nadie lo usa en los tests) siguiendo el plan al pie de la letra.

## Deviations from Plan

None - plan executed exactly as written. (Ajuste menor documentado: el cuerpo de `/api/verification` se registra en cada prueba con la forma de `maintenance.spec.ts`, aunque el `beforeEach` ya servía una verificación reciente por contraseña.)

## Issues Encountered

- `DATABASE_URL` no estaba exportado en el shell: el e2e y las suites se ejecutaron contra el PostgreSQL 18 desechable de loopback (`127.0.0.1:55432`) con las variables de prueba del bloque `env` de CI y `HUB_REQUIRE_TEST_DB=1`.
- En la suite completa de Vitest, `tests/migrations.test.ts` y `tests/digest-ack-labels.test.ts` agotaron su plazo por carga (3 pruebas); ajenas a este plan, pasan en solitario (17 pruebas).
- `pnpm lint` sobre todo el repositorio ya fallaba por los directorios de herramienta no versionados; `pnpm lint src tests` sale 0 (registrado en `deferred-items.md` por 06-01).

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None: sin rutas, endpoints ni accesos nuevos; la UI solo explica y el servidor sigue siendo la autoridad (T-06-10 mitigado por los e2e que recorren `hostCommandPolicies`).

## Next Phase Readiness

- Toda la UI de mutaciones (contenedores, archivos y siete comandos del host, desde tarjeta y búsqueda) pide verificación exactamente para lo protegido; 06-04 a 06-06 pueden apoyarse en ello.
- La suite e2e de acciones (`files-apps`, `hosts`, `maintenance`, `sensitive-action`, `maintenance-workflows`) está completa en verde: 40 pruebas.

---
*Phase: 06-puerta-de-seguridad*
*Completed: 2026-11-27*

## Self-Check: PASSED

- Archivo creado: `src/lib/host-command-client.ts` presente.
- Commits `4dee4a3` y `538a635` ancestros de HEAD.
- `pnpm typecheck` y `pnpm lint src tests` sin errores; 40 e2e en verde.
