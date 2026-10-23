import { db } from "./db";
import { configuration } from "./schema";
import { eq } from "drizzle-orm";
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
export async function getSettings() {
  const [row] = await db
    .select()
    .from(configuration)
    .where(eq(configuration.id, "settings"));
  return row?.value ?? defaults;
}
export async function saveSettings(value: Settings) {
  await db
    .insert(configuration)
    .values({ id: "settings", value })
    .onConflictDoUpdate({ target: configuration.id, set: { value } });
}
