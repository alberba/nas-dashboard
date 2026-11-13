import { expect, test, type Cookie, type Page } from "@playwright/test";
const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";

const GB = 1024 ** 3;
const containers = [
  ["jellyfin", "running", 3.2, 1.9 * GB],
  ["qbittorrent", "running", 12, 0.8 * GB],
  ["sonarr", "running", 0.4, 0.5 * GB],
  ["radarr", "running", 0.6, 0.6 * GB],
  ["bazarr", "running", 0.2, 0.2 * GB],
  ["prowlarr", "running", 0.1, 0.3 * GB],
  ["tdarr", "exited", null, null],
].map(([name, state, cpu, memory]) => ({
  id: String(name).padEnd(64, "0"),
  name,
  image: `lscr.io/linuxserver/${name}:latest`,
  state,
  status: state === "running" ? "Up 2 hours" : "Exited (0) 1 hour ago",
  protected: false,
  composeProject: "media-stack",
  composeService: name,
  oneShot: false,
  exitCode: state === "running" ? null : 0,
  orphan: false,
  recreateOnCompose: true,
  cpu,
  memory,
  compose: { project: "media-stack", service: name },
}));

const start = Date.now() - 60 * 60 * 1000;
const history = Array.from({ length: 13 }, (_, i) => ({
  at: new Date(start + i * 5 * 60 * 1000).toISOString(),
  cpu: i === 4 ? null : 10 + i,
  memory: i === 4 ? null : 40 + i,
  rx: i === 4 ? null : 1_000_000 * i,
  tx: i === 4 ? null : 200_000 * i,
}));

const host = { id: "nas-home", name: "NAS-HOME", role: "instance" };
const overview = {
  host,
  hosts: [{ ...host, connected: true, lastAt: new Date().toISOString() }],
  latest: {
    timestamp: Date.now(),
    hostname: "nas",
    cpu: 12.5,
    memory: { total: 16 * GB, used: 6 * GB },
    network: { rx: 2_500_000, tx: 400_000 },
    io: { read: 12_000_000, write: 3_000_000 },
    uptime: 3 * 86400 + 4 * 3600,
    disks: [
      { name: "Biblioteca", root: "/volume1", total: 8e12, used: 7.6e12, free: 0.4e12 },
      { name: "Descargas", root: "/volume2", total: 4e12, used: 1e12, free: 3e12 },
    ],
    temperatures: [
      { name: "CPU", value: 72 },
      { name: "Disco 1", value: 38 },
    ],
    containers,
  },
  lastAt: new Date().toISOString(),
  connected: true,
  interval: 5,
  alerts: [
    {
      id: 1,
      hostId: host.id,
      key: "disk",
      title: "Biblioteca casi llena",
      detail: "95 %",
      severity: "warning",
      at: new Date().toISOString(),
      resolvedAt: null,
    },
    {
      id: 2,
      hostId: host.id,
      key: "cpu",
      title: "CPU alta",
      detail: "",
      severity: "warning",
      at: new Date(start).toISOString(),
      resolvedAt: new Date().toISOString(),
    },
  ],
  openAlerts: 1,
  operations: [],
  history,
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
  // Other suites sign in on the same server; wait out Better Auth's sign-in
  // rate limit instead of depending on the order the files run in.
  const context = await browser.newContext();
  for (let attempt = 0; ; attempt++) {
    const response = await context.request.post("/api/auth/sign-in/email", {
      headers: { Origin: "http://localhost:3000" },
      data: { email, password },
    });
    if (response.status() !== 429 || attempt === 3) {
      expect(response.status()).toBe(200);
      break;
    }
    const wait = Number(response.headers()["x-retry-after"] ?? 10);
    await new Promise((done) => setTimeout(done, (wait + 1) * 1000));
  }
  session = await context.cookies();
  await context.close();
});

async function open(page: Page, path = "/") {
  const ranges: string[] = [];
  await page.context().addCookies(session);
  await page.route("**/api/overview?*", (route) => {
    ranges.push(new URL(route.request().url()).searchParams.get("range") ?? "");
    return route.fulfill({ json: overview });
  });
  await page.goto(path);
  return ranges;
}

const range = (page: Page, id: string) =>
  page.locator(`button:has([data-range="${id}"])`);

test("summary opens with a status strip and the period picker reloads the history", async ({
  page,
}) => {
  const ranges = await open(page);
  const view = page.locator('[data-view="summary"]');
  for (const segment of [
    "health",
    "uptime",
    "services",
    "cpu",
    "memory",
    "network",
    "temperature",
  ])
    await expect(
      view.locator(`.status-strip [data-segment="${segment}"]`),
    ).toBeVisible();
  await expect(view.locator("[data-health-state]")).toHaveAttribute(
    "data-health-state",
    "attention",
  );

  await expect(range(page, "1h")).toHaveAttribute("aria-pressed", "true");
  await range(page, "24h").click();
  await expect(range(page, "24h")).toHaveAttribute("aria-pressed", "true");
  await expect(range(page, "1h")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => ranges.at(-1)).toBe("24h");
});

test("summary shows the activity chart, the busiest services and the open alerts", async ({
  page,
}) => {
  await open(page);
  const view = page.locator('[data-view="summary"]');
  const chart = view.locator('[data-chart="activity"]').getByRole("img");
  await expect(chart).toHaveCount(1);
  await expect(chart).toHaveAttribute("aria-label", /\S/);

  await expect(view.locator("[data-top-service]")).toHaveCount(5);
  const order = await view
    .locator("[data-top-service]")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-top-service")));
  expect(order).toEqual(["jellyfin", "qbittorrent", "radarr", "sonarr", "prowlarr"]);

  await expect(view.locator("[data-alert]")).toHaveCount(1);
  await expect(view.locator('[data-alert="1"]')).toBeVisible();
  await expect(view.locator('[data-volume="/volume1"]')).toHaveAttribute(
    "data-level",
    "high",
  );
  await expect(view.locator("[data-shortcut]").first()).toHaveAttribute(
    "href",
    /^https:\/\//,
  );

  await view.locator('[data-view-link="maintenance"]').first().click();
  await expect(page.locator('[data-view="maintenance"]')).toBeVisible();
});

test("resources shows current values, four described charts and the hardware tables", async ({
  page,
}) => {
  const ranges = await open(page, "/?view=resources");
  const view = page.locator('[data-view="resources"]');
  for (const segment of ["cpu", "memory", "network", "io", "uptime"])
    await expect(
      view.locator(`.status-strip [data-segment="${segment}"]`),
    ).toBeVisible();

  const charts = view.locator("[data-chart]");
  await expect(charts).toHaveCount(4);
  const descriptions = new Set<string | null>();
  for (const chart of await charts.all()) {
    const image = chart.getByRole("img");
    await expect(image).toHaveAttribute("aria-label", /\S/);
    await expect(chart).toHaveAttribute("data-points", String(history.length));
    descriptions.add(await image.getAttribute("aria-label"));
  }
  // Each description is built from its own series, so no two are alike.
  expect(descriptions.size).toBe(4);

  await range(page, "7d").click();
  await expect.poll(() => ranges.at(-1)).toBe("7d");

  await expect(view.locator('[data-sensor="CPU"]')).toHaveAttribute(
    "data-level",
    "high",
  );
  await expect(view.locator('[data-sensor="Disco 1"]')).toHaveAttribute(
    "data-level",
    "normal",
  );
  await expect(view.locator("[data-io]")).toHaveCount(2);
  await expect(view.locator('[data-volume="/volume1"]')).toHaveAttribute(
    "data-level",
    "high",
  );
  await expect(
    view.locator('[data-volume="/volume2"]').getByRole("meter"),
  ).toHaveAttribute("aria-valuenow", "25");
});

test("on a phone the strips use two columns and the tables become compact rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, table] of [
    ["/", "[data-busy-table]"],
    ["/?view=resources", "[data-volume-table]"],
  ]) {
    await open(page, path);
    const strip = page.locator(".status-strip");
    await expect(strip).toBeVisible();
    expect(
      await strip.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    ).toBe(2);
    await expect(page.locator(`${table} thead`)).toBeHidden();
    // The period picker spans the panel in equal columns.
    const picker = page.locator('[role="group"]:has([data-range])');
    const widths = await picker
      .locator("button")
      .evaluateAll((buttons) =>
        buttons.map((b) => Math.round(b.getBoundingClientRect().width)),
      );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const row = page.locator(`${table} tbody tr`).first();
    // A compact row keeps the name and its key value; the other columns go.
    await expect(row.locator("td").first()).toBeVisible();
    await expect(row.locator("td").last()).toBeVisible();
    await expect(row.locator("td").nth(1)).toBeHidden();
    const box = await row.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("the five history periods are offered and each one reloads its range", async ({
  page,
}) => {
  const ranges = await open(page, "/?view=resources");
  const ids = ["1h", "6h", "24h", "7d", "30d"];
  await expect(page.locator("[data-range]")).toHaveCount(ids.length);
  for (const id of ids.toReversed()) {
    await range(page, id).click();
    await expect(range(page, id)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => ranges.at(-1)).toBe(id);
  }
});

/** Opens the summary with a frozen page clock, right after the first poll. */
async function openFrozen(page: Page) {
  await page.clock.install();
  const requests = await open(page);
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 100);
  return requests;
}

/** Advances the page clock and reports how many polls happened meanwhile. */
async function pollsDuring(page: Page, requests: string[], ms: number) {
  const before = requests.length;
  await page.clock.runFor(ms);
  await page.waitForTimeout(400);
  return requests.length - before;
}

test("the overview is polled every 5 s while the tab is visible", async ({
  page,
}) => {
  const requests = await openFrozen(page);
  expect(await pollsDuring(page, requests, 3_000)).toBe(0);
  expect(await pollsDuring(page, requests, 2_000)).toBe(1);
  expect(await pollsDuring(page, requests, 5_000)).toBe(1);
});

test("a hidden tab slows the overview polling to every 30 s", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });
  const requests = await openFrozen(page);
  expect(await pollsDuring(page, requests, 25_000)).toBe(0);
  expect(await pollsDuring(page, requests, 5_000)).toBe(1);
});
