import { submitLogin } from "./login";
import { readFile } from "node:fs/promises";
import { expect, test, type Cookie, type Page } from "@playwright/test";
const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";

type HostFixture = {
  id: string;
  name: string;
  role: "instance" | "apps-server";
  containers: string[];
};
const nas: HostFixture = {
  id: "nas-home",
  name: "NAS-HOME",
  role: "instance",
  containers: ["jellyfin"],
};
const apps: HostFixture = {
  id: "apps",
  name: "Apps",
  role: "apps-server",
  containers: ["seerr"],
};
const idOf = (name: string) => name.padEnd(64, "0");

function overviewFor(host: HostFixture, all: HostFixture[]) {
  const now = new Date().toISOString();
  return {
    host: { id: host.id, name: host.name, role: host.role },
    hosts: all.map((h) => ({ ...h, connected: true, lastAt: now })),
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
        id: idOf(name),
        name,
        image: `example/${name}:latest`,
        state: "running",
        status: "Up 2 hours (healthy)",
        protected: false,
        cpu: 1.5,
        memory: 200_000_000,
      })),
    },
    lastAt: now,
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

type LogLine = {
  stream: "stdout" | "stderr";
  at: string | null;
  message: string;
};
const T = (n: number) =>
  `2026-11-13T10:00:${String(n).padStart(2, "0")}.000000001Z`;
const firstLines: LogLine[] = [
  { stream: "stdout", at: T(1), message: "Starting service" },
  { stream: "stderr", at: T(2), message: "WARN cache miss" },
  { stream: "stderr", at: T(3), message: "ERROR connection refused" },
];
const newLines: LogLine[] = [
  { stream: "stdout", at: T(4), message: "Listening on :8096" },
];
const cursors = { first: `${T(3)}#1`, next: `${T(4)}#1` };

type Seen = {
  host: string | null;
  id: string | null;
  lines: string | null;
  since: string | null;
};
type Reply = { status?: number; delay?: number; body: unknown };

/** Serves /api/hosts, /api/overview and /api/logs, recording each logs read. */
async function serve(
  page: Page,
  reply: (seen: Seen, count: number) => Reply,
  all: HostFixture[] = [nas],
) {
  const seen: Seen[] = [];
  await page.route("**/api/hosts", (route) =>
    route.fulfill({
      json: {
        default: all[0].id,
        hosts: all.map((h) => ({ ...h, connected: true, lastAt: null })),
      },
    }),
  );
  await page.route("**/api/overview?*", (route) => {
    const requested = new URL(route.request().url()).searchParams.get("host");
    const host = all.find((h) => h.id === (requested ?? all[0].id)) ?? all[0];
    return route.fulfill({ json: overviewFor(host, all) });
  });
  await page.route("**/api/logs?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const entry = {
      host: params.get("host"),
      id: params.get("id"),
      lines: params.get("lines"),
      since: params.get("since"),
    };
    seen.push(entry);
    const answer = reply(entry, seen.length);
    if (answer.delay)
      await new Promise((resolve) => setTimeout(resolve, answer.delay));
    await route
      .fulfill({ status: answer.status ?? 200, json: answer.body })
      .catch(() => {});
  });
  return seen;
}

const incremental = (seen: Seen): Reply =>
  seen.since
    ? {
        body: {
          id: seen.id,
          lines: newLines,
          truncated: false,
          cursor: cursors.next,
        },
      }
    : {
        body: {
          id: seen.id,
          lines: firstLines,
          truncated: false,
          cursor: cursors.first,
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
  await serve(page, incremental);
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
  reply: Parameters<typeof serve>[1] = incremental,
  all: HostFixture[] = [nas],
  path = "/?view=maintenance&tab=status",
) {
  await page.context().addCookies(session);
  const seen = await serve(page, reply, all);
  await page.goto(path);
  return seen;
}

const viewer = (page: Page) => page.getByRole("log");
const logsButton = (page: Page, name: string) =>
  page.locator(`[data-container="${name}"] [data-logs-toggle]`);
const follow = (page: Page) => page.locator("[data-logs-follow]");

test("a container row opens a read-only log viewer with one first read", async ({
  page,
}) => {
  const seen = await open(page);
  await expect(viewer(page)).toHaveCount(0);
  await expect(logsButton(page, "jellyfin")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await logsButton(page, "jellyfin").click();
  await expect(logsButton(page, "jellyfin")).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  const lines = viewer(page).locator("[data-log-line]");
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(1)).toHaveAttribute("data-level", "warn");
  await expect(lines.nth(2)).toHaveAttribute("data-level", "error");
  await expect(lines.nth(0)).not.toHaveAttribute("data-level", /.+/);
  await expect(lines.nth(2)).toHaveAttribute("data-stream", "stderr");

  expect(seen).toEqual([
    { host: null, id: idOf("jellyfin"), lines: "200", since: null },
  ]);
  // Read-only: nothing in the viewer can run commands.
  await expect(page.locator("[data-logs] input[type=text]")).toHaveCount(0);
  await expect(follow(page)).toHaveAttribute("aria-pressed", "false");

  await logsButton(page, "jellyfin").click();
  await expect(viewer(page)).toHaveCount(0);
});

test("following polls only for new lines from the opaque cursor, and pausing stops", async ({
  page,
}) => {
  const seen = await open(page);
  await logsButton(page, "jellyfin").click();
  await expect(viewer(page).locator("[data-log-line]")).toHaveCount(3);

  await follow(page).click();
  await expect(follow(page)).toHaveAttribute("aria-pressed", "true");
  await expect(viewer(page).locator("[data-log-line]")).toHaveCount(4);
  await expect(viewer(page).locator("[data-log-line]").last()).toHaveAttribute(
    "data-stream",
    "stdout",
  );
  expect(seen[1]).toEqual({
    host: null,
    id: idOf("jellyfin"),
    lines: "200",
    since: cursors.first,
  });
  await expect.poll(() => seen.length, { timeout: 6000 }).toBeGreaterThan(2);
  expect(seen[2].since).toBe(cursors.next);
  expect(seen.slice(1).every((entry) => entry.since)).toBe(true);

  await page.locator("[data-logs-pause]").click();
  await expect(page.locator("[data-logs-pause]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const frozen = seen.length;
  await page.waitForTimeout(2800);
  expect(seen.length).toBe(frozen);

  await page.locator("[data-logs-pause]").click();
  await expect
    .poll(() => seen.length, { timeout: 6000 })
    .toBeGreaterThan(frozen);

  await follow(page).click();
  await expect(follow(page)).toHaveAttribute("aria-pressed", "false");
  const stopped = seen.length;
  await page.waitForTimeout(2800);
  expect(seen.length).toBe(stopped);
});

test("filter narrows the lines and the line count restarts the tail", async ({
  page,
}) => {
  const seen = await open(page);
  await logsButton(page, "jellyfin").click();
  const lines = viewer(page).locator("[data-log-line]");
  await expect(lines).toHaveCount(3);

  await page.getByRole("searchbox").fill("cache");
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toHaveAttribute("data-level", "warn");
  await page.getByRole("searchbox").fill("");
  await expect(lines).toHaveCount(3);

  await page.locator("[data-logs-count]").selectOption("1000");
  await expect.poll(() => seen.length).toBe(2);
  expect(seen[1]).toEqual({
    host: null,
    id: idOf("jellyfin"),
    lines: "1000",
    since: null,
  });
  await expect(lines).toHaveCount(3);
});

test("download saves the visible lines as a text file", async ({ page }) => {
  await open(page);
  await logsButton(page, "jellyfin").click();
  await expect(viewer(page).locator("[data-log-line]")).toHaveCount(3);
  await page.getByRole("searchbox").fill("connection");
  const download = page.waitForEvent("download");
  await page.locator("[data-logs-download]").click();
  const file = await download;
  expect(file.suggestedFilename()).toContain("jellyfin");
  const text = await readFile((await file.path())!, "utf8");
  expect(text).toBe(`${T(3)} ERROR connection refused\n`);
});

test("a failed read shows the reason and does not break the viewer", async ({
  page,
}) => {
  let fail = true;
  await open(page, (seen) =>
    fail
      ? { status: 502, body: { error: "El agente no responde" } }
      : incremental(seen),
  );
  await logsButton(page, "jellyfin").click();
  await expect(page.locator("[data-logs] [role=alert]")).toBeVisible();
  await expect(viewer(page).locator("[data-log-line]")).toHaveCount(0);
  fail = false;
  await page.locator("[data-logs-refresh]").click();
  await expect(viewer(page).locator("[data-log-line]")).toHaveCount(3);
  await expect(page.locator("[data-logs] [role=alert]")).toHaveCount(0);
});

test("changing host restarts the buffer and drops the old host's answer", async ({
  page,
}) => {
  const seen = await open(
    page,
    (entry) =>
      entry.host === null
        ? {
            delay: 1200,
            body: {
              id: entry.id,
              lines: [{ stream: "stdout", at: T(9), message: "from nas-home" }],
              truncated: false,
              cursor: cursors.first,
            },
          }
        : {
            body: {
              id: entry.id,
              lines: [{ stream: "stdout", at: T(5), message: "from apps" }],
              truncated: false,
              cursor: cursors.next,
            },
          },
    [nas, apps],
  );
  await logsButton(page, "jellyfin").click();
  await expect.poll(() => seen.length).toBe(1);
  await page.locator('[data-host-option="apps"]').click();
  await expect(page.locator('[data-container="seerr"]')).toBeVisible();
  await logsButton(page, "seerr").click();
  const lines = viewer(page).locator("[data-log-line]");
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toHaveAttribute("data-stream", "stdout");
  await page.waitForTimeout(1500);
  await expect(lines).toHaveCount(1);
  await expect(viewer(page)).not.toContainText("from nas-home");
  expect(seen[1]).toEqual({
    host: "apps",
    id: idOf("seerr"),
    lines: "200",
    since: null,
  });
});

test("on a phone the viewer fits the screen and scrolls inside itself", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await logsButton(page, "jellyfin").click();
  await expect(viewer(page).locator("[data-log-line]")).toHaveCount(3);
  await viewer(page).scrollIntoViewIfNeeded();
  const box = await viewer(page).boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/logs-mobile.png" });
});
