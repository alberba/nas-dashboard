# Phase 6: Puerta de seguridad - Pattern Map

**Mapped:** 2026-11-27
**Files analyzed:** 22 (9 nuevos, 13 modificados)
**Analogs found:** 20 / 22

Todos los analogos se leyeron en el codigo vivo y estan trackeados en git (`git ls-files` verificado para `src/`, `tests/`, `next.config.ts`). Ningun path es espejo gitignored.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/sensitive-actions.ts` (nuevo) | utility (manifiesto puro) | transform | `src/lib/host-command-contract.ts` (+ `validation.ts`) | role-match |
| `src/lib/request-body.ts` (nuevo) | utility | streaming | `readCapped` de RESEARCH + `src/lib/nas.ts` (errores tipados) | partial |
| `src/lib/csp.ts` (nuevo) | utility (puro) | transform | `src/lib/host-command-contract.ts` (modulo puro) | partial |
| `src/proxy.ts` (nuevo) | middleware | request-response | ninguno en repo; RESEARCH + `node_modules/next/dist/docs/.../proxy.md` | no analog |
| `tests/verified-session.ts` (nuevo) | test helper | CRUD | `tests/api-lifecycle.test.ts:196-203` (`verify()`) | exact |
| `tests/sensitive-actions.test.ts` (nuevo) | test | request-response | `tests/api-host-commands.test.ts` | role-match |
| `tests/request-body.test.ts` (nuevo) | test | streaming | `tests/agent-client.test.ts` | role-match |
| `tests/security-headers.test.ts` (nuevo) | test | transform | `tests/security.test.ts` | role-match |
| `tests/e2e/csp.spec.ts` (nuevo) | test e2e | request-response | `tests/e2e/sensitive-action.spec.ts` + `tests/e2e/login.ts` | role-match |
| `src/lib/verification-api.ts` (mod: `guardForPolicy`, relanzar `BodyTooLarge`) | service | request-response | si mismo (`guardSensitiveAction`) | exact |
| `src/app/api/[...path]/route.ts` (mod) | route / dispatcher | request-response | si mismo | exact |
| `src/lib/host-commands.ts` (mod `runHostCommand`) | service | request-response | `src/lib/lifecycle.ts:185-225` | exact |
| `src/lib/lifecycle.ts`, `deployment-settings.ts`, `renovate-merge.ts` (mod: `readJsonBody`) | service | request-response | ellos mismos | exact |
| `src/lib/nas.ts` (mod: tope de respuesta) | service (cliente agente) | streaming | si mismo (`nasEffectForHost`) | exact |
| `next.config.ts` (mod: HSTS + CSP API) | config | request-response | si mismo (`headers()`) | exact |
| `src/components/dashboard.tsx` (mod `execute`) | component | request-response | `src/components/command-search.tsx` (usa `useSensitiveAction`) | role-match |
| `src/components/views/maintenance-extras.tsx` (mod `run`) | component | request-response | `src/components/command-search.tsx:36-52` | exact |
| `src/components/command-search.tsx` (mod: `check-health` directo) | component | request-response | `maintenance-extras.tsx` `run()` | exact |
| `src/components/views/use-host-read.ts` (mod: leer `code`/`error`) | hook | request-response | si mismo | exact |
| `src/app/layout.tsx` (mod opcional `force-dynamic`) | config | request-response | `src/app/page.tsx` (`dynamic = "force-dynamic"`) | exact |
| tests existentes `api-hosts`, `api-incidents`, `api-host-commands`, `api-lifecycle`, `agent-client`, `api-deployment-settings` (mod) | test | request-response | `api-lifecycle.test.ts` | exact |
| e2e `files-apps`, `hosts`, `maintenance-workflows` (mod: interceptar `/api/verification`) | test e2e | request-response | `tests/e2e/sensitive-action.spec.ts` | role-match |

## Pattern Assignments

### `src/lib/sensitive-actions.ts` (utility, transform)

**Analog:** `src/lib/host-command-contract.ts` (modulo sin imports de servidor, importable desde cliente) y `src/lib/validation.ts:14-34` (fuente de ids).

**Fuentes de tipos a enumerar** (`host-command-contract.ts:4-15`):
```typescript
export const hostCommandIds = [
  "deploy-now", "pause-follower", "resume-follower", "run-security",
  "backup-now", "clean-images", "check-health", "reconnect-apps",
] as const;
export type HostCommand = (typeof hostCommandIds)[number];
```
`validation.ts:14`: `export const actionSchema = z.discriminatedUnion("action", [...])`; acciones: `start|stop|restart` (enum), `update-container`, `reboot`, `move`, `trash`, `restore|purge` (enum), `empty-trash`.

**Core pattern:** copiar el esqueleto `satisfies Record<ActionId, Policy>` de RESEARCH Pattern 1. Importar solo `import type`, nunca `db`/`auth`/`next/server`. Politica por D-01..D-06 (`stop`, `restart`, `update-container`, `reboot`, `purge`, `empty-trash` y 7 comandos protegidos; `start`, `move`, `trash`, `restore`, `check-health` exentos). Anadir `routeManifest` con `methods` por ruta (incluir `GET` para `setup`/`push`) y `routeFiles` (`src/app/api/[...path]/route.ts`, `src/app/api/auth/[...all]/route.ts`).

---

### `src/lib/request-body.ts` (utility, streaming)

**Analog:** no hay lector acotado; usar el prototipo verificado de RESEARCH ("Lector de cuerpo acotado"). Seguir la convencion de errores de `src/lib/nas.ts:5-15` (clases de error tipadas):
```typescript
export class NasInvalidResponse extends Data.TaggedError("NasInvalidResponse")<{
  readonly cause: unknown;
}> {}
```
`BodyTooLarge` puede ser `class extends Error` simple (se detecta con `instanceof` en el `catch`, como `ZodError` en `route.ts:~885`).

---

### `src/app/api/[...path]/route.ts` (route, request-response)

**Analog:** el propio fichero (901 lineas). Ediciones concretas:

**Preambulo** (lineas 112-116) donde enganchar manifiesto 404/405 tras el chequeo de origen:
```typescript
const route = (await context.params).path.join("/");
const mutation = request.method !== "GET";
if (mutation && !origins.includes(request.headers.get("origin") ?? ""))
  return json({ error: "Origen no autorizado" }, 403);
```
Anadir lookup del manifiesto despues del origen y antes de `setup`.

**Lecturas de cuerpo a sustituir** por `readJsonBody(request, limit?)`: `request.json()` en `setup` (~146), `incidents/...` (~313), `presence` (~548), `action` (~576), `settings` (~783), `push` POST/DELETE (~824, ~852).

**Guard de `/api/action` a generalizar** (lineas 597-604, mantener posicion tras el replay idempotente):
```typescript
if (body.action === "reboot") {
  const denied = await guardSensitiveAction({
    request,
    session: current,
    store: verificationStore,
  });
  if (denied) return denied;
}
```
Cambiar la condicion a `actionPolicies[body.action].kind === "protected"`.

**Catch** (lineas 880-896): anadir `BodyTooLarge` -> 413 como PRIMERA rama, y `NasInvalidResponse` con `cause instanceof ResponseTooLarge` -> 502 `agent_response_too_large`, antes de `console.error("API error", ...)` (D-09: sin log):
```typescript
if (error instanceof z.ZodError)
  return json({ error: error.issues[0]?.message ?? "Datos no válidos" }, 400);
console.error("API error", error instanceof Error ? error.name : "unknown");
```
Exports (899-901): `GET`, `POST`, `DELETE` -> el manifiesto debe rechazar `DELETE` no declarado.

---

### `src/lib/host-commands.ts` `runHostCommand` (service, request-response)

**Analog:** `src/lib/lifecycle.ts:185-225` (patron guard con `store`/`now` inyectables, tras replay idempotente).

**Guard pattern** (`lifecycle.ts:212-213`):
```typescript
const denied = await guardSensitiveAction({ request, session, store, now });
if (denied) return denied;
```
`runHostCommand` hoy (`host-commands.ts:~215-232`) recibe `session: { user: { id: string } }`: ampliar a `VerificationSession` y parametros `store?`/`now?` como `lifecycle.ts`. Poner el guard entre `Idempotency-Key` y `executeHostCommand`, solo si `hostCommandPolicies[input.command].kind === "protected"`. `executeHostCommand` queda SIN guard (lo llama `renovate-merge.ts:78`).

```typescript
const input = hostCommandRequestSchema.parse(await request.json()); // -> readJsonBody
const host = resolveHost(hosts, request.nextUrl?.searchParams.get("host"));
const operationId = z.uuid().parse(request.headers.get("idempotency-key"));
```

---

### `src/lib/verification-api.ts` (service, request-response)

**Analog:** el propio fichero. `guardSensitiveAction` (lineas 92-110) devuelve `json(failure, 403)` o `null`; anadir un helper `guardForPolicy(policy, args)` que devuelva `null` si `kind === "exempt"`.

**Pitfall (lineas 63-68):** el `catch {}` genera 400 para cualquier error del parseo; relanzar `BodyTooLarge`:
```typescript
try {
  ({ password } = z.object({ password: z.string().min(1).max(128) })
    .parse(await request.json()));
} catch {
  return json({ error: "Datos no válidos" }, 400);
}
```
Cambiar a `catch (error) { if (error instanceof BodyTooLarge) throw error; ... }`.

---

### `src/lib/lifecycle.ts`, `deployment-settings.ts`, `renovate-merge.ts` (service)

Sustituir `await request.json()` por `readJsonBody(request, ...)`: `lifecycle.ts:192`, `deployment-settings.ts:98` (con `limit: 64 * 1024`, alineado con `agent/env_settings.py:29`), `renovate-merge.ts:148`. El guard existente no se toca (`deployment-settings.ts:121`, `lifecycle.ts:212`, `renovate-merge.ts:149`).

---

### `src/lib/nas.ts` (service, streaming)

**Analog:** el propio `nasEffectForHost` (lineas 44-110). Sustituir el bloque de lectura (lineas 60-63):
```typescript
const raw = yield* Effect.tryPromise({
  try: () => response.text(),
  catch: (cause) => new NasUnavailable({ cause }),
});
```
por `readCapped(response, limitFor(path, body))` con `catch: (cause) => cause instanceof ResponseTooLarge ? new NasInvalidResponse({ cause }) : new NasUnavailable({ cause })`. Anadir `export class ResponseTooLarge extends Error` junto a las clases de error (lineas 5-15). No usar `NasRejected` (cambia la semantica de "pendiente" en acciones). Topes por camino: tabla de RESEARCH (`/files` 8 MiB, `/logs` 8 MiB, `/metrics` 2 MiB, POST 256 KiB, default 1 MiB).

Los llamadores `collector.ts:384` y `deploy-progress.ts:264-266` ya tratan `NasInvalidResponse` como contrato roto: no se tocan.

---

### `next.config.ts` (config)

**Analog:** el propio fichero, `headers()` lineas 6-20:
```typescript
{
  source: "/:path*",
  headers: [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ],
},
```
Anadir `{ key: "Strict-Transport-Security", value: "max-age=15552000" }` y una entrada `source: "/api/:path*"` con `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. `headers.md` dice que la ultima gana en colision: verificar en test.

---

### `src/proxy.ts` y `src/lib/csp.ts` (middleware / utility)

**No analog en repo** (no existe `proxy.ts`/`middleware.ts`). Usar RESEARCH "`src/proxy.ts`" y la politica de Pattern 5. AGENTS.md obliga a releer `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` y `.../02-guides/content-security-policy.md` antes de escribir. `csp.ts` debe ser puro (`buildContentSecurityPolicy(nonce, isDev)`) para testearlo sin Next.

---

### `src/components/views/maintenance-extras.tsx` y `command-search.tsx` (component)

**Analog para delegar:** `command-search.tsx:36-52` (ya usa `useSensitiveAction.request`):
```typescript
sensitive.request({
  title: commandLabels[command],
  consequences: [{ tone: "warn", text: "..." }],
  confirmLabel: "Confirmar",
  endpoint: scope.withHost("/api/host-command"),
  body: { command },
  onSettled: () => window.dispatchEvent(new Event("maintenance-refresh")),
});
```
**Cambio en `maintenance-extras.tsx` `run()` (lineas 48-95):** hoy hace `fetch(withHost("/api/host-command"), {...})` directo con `Idempotency-Key: crypto.randomUUID()` y `window.confirm` para `clean-images`. Para comandos con `hostCommandPolicies[command].kind === "protected"` delegar en `useSensitiveAction` (copiar el bloque de arriba); mantener el `fetch` directo solo para `check-health`.
**Cambio en `command-search.tsx`:** `check-health` se ejecuta con el mismo `fetch` directo que `maintenance-extras.tsx`, sin `sensitive.request` (D-03/D-07).

### `src/components/dashboard.tsx` `execute()` (component)

`execute` (lineas ~481-525) hace `fetch(withHost("/api/action", operationHost.id), { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({...operation.body, ...destination}) })`. Si `actionPolicies[operation.body.action].kind === "protected"`, cerrar el `<dialog>` propio y delegar en `useSensitiveAction.request({ endpoint, body, typedConfirmation, onSettled })` (patron de `command-search.tsx`). La UI lee la tabla; no duplica la lista (D-07).

### `src/components/views/use-host-read.ts` (hook)

Linea clave: `if (!response.ok) throw new Error("No se pudo actualizar esta sección");`. Cambiar a leer `{ code, error }` del cuerpo y lanzar `new Error(body.error ?? ...)`. Ya conserva `old.data` en el `setHeld((old) => ...)` (D-11). Referencia: `container-logs.tsx` ya lee `body.error`.

---

### `tests/verified-session.ts` (test helper)

**Analog:** `tests/api-lifecycle.test.ts:196-203` (exacto):
```typescript
async function verify() {
  await db.insert(tables.recentVerification).values({
    sessionId: "test-session",
    userId: "test-user",
    method: "passkey",
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 300_000),
  });
}
```
Extraer a helper compartido. Completar tambien el mock de sesion de `api-host-commands.test.ts:21-26`, que hoy NO tiene `session.id`:
```typescript
const session = vi.hoisted(() => ({
  value: { user: { id: "test-user", name: "Test", email: "test@hub.invalid" } } as {...} | null,
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => session.value) } },
  bootstrapAuth: { api: { signUpEmail: vi.fn() } },
  origins: ["http://localhost:3000"],
}));
```
Anadir `session: { id: "test-session" }` al valor.

### `tests/sensitive-actions.test.ts` (test)

**Analog:** `tests/api-host-commands.test.ts` (BD desechable via `./database` `createTestDatabase`/`dropTestDatabase`/`testDatabaseUrl`, agente falso `createServer`, `NextRequest`, mock de `@/lib/auth`; imports lineas 1-18). Para la parte de estructura copiar el escaneo de RESEARCH ("Escaneo de literales") y la introspeccion `actionSchema.options[...].shape.action._zod.def`. Asertar por estado HTTP (403 vs no-403), filas de `operations` y peticiones al agente falso; nunca copy (CODING_STANDARD.md).

### `tests/request-body.test.ts` (test)

**Analog:** `tests/agent-client.test.ts` (unitario, `vi.stubGlobal("fetch", ...)`, `new Response(...)`, `afterEach(() => vi.unstubAllGlobals())`; lineas 1-30). Probar por separado: cabecera `content-length` fijada explicitamente (con `ReadableStream` cuyo `pull` marca una bandera) y cuerpo troceado sin cabecera. El mismo fichero (o `agent-client.test.ts`) cubre `ResponseTooLarge` -> `NasInvalidResponse`.

### `tests/security-headers.test.ts` (test)

**Analog:** `tests/security.test.ts` (unitario puro, `describe`/`it.each`/`expect`). Importar `next.config.ts` y llamar `headers()`; asertar por nombre de directiva, no por texto completo.

### `tests/e2e/csp.spec.ts` (test e2e)

**Analog:** `tests/e2e/sensitive-action.spec.ts` (setup `/api/setup` con `SETUP_TOKEN`, inicio de sesion unico por fichero, `test.describe.configure({ mode: "serial" })`) y `tests/e2e/login.ts`. Escuchar `securitypolicyviolation` y fallar ante cualquier violacion en login, panel, 404 y registro de `sw.js`.

---

## Shared Patterns

### Guard de verificacion reciente
**Source:** `src/lib/verification-api.ts:92-110` `guardSensitiveAction`, usado como en `src/lib/lifecycle.ts:212-213`
**Apply to:** `/api/action` (protegidas), `runHostCommand` (protegidos), siempre DESPUES del replay idempotente y ANTES de muestra reciente e `insert` en `operations`. Un 403 no registra la operacion (la UI reutiliza la `Idempotency-Key`, `sensitive-action.tsx` campo `idempotencyKey`).

### Respuesta JSON de error en espanol
**Source:** `route.ts` `json(...)` + `verification-api.ts:10-12`:
```typescript
const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: noStore });
```
**Apply to:** 413 (`BodyTooLarge`) y 502 `agent_response_too_large`. Mensajes en espanol; sin `console.error` en el 413 (D-09).

### Errores tipados con `Effect`
**Source:** `src/lib/nas.ts:5-15`
**Apply to:** `ResponseTooLarge` (cause de `NasInvalidResponse`).

### Dialogo de accion sensible
**Source:** `src/components/sensitive-action/sensitive-action.tsx` (`useSensitiveAction`, `isVerificationRequired`, `SensitiveActionRequest`)
**Apply to:** `dashboard.tsx`, `maintenance-extras.tsx`, `command-search.tsx` para todo lo que `sensitive-actions.ts` marque protegido.

### Tests de API con BD desechable
**Source:** `tests/api-lifecycle.test.ts` (`verify()`) y `tests/api-host-commands.test.ts` (mock de auth, agente falso, `./database`)
**Apply to:** `sensitive-actions.test.ts`, ampliaciones de `api-hosts`, `api-incidents` (lineas ~1087, 1215, 1235, 1499 con `stop`/`restart`), `api-host-commands` (siete comandos), `api-lifecycle.test.ts:428` (`update-container`).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/proxy.ts` | middleware | request-response | No existe `proxy.ts`/`middleware.ts`; usar RESEARCH y la guia instalada de Next 16.4.6 |
| `src/lib/request-body.ts` (lector en streaming) | utility | streaming | No hay lector acotado previo; usar prototipo verificado de RESEARCH |

## Metadata

**Analog search scope:** `src/lib`, `src/components`, `src/app`, `tests`, `next.config.ts`
**Files scanned:** ~150 listados, ~20 leidos (route.ts por secciones)
**Pattern extraction date:** 2026-11-27
**Notas:** `.planning/codebase/*.md` esta obsoleto; todos los numeros de linea proceden del codigo vivo. Las lineas de `route.ts` citadas de RESEARCH (146, 313, 548, 576, 783, 824, 852) no se reverificaron una a una, solo 112-150, 570-625 y 880-901.
