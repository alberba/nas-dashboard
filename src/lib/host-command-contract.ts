import { z } from "zod";

/** Closed whitelist shared with the agent's host_commands.py. */
export const hostCommandIds = [
  "deploy-now",
  "pause-follower",
  "resume-follower",
  "run-security",
  "backup-now",
  "clean-images",
  "check-health",
  "reconnect-apps",
] as const;

export type HostCommand = (typeof hostCommandIds)[number];

export const hostCommandRequestSchema = z.strictObject({
  command: z.enum(hostCommandIds),
});

const unitCommandIds = [
  "deploy-now",
  "pause-follower",
  "resume-follower",
  "run-security",
] as const;

export const hostCommandResultSchema = z.discriminatedUnion("command", [
  z.object({
    command: z.enum(unitCommandIds),
    status: z.literal("success"),
  }),
  z.object({
    command: z.literal("backup-now"),
    status: z.literal("success"),
    backup: z.object({
      started: z.boolean(),
      lastStatus: z.object({
        status: z.enum(["ok", "failed", "unknown"]),
        at: z.string().nullable(),
      }),
    }),
  }),
  z.object({
    command: z.literal("clean-images"),
    status: z.literal("success"),
    cleanup: z.object({
      reclaimedBytes: z.number().int().nonnegative(),
      imagesRemoved: z.number().int().nonnegative(),
      imagesPreserved: z.number().int().nonnegative(),
      imagesFailed: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    command: z.literal("check-health"),
    status: z.literal("success"),
    health: z.object({
      vpn: z.object({
        applicable: z.boolean(),
        connected: z.boolean().nullable(),
        state: z.string().nullable(),
        health: z.string().nullable(),
      }),
      apps: z.array(
        z.object({
          name: z.string().nullable(),
          service: z.string().nullable(),
          state: z.string().nullable(),
          health: z.string().nullable(),
          healthy: z.boolean(),
        }),
      ),
      healthy: z.boolean(),
    }),
  }),
  z.object({
    command: z.literal("reconnect-apps"),
    status: z.literal("success"),
    wiring: z.object({ started: z.boolean() }),
  }),
]);

export type HostCommandResult = z.infer<typeof hostCommandResultSchema>;
