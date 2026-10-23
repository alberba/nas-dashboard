import { z } from "zod";
const root = z.enum(["media", "torrents"]);
const path = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (v) =>
      !v.startsWith("/") &&
      !v.includes("\0") &&
      !v.split("/").some((s) => s === ".." || s === ".hub-trash"),
    "Ruta no permitida",
  );
export const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["start", "stop", "restart"]),
    id: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal("reboot"),
    confirmation: z.literal("REINICIAR NAS"),
  }),
  z.object({ action: z.literal("move"), root, path, destination: path }),
  z.object({ action: z.literal("trash"), root, path }),
  z.object({ action: z.enum(["restore", "purge"]), root, id: z.uuid() }),
  z.object({
    action: z.literal("empty-trash"),
    confirmation: z.literal("VACIAR PAPELERA"),
  }),
]);
export const settingsSchema = z.object({
  cpu: z.number().min(50).max(100),
  memory: z.number().min(50).max(100),
  disk: z.number().min(50).max(99),
  temperature: z.number().min(40).max(110),
  sustainedSeconds: z.number().int().min(30).max(1800),
});
export function sampleInterval(hasVisibleTab: boolean) {
  return hasVisibleTab ? 5000 : 30000;
}
