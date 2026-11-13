import { expect, test, type Cookie, type Page } from "@playwright/test";
const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";

type HostFixture = {
  id: string;
  name: string;
  role: "instance" | "apps-server";
  connected: boolean;
  containers: string[];
};

const nas: HostFixture = {
  id: "nas-home",
  name: "NAS-HOME",
  role: "instance",
  connected: true,
  containers: ["jellyfin", "sonarr", "radarr"],
};
const apps: HostFixture = {
  id: "apps",
  name: "Apps",
  role: "apps-server",
  connected: true,
  containers: ["seerr"],
};

function status(host: HostFixture) {
  return {
    id: host.id,
    name: host.name,
    role: host.role,
    connected: host.connected,
    lastAt: host.connected ? new Date().toISOString() : null,
  };
}

function overviewFor(host: HostFixture, all: HostFixture[]) {
  return {
    host: { id: host.id, name: host.name, role: host.role },
    hosts: all.map(status),
    latest: {
      timestamp: Date.now(),
      hostname: host.id,
      cpu: 10,
      memory: { total: 8e9, used: 4e9 },
      network: { rx: 1000, tx: 1000 },
      io: { read: 0, write: 0 },
      uptime: 3600,
      disks: [],
      temperatures: [],
      containers: host.containers.map((name) => ({
        id: name.padEnd(64, "0"),
        name,
        image: `example/${name}:latest`,
        state: "running",
        status: "Up 2 hours (healthy)",
        protected: false,
        cpu: 1.5,
        memory: 200_000_000,
      })),
    },
    lastAt: host.connected ? new Date().toISOString() : null,
    connected: host.connected,
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

/**
 * Serves /api/hosts and /api/overview from fixtures. The overview follows the
 * `host` query parameter like the hub API: no parameter means the primary
 * host, an unknown one answers 404.
 */
async function serveHosts(
  page: Page,
  all: HostFixture[],
  delay: (host: string) => number = () => 0,
) {
  await page.route("**/api/hosts", (route) =>
    route.fulfill({ json: { default: all[0].id, hosts: all.map(status) } }),
  );
  await page.route("**/api/overview?*", async (route) => {
    const requested = new URL(route.request().url()).searchParams.get("host");
    const host = requested
      ? all.find((entry) => entry.id === requested)
      : all[0];
    if (!host)
      return route.fulfill({
        status: 404,
        json: { error: "Host no configurado" },
      });
    const wait = delay(host.id);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    await route.fulfill({ json: overviewFor(host, all) }).catch(() => {});
  });
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
  await serveHosts(page, [nas]);
  await page.goto("/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  session = await context.cookies();
  await context.close();
});

async function open(page: Page, path: string, all: HostFixture[]) {
  await page.context().addCookies(session);
  await serveHosts(page, all);
  await page.goto(path);
}

const content = (page: Page) => page.locator(".page-content");
const option = (page: Page, id: string) =>
  page.locator(`[data-host-option="${id}"]`);
const container = (page: Page, name: string) =>
  page.locator(`[data-container="${name}"]`);

test("choosing a host in maintenance shows that host and keeps it in the URL", async ({
  page,
}) => {
  await open(page, "/?view=maintenance&tab=status", [nas, apps]);
  await expect(content(page)).toHaveAttribute("data-host", "nas-home");
  await expect(option(page, "nas-home")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(container(page, "jellyfin")).toBeVisible();

  await option(page, "apps").click();
  await expect(page).toHaveURL(/[?&]host=apps(&|$)/);
  await expect(page).toHaveURL(/[?&]view=maintenance(&|$)/);
  await expect(option(page, "apps")).toHaveAttribute("aria-pressed", "true");
  await expect(option(page, "nas-home")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(content(page)).toHaveAttribute("data-host", "apps");
  await expect(container(page, "seerr")).toBeVisible();
  await expect(container(page, "jellyfin")).toHaveCount(0);

  await page.reload();
  await expect(content(page)).toHaveAttribute("data-host", "apps");
  await expect(option(page, "apps")).toHaveAttribute("aria-pressed", "true");

  await page.locator('[data-nav="summary"]').click();
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  await page.locator('[data-nav="maintenance"]').click();
  await expect(page).toHaveURL(/[?&]host=apps(&|$)/);
  await expect(content(page)).toHaveAttribute("data-host", "apps");
});

test("the sidebar lists every host with its own connection state", async ({
  page,
}) => {
  const offline = { ...apps, connected: false };
  await open(page, "/", [nas, offline]);
  const entry = (id: string) => page.locator(`[data-sidebar-host="${id}"]`);
  await expect(entry("nas-home")).toHaveAttribute("data-connected", "true");
  await expect(entry("apps")).toHaveAttribute("data-connected", "false");

  await entry("apps").click();
  await expect(page.locator('[data-view="maintenance"]')).toBeVisible();
  await expect(page).toHaveURL(/[?&]host=apps(&|$)/);
  await expect(entry("apps")).toHaveAttribute("aria-current", "true");
  await expect(entry("nas-home")).not.toHaveAttribute("aria-current", /.+/);
});

test("mutating controls follow the selected host's connection", async ({
  page,
}) => {
  const offline = { ...apps, connected: false };
  await open(page, "/?view=maintenance&tab=status&host=apps", [nas, offline]);
  await expect(content(page)).toHaveAttribute("data-host", "apps");
  await expect(page.locator("[data-live]")).toHaveAttribute(
    "data-live",
    "false",
  );
  await expect(container(page, "seerr").locator("[data-action]")).toHaveCount(
    2,
  );
  for (const button of await container(page, "seerr")
    .locator("[data-action]")
    .all())
    await expect(button).toBeDisabled();
  await expect(page.locator('[data-command="reboot"]')).toBeDisabled();

  await option(page, "nas-home").click();
  await expect(content(page)).toHaveAttribute("data-host", "nas-home");
  await expect(page.locator("[data-live]")).toHaveAttribute(
    "data-live",
    "true",
  );
  await expect(
    container(page, "jellyfin").locator('[data-action="restart"]'),
  ).toBeEnabled();
});

test("actions are sent to the selected host", async ({ page }) => {
  await open(page, "/?view=maintenance&tab=status&host=apps", [nas, apps]);
  const sent: string[] = [];
  await page.route("**/api/action*", (route) => {
    sent.push(route.request().url());
    return route.fulfill({ json: { status: "success" } });
  });
  await container(page, "seerr").locator('[data-action="restart"]').click();
  await page.locator("dialog[open] button[type=submit]").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(new URL(sent[0]).searchParams.get("host")).toBe("apps");
});

test("a late answer from the previous host never replaces the selected one", async ({
  page,
}) => {
  await page.context().addCookies(session);
  await serveHosts(page, [nas, apps], (host) =>
    host === "nas-home" ? 1500 : 0,
  );
  await page.goto("/?view=maintenance&tab=status");
  await option(page, "apps").click();
  await expect(content(page)).toHaveAttribute("data-host", "apps");
  await page.waitForTimeout(2000);
  await expect(content(page)).toHaveAttribute("data-host", "apps");
  await expect(container(page, "seerr")).toBeVisible();
  await expect(container(page, "jellyfin")).toHaveCount(0);
});

test("an unknown host in the URL falls back to the primary host", async ({
  page,
}) => {
  await open(page, "/?view=maintenance&tab=status&host=ghost", [nas, apps]);
  await expect(content(page)).toHaveAttribute("data-host", "nas-home");
  await expect(page).not.toHaveURL(/host=ghost/);
  await expect(option(page, "nas-home")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("with a single host maintenance has no host selector", async ({
  page,
}) => {
  await open(page, "/?view=maintenance&tab=status", [nas]);
  await expect(content(page)).toHaveAttribute("data-host", "nas-home");
  await expect(container(page, "jellyfin")).toBeVisible();
  await expect(page.locator("[data-host-option]")).toHaveCount(0);
  await expect(page.locator("[data-sidebar-host]")).toHaveCount(1);
});

test("only an instance host can be rebooted", async ({ page }) => {
  await open(page, "/?view=maintenance&tab=status&host=apps", [nas, apps]);
  let sent = 0;
  await page.route("**/api/action*", (route) => {
    sent += 1;
    return route.fulfill({ json: { status: "pending" } });
  });
  const reboot = page.locator('[data-command="reboot"]');
  await expect(reboot).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await option(page, "nas-home").click();
  await expect(content(page)).toHaveAttribute("data-host", "nas-home");
  await expect(reboot).toBeEnabled();
  await reboot.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-confirm]")).toBeDisabled();
  await dialog.locator("[data-typed-confirmation]").fill("REINICIAR NAS");
  await expect(dialog.locator("[data-confirm]")).toBeEnabled();
  expect(sent).toBe(0);
});
