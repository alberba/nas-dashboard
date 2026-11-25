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

/** The transaction type shared with the incident store transitions. */
export type SettingsTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/**
 * Rows written by older versions may lack the newer optional fields. Merge
 * them with the defaults instead of reinitializing the expected list.
 */
export function normalizeSettings(value: Partial<Settings> | null | undefined) {
  return {
    ...structuredClone(defaults),
    ...(value ?? {}),
    expectedContainers: Array.isArray(value?.expectedContainers)
      ? [...value.expectedContainers]
      : [],
  } satisfies Settings;
}

export async function getSettings(hostId: string) {
  const [row] = await db
    .select()
    .from(configuration)
    .where(
      and(eq(configuration.hostId, hostId), eq(configuration.id, "settings")),
    );
  return normalizeSettings(row?.value);
}

/**
 * Serializes a read-modify-write of one host settings row. The row is created
 * when it does not exist yet and locked until the callback and the incident
 * transitions it invokes commit together. Callers must never await Docker
 * inside the callback.
 */
export async function mutateSettings(
  hostId: string,
  mutate: (
    current: Settings,
    tx: SettingsTransaction,
  ) => Promise<Settings> | Settings,
): Promise<Settings> {
  return db.transaction(async (tx) => {
    // A missing row cannot be locked; create the default first so concurrent
    // writers serialize on the same row instead of both inserting.
    await tx
      .insert(configuration)
      .values({
        hostId,
        id: "settings",
        value: structuredClone(defaults),
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(configuration)
      .where(
        and(eq(configuration.hostId, hostId), eq(configuration.id, "settings")),
      )
      .for("update");
    const current = normalizeSettings(row?.value);
    const next = normalizeSettings(await mutate(current, tx));
    await tx
      .update(configuration)
      .set({ value: next })
      .where(
        and(eq(configuration.hostId, hostId), eq(configuration.id, "settings")),
      );
    return next;
  });
}

/**
 * Last-resort writer kept for callers that already own a complete document.
 * Production writers must use `mutateSettings` so a concurrent change is not
 * overwritten with an old copy.
 */
export async function saveSettings(hostId: string, value: Settings) {
  await db
    .insert(configuration)
    .values({ hostId, id: "settings", value })
    .onConflictDoUpdate({
      target: [configuration.hostId, configuration.id],
      set: { value },
    });
}
