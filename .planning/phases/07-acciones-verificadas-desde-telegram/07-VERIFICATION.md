---
phase: 07-acciones-verificadas-desde-telegram
verified: 2026-11-27T19:39:26Z
status: passed
score: 14/14 must-haves verified
covered_files:
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-01-PLAN.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-01-SUMMARY.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-02-PLAN.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-02-SUMMARY.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-03-PLAN.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-03-SUMMARY.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-04-PLAN.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-04-SUMMARY.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-05-PLAN.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-05-SUMMARY.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-06-PLAN.md"
  - ".planning/phases/07-acciones-verificadas-desde-telegram/07-06-SUMMARY.md"
  - "drizzle/0008_acciones_telegram.sql"
  - "src/components/views/telegram-handoff.tsx"
  - "src/lib/notification-dispatch.ts"
  - "src/lib/operation-runner.ts"
  - "src/lib/runtime-config.ts"
  - "src/lib/sensitive-actions.ts"
  - "src/lib/telegram-handoff-client.ts"
  - "src/lib/telegram-intent-api.ts"
  - "src/lib/telegram-intents.ts"
  - "src/lib/telegram-keyboard.ts"
  - "src/lib/telegram-updates.ts"
  - "src/lib/verification-api.ts"
  - "src/lib/verification.ts"
covered_digest: "v4:sha256:b2ebe392d3e4695c1b65c68e19ed46bc4e0ae4b5dee5d9e526f4bf66a828c658"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Provocar un backup-failed o deploy-failed reales, pulsar «Acciones…» y la acción en Telegram, abrir el botón url en el móvil, completar la passkey y comprobar la fila en operations y la edición del aviso"
    expected: "El hub abre Avisos con el diálogo «Copia ahora» / «Desplegar ahora», la acción se ejecuta una vez, operations tiene channel=telegram y requestedBy del usuario del hub, y el aviso se edita en silencio con el resultado"
    why_human: "Depende de Telegram real y del dispositivo. El e2e simula execute y no puede ejercitar WebAuthn real. La passkey puede fallar en el navegador interno de Telegram (suposición A1); en ese caso el botón debe reabrirse en el navegador del sistema antes de 5 min"
  - test: "Pulsar una acción en un aviso real, no abrir el enlace y esperar 5 min con el worker en marcha"
    expected: "El teclado se restaura en silencio con «Acciones…» y no queda un enlace muerto a la vista"
    why_human: "Necesita esperar el TTL real con el worker; las pruebas controlan el reloj, no el worker en producción"
  - test: "En el despliegue real (Nginx Proxy Manager y Tailscale Serve), con sesión iniciada por contraseña, POST a /api/verification/password en el dominio principal con Origin del origen alternativo y aparte con cabecera de host reenviada alternativa; después, por la entrada alternativa, verificar con contraseña y completar una acción"
    expected: "En el dominio principal ambos dan 403 password_not_allowed; la entrada alternativa sigue ofreciendo contraseña y la acción se ejecuta"
    why_human: "Depende de las cabeceras Host que reenvían los proxies reales, que ni el repo ni la documentación de Tailscale fijan. Si el proxy no reenviara el Host el resultado cae a passkey (sin regresión de seguridad) y la comprobación manual lo revela"
---

# Phase 7: Acciones verificadas desde Telegram Verification Report

**Phase Goal:** Permitir iniciar una acción de host desde Telegram y completarla en el hub con sesión y passkey, sin ejecutar nada desde el callback.
**Verified:** 2026-11-27T19:39:26Z
**Status:** human_needed
**Re-verification:** No, initial verification

> Nota de modo: el ROADMAP marca la fase `Mode: mvp`, pero su objetivo no tiene el formato de historia de usuario (`user-story.validate` devuelve `valid: false`). Se ha verificado de todos modos contra los criterios de éxito del ROADMAP (goal-backward estándar), porque el encargo pide explícitamente el informe. Se recomienda reformatear el objetivo con `/gsd-mvp-phase 7` si se quiere la tabla de cobertura de flujo de usuario canónica. La cobertura del flujo está resumida en la sección «User Flow Coverage».

## Goal Achievement

### User Flow Coverage (resumen)

| Paso | Esperado | Evidencia en el código | Estado |
| ---- | -------- | ---------------------- | ------ |
| Pulsar «Acciones…» y una acción en el aviso | El callback registra un intent y edita el mismo aviso con un botón url, sin ejecutar nada | `telegram-updates.ts` `registerIntent` → `createIntent` (solo inserta intent y encola edición de teclado); el carril no importa ejecutores | ✓ |
| Abrir el botón url | El hub captura `#intent=`, borra el fragmento y muestra el diálogo con verbo y objetivo | `telegram-handoff-client.ts` `captureHandoff`; `TelegramHandoff` montado en `alerts.tsx:432`; e2e HANDOFF-01/03 | ✓ |
| Confirmar con sesión y passkey | El servidor aplica el manifiesto y ejecuta una sola vez | `handleIntentExecute`: `guardIntentAction` antes de `claimIntent`; e2e + vitest con BD real | ✓ (passkey real: humano) |
| Ver el resultado | Operación con canal y solicitante; aviso editado | `operations.channel='telegram'`, `requestedBy`; `finishIntent` + `queueKeyboardEdit(:done)` | ✓ |

### Observable Truths

| #  | Truth | Status | Evidence |
| -- | ----- | ------ | -------- |
| SC1 | Una acción iniciada desde Telegram se completa en el hub con sesión y passkey; el chat solo abre el handoff | ✓ VERIFIED | `registerIntent` solo escribe `telegram_action_intents` y la edición del aviso. `execute` vive en `/api/telegram/intents/execute` (`route.ts:253`), detrás de sesión, con `guardIntentAction` → `guardSensitiveAction`. Vitest `api-telegram-intents.test.ts` "runs backup-now once from the chat handoff", "restarts a container once..." en verde con BD real |
| SC2 | Sin verificación reciente en el servidor, la acción destructiva se rechaza aunque el callback sea válido | ✓ VERIFIED | `telegram-intent-api.ts:195-202`: el guard va tras cargar el intent y antes del claim, el host y el runner. `requiresVerificationForIntent` lee `actionPolicies`/`hostCommandPolicies` (sin lista propia) y falla cerrado. Test "answers 403 to every protected stored action without verification" itera `intentActionIds`: 403 `recent_verification_required`, 0 peticiones al agente, 0 filas en `operations`, intent aún `pending`; `start` pasa solo con sesión |
| SC3 | Cada acción iniciada queda en `operations` con canal y solicitante | ✓ VERIFIED | Migración `0008` añade `operations.channel` (default `hub`) y `requestedBy`. `runAgentAction` y `executeHostCommand` insertan ambos; `route.ts:648-649` pasa `hub`; las de intent pasan `telegram` y `intent.userId`, con `operations.id = intent.id`. Test "records the channel and the requester of an operation by the surface that asked". Ver WR-05 (advertencia de necesidad) |
| SC4 | Un intent caducado o ya consumido no ejecuta la acción dos veces | ✓ VERIFIED | `claimIntent` es un único `UPDATE ... WHERE status='pending' AND expiresAt > now RETURNING`; índice único parcial `telegram_action_intents_live_idx`; el id de la operación es el del intent (`onConflictDoNothing`). Tests con Postgres real: "claims an intent once even when two claims race", "sends one request to the agent for two concurrent executes" (backup y restart), "answers 410 after the intent lapsed/cancelled", "returns the existing operation when the intent already ran" |
| T5 | El callback no ejecuta nada (D-00a): sin llamadas al agente ni filas en `operations`, y el carril no importa ejecutores | ✓ VERIFIED | `grep` de `operation-runner\|host-commands\|lifecycle\|nas` en `telegram-updates.ts`, `telegram-intents.ts`, `notification-dispatch.ts`, `incident-actions.ts`, `telegram-keyboard.ts`, `incident-store.ts`: sin importaciones. Escaneo `executorModules` en `tests/sensitive-actions.test.ts:384` en verde. `telegram-intents.test.ts` "turns a backup press into one pending intent without running anything" |
| T6 | Un intent vivo por aviso (D-10), impuesto por índice único parcial; una segunda acción no crea nada | ✓ VERIFIED | Índice parcial en `0008_acciones_telegram.sql`; `createIntent` con `onConflictDoNothing` → `live`. Tests "keeps one live intent per notice and allows another once it lapsed", "keeps a single link when an action is pressed while an intent is live" |
| T7 | Token de un solo uso, solo el hash en la base (D-00b); viaja en el fragmento | ✓ VERIFIED | `handoffToken` HMAC derivado, `hashHandoffToken` SHA-256; la tabla solo tiene `handoffHash`; `handoffHref` pone `#intent=`; `execute`/`inspect` leen el token solo del cuerpo (`z.strictObject`); `captureHandoff` hace `replaceState` conservando path y query. Vitest `telegram-handoff-client.test.ts` y e2e HANDOFF-01/02/11 |
| T8 | Tabla de acciones D-01..D-03: contenedor → Arrancar/Reiniciar; backup-failed, deploy-failed y reboot-pending su acción; el resto, nada; Actualizar/Detener/Eliminar no existen | ✓ VERIFIED | `hostActionsFor` e `intentActionIds` (con `satisfies` contra el manifiesto). Tests "never offers update, stop or remove as an intent action", "offers nothing to the outage or to any other condition" |
| T9 | Teclado: «Acciones…», «Volver», botón url + «Cancelar»; caducidad restaura el teclado vía outbox con `nextAttemptAt = expiresAt`; al resolverse desaparecen las acciones; callback_data ≤ 64 B | ✓ VERIFIED | `telegram-keyboard.ts` matriz por vista; `createIntent` encola `:open` y `:expire` con `notBefore`; `dispatchEdit` recompone el botón url con `handoffToken(secret, intent.id)` (`notification-dispatch.ts:644`). Tests de matriz (25 B por token), "queues the expiry row at expiresAt and delivers it only then", "renders no handoff button once the intent has expired", "cancels the intent and restores the normal keyboard in silence" |
| T10 | `start` también pasa por el hub (D-04) con sesión y sin passkey; `restart`/`reboot` piden verificación; `reboot` sin frase tecleada (D-12) | ✓ VERIFIED | `agentBodyOf` inyecta `confirmation: "REINICIAR NAS"` en el servidor; test "runs start with the session alone, resolving the id by name", "asks for a recent verification before restart and reboot", "requests the reboot with the server confirmation and leaves the operation pending"; e2e HANDOFF-07/08 |
| T11 | CR-01 corregido (D-13): el factor se decide por el `Host` del proxy, no por `Origin` | ✓ VERIFIED | `verification.ts:111-124` `verificationMethodForRequest`: `Origin` que difiere del host de conexión, `Host` ilegible/lista, `Origin` ilegible y ausencia de dominio principal caen a `passkey`; no lee cabeceras reenviadas. `execute` con `Host` principal y `Origin` alternativo falsificado con verificación `password` → 403 `method: passkey`, intent `pending` (test línea 1144); la entrada alternativa genuina → 200 (línea 1163). `06-REVIEW-DISPOSITION.md`: CR-01 `fixed` (07-06) |
| T12 | `TELEGRAM_DIRECT_ACTIONS` solo admite `0` o ausente (D-00a); documentado | ✓ VERIFIED | `runtime-config.ts:334-335` añade incidencia `invalid` para cualquier otro valor; `.env.example:32` y `README.md:105`. Cubierto por `tests/runtime-config.test.ts` (suite completa en verde) |
| T13 | Handoff en el hub: login sin perder el intent, estados `data-handoff-state`, diálogo con verbo y objetivo, passkey solo cuando `inspect` lo indica, estados terminales sin llamar a `execute` | ✓ VERIFIED | `login.tsx:31` captura antes del login; `TelegramHandoff` lee `requiresVerification` de `inspect`; Playwright: 26/26 en verde (HANDOFF-01..16 y sensitive-action) contra la compilación actual y BD migrada |
| T14 | Migración 0008 aditiva (no reescribe filas), y limpieza horaria elimina intents con más de 24 h desde la caducidad | ✓ VERIFIED | `0008_acciones_telegram.sql` solo `CREATE TABLE`, `ADD COLUMN ... DEFAULT` e índices. `tests/migrations.test.ts` (migración sobre datos existentes) y `telegram-intents.test.ts` en verde |

**Score:** 14/14 verdades verificadas (0 presentes con comportamiento sin verificar)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `drizzle/0008_acciones_telegram.sql` | Tabla, índices parcial y único, columnas aditivas | ✓ VERIFIED | Presente y sustantivo; aplicado en la BD de prueba |
| `src/lib/telegram-intents.ts` (400 líneas) | Ciclo de vida del intent | ✓ VERIFIED | create/claim/finish/release/cancel/expire reales, atómicos; importado por `telegram-updates`, `telegram-intent-api`, `notification-dispatch` |
| `src/lib/telegram-intent-api.ts` (397 líneas) | `inspect`/`execute` | ✓ VERIFIED | Enrutado en `route.ts:251-254`, declarado en el manifiesto |
| `src/lib/operation-runner.ts` (173 líneas) | Runner extraído | ✓ VERIFIED | Usado por `/api/action` y por el intent |
| `src/lib/verification-api.ts` `guardIntentAction` | Decide por la acción almacenada y delega | ✓ VERIFIED | `verification-api.ts:126-146` |
| `src/lib/sensitive-actions.ts` | Rutas `telegram/intents/*` y `requiresVerificationForIntent` | ✓ VERIFIED | Sin segunda lista |
| `src/lib/telegram-handoff-client.ts` | Captura, almacenamiento, limpieza | ✓ VERIFIED | Puro, probado |
| `src/components/views/telegram-handoff.tsx` (359 líneas) | Panel y diálogo | ✓ VERIFIED | Montado en `alerts.tsx:432` |
| `src/lib/verification.ts` | Factor por `Host` | ✓ VERIFIED | Ver T11 |
| `README.md` / `.env.example` | Contrato del proxy y `TELEGRAM_DIRECT_ACTIONS` | ✓ VERIFIED | Presentes |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `telegram-updates.ts` | `telegram-intents.ts` | `applyTokenAction` → `registerIntent` → `createIntent` en la transacción del token y el offset | WIRED | Líneas 209, 313 |
| `telegram-intents.ts` | `incident-store.ts` | `queueKeyboardEdit` `:open` y `:expire` | WIRED | Líneas 306-311 |
| `notification-dispatch.ts` | `telegram-intents.ts` | `handoffToken`/`handoffHref` para el botón url | WIRED | Líneas 644-648 |
| `route.ts` | `telegram-intent-api.ts` | literales `telegram/intents/inspect` y `execute` | WIRED | Líneas 251-254 |
| `telegram-intent-api.ts` | `verification-api.ts` | `guardIntentAction` antes del claim | WIRED | Línea 195 |
| `telegram-intent-api.ts` | `operation-runner.ts` / `host-commands.ts` | `runAgentAction` y `executeHostCommand` con `operationId = intent.id`, `channel: "telegram"` | WIRED | Líneas 262-293 |
| `route.ts` | `operation-runner.ts` | rama `action` con `channel: "hub"` | WIRED | Líneas 643-649 |
| `alerts.tsx` / `login.tsx` | `telegram-handoff*` | montaje y captura previa al login | WIRED | `alerts.tsx:432`, `login.tsx:31` |
| `verification-api.ts` | `verification.ts` | `verificationMethodForRequest` | WIRED | Los tres consumidores heredan la regla |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `telegram-handoff.tsx` | `intent` (verbo, objetivo, `requiresVerification`) | `POST /api/telegram/intents/inspect` → `findIntentByToken` (SELECT sobre `telegram_action_intents`) + `requiresVerificationForIntent` | Sí | ✓ FLOWING |
| `notification-dispatch.ts` botón url | `intent.action`, `intent.target`, token | `liveIntentOf` (SELECT) + HMAC | Sí | ✓ FLOWING |
| Acciones recientes (canal) | `operation.channel` | `operations.channel` vía `publicOperation` | Sí | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Suites de la fase con Postgres obligatorio | `HUB_REQUIRE_TEST_DB=1 pnpm vitest run tests/telegram-intents.test.ts tests/api-telegram-intents.test.ts tests/verification.test.ts tests/sensitive-actions.test.ts tests/telegram-keyboard.test.ts tests/migrations.test.ts` | 6 ficheros, 238 tests | ✓ PASS |
| Suite completa (una vez) | `HUB_REQUIRE_TEST_DB=1 pnpm vitest run` | 59 ficheros, 974 tests | ✓ PASS |
| Typecheck | `pnpm exec tsc --noEmit` | sin salida | ✓ PASS |
| E2E del handoff y de acción sensible (BD `hub` en 127.0.0.1:55433, `HUB_E2E_HARNESS=1`) | `playwright test tests/e2e/telegram-handoff.spec.ts tests/e2e/sensitive-action.spec.ts` | 26 passed | ✓ PASS |

### Probe Execution

Step 7c: SKIPPED. Ni los PLAN ni los criterios declaran sondas `probe-*.sh`.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| BOT-07 | 07-01, 07-02, 07-03, 07-04, 07-05, 07-06 | Iniciar una acción de host desde Telegram y completarla en el hub con sesión y passkey | ✓ SATISFIED (UAT real pendiente) | SC1, T5-T10, T13. Passkey real en el navegador de Telegram: verificación humana |
| BOT-08 | 07-01, 07-02, 07-04, 07-05, 07-06 | Ninguna acción destructiva iniciada desde Telegram se ejecuta sin verificación reciente en el servidor | ✓ SATISFIED | SC2, T10, T11 |
| BOT-09 | 07-01, 07-02, 07-04, 07-05 | Cada acción iniciada desde Telegram queda en `operations` con canal y solicitante | ✓ SATISFIED | SC3, T14 |

Los tres IDs de los PLAN figuran en `REQUIREMENTS.md` (líneas 48-50, marcados `[x]`, trazados a Phase 7). No hay requisitos huérfanos: `REQUIREMENTS.md` no asigna otros IDs a la fase 7 y 07-03 declara solo BOT-07.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (ficheros de la fase) | - | `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` | ✓ ninguno | Sin marcadores de deuda; sin `console.*` en el cliente del handoff |
| `src/lib/telegram-intent-api.ts` | 227-248 | Tras `claimIntent`, `run()` y la transacción de cierre no están protegidos (WR-01) | ⚠️ Warning | Una excepción deja el intent en `executing` para siempre: el enlace no se reutiliza, `inspect` lo muestra como `consumed`. No produce ejecución doble, falla hacia no ejecutar |
| `src/lib/telegram-intent-api.ts` | 227-235 | Perder la carrera del claim reescribe un intent `ready` como `expired` (WR-04) | ⚠️ Warning | Ventana estrecha (liberación tras 503 concurrente); la UI trata `intent_expired` como terminal y borra el token de un enlace aún vivo |
| `src/components/views/telegram-handoff.tsx` | 56-67, 294-309 | Un fallo `failed` del agente ofrece «Reintentar» que luego muestra «ya se había ejecutado» (WR-03) | ⚠️ Warning | Mensaje falso y reintento imposible tras un rechazo del agente; no ejecuta nada |
| `src/lib/incident-store.ts` | 228-243, 1026-1029 | Las filas de edición solo de teclado contaminan la proyección «última actualización» de Avisos (WR-02) | ⚠️ Warning | Aviso muestra «En cola» hasta 5 min tras crear un intent; defecto visual en el hub |
| `src/lib/schema.ts` | 458-459 | `operations.requestedBy` siempre igual a `userId` (WR-05, necesidad) | ℹ️ Info | El requisito BOT-09 («canal y solicitante») se cumple literalmente; el campo no aporta información propia hoy |
| `src/lib/runtime-config.ts` | 324-336 | `TELEGRAM_DIRECT_ACTIONS` existe solo para rechazarse (IN-01) | ℹ️ Info | Decisión deliberada D-00a; `07-REVIEW-DISPOSITION.md` los lista como `open` (7 de 7 sin triar) |

Ninguno de los hallazgos de `07-REVIEW.md` contradice una verdad exigida: cada uno falla hacia no ejecutar (ninguno permite una segunda ejecución ni salta el guard). Se registran como advertencias para triar; su disposición sigue `open` en `07-REVIEW-DISPOSITION.md`.

### Human Verification Required

#### 1. Flujo real de Telegram con passkey

**Test:** Provocar un `backup-failed` o `deploy-failed`, pulsar «Acciones…» y la acción, abrir el botón url en el móvil, completar la passkey y comprobar la fila en `operations` y la edición del aviso.
**Expected:** La acción se ejecuta una vez; `operations` queda con `channel = telegram` y el solicitante; el aviso se edita en silencio con el resultado.
**Why human:** Depende de Telegram y del dispositivo reales; el e2e simula `execute` y no ejercita WebAuthn. Si la passkey falla en el navegador interno de Telegram (A1), reabrir el botón en el navegador del sistema antes de 5 min.

#### 2. Caducidad real sin enlace muerto

**Test:** Pulsar una acción, no abrir el enlace y esperar 5 min con el worker en marcha.
**Expected:** El teclado vuelve a «Acciones…» en silencio.
**Why human:** Necesita el TTL real y el worker en producción.

#### 3. Contrato de cabeceras de los proxies (D-13 / CR-01)

**Test:** Comandos de README, «Factor de verificación por entrada», contra el dominio principal y la entrada de Tailscale Serve.
**Expected:** El dominio principal responde 403 `password_not_allowed` a un `Origin` o host reenviado falsificados; la entrada alternativa conserva la contraseña.
**Why human:** Depende de las cabeceras `Host` reales que reenvían Nginx Proxy Manager y Tailscale Serve.

### Gaps Summary

No hay verdades falladas, artefactos ausentes ni enlaces sin cablear: los cuatro criterios de éxito del ROADMAP y las verdades adicionales de los seis planes están respaldados por código real y por pruebas que pasan contra Postgres real (974 de 974 en vitest, 26 de 26 en Playwright, `tsc` limpio). La fase no queda en `passed` porque tres comprobaciones solo son posibles con Telegram, WebAuthn y los proxies reales (listadas arriba, tomadas del plan de verificación manual de `07-VALIDATION.md`). Las cinco advertencias del code review (WR-01..WR-05) siguen abiertas; WR-01, WR-03 y WR-04 conviene triarlas antes de dar la fase por cerrada, aunque ninguna rompe un criterio de éxito.

---

_Verified: 2026-11-27T19:39:26Z_
_Verifier: Claude (gsd-verifier)_
