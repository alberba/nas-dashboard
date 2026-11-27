import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  expect,
  test,
  type Cookie,
  type Page,
  type Request,
} from "@playwright/test";
import { submitLogin } from "./login";

const email = "ci@hub.invalid";
const password = "Ci-only-password-not-used-in-production!";
const host = "nas-home";
const inspectPath = "**/api/telegram/intents/inspect";
const executePath = "**/api/telegram/intents/execute";
const STORAGE_KEY = "hub.handoff";

test.describe.configure({ mode: "serial" });

let database: Client;
let userId: string;
// One password sign-in for the whole file: Better Auth rate-limits sign-ins.
let session: Cookie[] = [];

type Seeded = { token: string; incidentId: number; intentId: string };

/** A token the test knows; only its digest is stored, as the hub does. */
const newToken = () => randomBytes(32).toString("base64url");
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/**
 * One open (or resolved) episode with one intent on it. Every case gets its own
 * episode because a notice holds at most one live intent.
 */
async function seedIntent({
  name,
  action,
  target,
  status = "pending",
  resolved = false,
  minutes = 5,
}: {
  name: string;
  action: string;
  target: string;
  status?: string;
  resolved?: boolean;
  minutes?: number;
}): Promise<Seeded> {
  const inserted = await database.query<{ id: number }>(
    `INSERT INTO incidents
       ("hostId", key, title, detail, severity, at, "resolvedAt", fingerprint,
        seq, origin)
     VALUES ($1, $2, $3, 'Detalle', 'critical', now() - interval '10 minutes',
             CASE WHEN $4::boolean THEN now() ELSE NULL END, md5($2), 1, 'live')
     RETURNING id`,
    [host, `e2e-handoff-${name}`, `Aviso ${name}`, resolved],
  );
  const incidentId = inserted.rows[0].id;
  const token = newToken();
  const intentId = randomUUID();
  await database.query(
    `INSERT INTO telegram_action_intents
       (id, "incidentId", "hostId", action, target, "userId", "handoffHash",
        status, "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             now() + make_interval(mins => $9::int))`,
    [intentId, incidentId, host, action, target, userId, digest(token), status, minutes],
  );
  return { token, incidentId, intentId };
}

function link({ token, incidentId }: Seeded) {
  return `/?view=alerts&host=${host}&incident=${incidentId}#intent=${token}`;
}

async function clean() {
  await database.query(
    `DELETE FROM operations WHERE id LIKE 'e2e-handoff-%'
        OR id IN (SELECT id FROM telegram_action_intents
                   WHERE "incidentId" IN
                     (SELECT id FROM incidents WHERE key LIKE 'e2e-handoff-%'))`,
  );
  await database.query(`DELETE FROM incidents WHERE key LIKE 'e2e-handoff-%'`);
}

test.beforeAll(async ({ request, baseURL, browser }) => {
  test.setTimeout(90_000);
  const state = await (await request.get("/api/setup")).json();
  if (state.required) {
    const response = await request.post("/api/setup", {
      headers: { Origin: new URL(baseURL!).origin },
      data: { token: process.env.SETUP_TOKEN, name: "Test", email, password },
    });
    expect(response.status()).toBe(200);
  }
  database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  const found = await database.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email = $1`,
    [email],
  );
  userId = found.rows[0].id;
  await clean();

  // Earlier spec files may have spent the sign-in budget: wait it out.
  const context = await browser.newContext({ baseURL });
  for (let attempt = 0; ; attempt++) {
    const response = await context.request.post("/api/auth/sign-in/email", {
      headers: { Origin: new URL(baseURL!).origin },
      data: { email, password },
    });
    if (response.status() !== 429 || attempt === 5) {
      expect(response.status()).toBe(200);
      break;
    }
    const wait = Number(response.headers()["x-retry-after"] ?? 10);
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
  }
  session = await context.cookies();
  await context.close();
});

test.afterAll(async () => {
  await clean();
  await database.end();
});

async function signIn(page: Page) {
  await page.context().addCookies(session);
}

/** Records every request sent to `execute` and answers it with `answer`. */
async function answerExecute(
  page: Page,
  answer: { status: number; json: unknown },
) {
  const sent: Request[] = [];
  await page.route(executePath, async (route) => {
    sent.push(route.request());
    await route.fulfill(answer);
  });
  return sent;
}

/** Counts the requests sent to `inspect` while letting the real API answer. */
async function countInspect(page: Page) {
  const sent: Request[] = [];
  await page.route(inspectPath, async (route) => {
    sent.push(route.request());
    await route.continue();
  });
  return sent;
}

const panel = (page: Page) => page.locator("[data-handoff]");
const dialog = (page: Page) => page.locator("[data-sensitive-action]");
const stored = (page: Page) =>
  page.evaluate((key) => window.sessionStorage.getItem(key), STORAGE_KEY);

function success(operationId: string) {
  return {
    status: 200,
    json: {
      ok: true,
      status: "success",
      operation: {
        id: operationId,
        hostId: host,
        action: "start",
        target: "plex",
        status: "success",
        detail: "Contenedor iniciado",
        at: new Date().toISOString(),
      },
    },
  };
}

test("HANDOFF-01 opens the dialog from the link, confirms with one tap and reaches succeeded", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "start",
    action: "start",
    target: "plex",
  });
  await signIn(page);
  const inspected = await countInspect(page);
  const sent = await answerExecute(page, success(seeded.intentId));
  const logged: string[] = [];
  page.on("console", (message) => logged.push(message.text()));

  await page.goto(link(seeded));

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(panel(page)).toHaveAttribute("data-handoff-action", "start");
  await expect(panel(page)).toHaveAttribute("data-handoff-target", "plex");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-required",
    "false",
  );

  // The fragment is gone, the rest of the route is intact and the token waits
  // in the tab's storage (T-07-17).
  const url = new URL(page.url());
  expect(url.hash).toBe("");
  expect(url.searchParams.get("view")).toBe("alerts");
  expect(url.searchParams.get("host")).toBe(host);
  expect(url.searchParams.get("incident")).toBe(String(seeded.incidentId));
  expect(await stored(page)).toBe(seeded.token);
  expect(inspected).toHaveLength(1);
  expect(inspected[0].url()).not.toContain(seeded.token);

  await dialog(page).locator("[data-confirm]").click();

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "succeeded");
  expect(sent).toHaveLength(1);
  expect(sent[0].postDataJSON()).toEqual({ token: seeded.token });
  expect(sent[0].url()).not.toContain(seeded.token);
  expect(await stored(page)).toBeNull();
  expect(logged.join("\n")).not.toContain(seeded.token);
});

test("HANDOFF-02 stays idle and calls nothing when the URL has no fragment", async ({
  page,
}) => {
  await signIn(page);
  const inspected = await countInspect(page);
  const sent = await answerExecute(page, { status: 200, json: { ok: true } });

  await page.goto(`/?view=alerts&host=${host}`);
  await expect(page.locator('[data-view="alerts"]')).toBeVisible();
  await expect(page.locator("[data-digest-panel]")).toBeVisible();

  await expect(panel(page)).toHaveCount(0);
  expect(inspected).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

async function loginWithEmail(page: Page) {
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await submitLogin(page);
  await expect(page.locator("[data-view]").first()).toBeVisible();
}

test("HANDOFF-03 survives the login and a reload without losing the intent", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "login",
    action: "start",
    target: "plex",
  });
  await page.context().clearCookies();
  const sent = await answerExecute(page, success(seeded.intentId));

  await page.goto(link(seeded));
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
  // The fragment is captured before the login and the route stays in the URL.
  const url = new URL(page.url());
  expect(url.hash).toBe("");
  expect(url.searchParams.get("incident")).toBe(String(seeded.incidentId));
  expect(await stored(page)).toBe(seeded.token);

  await loginWithEmail(page);
  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(dialog(page)).toBeVisible();

  await page.reload();
  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  expect(await stored(page)).toBe(seeded.token);
  expect(sent).toHaveLength(0);
});

for (const [state, status] of [
  ["expired", "expired"],
  ["cancelled", "cancelled"],
] as const) {
  test(`HANDOFF-04 explains a ${state} intent without opening the dialog or calling execute`, async ({
    page,
  }) => {
    const seeded = await seedIntent({
      name: state,
      action: "start",
      target: "plex",
      status,
    });
    await signIn(page);
    const sent = await answerExecute(page, { status: 200, json: { ok: true } });

    await page.goto(link(seeded));

    await expect(panel(page)).toHaveAttribute("data-handoff-state", state);
    await expect(dialog(page)).toHaveCount(0);
    expect(sent).toHaveLength(0);
    expect(await stored(page)).toBeNull();
  });
}

test("HANDOFF-05 shows an unknown token as invalid without opening the dialog", async ({
  page,
}) => {
  await signIn(page);
  const sent = await answerExecute(page, { status: 200, json: { ok: true } });

  await page.goto(
    `/?view=alerts&host=${host}#intent=${newToken()}`,
  );

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "invalid");
  await expect(dialog(page)).toHaveCount(0);
  expect(sent).toHaveLength(0);
  expect(await stored(page)).toBeNull();
});

test("HANDOFF-06 shows the existing operation of a consumed intent and does not run it again", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "consumed",
    action: "backup-now",
    target: host,
    status: "executed",
  });
  await database.query(
    `INSERT INTO operations
       (id, "hostId", "userId", action, target, status, detail, channel,
        "requestedBy")
     VALUES ($1, $2, $3, 'backup-now', $2, 'success', 'Copia lanzada', 'telegram', $3)`,
    [seeded.intentId, host, userId],
  );
  await signIn(page);
  const sent = await answerExecute(page, { status: 200, json: { ok: true } });

  await page.goto(link(seeded));

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "consumed");
  await expect(page.locator("[data-handoff-operation]")).toHaveAttribute(
    "data-handoff-operation",
    seeded.intentId,
  );
  await expect(dialog(page)).toHaveCount(0);
  expect(sent).toHaveLength(0);
  expect(await stored(page)).toBeNull();
});

test("HANDOFF-07 asks for the passkey on backup-now and not on start", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "backup",
    action: "backup-now",
    target: host,
  });
  await signIn(page);

  await page.goto(link(seeded));

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(panel(page)).toHaveAttribute("data-handoff-action", "backup-now");
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-required",
    "true",
  );
});

test("HANDOFF-08 asks for a tap and the passkey on reboot, with no typed phrase", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "reboot",
    action: "reboot",
    target: host,
  });
  await signIn(page);

  await page.goto(link(seeded));

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-required",
    "true",
  );
  await expect(dialog(page).locator("[data-typed-confirmation]")).toHaveCount(0);
  await expect(dialog(page).locator("[data-confirm]")).toBeEnabled();
});

test("HANDOFF-09 marks a resolved incident and still lets the operator confirm", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "resolved",
    action: "start",
    target: "plex",
    resolved: true,
  });
  await signIn(page);
  const sent = await answerExecute(page, success(seeded.intentId));

  await page.goto(link(seeded));

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(panel(page)).toHaveAttribute("data-handoff-resolved", "true");
  await dialog(page).locator("[data-confirm]").click();

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "succeeded");
  expect(sent).toHaveLength(1);
});

test("HANDOFF-10 keeps the intent alive when the dialog is closed and lets the operator reopen or discard it", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "dismiss",
    action: "start",
    target: "plex",
  });
  await signIn(page);
  const sent = await answerExecute(page, success(seeded.intentId));

  await page.goto(link(seeded));
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "dismissed");
  expect(await stored(page)).toBe(seeded.token);

  await page.locator("[data-handoff-reopen]").click();
  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveAttribute("data-handoff-state", "dismissed");

  await page.locator("[data-handoff-discard]").click();
  await expect(panel(page)).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  expect(sent).toHaveLength(0);
});

test("HANDOFF-11 ignores a malformed fragment and leaves Avisos working", async ({
  page,
}) => {
  await signIn(page);
  const inspected = await countInspect(page);
  const sent = await answerExecute(page, { status: 200, json: { ok: true } });

  await page.goto(`/?view=alerts&host=${host}#intent=${"A".repeat(40)}`);

  await expect(page.locator('[data-view="alerts"]')).toBeVisible();
  await expect(page.locator("[data-digest-panel]")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  expect(inspected).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test("HANDOFF-12 keeps the token when inspect answers 401 and resumes after the reload", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "expiry",
    action: "start",
    target: "plex",
  });
  await signIn(page);
  let refused = false;
  await page.route(inspectPath, async (route) => {
    if (!refused) {
      refused = true;
      await route.fulfill({ status: 401, json: { error: "No autorizado" } });
      return;
    }
    await route.continue();
  });

  await page.goto(link(seeded));

  // The 401 reloads the page; the token survives in the tab and the second
  // inspect, now answered by the hub, opens the dialog.
  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(dialog(page)).toBeVisible();
  expect(refused).toBe(true);
  expect(await stored(page)).toBe(seeded.token);
});

test("HANDOFF-13 shows the channel of every recent operation and a label for backup-now and deploy-now", async ({
  page,
}) => {
  const rows = [
    ["e2e-handoff-op-hub", "restart", "hub"],
    ["e2e-handoff-op-telegram", "start", "telegram"],
    ["e2e-handoff-op-backup", "backup-now", "telegram"],
    ["e2e-handoff-op-deploy", "deploy-now", "telegram"],
  ] as const;
  for (const [id, action, channel] of rows)
    await database.query(
      `INSERT INTO operations
         (id, "hostId", "userId", action, target, status, detail, channel,
          "requestedBy")
       VALUES ($1, $2, $3, $4, $2, 'success', 'Hecho', $5, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, host, userId, action, channel],
    );
  await signIn(page);

  await page.goto(`/?view=alerts&host=${host}`);

  for (const [id, action, channel] of rows) {
    const row = page.locator(`[data-operation="${id}"]`);
    await expect(row).toHaveAttribute("data-operation-channel", channel);
    await expect(row).toHaveAttribute("data-operation-action", action);
  }
  for (const id of ["backup", "deploy"]) {
    const row = page.locator(`[data-operation="e2e-handoff-op-${id}"]`);
    const label = (await row.locator("strong").textContent())?.trim();
    expect(label).toBeTruthy();
    expect(label).not.toBe(await row.getAttribute("data-operation-action"));
  }
});

test("HANDOFF-14 offers a retry after a 503 that re-inspects and reopens the dialog without sending", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "retry",
    action: "start",
    target: "plex",
  });
  await signIn(page);
  const inspected = await countInspect(page);
  const sent = await answerExecute(page, {
    status: 503,
    json: { error: "El host no está conectado. No se ha enviado el comando." },
  });

  await page.goto(link(seeded));
  await dialog(page).locator("[data-confirm]").click();

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "failed");
  expect(sent).toHaveLength(1);
  expect(inspected).toHaveLength(1);
  // The token waits for the retry: nothing was consumed.
  expect(await stored(page)).toBe(seeded.token);

  await dialog(page).locator("button", { hasText: /^Cerrar$/ }).first().click();
  await page.locator("[data-handoff-retry]").click();

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "ready");
  await expect(dialog(page)).toBeVisible();
  expect(inspected).toHaveLength(2);
  expect(sent).toHaveLength(1);
});

test("HANDOFF-15 leaves an uncertain 502 pending with no retry", async ({
  page,
}) => {
  const seeded = await seedIntent({
    name: "uncertain",
    action: "start",
    target: "plex",
  });
  await signIn(page);
  const sent = await answerExecute(page, {
    status: 502,
    json: { error: "Resultado pendiente de verificar.", status: "pending" },
  });

  await page.goto(link(seeded));
  await dialog(page).locator("[data-confirm]").click();

  await expect(panel(page)).toHaveAttribute("data-handoff-state", "pending");
  await expect(page.locator("[data-handoff-retry]")).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(await stored(page)).toBeNull();
});

test("HANDOFF-16 explains the system browser in the passkey dialog and not in the exempt one", async ({
  page,
}) => {
  const protectedIntent = await seedIntent({
    name: "help-backup",
    action: "backup-now",
    target: host,
  });
  const exempt = await seedIntent({
    name: "help-start",
    action: "start",
    target: "plex",
  });
  await signIn(page);

  await page.goto(link(protectedIntent));
  await expect(dialog(page)).toHaveAttribute("data-verification-required", "true");
  await expect(dialog(page).locator("[data-handoff-passkey-help]")).toBeVisible();

  await page.goto(link(exempt));
  await expect(dialog(page)).toHaveAttribute("data-verification-required", "false");
  await expect(dialog(page).locator("[data-handoff-passkey-help]")).toHaveCount(0);
});
