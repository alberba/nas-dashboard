import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { db } from "./db";
import * as schema from "./schema";

export const origins = (
  process.env.TRUSTED_ORIGINS ??
  process.env.BETTER_AUTH_URL ??
  "http://localhost:3000"
).split(",");
const config = {
  appName: "hub.",
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL:
    origins.length > 1
      ? {
          allowedHosts: origins.map((value) => new URL(value).host),
          fallback: process.env.BETTER_AUTH_URL,
          protocol: "https" as const,
        }
      : (process.env.BETTER_AUTH_URL ?? "http://localhost:3000"),
  trustedOrigins: origins,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    revokeSessionsOnPasswordReset: true,
  },
  plugins: [
    passkey({
      rpName: "hub.",
      rpID: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
        .hostname,
      origin: origins,
    }),
  ],
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 },
};
// One web replica: the built-in in-memory rate limiter covers authentication endpoints.
export const auth = betterAuth({ ...config, rateLimit: { enabled: true } });
export const bootstrapAuth = betterAuth({
  ...config,
  emailAndPassword: { ...config.emailAndPassword, disableSignUp: false },
  rateLimit: { enabled: true },
});
