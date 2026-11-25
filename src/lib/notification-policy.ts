import type { IncidentDeliveryChannel } from "./incident-store";
import type { AlertSeverity } from "./maintenance-alerts";

/** Finite reason persisted when a first notice is not sent immediately. */
export type NotificationReason =
  | "policy_immediate"
  | "digest_pending"
  | "policy_silent";

export type NotificationPolicy = {
  channel: IncidentDeliveryChannel;
  reason: NotificationReason;
  /** True when phase 4's daily digest should list this open episode. */
  digest: boolean;
  /** True when the first notice does not wait for the digest. */
  immediate: boolean;
};

/**
 * Audited catalog from phase 1 (`01-AUDIT.md`): hub keys that interrupt
 * immediately, keys that belong to the daily digest and the silent container
 * family. Anything else is not audited yet and stays in the digest rather than
 * interrupting the operator.
 */
const CRITICAL_IMMEDIATE_KEYS = new Set([
  "connection",
  "temperature",
  "backup-failed",
  "stack-unit-failed",
  "deploy-failed",
]);

const DIGEST_KEYS = new Set([
  "cpu",
  "memory",
  "disk",
  "reboot-pending",
  "release-retained",
]);

const SILENT_PREFIX = "container:";

/** `PUSH_WARNINGS` opt-in, false unless the operator explicitly enables it. */
export function pushWarningsEnabled(value = process.env.PUSH_WARNINGS): boolean {
  if (value === undefined) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function digestNotice(
  severity: AlertSeverity,
  pushWarnings: boolean,
): NotificationPolicy {
  // Push replaces the digest only for eligible warnings. A critical key that
  // happens to be in the digest catalog keeps its digest destination.
  if (severity === "warning" && pushWarnings)
    return {
      channel: "push",
      reason: "policy_immediate",
      digest: true,
      immediate: true,
    };
  return {
    channel: "digest",
    reason: "digest_pending",
    digest: true,
    immediate: false,
  };
}

export function notificationPolicy(
  key: string,
  severity: AlertSeverity,
  options: { pushWarnings?: boolean } = {},
): NotificationPolicy {
  const pushWarnings = options.pushWarnings ?? pushWarningsEnabled();
  if (key.startsWith(SILENT_PREFIX))
    return {
      channel: "silent",
      reason: "policy_silent",
      digest: false,
      immediate: false,
    };
  if (key === "helper-cleanup")
    // D-11: phase 4 wants this condition in the daily digest. It must not turn
    // into a push when PUSH_WARNINGS is enabled, so the branch is explicit.
    return {
      channel: "digest",
      reason: "digest_pending",
      digest: true,
      immediate: false,
    };
  if (key === "disk-health") {
    if (severity === "critical")
      return {
        channel: "telegram",
        reason: "policy_immediate",
        digest: false,
        immediate: true,
      };
    return digestNotice(severity, pushWarnings);
  }
  if (CRITICAL_IMMEDIATE_KEYS.has(key))
    return {
      channel: "telegram",
      reason: "policy_immediate",
      digest: false,
      immediate: true,
    };
  if (DIGEST_KEYS.has(key)) return digestNotice(severity, pushWarnings);
  // Not audited yet: keep it visible in the digest instead of interrupting.
  return digestNotice(severity, pushWarnings);
}
