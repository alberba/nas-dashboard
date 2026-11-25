import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const ORIGIN = "http://localhost:3000";
const source = readFileSync(
  fileURLToPath(new URL("../public/sw.js", import.meta.url)),
  "utf8",
);

type ShownNotification = {
  title: string;
  options: {
    body?: string;
    tag?: string;
    data?: { url?: string; tag?: string; seq?: number };
  };
};

type WindowClient = {
  url: string;
  navigate: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
};

type WorkerEvent = {
  data?: { json(): unknown };
  notification?: { close(): void; data?: { url?: unknown } };
  waitUntil?(promise: Promise<unknown>): void;
};

/**
 * Evaluate the real service worker against a minimal worker global. The
 * handlers are the deployed ones, so a regression in the internal Avisos
 * route or in the tag/seq carried to a visible refresh fails here.
 */
function loadWorker() {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const shown: ShownNotification[] = [];
  const windows: WindowClient[] = [];
  let pending: Promise<unknown> = Promise.resolve();

  const clients = {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => windows),
    openWindow: vi.fn(async () => null),
  };
  const self = {
    location: { origin: ORIGIN },
    registration: {
      showNotification: vi.fn(
        async (title: string, options: ShownNotification["options"]) => {
          shown.push({ title, options });
        },
      ),
    },
    clients,
    skipWaiting: vi.fn(),
    addEventListener: (
      name: string,
      listener: (event: WorkerEvent) => void,
    ) => {
      listeners.set(name, listener);
    },
  };

  vm.runInNewContext(source, { self, URL, Number, console });

  const fire = async (name: string, event: WorkerEvent) => {
    event.waitUntil = (promise: Promise<unknown>) => {
      pending = promise;
    };
    const listener = listeners.get(name);
    if (!listener) throw new Error(`Missing ${name} listener`);
    listener(event);
    await pending;
  };

  return { fire, shown, windows, clients };
}

describe("incident service worker", () => {
  it("keeps the episode target, tag and revision from a push payload", async () => {
    const worker = loadWorker();

    await worker.fire("push", {
      data: {
        json: () => ({
          title: "Disco con problemas",
          body: "Se ha agravado",
          url: "/?view=alerts&host=nas-home&incident=42",
          tag: "hub:incident:nas-home:42",
          seq: 7,
        }),
      },
    });

    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]).toMatchObject({
      title: "Disco con problemas",
      options: {
        body: "Se ha agravado",
        tag: "hub:incident:nas-home:42",
        data: {
          url: "/?view=alerts&host=nas-home&incident=42",
          tag: "hub:incident:nas-home:42",
          seq: 7,
        },
      },
    });
  });

  it("falls back to the generic alerts view for a tampered or invalid target", async () => {
    const targets = [
      "https://evil.example/?view=alerts&host=nas-home&incident=42",
      "/other?view=alerts&host=nas-home&incident=42",
      "/?view=alerts&host=nas-home&incident=42&next=https://evil.example",
      "/?view=alerts&host=NAS-HOME&incident=42",
      "/?view=alerts&host=nas-home&incident=0",
      "/?view=alerts&host=nas-home&incident=2147483648",
    ];

    for (const url of targets) {
      const worker = loadWorker();
      await worker.fire("push", {
        data: { json: () => ({ url, seq: 1.5 }) },
      });

      expect(worker.shown[0]?.options.data).toEqual({
        url: "/?view=alerts",
        tag: undefined,
        seq: undefined,
      });
    }
  });

  it("navigates a same-origin window to the validated episode and focuses it", async () => {
    const worker = loadWorker();
    const sameOrigin: WindowClient = {
      url: `${ORIGIN}/?view=dashboard`,
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    const foreign: WindowClient = {
      url: "https://evil.example/",
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    worker.windows.push(foreign, sameOrigin);

    await worker.fire("notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/?view=alerts&host=nas-home&incident=42" },
      },
    });

    expect(sameOrigin.navigate).toHaveBeenCalledWith(
      `${ORIGIN}/?view=alerts&host=nas-home&incident=42`,
    );
    expect(sameOrigin.focus).toHaveBeenCalledTimes(1);
    expect(foreign.navigate).not.toHaveBeenCalled();
    expect(worker.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when no authenticated window exists", async () => {
    const worker = loadWorker();

    await worker.fire("notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/?view=alerts&host=nas-home&incident=42" },
      },
    });

    expect(worker.clients.openWindow).toHaveBeenCalledWith(
      `${ORIGIN}/?view=alerts&host=nas-home&incident=42`,
    );
  });

  it("never opens a target outside the internal alerts route", async () => {
    const worker = loadWorker();

    await worker.fire("notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "https://evil.example/phish" },
      },
    });

    expect(worker.clients.openWindow).toHaveBeenCalledWith(
      `${ORIGIN}/?view=alerts`,
    );
  });
});
