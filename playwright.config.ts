import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3000/api/setup",
    reuseExistingServer: !process.env.CI,
  },
});
