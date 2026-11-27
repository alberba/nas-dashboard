---
phase: 07-acciones-verificadas-desde-telegram
plan: "06"
subsystem: auth
tags: [verification, passkey, password, host-header, proxy, cr-01]
status: complete

requires:
  - phase: 06-puerta-de-seguridad
    provides: "verificationMethodForRequest, handlePasswordVerification, guardSensitiveAction y el hallazgo CR-01 de 06-REVIEW.md"
provides:
  - "El factor de verificacion (passkey o contrasena) se decide por el Host que fija el proxy, no por el Origin del cliente"
  - "CR-01 de la fase 6 resuelto y marcado fixed en 06-REVIEW-DISPOSITION.md"
  - "Contrato del proxy documentado en el README con comprobacion manual"
affects: [07-02, 07-validation]

actuals:
  tokens: 7000
  tasks: 3
  commits: 4
plan_head_before: 73e4d9b54cdbc2326ed928542e0ac607b7a2a0f8
plan_head_after: f17c4d00451ff29c41b17dc3ff215f824eaccc79

tech-stack:
  added: []
  patterns:
    - "Decision por cabecera que reescribe el proxy (Host), con fallo cerrado a passkey ante cualquier ambiguedad"

key-files:
  created: []
  modified:
    - src/lib/verification.ts
    - tests/verification.test.ts
    - tests/sensitive-actions.test.ts
    - README.md
    - .planning/phases/06-puerta-de-seguridad/06-REVIEW-DISPOSITION.md

key-decisions:
  - "P-26: decide el Host, no el host reenviado ni el protocolo reenviado, porque el cliente puede fijar estos y el proxy no esta obligado a sobrescribirlos"
  - "P-27: Origin y Host se comparan por nombre de host, sin puerto"
  - "P-28: sin cabecera Host se usa el nombre de request.url; un Host con comas, vacio o ilegible cae a passkey"
  - "P-30: no se fija el host de inicio de sesion en la sesion; el metodo se decide por peticion"
  - "P-31: WR-01 a WR-04 de la fase 6 quedan fuera"

requirements-completed: [BOT-07, BOT-08]

coverage:
  - id: D1
    description: "Un Origin alternativo falsificado contra el Host principal no obtiene el metodo password: POST /api/verification/password responde 403 password_not_allowed sin llamar a verifyPassword ni guardar verificacion"
    requirement: BOT-07
    verification:
      - kind: unit
        ref: "tests/verification.test.ts#does not give the password to a forged alternate Origin on the primary host"
        status: pass
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#refuses the password route on the primary host with a forged Origin"
        status: pass
    human_judgment: false
  - id: D2
    description: "Con una verificacion password guardada, una accion protegida con el Origin falsificado responde 403 recent_verification_required con metodo passkey, sin peticion al agente y sin filas en operations"
    requirement: BOT-08
    verification:
      - kind: unit
        ref: "tests/verification.test.ts#does not let a stored password verification satisfy an action sent with a forged Origin"
        status: pass
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#does not let a password verification run a protected action sent with a forged Origin"
        status: pass
    human_judgment: false
  - id: D3
    description: "Host ambiguo, Origin ilegible o null, host reenviado y falta de dominio principal caen a passkey; la entrada alternativa genuina y el passkey del principal conservan su flujo"
    requirement: BOT-07
    verification:
      - kind: unit
        ref: "tests/verification.test.ts#method by connection host"
        status: pass
      - kind: integration
        ref: "tests/sensitive-actions.test.ts#verification factor by entry"
        status: pass
    human_judgment: false
  - id: D4
    description: "README documenta el contrato del proxy y 06-REVIEW-DISPOSITION.md marca CR-01 como fixed"
    requirement: BOT-07
    verification:
      - kind: other
        ref: "grep de la tarea 3 (subseccion unica, fixed, open: 8)"
        status: pass
    human_judgment: false
  - id: D5
    description: "En el despliegue real, Nginx Proxy Manager y Tailscale Serve reenvian el Host original: la entrada alternativa sigue ofreciendo contrasena y el dominio principal rechaza un Origin o un host reenviado falsificados"
    requirement: BOT-08
    human_judgment: true
    rationale: "Comportamiento de proxies externos que ni el repo ni la documentacion de Tailscale fijan; solo se comprueba en el despliegue real con la comprobacion manual del README"
---

# Phase 7 Plan 06: Factor de verificacion por Host Summary

**`verificationMethodForRequest` decide passkey o contrasena por el `Host` que fija el proxy, con un `Origin` incoherente o ilegible y cualquier `Host` ambiguo cayendo a passkey, lo que cierra CR-01 (forjar el `Origin` alternativo en el dominio principal).**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-11-27
- **Tasks:** 3 (1 tracer, 2 auto) | **Files:** 5 modificados | **Commits:** 4 de produccion

## Accomplishments

- Regla unica de decision en `src/lib/verification.ts` (sin cambios en `verification-api.ts`, esquema ni rutas):
  1. Host de la conexion: nombre de la cabecera `Host`, sin puerto y en minusculas; sin cabecera, el nombre de `request.url`; una cabecera con comas, vacia o que no es `nombre[:puerto]` (incluido IPv6 entre corchetes) no da host.
  2. Sin host de conexion o sin dominio principal legible: `passkey`.
  3. Con `Origin` presente, su nombre debe ser el del host de la conexion; si no coincide o no se lee (incluido `null`): `passkey`.
  4. En otro caso: `passkey` si el nombre es el de `BETTER_AUTH_URL`, `password` si es otro.
- Eliminados `requestOrigin` y `verificationMethodForOrigin` (sin importadores; `pnpm typecheck` limpio). No se lee ninguna cabecera de host o protocolo reenviados.
- El ataque de `06-REVIEW.md` CR-01 falla por el handler, por el guard y por la ruta real del catch-all (`/api/verification/password` y `/api/action` de `stop`).
- README: subseccion «Factor de verificacion por entrada» con el contrato del proxy y la comprobacion manual con `curl`.
- `06-REVIEW-DISPOSITION.md`: CR-01 `fixed` con «07-06 (D-13)», `open: 8`.

## Evidencia rojo a verde (TDD)

- **RED** (`d6d31f3`, `test(07-06)`): `does not give the password to a forged alternate Origin on the primary host` fallo con `expected 200 to be 403` y `does not let a stored password verification satisfy an action sent with a forged Origin` con `expected undefined to be 403`; los 11 casos previos en verde (2 failed, 11 passed). Evaluacion semantica: el objetivo se ejecuto y fallo en la asercion planificada (estado HTTP) porque el `Origin` falsificado elegia `password`; no fue un error de import, de sintaxis ni de fixture. No se persistio un registro para `gsd check tdd-red-evidence` (el comando `gsd_run` no esta disponible en este entorno); la evidencia es la salida literal anterior.
- **GREEN** (`f35c9f9`, `fix(07-06)`): 13 de 13 en verde y `pnpm typecheck` limpio.
- **Cobertura ampliada** (`630e5f4`): se corrieron las pruebas nuevas de la tarea 2 contra el `verification.ts` anterior (`d6d31f3`): 10 fallan (los 2 del handler/guard, 6 filas de la matriz, y los 2 de la ruta real); con la correccion, 128 de 128 pasan. Las filas de la matriz que ya pasaban con el codigo antiguo (host/Origin coherentes, puerto distinto) son regresiones de contrato, no del ataque.
- No hay commit `refactor`: no hizo falta.

## Task Commits

1. **Tarea 1 (tracer):** `d6d31f3` test (RED), `f35c9f9` fix (GREEN)
2. **Tarea 2:** `630e5f4` test (matriz, flujo genuino y ruta real)
3. **Tarea 3:** `f17c4d0` docs (README y disposicion de la fase 6)

## Estado de CR-01 en la fase 6

`fixed` en frontmatter y tabla de `06-REVIEW-DISPOSITION.md`, Source «07-06 (D-13)», `open: 8`. Las demas filas y la marca `recorded` no se tocaron.

## Comprobacion manual en el despliegue real

**Pendiente.** No se ejecuto contra Nginx Proxy Manager ni Tailscale Serve (no hay acceso al despliegue desde este entorno). Se registra en el UAT de fin de fase (`07-VALIDATION.md`, verificaciones solo manuales): los dos `curl` del README al dominio principal deben dar 403 `password_not_allowed`, y por la entrada alternativa la contrasena del dialogo debe funcionar. Si el proxy no reenviara el `Host`, el resultado cae a passkey (sin regresion de seguridad) y la comprobacion lo revela.

## Deviations from Plan

None - plan executed exactly as written.

Notas sin impacto: la tarea 2 es `tdd="true"` pero su implementacion ya estaba desde la tarea 1, asi que las pruebas nuevas nacen en verde (se comprobo que no son vacias ejecutandolas contra el codigo anterior). El `pnpm lint` global del repo falla por ficheros ajenos sin seguimiento (`.opencode/`, `.claude/`, etc.); se paso `eslint` solo sobre los tres ficheros TypeScript tocados, sin errores.

## Known Stubs

None.

## Threat Flags

None. Sin superficie nueva: no hay endpoints, rutas, esquema ni dependencias nuevas. T-07-21 y T-07-22 quedan mitigados con pruebas; T-07-24 con la prueba de la entrada genuina y la comprobacion manual pendiente; T-07-23 aceptado segun el plan.

## Next Phase Readiness

07-02 puede depender de esta correccion: `guardSensitiveAction` (y con el `guardIntentAction`) hereda la regla por `verificationMethodForRequest`.

## Self-Check: PASSED

- FOUND: src/lib/verification.ts, tests/verification.test.ts, tests/sensitive-actions.test.ts, README.md, 06-REVIEW-DISPOSITION.md
- FOUND commits: d6d31f3, f35c9f9, 630e5f4, f17c4d0 (todos ancestros de HEAD; RED precede a GREEN)
