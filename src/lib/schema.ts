import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { Metrics, Settings } from "./types";

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
export const alerts = pgTable(
  "alerts",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    hostId: text().notNull().default("nas-home"),
    key: text().notNull(),
    title: text().notNull(),
    detail: text().notNull(),
    severity: text().notNull(),
    at: timestamp().notNull().defaultNow(),
    resolvedAt: timestamp(),
  },
  (t) => [
    index("alerts_key_idx").on(t.key),
    index("alerts_at_idx").on(t.at),
    index("alerts_host_key_idx").on(t.hostId, t.key),
  ],
);
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
