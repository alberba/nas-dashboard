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
- **Tras cada ola:** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts tests/telegram-keyboard.test.ts tests/api-telegram-intents.test.ts tests/verification.test.ts tests/sensitive-actions.test.ts tests/api-lifecycle.test.ts tests/api-host-commands.test.ts tests/migrations.test.ts tests/runtime-config.test.ts && pnpm typecheck && pnpm lint src tests`.
- **Antes de `/gsd-verify-work`:** suite completa en verde, con `pnpm build` y los e2e.
- **Latencia máxima de respuesta:** 120 s por comando focalizado.

---

## Matriz de verificación por tarea

Completada al cerrar la planificación: una fila por tarea de los seis PLAN.md de la fase (07-01 a 07-06). Las tareas `tracer` abren cada plan; los ficheros de prueba nuevos los crea la tarea que se indica, no una ola previa.

| Task ID | Plan | Ola | Requisito | Amenaza | Comportamiento seguro | Tipo | Comando automático | Fichero existe | Estado |
|---------|------|-----|-----------|---------|-----------------------|------|--------------------|----------------|--------|
| 07-01-T1 | 07-01 | 1 | BOT-07, BOT-08, BOT-09 | T-07-01, T-07-02 | Pulsar `act_backup_now` crea un intent `pending` con solo el hash del token y no ejecuta nada (cero peticiones al agente, cero operaciones) | tracer (integración BD + `telegram-fake`) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts && pnpm typecheck` | ❌ lo crea la tarea | ⬜ pendiente |
| 07-01-T2 | 07-01 | 1 | BOT-07 | T-07-02 | El aviso se edita en silencio con un botón url cuyo token en el fragmento coincide con el hash guardado y no se envía un mensaje nuevo | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts tests/telegram.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ pendiente |
| 07-01-T3 | 07-01 | 1 | BOT-07, BOT-09 | T-07-03, T-07-04 | Un intent vivo por aviso, reclamo atómico de un solo uso y migración 0008 aditiva y repetible | integración + migración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/migrations.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ pendiente |
| 07-06-T1 | 07-06 | 1 | BOT-07, BOT-08 | T-07-21, T-07-22 | Un `Origin` alternativo falsificado contra el host principal no obtiene el método `password` ni deja pasar una acción protegida (D-13, CR-01) | tracer (unitario, sin BD) | `pnpm test tests/verification.test.ts && pnpm typecheck` | ✅ (ampliar) | ⬜ pendiente |
| 07-06-T2 | 07-06 | 1 | BOT-07, BOT-08 | T-07-21, T-07-22, T-07-24 | La entrada alternativa genuina conserva la contraseña; `Origin` distinto del `Host`, host ambiguo, host reenviado y falta de dominio principal caen a passkey; el mismo ataque falla por la ruta real del catch-all | unitario + integración API | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/verification.test.ts tests/sensitive-actions.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ pendiente |
| 07-06-T3 | 07-06 | 1 | BOT-08 | T-07-21, T-07-23, T-07-24 | El README documenta el contrato del proxy y CR-01 queda `fixed` en la disposición de la fase 6 | documentación (grep con línea base) | `test "$(grep -c '^### Factor de verificación por entrada' README.md)" = 1 && test "$(grep -c '^open: 8$' .planning/phases/06-puerta-de-seguridad/06-REVIEW-DISPOSITION.md)" = 1` | ✅ (ampliar) | ⬜ pendiente |
| 07-02-T1 | 07-02 | 2 | BOT-07, BOT-08, BOT-09 | T-07-05, T-07-09 | `execute` ejecuta `backup-now` una vez con verificación reciente y registra canal y solicitante; sin ella 403 sin consumir el intent | tracer (integración API + agente falso) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts tests/sensitive-actions.test.ts && pnpm typecheck` | ❌ lo crea la tarea | ⬜ pendiente |
| 07-02-T2 | 07-02 | 2 | BOT-07, BOT-08 | T-07-07, T-07-08 | `inspect` y estados (410, replay, 503 sin consumir, 404 uniforme) y una sola petición al agente en concurrencia | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts tests/sensitive-actions.test.ts && pnpm typecheck && pnpm lint` | ✅ (tarea 1) | ⬜ pendiente |
| 07-02-T3 | 07-02 | 2 | BOT-08 | T-07-01, T-07-05, T-07-06 | Lo protegido sale del manifiesto y de la acción almacenada, no del cuerpo; el carril no importa ejecutores; un `Origin` alternativo falsificado contra el host principal no ejecuta `execute` con una verificación `password` (D-13) | escaneo estático + integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts tests/sensitive-actions.test.ts tests/api-host-commands.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ pendiente |
| 07-03-T1 | 07-03 | 2 | BOT-07 | T-07-11 | «Acciones…» y «Volver» editan el aviso en silencio y solo aparecen con acciones ofrecidas | tracer (integración BD + `telegram-fake`) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts tests/incident-actions.test.ts tests/incident-why.test.ts tests/incident-snooze.test.ts && pnpm typecheck` | ✅ (ampliar) | ⬜ pendiente |
| 07-03-T2 | 07-03 | 2 | BOT-07 | T-07-10, T-07-11 | «Cancelar» y la fila `:expire` restauran el teclado sin enlaces muertos y con un solo intent vivo | integración con reloj inyectado | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts tests/telegram-updates.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ pendiente |
| 07-03-T3 | 07-03 | 2 | BOT-07 | T-07-10, T-07-12 | Reglas de resolución D-05 y D-06, línea de resultado, `callback_data` de 25 bytes y limpieza de intents viejos | puro + integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-keyboard.test.ts tests/telegram-intents.test.ts tests/telegram-lane-hardening.test.ts tests/incident-why.test.ts tests/incident-snooze.test.ts tests/telegram-updates.test.ts && pnpm typecheck && pnpm lint` | ❌ `telegram-keyboard.test.ts` lo crea la tarea | ⬜ pendiente |
| 07-04-T1 | 07-04 | 3 | BOT-07, BOT-08, BOT-09 | T-07-14, T-07-09 | El runner extraído no cambia `/api/action`; `restart` desde un intent ejecuta una vez; canal `hub` y `telegram` con solicitante | tracer (integración API + agente falso) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-lifecycle.test.ts tests/api-telegram-intents.test.ts tests/api-host-commands.test.ts tests/sensitive-actions.test.ts && pnpm typecheck` | ✅ (ampliar) | ⬜ pendiente |
| 07-04-T2 | 07-04 | 3 | BOT-07, BOT-08 | T-07-13, T-07-16 | `start` solo con sesión, `reboot` con passkey y sin frase tecleada, contenedor recreado por nombre y prechequeos que no consumen el intent | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts tests/api-lifecycle.test.ts && pnpm typecheck && pnpm lint` | ✅ (ampliar) | ⬜ pendiente |
| 07-04-T3 | 07-04 | 3 | BOT-08 | T-07-15 | `TELEGRAM_DIRECT_ACTIONS` solo admite `0` o ausente; con otro valor el arranque falla | unitario + documentación | `pnpm test tests/runtime-config.test.ts && pnpm typecheck && pnpm lint && grep -q 'TELEGRAM_DIRECT_ACTIONS=0' .env.example && grep -q 'TELEGRAM_DIRECT_ACTIONS' README.md` | ✅ (ampliar) | ⬜ pendiente |
| 07-05-T1 | 07-05 | 3 | BOT-07, BOT-08 | T-07-17, T-07-18 | El fragmento se captura y se borra de la URL, el diálogo abre con verbo y objetivo y una acción exenta se confirma sin passkey | tracer (e2e) | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/telegram-handoff.spec.ts tests/e2e/sensitive-action.spec.ts` | ❌ lo crea la tarea | ⬜ pendiente |
| 07-05-T2 | 07-05 | 3 | BOT-07, BOT-08 | T-07-17, T-07-18, T-07-20 | El token sobrevive al login y a la recarga; los estados terminales no llaman a `execute`; lo protegido marca `data-verification-required` | puro + e2e | `pnpm test tests/telegram-handoff-client.test.ts && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/telegram-handoff.spec.ts` | ❌ `telegram-handoff-client.test.ts` lo crea la tarea | ⬜ pendiente |
| 07-05-T3 | 07-05 | 3 | BOT-07, BOT-09 | T-07-20 | El canal de cada operación es visible, el reintento tras un fallo no reenvía sin confirmación y la ayuda de passkey cubre el navegador de Telegram | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/telegram-handoff.spec.ts tests/e2e/incidents.spec.ts tests/e2e/overview.spec.ts` | ✅ (tarea 1) | ⬜ pendiente |

*Estado: ⬜ pendiente · ✅ verde · ❌ rojo · ⚠️ inestable*

### Requisitos → pruebas (de la investigación)

| Req | Comportamiento | Tipo | Comando | ¿Existe? |
|-----|----------------|------|---------|----------|
| BOT-07 | Pulsar una acción crea un intent `pending` con el hash (no el token) y TTL de 5 min, y edita el aviso con un botón url. El agente no recibe nada | integración (BD + `telegram-fake`) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/telegram-intents.test.ts -t intent` | ❌ lo crea 07-01-T1 |
| BOT-07 | `execute` con sesión, y passkey sembrada cuando toca, ejecuta una vez y devuelve la operación | integración (API + agente falso) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts` | ❌ Ola 0 |
| BOT-07 | El fragmento se captura, se quita de la URL y el diálogo se abre. Sin sesión pasa por el login y vuelve | e2e | `pnpm test:e2e tests/e2e/telegram-handoff.spec.ts` | ❌ Ola 0 |
| BOT-08 | `execute` de una acción protegida sin verificación reciente devuelve 403 `recent_verification_required`, con 0 peticiones al agente, 0 filas en `operations` y el intent aún `pending` | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-telegram-intents.test.ts -t verification` | ❌ Ola 0 |
| BOT-08 | `start` (exenta) se ejecuta solo con sesión. Lo protegido sale del manifiesto, no del cuerpo | integración + unitario | `pnpm test tests/sensitive-actions.test.ts` | ✅ (ampliar) |
| BOT-08 | El carril de updates no importa ejecutores (`operation-runner`, `host-commands`, `lifecycle`, `nas`) | escaneo estático | `pnpm test tests/sensitive-actions.test.ts -t "lane"` | ❌ Ola 0 |
| BOT-08 / D-13 | Un `Origin` alternativo falsificado contra el host principal no obtiene el método `password` ni ejecuta una acción protegida (handler, ruta real y `execute` del handoff); la entrada alternativa genuina conserva la contraseña | unitario + integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/verification.test.ts tests/sensitive-actions.test.ts tests/api-telegram-intents.test.ts` | ✅ (ampliar 07-06) / ❌ (`execute`, 07-02-T3) |
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

Cada fichero de prueba nuevo lo crea la tarea `tracer` o la primera tarea de su plan; ninguna tarea depende de una ola previa de andamiaje.

- [ ] `tests/telegram-intents.test.ts`: ciclo de vida, unicidad, caducidad, reclamo atómico, menú, cancelación y `:expire` (BOT-07, BOT-08, SC4, D-09, D-10). Lo crea 07-01-T1 y lo amplían 07-01-T2, 07-01-T3, 07-03-T1, 07-03-T2 y 07-03-T3.
- [ ] `tests/api-telegram-intents.test.ts`: `inspect` y `execute`, 403 sin consumir el intent, `operations.channel` y la matriz por acción (BOT-07, BOT-08, BOT-09). Lo crea 07-02-T1 y lo amplían 07-02-T2, 07-02-T3, 07-04-T1 y 07-04-T2.
- [ ] `tests/telegram-keyboard.test.ts`: `keyboardActions` y `renderActionRows` por estado y tamaño de `callback_data` (D-01 a D-07). Lo crea 07-03-T3.
- [ ] `tests/telegram-handoff-client.test.ts`: `parseHandoffFragment` y `captureHandoff` idempotente (puro). Lo crea 07-05-T2.
- [ ] `tests/e2e/telegram-handoff.spec.ts`: fragmento, login y estados, con `page.route` para `execute` (precedente: `tests/e2e/sensitive-action.spec.ts`). Lo crea 07-05-T1 y lo amplían 07-05-T2 y 07-05-T3.
- [ ] Filas nuevas en `bodyLimitCases`, entradas del manifiesto y escaneo «lane» en `tests/sensitive-actions.test.ts` (07-02-T1 y 07-02-T3), bloque de 0008 en `tests/migrations.test.ts` (07-01-T3) y casos de `TELEGRAM_DIRECT_ACTIONS` en `tests/runtime-config.test.ts` (07-04-T3).
- [ ] Casos de CR-01 (D-13): el ataque y la matriz de `Host` y `Origin` en `tests/verification.test.ts` (07-06-T1 y 07-06-T2), el bloque «factor por entrada» por la ruta real en `tests/sensitive-actions.test.ts` (07-06-T2) y el caso de `execute` con `Origin` falsificado en `tests/api-telegram-intents.test.ts` (07-02-T3).
- `tests/telegram-fake.ts` no necesita ampliarse: ya registra el `reply_markup` completo de `editMessageText` (botones url incluidos) en `calls`.
- Framework ya instalado; sin dependencias nuevas.

Estructura de ejecución: ola 1 = 07-01 y 07-06 en paralelo (sin ficheros compartidos); ola 2 = 07-02 y 07-03 en paralelo (sin ficheros compartidos; 07-02 depende además de 07-06 porque ambos editan `tests/sensitive-actions.test.ts`); ola 3 = 07-04 y 07-05 en paralelo (sin ficheros compartidos).

---

## Verificaciones solo manuales

| Comportamiento | Requisito | Por qué es manual | Pasos |
|----------------|-----------|-------------------|-------|
| El botón url de un aviso real abre el hub en el móvil y la acción protegida se completa con passkey | BOT-07, BOT-08 | Depende del dispositivo y de Telegram real. La passkey puede fallar en el navegador interno de Telegram (suposición A1 de la investigación) | Provocar un `backup-failed` o `deploy-failed`, pulsar «Acciones…» y la acción, abrir el enlace, completar la passkey y comprobar la fila en `operations` y la edición del aviso. Si la passkey falla dentro de Telegram, reabrir el botón en el navegador del sistema antes de que pasen 5 min |
| El aviso caducado vuelve a «Acciones…» sin dejar un enlace muerto a la vista | BOT-07 (D-09) | Necesita esperar el TTL real con el worker en marcha | Pulsar una acción, no abrir el enlace, esperar 5 min y comprobar que el teclado se restaura en silencio |
| El dominio principal rechaza un `Origin` o un host reenviado falsificados y la entrada de Tailscale Serve sigue ofreciendo contraseña (D-13, CR-01) | BOT-08 | Depende de las cabeceras reales que reenvían Nginx Proxy Manager y Tailscale Serve, que ni el repo ni la documentación de Tailscale fijan | Con una sesión iniciada por contraseña, `POST` a `/api/verification/password` en el dominio principal con `Origin` del origen alternativo y, aparte, con una cabecera de host reenviado alternativa: ambos deben dar 403 `password_not_allowed` (comandos en el README, «Factor de verificación por entrada»). Después, por el origen alternativo, verificar con contraseña desde el diálogo y completar una acción protegida. Si la entrada alternativa deja de ofrecer contraseña, el proxy no reenvía el `Host` original |

---

## Aprobación de la validación

- [ ] Todas las tareas tienen verificación `<automated>` o dependen de la Ola 0
- [ ] Continuidad del muestreo: nunca tres tareas seguidas sin verificación automática
- [ ] La Ola 0 cubre todas las referencias marcadas como inexistentes
- [ ] Sin opciones de modo vigilancia (`--watch`)
- [ ] Latencia de respuesta < 120 s
- [ ] `nyquist_compliant: true` en el frontmatter

**Aprobación:** pendiente
