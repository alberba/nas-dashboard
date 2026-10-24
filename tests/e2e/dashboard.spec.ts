import { expect, test } from "@playwright/test";
const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  const state = await (await request.get("/api/setup")).json();
  if (state.required) {
    const response = await request.post("/api/setup", {
      headers: { Origin: "http://localhost:3000" },
      data: { token: process.env.SETUP_TOKEN, name: "Test", email, password },
    });
    expect(response.status()).toBe(200);
  }
});
test("private endpoints require authentication and public signup stays closed", async ({
  request,
}) => {
  expect((await request.get("/api/overview")).status()).toBe(401);
  expect((await request.get("/api/files?root=media")).status()).toBe(401);
  const signup = await request.post("/api/auth/sign-up/email", {
    headers: { Origin: "http://localhost:3000" },
    data: { email: "intruder@hub.invalid", password, name: "Other" },
  });
  expect(signup.ok()).toBe(false);
  const setup = await request.post("/api/setup", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      token: process.env.SETUP_TOKEN,
      email: "other@hub.invalid",
      password,
      name: "Other",
    },
  });
  expect(setup.status()).toBe(403);
});
test("login, navigation, origin checks and mobile layout", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  const forbidden = await page.request.post("/api/presence", {
    headers: { Origin: "https://evil.invalid" },
    data: { id: "3f9bde9b-a17f-40d3-85d7-5b6b0ca0d2c6", visible: true },
  });
  expect(forbidden.status()).toBe(403);
  await page.getByRole("button", { name: "Aplicaciones", exact: true }).click();
  await expect(page.locator('[data-view="apps"]')).toBeVisible();
  await expect(page.getByRole("link", { name: /Jellyfin/ })).toHaveAttribute(
    "href",
    /https:\/\/jellyfin\./,
  );
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.locator('[data-view="settings"]')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Cerrar sesión", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
});
test("registers a passkey and signs in with it", async ({ page }) => {
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
  await page.goto("/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page.getByRole("button", { name: "Añadir", exact: true }).click();
  await expect(page.locator(".notice.success")).toBeVisible();
  await page
    .getByRole("button", { name: "Cerrar sesión", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Entrar con passkey", exact: true })
    .click();
  await expect(page.locator('[data-view="summary"]')).toBeVisible();
});
