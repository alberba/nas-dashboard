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
const shutdown = new AbortController();

function stop() {
  stopping = true;
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
 * opportunity: a long batch can never hide the moment its window closes.
 */
async function drain(
  config: ReturnType<typeof readRuntimeConfig>,
  lock: PoolClient,
) {
  for (let index = 0; index < 20 && !stopping; index += 1) {
    const result = await runDispatchOnce({
      client: lock,
      config,
      signal: shutdown.signal,
    });
    const digest = await runDigestOnce({
      client: lock,
      config,
      signal: shutdown.signal,
      onTransition: logDigestTransition,
    });
    if (result.action === "idle" && digest.action === "idle") return;
  }
}

async function main() {
  // Validate the whole environment before the pool is used: a worker with an
  // unusable configuration must never take the collection lock or query the
  // database.
  const config = readRuntimeConfig();
  const hosts = config.hosts;
  const lock = await pool.connect();
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
    while (!stopping) {
      try {
        if (lockLost || !(await holdsCollectionLock(lock)))
          throw new CollectionLockLost();
        const [active] = await db
          .select({ id: presence.id })
          .from(presence)
          .where(gt(presence.expiresAt, new Date()))
          .limit(1);
        if (Date.now() - lastCollection >= sampleInterval(Boolean(active))) {
          lastCollection = Date.now();
          await collectAll(hosts);
        }
        await drain(config, lock);
        if (Date.now() - lastCleanup > 3600000) {
          const cutoff = new Date(Date.now() - 30 * 86400000);
          await db.delete(samples).where(lt(samples.at, cutoff));
          await cleanupExpiredIncidents(cutoff);
          await db.delete(operations).where(lt(operations.at, cutoff));
          await db.delete(presence).where(lt(presence.expiresAt, new Date()));
          lastCleanup = Date.now();
        }
      } catch (error) {
        if (error instanceof CollectionLockLost || lockLost) throw error;
        console.error(
          "Error de recogida; se volverá a comprobar sin repetir acciones",
        );
      }
      if (!stopping) await delay(1000);
    }
    if (lockLost) throw new CollectionLockLost();
  } finally {
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
