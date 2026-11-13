import {
  expect,
  test,
  type Cookie,
  type Page,
  type Request,
} from "@playwright/test";

const email = "ci@hub.invalid",
  password = "Ci-only-password-not-used-in-production!";

// The harness page mounts the reusable confirmation exactly as a consumer
// would, against a sensitive endpoint the tests answer through page.route.
const harness = "/e2e/sensitive-action";
const endpoint = "**/api/containers/remove*";

test.describe.configure({ mode: "serial" });

// One password sign-in for the whole file: Better Auth rate-limits sign-ins.
let session: Cookie[] = [];

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

async function signIn(page: Page) {
  await page.context().addCookies(session);
}

/** Records every request sent to the sensitive endpoint and answers them in order. */
async function answerAction(
  page: Page,
  responses: { status: number; json: unknown }[],
) {
  const sent: Request[] = [];
  await page.route(endpoint, async (route) => {
    sent.push(route.request());
    const next = responses[Math.min(sent.length, responses.length) - 1];
    await route.fulfill({ status: next.status, json: next.json });
  });
  return sent;
}

const dialog = (page: Page) => page.getByRole("dialog");
const trigger = (page: Page) => page.locator("[data-harness-trigger]");

test("the confirmation is a modal dialog that keeps and returns focus and closes with Escape", async ({
  page,
}) => {
  await signIn(page);
  const sent = await answerAction(page, [{ status: 200, json: {} }]);
  await page.goto(harness);
  await trigger(page).click();

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("aria-labelledby", /.+/);
  await expect(dialog(page).locator("[data-consequence]")).not.toHaveCount(0);
  expect(
    await dialog(page).evaluate((node) =>
      node.contains(document.activeElement),
    ),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(sent).toHaveLength(0);
});

async function addPasskey(page: Page) {
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
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Añadir", exact: true }).click();
  await expect(page.locator(".notice.success")).toBeVisible();
}

const confirm = (page: Page) => dialog(page).locator("[data-confirm]");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("without a recent passkey the confirmation verifies it first and then sends the action once", async ({
  page,
}) => {
  await signIn(page);
  await addPasskey(page);
  const sent = await answerAction(page, [
    { status: 200, json: { status: "success" } },
  ]);
  await page.goto(harness);
  await trigger(page).click();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-method",
    "passkey",
  );
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-recent",
    "false",
  );

  await confirm(page).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator("[data-harness-outcome]")).toHaveAttribute(
    "data-harness-outcome",
    "succeeded",
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].headers()["idempotency-key"]).toMatch(uuid);
  const verification = await page.request.get("/api/verification");
  expect(await verification.json()).toMatchObject({ recent: true });
});

test("a verification the server rejects asks again and resends only on an explicit confirm, with the same key", async ({
  page,
}) => {
  await signIn(page);
  await addPasskey(page);
  // The status check still says recent, but it expires before the action arrives.
  await page.route("**/api/verification", (route) =>
    route.fulfill({
      json: {
        method: "passkey",
        recent: true,
        reason: null,
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        ttlSeconds: 300,
      },
    }),
  );
  const sent = await answerAction(page, [
    {
      status: 403,
      json: {
        code: "recent_verification_required",
        reason: "expired",
        method: "passkey",
        error: "Necesitas verificar tu identidad para continuar.",
        verifiedAt: null,
        expiresAt: null,
      },
    },
    { status: 200, json: { status: "success" } },
  ]);
  await page.goto(harness);
  await trigger(page).click();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-recent",
    "true",
  );

  await confirm(page).click();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-recent",
    "false",
  );
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-reason",
    "expired",
  );
  await expect(confirm(page)).toBeEnabled();
  expect(sent).toHaveLength(1);

  await confirm(page).click();
  await expect(dialog(page)).toBeHidden();
  expect(sent).toHaveLength(2);
  expect(sent[1].headers()["idempotency-key"]).toBe(
    sent[0].headers()["idempotency-key"],
  );
});

async function recentVerification(page: Page, method: "passkey" | "password") {
  await page.route("**/api/verification", (route) =>
    route.fulfill({
      json: {
        method,
        recent: true,
        reason: null,
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        ttlSeconds: 300,
      },
    }),
  );
}

test("an uncertain result stays pending and is never sent again", async ({
  page,
}) => {
  await signIn(page);
  await recentVerification(page, "passkey");
  const sent = await answerAction(page, [
    {
      status: 502,
      json: { status: "pending", error: "Resultado pendiente de verificar." },
    },
  ]);
  await page.goto(harness);
  await trigger(page).click();
  await confirm(page).click();

  await expect(dialog(page)).toHaveAttribute("data-phase", "pending");
  await expect(confirm(page)).toHaveCount(0);
  await expect(page.locator("[data-harness-outcome]")).toHaveAttribute(
    "data-harness-outcome",
    "pending",
  );
  expect(sent).toHaveLength(1);

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  expect(sent).toHaveLength(1);
});

test("on the alternative domain the password verifies the Operator before the action is sent", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/verification", (route) =>
    route.fulfill({
      json: {
        method: "password",
        recent: false,
        reason: "missing",
        verifiedAt: null,
        expiresAt: null,
        ttlSeconds: 300,
      },
    }),
  );
  const checks: Request[] = [];
  await page.route("**/api/verification/password", async (route) => {
    checks.push(route.request());
    const valid = route.request().postDataJSON().password === password;
    await route.fulfill(
      valid
        ? {
            json: {
              method: "password",
              recent: true,
              reason: null,
              verifiedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              ttlSeconds: 300,
            },
          }
        : {
            status: 403,
            json: {
              code: "invalid_password",
              method: "password",
              error: "La contraseña no es correcta.",
            },
          },
    );
  });
  const sent = await answerAction(page, [
    { status: 200, json: { status: "success" } },
  ]);
  await page.goto(harness);
  await trigger(page).click();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-method",
    "password",
  );
  const field = dialog(page).getByLabel("Contraseña", { exact: true });
  await expect(field).toHaveAttribute("type", "password");

  await field.fill("not-the-password");
  await confirm(page).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  expect(checks).toHaveLength(1);
  expect(sent).toHaveLength(0);

  await field.fill(password);
  await confirm(page).click();
  await expect(dialog(page)).toBeHidden();
  expect(checks).toHaveLength(2);
  expect(checks[1].headers()["origin"]).toBeTruthy();
  expect(sent).toHaveLength(1);
});

test("the action stays disabled until the exact name is typed and the manual steps are acknowledged", async ({
  page,
}) => {
  await signIn(page);
  await recentVerification(page, "passkey");
  const sent = await answerAction(page, [
    { status: 200, json: { status: "success" } },
  ]);
  await page.goto(`${harness}?typed=homarr-preview&acknowledge=1`);
  await trigger(page).click();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-recent",
    "true",
  );
  const name = dialog(page).locator("[data-typed-confirmation]");
  const acknowledged = dialog(page).getByRole("checkbox");
  await expect(name).toBeFocused();
  await expect(confirm(page)).toBeDisabled();

  await name.fill("homarr-previe");
  await acknowledged.check();
  await expect(confirm(page)).toBeDisabled();
  await name.fill("homarr-preview");
  await acknowledged.uncheck();
  await expect(confirm(page)).toBeDisabled();
  await acknowledged.check();
  await expect(confirm(page)).toBeEnabled();

  await confirm(page).click();
  await expect(dialog(page)).toBeHidden();
  expect(sent).toHaveLength(1);
});

test("a consumer can hand over the key of an action the server already refused", async ({
  page,
}) => {
  await signIn(page);
  await recentVerification(page, "passkey");
  const sent = await answerAction(page, [
    { status: 200, json: { status: "success" } },
  ]);
  const key = "6f1b8d64-3f5a-4c1e-9f1d-2b7c9e0a4d11";
  await page.goto(`${harness}?key=${key}`);
  await trigger(page).click();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-recent",
    "true",
  );
  await confirm(page).click();
  await expect(dialog(page)).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0].headers()["idempotency-key"]).toBe(key);
});

test("a definitive rejection is shown as failed and offers no resend", async ({
  page,
}) => {
  await signIn(page);
  await recentVerification(page, "passkey");
  const sent = await answerAction(page, [
    {
      status: 400,
      json: { status: "failed", error: "El contenedor está en ejecución." },
    },
  ]);
  await page.goto(harness);
  await trigger(page).click();
  await expect(dialog(page)).toHaveAttribute(
    "data-verification-recent",
    "true",
  );
  await confirm(page).click();
  await expect(dialog(page)).toHaveAttribute("data-phase", "failed");
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await expect(confirm(page)).toHaveCount(0);
  await expect(page.locator("[data-harness-outcome]")).toHaveAttribute(
    "data-harness-outcome",
    "failed",
  );
  expect(sent).toHaveLength(1);
});

test("an HTTP 200 replay with pending state remains uncertain and is never sent again", async ({
  page,
}) => {
  await signIn(page);
  await recentVerification(page, "passkey");
  const sent = await answerAction(page, [
    { status: 200, json: { status: "pending" } },
  ]);
  await page.goto(harness);
  await trigger(page).click();
  await confirm(page).click();
  await expect(dialog(page)).toHaveAttribute("data-phase", "pending");
  expect(sent).toHaveLength(1);
});
