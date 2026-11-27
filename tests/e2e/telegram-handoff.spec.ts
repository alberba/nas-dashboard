import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  expect,
  test,
  type Cookie,
  type Page,
  type Request,
} from "@playwright/test";

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
