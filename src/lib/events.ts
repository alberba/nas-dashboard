import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "./db";
import { operations } from "./schema";
import { publicHost, type HostConfig } from "./hosts";
import { nasForHost } from "./nas";
import { madridDay } from "./madrid-day";
import type { DeploymentsSnapshot } from "./deployments";
import type { MaintenanceSnapshot } from "./maintenance";
import type { HostInfo } from "./types";

export type TodayEventKind =
  | "deploy"
  | "health"
  | "retention"
  | "backup"
  | "security";

export type TodayEventStatus = "ok" | "failed" | "pending" | "info";

/**
 * One entry of Mantenimiento · Estado → «Eventos de hoy». The UI translates
 * `kind`, `status` and `reason`; free text is never part of this contract.
 */
export type TodayEvent = {
  /** Stable within one response, unique across the feed. */
  id: string;
  kind: TodayEventKind;
  /** ISO 8601 instant in UTC. */
  at: string;
  status: TodayEventStatus;
  /** Release tag when the event names one. */
  release: string | null;
  /** Host-command action recorded in `operations`. */
  action: string | null;
  /** systemd unit for a security run. */
  unit: string | null;
  /** Stable retention reason code (#23). */
  reason: string | null;
};

export type TodayEvents = {
  host: HostInfo;
  /** Europe/Madrid calendar date, as YYYY-MM-DD. */
  day: string;
  timeZone: string;
  events: TodayEvent[];
  /** Unreadable sources: `maintenance`, `deployments` or `<source>:<section>`. */
  degraded: string[];
};

/** Host commands that belong to the feed, keyed by their recorded action. */
const actionKinds: Record<string, TodayEventKind> = {
  "deploy-now": "deploy",
  "pause-follower": "deploy",
  "resume-follower": "deploy",
  "run-security": "security",
  backup: "backup",
  "backup-now": "backup",
  "run-backup": "backup",
  "check-health": "health",
  "health-check": "health",
  health: "health",
};

function operationStatus(status: string): TodayEventStatus {
  if (status === "success") return "ok";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "info";
}

function unitStatus(result: string | null, state: string): TodayEventStatus {
  if (result === "success") return "ok";
  if (result || state === "failed") return "failed";
  return "info";
}

/**
 * Builds the read-only feed for the Europe/Madrid day that contains `now`.
 * Agent snapshots are read in parallel and never retried; a lost source only
 * marks `degraded`, so the hub actions still appear.
 */
export async function eventsForHost(
  host: HostConfig,
  now = Date.now(),
): Promise<TodayEvents> {
  const day = madridDay(now);
  const [rows, maintenance, deployments] = await Promise.allSettled([
    db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.hostId, host.id),
          gte(operations.at, day.start),
          lt(operations.at, day.end),
        ),
      )
      .orderBy(desc(operations.at)),
    nasForHost<MaintenanceSnapshot>(host, "/maintenance"),
    nasForHost<DeploymentsSnapshot>(host, "/deployments?lines=1"),
  ]);
  if (rows.status === "rejected") throw rows.reason;

  const events: TodayEvent[] = [];
  const degraded: string[] = [];
  const inDay = (value: string | null) => {
    if (!value) return false;
    const at = Date.parse(value);
    return (
      Number.isFinite(at) &&
      at >= day.start.getTime() &&
      at < day.end.getTime()
    );
  };

  for (const row of rows.value) {
    const kind = actionKinds[row.action];
    if (!kind) continue;
    const at = row.at.getTime();
    if (at < day.start.getTime() || at >= day.end.getTime()) continue;
    events.push({
      id: `operation:${row.id}`,
      kind,
      at: new Date(at).toISOString(),
      status: operationStatus(row.status),
      release: null,
      action: row.action,
      unit: null,
      reason: null,
    });
  }

  if (maintenance.status === "rejected") degraded.push("maintenance");
  else {
    const snapshot = maintenance.value;
    const sections = new Set(
      Array.isArray(snapshot.degraded) ? snapshot.degraded : [],
    );
    degraded.push(...[...sections].map((section) => `maintenance:${section}`));
    if (
      !sections.has("backup") &&
      snapshot.backup &&
      inDay(snapshot.backup.at) &&
      (snapshot.backup.status === "ok" || snapshot.backup.status === "failed")
    ) {
      events.push({
        id: `backup:${Date.parse(snapshot.backup.at!)}`,
        kind: "backup",
        at: new Date(snapshot.backup.at!).toISOString(),
        status: snapshot.backup.status === "ok" ? "ok" : "failed",
        release: null,
        action: null,
        unit: null,
        reason: null,
      });
    }
    if (!sections.has("units")) {
      for (const unit of Array.isArray(snapshot.units) ? snapshot.units : []) {
        if (unit.kind !== "security" || !inDay(unit.lastRun)) continue;
        events.push({
          id: `security:${unit.name}:${Date.parse(unit.lastRun!)}`,
          kind: "security",
          at: new Date(unit.lastRun!).toISOString(),
          status: unitStatus(unit.result, unit.state),
          release: null,
          action: null,
          unit: unit.name,
          reason: null,
        });
      }
    }
  }

  if (deployments.status === "rejected") degraded.push("deployments");
  else {
    const snapshot = deployments.value;
    const sections = new Set(
      Array.isArray(snapshot.degraded) ? snapshot.degraded : [],
    );
    degraded.push(...[...sections].map((section) => `deployments:${section}`));
    if (!sections.has("follower")) {
      for (const entry of Array.isArray(snapshot.history)
        ? snapshot.history
        : []) {
        if (!inDay(entry.at)) continue;
        events.push({
          id: `deploy:${entry.release}:${Date.parse(entry.at!)}`,
          kind: "deploy",
          at: new Date(entry.at!).toISOString(),
          status: entry.outcome === "success" ? "ok" : "failed",
          release: entry.release,
          action: null,
          unit: null,
          reason: null,
        });
      }
    }
    if (
      !sections.has("follower") &&
      !sections.has("git") &&
      !sections.has("checkout")
    ) {
      for (const entry of Array.isArray(snapshot.retained)
        ? snapshot.retained
        : []) {
        if (!inDay(entry.at)) continue;
        events.push({
          id: `retention:${entry.release}:${Date.parse(entry.at!)}`,
          kind: "retention",
          at: new Date(entry.at!).toISOString(),
          status: "info",
          release: entry.release,
          action: null,
          unit: null,
          reason: entry.reason,
        });
      }
    }
  }

  events.sort(
    (left, right) =>
      Date.parse(right.at) - Date.parse(left.at) ||
      left.id.localeCompare(right.id),
  );
  return {
    host: publicHost(host),
    day: day.date,
    timeZone: day.timeZone,
    events,
    degraded: [...new Set(degraded)],
  };
}
