import { submitLogin } from "./login";
import { expect, test, type Cookie, type Page } from "@playwright/test";
const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";

type Role = "instance" | "apps-server";
const hosts = [
  { id: "nas-home", name: "NAS-HOME", role: "instance" as Role },
  { id: "apps", name: "Apps", role: "apps-server" as Role },
];

const unit = (name: string, kind: string, state = "active") => ({
  name,
  kind,
  service: `${name}.service`,
  timer: `${name}.timer`,
  activeState: "inactive",
  subState: "dead",
  unitFileState: state === "paused" ? "disabled" : "enabled",
  result: "success",
  state,
  paused: state === "paused",
  lastRun: new Date(Date.now() - 3_600_000).toISOString(),
  nextRun: new Date(Date.now() + 3_600_000).toISOString(),
});

function snapshot(role: Role, overrides: Record<string, unknown> = {}) {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    role,
    follower: {
      available: true,
      state: "idle",
      installed: {
        release: role === "instance" ? "v2.4.1" : "v9.9.9",
        commit: "abc",
        bootstrap: false,
        installedAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
      pending: null,
      failed: null,
    },
    security: { pins: [], pending: null, review: [] },
    backup: { status: "ok", at: new Date().toISOString() },
    disks: { available: false, devices: [] },
    helperCleanup: {
      available: true,
      status: "clean",
      checkedAt: new Date().toISOString(),
      pending: 0,
      persistent: 0,
    },
    units:
      role === "instance"
        ? [
            unit("media-stack-merged-updates", "follower"),
            unit("media-stack-evidence", "automation"),
            unit("media-stack-tdarr-hardlinks", "automation", "paused"),
          ]
        : [unit("media-stack-apps-merged-updates", "follower")],
    failedUnits: {
      stack: [{ name: "media-stack-backup.service", description: null }],
      other: [{ name: "snapd.service", description: "Snap" }],
    },
    reboot: { available: role !== "instance", required: false },
    docker: {
      available: true,
      images: { count: 4, size: 8e9, reclaimable: 2e9 },
      containers: { count: 2, size: 1e6 },
      volumes: { count: 1, size: 1e6 },
      buildCache: { count: 0, size: 0 },
      total: 9e9,
      reclaimable: 2e9,
    },
    degraded: [],
    ...overrides,
  };
}

const status = (h: (typeof hosts)[number]) => ({
  ...h,
  connected: true,
  lastAt: new Date().toISOString(),
});

function overview(h: (typeof hosts)[number]) {
  return {
    host: h,
    hosts: hosts.map(status),
    latest: {
      timestamp: Date.now(),
      hostname: h.id,
      cpu: 10,
      memory: { total: 8e9, used: 4e9 },
      network: { rx: 1000, tx: 1000 },
      io: { read: 0, write: 0 },
      uptime: 3600,
      disks: [],
      temperatures: [],
      containers: [],
    },
    lastAt: new Date().toISOString(),
    connected: true,
    interval: 5,
    alerts: [],
    openAlerts: 0,
    operations: [],
    history: [],
    settings: {
      cpu: 90,
      memory: 90,
      disk: 90,
      temperature: 70,
      sustainedSeconds: 300,
      expectedContainers: [],
      initialized: true,
    },
  };
}

type Maintenance = (host: string, call: number) => Promise<Response> | unknown;

/** Serves hosts, overview and a scripted maintenance endpoint. */
async function serve(page: Page, maintenance: Maintenance) {
  const calls: Record<string, number> = {};
  await page.route("**/api/hosts", (route) =>
    route.fulfill({ json: { default: hosts[0].id, hosts: hosts.map(status) } }),
  );
  await page.route("**/api/overview?*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("host");
    const h = hosts.find((x) => x.id === id) ?? hosts[0];
    return route.fulfill({ json: overview(h) });
  });
  await page.route("**/api/maintenance*", async (route) => {
    const id =
      new URL(route.request().url()).searchParams.get("host") ?? hosts[0].id;
    calls[id] = (calls[id] ?? 0) + 1;
    const h = hosts.find((x) => x.id === id) ?? hosts[0];
    const result = (await maintenance(id, calls[id])) as
      { status: number; body?: unknown } | Record<string, unknown>;
    if ("status" in result && typeof result.status === "number")
      return route.fulfill({
        status: result.status,
        json: "body" in result ? result.body : {},
      });
    await route
      .fulfill({ json: { host: h, snapshot: result } })
      .catch(() => {});
  });
  return calls;
}

let session: Cookie[] = [];
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request, browser }) => {
  const state = await (await request.get("/api/setup")).json();
  if (state.required) {
    const response = await request.post("/api/setup", {
      headers: { Origin: "http://localhost:3000" },
      data: { token: process.env.SETUP_TOKEN, name: "Test", email, password },
    });
    expect(response.status()).toBe(200);
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await serve(page, (id) =>
    snapshot(id === "apps" ? "apps-server" : "instance"),
  );
  await page.goto("/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await submitLogin(page);
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  session = await context.cookies();
  await context.close();
});

async function open(
  page: Page,
  maintenance: Maintenance,
  path = "/?view=maintenance&tab=status",
) {
  await page.context().addCookies(session);
  const calls = await serve(page, maintenance);
  await page.goto(path);
  return calls;
}

const cell = (page: Page, id: string) => page.locator(`[data-segment="${id}"]`);
const nasRole = (id: string) => (id === "apps" ? "apps-server" : "instance");

test("the strip reflects the host snapshot and surfaces failed units", async ({
  page,
}) => {
  await open(page, (id) => snapshot(nasRole(id) as Role));
  await expect(cell(page, "release")).toHaveAttribute(
    "data-state",
    "installed",
  );
  await expect(cell(page, "release")).toContainText("v2.4.1");
  await expect(cell(page, "follower")).toHaveAttribute("data-state", "active");
  await expect(cell(page, "backup")).toHaveAttribute("data-state", "ok");
  await expect(cell(page, "reboot")).toHaveAttribute(
    "data-state",
    "unavailable",
  );
  await expect(cell(page, "docker")).toHaveAttribute("data-state", "ok");

  const failed = page.locator("[data-failed-units]");
  await expect(failed).toBeVisible();
  await failed.locator("summary").click();
  const stack = page.locator('[data-failed-group="stack"]');
  const other = page.locator('[data-failed-group="other"]');
  await expect(stack).toHaveAttribute("data-count", "1");
  await expect(
    stack.locator('[data-failed-unit="media-stack-backup.service"]'),
  ).toBeVisible();
  await expect(stack.locator('[data-failed-unit="snapd.service"]')).toHaveCount(
    0,
  );
  await expect(
    other.locator('[data-failed-unit="snapd.service"]'),
  ).toBeVisible();
});

test("missing follower files and degraded sections do not break the page", async ({
  page,
}) => {
  await open(page, (id) =>
    snapshot(nasRole(id) as Role, {
      follower: {
        available: false,
        state: "unknown",
        installed: null,
        pending: null,
        failed: null,
      },
      units: [],
      backup: { status: "unknown", at: null },
      degraded: ["backup", "failedUnits"],
    }),
  );
  await expect(cell(page, "release")).toHaveAttribute("data-state", "absent");
  await expect(cell(page, "follower")).toHaveAttribute("data-state", "absent");
  await expect(cell(page, "backup")).toHaveAttribute("data-state", "absent");
  await expect(cell(page, "docker")).toHaveAttribute("data-state", "ok");
  await expect(page.locator("[data-failed-group]")).toHaveCount(0);
  await expect(page.locator("[data-container-table]")).toBeVisible();
});

test("switching host drops the previous host's slow answer", async ({
  page,
}) => {
  await open(page, async (id) => {
    if (id === "nas-home") await new Promise((r) => setTimeout(r, 1500));
    return snapshot(nasRole(id) as Role);
  });
  await page.locator('[data-host-option="apps"]').click();
  await expect(cell(page, "release")).toContainText("v9.9.9");
  await page.waitForTimeout(2000);
  await expect(cell(page, "release")).toContainText("v9.9.9");
  await expect(page.locator("[data-container-table]")).toBeVisible();
});

test("a failed refresh keeps the last data marked as stale and recovers", async ({
  page,
}) => {
  await page.clock.install();
  await open(page, (id, call) =>
    call === 2 ? { status: 503 } : snapshot(nasRole(id) as Role),
  );
  await expect(cell(page, "release")).toContainText("v2.4.1");
  const root = page.locator("[data-maintenance-snapshot]");
  await expect(root).not.toHaveAttribute("data-stale", /.+/);

  await page.clock.fastForward(61_000);
  await expect(root).toHaveAttribute("data-stale", "true");
  await expect(cell(page, "release")).toContainText("v2.4.1");

  await page.clock.fastForward(61_000);
  await expect(root).not.toHaveAttribute("data-stale", /.+/);
});

// What the hub answers when the agent's reply went over the cap of its path.
const refused = {
  status: 502,
  body: { error: "refused", code: "agent_response_too_large" },
};

test("a refresh refused as too large keeps the last data and is flagged apart from other failures", async ({
  page,
}) => {
  await page.clock.install();
  await open(page, (id, call) =>
    call === 2
      ? { status: 503 }
      : call === 3
        ? refused
        : snapshot(nasRole(id) as Role),
  );
  await expect(cell(page, "release")).toContainText("v2.4.1");
  const root = page.locator("[data-maintenance-snapshot]");
  const note = page.locator("[data-snapshot-note]");
  await expect(note).toHaveCount(0);

  await page.clock.fastForward(61_000);
  await expect(note).toHaveAttribute("data-snapshot-note", "stale");

  await page.clock.fastForward(61_000);
  await expect(note).toHaveAttribute("data-snapshot-note", "too-large");
  await expect(root).toHaveAttribute("data-stale", "true");
  await expect(cell(page, "release")).toContainText("v2.4.1");

  await page.clock.fastForward(61_000);
  await expect(note).toHaveCount(0);
  await expect(root).not.toHaveAttribute("data-stale", /.+/);
});

test("a first read refused as too large ends in the error phase with the same note", async ({
  page,
}) => {
  await open(page, () => refused);
  await expect(page.locator("[data-maintenance-snapshot]")).toHaveAttribute(
    "data-phase",
    "error",
  );
  await expect(page.locator("[data-snapshot-note]")).toHaveAttribute(
    "data-snapshot-note",
    "too-large",
  );
});

test("today's events keep their rows when a refresh fails and relay only the too-large refusal", async ({
  page,
}) => {
  // The messages are the test's own: what matters is which of them reaches the page.
  const refusal = "refusal-text-sent-by-the-hub";
  const other = "other-failure-text-sent-by-the-hub";
  let answer: "ok" | "too-large" | "other" = "ok";
  await page.route(/\/api\/events(?:\?.*)?$/, (route) =>
    answer === "ok"
      ? route.fulfill({
          json: {
            host: status(hosts[0]),
            day: "2026-11-27",
            timeZone: "Europe/Madrid",
            events: [
              {
                id: "deploy-1",
                kind: "deploy",
                at: new Date().toISOString(),
                status: "ok",
                release: "v2.4.1",
                action: null,
                unit: null,
                reason: null,
              },
            ],
            degraded: [],
          },
        })
      : route.fulfill({
          status: 502,
          json:
            answer === "too-large"
              ? { error: refusal, code: "agent_response_too_large" }
              : { error: other },
        }),
  );
  await open(page, (id) => snapshot(nasRole(id) as Role));
  const panel = page.locator("[data-events]");
  const rows = panel.locator("[data-event]");
  const failure = panel.getByRole("status");
  const refresh = () =>
    page.evaluate(() => window.dispatchEvent(new Event("maintenance-refresh")));
  await expect(rows).toHaveCount(1);
  await expect(failure).toHaveCount(0);

  answer = "too-large";
  await refresh();
  await expect(failure).toHaveText(refusal);
  await expect(rows).toHaveCount(1);

  // Any other failure shows a generic notice, never the server's own text.
  answer = "other";
  await refresh();
  await expect(failure).not.toHaveText(refusal);
  await expect(failure).toBeVisible();
  await expect(failure).not.toContainText(other);
  await expect(rows).toHaveCount(1);

  answer = "ok";
  await refresh();
  await expect(failure).toHaveCount(0);
  await expect(rows).toHaveCount(1);
});

test("the cleaning cell distinguishes a persistent failure from a confirmed host", async ({
  page,
}) => {
  await open(page, (id) =>
    snapshot(nasRole(id) as Role, {
      helperCleanup:
        id === "apps"
          ? {
              available: true,
              status: "clean",
              checkedAt: new Date().toISOString(),
              pending: 0,
              persistent: 0,
            }
          : {
              available: true,
              status: "persistent",
              checkedAt: new Date(Date.now() - 60_000).toISOString(),
              pending: 2,
              persistent: 1,
            },
    }),
  );
  await expect(cell(page, "cleanup")).toHaveAttribute(
    "data-state",
    "persistent",
  );
  await expect(cell(page, "cleanup")).toContainText("2");
  await page.locator('[data-host-option="apps"]').click();
  await expect(cell(page, "cleanup")).toHaveAttribute("data-state", "clean");
  await expect(cell(page, "cleanup")).toContainText("Sin pendientes");
});

test("an unproven cleanup state stays distinct from a failure", async ({
  page,
}) => {
  await open(page, (id) =>
    snapshot(nasRole(id) as Role, {
      helperCleanup:
        id === "apps"
          ? {
              available: true,
              status: "clean",
              checkedAt: new Date().toISOString(),
              pending: 0,
              persistent: 0,
            }
          : {
              available: true,
              status: "indeterminate",
              checkedAt: null,
              pending: 1,
              persistent: 0,
            },
    }),
  );
  await expect(cell(page, "cleanup")).toHaveAttribute(
    "data-state",
    "indeterminate",
  );
  await expect(cell(page, "cleanup")).toContainText("sin confirmar");
});

test("on a phone the strip is two columns and the page does not scroll sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, (id) => snapshot(nasRole(id) as Role));
  await expect(cell(page, "docker")).toBeVisible();
  const [a, b, c] = await Promise.all(
    ["release", "follower", "security"].map((id) =>
      cell(page, id).boundingBox(),
    ),
  );
  expect(a!.y).toBe(b!.y);
  expect(c!.y).toBeGreaterThan(a!.y);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
