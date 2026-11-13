import { db } from "./db";
import { configuration } from "./schema";
import { and, eq } from "drizzle-orm";
import type { Settings } from "./types";
export const defaults: Settings = {
  cpu: 90,
  memory: 90,
  disk: 90,
  temperature: 85,
  sustainedSeconds: 300,
  expectedContainers: [],
  initialized: false,
};
export async function getSettings(hostId: string) {
  const [row] = await db
    .select()
    .from(configuration)
    .where(
      and(eq(configuration.hostId, hostId), eq(configuration.id, "settings")),
    );
  return row?.value ?? structuredClone(defaults);
}
export async function saveSettings(hostId: string, value: Settings) {
  await db
    .insert(configuration)
    .values({ hostId, id: "settings", value })
    .onConflictDoUpdate({
      target: [configuration.hostId, configuration.id],
      set: { value },
    });
}
