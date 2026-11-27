---
phase: 06-puerta-de-seguridad
researched: 2026-11-27
status: complete
confidence: high
---

# Fase 6: Puerta de seguridad - Investigación

**Researched:** 2026-11-27
**Domain:** Autorización por acción en el borde HTTP de un hub Next.js 16.4.6 (verificación reciente en servidor), CSP con nonce y HSTS, límites de cuerpo de petición y de respuesta del agente
**Confidence:** HIGH (código leído en esta sesión, documentación de Next 16.4.6 instalada en `node_modules/next/dist/docs/` y dos sondas ejecutadas; los juicios operativos sobre Nginx Proxy Manager y Tailscale Serve van marcados `[ASSUMED]`)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Frontera de lo protegido (SEC-01)**
- **D-01:** Contenedores: `stop`, `restart`, `update-container` y la eliminación (ya protegida) exigen verificación reciente. `start` queda exento: no pierde datos ni corta servicio.
- **D-02:** Archivos: solo lo irreversible se protege, `purge` y `empty-trash`. `trash`, `move` y `restore` quedan exentos (la papelera de 7 días es la red de seguridad).
- **D-03:** Comandos de host: se protegen los siete que cambian estado (`deploy-now`, `pause-follower`, `resume-follower`, `run-security`, `backup-now`, `clean-images`, `reconnect-apps`). `check-health` queda exento porque solo lee; la UI deja de pedir passkey para `check-health` para que UI y servidor coincidan.
- **D-04:** Se mantienen protegidas las que ya lo están: `reboot`, eliminación de contenedor, ajustes de releases retenidas (`deployments/settings`) y merge de Renovate.
- **D-05:** Reconocer, silenciar y quitar silencio desde el hub siguen exentos (decisión heredada de la fase 5, confirmada aquí).

**Declaración obligatoria (SEC-02)**
- **D-06:** Toda mutación (cada `action` de `/api/action`, cada `host-command` y cada ruta mutante del catch-all) aparece en el módulo único como `protegida` o `exenta` con un motivo. Una mutación sin entrada hace fallar el test. Exentas explícitas esperadas: `start`, `trash`, `move`, `restore`, `check-health`, umbrales (`settings`), suscripción y prueba de push, acciones de incidencia, `setup`.
- **D-07:** La UI pide passkey exactamente para lo que el módulo marca como protegida; el servidor es la autoridad y la UI solo explica.

**Límite de cuerpo (SEC-04)**
- **D-08:** Un helper compartido lee el cuerpo de toda mutación con un tope global pequeño (~16 KB) y responde 413 antes de parsear. Un `Content-Length` declarado por encima del tope se rechaza sin leer el cuerpo. Una ruta que necesite más (p. ej. ajustes de `.env` en `deployments/settings`) declara su propio tope explícito.
- **D-09:** El 413 solo responde con un mensaje en español; no crea operación, incidencia ni línea de log.

**Tope de respuesta (plan 06-03)**
- **D-10:** El tope cubre lo que el hub lee del agente (logs, listados de directorio, journal de despliegues, etc.): el hub deja de leer al superar el tope en lugar de cargar la respuesta entera. El agente Python no se toca en esta fase.
- **D-11:** Al superar el tope, la vista muestra un error claro de respuesta demasiado grande y conserva el último dato válido; nunca se muestran datos parciales ni JSON truncado.

### Claude's Discretion

- CSP: forma concreta (nonce frente a `'self'` con lo mínimo que Next 16 requiera), si se arranca en Report-Only, y qué orígenes permite (`connect-src 'self'`, workers de push/PWA). Debe ser conservadora y no romper la PWA, las passkeys ni el service worker.
- HSTS: si lo emite la app, el proxy o ambos; `max-age` e `includeSubDomains` con criterio conservador, teniendo en cuenta el dominio principal (Nginx Proxy Manager) y el alternativo de Tailscale Serve. Documentar la decisión en el README.
- Fricción de la verificación: se mantiene la ventana de 5 min por sesión (`RECENT_VERIFICATION_TTL_MS`) salvo que el planner encuentre un motivo; la UX al recibir 403 `recent_verification_required` reutiliza el diálogo de acción sensible existente.
- Orden dentro de cada ruta: el replay idempotente puede seguir antes del guard como en `lifecycle.ts`, siempre que ninguna ejecución nueva ocurra sin verificación.
- Valor exacto de los topes de respuesta por tipo de lectura.

### Deferred Ideas (OUT OF SCOPE)

- Bajar en `agent/` el tope de logs de 64 MiB y paginar el listado de directorios (CONCERNS, severidad media) — fase o tarea posterior.
- Pedir el nombre del elemento para confirmar `purge` (CONCERNS) — mejora de diseño, no incluida.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-01 | Toda ruta destructiva exige verificación reciente en el servidor (stop, restart, update, purge, empty-trash, clean-images, reconnect-apps, host-command, merge de Renovate) | Inventario completo de mutaciones (sección Architecture Patterns), módulo puro `sensitive-actions.ts`, puntos de guard por ruta, migración de la UI y de los tests API existentes |
| SEC-02 | La lista de acciones protegidas vive en un único módulo y una ruta nueva no puede olvidarla sin que falle un test | Manifiesto de rutas con `satisfies Record<…>` exhaustivo, escaneo de literales de `route.ts`, comprobación de ficheros `route.ts`, matriz de comportamiento por entrada |
| SEC-04 | Las respuestas incluyen CSP conservadora y HSTS, y las mutaciones tienen límite de cuerpo | CSP con nonce vía `src/proxy.ts` (documentación de Next 16.4.6), HSTS en `next.config.ts`, lector de cuerpo con tope y 413, tope de respuesta del agente en `nas.ts` |
</phase_requirements>

## Summary

La fase es de endurecimiento sin dependencias nuevas. El hub ya tiene la pieza difícil: `guardSensitiveAction` solo confía en el registro del servidor y el diálogo `useSensitiveAction` ya sabe reaccionar a un 403 `recent_verification_required` con la misma clave de idempotencia. Lo que falta es (a) que la decisión "protegida o exenta" salga de un único módulo puro que importen servidor y UI, (b) aplicarla en `/api/action` (hoy solo `reboot`) y en `runHostCommand` (hoy ninguno), (c) un test que haga fallar una mutación sin declarar, (d) un lector de cuerpo con tope, (e) un tope de lectura de respuesta del agente en el único punto por el que pasa todo (`nasEffectForHost`), y (f) cabeceras CSP y HSTS.

Tres hallazgos cambian el plan respecto a lo que CONTEXT.md da por supuesto. **Primero**, la UI hoy no pasa por el diálogo de passkey para `stop`, `restart`, `purge`, `empty-trash` (usan el diálogo simple de `dashboard.tsx`, que hace `fetch("/api/action")` directo) ni para cuatro de los comandos de la tarjeta "Acciones del host" (`maintenance-extras.tsx` hace `fetch("/api/host-command")` directo). En cuanto el servidor los proteja, esos botones devolverán 403 y se romperán: la migración de la UI no es opcional y arrastra specs e2e. **Segundo**, `mutation` en el catch-all es `request.method !== "GET"` y se exportan `GET`, `POST` y `DELETE`, así que `DELETE /api/action` y `DELETE /api/settings` llegan hoy al mismo código que POST; el manifiesto debe declarar métodos por ruta y el despachador debe rechazar los no declarados. **Tercero**, los tests API existentes que ejecutan `stop`/`restart`/`update-container`/host-commands no siembran verificación y, en `api-host-commands.test.ts`, la sesión simulada ni siquiera tiene `session.id`: pasarán a 403 o a 503 salvo que se centralice un helper de sesión verificada.

La CSP recomendada es estricta con nonce (`'strict-dynamic'`) emitida desde `src/proxy.ts` solo para documentos (matcher que excluye `api`, `_next/*` y ficheros con punto), porque la página ya es `force-dynamic` y la documentación de Next 16.4.6 describe exactamente ese camino; `style-src` necesita `'unsafe-inline'` porque hay 13 `style={{…}}` que se serializan como atributos `style=""` en el HTML. Para HSTS, emitirlo desde la aplicación (`next.config.ts`) con `max-age=15552000`, sin `includeSubDomains` ni `preload`, y dejar apagado el interruptor HSTS de Nginx Proxy Manager para no duplicar la cabecera. El tope de respuesta se implementa como un `NasInvalidResponse` cuyo `cause` es una clase `ResponseTooLarge`, de modo que el colector y `deploy-progress` ya lo tratan como contrato roto sin tocarlos.

**Primary recommendation:** crear `src/lib/sensitive-actions.ts` (puro, importable desde cliente) como único manifiesto de rutas y acciones, con `satisfies Record<…>` exhaustivo sobre `actionSchema` y `hostCommandIds`; aplicar el guard desde ese manifiesto en `/api/action` y `runHostCommand`; migrar la UI y los tests existentes con un helper compartido; y después añadir `src/lib/request-body.ts`, el tope en `nas.ts`, `src/proxy.ts` con la CSP y HSTS en `next.config.ts`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Decidir si una acción exige verificación reciente | API / Backend (módulo puro `sensitive-actions.ts`) | Browser / Client (solo lee la misma tabla para explicar) | El servidor es la autoridad (D-07); la tabla debe ser importable por el cliente sin traer `db` |
| Comprobar la verificación reciente | API / Backend (`guardSensitiveAction`) | Database / Storage (`recentVerification`) | El registro vive en PostgreSQL y nunca se lee del cliente |
| Pedir passkey o contraseña y reintentar tras 403 | Browser / Client (`useSensitiveAction`) | API / Backend (`/api/verification*`) | Solo la UI puede ejecutar WebAuthn; el servidor valida |
| Tope de cuerpo de mutaciones (413) | API / Backend (`request-body.ts` en cada handler) | — | Debe ocurrir antes de `JSON.parse` y antes de cualquier escritura |
| Tope de respuesta del agente | API / Backend (`nas.ts`, único lector) | Browser / Client (muestra el error y conserva el último dato) | Un solo punto lee del agente; la UI ya retiene datos viejos en `useHostRead` |
| CSP con nonce | Frontend Server (SSR) (`src/proxy.ts`) | Browser / Client (la aplica) | Necesita un nonce por petición y renderizado dinámico |
| CSP estática para respuestas JSON y HSTS | API / Backend (`next.config.ts` `headers()`) | CDN / Static — no hay CDN | Cabeceras constantes, sin lógica por petición |
| Terminación TLS | Proxy externo (Nginx Proxy Manager / Tailscale Serve) | — | HSTS solo se respeta sobre HTTPS; la app emite, el proxy transporta |

## Standard Stack

No hay dependencias nuevas. Todo se resuelve con lo instalado. `[VERIFIED: package.json]`

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | 16.4.6 | `proxy.ts` (antes middleware), `headers()` en `next.config.ts` | Versión instalada y fijada; la CSP con nonce está documentada en `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md` |
| zod | ^4.6.7 | Esquemas de cuerpo, enumeración de ids de acción (`actionSchema.options`) | Ya es el contrato de validación del hub |
| effect | ^4.1.2 | `nasEffectForHost` (único lector del agente) | Ya modela los fallos tipados del cliente del agente |
| vitest | ^5.1.0 | Tests de manifiesto, cuerpo, cabeceras, tope de respuesta | Suite existente (`tests/**/*.test.ts`) |
| @playwright/test | ^1.65.0 | Test e2e de CSP sin violaciones y de la UI migrada | Suite e2e existente; Chromium ya en caché local |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:fs` | Node 24 local / 26 CI | Test de enumeración de ficheros `route.ts` y escaneo de literales | Solo en tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| CSP con nonce en `proxy.ts` | CSP estática en `next.config.ts` con `script-src 'self' 'unsafe-inline'` (ejemplo "Without Nonces" de la documentación) | Más simple y sin proxy, pero `'unsafe-inline'` en scripts anula casi todo el valor frente a XSS, que es el riesgo que CONCERNS.md nombra |
| CSP con nonce | `experimental.sri` (hash por SRI) | Experimental en 16.4.6; descartado por riesgo |
| Manifiesto completo de rutas | Solo lista de acciones protegidas | No detecta una ruta nueva en el catch-all ni un método no declarado |

**Installation:**
```bash
# Ninguna. Sin paquetes nuevos.
```

**Version verification:** `[VERIFIED: node_modules/next/package.json]` `"version": "16.4.6"`. No se recomienda ningún paquete nuevo, así que no hay nada que verificar contra el registro.

## Package Legitimacy Audit

No se instala ningún paquete externo en esta fase, así que la puerta `package-legitimacy` no aplica.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (ninguno) | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
Navegador / PWA
   │  HTML (GET /)                         JSON (POST /api/...)
   ▼                                          ▼
Nginx Proxy Manager  ──┐              Nginx Proxy Manager / Tailscale Serve
Tailscale Serve  ──────┤  (TLS; reenvían cabeceras de la app, entre ellas HSTS)
                       ▼
                  Next.js app (puerto 4323 / 127.0.0.1:4324)
   ┌───────────────────┴──────────────────────────────────────────┐
   │ src/proxy.ts (solo documentos)     next.config.ts headers()  │
   │  genera nonce, fija CSP estricta   HSTS en todo; CSP mínima  │
   │  en cabeceras de petición y        default-src 'none' en     │
   │  respuesta                         /api/:path*               │
   └───────────────────┬──────────────────────────────────────────┘
                       ▼
        src/app/api/[...path]/route.ts  handle()
          1. origen permitido (mutaciones)            → 403
          2. setup (sin sesión) ─────────────┐
          3. sesión                           → 401   │
          4. manifiesto: lookup(método, ruta) → 404 / 405 si no declarado
          5. readJsonBody(request, límite)    → 413 sin parsear, sin log, sin escritura
          6. schema (zod)                     → 400
          7. política: protegida? → guardSensitiveAction → 403 recent_verification_required
          8. replay idempotente / host / muestra reciente / operations.insert
          9. nasForHost → agente
                       │
                       ▼
          src/lib/nas.ts nasEffectForHost
            fetch → Content-Length > tope? → falla    (sin leer)
                  → lectura en streaming con tope     (cancela al pasar)
                  → JSON.parse solo si cabe entero
            exceso → NasInvalidResponse{cause: ResponseTooLarge}
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
 colector (worker): no escribe     ruta GET: 502 {code:"agent_response_too_large"}
 muestra, no resuelve incidencias  → useHostRead conserva el último dato y muestra el error
```

### Recommended Project Structure
```
src/
├── proxy.ts                     # NUEVO: CSP con nonce solo para documentos
├── lib/
│   ├── sensitive-actions.ts     # NUEVO: manifiesto único, puro, importable desde cliente
│   ├── csp.ts                   # NUEVO: buildContentSecurityPolicy(nonce, isDev) puro y testeable
│   ├── request-body.ts          # NUEVO: readJsonBody + BodyTooLarge
│   ├── verification-api.ts      # guardSensitiveAction ya existe; añadir guardForPolicy
│   └── nas.ts                   # tope de respuesta + ResponseTooLarge
tests/
├── sensitive-actions.test.ts    # manifiesto, escaneo, matriz de comportamiento
├── request-body.test.ts
├── security-headers.test.ts
├── verified-session.ts          # helper compartido (no es *.test.ts)
└── e2e/csp.spec.ts
```

### Inventario exhaustivo de mutaciones (SEC-01, SEC-02, D-06)

Leído completo en `src/app/api/[...path]/route.ts` (901 líneas) y los módulos a los que despacha.

**Rutas del catch-all con efecto (método distinto de GET).**

| Ruta | Método declarado | Hoy llama a guard | Lectura de cuerpo (línea) | Decisión | Motivo para el manifiesto |
|------|------------------|-------------------|---------------------------|----------|---------------------------|
| `setup` | POST | no (no hay sesión) | `route.ts:146` | exenta | alta inicial protegida por `SETUP_TOKEN`, cuenta cero y bloqueo advisory |
| `verification/password` | POST | no | `verification-api.ts:65` | exenta | es la propia verificación; exige sesión |
| `containers/remove` | POST | `lifecycle.ts:212` | `lifecycle.ts:192` | protegida (ya) | elimina un contenedor |
| `host-command` | POST | **no** | `host-commands.ts:224` | por comando (ver tabla) | cambia estado del host |
| `incidents/:id/(acknowledge\|snooze\|unsnooze)` | POST | no | `route.ts:313` | exenta (D-05) | reconocer y silenciar no pierden datos |
| `deployments/settings` | POST | `deployment-settings.ts:121` | `deployment-settings.ts:98` | protegida (ya) | escribe el `.env` del host |
| `renovate/merge` | POST | `renovate-merge.ts:149` | `renovate-merge.ts:148` | protegida (ya) | fusiona una PR y puede lanzar `deploy-now` |
| `presence` | POST (y DELETE) | no | `route.ts:548` | exenta | latido de pestaña visible; **no figura en la lista D-06** |
| `action` | POST (y DELETE) | solo `reboot` (`route.ts:597-604`) | `route.ts:576` | por acción (ver tabla) | despachador de acciones del agente |
| `settings` | POST (y DELETE) | no | `route.ts:783` | exenta (D-06) | umbrales; el esquema es estricto |
| `push` | POST | no | `route.ts:824` | exenta (D-06) | suscripción de la propia sesión |
| `push` | DELETE | no | `route.ts:852` | exenta | baja de la propia suscripción; **no figura en la lista D-06** |
| `push/test` | POST (y DELETE) | no | no lee cuerpo | exenta (D-06) | encola un envío de prueba al propietario |

Fuera del catch-all: `src/app/api/auth/[...all]/route.ts` (`export const { GET, POST } = toNextJsHandler(auth);`) pertenece a Better Auth. Debe aparecer en el manifiesto como ruta delegada y exenta, con el motivo "Better Auth valida credenciales y limita intentos". `[VERIFIED: find src -name route.ts]` solo existen esos dos ficheros `route.ts`, y no existe `proxy.ts` ni `middleware.ts`. No hay Server Actions `[VERIFIED: grep "use server" src]`.

**Acciones de `/api/action`.** Valores verbatim de `src/lib/validation.ts:14-34` y comprobados ejecutando la enumeración: `start,stop,restart,update-container,reboot,move,trash,restore,purge,empty-trash`.

| `action` | Decisión | Fuente |
|----------|----------|--------|
| `start` | exenta | D-01 |
| `stop` | **protegida** | D-01 |
| `restart` | **protegida** | D-01 |
| `update-container` | **protegida** | D-01 |
| `reboot` | protegida (ya) | D-04 |
| `move` | exenta | D-02 |
| `trash` | exenta | D-02 |
| `restore` | exenta | D-02 |
| `purge` | **protegida** | D-02 |
| `empty-trash` | **protegida** | D-02 |

`remove-container` no está en `actionSchema`: es la ruta propia `containers/remove`.

**Comandos de host.** Valores verbatim de `src/lib/host-command-contract.ts:4-13`: `"deploy-now"`, `"pause-follower"`, `"resume-follower"`, `"run-security"`, `"backup-now"`, `"clean-images"`, `"check-health"`, `"reconnect-apps"`. Protegidos los siete de D-03; `check-health` exento. `executeHostCommand` (usado también por `renovate-merge.ts:78` tras su propio guard) no debe llevar guard propio: la decisión pertenece a quien lo llama.

**Hallazgo de método.** `route.ts:130` es `const mutation = request.method !== "GET";` y las exportaciones son `GET`, `POST` y `DELETE` (`route.ts:899-901`). Las ramas `route === "action" && mutation`, `"settings" && mutation`, `"presence" && mutation` y `"push/test" && mutation` aceptan por tanto también `DELETE`. El guard por cuerpo sigue protegiendo `DELETE /api/action`, pero el manifiesto debe declarar `methods` y el despachador devolver 405 (o 404) para cualquier otro. `[VERIFIED: route.ts:130, 899-901]`

### Pattern 1: Manifiesto único, puro y exhaustivo por tipos

**What:** un módulo sin importaciones de servidor que declara cada acción, cada comando y cada ruta, con política y motivo. Los `Record` con `satisfies` hacen que añadir una acción a `actionSchema` o un comando a `hostCommandIds` sin declararlo no compile.
**When to use:** siempre que una ruta o acción nueva toque el hub; la fase 7 lo reutilizará.
**Example:**
```typescript
// src/lib/sensitive-actions.ts  — sin imports de db, auth ni next/server
import type { z } from "zod";
import type { actionSchema } from "./validation";
import type { HostCommand } from "./host-command-contract";

export type ActionId = z.infer<typeof actionSchema>["action"];
export type Policy =
  | { kind: "protected"; reason: string }
  | { kind: "exempt"; reason: string };
const protectedBy = (reason: string): Policy => ({ kind: "protected", reason });
const exempt = (reason: string): Policy => ({ kind: "exempt", reason });

export const actionPolicies = {
  start: exempt("No pierde datos ni corta servicio"),
  stop: protectedBy("Corta el servicio"),
  restart: protectedBy("Interrumpe el servicio"),
  "update-container": protectedBy("Recrea el servicio"),
  reboot: protectedBy("Reinicia el host"),
  move: exempt("Recuperable moviendo de vuelta"),
  trash: exempt("La papelera conserva 7 días"),
  restore: exempt("Recupera, no destruye"),
  purge: protectedBy("Irreversible"),
  "empty-trash": protectedBy("Irreversible"),
} satisfies Record<ActionId, Policy>;

export const hostCommandPolicies = {
  "deploy-now": protectedBy("Cambia el estado del host"),
  // … los seis restantes protegidos …
  "check-health": exempt("Solo lee"),
} satisfies Record<HostCommand, Policy>;

export const requiresVerification = (policy: Policy) => policy.kind === "protected";
```
La UI importa `actionPolicies`/`hostCommandPolicies` para decidir si abre el diálogo de passkey (D-07). Los ids enumerables se obtienen en tests con `actionSchema.options` (ver Code Examples).

### Pattern 2: Manifiesto de rutas con métodos y despacho fail-closed

**What:** `routeManifest` declara cada literal de `route === "…"` del catch-all (lecturas incluidas como `read`) y cada ruta por expresión regular, con sus métodos permitidos. `handle()` consulta el manifiesto antes de la cadena de `if` y devuelve 404 o 405 si la pareja método-ruta no está declarada.
**Why:** convierte "olvidé declarar la ruta" en un fallo observable (la ruta nueva no responde) y además el test de escaneo (plan 06-02) lo detecta aunque su autor no escriba ninguna prueba.
**Cuidado:** `setup` y `push` sirven GET y POST; la entrada declara una lista de métodos, no uno.

### Pattern 3: Lector de cuerpo con tope, antes de parsear

**What:** `readJsonBody(request, { limit = 16 * 1024 })` comprueba `Content-Length`, lee `request.body` en streaming contando bytes, cancela el lector al pasar el tope y solo entonces llama a `JSON.parse`. Lanza `BodyTooLarge`; el `catch` del catch-all la convierte en 413 antes del `console.error("API error", …)` genérico.
**Verificado:** sonda ejecutada con Node 24 (ver Code Examples): un cuerpo de 20 000 bytes con tope 16 384 se corta en streaming, un cuerpo troceado sin `Content-Length` también, y uno pequeño pasa.
**Cuidado con los tests:** `new Request(url, { body: "…" })` **no** añade `Content-Length` (la sonda mostró `content-length: null` en el troceado y el camino "declared" no se ejercitó con cuerpo en cadena). Un test del pre-chequeo declarado debe fijar la cabecera explícitamente.

### Pattern 4: Tope de respuesta del agente sin romper a los llamadores

**What:** en `nasEffectForHost` (`src/lib/nas.ts`), sustituir `response.text()` (líneas 60-63) por un lector acotado: si `Content-Length` supera el tope se cancela el cuerpo sin leerlo; si no, streaming con contador y `reader.cancel()` al pasar. Nunca se llama a `JSON.parse` con datos parciales. El fallo es `new NasInvalidResponse({ cause: new ResponseTooLarge(limit, path) })`.
**Por qué reutilizar `NasInvalidResponse`:** `collector.ts:384` (`if (error instanceof NasInvalidResponse)`) y `deploy-progress.ts:264-266` ya tratan esa clase como contrato roto: sin muestra, sin resolver incidencias, sin contar como desconexión. Una respuesta excesiva debe comportarse igual. Para POST (acción ejecutada), una respuesta excesiva cae en la rama de "resultado pendiente de verificar" porque no es `NasRejected`, que es lo correcto: la acción pudo ejecutarse.
**En la ruta:** añadir al `catch` de `route.ts` una rama anterior a la genérica que mapee `NasInvalidResponse` con `cause instanceof ResponseTooLarge` a `502` con `{ error: "La respuesta del host es demasiado grande para mostrarla.", code: "agent_response_too_large" }`.
**En la UI (D-11):** `use-host-read.ts` hoy lanza siempre `"No se pudo actualizar esta sección"` ante `!response.ok`; debe leer `code` y `error` del cuerpo y conservar `old.data` (ya lo hace). `container-logs.tsx` ya lee `body.error`.

### Pattern 5: CSP con nonce en `src/proxy.ts`, solo documentos

Según la documentación instalada, el proxy genera el nonce, lo pone en la cabecera `Content-Security-Policy` de la **petición** y de la respuesta, y Next lo aplica a los scripts del framework durante el renderizado dinámico. `[CITED: node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md]` La página principal ya es `export const dynamic = "force-dynamic";` (`src/app/page.tsx`) y la página de harness e2e lee `headers()`, así que ambas son dinámicas.

Puntos que la documentación fija y esta investigación contrastó con el código:
- El matcher recomendado excluye `api`, `_next/static`, `_next/image` y `favicon.ico`. Aquí hay que excluir además los ficheros de `public/` (`sw.js`, `manifest.webmanifest`, `icon-*.png`, `icon.svg`): `/((?!api|_next/static|_next/image|.*\\..*).*)`. `[ASSUMED]` la forma exacta del patrón; la documentación solo muestra `.*\\.png$`.
- Con proxy activo Next clona y almacena en memoria el cuerpo de las peticiones **que casan** (10 MB por defecto, `experimental.proxyClientMaxBodySize`). `[CITED: …/proxyClientMaxBodySize.md]` Al excluir `api` del matcher, ninguna mutación pasa por ese buffer y el tope de 16 KB sigue siendo el único.
- `'unsafe-eval'` solo en desarrollo. `[CITED: content-security-policy.md]`
- Los `not-found` estáticos no reciben nonce: la documentación dice que todas las páginas deben ser dinámicas. Comprobar en el e2e que la 404 no genera violaciones, o forzar `export const dynamic = "force-dynamic"` en `src/app/layout.tsx`.

**Política recomendada** (construida por `buildContentSecurityPolicy(nonce, isDev)` en `src/lib/csp.ts`):
```
default-src 'self';
script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""};
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
worker-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```
Justificación de cada decisión no obvia:
- **`style-src 'unsafe-inline'`**: hay 13 `style={{…}}` en `chart.tsx`, `views/shared.tsx` y `views/resource-panels.tsx`, anchos porcentuales dependientes de datos. Los componentes cliente se renderizan en servidor y emiten atributos `style=""`, que `style-src` sin `'unsafe-inline'` bloquea. `[VERIFIED: grep "style={{" src]` (13 coincidencias). Intentar `style-src 'self'` más `style-src-attr 'unsafe-inline'` es una mejora posible, pero no se pudo verificar sin una compilación con base de datos; queda como mejora opcional condicionada al e2e.
- **Sin `upgrade-insecure-requests`** (que sí lleva el ejemplo de la documentación): Playwright y el desarrollo usan `http://localhost:3000`, y TLS ya lo pone el proxy; HSTS cubre el resto. `[ASSUMED]` que un navegador la aplicaría a `localhost` y rompería el e2e; omitirla no cuesta nada.
- **`font-src 'self'`**: los woff2 son ficheros estáticos locales. `[VERIFIED: .next/static/chunks/*.css]` solo hay `url(../media/…woff2)`; no hay `url(data:` en el CSS compilado.
- **`worker-src 'self'`**: la sonda de esta sesión (Chromium, servidor HTTP mínimo con `script-src 'self' 'nonce-…' 'strict-dynamic'`) registró `/sw.js` correctamente **con y sin** `worker-src`, y bloqueó el script en línea sin nonce. Se declara de todos modos por claridad. Firefox y Safari no se probaron: `[ASSUMED]` el mismo comportamiento.
- **WebAuthn y push**: `navigator.credentials` y `pushManager.subscribe` no los gobierna la CSP; `authClient` y los sondeos usan `fetch` al mismo origen, cubierto por `connect-src 'self'`. `[ASSUMED]` para push en Safari; se cubre en la UAT.
- **Enforced y no Report-Only**: no hay sumidero de informes y crear uno exigiría una ruta POST nueva que habría que declarar y limitar. Report-Only sin informes solo deja un mensaje en la consola. En su lugar, el e2e `csp.spec.ts` escucha `securitypolicyviolation` y falla ante cualquier violación en login, panel y 404; la reversión es borrar `src/proxy.ts`.

**CSP para respuestas JSON.** El criterio de éxito 3 dice "las respuestas". En `next.config.ts`, una entrada `source: "/api/:path*"` con `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` cubre las respuestas de la API sin afectar a los documentos (el proxy no las toca).

### Pattern 6: HSTS desde la aplicación

`headers()` de `next.config.ts` ya existe con `source: "/:path*"` (nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`). Añadir ahí `Strict-Transport-Security: max-age=15552000`.

- **Dónde:** en la aplicación. Un navegador ignora HSTS recibido por HTTP, así que emitirlo en `localhost` es inocuo, y emitirlo en la aplicación cubre a la vez el dominio principal (Nginx Proxy Manager) y el alternativo (Tailscale Serve) sin configurar dos proxies. `[ASSUMED]` que ambos proxies reenvían las cabeceras de la aplicación sin tocarlas (comportamiento por defecto de `proxy_pass` en nginx).
- **Valor:** 180 días, sin `includeSubDomains` ni `preload`. `includeSubDomains` afectaría a todo subdominio del dominio principal que comparta el nombre (p. ej. otros servicios del NAS), y `preload` es prácticamente irreversible. `[ASSUMED]` criterio conservador; el operador puede subirlo tras observar.
- **No duplicar:** si Nginx Proxy Manager tiene activo su interruptor "HSTS Enabled", llegarían dos cabeceras y RFC 6797 solo respeta la primera. Documentar en el README (sección "Configuración y despliegue", junto a la ruta de NPM, y en "Entrada privada alternativa") que ese interruptor debe quedar apagado.
- `README.md` cita ambas topologías `[VERIFIED: README.md]` ("Configura Nginx Proxy Manager para dirigir el dominio HTTPS a `APP_SERVER_TAILSCALE_IP:4323`" y "Puedes publicar `127.0.0.1:4324` mediante Tailscale Serve").

### Orden dentro de cada ruta (discreción de CONTEXT.md)

- **`/api/action`:** colocar el guard en el mismo sitio que hoy el de `reboot` (tras el replay idempotente, antes de la muestra reciente y del `insert`), pero decidiendo con `actionPolicies[body.action]`. Cero cambio de comportamiento para `reboot`.
- **`host-command`:** colocar el guard en `runHostCommand` entre el parseo de `Idempotency-Key` y `executeHostCommand`. Un replay de una operación ya terminada exigirá verificación reciente; es un efecto menor y aceptable, y evita partir `executeHostCommand`.
- **Un 403 no debe registrar la operación**: el diálogo reutiliza la misma clave de idempotencia tras un 403 (`sensitive-action.tsx`, "Reuse the key of an attempt the server already refused"). `[VERIFIED: sensitive-action.tsx:52]`

### Anti-Patterns to Avoid
- **Guard solo en la UI:** es exactamente el hueco de CONCERNS.md. La UI solo lee la tabla.
- **Lista de protegidas separada de la lista de rutas:** reproduce el hueco "implícita y duplicada". Un solo manifiesto.
- **`request.json()` suelto en un handler nuevo:** pasa por `readJsonBody`.
- **`catch { return 400 }` alrededor del parseo:** `handlePasswordVerification` (`verification-api.ts:63-68`) captura cualquier error del parseo y responde 400. Si `readJsonBody` lanza `BodyTooLarge` ahí, se convertiría en 400 y no en 413. Debe relanzarla.
- **`NasRejected` para un exceso de respuesta:** cambiaría la semántica de "pendiente de verificar" en acciones.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Generar el nonce y propagar la CSP | Parsear o inyectar nonces en el HTML a mano | `src/proxy.ts` con `x-nonce` y la cabecera `Content-Security-Policy` de la petición, como indica la documentación de Next | Next extrae el nonce del `Content-Security-Policy` de la petición y lo aplica a sus scripts |
| Enumerar los ids de acción | Un array duplicado junto al manifiesto | `actionSchema.options` y `hostCommandIds` como fuentes; `satisfies Record<…>` | Una segunda lista se desincroniza, que es el fallo que la fase combate |
| Verificación reciente | Otro mecanismo de ventana | `guardSensitiveAction`, `RECENT_VERIFICATION_TTL_MS`, `verificationStore` | Ya existen, probados en `tests/verification.test.ts` |
| Diálogo de confirmación con passkey | Un diálogo nuevo | `useSensitiveAction` | Ya maneja 403, reintento con la misma clave, contraseña en el dominio alternativo y estados pendiente y fallido |
| Fallos tipados del cliente del agente | Una clase de error nueva con ramas nuevas en colector y `deploy-progress` | `NasInvalidResponse` con `cause: ResponseTooLarge` | Los dos llamadores ya la tratan como contrato roto |
| Fixtures de sesión verificada en tests | Copiar el `insert` de `recentVerification` en cada fichero | Un helper `tests/verified-session.ts` | Hoy `api-lifecycle`, `api-deployment-settings` y `api-merge-progress` lo repiten; ahora lo necesitan cinco ficheros más |

**Key insight:** la fase no añade capacidad nueva, solo traslada decisiones que hoy están dispersas (en la UI, en cinco módulos y en una cadena de `if`) a un único módulo comprobable. Cada vez que se tiene la tentación de añadir una lista, hay que preguntarse si el manifiesto ya la contiene.

## Common Pitfalls

### Pitfall 1: La UI se rompe en cuanto el servidor protege
**What goes wrong:** `dashboard.tsx` `execute()` (líneas 477-518) hace `fetch(withHost("/api/action", …))` directo para `stop`, `restart`, `purge`, `empty-trash`; `maintenance-extras.tsx` `run()` (líneas 48-95) hace `fetch("/api/host-command")` directo para `deploy-now`, `reconnect-apps`, `backup-now`, `clean-images` (este último con `window.confirm`). Tras proteger el servidor devolverán 403 y la UI mostrará solo `result.error`.
**Why it happens:** CONTEXT.md habla de que el diálogo "ya existe", pero solo lo usan `reboot`, `update-container`, eliminación, `deployment-details` (merge y ajustes) y `command-search`.
**How to avoid:** en el diálogo simple de `dashboard.tsx`, si `requiresVerification(actionPolicies[action.body.action])`, delegar en `useSensitiveAction.request({ endpoint, body, typedConfirmation, onSettled })` en lugar de abrir `<dialog>` propio; en `maintenance-extras.tsx` hacer lo mismo para los cuatro comandos protegidos y dejar `check-health` directo; en `command-search.tsx` ejecutar `check-health` sin diálogo (hoy pasa siempre por `sensitive.request`, `command-search.tsx:36`) reutilizando el mismo `fetch` directo.
**Warning signs:** un 403 con `code: "recent_verification_required"` visible como texto de error rojo; e2e rojos en `files-apps.spec.ts`, `hosts.spec.ts`, `maintenance*.spec.ts`.

### Pitfall 2: Los tests e2e y API existentes pasan a 403
**What goes wrong:** `tests/e2e/files-apps.spec.ts:260-290` (restaurar, purgar, vaciar), `tests/e2e/hosts.spec.ts:231-238` (reiniciar `seerr`), `tests/e2e/maintenance*.spec.ts` (acciones de contenedor y `/api/host-command`) interceptan `**/api/action*` pero el diálogo de acción sensible primero consulta `GET /api/verification`; `tests/api-hosts.test.ts:315,329`, `tests/api-incidents.test.ts` (líneas 1087, 1215, 1235, 1499, entre otras con `stop` y `restart`), `tests/api-lifecycle.test.ts:428` (`update-container`) y `tests/api-host-commands.test.ts` (los siete comandos) no siembran verificación. `api-host-commands.test.ts:29` simula `getSession` sin `session.id` (`session.value` solo trae `user`): el guard leería `session.session.id` y fallaría con 503.
**How to avoid:** helper `tests/verified-session.ts` que siembra `recentVerification` (patrón de `api-lifecycle.test.ts:196-203`: `sessionId: "test-session"`, `userId: "test-user"`, `method: "passkey"`, `expiresAt` +300 000 ms) y completa la sesión simulada con `session: { id: "test-session" }`. Para los e2e, interceptar `**/api/verification*` devolviendo `recent: true` en los flujos migrados (como ya hace `sensitive-action.spec.ts` contra su harness).
**Warning signs:** 403 o 503 inesperados al ejecutar `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-hosts.test.ts`.

### Pitfall 3: 413 convertido en 400 o 503
**What goes wrong:** `catch` genéricos engullen `BodyTooLarge`. En el catch-all, cualquier error no reconocido cae en el `503` genérico y en `console.error("API error", …)` (`route.ts:889-896`), lo que violaría D-09 (sin línea de log).
**How to avoid:** `if (error instanceof BodyTooLarge) return json({ error: "…" }, 413)` como **primera** rama del `catch`; relanzarla en `handlePasswordVerification`. Test: espiar `console.error`, comprobar que no se llamó, y que `operations` y `alerts` no cambian.

### Pitfall 4: Tests sin `Content-Length`
**What goes wrong:** el camino "declarado" del lector nunca se ejercita en tests porque `NextRequest`/`Request` no añaden la cabecera a un cuerpo en cadena.
**How to avoid:** en `request-body.test.ts`, probar los dos caminos por separado: cabecera declarada grande con cuerpo vacío (debe fallar **sin** leer el flujo; basta con un `ReadableStream` cuyo `pull` marque una bandera) y cuerpo troceado sin cabecera.

### Pitfall 5: Rutas nuevas fuera del catch-all
**What goes wrong:** la fase 7 (Telegram) puede añadir `src/app/api/telegram/.../route.ts`; un test que solo escanee `[...path]/route.ts` no lo vería.
**How to avoid:** el test enumera `src/app/api/**/route.ts` y compara con `routeFiles` del manifiesto.

### Pitfall 6: Cuerpos con tope alto legítimo
**What goes wrong:** `deploymentSettingsSchema` admite hasta 64 valores de 4096 caracteres (más de 256 KiB), pero el agente rechaza lo que supere `MAX_REQUEST_BYTES = 64 * 1024` (`agent/env_settings.py:29`, verbatim) y `/action` en el agente acepta `0 < size <= 8192` (`agent/server.py`, verbatim). Un tope global de 16 KB rompería `deployments/settings`.
**How to avoid:** `deployments/settings` declara `limit: 64 * 1024`, alineado con el agente; el resto usa el valor por defecto.

### Pitfall 7: Doble `Strict-Transport-Security`
**What goes wrong:** la aplicación y el interruptor de HSTS de Nginx Proxy Manager emiten cabecera; solo se respeta la primera.
**How to avoid:** documentarlo en el README y dejar un único emisor.

### Pitfall 8: Nonce ausente en páginas estáticas
**What goes wrong:** `_not-found` se prerenderiza en la compilación, sin cabeceras de petición, así que sus scripts en línea no llevan nonce y `strict-dynamic` los bloquea (la página se ve pero no hidrata).
**How to avoid:** `export const dynamic = "force-dynamic"` en `src/app/layout.tsx` o comprobarlo en el e2e; no usar `<Script>` sin `nonce`.

### Pitfall 9: Endpoint de contraseña sin límite propio
**What goes wrong:** en el dominio alternativo el factor de verificación es la contraseña (`verificationMethodForOrigin`). `POST /api/verification/password` llama a `auth.api.verifyPassword` directamente, no por el manejador HTTP de Better Auth. `[ASSUMED]` que el limitador integrado (`rateLimit: { enabled: true }`) solo actúa sobre peticiones HTTP a `/api/auth/*` y no sobre llamadas internas a `auth.api.*`. Una cookie de sesión robada podría probar contraseñas sin freno, que es la amenaza que la puerta intenta cerrar.
**How to avoid:** fuera del alcance de la fase por defecto; se recoge en Open Questions para que el usuario decida si añade un contador de intentos.

## Code Examples

### Enumerar las acciones de `actionSchema` en un test
```typescript
// Verificado en esta sesión con `node --import tsx` sobre src/lib/validation.ts:
// salida: start,stop,restart,update-container,reboot,move,trash,restore,purge,empty-trash
import { actionSchema } from "../src/lib/validation";

function actionIds() {
  const ids: string[] = [];
  for (const option of actionSchema.options) {
    const def = (option.shape as Record<string, { _zod: { def: any } }>)
      .action._zod.def;
    if (def.type === "enum") ids.push(...(Object.values(def.entries) as string[]));
    else if (def.type === "literal") ids.push(...def.values);
  }
  return ids;
}
```
`_zod.def` es la API de introspección de zod 4. `[VERIFIED: sonda con zod ^4.6.7]` Para no depender de ella en el código de producción, el tipo `ActionId` sale de `z.infer<typeof actionSchema>["action"]` y la comprobación en tiempo de ejecución queda solo en el test.

### Lector de cuerpo acotado
```typescript
// Prototipo ejecutado en Node 24: tope de 16 384 bytes.
// declarado / troceado sin Content-Length / pequeño => "413-streamed" / "413-streamed" / '{"a":1}'
export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super("La solicitud es demasiado grande");
  }
}
export const DEFAULT_BODY_LIMIT = 16 * 1024;

export async function readBodyText(request: Request, limit = DEFAULT_BODY_LIMIT) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new BodyTooLarge(limit);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLarge(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonBody(request: Request, limit = DEFAULT_BODY_LIMIT) {
  return JSON.parse(await readBodyText(request, limit)) as unknown;
}
```
`JSON.parse` de un cuerpo vacío o malformado lanza `SyntaxError`, igual que `request.json()` hoy (cae en el 503 genérico de `route.ts`). Conservar ese comportamiento mantiene el alcance acotado; convertirlo en 400 sería una mejora aparte.

### Tope de respuesta en `nasEffectForHost`
```typescript
// src/lib/nas.ts — sustituye a response.text() (líneas 60-63)
export class ResponseTooLarge extends Error {
  constructor(readonly limit: number) {
    super("Respuesta del agente demasiado grande");
  }
}

async function readCapped(response: Response, limit: number) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel();
    throw new ResponseTooLarge(limit);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ResponseTooLarge(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
// En el Effect.gen: catch: (cause) => cause instanceof ResponseTooLarge
//   ? new NasInvalidResponse({ cause }) : new NasUnavailable({ cause })
```
Para que `Effect.tryPromise` produzca la clase correcta, el `catch` de la lectura debe distinguir `ResponseTooLarge` de un error de red (hoy cualquier fallo es `NasUnavailable`).

**Topes por lectura, propuesta inicial** (discreción de CONTEXT.md; todos `[ASSUMED]`, ajustar con tamaños reales del agente de producción):

| Camino del agente | Tope | Razonamiento |
|-------------------|------|--------------|
| `/metrics` | 2 MiB | un documento por host con contenedores, discos y temperaturas |
| `/maintenance` | 1 MiB | instantánea de mantenimiento |
| `/deployments` | 2 MiB | journal acotado a 500 líneas (`z.coerce.number().int().min(1).max(500)`) más releases |
| `/files` | 8 MiB | directorio completo sin paginar; es el caso que más puede crecer (la paginación del agente está diferida) |
| `/trash` | 2 MiB | |
| `/logs` | 8 MiB | `MAX_LINES = 5000` (`agent/logs.py:19`) y una línea puede ser enorme; el agente puede leer hasta 64 MiB (`agent/logs.py:21`) |
| respuestas a POST (`/action`, `/command`, `/deployments/settings`) | 256 KiB | resultados pequeños; un exceso se trata como pendiente |
| cualquier otro | 1 MiB | tope por defecto |

Consecuencia que el usuario debe conocer: un directorio de descargas con más entradas que cabe en 8 MiB dejará de poder listarse hasta que se pagine en el agente (diferido); la vista mostrará el error y conservará el último listado válido.

### `src/proxy.ts`
```typescript
// Fuente: node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md
import { NextRequest, NextResponse } from "next/server";
import { buildContentSecurityPolicy } from "@/lib/csp";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|.*\\..*).*)"],
};
```

### Cabeceras estáticas en `next.config.ts`
```typescript
// Añadir a la entrada existente source: "/:path*":
{ key: "Strict-Transport-Security", value: "max-age=15552000" },
// y una entrada nueva solo para la API (no para documentos):
{
  source: "/api/:path*",
  headers: [
    { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
  ],
},
```
La entrada existente verbatim (`next.config.ts`, líneas 6-20): `source: "/:path*"` con `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` y `Permissions-Policy: camera=(), microphone=(), geolocation=()`. `[VERIFIED: next.config.ts]`

### Escaneo de literales del catch-all (SEC-02)
```typescript
// tests/sensitive-actions.test.ts — estructura, no copy (CODING_STANDARD.md)
import { readFileSync, readdirSync } from "node:fs";

const source = readFileSync("src/app/api/[...path]/route.ts", "utf8");
const literals = new Set(
  [...source.matchAll(/route === "([^"]+)"/g)].map((match) => match[1]),
);
// Cada literal debe tener una entrada en routeManifest (lecturas incluidas).
// Y el número de rutas por expresión regular (`.exec(route)`) debe coincidir
// con las entradas de tipo patrón del manifiesto.
```
El fichero actual se leyó completo en esta sesión: el manifiesto debe cubrir todos los literales de `route === "…"` (mutantes y de lectura) más las dos rutas por expresión regular (`incidents/:id` y `incidents/:id/(acknowledge|snooze|unsnooze)`).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `middleware.ts` | `proxy.ts` (runtime Node por defecto) | Next 16 | La CSP con nonce va en `src/proxy.ts`; `[CITED: …/file-conventions/proxy.md]` "The `middleware` file convention is deprecated and has been renamed to `proxy`" |
| CSP estática con `'unsafe-inline'` | Nonce por petición con `'strict-dynamic'` | Guía CSP de Next | Exige renderizado dinámico de todas las páginas; PPR es incompatible `[CITED: content-security-policy.md]` |
| `experimental.middlewareClientMaxBodySize` | `experimental.proxyClientMaxBodySize` | Next 16 | Solo afecta a rutas que casan con el proxy; aquí `api` queda fuera |

**Deprecated/outdated:**
- `middleware.ts`: sustituido por `proxy.ts`.
- `request.json()` sin tope en rutas mutantes: sustituido por `readJsonBody` en esta fase.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Los topes de respuesta (2 MiB métricas, 8 MiB ficheros y logs, etc.) son suficientes para el uso real | Code Examples | Un listado legítimo grande daría error; hay que medir tamaños reales en producción antes de fijar valores |
| A2 | HSTS `max-age=15552000` sin `includeSubDomains` ni `preload` es el criterio conservador adecuado | Pattern 6 | Un valor demasiado alto sería difícil de revertir; demasiado bajo debilita la protección |
| A3 | Nginx Proxy Manager y Tailscale Serve reenvían las cabeceras de la aplicación sin modificarlas | Pattern 6 | HSTS no llegaría al navegador; habría que activarlo en el proxy |
| A4 | El interruptor HSTS de Nginx Proxy Manager duplicaría la cabecera si se deja activo | Pitfall 7 | Si el proxy sustituye en vez de duplicar, el aviso del README sobra |
| A5 | `upgrade-insecure-requests` se aplicaría a `localhost` y rompería el e2e | Pattern 5 | Omitirla es inocuo; solo se pierde una defensa redundante tras HSTS |
| A6 | El patrón de matcher `/((?!api|_next/static|_next/image|.*\\..*).*)` excluye los ficheros de `public/` | Pattern 5 | Un fichero estático recibiría CSP de documento o un documento quedaría sin ella; el e2e lo detecta |
| A7 | El registro de `sw.js` bajo `strict-dynamic` funciona igual en Firefox y Safari que en Chromium | Pattern 5 | La PWA no registraría el service worker; `worker-src 'self'` explícito lo mitiga |
| A8 | Las suscripciones push no las limita `connect-src` en ningún navegador soportado | Pattern 5 | El push dejaría de suscribirse; se cubre en la UAT |
| A9 | El limitador de Better Auth no actúa sobre llamadas internas a `auth.api.verifyPassword` | Pitfall 9 | Si sí actuara, el riesgo descrito no existe |
| A10 | `presence`, `verification/password` y la baja de push (`DELETE push`) son exentas | Inventario | Si el usuario prefiere protegerlas, el manifiesto cambia; son mutaciones no listadas en D-06 |
| A11 | Un tope de 32 KiB para el envoltorio de Better Auth admite los cuerpos de alta de passkey | Open Questions | Un alta de passkey legítima fallaría con 413 |
| A12 | `style-src 'self'` más `style-src-attr 'unsafe-inline'` sería una mejora compatible | Pattern 5 | Si Next emite `<style>` en línea, se rompería el estilo; por eso queda opcional |

## Open Questions

1. **¿Se limita también el cuerpo de `/api/auth/*` (Better Auth)?**
   - What we know: es la superficie sin sesión más expuesta (inicio de sesión) y no pasa por el catch-all; `src/app/api/auth/[...all]/route.ts` exporta `toNextJsHandler(auth)` directamente.
   - What's unclear: cómo envolver `POST` sin alterar el comportamiento de Better Auth.
   - Recommendation: envolver `POST` con una lectura acotada y reconstruir la `Request` con el cuerpo leído (tope propio, 32 KiB, `[ASSUMED]`), y cubrirlo con el e2e de inicio de sesión y el de passkey (`dashboard.spec.ts` ya registra una passkey con el autenticador virtual). Si el planner prefiere acotar la fase, declarar la ruta como exenta con ese motivo y dejar el límite como deuda explícita.

2. **¿Se añade un límite de intentos a `POST /api/verification/password`?**
   - What we know: ver Pitfall 9; la verificación por contraseña es el único factor en el dominio alternativo.
   - What's unclear: si el limitador de Better Auth lo cubre.
   - Recommendation: no está en SEC-01/02/04; abrir una tarea de backlog o decidir en `/gsd-discuss-phase` si entra aquí.

3. **¿Se confirman las exenciones no listadas en D-06 (`presence`, `verification/password`, baja de push)?**
   - What we know: son mutaciones del catch-all que el manifiesto debe declarar y D-06 no las nombra.
   - Recommendation: declararlas exentas con motivo; el planner puede confirmarlo con el usuario en la revisión del plan.

4. **¿Tamaños reales de respuesta del agente?**
   - What we know: los topes propuestos son estimaciones.
   - Recommendation: medir `Content-Length` de `/metrics`, `/files` y `/logs` en producción antes de fijar los valores definitivos, o arrancar con los propuestos y vigilar el 502 `agent_response_too_large`.

5. **Reglas de la fase 7 sobre `executeHostCommand`.**
   - `executeHostCommand` queda sin guard por diseño (lo llama el merge ya protegido). La fase 7 debe invocarlo solo desde una ruta que aplique el manifiesto. Anotarlo en el módulo.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Todo | ✓ | v24.22.3 local (CI y la imagen usan Node 26) | — |
| pnpm | Scripts | ✓ | 12.15.0 | — |
| Vitest | Tests unitarios y API | ✓ | 5.1.0 (28 tests de `verification`, `security` y `service-worker` pasaron en esta sesión) | — |
| Docker | PostgreSQL desechable para `HUB_REQUIRE_TEST_DB=1` | ✓ | demonio activo (otros proyectos en marcha) | — |
| PostgreSQL local del hub | Tests API y e2e | ✗ | no hay base del hub ni `psql`/`pg_isready` | `docker run postgres:18` desechable en loopback (patrón de las fases anteriores y de CI) |
| Chromium de Playwright | e2e de CSP y de la UI migrada | ✓ | `chromium-1255` en `~/Library/Caches/ms-playwright` | `pnpm exec playwright install chromium` |
| Python 3 | `pnpm test:agent` | no necesario | — | La fase no toca `agent/` |

**Missing dependencies with no fallback:** ninguna.

**Missing dependencies with fallback:** PostgreSQL local del hub; se resuelve con el contenedor desechable. No se abrió `.env.local` (contiene secretos); el e2e y los tests API deben arrancarse con variables explícitas de prueba, como hace `.github/workflows/ci.yml`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.1.0 (unitarios y API) y Playwright 1.65 (e2e en Chromium) |
| Config file | `vitest.config.ts` (alias `@` a `src`, `include: ["tests/**/*.test.ts"]`) y `playwright.config.ts` (`webServer: pnpm start`) |
| Quick run command | `pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/security-headers.test.ts` |
| Full suite command | `HUB_REQUIRE_TEST_DB=1 pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEC-01 | Cada acción y comando protegido devuelve 403 `recent_verification_required` sin verificación y no llama al agente ni inserta `operations` | integración (ruta real, BD desechable) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ❌ Wave 0 |
| SEC-01 | Cada acción y comando exento no devuelve 403 de verificación | integración | idem | ❌ Wave 0 |
| SEC-01 | `containers/remove`, `deployments/settings` y `renovate/merge` siguen protegidos | integración (ya existen) | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts` | ✅ |
| SEC-01 | La UI abre el diálogo de passkey exactamente para lo protegido (`data-sensitive-action`) y `check-health` no | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/sensitive-action.spec.ts tests/e2e/maintenance-workflows.spec.ts tests/e2e/files-apps.spec.ts` | ✅ (adaptar) |
| SEC-02 | Una acción nueva en `actionSchema` o un comando nuevo en `hostCommandIds` sin entrada falla (tipos y test) | unitario + `pnpm typecheck` | `pnpm test tests/sensitive-actions.test.ts && pnpm typecheck` | ❌ Wave 0 |
| SEC-02 | Todo literal `route === "…"` del catch-all y toda ruta regex tiene entrada en el manifiesto | unitario (estructura) | `pnpm test tests/sensitive-actions.test.ts` | ❌ Wave 0 |
| SEC-02 | `src/app/api/**/route.ts` coincide con `routeFiles` del manifiesto | unitario (estructura) | idem | ❌ Wave 0 |
| SEC-02 | Un método no declarado (p. ej. `DELETE /api/action`) no llega al handler | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ❌ Wave 0 |
| SEC-04 | Cuerpo por encima del tope: 413, sin parseo, sin `operations`, sin `console.error` | unitario + integración | `pnpm test tests/request-body.test.ts` y `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts` | ❌ Wave 0 |
| SEC-04 | `Content-Length` declarado grande se rechaza sin leer el flujo; cuerpo troceado sin cabecera se corta | unitario | `pnpm test tests/request-body.test.ts` | ❌ Wave 0 |
| SEC-04 | `deployments/settings` admite hasta su tope propio de 64 KiB y rechaza más | integración | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-deployment-settings.test.ts` | ✅ (ampliar) |
| SEC-04 | Respuesta del agente por encima del tope: `NasInvalidResponse` con `ResponseTooLarge`, sin JSON parcial; la ruta responde 502 `agent_response_too_large`; el colector no escribe muestra | unitario + integración | `pnpm test tests/agent-client.test.ts` y `HUB_REQUIRE_TEST_DB=1 pnpm test tests/api-logs.test.ts tests/collector-alerts.test.ts` | ✅ (ampliar) |
| SEC-04 | `next.config.ts` emite HSTS y CSP `default-src 'none'` en `/api/:path*`; `buildContentSecurityPolicy` no incluye `'unsafe-inline'` ni `'unsafe-eval'` en scripts de producción y lleva `object-src 'none'` y `frame-ancestors 'none'` | unitario (estructura) | `pnpm test tests/security-headers.test.ts` | ❌ Wave 0 |
| SEC-04 | El documento sirve CSP con nonce y no hay `securitypolicyviolation` en login, panel, 404 ni al registrar el service worker | e2e | `pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e tests/e2e/csp.spec.ts` | ❌ Wave 0 |

Los tests aseveran estado, resultado o estructura, nunca copy (`CODING_STANDARD.md`). El 413 se comprueba por **estado HTTP**, no por el mensaje; las directivas se comprueban por **nombre de directiva**, no por el texto completo.

### Sampling Rate
- **Per task commit:** `pnpm test <ficheros de la tarea> && pnpm typecheck` (con `HUB_REQUIRE_TEST_DB=1` cuando la tarea toque rutas).
- **Per wave merge:** `HUB_REQUIRE_TEST_DB=1 pnpm test tests/sensitive-actions.test.ts tests/request-body.test.ts tests/security-headers.test.ts tests/api-hosts.test.ts tests/api-incidents.test.ts tests/api-host-commands.test.ts tests/api-lifecycle.test.ts tests/api-deployment-settings.test.ts tests/api-merge-progress.test.ts tests/agent-client.test.ts && pnpm typecheck && pnpm lint`.
- **Phase gate:** suite completa, `pnpm build` y los e2e de CSP, `sensitive-action`, `maintenance-workflows`, `files-apps` y `hosts` en verde antes de `/gsd-verify-work`, más el `pnpm test:e2e` completo en CI.

### Wave 0 Gaps
- [ ] `tests/verified-session.ts` — helper compartido que siembra `recentVerification` y fija `session: { id: "test-session" }`; lo necesitan `api-hosts`, `api-incidents`, `api-host-commands`, `api-lifecycle` y el nuevo test de matriz.
- [ ] `tests/sensitive-actions.test.ts` — manifiesto, escaneo de literales, `routeFiles`, matriz de comportamiento por entrada (SEC-01, SEC-02).
- [ ] `tests/request-body.test.ts` — dos caminos del lector y 413 sin efectos (SEC-04).
- [ ] `tests/security-headers.test.ts` — `headers()` de `next.config.ts` y `buildContentSecurityPolicy` (SEC-04).
- [ ] `tests/e2e/csp.spec.ts` — sin violaciones de CSP con la compilación de producción (SEC-04).
- [ ] Adaptar `tests/e2e/files-apps.spec.ts`, `hosts.spec.ts` y `maintenance-workflows.spec.ts` para interceptar `/api/verification` en los flujos migrados.
- [ ] Framework: ya instalado; sin comando de instalación.

## Security Domain

`security_enforcement` está activo y `security_asvs_level` es 1 en `.planning/config.json`.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | sí (reautenticación para acciones sensibles) | `guardSensitiveAction` con passkey (Better Auth) o contraseña; sin mecanismo nuevo |
| V3 Session Management | sí | verificación reciente atada a `session.id`; TTL 5 min (`RECENT_VERIFICATION_TTL_MS = 5 * 60_000`) |
| V4 Access Control | **sí, núcleo de la fase** | manifiesto único y guard en servidor; la UI no es control |
| V5 Input Validation | sí | `readJsonBody` con tope y esquemas zod existentes |
| V6 Cryptography | no | nada nuevo; el nonce usa `crypto.randomUUID()` |
| V8 Data Protection | parcial | los valores de `deployments/settings` no se copian a respuesta, operación ni logs (ya así) |
| V13 API and Web Service | sí | métodos declarados por ruta, 413, tope de respuesta |
| V14 Configuration | sí | CSP, HSTS y cabeceras en `next.config.ts` y `proxy.ts` |

### Known Threat Patterns for Next.js 16 + agente de host

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cookie de sesión robada ejecuta `purge`, `empty-trash`, `clean-images` o `update-container` sin pasar por la UI | Elevation of Privilege | Guard en servidor con ventana de 5 min, ahora para todo lo destructivo (SEC-01) |
| Ruta o acción nueva olvidada en la lista protegida | Elevation of Privilege | Manifiesto con `satisfies`, escaneo de literales y comprobación de ficheros `route.ts` (SEC-02) |
| Verbo no previsto (`DELETE /api/action`) | Tampering | Métodos declarados por ruta y 405 |
| Cuerpo enorme para forzar asignación de memoria | Denial of Service | Tope de 16 KiB antes de parsear, pre-chequeo de `Content-Length` y corte en streaming |
| Respuesta enorme del agente (logs de hasta 64 MiB, listados sin paginar) | Denial of Service | Tope de lectura por camino en `nas.ts`, cancelación del flujo |
| XSS inyectado ejecuta la API con la sesión | Elevation of Privilege / Information Disclosure | CSP con nonce y `strict-dynamic`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` |
| Clickjacking | Spoofing | `frame-ancestors 'none'` (ya hay `X-Frame-Options: DENY`) |
| Degradación a HTTP | Information Disclosure | HSTS tras el proxy TLS |
| Fuga de contenido por errores del agente | Information Disclosure | mensajes de rechazo no reenviados en `deployments/settings` (ya existe) |
| Fuerza bruta de la contraseña de verificación con una sesión robada | Elevation of Privilege | Pendiente: Open Question 2 |

## Project Constraints (from CLAUDE.md)

No existe `./CLAUDE.md` en el repositorio ni `./.claude/CLAUDE.md` con directrices de proyecto (la configuración apunta a `./.agents/GEMINI.md`, que no es un fichero de reglas de código). Las directrices vinculantes proceden de `AGENTS.md` y `CODING_STANDARD.md`:

- **Next.js 16 difiere del conocido:** leer la guía relevante de `node_modules/next/dist/docs/` antes de tocar cabeceras, `next.config.ts`, `proxy.ts` o rutas. Hecho en esta investigación para CSP, `proxy`, `headers` y `proxyClientMaxBodySize`; el ejecutor debe releer `proxy.md` antes de escribir `src/proxy.ts`.
- **`CODING_STANDARD.md`:** los tests aseveran **estado** (atributos `data-*`), **resultado** (estado HTTP, fila guardada, petición enviada) o **estructura** (rol o control etiquetado); nunca copy. Si falta un gancho de estado en un componente, añadir un atributo `data-*` y aseverar sobre él. Antes de terminar un cambio que edite texto de usuario, buscar en `tests/` la cadena antigua y reescribir los tests acoplados. Se aplica a Playwright, Vitest y los tests del agente.
- **Shell del usuario (zsh):** entrecomillar globs, usar `-i ''` y `-E` con BSD `sed`, y no confiar en la división de palabras de variables sin comillas ni en `"$ref:path"` sin llaves.
- **Escritura de textos de usuario:** el 413 y el error de respuesta grande van en español.
- **Secretos:** no leer `.env.local`; usar variables de prueba explícitas.

## Sources

### Primary (HIGH confidence)
- `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md` — nonces, proxy, renderizado dinámico, política recomendada, SRI experimental, `unsafe-eval` en desarrollo
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` — ubicación, matcher, runtime Node, exclusión de rutas
- `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md` — buffer de 10 MB solo para rutas que casan con el proxy
- `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md` — cabeceras por `source`, la última gana en colisión
- Código leído en esta sesión: `src/app/api/[...path]/route.ts`, `src/lib/verification-api.ts`, `src/lib/verification.ts`, `src/lib/validation.ts`, `src/lib/host-command-contract.ts`, `src/lib/host-commands.ts`, `src/lib/lifecycle.ts` (150-290), `src/lib/deployment-settings.ts`, `src/lib/renovate-merge.ts` (100-190), `src/lib/nas.ts`, `src/lib/auth.ts`, `src/app/api/auth/[...all]/route.ts`, `src/app/page.tsx`, `src/app/layout.tsx`, `next.config.ts`, `public/sw.js`, `public/manifest.webmanifest`, `agent/env_settings.py:29`, `agent/server.py` (límites de `/action` y `/deployments/settings`), `src/components/dashboard.tsx`, `file-browser.tsx`, `command-search.tsx`, `sensitive-action.tsx`, `views/maintenance-extras.tsx`, `views/maintenance.tsx`, `views/update-container.tsx`, `views/use-host-read.ts`, tests `api-host-commands`, `api-lifecycle`, `verification`, `security`
- `.planning/codebase/CONCERNS.md`, `README.md`, `.github/workflows/ci.yml`, `CODING_STANDARD.md`, `AGENTS.md`
- Sondas ejecutadas: enumeración de `actionSchema.options` con zod ^4.6.7, lector de cuerpo acotado en Node 24, registro de service worker bajo `strict-dynamic` en Chromium

### Secondary (MEDIUM confidence)
- Ninguna.

### Tertiary (LOW confidence)
- Conocimiento de entrenamiento sobre el comportamiento de Nginx Proxy Manager, Tailscale Serve y Safari/Firefox ante CSP: recogido como `[ASSUMED]` en el registro de suposiciones.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — sin dependencias nuevas; versiones leídas de `package.json` y de `node_modules/next/package.json`.
- Architecture: HIGH — inventario de mutaciones leído línea a línea; el manifiesto cubre cada literal.
- Pitfalls: HIGH para los de código (UI directa, tests sin sesión, `catch` que engulle, `DELETE`); MEDIUM para los dependientes de proxies externos y navegadores no probados.
- CSP exacta: MEDIUM — la política sigue la documentación instalada y el service worker se contrastó en Chromium, pero no se pudo arrancar la aplicación completa (sin base de datos) para comprobar que Next no emite `<style>` en línea ni scripts sin nonce; el e2e `csp.spec.ts` es la comprobación definitiva.

**Research date:** 2026-11-27
**Valid until:** 2026-12-27 (Next 16.4.6 fijado; revisar si se actualiza la versión de `next`)
