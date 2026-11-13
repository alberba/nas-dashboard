import { submitLogin } from "./login";
import { expect, test, type Cookie, type Page } from "@playwright/test";
const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";

const containers = [
  ["jellyfin", "running", "Up 2 hours (healthy)", false],
  ["bazarr", "running", "Up 12 minutes (unhealthy)", false],
  ["tailscale", "running", "Up 3 days", true],
  ["sonarr", "exited", "Exited (137) 1 hour ago", false],
  ["wire", "exited", "Exited (0) 3 days ago", false],
].map(([name, state, status, isProtected]) => ({
  id: String(name).padEnd(64, "0"),
  name,
  image: `lscr.io/linuxserver/${name}:latest`,
  state,
  status,
  protected: isProtected,
  cpu: state === "running" ? 1.5 : null,
  memory: state === "running" ? 200_000_000 : null,
}));

const overview = {
  latest: {
    timestamp: Date.now(),
    hostname: "nas",
    cpu: 10,
    memory: { total: 8e9, used: 4e9 },
    network: { rx: 1000, tx: 1000 },
    io: { read: 0, write: 0 },
    uptime: 3600,
    disks: [],
    temperatures: [],
    containers,
  },
  lastAt: new Date().toISOString(),
  connected: true,
  interval: 5,
  alerts: [],
  operations: [],
  history: [],
  settings: {
    cpu: 90,
    memory: 90,
    disk: 90,
    temperature: 70,
    sustainedSeconds: 300,
    expectedContainers: ["sonarr"],
    initialized: true,
  },
};

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
  await page.route("**/api/overview?*", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.goto("http://localhost:3000/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await submitLogin(page);
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  session = await context.cookies();
  await context.close();
});

async function signIn(page: Page) {
  await page.context().addCookies(session);
  await page.route("**/api/overview?*", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.goto("/");
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
}

const rows = (page: Page) => page.locator("[data-container]");
const filter = (page: Page, id: string) =>
  page.locator(`[data-filter="${id}"]`);

test("maintenance status is reachable from the navigation and by URL", async ({
  page,
}) => {
  await signIn(page);
  const entry = page.locator('[data-nav="maintenance"]');
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
  const view = page.locator('[data-view="maintenance"]');
  await expect(view).toHaveAttribute("data-subview", "status");
  await expect(page).toHaveURL(/[?&]view=maintenance(&|$)/);
  await expect(page).toHaveURL(/[?&]tab=status(&|$)/);
  await expect(page.locator('[data-subview-link="status"]')).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.goto("/?view=containers");
  await expect(page.locator('[data-view="maintenance"]')).toHaveAttribute(
    "data-subview",
    "status",
  );
  await page.goto("/?view=maintenance&tab=status");
  await expect(page.locator('[data-view="maintenance"]')).toHaveAttribute(
    "data-subview",
    "status",
  );
  await expect(rows(page)).toHaveCount(containers.length);
});

test("container filters show their counts and narrow the table", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/?view=maintenance&tab=status");
  await expect(filter(page, "all")).toHaveAttribute("aria-pressed", "true");
  await expect(filter(page, "all")).toHaveAttribute("data-count", "5");
  await expect(filter(page, "problems")).toHaveAttribute("data-count", "2");
  await expect(filter(page, "stopped")).toHaveAttribute("data-count", "2");

  await filter(page, "problems").click();
  await expect(filter(page, "problems")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(filter(page, "all")).toHaveAttribute("aria-pressed", "false");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('[data-container="bazarr"]')).toHaveAttribute(
    "data-health",
    "unhealthy",
  );

  await filter(page, "stopped").click();
  await expect(rows(page)).toHaveCount(2);
  for (const row of await rows(page).all())
    await expect(row).toHaveAttribute("data-state", "exited");

  await filter(page, "all").click();
  await expect(rows(page)).toHaveCount(5);
});

test("container rows keep their actions and protected services stay locked", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/?view=maintenance&tab=status");
  const bazarr = page.locator('[data-container="bazarr"]');
  await expect(bazarr.locator('[data-action="restart"]')).toBeEnabled();
  await expect(bazarr.locator('[data-action="stop"]')).toBeEnabled();
  await expect(bazarr.locator('[data-action="start"]')).toHaveCount(0);
  const tailscale = page.locator('[data-container="tailscale"]');
  for (const button of await tailscale.locator("[data-action]").all())
    await expect(button).toBeDisabled();
  const sonarr = page.locator('[data-container="sonarr"]');
  await expect(sonarr.locator('[data-action="stop"]')).toHaveCount(0);
  await sonarr.locator('[data-action="start"]').click();
  await expect(page.locator("dialog[open]")).toBeVisible();
});

test("on a phone the container table becomes compact rows without page scroll", async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=maintenance&tab=status");
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator("[data-container-table] thead")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const row = page.locator('[data-container="bazarr"]');
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await expect(row.locator('[data-action="restart"]')).toBeInViewport();
});

test("rebooting the NAS asks for the typed phrase and sends one action that carries its idempotency key", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/verification", (route) =>
    route.fulfill({
      json: {
        method: "passkey",
        recent: true,
        reason: null,
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        ttlSeconds: 300,
      },
    }),
  );
  const sent: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/api/action*", async (route) => {
    sent.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    await route.fulfill({ json: { status: "pending" } });
  });
  await page.goto("/?view=maintenance&tab=status");
  await page.locator('[data-command="reboot"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("data-verification-recent", "true");
  const confirm = dialog.locator("[data-confirm]");
  await expect(confirm).toBeDisabled();

  await dialog.locator("[data-typed-confirmation]").fill("REINICIAR NAS");
  await confirm.click();
  await expect(dialog).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[0].body).toMatchObject({ action: "reboot" });
});
