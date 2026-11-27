import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { hostCommandPolicies } from "../../src/lib/sensitive-actions";
const host = {
  id: "nas-home",
  name: "NAS-HOME",
  role: "instance",
  connected: true,
  lastAt: new Date().toISOString(),
};
const id = "a".repeat(64);
const overview = {
  host,
  hosts: [host],
  connected: true,
  lastAt: new Date().toISOString(),
  openAlerts: 2,
  alerts: [],
  operations: [],
  history: [],
  settings: { expectedContainers: [], initialized: true },
  latest: {
    timestamp: Date.now(),
    hostname: "nas",
    cpu: 1,
    memory: { total: 8e9, used: 1e9 },
    network: { rx: 0, tx: 0 },
    io: { read: 0, write: 0 },
    uptime: 10,
    disks: [],
    temperatures: [],
    containers: [
      {
        id,
        name: "orphan-preview",
        image: "local",
        state: "exited",
        status: "Exited (255)",
        protected: false,
        orphan: true,
        cpu: null,
        memory: null,
      },
    ],
  },
};
const retained = {
  release: "v9.0.0",
  reason: "missing-configuration",
  blockedBy: null,
  breaking: true,
  manualSteps: ["Revisar compatibilidad"],
  missingSettings: ["NEW_TOKEN"],
  secretSettings: ["NEW_TOKEN"],
  services: ["jellyfin"],
  sourceCommit: null,
  at: null,
};
let cookies: Awaited<
  ReturnType<import("@playwright/test").BrowserContext["cookies"]>
> = [];
test.beforeAll(async ({ request }) => {
  const state = await (await request.get("/api/setup")).json();
  if (state.required)
    expect(
      (
        await request.post("/api/setup", {
          headers: { Origin: "http://localhost:3000" },
          data: {
            token: process.env.SETUP_TOKEN,
            name: "Test",
            email: "ci@hub.invalid",
            password: "Ci-only-password-not-used-in-production!",
          },
        })
      ).ok(),
    ).toBeTruthy();
  const response = await request.post("/api/auth/sign-in/email", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "ci@hub.invalid",
      password: "Ci-only-password-not-used-in-production!",
    },
  });
  expect(response.ok()).toBeTruthy();
  cookies = (await request.storageState()).cookies;
});
test.beforeEach(async ({ page }) => {
  await page.context().addCookies(cookies);
  await page.route("**/api/overview?*", (r) => r.fulfill({ json: overview }));
  await page.route(/\/api\/renovate(?:\?.*)?$/, (r) =>
    r.fulfill({ json: { enabled: false, prs: [] } }),
  );
  await page.route(/\/api\/maintenance(?:\?.*)?$/, (r) =>
    r.fulfill({ status: 503, json: { error: "offline" } }),
  );
  await page.route(/\/api\/events(?:\?.*)?$/, (r) =>
    r.fulfill({
      json: {
        host,
        day: "2026-11-13",
        timeZone: "Europe/Madrid",
        events: [],
        degraded: [],
      },
    }),
  );
  await page.route("**/api/verification", (r) =>
    r.fulfill({ json: { method: "password", recent: true, reason: null } }),
  );
  await page.route("**/api/deployments?*", (r) =>
    r.fulfill({
      json: {
        host,
        deployments: {
          timestamp: Date.now() / 1000,
          role: "instance",
          available: true,
          follower: {},
          blocker: {
            code: "dirty-checkout",
            files: [{ path: "compose.yml", from: null }],
            missingSettings: [],
          },
          history: [],
          retained: [retained],
          journal: { entries: [] },
          degraded: [],
        },
      },
    }),
  );
  await page.route("**/api/renovate/progress?*", (r) =>
    r.fulfill({ json: { enabled: false, updates: [] } }),
  );
});
test("retained releases expose missing secrets only as write-only inputs and require manual acknowledgement", async ({
  page,
}) => {
  await page.goto("/?view=maintenance&tab=deployments");
  await expect(page.locator('[data-blocker="dirty-checkout"]')).toBeVisible();
  const release = page.locator('[data-release="v9.0.0"] button');
  await release.click();
  await expect(release).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({
    path: "test-results/deployments-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const form = page.locator('[data-release-settings="v9.0.0"]');
  await expect(form).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/deployments-mobile.png",
    fullPage: true,
  });
  await expect(form.locator('input[name="NEW_TOKEN"]')).toHaveAttribute(
    "type",
    "password",
  );
  await expect(
    form.getByRole("button", { name: "Guardar ajustes" }),
  ).toBeDisabled();
  await form.locator('input[name="NEW_TOKEN"]').fill("secret-value");
  await form.locator('input[type="checkbox"]').check();
  await form.getByRole("button", { name: "Guardar ajustes" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
test("search toggles with Ctrl K, shortcuts ignore inputs and removal always opens exact-name confirmation", async ({
  page,
}) => {
  let calls = 0;
  await page.route(/\/api\/host-command(?:\?.*)?$/, (r) => {
    calls++;
    return r.fulfill({ json: { status: "success" } });
  });
  await page.goto("/?view=maintenance&tab=status");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("textbox").fill("b");
  await page.keyboard.press("b");
  expect(calls).toBe(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.locator('[data-stopped-section] summary').click();
  await expect(page.locator("[data-stopped-section]")).toHaveAttribute(
    "open",
    "",
  );
  await page
    .locator('[data-container="orphan-preview"] [data-action="remove"]')
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").locator("[data-typed-confirmation]"),
  ).toHaveValue("");
  expect(calls).toBe(0);
});

test("merge sends the reviewed SHA once, with explicit major acknowledgement and a stable idempotency key", async ({
  page,
}) => {
  const sha = "b".repeat(40);
  const pr = {
    number: 17,
    title: "Update image",
    url: "https://github.com/alberba/media-stack/pull/17",
    branch: "renovate/example",
    author: "renovate[bot]",
    headSha: sha,
    draft: false,
    automerge: false,
    requiresWorker: true,
    ci: "success",
    type: "major",
    updates: [],
    containers: [],
  };
  await page.route(/\/api\/renovate(?:\?.*)?$/, (r) =>
    r.fulfill({
      json: { enabled: true, repository: "alberba/media-stack", prs: [pr] },
    }),
  );
  const calls: { body: unknown; key: string | undefined }[] = [];
  await page.route(/\/api\/renovate\/merge(?:\?.*)?$/, (r) => {
    calls.push({
      body: r.request().postDataJSON(),
      key: r.request().headers()["idempotency-key"],
    });
    return r.fulfill({ status: 502, json: { status: "pending" } });
  });
  await page.goto("/?view=maintenance&tab=deployments");
  await page.locator('[data-merge-pr="17"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-confirm]")).toBeDisabled();
  await dialog.locator('input[type="checkbox"]').check();
  await dialog.locator("[data-confirm]").click();
  await expect(dialog).toHaveAttribute("data-phase", "pending");
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ number: 17, headSha: sha, deployNow: false });
  expect(calls[0].key).toMatch(/^[0-9a-f-]{36}$/);
});

const uuid = /^[0-9a-f-]{36}$/;
type CommandCall = { body: unknown; key: string | undefined };

/** Counts host-command requests and fails the test on any native dialog. */
async function watchCommands(page: Page, status = 200) {
  const calls: CommandCall[] = [];
  const native: string[] = [];
  page.on("dialog", (dialog) => {
    native.push(dialog.type());
    void dialog.dismiss();
  });
  await page.route("**/api/verification", (r) =>
    r.fulfill({
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
  await page.route("**/api/host-command*", (r) => {
    calls.push({
      body: r.request().postDataJSON(),
      key: r.request().headers()["idempotency-key"],
    });
    return r.fulfill(
      status === 200
        ? { json: { status: "success" } }
        : { status, json: { error: "rechazado" } },
    );
  });
  return { calls, native };
}

test("the host actions card asks for verification exactly for the protected commands", async ({
  page,
}) => {
  const { calls, native } = await watchCommands(page);
  await page.goto("/?view=maintenance&tab=status");
  const ids = await page
    .locator("[data-host-command]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.hostCommand ?? ""),
    );
  const policies: Record<string, { kind: string }> = hostCommandPolicies;
  expect(ids.some((id) => policies[id]?.kind === "protected")).toBe(true);
  expect(ids).toContain("check-health");
  for (const id of ids) {
    const sent = calls.length;
    await page.locator(`[data-host-command="${id}"]`).click();
    if (policies[id].kind === "protected") {
      await expect(page.locator("dialog[data-sensitive-action]")).toBeVisible();
      expect(calls).toHaveLength(sent);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[data-sensitive-action]")).toHaveCount(0);
    } else {
      await expect.poll(() => calls.length).toBe(sent + 1);
      expect(calls[sent].key).toMatch(uuid);
      expect(calls[sent].body).toEqual({ command: id });
      await expect(page.locator("dialog[data-sensitive-action]")).toHaveCount(0);
      await expect(page.locator("[data-command-state]")).toHaveAttribute(
        "data-command-state",
        "success",
      );
    }
  }
  expect(native).toEqual([]);
});

test("the Ctrl K search asks for verification exactly for the protected commands", async ({
  page,
}) => {
  const { calls, native } = await watchCommands(page);
  await page.goto("/?view=maintenance&tab=status");
  const palette = page.locator("dialog[aria-label]");
  await page.keyboard.press("Control+k");
  await expect(palette).toBeVisible();
  const ids = await page
    .locator("[data-command-option]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.commandOption ?? ""),
    );
  await page.keyboard.press("Control+k");
  const policies: Record<string, { kind: string }> = hostCommandPolicies;
  expect(ids.some((id) => policies[id]?.kind === "protected")).toBe(true);
  expect(ids).toContain("check-health");
  for (const id of ids) {
    const sent = calls.length;
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible();
    await page.locator(`[data-command-option="${id}"]`).click();
    if (policies[id].kind === "protected") {
      await expect(page.locator("dialog[data-sensitive-action]")).toBeVisible();
      expect(calls).toHaveLength(sent);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[data-sensitive-action]")).toHaveCount(0);
    } else {
      await expect.poll(() => calls.length).toBe(sent + 1);
      expect(calls[sent].key).toMatch(uuid);
      expect(calls[sent].body).toEqual({ command: id });
      await expect(page.locator("dialog[data-sensitive-action]")).toHaveCount(0);
      await expect(page.locator("[data-toast]")).toBeVisible();
    }
  }
  expect(native).toEqual([]);
});

test("a check-health rejected from the search is reported in the panel notice", async ({
  page,
}) => {
  const { calls } = await watchCommands(page, 500);
  await page.goto("/?view=maintenance&tab=status");
  await page.keyboard.press("Control+k");
  await page.locator('[data-command-option="check-health"]').click();
  await expect(page.locator("[data-toast]")).toBeVisible();
  expect(calls).toHaveLength(1);
  await expect(page.locator("dialog[data-sensitive-action]")).toHaveCount(0);
});

test("confirming clean-images in the dialog sends one request and the card shows the outcome", async ({
  page,
}) => {
  const { calls, native } = await watchCommands(page);
  await page.goto("/?view=maintenance&tab=status");
  await page.locator('[data-host-command="clean-images"]').click();
  const dialog = page.locator("dialog[data-sensitive-action]");
  await expect(dialog).toHaveAttribute("data-verification-recent", "true");
  expect(calls).toHaveLength(0);
  await dialog.locator("[data-confirm]").click();
  await expect(page.locator("[data-command-state]")).toHaveAttribute(
    "data-command-state",
    "success",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ command: "clean-images" });
  expect(calls[0].key).toMatch(uuid);
  expect(native).toEqual([]);
});
