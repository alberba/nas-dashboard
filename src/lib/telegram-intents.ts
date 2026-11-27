/**
 * Lifecycle authority of a Telegram action intent.
 *
 * Pressing a host action in the notice never runs anything (D-00a): the lane
 * records an intention, edits the notice with a five-minute link to the hub and
 * stops. The hub confirms with a session and a passkey; only then does an
 * executor run. This module owns every transition of that row so the bot, the
 * worker and the hub cannot disagree on what a live intent is.
 *
 * The handoff token is derived, never stored: the worker recomputes it from the
 * intent id and a subkey of `BETTER_AUTH_SECRET` when it renders the button, and
 * the database only keeps its SHA-256 (D-00b). Rotating the secret therefore
 * only voids intents younger than five minutes.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { incidentHref } from "../components/views/routes";
import type { HostCommand } from "./host-command-contract";
import { queueKeyboardEdit, type Transaction } from "./incident-store";
import { telegramActionIntents, user } from "./schema";
import type { ActionId } from "./sensitive-actions";
import type { TelegramAction } from "./telegram-keyboard";

/** A handoff link works for five minutes (D-00b). */
export const HANDOFF_TTL_MS = 5 * 60_000;

/**
 * Actions the chat may register. The `satisfies` clause keeps the list honest:
 * it compiles only while every id exists in the sensitive-action manifest.
 * Updating an image, stopping and removing are deliberately absent (D-01).
 */
export const intentActionIds = [
  "start",
  "restart",
  "reboot",
  "backup-now",
  "deploy-now",
] as const satisfies readonly (ActionId | HostCommand)[];

export type IntentActionId = (typeof intentActionIds)[number];

export const INTENT_STATUSES = [
  "pending",
  "executing",
  "executed",
  "failed",
  "uncertain",
  "expired",
  "cancelled",
] as const;

export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** The one source of each verb: the button label and the confirmation text. */
export const INTENT_VERBS: Record<IntentActionId, string> = {
  start: "Arrancar",
  restart: "Reiniciar",
  reboot: "Reiniciar host",
  "backup-now": "Copia ahora",
  "deploy-now": "Desplegar ahora",
};

const CONTAINER_PREFIX = "container:";

/**
 * What a notice offers, by its durable key (D-01 to D-03): a container may be
 * started or restarted, and three maintenance conditions offer their own fix.
 * Everything else, the outage included, offers nothing.
 */
export function hostActionsFor(key: string): IntentActionId[] {
  if (key.startsWith(CONTAINER_PREFIX) && key.length > CONTAINER_PREFIX.length)
    return ["start", "restart"];
  if (key === "backup-failed") return ["backup-now"];
  if (key === "deploy-failed") return ["deploy-now"];
  if (key === "reboot-pending") return ["reboot"];
  return [];
}

/** Closed correspondence between the keyboard button and the intent action. */
const TOKEN_ACTIONS = {
  act_start: "start",
  act_restart: "restart",
  act_reboot: "reboot",
  act_backup_now: "backup-now",
  act_deploy_now: "deploy-now",
} as const satisfies Record<string, IntentActionId>;

export type IntentTokenAction = keyof typeof TOKEN_ACTIONS;

export function tokenActionOf(action: IntentActionId): IntentTokenAction {
  const found = (Object.keys(TOKEN_ACTIONS) as IntentTokenAction[]).find(
    (token) => TOKEN_ACTIONS[token] === action,
  );
  // The map is closed over `IntentActionId`, so every action has a button.
  return found as IntentTokenAction;
}

export function intentActionOfToken(
  action: TelegramAction,
): IntentActionId | null {
  return Object.hasOwn(TOKEN_ACTIONS, action)
    ? TOKEN_ACTIONS[action as IntentTokenAction]
    : null;
}

function handoffKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("hub:telegram-handoff:v1").digest();
}

/** 43 base64url characters: the HMAC-SHA256 of the intent id, recomputable. */
export function handoffToken(secret: string, intentId: string): string {
  return createHmac("sha256", handoffKey(secret))
    .update(intentId)
    .digest("base64url");
}

/** The digest that lives in the database; the token itself never persists. */
export function hashHandoffToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two digests of any length. */
export function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Minimal executor both the pool and a transaction satisfy. */
export type IntentExecutor = Pick<Transaction, "select" | "insert" | "update">;

/**
 * The single user of the instance, or null when there are none or several: an
 * intent is bound to a person, so an ambiguous instance fails closed (P-04).
 */
export async function soleOperatorId(
  executor: Pick<Transaction, "select">,
): Promise<string | null> {
  const rows = await executor.select({ id: user.id }).from(user).limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * The link the notice button opens: the incident view of the hub with the token
 * in the fragment, which the browser never sends to the server or to a proxy
 * log. `incidentHref` already validates the base URL and the host.
 */
export function handoffHref(
  base: string,
  hostId: string,
  incidentId: number,
  token: string,
): string {
  const url = new URL(incidentHref(base, hostId, incidentId));
  url.hash = `intent=${token}`;
  return url.toString();
}

/** The pending intent of a notice that has not yet expired, if any. */
export async function liveIntentOf(
  executor: Pick<Transaction, "select">,
  incidentId: number,
  now: number,
): Promise<typeof telegramActionIntents.$inferSelect | null> {
  const [intent] = await executor
    .select()
    .from(telegramActionIntents)
    .where(
      and(
        eq(telegramActionIntents.incidentId, incidentId),
        eq(telegramActionIntents.status, "pending"),
        gt(telegramActionIntents.expiresAt, new Date(now)),
      ),
    )
    .limit(1);
  return intent ?? null;
}

/** Container actions target the container; the rest target the host. */
function targetOf(key: string, hostId: string): string {
  return key.startsWith(CONTAINER_PREFIX)
    ? key.slice(CONTAINER_PREFIX.length)
    : hostId;
}

/**
 * Marks as expired the pending intents of a notice whose time is up. The partial
 * unique index cannot see the clock, so a lapsed row would otherwise keep
 * blocking the next intent of the same notice.
 */
export async function expireDueIntents(
  executor: IntentExecutor,
  incidentId: number,
  now: number,
): Promise<number> {
  const rows = await executor
    .update(telegramActionIntents)
    .set({ status: "expired" })
    .where(
      and(
        eq(telegramActionIntents.incidentId, incidentId),
        eq(telegramActionIntents.status, "pending"),
        lte(telegramActionIntents.expiresAt, new Date(now)),
      ),
    )
    .returning({ id: telegramActionIntents.id });
  return rows.length;
}

export type CreateIntentResult =
  | { state: "created"; id: string; expiresAt: Date }
  | { state: "live" }
  | { state: "ignored" };

/**
 * Registers the intention inside the caller's transaction. `live` means the
 * notice already has a pending intent (D-10); `ignored` means there is no single
 * operator to bind it to. It never calls the agent and never writes an
 * operation.
 */
export async function createIntent(
  tx: Transaction,
  input: {
    incident: { id: number; hostId: string; key: string };
    action: IntentActionId;
    secret: string;
    now: number;
  },
): Promise<CreateIntentResult> {
  await expireDueIntents(tx, input.incident.id, input.now);
  const userId = await soleOperatorId(tx);
  if (!userId) return { state: "ignored" };

  const id = randomUUID();
  const expiresAt = new Date(input.now + HANDOFF_TTL_MS);
  const [created] = await tx
    .insert(telegramActionIntents)
    .values({
      id,
      incidentId: input.incident.id,
      hostId: input.incident.hostId,
      action: input.action,
      target: targetOf(input.incident.key, input.incident.hostId),
      userId,
      handoffHash: hashHandoffToken(handoffToken(input.secret, id)),
      status: "pending",
      createdAt: new Date(input.now),
      expiresAt,
    })
    // The partial unique index is the arbiter: a live intent keeps the notice.
    .onConflictDoNothing()
    .returning({ id: telegramActionIntents.id });
  if (!created) return { state: "live" };
  // The notice learns about the intent through a silent, keyboard-only edit
  // that commits or rolls back with the row itself (D-08).
  await queueKeyboardEdit(tx, input.incident.id, `i${id}:open`);
  return { state: "created", id, expiresAt };
}
