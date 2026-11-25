import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { submitLogin } from "./login";

const email = "ci@hub.invalid";
const password = "Ci-only-password-not-used-in-production!";
const host = "nas-home";

test.describe.configure({ mode: "serial" });

let database: Client;
let targetId: number;

async function seedIncidents() {
  await database.query(
    `DELETE FROM notification_outbox
      WHERE "incidentId" IN (
        SELECT id FROM incidents WHERE key LIKE 'e2e-incident-%'
      )`,
  );
  await database.query(
    `DELETE FROM incidents WHERE key LIKE 'e2e-incident-%'`,
  );
  await database.query(`
    INSERT INTO incidents
      ("hostId", key, title, detail, severity, at, fingerprint, seq, origin)
    SELECT $1,
           'e2e-incident-filler-' || i,
           'Relleno ' || i,
           '',
           'warning',
           now() - (i || ' seconds')::interval,
           md5('e2e-filler-' || i),
           1,
           'live'
    FROM generate_series(1, 105) AS i
  `, [host]);
  const inserted = await database.query<{ id: number }>(
    `INSERT INTO incidents
       ("hostId", key, title, detail, severity, at, fingerprint, seq, origin)
     VALUES ($1, 'e2e-incident-target', 'Incidencia enlazada', 'Detalle', 'critical',
             now() - interval '3 hours', md5('e2e-target'), 2, 'live')
     RETURNING id`,
    [host],
  );
  targetId = inserted.rows[0].id;
  await database.query(
    `INSERT INTO notification_outbox
       (key, "incidentId", kind, channel, status, revision, result,
        "fallbackResult")
     VALUES ($1, $2, 'incident-open', 'telegram', 'sent', 2,
             jsonb_build_object('state', 'sent', 'reason', NULL,
                                'at', now()::text),
             jsonb_build_object('state', 'failed', 'reason',
                                'endpoint_rejected', 'at', now()::text))`,
    [`incident:${targetId}:open`, targetId],
  );
  await database.query(
    `INSERT INTO notification_outbox
       (key, "incidentId", kind, channel, status, revision, "editResult",
        "chatId", "messageId")
     VALUES ($1, $2, 'incident-edit', 'telegram', 'uncertain', 2,
             jsonb_build_object('state', 'uncertain', 'reason',
                                'endpoint_uncertain', 'at', now()::text),
             '42', '9')`,
    [`incident:${targetId}:edit:2`, targetId],
  );
}

function deepLink() {
  return `/?view=alerts&host=${host}&incident=${targetId}`;
}

async function loginWithEmail(page: import("@playwright/test").Page) {
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await submitLogin(page);
  // The destination may already be Avisos or any other authenticated view.
  await expect(page.locator("[data-view]").first()).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  const state = await (await request.get("/api/setup")).json();
  if (state.required) {
    const response = await request.post("/api/setup", {
      headers: { Origin: "http://localhost:3000" },
      data: { token: process.env.SETUP_TOKEN, name: "Test", email, password },
    });
    expect(response.status()).toBe(200);
  }
  database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  await seedIncidents();
});

test.afterAll(async () => {
  await database.end();
});

test("INC-E2E-01 opens an episode older than the 100 recent through email login", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto(deepLink());
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`incident=${targetId}`));

  await loginWithEmail(page);
  await expect(page).toHaveURL(
    new RegExp(`view=alerts.*incident=${targetId}|incident=${targetId}.*view=alerts`),
  );
  await expect(page.locator('[data-view="alerts"]')).toBeVisible();
  const row = page.locator(`[data-incident="${targetId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-delivery-state", "sent");
  await expect(
    page.locator(
      '[data-delivery-part="fallback"][data-delivery-state="failed"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-delivery-part="last-update"][data-delivery-state="uncertain"]',
    ),
  ).toBeVisible();
});

test("INC-E2E-02 keeps the episode link after signing in with a passkey", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/");
  await loginWithEmail(page);
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.locator('[data-view="settings"]')).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.getByRole("button", { name: "Añadir", exact: true }).click();
  await expect(page.locator(".notice.success")).toBeVisible();
  await page
    .getByRole("button", { name: "Cerrar sesión", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();

  await page.goto(deepLink());
  await page
    .getByRole("button", { name: "Entrar con passkey", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`view=alerts.*incident=${targetId}|incident=${targetId}.*view=alerts`),
  );
  await expect(page.locator(`[data-incident="${targetId}"]`)).toBeVisible();
});

test("INC-E2E-03 returns to the same episode after a session expiry", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto(deepLink());
  await loginWithEmail(page);
  const row = page.locator(`[data-incident="${targetId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();

  // Invalidate the session without navigating: the dashboard's next visible
  // refresh receives the real 401 and must keep the episode in the destination.
  await page.context().clearCookies();
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(new RegExp(`incident=${targetId}`));

  await loginWithEmail(page);
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`incident=${targetId}`));
});
