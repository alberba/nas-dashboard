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
import { notificationOutbox, telegramActionIntents, user } from "./schema";
import type { ActionId } from "./sensitive-actions";
import type { KeyboardView, TelegramAction } from "./telegram-keyboard";

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

/**
 * Records which keyboard the confirmed notice shows. The view lives on the
 * `:open` row because a menu change never moves the episode `seq`; the flag says
 * whether that row exists, so a notice that was never delivered stays untouched.
 */
export async function setKeyboardView(
  executor: Pick<Transaction, "update">,
  incidentId: number,
  view: KeyboardView,
): Promise<boolean> {
  const rows = await executor
    .update(notificationOutbox)
    .set({ keyboardView: view })
    .where(
      and(
        eq(notificationOutbox.key, `incident:${incidentId}:open`),
        eq(notificationOutbox.status, "sent"),
      ),
    )
    .returning({ id: notificationOutbox.id });
  return rows.length > 0;
}

/**
 * Invalidates the live intent of a notice (D-10). A single conditional `UPDATE`
 * is the whole decision: only a pending intent still in time is cancelled, so an
 * old or repeated press finds nothing and the caller answers `unchanged`.
 */
export async function cancelLiveIntent(
  executor: IntentExecutor,
  incidentId: number,
  now: number,
): Promise<IntentRow | null> {
  const [cancelled] = await executor
    .update(telegramActionIntents)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(telegramActionIntents.incidentId, incidentId),
        eq(telegramActionIntents.status, "pending"),
        gt(telegramActionIntents.expiresAt, new Date(now)),
      ),
    )
    .returning();
  return cancelled ?? null;
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
  // that commits or rolls back with the row itself (D-08). The link and the
  // menu exclude each other, so the menu view is closed.
  await setKeyboardView(tx, input.incident.id, "normal");
  await queueKeyboardEdit(tx, input.incident.id, `i${id}:open`);
  // The same transaction schedules the visible expiry (D-09): the outbox row is
  // not eligible before `expiresAt`, and its render restores the keyboard.
  await queueKeyboardEdit(tx, input.incident.id, `i${id}:expire`, {
    notBefore: expiresAt,
  });
  return { state: "created", id, expiresAt };
}

type IntentRow = typeof telegramActionIntents.$inferSelect;

/**
 * Resolves a handoff token to its intent. The lookup is by digest and the final
 * comparison is constant-time, so neither the index nor a timing difference
 * reveals how close a guess was. Any status is returned: the caller decides
 * what a lapsed or finished intent means.
 */
export async function findIntentByToken(
  executor: Pick<Transaction, "select">,
  token: string,
): Promise<IntentRow | null> {
  if (!token) return null;
  const hash = hashHandoffToken(token);
  const [intent] = await executor
    .select()
    .from(telegramActionIntents)
    .where(eq(telegramActionIntents.handoffHash, hash))
    .limit(1);
  return intent && sameHash(intent.handoffHash, hash) ? intent : null;
}

/**
 * Takes the intent for execution. One `UPDATE ... RETURNING` is the whole
 * claim: the row is pending and in time or nothing happens, so two racing
 * claims leave exactly one winner and the other gets null (SC4).
 */
export async function claimIntent(
  executor: IntentExecutor,
  id: string,
  now: number,
): Promise<IntentRow | null> {
  const [claimed] = await executor
    .update(telegramActionIntents)
    .set({ status: "executing", usedAt: new Date(now) })
    .where(
      and(
        eq(telegramActionIntents.id, id),
        eq(telegramActionIntents.status, "pending"),
        gt(telegramActionIntents.expiresAt, new Date(now)),
      ),
    )
    .returning();
  return claimed ?? null;
}

/** Closes a claimed intent with its outcome; any other state is untouched. */
export async function finishIntent(
  executor: IntentExecutor,
  id: string,
  status: Extract<IntentStatus, "executed" | "failed" | "uncertain">,
  now: number,
): Promise<IntentRow | null> {
  const [finished] = await executor
    .update(telegramActionIntents)
    .set({ status, finishedAt: new Date(now) })
    .where(
      and(
        eq(telegramActionIntents.id, id),
        eq(telegramActionIntents.status, "executing"),
      ),
    )
    .returning();
  return finished ?? null;
}

/**
 * Gives a claimed intent back when nothing was sent, for example because the
 * agent was unavailable, so the same link can be used again before it lapses.
 */
export async function releaseIntent(
  executor: IntentExecutor,
  id: string,
): Promise<IntentRow | null> {
  const [released] = await executor
    .update(telegramActionIntents)
    .set({ status: "pending", usedAt: null })
    .where(
      and(
        eq(telegramActionIntents.id, id),
        eq(telegramActionIntents.status, "executing"),
      ),
    )
    .returning();
  return released ?? null;
}
