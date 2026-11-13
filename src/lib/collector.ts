import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./db";
import { alerts, operations, samples } from "./schema";
import { nasForHost } from "./nas";
import { getSettings, saveSettings } from "./settings";
import { getHosts, type HostConfig } from "./hosts";
import { notify } from "./push";
import type { Metrics } from "./types";

const started = new Map<string, number>();

function scoped(host: HostConfig, key: string) {
  return `${host.id}:${key}`;
}

async function condition(
  host: HostConfig,
  key: string,
  failing: boolean,
  title: string,
  detail: string,
  now: number,
  duration = 0,
  severity = "warning",
) {
  const [open] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.hostId, host.id),
        eq(alerts.key, key),
        isNull(alerts.resolvedAt),
      ),
    )
    .limit(1);
  if (!failing) {
    started.delete(scoped(host, key));
    if (open) {
      await db
        .update(alerts)
        .set({ resolvedAt: new Date(now) })
        .where(eq(alerts.id, open.id));
      await notify(
        "Recuperado: " + title,
        "La incidencia se ha resuelto.",
        scoped(host, key) + "-resolved",
      );
    }
    return;
  }
  if (!started.has(scoped(host, key))) started.set(scoped(host, key), now);
  if (!open && now - started.get(scoped(host, key))! >= duration * 1000) {
    await db
      .insert(alerts)
      .values({ hostId: host.id, key, title, detail, severity });
    await notify(title, detail, scoped(host, key));
  }
}

export async function collectHost(host: HostConfig, now = Date.now()) {
  const settings = await getSettings(host.id);
  let metrics: Metrics;
  try {
    metrics = await nasForHost<Metrics>(host, "/metrics");
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
          eq(operations.hostId, host.id),
          eq(operations.action, "reboot"),
          eq(operations.status, "pending"),
          gt(operations.at, new Date(now - 300000)),
        ),
      )
      .limit(1);
    if (planned) {
      started.delete(scoped(host, "connection"));
      return;
    }
    await condition(
      host,
      "connection",
      true,
      `${host.name} no responde`,
      "No se reciben métricas. Revisa la conexión y el estado del host.",
      now,
      60,
      "critical",
    );
    return;
  }
  await condition(
    host,
    "connection",
    false,
    `${host.name} vuelve a responder`,
    "",
    now,
  );
  await db
    .insert(samples)
    .values({
      hostId: host.id,
      at: new Date(metrics.timestamp * 1000),
      data: metrics,
    });
  if (!settings.initialized) {
    settings.expectedContainers = metrics.containers
      .filter((container) => container.state === "running")
      .map((container) => container.name);
    settings.initialized = true;
    await saveSettings(host.id, settings);
  }
  await condition(
    host,
    "cpu",
    metrics.cpu !== null && metrics.cpu >= settings.cpu,
    `CPU elevada en ${host.name}`,
    `Uso sostenido superior al ${settings.cpu} %.`,
    now,
    settings.sustainedSeconds,
  );
  const memory = (metrics.memory.used / metrics.memory.total) * 100;
  await condition(
    host,
    "memory",
    memory >= settings.memory,
    `Memoria elevada en ${host.name}`,
    `Uso sostenido superior al ${settings.memory} %.`,
    now,
    settings.sustainedSeconds,
  );
  await condition(
    host,
    "disk",
    metrics.disks.some(
      (disk) => (disk.used / disk.total) * 100 >= settings.disk,
    ),
    `Queda poco espacio en ${host.name}`,
    `Algún volumen supera el ${settings.disk} % de ocupación.`,
    now,
  );
  await condition(
    host,
    "temperature",
    metrics.temperatures.some(
      (temperature) => temperature.value >= settings.temperature,
    ),
    `Temperatura elevada en ${host.name}`,
    `Algún sensor supera ${settings.temperature} °C.`,
    now,
    30,
    "critical",
  );
  for (const name of settings.expectedContainers) {
    await condition(
      host,
      "container:" + name,
      !metrics.containers.some(
        (container) =>
          container.name === name && container.state === "running",
      ),
      `Servicio detenido en ${host.name}: ${name}`,
      "El servicio estaba previsto en ejecución y no está disponible.",
      now,
      30,
    );
  }
  const pending = await db
    .select()
    .from(operations)
    .where(
      and(eq(operations.hostId, host.id), eq(operations.status, "pending")),
    );
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
          detail: "El host ha vuelto a responder después del reinicio.",
        })
        .where(eq(operations.id, operation.id));
    } else if (["start", "stop", "restart"].includes(operation.action)) {
      const container = metrics.containers.find(
        (item) => item.id === operation.target,
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

/** Collects every configured host independently; one failure never hides the rest. */
export async function collectAll(
  hosts: HostConfig[] = getHosts(),
  now = Date.now(),
) {
  await Promise.all(
    hosts.map(async (host) => {
      try {
        await collectHost(host, now);
      } catch {
        console.error(`Error de recogida en ${host.id}`);
      }
    }),
  );
}
