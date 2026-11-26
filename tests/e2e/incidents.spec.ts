import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { submitLogin } from "./login";

const email = "ci@hub.invalid";
const password = "Ci-only-password-not-used-in-production!";
const host = "nas-home";

test.describe.configure({ mode: "serial" });

let database: Client;
let targetId: number;
let actionId: number;
const digestDate = "2026-11-26";

async function seedIncidents() {
  // The digest projection always answers with the latest target. Clear other
  // dates so this seeded result is the only candidate of the walk.
  await database.query(
    `DELETE FROM digest_runs WHERE "date" <> $1`,
    [digestDate],
  );
  await database.query(
    `INSERT INTO digest_runs
       ("date", "targetAt", "periodStartAt", "dueAt", status, reason, payload)
     VALUES ($1, now() - interval '1 minute', now() - interval '25 hours',
             now() + interval '1 hour', 'failed', 'window_closed',
             'contenido privado del resumen')
     ON CONFLICT ("date") DO UPDATE
       SET "targetAt" = EXCLUDED."targetAt",
           "periodStartAt" = EXCLUDED."periodStartAt",
           "dueAt" = EXCLUDED."dueAt",
           status = EXCLUDED.status,
           reason = EXCLUDED.reason,
           payload = EXCLUDED.payload,
           "updatedAt" = now()`,
    [digestDate],
  );
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
  // A second open episode with a confirmed Telegram notice, reachable by its
  // own link so the action walk never depends on its position in the list.
  const actionInserted = await database.query<{ id: number }>(
    `INSERT INTO incidents
       ("hostId", key, title, detail, severity, at, fingerprint, seq, origin)
     VALUES ($1, 'e2e-incident-actions', 'Incidencia accionable', 'Detalle',
             'warning', now() - interval '2 hours', md5('e2e-actions'), 1, 'live')
     RETURNING id`,
    [host],
  );
  actionId = actionInserted.rows[0].id;
  await database.query(
    `INSERT INTO notification_outbox
       (key, "incidentId", kind, channel, status, revision, result,
        "chatId", "messageId")
     VALUES ($1, $2, 'incident-open', 'telegram', 'sent', 1,
             jsonb_build_object('state', 'sent', 'reason', NULL,
                                'at', now()::text), '42', '9')`,
    [`incident:${actionId}:open`, actionId],
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
  const digest = page.locator("[data-digest-panel]");
  await expect(digest).toHaveAttribute("data-digest-scope", "global");
  await expect(digest).toHaveAttribute("data-digest-state", "failed");
  await expect(digest).toHaveAttribute("data-digest-date", digestDate);
  await expect(digest).toHaveAttribute("data-digest-reason", "window_closed");
  await expect(page.locator("body")).not.toContainText(
    "contenido privado del resumen",
  );
  const row = page.locator(`[data-incident="${targetId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-incident-selected", "true");
  await expect(row).toHaveAttribute("data-severity", "critical");
  await expect(
    row.locator('[data-severity-indicator="critical"]'),
  ).toBeVisible();
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

test("INC-E2E-04 keeps the global digest result when the host changes", async ({
  page,
}) => {
  await page.context().clearCookies();
  const hosts = [
    {
      id: "nas-home",
      name: "NAS-HOME",
      role: "instance",
      connected: true,
      lastAt: new Date().toISOString(),
    },
    {
      id: "apps",
      name: "Apps",
      role: "apps-server",
      connected: true,
      lastAt: new Date().toISOString(),
    },
  ];
  await page.route("**/api/hosts", (route) =>
    route.fulfill({ json: { default: "nas-home", hosts } }),
  );
  // Only the second host is a fixture: every overview is built from the real
  // primary answer, so the digest block is always the one the hub projects. The
  // overview also carries the host directory, so every answer advertises both.
  await page.route("**/api/overview?*", async (route) => {
    const url = new URL(route.request().url());
    const requested = url.searchParams.get("host");
    const primaryUrl = new URL(url);
    primaryUrl.searchParams.delete("host");
    const response = await route.fetch({ url: primaryUrl.href });
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        hosts,
        ...(requested === "apps"
          ? { host: { id: "apps", name: "Apps", role: "apps-server" } }
          : {}),
      },
    });
  });

  await page.goto("/?view=alerts");
  await loginWithEmail(page);
  await expect(page.locator('[data-view="alerts"]')).toBeVisible();
  const digest = page.locator("[data-digest-panel]");
  await expect(digest).toHaveAttribute("data-digest-state", "failed");
  await expect(digest).toHaveAttribute("data-digest-date", digestDate);
  const target = await digest.getAttribute("data-digest-target");

  // A different host has its own overview, but the digest is global.
  await page.locator('[data-sidebar-host="apps"]').click();
  await expect(page.locator('[data-view="maintenance"]')).toBeVisible();
  await expect(page.locator(".page-content")).toHaveAttribute("data-host", "apps");

  await page.getByRole("button", { name: /^Avisos/ }).click();
  await expect(page.locator('[data-view="alerts"]')).toBeVisible();
  await expect(digest).toHaveAttribute("data-digest-state", "failed");
  await expect(digest).toHaveAttribute("data-digest-date", digestDate);
  await expect(digest).toHaveAttribute("data-digest-target", target!);
});

test("INC-E2E-05 acknowledges, silences and unsilences an episode from Avisos", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto(`/?view=alerts&host=${host}&incident=${actionId}`);
  await loginWithEmail(page);
  await expect(page.locator('[data-view="alerts"]')).toBeVisible();

  const row = page.locator(`[data-incident="${actionId}"]`);
  await expect(row).toBeVisible();
  const state = row.locator("[data-ack-state]");
  await expect(state).toHaveAttribute("data-ack-state", "none");
  await expect(state).toHaveAttribute("data-snooze-state", "none");
  await expect(row.locator('[data-action="acknowledge"]')).toBeVisible();
  await expect(row.locator('[data-action="snooze-1h"]')).toBeVisible();
  await expect(row.locator('[data-action="snooze-24h"]')).toBeVisible();

  await row.locator('[data-action="acknowledge"]').click();
  await expect(state).toHaveAttribute("data-ack-state", "acknowledged");
  await expect(state).toHaveAttribute("data-ack-via", "hub");
  await expect(row.locator('[data-action="acknowledge"]')).toHaveCount(0);
  const acknowledged = await database.query<{
    acknowledgedVia: string;
    acknowledgedBy: string;
  }>(
    `SELECT "acknowledgedVia", "acknowledgedBy" FROM incidents WHERE id = $1`,
    [actionId],
  );
  expect(acknowledged.rows[0]).toMatchObject({
    acknowledgedVia: "hub",
    acknowledgedBy: "Test",
  });

  const before = Date.now();
  await row.locator('[data-action="snooze-1h"]').click();
  await expect(state).toHaveAttribute("data-snooze-state", "active");
  await expect(row.locator('[data-action="unsnooze"]')).toBeVisible();
  await expect(row.locator('[data-action="snooze-1h"]')).toHaveCount(0);
  await expect(row.locator('[data-action="snooze-24h"]')).toHaveCount(0);
  const until = await state.getAttribute("data-snooze-until");
  expect(new Date(until!).getTime()).toBeGreaterThan(before);
  const silenced = await database.query(
    `SELECT 1 FROM incident_snoozes WHERE "hostId" = $1 AND key = 'e2e-incident-actions'`,
    [host],
  );
  expect(silenced.rowCount).toBe(1);

  await row.locator('[data-action="unsnooze"]').click();
  await expect(state).toHaveAttribute("data-snooze-state", "none");
  await expect(row.locator('[data-action="snooze-1h"]')).toBeVisible();
  await expect(row.locator('[data-action="snooze-24h"]')).toBeVisible();
  const cleared = await database.query(
    `SELECT 1 FROM incident_snoozes WHERE "hostId" = $1 AND key = 'e2e-incident-actions'`,
    [host],
  );
  expect(cleared.rowCount).toBe(0);
});
