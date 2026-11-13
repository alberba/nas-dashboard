import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { samples } from "./schema";
import { CONNECTION_STALE_MS, publicHost, type HostConfig } from "./hosts";
import type { HostStatus } from "./types";

export async function hostStatuses(
  hosts: HostConfig[],
  now = Date.now(),
): Promise<HostStatus[]> {
  return Promise.all(
    hosts.map(async (host) => {
      const [latest] = await db
        .select({ at: samples.at })
        .from(samples)
        .where(eq(samples.hostId, host.id))
        .orderBy(desc(samples.at))
        .limit(1);
      return {
        ...publicHost(host),
        connected: Boolean(
          latest && now - latest.at.getTime() < CONNECTION_STALE_MS,
        ),
        lastAt: latest ? latest.at.toISOString() : null,
      };
    }),
  );
}
