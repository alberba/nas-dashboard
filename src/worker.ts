import type { PoolClient } from "pg";
import { gt, lt } from "drizzle-orm";
import { db, pool } from "./lib/db";
import { operations, presence, samples } from "./lib/schema";
import { readRuntimeConfig, RuntimeConfigError } from "./lib/runtime-config";
import { collectAll } from "./lib/collector";
import { cleanupExpiredIncidents } from "./lib/incident-store";
import {
  acquireCollectionLock,
  CollectionLockLost,
  holdsCollectionLock,
  releaseCollectionLock,
  runDispatchOnce,
} from "./lib/notification-dispatch";
import { runDigestOnce, publicDigestReason, type DigestTransition } from "./lib/digest-runs";
import { sampleInterval } from "./lib/validation";
import { WorkerHealth } from "./lib/worker-health";
import {
  WORKER_IDLE_MS,
  drainWorker,
  workerTurn,
} from "./lib/worker-loop";

const digestTransitionLabels: Record<DigestTransition["status"], string> = {
  expired: "vencido",
  failed: "fallo",
  uncertain: "incierto",
};

/**
 * One bounded line per durable terminal transition. It names only the civil
 * date and the finite reason: the payload, the chat, the bot token and any
 * provider body stay out of the log.
 */
function logDigestTransition(event: DigestTransition) {
  const reason = publicDigestReason(event.reason) ?? "unknown";
  console.log(
    `Resumen diario ${event.date}: ${digestTransitionLabels[event.status]} (${reason})`,
  );
}

let lastCollection = 0;
let lastCleanup = 0;
let stopping = false;
let lockLost = false;
let health: WorkerHealth | null = null;
const shutdown = new AbortController();

function stop() {
  stopping = true;
  // The shutdown and a lost lock must never leave a healthy mark behind.
  health?.closeSync();
  shutdown.abort();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

/** Responsive sleep: shutdown or a lost lock session releases the loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      shutdown.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (shutdown.signal.aborted) done();
    else shutdown.signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Drains a bounded batch so delivery never starves collection. Every turn
 * dispatches at most one individual job and then offers the daily digest one
 * opportunity: a long batch can never hide the moment its window closes. Each
 * completed lane renews the health mark.
 */
async function drain(
  config: ReturnType<typeof readRuntimeConfig>,
  lock: PoolClient,
  workerHealth: WorkerHealth,
) {
  await drainWorker({
    health: workerHealth,
    stopping: () => stopping,
    runDispatch: () =>
      runDispatchOnce({
        client: lock,
        config,
        signal: shutdown.signal,
      }),
    runDigest: () =>
      runDigestOnce({
        client: lock,
        config,
        signal: shutdown.signal,
        onTransition: logDigestTransition,
      }),
  });
}

async function main() {
  // Validate the whole environment before the pool is used: a worker with an
  // unusable configuration must never take the collection lock or query the
  // database.
  const config = readRuntimeConfig();
  const hosts = config.hosts;
  const lock = await pool.connect();
  health = new WorkerHealth({
    holdsLock: () => holdsCollectionLock(lock),
    log: (line) => console.error(line),
  });
  // A mark left by a previous process in the same tmpfs never means health.
  health.invalidateSync();
  // Any error or normal end of the dedicated session means the advisory lock
  // is gone: stop claiming, abort in-flight work and let a new owner recover.
  lock.on("error", () => {
    lockLost = true;
    stop();
  });
  lock.on("end", () => {
    lockLost = true;
    stop();
  });

  try {
    if (!(await acquireCollectionLock(lock)))
      throw new Error("Ya hay un recolector activo");
    console.log(
      `Recolector iniciado para ${hosts.map((host) => host.name).join(", ")}`,
    );
    const state = { lastCollection, lastCleanup };
    while (!stopping) {
      try {
        await workerTurn({
          health,
          holdsLock: () =>
            lockLost ? Promise.resolve(false) : holdsCollectionLock(lock),
          stopping: () => stopping,
          now: () => Date.now(),
          presenceActive: async () => {
            const [active] = await db
              .select({ id: presence.id })
              .from(presence)
              .where(gt(presence.expiresAt, new Date()))
              .limit(1);
            return Boolean(active);
          },
          sampleInterval,
          collect: () => collectAll(hosts),
          drain: () => drain(config, lock, health!),
          cleanup: async () => {
            const cutoff = new Date(Date.now() - 30 * 86400000);
            await db.delete(samples).where(lt(samples.at, cutoff));
            await cleanupExpiredIncidents(cutoff);
            await db.delete(operations).where(lt(operations.at, cutoff));
            await db.delete(presence).where(lt(presence.expiresAt, new Date()));
          },
          state,
        });
        lastCollection = state.lastCollection;
        lastCleanup = state.lastCleanup;
      } catch (error) {
        if (error instanceof CollectionLockLost || lockLost) throw error;
        console.error(
          "Error de recogida; se volverá a comprobar sin repetir acciones",
        );
      }
      if (!stopping) await delay(WORKER_IDLE_MS);
    }
    if (lockLost) throw new CollectionLockLost();
  } finally {
    health?.closeSync();
    if (!lockLost) await releaseCollectionLock(lock).catch(() => {});
    try {
      lock.release();
    } catch {
      // The dedicated session may already be closed after lock loss.
    }
    await pool.end().catch(() => {});
  }
}

main().catch(async (error) => {
  if (error instanceof RuntimeConfigError) {
    // The message names variables and finite reasons, never their values.
    console.error(error.message);
  } else if (error instanceof CollectionLockLost) {
    console.error(error.message);
  } else {
    console.error("No se pudo iniciar el recolector");
  }
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
