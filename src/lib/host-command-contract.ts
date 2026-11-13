import { z } from "zod";

/** Closed whitelist shared with the agent's host_commands.py. */
export const hostCommandIds = [
  "deploy-now",
  "pause-follower",
  "resume-follower",
  "run-security",
] as const;

export type HostCommand = (typeof hostCommandIds)[number];

export const hostCommandRequestSchema = z.strictObject({
  command: z.enum(hostCommandIds),
});

export type HostCommandResult = {
  command: HostCommand;
  status: "success";
};
