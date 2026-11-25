import { afterEach, describe, expect, it, vi } from "vitest";
import {
  incidentNotificationTag,
  updatePresentIncidentNotification,
  type NotificationSurface,
  type PresentNotification,
} from "@/lib/incident-push";

function surface(present: PresentNotification[] = []) {
  const getNotifications = vi.fn(
    async (options?: { tag?: string }): Promise<PresentNotification[]> =>
      options?.tag
        ? present.filter((notification) => notification.tag === options.tag)
        : present,
  );
  const showNotification = vi.fn<NotificationSurface["showNotification"]>(
    async () => {},
  );
  return {
    getNotifications,
    showNotification,
    value: {
      getNotifications,
      showNotification,
    } satisfies NotificationSurface,
  };
}

const tag = incidentNotificationTag("nas-home", 12);

function input(overrides: Record<string, unknown> = {}) {
  return {
    hostId: "nas-home",
    incidentId: 12,
    seq: 4,
    title: "Disco con problemas",
    body: "Se ha agravado",
    url: "/?view=alerts&host=nas-home&incident=12",
    visible: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updatePresentIncidentNotification", () => {
  it("replaces a present older revision with the same tag without renotifying", async () => {
    const api = surface([{ tag, data: { seq: 2 } }]);
    const result = await updatePresentIncidentNotification({
      ...input(),
      surface: api.value,
    });

    expect(result).toEqual({ state: "updated", tag });
    expect(api.getNotifications).toHaveBeenCalledWith({ tag });
    expect(api.showNotification).toHaveBeenCalledTimes(1);
    expect(api.showNotification).toHaveBeenCalledWith(
      "Disco con problemas",
      expect.objectContaining({
        tag,
        silent: true,
        renotify: false,
        data: {
          url: "/?view=alerts&host=nas-home&incident=12",
          tag,
          seq: 4,
        },
      }),
    );
    const options = api.showNotification.mock.calls[0][1] as {
      tag?: string;
      silent?: boolean;
      renotify?: boolean;
    };
    expect(options.tag).toBe("hub:incident:nas-home:12");
    expect(options.silent).toBe(true);
    expect(options.renotify).toBe(false);
  });

  it("does not present a notification when none is still in the tray", async () => {
    const api = surface([]);
    const result = await updatePresentIncidentNotification({
      ...input(),
      surface: api.value,
    });

    expect(result).toEqual({ state: "missing", tag });
    expect(api.showNotification).not.toHaveBeenCalled();
  });

  it("leaves the current revision untouched", async () => {
    const api = surface([{ tag, data: { seq: 4 } }]);
    const result = await updatePresentIncidentNotification({
      ...input(),
      surface: api.value,
    });

    expect(result).toEqual({ state: "same_revision", tag });
    expect(api.showNotification).not.toHaveBeenCalled();
  });

  it("treats a newer revision as already current", async () => {
    const api = surface([
      { tag, data: { seq: 7 } },
      { tag, data: { seq: 3 } },
    ]);
    const result = await updatePresentIncidentNotification({
      ...input(),
      surface: api.value,
    });

    expect(result).toEqual({ state: "same_revision", tag });
    expect(api.showNotification).not.toHaveBeenCalled();
  });

  it("updates a legacy notification without a stored revision", async () => {
    const api = surface([{ tag }]);
    const result = await updatePresentIncidentNotification({
      ...input(),
      surface: api.value,
    });

    expect(result).toEqual({ state: "updated", tag });
    expect(api.showNotification).toHaveBeenCalledTimes(1);
  });

  it("does not touch the API when the page is not visible", async () => {
    const api = surface([{ tag, data: { seq: 1 } }]);
    const result = await updatePresentIncidentNotification({
      ...input({ visible: false }),
      surface: api.value,
    });

    expect(result).toEqual({ state: "hidden", tag });
    expect(api.getNotifications).not.toHaveBeenCalled();
    expect(api.showNotification).not.toHaveBeenCalled();
  });

  it("reports an unavailable API or a failed read without presenting anything", async () => {
    const unavailable = await updatePresentIncidentNotification({
      ...input(),
      surface: null,
    });
    expect(unavailable).toEqual({ state: "unsupported", tag });

    const failing = surface([{ tag, data: { seq: 1 } }]);
    failing.getNotifications.mockRejectedValueOnce(new Error("no api"));
    const failed = await updatePresentIncidentNotification({
      ...input(),
      surface: failing.value,
    });
    expect(failed).toEqual({ state: "unsupported", tag });
    expect(failing.showNotification).not.toHaveBeenCalled();
  });

  it("does not throw when showNotification itself fails", async () => {
    const api = surface([{ tag, data: { seq: 1 } }]);
    api.showNotification.mockRejectedValueOnce(new Error("denied"));
    const result = await updatePresentIncidentNotification({
      ...input(),
      surface: api.value,
    });

    expect(result).toEqual({ state: "unsupported", tag });
  });

  it("never contacts the push provider", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const api = surface([{ tag, data: { seq: 1 } }]);
    await updatePresentIncidentNotification({
      ...input(),
      surface: api.value,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid hosts and ids before building a tag", async () => {
    expect(
      await updatePresentIncidentNotification({ ...input({ hostId: "NAS HOME" }) }),
    ).toEqual({ state: "invalid", tag: null });
    expect(
      await updatePresentIncidentNotification({ ...input({ incidentId: 0 }) }),
    ).toEqual({ state: "invalid", tag: null });
    expect(
      await updatePresentIncidentNotification({ ...input({ seq: -1 }) }),
    ).toEqual({ state: "invalid", tag: null });
  });
});
