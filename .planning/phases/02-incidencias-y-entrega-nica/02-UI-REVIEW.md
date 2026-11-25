# Phase 02 — UI Review

**Audited:** 2026-11-25
**Baseline:** `DESIGN.md` (contrato de diseño del repo) + 6-pillar standards. La fase no tiene `UI-SPEC.md`.
**Screenshots:** captured — 16 capturas del flujo (login y vistas autenticadas) en `.planning/ui-reviews/02-20261125T110629/` (Chromium, 1440×900 / 768×1024 / 375×812, BD dedicada `hub_e2e_uireview`).
**Interaction captures:** off (`workflow.ui_interaction_capture=false`). Las interacciones de la fase (deep link, foco, prueba push) se comprobaron con un script Playwright propio, no con la captura de interacción del skill.

---

## Findings classification

- **Blocking:** ninguno. Ningún defecto impide completar el flujo: el enlace abre la incidencia correcta, el estado de entrega es legible y la prueba push distingue cola de entrega.
- **Advisory (alta prioridad):** F6 (bloque de entrega sin estilos), F7 (severidad invisible en Avisos), F8 (resaltado del episodio enlazado no fiable), F1 (severidad en inglés en Telegram), F2 (estado `Sin envío` sin motivo), F10 (estados sin color semántico) y F12 (jerarquía tipográfica invertida).
- **Advisory (menor):** F3, F4, F5, F9, F11 y F13–F16.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 3/4 | Copy específico y en español; el mensaje de Telegram filtra `critical`/`warning` y el estado heredado dice «Sin envío» sin motivo. |
| 2. Visuals | 2/4 | El bloque de entrega no tiene estilos propios y domina sobre el título; la severidad no se representa. |
| 3. Color | 2/4 | Estados de entrega y severidad monocromos; no se usa el sistema de punto/tono que ya existe en Resumen. |
| 4. Typography | 2/4 | La entrega hereda 15,04 px/400 frente al título 13,6 px/700; las etiquetas no usan 10,5 px/800 mayúsculas. |
| 5. Spacing | 3/4 | 1 rem entre cada línea de estado convierte el bloque en párrafos sueltos y alarga cada fila a ~210 px. |
| 6. Experience Design | 3/4 | Flujos y estados cubiertos; el resaltado del episodio enlazado depende de `:focus-visible` y el login no anuncia el destino. |

**Overall: 15/24**

---

## Top 3 Priority Fixes

1. **Dar estilos al bloque de entrega** — hoy `.alert-delivery`/`.alert-deliveries` no tienen ninguna regla CSS, así que el estado se lee como prosa de 15 px y tapa el título — añadir etiqueta 10,5 px/800 mayúsculas en `--muted`, valor con punto de estado de 7 px y color semántico, y un gap compacto de 4–6 px (`src/components/views/alerts.tsx:41`, `:128`; `src/app/globals.css` sin reglas para esas clases).
2. **Mostrar la severidad en la fila de Avisos** — hoy `critical` y `warning` comparten el mismo triángulo y color — reutilizar `StatusDot` con `loss`/`peach` y una etiqueta «Crítica»/«Advertencia», como ya hace Resumen (`src/components/views/summary.tsx:334-352`; `src/components/views/alerts.tsx:114-118`).
3. **Hacer persistente el resaltado del episodio enlazado** — el único indicador es el anillo de `:focus-visible`, que apareció en unas capturas y no en otras — añadir una regla para `[data-incident-selected]` (fondo `--panel2` o borde izquierdo `--accent` + texto «Incidencia enlazada») y no depender del foco (`src/components/views/alerts.tsx:102-112`; `src/app/globals.css:119-122`).

**Además, prioritario:** traducir la severidad del mensaje de Telegram (`nas-home · critical` → `nas-home · crítica`) y explicar el estado `Sin envío` de los episodios heredados sin outbox.

---

## Detailed Findings

### Pillar 1: Copywriting (3/4)

**F1 · WARNING · La severidad del mensaje de Telegram está en inglés.**
`openingText` y `editText` añaden `${incident.hostId} · ${incident.severity}`, y los valores persistidos son `critical`/`warning` (`src/lib/notification-dispatch.ts:284-287` y `:725-731`; `src/lib/collector.ts:40`). El operador recibe «nas-home · critical» en un producto cuyo resto del copy es español. *Fix:* mapear a `crítica`/`advertencia` en la capa de copy y añadir un caso a `tests/telegram.test.ts`.

**F2 · WARNING · Un episodio heredado sin outbox muestra «Entrega inicial: Sin envío» sin explicación.**
`emptyDelivery` deja `state: "none"` y `reason: null` (`src/lib/incident-store.ts:485-489`), y 02-01-SUMMARY confirma que los episodios heredados no crean fila de outbox. La captura `alerts-legacy-no-outbox-desktop.png` muestra una incidencia crítica abierta con esa única línea. *Fix:* publicar un motivo `legacy_open` también para el caso sin outbox o renderizar «Sin aviso programado (anterior a la migración)».

**F3 · ADVISORY · El estado de ausencia atribuye cualquier 404 al host.**
El título «No encontramos esa incidencia en este host» y el texto «El enlace sigue apuntando al host original» (`src/components/views/alerts.tsx:82-94`) asumen un desajuste de host, pero `GET /api/incidents/:id` también devuelve 404 para un id inexistente, caducado o purgado. *Fix:* titular «No encontramos esa incidencia» y usar la segunda línea solo para explicar que el host del enlace se conserva.

**F4 · ADVISORY · La notificación de prueba no se identifica como prueba.**
El payload de `push-test` envía `title: "hub."` y `body: "Notificaciones del hub"` (`src/lib/notification-dispatch.ts:846-849`), mientras Ajustes promete una prueba. *Fix:* `body: "Prueba de notificaciones del hub."` para que el operador sepa qué acaba de recibir.

**F5 · ADVISORY · Formato de fecha inconsistente y con segundos.**
Avisos usa `toLocaleString("es")` (`src/components/views/alerts.tsx:121-127`) y produce «9/5/2026, 13:06:29»; Resumen ya usa hora compacta o «25 nov» (`src/components/views/summary.tsx:326-332`). El año y los segundos añaden ruido y el formato numérico es ambiguo para días ≤ 12. *Fix:* reutilizar el helper de Resumen y mantener el detalle exacto en un `title`/`dateTime`.

### Pillar 2: Visuals (2/4)

**F6 · WARNING · El bloque de entrega no tiene estilos: es texto plano que adelanta al título.**
`DeliveryStatus` emite `className="alert-delivery"` y el contenedor `className="stack alert-deliveries"` (`src/components/views/alerts.tsx:41` y `:128`), pero no existe ninguna regla `.alert-delivery`/`.alert-deliveries` en `src/app/globals.css`. El único estilo aplicado es `.stack { gap: 1rem }`. En la captura `incident-row-desktop.png` las tres líneas se leen como párrafos, sin etiqueta ni valor diferenciados. *Fix:* reglas propias con etiqueta, valor, punto y color semántico.

**F7 · WARNING · La severidad no se representa en Avisos.**
La fila solo distingue resuelta/abierta con `CircleCheck` o `TriangleAlert` (`src/components/views/alerts.tsx:114-118`); el campo `severity` existe en el tipo (`src/lib/types.ts:190`) pero no se pinta. Una incidencia crítica y una advertencia se ven idénticas, aunque Resumen sí las separa con `loss`/`peach` (`src/components/views/summary.tsx:334-352`). Esto incumple D-04 en la vista a la que llega el enlace del aviso. *Fix:* punto + etiqueta de severidad en la primera línea de la fila.

**F8 · WARNING · El resaltado del episodio enlazado no es fiable.**
El componente enfoca la fila con `tabIndex={-1}` (`src/components/views/alerts.tsx:102-112`) y el único indicador visual es `:focus-visible { outline: 2px solid var(--accent) }` (`src/app/globals.css:119-122`). `[data-incident-selected]` no tiene regla CSS. En `alerts-legacy-desktop.png` y `alerts-detail-fullpage.png` el anillo aparece; en `alerts-detail-desktop.png` y `alerts-legacy-no-outbox-desktop.png`, con el mismo flujo, no. *Fix:* estilo persistente por atributo, independiente del foco y de la modalidad de entrada.

**F9 · ADVISORY · El aviso de ausencia se inserta dentro del panel, encima de la lista.**
`trueAbsence` se renderiza antes de `rows.map` en el mismo panel (`src/components/views/alerts.tsx:82-101`). En `alerts-missing-desktop.png` el bloque «No encontramos esa incidencia» parece la cabecera de las incidencias que vienen debajo. *Fix:* separarlo con un borde/`padding` propio o mostrarlo como panel independiente antes de la lista.

### Pillar 3: Color (2/4)

**F10 · WARNING · Los estados de entrega son monocromos.**
Los valores `Enviado`, `No entregado`, `Suprimido`, `Entrega incierta` y `En cola` heredan `--text`; no hay punto, tono ni color por estado (`src/components/views/alerts.tsx:40-48`; `metrics-alerts-detail.json` registra `color: lab(89.6% …)` y `font-weight: 400` para `.alert-delivery`). El contrato pide que todo estado lleve punto de color y texto (`DESIGN.md` § Semántica del color). Los contrastes medidos son correctos (`--loss` 6,86:1, `--peach` 8,66:1, `--accent` 5,29:1 sobre `--panel`), así que el problema es de asignación, no de legibilidad. *Fix:* `sent→gain`, `failed→loss`, `uncertain→peach`, `suppressed→muted`, `pending→accent`, con punto de 7 px.

**F11 · ADVISORY · Avisos no reutiliza el tono de severidad que ya existe.**
Resumen pinta un `StatusDot` con `tone="loss"` para crítica y `tone="peach"` para advertencia (`src/components/views/summary.tsx:334-352`). Avisos usa `danger-text` para cualquier abierta. El mismo episodio cambia de color al abrir el enlace. *Fix:* usar el mismo `StatusDot` y tono en ambas vistas.

### Pillar 4: Typography (2/4)

**F12 · WARNING · Inversión de jerarquía y etiquetas sin el estilo de etiqueta.**
Medido en `metrics-alerts-detail.json`: `.alert-delivery` 15,04 px/400; `.alert-row strong` 13,6 px/700; `.alert-row p` 12,8 px; `.alert-row time` 10,4 px. El estado de entrega es el texto más grande de la fila. Además, «Entrega inicial:» va en el mismo peso y tamaño que el valor, cuando `DESIGN.md` fija etiquetas de 10,5 px, peso 800, mayúsculas y `letter-spacing: .07em`. *Fix:* etiqueta en ese estilo y valor a 12–13 px/600.

**F13 · ADVISORY (deuda previa) · La escala global no coincide con `DESIGN.md`.**
`h1` 41,6 px (contrato 32 px), `h2` 16,8 px (contrato 14 px), cuerpo 15,04 px (contrato 13,5 px) y radio de panel 22,4 px (contrato 18 px). No lo introduce la fase 2, pero conviene registrarlo para que la deuda no se consolide.

### Pillar 5: Spacing (3/4)

**F14 · ADVISORY · 1 rem entre líneas de estado.**
`.alert-deliveries` solo hereda `.stack { gap: 1rem }` (`src/app/globals.css:201-205`). Con tres estados la fila mide ~210 px (`incident-row-desktop.png`) y cada línea parece un párrafo independiente. *Fix:* gap de 4–6 px y separar el grupo con un `border-block-start` de `--row-line` o una superficie `--panel2` suave.

La escala general sí es consistente: no hay valores arbitrarios (`[]`) ni clases Tailwind sueltas; los huecos usan los tokens `clamp()` del proyecto. No hay desbordamiento horizontal en 375, 768 ni 1440 px (`horizontalOverflow` ≤ 0 en las métricas).

### Pillar 6: Experience Design (3/4)

**Cubierto y verificado visualmente:** estados de carga/error/ausencia; foco del episodio enlazado; conservación de `view`/`host`/`incident` tras correo, passkey y expiración (cubierta por INC-E2E-01/02/03 de la fase); aviso de ausencia sin cambiar el host; botones deshabilitados durante la acción; y la distinción «Prueba en cola…» de Ajustes, que se ve correctamente en `settings-push-queued-desktop.png` y `settings-push-mobile-after.png`. Todos los botones medidos superan 44 px.

**F15 · ADVISORY · El login no anuncia que se volverá al aviso.**
`page.tsx` reconstruye el destino y `Login` lo aplica en correo y passkey (`src/app/page.tsx:19-29`; `src/components/login.tsx:41-48`), pero la pantalla de acceso es genérica: quien llega desde Telegram no sabe que el enlace se conservará. *Fix:* una línea de contexto («Después de entrar volverás al aviso que has abierto») cuando `next` incluye `incident`.

**F16 · ADVISORY · La severidad no se percibe en la vista de destino.**
Aunque el dato está en el hub, la vista que abre el enlace no permite saber si el aviso es crítico o una advertencia (ver F7/F11). El estado de entrega sí es perceptible, pero el triaje no.

---

## Evidence

**Entorno de captura:** PostgreSQL 18.7 (`hub-test-db`, 127.0.0.1:55432), base dedicada `hub_e2e_uireview` (eliminada al terminar), Next 16.4.6 en `http://localhost:3000` con `HUB_E2E_HARNESS=1`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `SETUP_TOKEN`, `NAS_AGENT_URL` y `AGENT_TOKEN` de CI. Servidor parado al terminar; sin `.env` escritos.

**Datos sembrados:** 7 incidencias recientes (6 abiertas y 1 resuelta) con estados `sent`, `suppressed`+`digest_pending`, `suppressed`+`policy_silent`, `failed`+`permanent_rejection` con `fallback sent` y `pending`; 100 incidencias de relleno; 1 episodio de 200 días con `lastUpdate uncertain` (objetivo del enlace) y 1 episodio heredado sin outbox. Ver `seed.json`.

**Capturas principales:**

| Archivo | Qué muestra |
|---|---|
| `login-deeplink-desktop.png` | Login tras abrir un enlace de incidencia, sin contexto del destino. |
| `alerts-detail-desktop.png` | Avisos con el episodio enlazado fijado arriba y sus tres estados de entrega. |
| `incident-row-desktop.png` | Detalle de la fila: estado de entrega como texto plano. |
| `alerts-list-desktop.png` | Lista sin episodio seleccionado. |
| `alerts-missing-desktop.png` | Ausencia de episodio sobre la lista. |
| `alerts-legacy-desktop.png` | Motivo `legacy_open` y anillo de foco visible. |
| `alerts-legacy-no-outbox-desktop.png` | Heredado sin outbox: «Entrega inicial: Sin envío». |
| `settings-push-queued-desktop.png` | Prueba push en cola, distinción cola/entrega. |
| `settings-push-mobile-after.png` | El aviso de cola sigue visible en móvil tras pulsar. |
| `alerts-detail-mobile.png` / `alerts-list-mobile.png` | 375 px: el bloque de entrega domina la fila. |
| `alerts-detail-tablet.png` / `alerts-list-tablet.png` | 768 px: sin desbordamiento. |
| `alerts-detail-fullpage.png` | Página completa con el anillo de foco. |

**Métricas:** `metrics-alerts-detail.json`, `metrics-alerts-detail-mobile.json`, `metrics-alerts-detail-tablet.json`, `metrics-alerts-list.json`, `focus.json`, `console-errors.json`. Único error de consola: un 404 de recurso, coherente con la consulta esperada de `incident=999999`.

**Contraste (sobre `--panel`):** texto 12,2:1; `--soft` 8,7:1; `--muted` 5,3:1; `--accent` 5,29:1; `--gain` 8,88:1; `--loss` 6,86:1; `--peach` 8,66:1; `--lilac` 6,89:1. Todos los textos superan 4,5:1.

**Comandos ejecutados:**

| Comando | Resultado |
|---|---|
| `docker exec hub-test-db psql -U hub -d postgres -c 'CREATE DATABASE hub_e2e_uireview'` | Creada |
| `DATABASE_URL=…hub_e2e_uireview pnpm db:migrate` | Migraciones aplicadas |
| `pnpm build` con el entorno de CI | exit 0 (Next 16.4.6) |
| `pnpm start` con el entorno de CI | `Ready in 82ms` |
| `node /tmp/uireview-capture.mjs` | 16 capturas, métricas y `focus.json` |
| `node /tmp/uireview-mobile-settings.mjs` | Antes/después de la prueba push en móvil |
| `node /tmp/uireview-contrast.mjs` | Ratios de contraste de los tokens |
| `node /tmp/uireview-legacy.mjs` | Episodio heredado sin outbox |

**No verificado en esta auditoría:** el reemplazo silencioso en la bandeja real de iOS, la recepción en un chat de Telegram real y el despliegue/reversa sobre producción. Siguen siendo los casos manuales de `02-VALIDATION.md`. El banner «NAS-HOME no responde» de las capturas es el estado esperado sin agente en este entorno, no un defecto de la fase.

**Registry audit:** omitido; no existe `components.json` ni se declaran registries de terceros.

**Alcance del encargo:** auditoría de solo lectura. No se modificaron código de producción, tests, `ROADMAP.md` ni `STATE.md`, y no se creó ningún commit. Este archivo queda en el árbol de trabajo para que lo confirme el orquestador.

---

## Files Audited

- `src/components/views/alerts.tsx`
- `src/components/views/routes.ts`
- `src/components/dashboard.tsx`
- `src/components/login.tsx`
- `src/components/settings.tsx`
- `src/app/page.tsx`
- `src/app/globals.css`
- `src/lib/types.ts`
- `src/lib/incident-push.ts`
- `src/lib/incident-store.ts` (proyección pública)
- `src/lib/notification-dispatch.ts` (copy de Telegram y push)
- `public/sw.js`
- `.planning/phases/02-incidencias-y-entrega-nica/02-CONTEXT.md`
- `.planning/phases/02-incidencias-y-entrega-nica/02-05-PLAN.md`
- `.planning/phases/02-incidencias-y-entrega-nica/02-*-SUMMARY.md`
- `DESIGN.md`

## Remediation (post-review)

Aplicado después de la auditoría en `56230f8`:

- **F6 — fixed.** `.alert-delivery` / `.alert-deliveries` tienen reglas propias: etiqueta `10.5px`/800 en mayúsculas, `StatusDot` de 7 px con tono semántico por estado (`sent` gain, `failed` loss, `uncertain` peach, `pending` accent, `suppressed`/`none` muted), valor `12.8px`/600 y un gap compacto de 5 px con separador `--row-line`.
- **F7 — fixed.** Cada fila de Avisos expone `data-severity` y muestra un `StatusDot` con «Crítica» (`loss`) o «Advertencia» (`peach`), reutilizando el sistema de tonos de Resumen.
- **F8 — fixed.** `[data-incident-selected="true"]` recibe una superficie persistente `--panel2` y la etiqueta «Incidencia enlazada»; el resaltado ya no depende de `:focus-visible`.
- El resto (F1–F5, F9–F16) sigue siendo advisory.

`tests/e2e/incidents.spec.ts` comprueba los atributos de estado `data-incident-selected` y `data-severity` del episodio enlazado.
