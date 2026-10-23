import webpush from "web-push";
import { db } from "./db";
import { subscriptions } from "./schema";
import { eq } from "drizzle-orm";

export async function notify(title: string, body: string, tag: string) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  const entries = await db.select().from(subscriptions);
  await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        await webpush.sendNotification(
          { endpoint: entry.endpoint, keys: entry.keys },
          JSON.stringify({ title, body, tag, url: "/?view=alerts" }),
          { TTL: 3600, timeout: 10000 },
        );
      } catch (error) {
        if (
          error instanceof webpush.WebPushError &&
          [404, 410].includes(error.statusCode)
        ) {
          await db
            .delete(subscriptions)
            .where(eq(subscriptions.endpoint, entry.endpoint));
        } else console.error("No se pudo entregar una notificación push");
      }
    }),
  );
}
