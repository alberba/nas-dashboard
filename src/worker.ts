import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db, pool } from "./lib/db";
import { alerts, operations, presence, samples } from "./lib/schema";
import { nas } from "./lib/nas";
import { getSettings, saveSettings } from "./lib/settings";
import { sampleInterval } from "./lib/validation";
import { notify } from "./lib/push";
import type { Metrics } from "./lib/types";

const started = new Map<string, number>();
let lastCollection = 0;
let lastCleanup = 0;
let stopping = false;

async function condition(
  key: string,
  failing: boolean,
  title: string,
  detail: string,
  duration = 0,
  severity = "warning",
) {
  const now = Date.now();
  const [open] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.key, key), isNull(alerts.resolvedAt)))
    .limit(1);
  if (!failing) {
    started.delete(key);
    if (open) {
      await db
        .update(alerts)
        .set({ resolvedAt: new Date() })
        .where(eq(alerts.id, open.id));
      await notify(
        "Recuperado: " + title,
        "La incidencia se ha resuelto.",
        key + "-resolved",
      );
    }
    return;
  }
  if (!started.has(key)) started.set(key, now);
  if (!open && now - started.get(key)! >= duration * 1000) {
    await db.insert(alerts).values({ key, title, detail, severity });
    await notify(title, detail, key);
  }
}

async function collect() {
  const settings = await getSettings();
  let metrics: Metrics;
  try {
    metrics = await nas<Metrics>("/metrics");
    if (
      !Number.isFinite(metrics.timestamp) ||
      !Array.isArray(metrics.containers) ||
      !metrics.memory?.total
    )
      throw new Error("Muestra no válida");
  } catch {
    const [planned] = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.action, "reboot"),
          eq(operations.status, "pending"),
          gt(operations.at, new Date(Date.now() - 300000)),
        ),
      )
      .limit(1);
    if (planned) {
      started.delete("connection");
      return;
    }
    await condition(
      "connection",
      true,
      "El NAS no responde",
      "No se reciben métricas. Revisa la conexión y el estado del NAS.",
      60,
      "critical",
    );
    return;
  }
  await condition("connection", false, "El NAS vuelve a responder", "");
  await db
    .insert(samples)
    .values({ at: new Date(metrics.timestamp * 1000), data: metrics });
  if (!settings.initialized) {
    settings.expectedContainers = metrics.containers
      .filter((c) => c.state === "running")
      .map((c) => c.name);
    settings.initialized = true;
    await saveSettings(settings);
  }
  await condition(
    "cpu",
    metrics.cpu !== null && metrics.cpu >= settings.cpu,
    "CPU elevada",
    `Uso sostenido superior al ${settings.cpu} %.`,
    settings.sustainedSeconds,
  );
  const memory = (metrics.memory.used / metrics.memory.total) * 100;
  await condition(
    "memory",
    memory >= settings.memory,
    "Memoria elevada",
    `Uso sostenido superior al ${settings.memory} %.`,
    settings.sustainedSeconds,
  );
  await condition(
    "disk",
    metrics.disks.some((d) => (d.used / d.total) * 100 >= settings.disk),
    "Queda poco espacio",
    `Algún volumen supera el ${settings.disk} % de ocupación.`,
  );
  await condition(
    "temperature",
    metrics.temperatures.some((t) => t.value >= settings.temperature),
    "Temperatura elevada",
    `Algún sensor supera ${settings.temperature} °C.`,
    30,
    "critical",
  );
  for (const name of settings.expectedContainers) {
    await condition(
      "container:" + name,
      !metrics.containers.some((c) => c.name === name && c.state === "running"),
      `Servicio detenido: ${name}`,
      "El servicio estaba previsto en ejecución y no está disponible.",
      30,
    );
  }
  const pending = await db
    .select()
    .from(operations)
    .where(eq(operations.status, "pending"));
  for (const operation of pending) {
    if (
      operation.action === "reboot" &&
      operation.bootAt &&
      metrics.timestamp * 1000 - metrics.uptime * 1000 >
        operation.bootAt.getTime() + 5000
    ) {
      await db
        .update(operations)
        .set({
          status: "success",
          detail: "El NAS ha vuelto a responder después del reinicio.",
        })
        .where(eq(operations.id, operation.id));
    } else if (["start", "stop", "restart"].includes(operation.action)) {
      const container = metrics.containers.find(
        (c) => c.id === operation.target,
      );
      const expected =
        operation.action === "stop"
          ? container?.state !== "running"
          : container?.state === "running";
      if (container && expected && operation.action !== "restart") {
        await db
          .update(operations)
          .set({
            status: "success",
            detail: "Estado comprobado tras recuperar la conexión.",
          })
          .where(eq(operations.id, operation.id));
      }
    }
  }
}

async function main() {
  const lock = await pool.connect();
  const result = await lock.query("SELECT pg_try_advisory_lock(734921)");
  if (!result.rows[0].pg_try_advisory_lock)
    throw new Error("Ya hay un recolector activo");
  console.log("Recolector iniciado");
  while (!stopping) {
    try {
      const [active] = await db
        .select({ id: presence.id })
        .from(presence)
        .where(gt(presence.expiresAt, new Date()))
        .limit(1);
      if (Date.now() - lastCollection >= sampleInterval(Boolean(active))) {
        lastCollection = Date.now();
        await collect();
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
