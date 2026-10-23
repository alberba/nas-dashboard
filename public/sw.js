/* Never cache authenticated HTML or API responses on a shared device. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  let data;
  try { data = event.data.json(); } catch { data = { title: "hub.", body: "Tienes un aviso del NAS." }; }
  event.waitUntil(self.registration.showNotification(data.title || "hub.", {
    body: data.body, tag: data.tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: "/?view=alerts" },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate("/?view=alerts"); return client.focus();
      }
    }
    return self.clients.openWindow("/?view=alerts");
  })());
});
