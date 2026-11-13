import { z } from "zod";
import type { HostInfo, HostRole } from "./types";

/** A sample older than this marks the host as disconnected in the hub. */
export const CONNECTION_STALE_MS = 75_000;

export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostConfigError";
  }
}

export class HostNotFound extends Error {
  constructor(readonly id: string) {
    super(`Host no configurado: ${id}`);
    this.name = "HostNotFound";
  }
}

const hostId = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    "El identificador solo admite minúsculas, números y guiones",
  );
const host = z.object({
  id: hostId,
  name: z.string().trim().min(1).max(80),
  role: z.enum(["instance", "apps-server"]),
  url: z
    .url()
    .refine((value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, "La URL debe usar HTTP o HTTPS"),
  token: z.string().min(32).max(256),
});

export type HostConfig = {
  id: string;
  name: string;
  role: HostRole;
  url: string;
  token: string;
};

function validate(value: unknown): HostConfig[] {
  const result = z.array(host).min(1).max(20).safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "hosts"}: ${issue.message}`)
      .join("; ");
    throw new HostConfigError(`NAS_HOSTS no es válido (${detail})`);
  }
  const hosts = result.data.map((entry) => ({
    ...entry,
    url: entry.url.replace(/\/+$/, ""),
  }));
  const ids = new Set<string>();
  for (const entry of hosts) {
    if (ids.has(entry.id))
      throw new HostConfigError(`NAS_HOSTS repite el identificador ${entry.id}`);
    ids.add(entry.id);
  }
  if (!hosts.some((entry) => entry.role === "instance"))
    throw new HostConfigError(
      "NAS_HOSTS necesita al menos un host con rol instance",
    );
  return hosts;
}

/**
 * Reads the host list from the server environment. NAS_HOSTS is the explicit
 * multi-host configuration; NAS_AGENT_URL and AGENT_TOKEN keep older single
 * agent deployments working unchanged.
 */
export function parseHosts(
  env: Record<string, string | undefined> = process.env,
): HostConfig[] {
  const configured = env.NAS_HOSTS?.trim();
  if (configured) {
    let value: unknown;
    try {
      value = JSON.parse(configured);
    } catch {
      throw new HostConfigError("NAS_HOSTS no contiene JSON válido");
    }
    return validate(value);
  }
  const url = env.NAS_AGENT_URL?.trim();
  const token = env.AGENT_TOKEN?.trim();
  if (!url && !token)
    throw new HostConfigError(
      "Configura NAS_HOSTS o las variables NAS_AGENT_URL y AGENT_TOKEN",
    );
  if (!url || !token)
    throw new HostConfigError(
      "NAS_AGENT_URL y AGENT_TOKEN deben configurarse juntos",
    );
  return validate([
    { id: "nas-home", name: "NAS-HOME", role: "instance", url, token },
  ]);
}

export function getHosts(
  env: Record<string, string | undefined> = process.env,
): HostConfig[] {
  return parseHosts(env);
}

export function primaryHost(hosts: HostConfig[]): HostConfig {
  return hosts.find((entry) => entry.role === "instance") ?? hosts[0];
}

export function resolveHost(
  hosts: HostConfig[],
  id: string | null | undefined,
): HostConfig {
  if (!id) return primaryHost(hosts);
  const selected = hosts.find((entry) => entry.id === id);
  if (!selected) throw new HostNotFound(id);
  return selected;
}

export function publicHost(host: HostConfig): HostInfo {
  return { id: host.id, name: host.name, role: host.role };
}
