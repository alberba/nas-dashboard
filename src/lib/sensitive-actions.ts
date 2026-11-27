import type { z } from "zod";
import type { actionSchema } from "./validation";
import type { HostCommand } from "./host-command-contract";

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

const protectedBy = (reason: string): Policy => ({ kind: "protected", reason });
const exempt = (reason: string): Policy => ({ kind: "exempt", reason });

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
