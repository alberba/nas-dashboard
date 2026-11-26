import { sql } from "drizzle-orm";
import {
  bigint,
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IncidentInventoryContext, Metrics, Settings } from "./types";

export const user = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});
export const session = pgTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: timestamp().notNull(),
    token: text().notNull().unique(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const account = pgTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp(),
    refreshTokenExpiresAt: timestamp(),
    scope: text(),
    password: text(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);
export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp().notNull(),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
export const passkey = pgTable(
  "passkey",
  {
    id: text().primaryKey(),
    name: text(),
    publicKey: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text().notNull().unique(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    createdAt: timestamp(),
    aaguid: text(),
  },
  (t) => [index("passkey_user_idx").on(t.userId)],
);
export const recentVerification = pgTable(
  "recent_verification",
  {
    sessionId: text()
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    method: text().notNull(),
    verifiedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("recent_verification_expires_idx").on(t.expiresAt)],
);
export const samples = pgTable(
  "samples",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    hostId: text().notNull().default("nas-home"),
    at: timestamp().notNull().defaultNow(),
    data: jsonb().$type<Metrics>().notNull(),
  },
  (t) => [
    index("samples_at_idx").on(t.at),
    index("samples_host_at_idx").on(t.hostId, t.at),
  ],
);
export const presence = pgTable("presence", {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp().notNull(),
});
export const configuration = pgTable(
  "configuration",
  {
    hostId: text().notNull().default("nas-home"),
    id: text().notNull(),
    value: jsonb().$type<Settings>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.id] })],
);
/**
 * One durable episode per watched condition. `fingerprint` identifies the
 * host/key pair across episodes; `id` identifies the episode itself. Only one
 * row per pair may stay open, enforced by a partial unique index.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    hostId: text().notNull().default("nas-home"),
    key: text().notNull(),
    title: text().notNull(),
    detail: text().notNull(),
    severity: text().notNull(),
    at: timestamp().notNull().defaultNow(),
    resolvedAt: timestamp(),
    fingerprint: text().notNull(),
    seq: integer().notNull().default(0),
    /** `legacy` marks episodes already open before the 0004 backfill (D-03). */
    origin: text().notNull().default("live"),
    /** `collector`, `lifecycle` or the synthetic `migration-dedup` closure. */
    closedBy: text(),
    /** Original `resolvedAt`, kept for the reversible migration. */
    previousResolvedAt: timestamp(),
    /**
     * Public inventory captured when a `services-down` group opened. Nullable
     * so the previous binary keeps writing and older episodes stay readable.
     */
    context: jsonb().$type<IncidentInventoryContext>(),
    /** Outage episode that currently blocks a container observation (D-02). */
    inhibitedBy: integer(),
    /** Finite cause of the observation block, separate from delivery. */
    inhibitedReason: text(),
    /** True while a container state is still unverified after an outage. */
    observationPending: boolean().notNull().default(false),
    /**
     * When the operator acknowledged the episode, by any channel. Null while
     * nobody has seen it; the `sentAt -> acknowledgedAt` span feeds D-05.
     */
    acknowledgedAt: timestamp({ withTimezone: true }),
    /** `telegram` or `hub`; null when the episode is not acknowledged. */
    acknowledgedVia: text(),
    /**
     * Internal name of the actor: the session name from the hub. Telegram runs
     * leave it null so the numeric operator id is never persisted.
     */
    acknowledgedBy: text(),
  },
  (t) => [
    index("incidents_key_idx").on(t.key),
    index("incidents_at_idx").on(t.at),
    index("incidents_host_key_idx").on(t.hostId, t.key),
    index("incidents_fingerprint_idx").on(t.fingerprint),
    index("incidents_inhibited_idx").on(t.inhibitedBy),
    uniqueIndex("incidents_open_host_key_idx")
      .on(t.hostId, t.key)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

/**
 * Temporary name kept for every reader that still imports `alerts`. It is the
 * same table object, never a second SQL table.
 */
export const alerts = incidents;

/** Immutable timeline of the significant transitions of one episode. */
export const incidentEvents = pgTable(
  "incident_events",
  {
    incidentId: integer()
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    kind: text().notNull(),
    severity: text().notNull(),
    title: text().notNull(),
    detail: text().notNull(),
    at: timestamp().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.incidentId, t.seq] }),
    index("incident_events_at_idx").on(t.at),
  ],
);

/**
 * Delivery of the initial notice and its later edits, written in the same
 * transaction as the episode. `key` is the logical idempotency key; a push
 * test may have `incidentId` null and an incident job has `ownerUserId` null.
 */
export type NotificationOutcome = {
  state: "sent" | "failed" | "suppressed" | "uncertain";
  reason: string | null;
  at: string;
};

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    key: text().notNull(),
    incidentId: integer().references(() => incidents.id, {
      onDelete: "cascade",
    }),
    ownerUserId: text().references(() => user.id, { onDelete: "cascade" }),
    /** `incident-open`, `incident-edit`, `incident-why`, `incident-push` or `push-test`. */
    kind: text().notNull(),
    /** `telegram` or `push`. */
    channel: text().notNull(),
    status: text().notNull().default("pending"),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp({ withTimezone: true }),
    claimToken: text(),
    attemptStartedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    /** Incident `seq` this row reflects; stale edits are never applied. */
    revision: integer().notNull().default(0),
    /** Chat and message confirmed by Telegram, kept for later edits. */
    chatId: text(),
    messageId: text(),
    result: jsonb().$type<NotificationOutcome>(),
    fallbackResult: jsonb().$type<NotificationOutcome>(),
    editResult: jsonb().$type<NotificationOutcome>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_outbox_key_idx").on(t.key),
    index("notification_outbox_due_idx").on(t.status, t.nextAttemptAt),
    index("notification_outbox_incident_idx").on(t.incidentId),
    index("notification_outbox_owner_idx").on(t.ownerUserId),
  ],
);

/**
 * One row per Europe/Madrid civil date: the durable daily digest queue. It is
 * the authority for that date, so `notification_outbox` keeps individual
 * deliveries only. `dueAt` freezes the recovery window (`targetAt + 2 h`) even
 * when the operator changes `DIGEST_TIME` later.
 */
export const digestRuns = pgTable(
  "digest_runs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    /** Civil date in Europe/Madrid, `YYYY-MM-DD`; unique. */
    date: text().notNull(),
    /** Instant this digest is scheduled for, resolved from `DIGEST_TIME`. */
    targetAt: timestamp({ withTimezone: true }).notNull(),
    /** Previous target: the start of the period its sections fold. */
    periodStartAt: timestamp({ withTimezone: true }).notNull(),
    /** Exclusive end of the recovery window. */
    dueAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * `prepared`, `claimed`, `sent`, `empty`, `unconfigured`, `expired`,
     * `failed` or `uncertain`. The durable attempt mark is a column, not a
     * state, so a claim before it stays safely reclaimable.
     */
    status: text().notNull().default("prepared"),
    /** Plain text frozen before the first request; never rebuilt afterwards. */
    payload: text(),
    result: jsonb().$type<NotificationOutcome>(),
    /** Finite reason of the current terminal or waiting state. */
    reason: text(),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    claimToken: text(),
    leaseUntil: timestamp({ withTimezone: true }),
    attemptStartedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    preparedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("digest_runs_date_idx").on(t.date),
    index("digest_runs_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

/**
 * Single durable pause shared by every Telegram delivery of this bot: openings,
 * edits and the daily digest. No row means no pause; push never reads it.
 */
export const telegramCooldown = pgTable("telegram_cooldown", {
  /** One row per channel; only `telegram` exists today. */
  channel: text().primaryKey(),
  until: timestamp({ withTimezone: true }).notNull(),
  reason: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * One single-use token per rendered keyboard button. Only the SHA-256 digest of
 * the `callback_data` value lives here: the token itself never persists, so a
 * database reader cannot replay a button. The token is bound to the episode,
 * the action and the chat; the message it belongs to is validated at consumption
 * against the confirmed `incident:<id>:open` outbox row.
 */
export const telegramActionTokens = pgTable(
  "telegram_action_tokens",
  {
    /** SHA-256 hex of the opaque token; primary key. */
    tokenHash: text().primaryKey(),
    incidentId: integer()
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    /**
     * Closed set of actions: `ack`, `snooze_1h`, `snooze_24h`, `unsnooze` and
     * `why`. Everything else is deduced server-side, never sent in the callback.
     */
    action: text().notNull(),
    /** Chat the keyboard was rendered for; a token from another chat is void. */
    chatId: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Set exactly once by the atomic consumption of the callback. */
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("telegram_action_tokens_incident_idx").on(t.incidentId),
    index("telegram_action_tokens_expires_idx").on(t.expiresAt),
  ],
);

/**
 * A silence lasts for a `(hostId, key)` pair, not for one episode: a flapping
 * condition or a re-escalation stays quiet until `until`, and a later event
 * after the deadline interrupts again. Removing the row is the only way to end
 * a silence early; the timeline keeps the history.
 */
export const incidentSnoozes = pgTable(
  "incident_snoozes",
  {
    hostId: text().notNull().default("nas-home"),
    key: text().notNull(),
    until: timestamp({ withTimezone: true }).notNull(),
    setAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** `telegram` or `hub`. */
    setVia: text().notNull(),
    /** Internal session name from the hub; null for Telegram. */
    setBy: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.key] })],
);

/**
 * Durable `getUpdates` offset of the single updates consumer. One row named
 * `updates`; a missing row means the lane has never polled. `lastUpdateAt`
 * decides when the sequential ids of Telegram may have reset (a week without
 * activity), so the lane omits the offset instead of trusting it.
 */
export const telegramPollState = pgTable("telegram_poll_state", {
  /** One row per consumer; only `updates` exists today. */
  name: text().primaryKey(),
  lastUpdateId: bigint({ mode: "number" }),
  lastUpdateAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export const operations = pgTable(
  "operations",
  {
    id: text().primaryKey(),
    hostId: text().notNull().default("nas-home"),
    userId: text().notNull(),
    action: text().notNull(),
    target: text().notNull(),
    status: text().notNull(),
    detail: text(),
    at: timestamp().notNull().defaultNow(),
    bootAt: timestamp(),
  },
  (t) => [index("operations_host_at_idx").on(t.hostId, t.at)],
);
export const subscriptions = pgTable("subscriptions", {
  endpoint: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  keys: jsonb().$type<{ p256dh: string; auth: string }>().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
});
