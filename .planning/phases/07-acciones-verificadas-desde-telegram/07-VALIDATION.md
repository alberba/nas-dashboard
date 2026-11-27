---
phase: "07"
slug: "acciones-verificadas-desde-telegram"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-27"
---

# Fase 7 · Estrategia de validación

> Contrato de validación de la fase para muestrear el resultado durante la ejecución. Sale de la [investigación](07-RESEARCH.md#validation-architecture).

---

## Infraestructura de pruebas

| Propiedad | Valor |
|-----------|-------|
| **Framework** | Vitest ^5.1.0 (Node, sin jsdom) y Playwright ^1.65.0 (e2e en Chromium) |
| **Configuración** | `vitest.config.ts` (alias `@` a `src`, `include: ["tests/**/*.test.ts"]`) y `playwright.config.ts` (`testDir: tests/e2e`, `webServer: pnpm start`) |
| **Comando rápido** | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts tests/sensitive-actions.test.ts && pnpm typecheck` |
| **Suite completa** | `HUB_REQUIRE_TEST_DB=1 pnpm test && pnpm typecheck && pnpm lint src tests && pnpm build && pnpm test:e2e` |
| **Base de datos** | PostgreSQL 18 desechable de loopback, como en CI. `HUB_REQUIRE_TEST_DB=1` impide que se omitan casos. `DATABASE_URL` no estaba definida en el shell durante la investigación: sin ella los tests con base se omiten, y con `HUB_REQUIRE_TEST_DB=1` fallan. El contenedor `hub-phase3-pg` (`postgres:18`) estaba en marcha. |
| **Duración estimada** | Según lo observado en la fase 6: Vitest completo, de 20 a 32 s; e2e focalizados, de 6 a 33 s; `pnpm test:e2e` completo, unos 2 min |

Vitest corre en Node sin DOM, así que la lógica del cliente del handoff se aísla en funciones puras con `location`, `history` y `storage` inyectados (`telegram-handoff-client.ts`). El comportamiento visual se cubre con Playwright.

---

## Frecuencia

- **Tras cada tarea:** `HUB_REQUIRE_TEST_DB=1 pnpm test <ficheros de la tarea> && pnpm typecheck`.
- **Tras cada ola:** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts tests/telegram-keyboard.test.ts tests/api-telegram-intents.test.ts tests/sensitive-actions.test.ts tests/api-lifecycle.test.ts tests/api-host-commands.test.ts tests/migrations.test.ts tests/runtime-config.test.ts && pnpm typecheck && pnpm lint src tests`.
- **Antes de `/gsd-verify-work`:** suite completa en verde, con `pnpm build` y los e2e.
- **Latencia máxima de respuesta:** 120 s por comando focalizado.

---

## Matriz de verificación por tarea

Se completa al cerrar la planificación, con una fila por tarea de los PLAN.md de la fase.

| Task ID | Plan | Ola | Requisito | Amenaza | Comportamiento seguro | Tipo | Comando automático | Fichero existe | Estado |
|---------|------|-----|-----------|---------|-----------------------|------|--------------------|----------------|--------|

*Estado: ⬜ pendiente · ✅ verde · ❌ rojo · ⚠️ inestable*

### Requisitos → pruebas (de la investigación)

| Req | Comportamiento | Tipo | Comando | ¿Existe? |
|-----|----------------|------|---------|----------|
| BOT-07 | Pulsar una acción crea un intent `pending` con el hash (no el token) y TTL de 5 min, y edita el aviso con un botón url. El agente no recibe nada | integración (BD + `telegram-fake`) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-updates.test.ts -t intent` | ❌ Ola 0 (ampliar fichero) |
| BOT-07 | `execute` con sesión, y passkey sembrada cuando toca, ejecuta una vez y devuelve la operación | integración (API + agente falso) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts` | ❌ Ola 0 |
| BOT-07 | El fragmento se captura, se quita de la URL y el diálogo se abre. Sin sesión pasa por el login y vuelve | e2e | `pnpm test:e2e tests/e2e/telegram-handoff.spec.ts` | ❌ Ola 0 |
| BOT-08 | `execute` de una acción protegida sin verificación reciente devuelve 403 `recent_verification_required`, con 0 peticiones al agente, 0 filas en `operations` y el intent aún `pending` | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts -t verification` | ❌ Ola 0 |
| BOT-08 | `start` (exenta) se ejecuta solo con sesión. Lo protegido sale del manifiesto, no del cuerpo | integración + unitario | `pnpm test tests/sensitive-actions.test.ts` | ✅ (ampliar) |
| BOT-08 | El carril de updates no importa ejecutores (`operation-runner`, `host-commands`, `lifecycle`, `nas`) | escaneo estático | `pnpm test tests/sensitive-actions.test.ts -t "lane"` | ❌ Ola 0 |
| BOT-09 | La operación queda con `channel='telegram'`, `requestedBy` e `id = intent.id`. Las de `/api/action` quedan con `channel='hub'` | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts tests/api-lifecycle.test.ts` | ✅ parcial (lifecycle) / ❌ |
| BOT-09 | La migración 0008 no reescribe filas existentes y repetirla no aplica nada | migración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` | ✅ (ampliar, patrón de 0007) |
| SC4 | Dos `execute` concurrentes, y un `execute` tras caducar, tras cancelar y tras consumir: una sola petición al agente | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts -t "single use"` | ❌ Ola 0 |
| D-10 | Una segunda acción sobre el mismo aviso con un intent vivo queda `unchanged`. Tras caducar se permite | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts -t "one live intent"` | ❌ Ola 0 |
| D-09 | La fila `:expire` restaura el teclado (edición sin botón url) tras `expiresAt` | integración con reloj inyectado | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts -t expiry` | ❌ Ola 0 |
| D-05 / D-06 | Aviso resuelto: sin «Acciones…». Un intent vivo previo sigue valiendo e `inspect` lo marca `resolved` | puro + integración | `pnpm test tests/telegram-keyboard.test.ts` | ❌ Ola 0 |
| D-00a | `TELEGRAM_DIRECT_ACTIONS` solo admite `0` o ausente; con `1` el arranque falla | unitario | `pnpm test tests/runtime-config.test.ts` | ✅ (ampliar) |
| Rutas | `telegram/intents/*` declaradas en el manifiesto, con su fila de 413 | escaneo | `pnpm test tests/sensitive-actions.test.ts` | ✅ (ampliar) |
| `callback_data` | Todo token de los botones nuevos tiene formato `v1:` y ocupa ≤ 64 bytes | unitario | `pnpm test tests/telegram-keyboard.test.ts` | ❌ Ola 0 |

Los tests aseveran estado, resultado o estructura, nunca copy (`CODING_STANDARD.md`): filas guardadas, códigos HTTP, peticiones registradas por el agente falso, `callback_data` y `url` de los botones enviados a `editMessageText`, y atributos `data-*` (`data-handoff-state`, `data-phase`, `data-verification-required`).

---

## Ola 0

- [ ] `tests/telegram-intents.test.ts`: ciclo de vida, unicidad, caducidad y reclamo atómico (BOT-07, BOT-08, SC4, D-09, D-10).
- [ ] `tests/api-telegram-intents.test.ts`: `inspect` y `execute`, 403 sin consumir el intent y `operations.channel` (BOT-07, BOT-08, BOT-09).
- [ ] `tests/telegram-keyboard.test.ts`: `hostActionsFor`, render por estado y tamaño de `callback_data` (D-01 a D-07).
- [ ] `tests/telegram-handoff-client.test.ts`: `parseHandoffFragment` y `captureHandoff` idempotente (puro).
- [ ] `tests/e2e/telegram-handoff.spec.ts`: fragmento, login y estados, con `page.route` para `execute` (precedente: `tests/e2e/sensitive-action.spec.ts`).
- [ ] Filas nuevas en `bodyLimitCases` y entradas del manifiesto en `tests/sensitive-actions.test.ts`.
- [ ] Ampliar `tests/telegram-fake.ts` si hace falta registrar `editMessageText` con botones url (ya registra `callback_data`).
- Framework ya instalado; sin dependencias nuevas.

---

## Verificaciones solo manuales

| Comportamiento | Requisito | Por qué es manual | Pasos |
|----------------|-----------|-------------------|-------|
| El botón url de un aviso real abre el hub en el móvil y la acción protegida se completa con passkey | BOT-07, BOT-08 | Depende del dispositivo y de Telegram real. La passkey puede fallar en el navegador interno de Telegram (suposición A1 de la investigación) | Provocar un `backup-failed` o `deploy-failed`, pulsar «Acciones…» y la acción, abrir el enlace, completar la passkey y comprobar la fila en `operations` y la edición del aviso. Si la passkey falla dentro de Telegram, reabrir el botón en el navegador del sistema antes de que pasen 5 min |
| El aviso caducado vuelve a «Acciones…» sin dejar un enlace muerto a la vista | BOT-07 (D-09) | Necesita esperar el TTL real con el worker en marcha | Pulsar una acción, no abrir el enlace, esperar 5 min y comprobar que el teclado se restaura en silencio |

---

## Aprobación de la validación

- [ ] Todas las tareas tienen verificación `<automated>` o dependen de la Ola 0
- [ ] Continuidad del muestreo: nunca tres tareas seguidas sin verificación automática
- [ ] La Ola 0 cubre todas las referencias marcadas como inexistentes
- [ ] Sin opciones de modo vigilancia (`--watch`)
- [ ] Latencia de respuesta < 120 s
- [ ] `nyquist_compliant: true` en el frontmatter

**Aprobación:** pendiente
