/* Never cache authenticated HTML or API responses on a shared device. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

const ALERTS_FALLBACK = "/?view=alerts";
const HOST_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const INCIDENT_ID = /^[1-9]\d{0,9}$/;

/**
 * Only the internal Avisos route with validated host and episode parameters
 * may be opened. Anything else, including an older notification without an
 * episode id, falls back to the generic alerts view.
 */
function alertsPath(value) {
  if (typeof value !== "string") return ALERTS_FALLBACK;
  let url;
  try {
    url = new URL(value, self.location.origin);
  } catch {
    return ALERTS_FALLBACK;
  }
  if (url.origin !== self.location.origin || url.pathname !== "/") return ALERTS_FALLBACK;
  if (url.searchParams.get("view") !== "alerts") return ALERTS_FALLBACK;
  for (const key of url.searchParams.keys()) {
    if (!["view", "host", "incident"].includes(key)) return ALERTS_FALLBACK;
  }
  const host = url.searchParams.get("host");
  const incident = url.searchParams.get("incident");
  if (host !== null && !HOST_ID.test(host)) return ALERTS_FALLBACK;
  if (incident !== null && !INCIDENT_ID.test(incident)) return ALERTS_FALLBACK;
  let path = ALERTS_FALLBACK;
  if (host) path += `&host=${encodeURIComponent(host)}`;
  if (incident) path += `&incident=${incident}`;
  return path;
}

self.addEventListener("push", event => {
  let data;
  try { data = event.data.json(); } catch { data = { title: "hub.", body: "Tienes un aviso del NAS." }; }
  if (!data || typeof data !== "object") data = { title: "hub.", body: "Tienes un aviso del NAS." };
  const url = alertsPath(data.url);
  const seq = Number.isSafeInteger(data.seq) && data.seq > 0 ? data.seq : undefined;
  event.waitUntil(self.registration.showNotification(data.title || "hub.", {
    body: data.body,
    tag: data.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    /* Keep the tag and revision so a visible refresh can replace silently. */
    data: { url, tag: data.tag, seq },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const fallback = event.notification.data && event.notification.data.url;
  const target = new URL(alertsPath(fallback), self.location.origin).toString();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(target); return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
