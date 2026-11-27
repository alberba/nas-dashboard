import { expect, test, type Cookie, type Page } from "@playwright/test";
import { submitLogin } from "./login";

const email = "ci@hub.invalid";
const password = "Ci-only-password-not-used-in-production!";

type Violation = { directive: string; blocked: string };

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

/**
 * Records every CSP violation in the document so a test can assert the array
 * stays empty. It runs before any page script, including the framework ones.
 */
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const collected: { directive: string; blocked: string }[] = [];
    Object.defineProperty(window, "__cspViolations", { value: collected });
    document.addEventListener("securitypolicyviolation", (event) => {
      collected.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      });
    });
  });
}

async function violations(page: Page): Promise<Violation[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __cspViolations: Violation[] }).__cspViolations,
  );
}

/** Parses a policy into directive name → sources, so assertions name directives. */
function directives(policy: string) {
  const parsed = new Map<string, string>();
  for (const raw of policy.split(";")) {
    const [name, ...sources] = raw.trim().split(/\s+/);
    if (name) parsed.set(name.toLowerCase(), sources.join(" "));
  }
  return parsed;
}

function nonceOf(policy: string) {
  const match = /'nonce-([^']+)'/.exec(policy);
  if (!match) throw new Error("policy has no nonce");
  return match[1];
}

function expectConservativeHsts(value: string | undefined) {
  expect(value).toBeDefined();
  const tokens = value!.split(";").map((token) => token.trim());
  expect(tokens).toContain("max-age=15552000");
  expect(value!.toLowerCase()).not.toContain("includesubdomains");
  expect(value!.toLowerCase()).not.toContain("preload");
}

test("the login loads under a fresh nonce policy, hydrates and signs in without violations", async ({
  page,
}) => {
  await watchViolations(page);

  const first = await page.goto("/");
  const firstPolicy = first?.headers()["content-security-policy"];
  expect(firstPolicy).toBeTruthy();
  const firstDirectives = directives(firstPolicy!);
  expect(firstDirectives.get("script-src")).toContain("'nonce-");
  expect(firstDirectives.get("script-src")).toContain("'strict-dynamic'");
  expect(firstDirectives.get("frame-ancestors")).toBe("'none'");
  const firstNonce = nonceOf(firstPolicy!);

  const second = await page.reload();
  const secondPolicy = second?.headers()["content-security-policy"];
  expect(secondPolicy).toBeTruthy();
  expect(nonceOf(secondPolicy!)).not.toBe(firstNonce);

  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await submitLogin(page);
  await expect(page.locator('[data-view="summary"]')).toBeVisible();

  expect(await violations(page)).toEqual([]);
});

test("the authenticated panel loads without violations", async ({ page }) => {
  await signIn(page);
  await watchViolations(page);

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toBeTruthy();
  await expect(page.locator('[data-view="summary"]')).toBeVisible();

  expect(await violations(page)).toEqual([]);
});

test("an unknown route answers 404 with a nonce policy and no violations", async ({
  page,
}) => {
  await signIn(page);
  await watchViolations(page);

  const response = await page.goto("/esta-ruta-no-existe-06-02");
  expect(response?.status()).toBe(404);
  const policy = response?.headers()["content-security-policy"];
  expect(policy).toBeTruthy();
  const parsed = directives(policy!);
  expect(parsed.get("script-src")).toContain("'nonce-");
  expect(parsed.get("frame-ancestors")).toBe("'none'");
  await page.waitForLoadState("load");

  expect(await violations(page)).toEqual([]);
});

test("the service worker registers and runs without violations", async ({
  page,
}) => {
  await signIn(page);
  await watchViolations(page);
  await page.goto("/");
  await expect(page.locator('[data-view="summary"]')).toBeVisible();

  const worker = await page.evaluate(async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    return registration?.active?.scriptURL ?? null;
  });
  expect(worker).toMatch(/\/sw\.js$/);
  expect(await violations(page)).toEqual([]);
});

test("the API and document responses compose HSTS and their own CSP", async ({
  request,
}) => {
  const api = await request.get("/api/setup");
  expect(api.status()).toBe(200);
  expectConservativeHsts(api.headers()["strict-transport-security"]);
  const apiPolicy = api.headers()["content-security-policy"];
  expect(apiPolicy).toBeTruthy();
  const apiDirectives = directives(apiPolicy!);
  expect(apiDirectives.get("default-src")).toBe("'none'");
  expect(apiDirectives.get("frame-ancestors")).toBe("'none'");

  const document = await request.get("/");
  expect(document.status()).toBe(200);
  expectConservativeHsts(document.headers()["strict-transport-security"]);
  const documentPolicy = document.headers()["content-security-policy"];
  expect(documentPolicy).toBeTruthy();
  const documentDirectives = directives(documentPolicy!);
  expect(documentDirectives.get("script-src")).toContain("'nonce-");
  expect(documentDirectives.get("default-src")).not.toBe("'none'");
});
