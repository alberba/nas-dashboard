import type { z } from "zod";
import type { actionSchema } from "./validation";
import type { HostCommand } from "./host-command-contract";
import type { IntentActionId } from "./telegram-intents";

/**
 * Single manifest of what needs a recent verification.
 *
 * Server and UI read the same tables: `/api/action` guards each action and the
 * dashboard decides whether to open the passkey dialog from here, so there is
 * never a second list to drift (SEC-02, D-07).
 *
 * Pure module: no `db`, no `auth`, no `next/server`. Only types cross the
 * client boundary so the browser can import it.
 *
 * `executeHostCommand` deliberately carries no guard of its own: the Renovate
 * merge calls it after its own protected check, and the decision belongs to
 * the caller. Phase 7 must only call it from a route that applies this
 * manifest.
 */

export type Policy = { kind: "protected" | "exempt"; reason: string };

export type ActionId = z.infer<typeof actionSchema>["action"];

// The literal `kind` survives so `routeManifest` can derive which routes are
// protected from its own type (a new protected route then needs a fixture).
const protectedBy = (reason: string) => ({ kind: "protected" as const, reason });
const exempt = (reason: string) => ({ kind: "exempt" as const, reason });

/** D-01, D-02 and D-04: stop, restart, update, reboot, purge and empty-trash. */
export const actionPolicies = {
  start: exempt("No pierde datos ni corta servicio"),
  stop: protectedBy("Corta el servicio"),
  restart: protectedBy("Interrumpe el servicio"),
  "update-container": protectedBy("Recrea el servicio"),
  reboot: protectedBy("Reinicia el host"),
  move: exempt("Se recupera moviendo de vuelta"),
  trash: exempt("La papelera lo conserva 7 días"),
  restore: exempt("Recupera, no destruye"),
  purge: protectedBy("Elimina de forma irreversible"),
  "empty-trash": protectedBy("Elimina de forma irreversible"),
} satisfies Record<ActionId, Policy>;

/** D-03: the seven commands that change host state; `check-health` only reads. */
export const hostCommandPolicies = {
  "deploy-now": protectedBy("Despliega y recrea servicios"),
  "pause-follower": protectedBy("Detiene el seguidor de despliegues"),
  "resume-follower": protectedBy("Reanuda el seguidor de despliegues"),
  "run-security": protectedBy("Lanza el actualizador de seguridad"),
  "backup-now": protectedBy("Inicia una copia del host"),
  "clean-images": protectedBy("Elimina imágenes del host"),
  "check-health": exempt("Solo lee el estado del host"),
  "reconnect-apps": protectedBy("Reconecta el wiring de las apps"),
} satisfies Record<HostCommand, Policy>;

function requiresVerification(policy: Policy | undefined) {
  return policy?.kind === "protected";
}

/**
 * Accepts any client value: an id outside the manifest is not protected, so a
 * malformed body reaches the schema instead of being treated as sensitive.
 */
export function requiresVerificationForAction(id: unknown): boolean {
  if (typeof id !== "string" || !Object.hasOwn(actionPolicies, id)) return false;
  return requiresVerification(actionPolicies[id as ActionId]);
}

export function requiresVerificationForCommand(id: unknown): boolean {
  if (typeof id !== "string" || !Object.hasOwn(hostCommandPolicies, id))
    return false;
  return requiresVerification(hostCommandPolicies[id as HostCommand]);
}

/**
 * Whether the hub needs a recent verification before it runs the action a
 * Telegram intent stored (D-00c). It reads the two tables above, so the intent
 * lane never keeps a second list. An id found in neither fails closed.
 */
export function requiresVerificationForIntent(action: IntentActionId): boolean {
  if (Object.hasOwn(actionPolicies, action))
    return requiresVerificationForAction(action);
  if (Object.hasOwn(hostCommandPolicies, action))
    return requiresVerificationForCommand(action);
  return true;
}

/** The verbs the catch-all route exports; anything else never reaches it. */
export type RouteMethod = "GET" | "POST" | "DELETE";

/** A verb whose policy depends on the body: it points at a per-item table. */
export type PerItemPolicy = {
  kind: "per-item";
  policies: Record<string, Policy>;
};

const perItem = (policies: Record<string, Policy>): PerItemPolicy => ({
  kind: "per-item",
  policies,
});

/** `GET` only ever reads; every mutation verb carries a policy. */
type RouteEntry = {
  GET?: "read";
  POST?: Policy | PerItemPolicy;
  DELETE?: Policy | PerItemPolicy;
};

/**
 * Every route the catch-all serves by exact name, with the verbs it accepts and
 * a policy for each mutation (SEC-02, D-06). `routeVerdict` consults it before
 * any handler runs, so a route or verb missing here answers 404 or 405 instead
 * of reaching code nobody declared a policy for.
 *
 * Phase 7: a new route or verb goes here first, and a protected `POST` needs a
 * fixture in `tests/sensitive-actions.test.ts`.
 */
export const routeManifest = {
  setup: {
    GET: "read",
    POST: exempt(
      "Alta inicial protegida por SETUP_TOKEN, cuenta cero y bloqueo advisory",
    ),
  },
  verification: { GET: "read" },
  "verification/password": {
    POST: exempt("Es la propia verificación y exige sesión"),
  },
  "containers/remove": { POST: protectedBy("Elimina el contenedor") },
  hosts: { GET: "read" },
  maintenance: { GET: "read" },
  "host-command": { POST: perItem(hostCommandPolicies) },
  "telegram/intents/execute": {
    POST: perItem({ ...actionPolicies, ...hostCommandPolicies }),
  },
  deployments: { GET: "read" },
  events: { GET: "read" },
  "deployments/settings": {
    POST: protectedBy("Cambia el despliegue automático del host"),
  },
  renovate: { GET: "read" },
  "renovate/merge": {
    POST: protectedBy("Fusiona un cambio que luego se despliega"),
  },
  "renovate/progress": { GET: "read" },
  overview: { GET: "read" },
  "container-history": { GET: "read" },
  presence: { POST: exempt("Latido de la pestaña visible, no actúa sobre nada") },
  action: { POST: perItem(actionPolicies) },
  files: { GET: "read" },
  trash: { GET: "read" },
  logs: { GET: "read" },
  settings: {
    GET: "read",
    POST: exempt("Umbrales de aviso, no actúan sobre los servicios"),
  },
  push: {
    GET: "read",
    POST: exempt("Suscripción del propio navegador"),
    DELETE: exempt("Baja de la propia suscripción"),
  },
  "push/test": {
    POST: exempt("Encola una prueba de aviso al propietario"),
  },
} satisfies Record<string, RouteEntry>;

export type RouteName = keyof typeof routeManifest;

/** Routes whose `POST` is protected as a whole; each needs a typed fixture. */
export type ProtectedPostRoute = {
  [K in RouteName]: (typeof routeManifest)[K] extends {
    POST: { kind: "protected" };
  }
    ? K
    : never;
}[RouteName];

/** Detail of one incident: a read. */
export const incidentDetailPattern = /^incidents\/([^/]+)$/;
/** Acknowledge, snooze and unsnooze of one incident. */
export const incidentActionPattern =
  /^incidents\/([^/]+)\/(acknowledge|snooze|unsnooze)$/;

/** The routes the catch-all matches by regular expression instead of by name. */
export const patternRoutes = [
  { pattern: incidentDetailPattern, entry: { GET: "read" } },
  {
    pattern: incidentActionPattern,
    entry: {
      POST: exempt("Reconocer o silenciar no cambia el host (D-05)"),
    },
  },
] satisfies { pattern: RegExp; entry: RouteEntry }[];

export type RouteVerdict =
  | { verdict: "ok" }
  | { verdict: "not_found" }
  | { verdict: "method_not_allowed"; allow: RouteMethod[] };

const routeMethods: RouteMethod[] = ["GET", "POST", "DELETE"];

function declaredMethods(entry: RouteEntry): RouteMethod[] {
  return routeMethods.filter((method) => Object.hasOwn(entry, method));
}

/**
 * Pure decision on a route and verb pair. It compares the exact route name:
 * no case folding and no segment trimming, so `ACTION` and `action/extra`
 * match nothing. Inherited object keys (`constructor`) are not routes.
 */
export function routeVerdict(route: string, method: string): RouteVerdict {
  const entry: RouteEntry | undefined = Object.hasOwn(routeManifest, route)
    ? routeManifest[route as RouteName]
    : patternRoutes.find((candidate) => candidate.pattern.test(route))?.entry;
  if (!entry) return { verdict: "not_found" };
  const allow = declaredMethods(entry);
  if ((allow as string[]).includes(method)) return { verdict: "ok" };
  return { verdict: "method_not_allowed", allow };
}

/**
 * Every `route.ts` under `src/app/api` and how it dispatches. A new route file
 * must be declared here, or the scan in `tests/sensitive-actions.test.ts`
 * fails. The catch-all is governed by `routeManifest`; a delegated route says
 * who owns its policy.
 */
export const routeFiles = {
  "src/app/api/[...path]/route.ts": { dispatch: "catch-all" },
  "src/app/api/auth/[...all]/route.ts": {
    dispatch: "better-auth",
    policy: exempt(
      "Better Auth valida credenciales y limita intentos; el cuerpo se acota en su envoltorio de 32 KiB",
    ),
  },
} satisfies Record<
  string,
  { dispatch: "catch-all" } | { dispatch: "better-auth"; policy: Policy }
>;
