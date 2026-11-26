import { WORKER_HEALTH_FILE, checkWorkerHealth } from "../src/lib/worker-health";

/**
 * Docker healthcheck for the worker.
 *
 * Runs with the same Node runtime and `tsx` loader as the worker, as the
 * container user, and only reads the private mark of its own container. Exit 0
 * means recent progress under the collection lock; every other outcome exits 1.
 */
const file = process.env.WORKER_HEALTH_FILE?.trim() || WORKER_HEALTH_FILE;
const result = await checkWorkerHealth({ file });
if (!result.ok) {
  console.error(`Marca de salud del worker no válida (${result.reason})`);
  process.exit(1);
}
