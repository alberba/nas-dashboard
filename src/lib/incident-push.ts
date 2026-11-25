/**
 * Local refresh of an already-present incident notification (D-05).
 *
 * The hub never sends a background push to update an opening: WebKit can
 * revoke a subscription when a push arrives without presenting a notice, and
 * an update must never interrupt again. Instead, while an authenticated page
 * is visible, the hub reads the notifications that are still in the tray and
 * replaces the one with the same episode tag when its revision is older.
 *
 * The Notifications API has no atomic conditional replace: between
 * `getNotifications` and `showNotification` the operator may dismiss the
 * notice. This module never recreates a notification it did not read as
 * present, but a dismissal in that narrow window is not observable and may
 * create a new one. The hub state is always updated regardless.
 */

const hostIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Stable per-episode tag shared with the service worker and the worker. */
export function incidentNotificationTag(
  hostId: string,
  incidentId: number,
): string {
  return `hub:incident:${hostId}:${incidentId}`;
}

export type PresentNotification = {
  tag: string;
  data?: { seq?: number; url?: string };
};

/** Minimal registration surface; injectable for tests. */
export type NotificationSurface = {
  getNotifications(options?: {
    tag?: string;
  }): Promise<PresentNotification[]>;
  showNotification(
    title: string,
    options: NotificationOptions,
  ): Promise<void>;
};

export type IncidentNotificationResult =
  | { state: "updated"; tag: string }
  | { state: "missing"; tag: string }
  | { state: "same_revision"; tag: string }
  | { state: "hidden"; tag: string }
  | { state: "unsupported"; tag: string }
  | { state: "invalid"; tag: null };

export type IncidentNotificationInput = {
  hostId: string;
  incidentId: number;
  seq: number;
  title?: string;
  body?: string;
  /** Internal Avisos path, built by the route helpers. */
  url?: string;
  /** The caller knows whether the page is visible; false never touches the API. */
  visible?: boolean;
  surface?: NotificationSurface | null;
  getSurface?: () => Promise<NotificationSurface | null>;
};

async function browserSurface(): Promise<NotificationSurface | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (
      !registration ||
      typeof registration.getNotifications !== "function" ||
      typeof registration.showNotification !== "function"
    )
      return null;
    return registration as unknown as NotificationSurface;
  } catch {
    return null;
  }
}

function notificationSeq(notification: PresentNotification): number | null {
  const value = notification.data?.seq;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Replaces the present notification for this episode only when an older
 * revision is still in the tray. Always returns a finite outcome; never
 * throws and never contacts the push provider.
 */
export async function updatePresentIncidentNotification(
  input: IncidentNotificationInput,
): Promise<IncidentNotificationResult> {
  if (
    !hostIdPattern.test(input.hostId) ||
    !Number.isSafeInteger(input.incidentId) ||
    input.incidentId <= 0 ||
    !Number.isSafeInteger(input.seq) ||
    input.seq < 0
  )
    return { state: "invalid", tag: null };

  const tag = incidentNotificationTag(input.hostId, input.incidentId);
  if (input.visible === false) return { state: "hidden", tag };

  let surface = input.surface;
  if (surface === undefined) {
    surface = await (input.getSurface ?? browserSurface)();
  }
  if (
    !surface ||
    typeof surface.getNotifications !== "function" ||
    typeof surface.showNotification !== "function"
  )
    return { state: "unsupported", tag };

  let present: PresentNotification[];
  try {
    present = await surface.getNotifications({ tag });
  } catch {
    return { state: "unsupported", tag };
  }
  if (!Array.isArray(present) || present.length === 0)
    return { state: "missing", tag };

  const revisions = present
    .map(notificationSeq)
    .filter((value): value is number => value !== null);
  // A legacy notification without a revision is older than any current one.
  if (revisions.length && Math.max(...revisions) >= input.seq)
    return { state: "same_revision", tag };

  try {
    await surface.showNotification(input.title?.trim() || "hub.", {
      body: input.body?.trim() || "La incidencia se ha actualizado.",
      tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      silent: true,
      renotify: false,
      data: {
        url: input.url ?? "/?view=alerts",
        tag,
        seq: input.seq,
      },
    } as NotificationOptions);
  } catch {
    return { state: "unsupported", tag };
  }
  return { state: "updated", tag };
}
