import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { subscriptions } from "./schema";
import type { VapidConfig } from "./runtime-config";

/**
 * Explicit outcome of one push delivery. Acceptance is a commitment of the
 * episode channel even when other endpoints failed; an error whose outcome is
 * unknown is never reported as a confirmed failure.
 */
export type PushOutcome =
  | { state: "accepted"; delivered: number }
  | { state: "failed"; reason: string }
  | { state: "uncertain"; reason: string }
  | { state: "no_subscriptions" }
  | { state: "suppressed"; reason: "push_disabled" };

export type PushPayload = {
  title: string;
  body: string;
  /** Stable per-episode tag (`hub:incident:<host>:<id>`). */
  tag: string;
  /** Internal hub path; the service worker validates it before opening. */
  url: string;
  /** Episode revision, kept in the payload for local refreshes. */
  seq?: number;
};

type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushTransport = (
  subscription: PushSubscription,
  body: string,
  options: { TTL: number; timeout: number },
) => Promise<unknown>;

export type PushOptions = {
  /** Restricts a worker test to the subscriptions of its owner. */
  ownerUserId?: string;
  /** `undefined` reads the environment, `null` means the channel is off. */
  vapid?: VapidConfig | null;
  subject?: string;
  transport?: PushTransport;
};

const PUSH_TTL_SECONDS = 3600;
const PUSH_TIMEOUT_MS = 10_000;
const MAX_TITLE = 200;
const MAX_BODY = 1200;

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function envVapid(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

function statusCode(error: unknown): number | null {
  let value: unknown;
  if (error instanceof webpush.WebPushError) value = error.statusCode;
  else if (error && typeof error === "object" && "statusCode" in error)
    value = (error as { statusCode?: unknown }).statusCode;
  // 0 or a missing code is not a confirmed rejection: it stays uncertain.
  return typeof value === "number" && value >= 400 ? value : null;
}

/**
 * Provider responses that may succeed on a later attempt. They are recorded as
 * uncertain (never retried, per D-01) instead of a permanent rejection.
 */
function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function removeSubscription(endpoint: string): Promise<void> {
  await db.delete(subscriptions).where(eq(subscriptions.endpoint, endpoint));
}

/**
 * Sends one notification to every eligible subscription. It preserves the
 * 404/410 cleanup and never throws: callers persist the explicit outcome.
 */
export async function deliverPush(
  payload: PushPayload,
  options: PushOptions = {},
): Promise<PushOutcome> {
  const vapid = options.vapid === undefined ? envVapid() : options.vapid;
  if (!vapid) return { state: "suppressed", reason: "push_disabled" };

  const entries = options.ownerUserId
    ? await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, options.ownerUserId))
    : await db.select().from(subscriptions);
  if (entries.length === 0) return { state: "no_subscriptions" };

  const body = JSON.stringify({
    title: bounded(payload.title, MAX_TITLE),
    body: bounded(payload.body, MAX_BODY),
    tag: payload.tag,
    url: payload.url,
    ...(payload.seq !== undefined ? { seq: payload.seq } : {}),
  });
  const transport: PushTransport =
    options.transport ??
    (async (subscription, message, sendOptions) => {
      webpush.setVapidDetails(
        options.subject ?? process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
        vapid.publicKey,
        vapid.privateKey,
      );
      return webpush.sendNotification(subscription, message, sendOptions);
    });

  let accepted = 0;
  let rejected = 0;
  let uncertain = 0;
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await transport(
          { endpoint: entry.endpoint, keys: entry.keys },
          body,
          { TTL: PUSH_TTL_SECONDS, timeout: PUSH_TIMEOUT_MS },
        );
        accepted += 1;
      } catch (error) {
        const status = statusCode(error);
        if (status !== null && [404, 410].includes(status)) {
          await removeSubscription(entry.endpoint).catch(() => {});
          rejected += 1;
          return;
        }
        // Rate limiting, request timeouts and provider failures are transient:
        // the attempt is uncertain, never a permanent rejection (D-01).
        if (status !== null && !transientStatus(status)) {
          rejected += 1;
          return;
        }
        uncertain += 1;
      }
    }),
  );

  // Acceptance anywhere commits the channel, even if another endpoint failed.
  if (accepted > 0) return { state: "accepted", delivered: accepted };
  if (uncertain > 0)
    return { state: "uncertain", reason: "endpoint_uncertain" };
  if (rejected > 0) return { state: "failed", reason: "endpoint_rejected" };
  return { state: "no_subscriptions" };
}
