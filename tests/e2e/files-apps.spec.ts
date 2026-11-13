import { expect, test, type Cookie, type Page } from "@playwright/test";
const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";

const day = 86400;
const now = Math.floor(Date.now() / 1000);

const containers = [
  ["jellyfin", "running", "Up 2 hours (healthy)"],
  ["bazarr", "running", "Up 12 minutes (unhealthy)"],
  ["sonarr", "exited", "Exited (137) 1 hour ago"],
].map(([name, state, status]) => ({
  id: String(name).padEnd(64, "0"),
  name,
  image: `lscr.io/linuxserver/${name}:latest`,
  state,
  status,
  protected: false,
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
    expectedContainers: [],
    initialized: true,
  },
};

const folders: Record<string, Record<string, unknown>[]> = {
  "media:": [
    { name: "Películas", path: "Películas", directory: true },
    { name: "Series", path: "Series", directory: true },
    { name: "enlace", path: "enlace", directory: true, symlink: true },
    { name: "notas.txt", path: "notas.txt", size: 2048 },
  ],
  "media:Películas": [
    { name: "Dune (2021)", path: "Películas/Dune (2021)", directory: true },
    { name: "trailer.mkv", path: "Películas/trailer.mkv", size: 5e8 },
  ],
  "torrents:": [{ name: "incompleto", path: "incompleto", directory: true }],
};

const expiringId = "3f2b9c1e-6a4d-4e8b-9f0a-1c2d3e4f5a6b";
const freshId = "8d7c6b5a-4f3e-4d2c-8b1a-0f9e8d7c6b5a";

const trash = [
  {
    id: expiringId,
    root: "media",
    name: "viejo.mkv",
    path: "Películas/viejo.mkv",
    deletedAt: now - 6 * day,
    expiresAt: now + day / 2,
  },
  {
    id: freshId,
    root: "torrents",
    name: "basura",
    path: "basura",
    deletedAt: now - day,
    expiresAt: now + 6 * day,
  },
];

let session: Cookie[] = [];

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request, browser, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost:3000").origin;
  const state = await (await request.get("/api/setup")).json();
  if (state.required) {
    const response = await request.post("/api/setup", {
      headers: { Origin: origin },
      data: { token: process.env.SETUP_TOKEN, name: "Test", email, password },
    });
    expect(response.status()).toBe(200);
  }
  // Inicio de sesión con su propia IP (TEST-NET): no gasta el cupo de 3 por
  // 10 s que comparten los inicios de sesión de los demás specs.
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "192.0.2.27" },
  });
  const page = await context.newPage();
  await page.route("**/api/overview?*", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.goto("/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  session = await context.cookies();
  await context.close();
});

async function signIn(page: Page) {
  const actions: Record<string, unknown>[] = [];
  const listings: string[] = [];
  await page.context().addCookies(session);
  await page.route("**/api/overview?*", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/files?*", (route) => {
    const url = new URL(route.request().url());
    const key = `${url.searchParams.get("root")}:${url.searchParams.get("path") ?? ""}`;
    listings.push(key);
    return route.fulfill({
      json: (folders[key] ?? []).map((entry) => ({
        directory: false,
        symlink: false,
        size: 0,
        modified: now - day,
        ...entry,
      })),
    });
  });
  await page.route("**/api/trash", (route) => route.fulfill({ json: trash }));
  await page.route("**/api/action", (route) => {
    actions.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: "success" } });
  });
  return { actions, listings };
}

const entry = (page: Page, path: string) =>
  page.locator(`[data-entry="${path}"]`);

test("the file browser switches between its two roots and navigates folders", async ({
  page,
}) => {
  const { listings } = await signIn(page);
  await page.goto("/?view=files");
  const roots = page.locator("[data-root]");
  await expect(roots).toHaveCount(2);
  await expect(page.locator('[data-root="media"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("[data-entry]")).toHaveCount(4);
  await expect(entry(page, "enlace")).toHaveAttribute("data-kind", "symlink");
  for (const button of await entry(page, "enlace").getByRole("button").all())
    await expect(button).toBeDisabled();

  await entry(page, "Películas")
    .getByRole("button", { name: "Películas", exact: true })
    .click();
  await expect(page.locator("[data-file-browser]")).toHaveAttribute(
    "data-path",
    "Películas",
  );
  await expect(page.locator("[data-entry]")).toHaveCount(2);
  await page.locator('[data-crumb=""]').click();
  await expect(page.locator("[data-file-browser]")).toHaveAttribute(
    "data-path",
    "",
  );

  await page.locator('[data-root="torrents"]').click();
  await expect(page.locator('[data-root="torrents"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("[data-entry]")).toHaveCount(1);
  await expect(entry(page, "incompleto")).toBeVisible();
  expect(listings).toEqual(
    expect.arrayContaining(["media:", "media:Películas", "torrents:"]),
  );
  for (const listing of listings)
    expect(listing).toMatch(/^(media|torrents):/);
});


test("rename, move and trash are confirmed actions on the selected root", async ({
  page,
}) => {
  const { actions } = await signIn(page);
  await page.goto("/?view=files");
  const notes = entry(page, "notas.txt");
  await notes.getByRole("button", { name: /notas\.txt/ }).first().waitFor();

  await notes.getByRole("button", { name: "Renombrar notas.txt", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("leeme.txt");
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();

  await notes.getByRole("button", { name: "Mover notas.txt", exact: true }).click();
  await dialog.getByRole("textbox").fill("Series/notas.txt");
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator("dialog[open]")).toBeHidden();

  await notes
    .getByRole("button", {
      name: "Enviar notas.txt a la papelera",
      exact: true,
    })
    .click();
  await page.locator('dialog[open] button[type="submit"]').click();
  await expect(page.locator("dialog[open]")).toBeHidden();

  expect(actions).toEqual([
    {
      action: "move",
      root: "media",
      path: "notas.txt",
      destination: "leeme.txt",
    },
    {
      action: "move",
      root: "media",
      path: "notas.txt",
      destination: "Series/notas.txt",
    },
    { action: "trash", root: "media", path: "notas.txt" },
  ]);
});

test("the trash panel sits beside the folder and shows when each item expires", async ({
  page,
}) => {
  const { actions } = await signIn(page);
  await page.goto("/?view=files");
  const items = page.locator("[data-trash-item]");
  await expect(items).toHaveCount(2);
  await expect(page.locator(`[data-trash-item="${expiringId}"]`))
    .toHaveAttribute("data-expiring", "true");
  await expect(
    page.locator(`[data-trash-item="${freshId}"]`),
  ).not.toHaveAttribute("data-expiring", "true");
  await expect(page.locator("[data-entry]")).toHaveCount(4);

  await page
    .getByRole("button", { name: "Restaurar viejo.mkv", exact: true })
    .click();
  await page.locator('dialog[open] button[type="submit"]').click();
  await expect(page.locator("dialog[open]")).toBeHidden();
  await page
    .getByRole("button", {
      name: "Eliminar definitivamente basura",
      exact: true,
    })
    .click();
  await page.locator('dialog[open] button[type="submit"]').click();
  await expect(page.locator("dialog[open]")).toBeHidden();

  await page
    .getByRole("button", { name: "Vaciar la papelera", exact: true })
    .click();
  const confirm = page.locator('dialog[open] button[type="submit"]');
  await expect(confirm).toBeDisabled();
  await page.locator("dialog[open] input").fill("VACIAR PAPELERA");
  await confirm.click();
  await expect(page.locator("dialog[open]")).toBeHidden();

  expect(actions).toEqual([
    { action: "restore", root: "media", id: expiringId },
    { action: "purge", root: "torrents", id: freshId },
    { action: "empty-trash", confirmation: "VACIAR PAPELERA" },
  ]);
});

test("applications filter by category and show the state of their service", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/?view=apps");
  const apps = page.locator("[data-app]");
  await expect(apps.first()).toBeVisible();
  const all = await apps.count();
  expect(all).toBeGreaterThan(5);
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-app="jellyfin"]')).toHaveAttribute(
    "data-service",
    "healthy",
  );
  await expect(page.locator('[data-app="bazarr"]')).toHaveAttribute(
    "data-service",
    "unhealthy",
  );
  await expect(page.locator('[data-app="sonares"]')).toHaveAttribute(
    "data-service",
    "stopped",
  );
  await expect(page.locator('[data-app="finance"]')).toHaveAttribute(
    "data-service",
    "unknown",
  );
  await expect(
    page.locator('[data-app="jellyfin"]').getByRole("link").first(),
  ).toHaveAttribute("href", /^https:\/\/jellyfin\./);

  const series = page.locator('[data-filter="series"]');
  await series.click();
  await expect(series).toHaveAttribute("aria-pressed", "true");
  await expect(apps).toHaveCount(Number(await series.getAttribute("data-count")));
  await expect(page.locator('[data-app="sonares"]')).toBeVisible();
  await expect(page.locator('[data-app="jellyfin"]')).toHaveCount(0);
  await page.locator('[data-filter="all"]').click();
  await expect(apps).toHaveCount(all);
});

test("on a phone files and applications become compact rows without page scroll", async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ["files", "apps"]) {
    await page.goto(`/?view=${view}`);
    const table = page.locator(`[data-${view}-table]`);
    await expect(table.locator("tbody tr").first()).toBeVisible();
    await expect(table.locator("thead")).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const row = table.locator("tbody tr").first();
    const box = await row.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.goto("/?view=files");
  const trashButton = entry(page, "notas.txt").getByRole("button", {
    name: "Enviar notas.txt a la papelera",
    exact: true,
  });
  await trashButton.scrollIntoViewIfNeeded();
  await expect(trashButton).toBeInViewport();
  const button = await trashButton.boundingBox();
  expect(button && button.x + button.width).toBeLessThanOrEqual(390);
  expect(button?.height).toBeGreaterThanOrEqual(44);
});
