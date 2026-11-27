import { expect, test, type Page } from "@playwright/test";
import { submitLogin } from "./login";

const email = "ci@hub.invalid";
const password = "Ci-only-password-not-used-in-production!";

type Violation = { directive: string; blocked: string };

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request, baseURL }) => {
  test.setTimeout(90_000);
  const state = await (await request.get("/api/setup")).json();
  if (state.required) {
    const response = await request.post("/api/setup", {
      headers: { Origin: new URL(baseURL!).origin },
      data: { token: process.env.SETUP_TOKEN, name: "Test", email, password },
    });
    expect(response.status()).toBe(200);
  }
});

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
