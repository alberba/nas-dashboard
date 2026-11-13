import { and, gt, lt } from "drizzle-orm";
import { db, pool } from "./lib/db";
import { alerts, operations, presence, samples } from "./lib/schema";
import { getHosts } from "./lib/hosts";
import { collectAll } from "./lib/collector";
import { sampleInterval } from "./lib/validation";

let lastCollection = 0;
let lastCleanup = 0;
let stopping = false;

async function main() {
  const hosts = getHosts();
  const lock = await pool.connect();
  const result = await lock.query("SELECT pg_try_advisory_lock(734921)");
  if (!result.rows[0].pg_try_advisory_lock)
    throw new Error("Ya hay un recolector activo");
  console.log(
    `Recolector iniciado para ${hosts.map((host) => host.name).join(", ")}`,
  );
  while (!stopping) {
    try {
      const [active] = await db
        .select({ id: presence.id })
        .from(presence)
        .where(gt(presence.expiresAt, new Date()))
        .limit(1);
      if (Date.now() - lastCollection >= sampleInterval(Boolean(active))) {
        lastCollection = Date.now();
        await collectAll(hosts);
      }
      if (Date.now() - lastCleanup > 3600000) {
        const cutoff = new Date(Date.now() - 30 * 86400000);
        await db.delete(samples).where(lt(samples.at, cutoff));
        await db
          .delete(alerts)
          .where(and(lt(alerts.at, cutoff), lt(alerts.resolvedAt, cutoff)));
        await db.delete(operations).where(lt(operations.at, cutoff));
        await db.delete(presence).where(lt(presence.expiresAt, new Date()));
        lastCleanup = Date.now();
      }
    } catch {
      console.error(
        "Error de recogida; se volverá a comprobar sin repetir acciones",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await lock.query("SELECT pg_advisory_unlock(734921)");
  lock.release();
  await pool.end();
}
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
main().catch(() => {
  console.error("No se pudo iniciar el recolector");
  process.exitCode = 1;
});
