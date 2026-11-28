import { WORKER_ROLLUP_MS } from "./history-rollups";
import { CollectionLockLost } from "./notification-dispatch";
import type { UpdatesOutcome } from "./telegram-updates";
import type { WorkerHealth } from "./worker-health";

/**
 * Worker loop milestones.
 *
 * The health mark may only move when the loop that owns the collection lock
 * completes real work: a query, a collection, one delivery opportunity or a
 * full idle check. A repeated error that makes no progress must not extend it,
 * and neither must a timer or a probe of the process itself.
 */

export const WORKER_DRAIN_TURNS = 20;
export const WORKER_CLEANUP_MS = 3_600_000;
export const WORKER_IDLE_MS = 1_000;
/**
 * Longest Telegram poll of one turn. A long poll past this would delay the
 * collection that a visible tab expects every 5 s; 3 s is the compromise.
 */
export const WORKER_UPDATES_MAX_WAIT_SECONDS = 3;

export type WorkerDrainDeps = {
  health: WorkerHealth;
  runDispatch: () => Promise<{ action: string }>;
  runDigest: () => Promise<{ action: string }>;
  stopping: () => boolean;
  maxTurns?: number;
};

/**
 * Drains a bounded batch so delivery never starves collection. Every completed
 * lane renews the mark: with a 10 s provider timeout, one renewal per batch
 * would be too old. Once both lanes answer idle the turn ends.
 */
export async function drainWorker(deps: WorkerDrainDeps): Promise<void> {
  const turns = deps.maxTurns ?? WORKER_DRAIN_TURNS;
  for (let index = 0; index < turns && !deps.stopping(); index += 1) {
    const dispatched = await deps.runDispatch();
    await deps.health.renew();
    const digest = await deps.runDigest();
    await deps.health.renew();
    if (dispatched.action === "idle" && digest.action === "idle") return;
  }
}

export type WorkerTurnDeps = {
  health: WorkerHealth;
  holdsLock: () => Promise<boolean>;
  stopping: () => boolean;
  now: () => number;
  presenceActive: () => Promise<boolean>;
  sampleInterval: (active: boolean) => number;
  collect: () => Promise<void>;
  drain: () => Promise<void>;
  cleanup: () => Promise<void>;
  /**
   * Optional history rollup lane (PERF-01): aggregates the recent hours of
   * samples every `WORKER_ROLLUP_MS`.
   */
  rollups?: () => Promise<void>;
  /** Optional Telegram updates lane: the long poll replaces the idle pause. */
  updates?: (budget: { waitSeconds: number }) => Promise<UpdatesOutcome>;
  /** `lastRollup` is optional so a harness that predates the lane still fits. */
  state: { lastCollection: number; lastCleanup: number; lastRollup?: number };
};

/**
 * Seconds the updates lane may wait without delaying the next collection.
 * A zero means short polling: the collection is due right now.
 */
export function updatesWaitSeconds(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return WORKER_UPDATES_MAX_WAIT_SECONDS;
  return Math.min(
    Math.max(Math.ceil(remainingMs / 1000), 0),
    WORKER_UPDATES_MAX_WAIT_SECONDS,
  );
}

/**
 * One turn of the loop that owns the collection lock. It renews the mark only
 * after a milestone completes; an error propagates before any later renewal,
 * so a failing loop stops looking healthy when its last real progress ages.
 */
export async function workerTurn(deps: WorkerTurnDeps): Promise<void> {
  if (deps.stopping()) return;
  if (!(await deps.holdsLock())) throw new CollectionLockLost();
  const active = await deps.presenceActive();
  await deps.health.renew();

  if (deps.now() - deps.state.lastCollection >= deps.sampleInterval(active)) {
    deps.state.lastCollection = deps.now();
    await deps.collect();
    await deps.health.renew();
  }

  await deps.drain();
  await deps.health.renew();

  if (deps.now() - deps.state.lastCleanup > WORKER_CLEANUP_MS) {
    await deps.cleanup();
    deps.state.lastCleanup = deps.now();
    await deps.health.renew();
  }

  if (
    deps.rollups &&
    deps.now() - (deps.state.lastRollup ?? 0) >= WORKER_ROLLUP_MS
  ) {
    // Marked before the run, like the collection: a failing aggregation is
    // retried on the next period, not on every one-second turn.
    deps.state.lastRollup = deps.now();
    await deps.rollups();
    await deps.health.renew();
  }

  if (deps.updates) {
    const untilNextCollection =
      deps.state.lastCollection + deps.sampleInterval(active) - deps.now();
    const outcome = await deps.updates({
      waitSeconds: updatesWaitSeconds(untilNextCollection),
    });
    // A failed poll is no progress: it must not extend the health mark.
    if (outcome.ok) await deps.health.renew();
  }
}
