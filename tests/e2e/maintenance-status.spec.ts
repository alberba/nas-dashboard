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
      { status: number } | Record<string, unknown>;
    if ("status" in result && typeof result.status === "number")
      return route.fulfill({ status: result.status, json: {} });
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

test("the strip reflects the host snapshot and lists automations and failed units apart", async ({
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

  const units = page.locator("[data-unit]");
  await expect(units).toHaveCount(3);
  await expect(
    page.locator('[data-unit="media-stack-evidence"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-unit="media-stack-tdarr-hardlinks"]'),
  ).toHaveAttribute("data-state", "paused");

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
  await expect(page.locator("[data-unit]")).toHaveCount(1);
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
