import { test, type Page } from "@playwright/test";
/** Auth rate limits remain enabled. Only a refused login can be retried. */
export async function submitLogin(page: Page) {
  test.setTimeout(90_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/api/auth/sign-in/email") &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    const result = await response;
    if (result.status() !== 429) return;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(15, Number(result.headers()["x-retry-after"] ?? 10) + 1) *
          1000,
      ),
    );
  }
  throw new Error("Login remained rate-limited");
}
