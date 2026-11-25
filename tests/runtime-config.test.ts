import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readRuntimeConfig,
  RuntimeConfigError,
} from "@/lib/runtime-config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const preflightScript = path.join(repoRoot, "scripts", "check-runtime-config.ts");

const CONFIG_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "TRUSTED_ORIGINS",
  "SETUP_TOKEN",
  "NAS_HOSTS",
  "NAS_AGENT_URL",
  "AGENT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "PUSH_WARNINGS",
  "__NEXT_PROCESSED_ENV",
] as const;

/** Same shape as `.github/workflows/ci.yml`. */
const ciEnv: Record<string, string> = {
  DATABASE_URL: "postgresql://hub:ci-only-password@127.0.0.1:5432/hub",
  BETTER_AUTH_SECRET: "ci-only-auth-secret-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  TRUSTED_ORIGINS: "http://localhost:3000",
  SETUP_TOKEN: "ci-only-setup-token-at-least-thirty-two-characters",
  NAS_AGENT_URL: "http://127.0.0.1:9450",
  AGENT_TOKEN: "ci-only-agent-token-at-least-thirty-two-characters",
};

const fileEnv: Record<string, string> = {
  DATABASE_URL: "postgresql://hub:hub@127.0.0.1:5432/hub",
  BETTER_AUTH_SECRET: "file-auth-secret-with-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  TRUSTED_ORIGINS: "http://localhost:3000",
  SETUP_TOKEN: "file-setup-token-with-at-least-32-characters",
  NAS_AGENT_URL: "http://127.0.0.1:9450",
  AGENT_TOKEN: "file-agent-token-with-at-least-32-characters",
};

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {
    ...ciEnv,
    ...overrides,
  };
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) delete result[key];
  }
  return result;
}

function errorFor(
  overrides: Record<string, string | undefined>,
): RuntimeConfigError {
  try {
    readRuntimeConfig(env(overrides));
  } catch (error) {
    if (error instanceof RuntimeConfigError) return error;
    throw error;
  }
  throw new Error("expected readRuntimeConfig to reject the environment");
}

function issuesOf(
  overrides: Record<string, string | undefined>,
): Array<{ variable: string; reason: string }> {
  return errorFor(overrides).issues;
}

function dotenv(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function cleanEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const result: Record<string, string | undefined> = { ...process.env };
  for (const key of CONFIG_KEYS) delete result[key];
  result.NODE_ENV = "production";
  return { ...result, ...overrides } as NodeJS.ProcessEnv;
}

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, options.timeoutMs ?? 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runPreflight(
  files: Record<string, string>,
  processEnv: Record<string, string> = {},
): Promise<ProcessResult> {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-runtime-config-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(path.join(directory, name), contents);
    }
    return await runProcess(tsxBin, [preflightScript], {
      cwd: directory,
      env: cleanEnv(processEnv),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("readRuntimeConfig", () => {
  it("accepts the CI environment without Telegram or VAPID", () => {
    const config = readRuntimeConfig({ ...ciEnv });
    expect(config.databaseUrl).toBe(ciEnv.DATABASE_URL);
    expect(config.betterAuthSecret).toBe(ciEnv.BETTER_AUTH_SECRET);
    expect(config.betterAuthUrl).toBe("http://localhost:3000");
    expect(config.setupToken).toBe(ciEnv.SETUP_TOKEN);
    expect(config.trustedOrigins).toEqual(["http://localhost:3000"]);
    expect(config.hosts).toHaveLength(1);
    expect(config.hosts[0]).toMatchObject({ id: "nas-home", role: "instance" });
  });

  it("accepts a multi-host NAS_HOSTS list", () => {
    const config = readRuntimeConfig(
      env({
        NAS_HOSTS: JSON.stringify([
          {
            id: "nas-home",
            name: "NAS",
            role: "instance",
            url: "http://127.0.0.1:9450",
            token: "multi-host-instance-token-at-least-32-chars",
          },
          {
            id: "apps",
            name: "Apps",
            role: "apps-server",
            url: "http://127.0.0.1:9450",
            token: "multi-host-apps-token-at-least-32-chars",
          },
        ]),
        NAS_AGENT_URL: undefined,
        AGENT_TOKEN: undefined,
      }),
    );
    expect(config.hosts.map((host) => host.id)).toEqual(["nas-home", "apps"]);
  });

  it("defaults trusted origins to the canonical URL", () => {
    const config = readRuntimeConfig(env({ TRUSTED_ORIGINS: undefined }));
    expect(config.trustedOrigins).toEqual(["http://localhost:3000"]);
  });

  it.each([
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "SETUP_TOKEN",
    "BETTER_AUTH_URL",
  ])("rejects a missing %s", (variable) => {
    const issues = issuesOf({ [variable]: undefined });
    expect(issues).toContainEqual({ variable, reason: "missing" });
  });

  it.each([
    ["DATABASE_URL", "postgresql://hub:change-me@db:5432/hub"],
    ["DATABASE_URL", "postgresql://hub:change%2Dme@db:5432/hub"],
    [
      "BETTER_AUTH_SECRET",
      "replace-with-a-random-secret-of-at-least-32-characters",
    ],
    [
      "SETUP_TOKEN",
      "replace-with-a-random-secret-of-at-least-32-characters",
    ],
    [
      "BETTER_AUTH_SECRET",
      "build-placeholder-never-used-at-runtime-32",
    ],
    ["BETTER_AUTH_URL", "https://hub.example.com"],
    ["TRUSTED_ORIGINS", "https://hub.example.com"],
  ])("rejects the example value in %s", (variable, value) => {
    const issues = issuesOf({ [variable]: value });
    expect(issues).toContainEqual({ variable, reason: "example" });
  });

  it.each([
    "mysql://hub:hub@db:5432/hub",
    "postgresql://db:5432/hub",
    "postgresql://hub@db:5432/hub",
    "postgresql://hub:hub@db:5432",
    "not a url",
  ])("rejects an unusable DATABASE_URL: %s", (value) => {
    const issues = issuesOf({ DATABASE_URL: value });
    expect(issues).toContainEqual({
      variable: "DATABASE_URL",
      reason: "invalid",
    });
  });

  it("rejects plain HTTP for a public canonical URL", () => {
    const issues = issuesOf({ BETTER_AUTH_URL: "http://hub.example.org" });
    expect(issues).toContainEqual({
      variable: "BETTER_AUTH_URL",
      reason: "insecure",
    });
  });

  it("accepts HTTPS and loopback HTTP canonical URLs", () => {
    for (const value of [
      "https://hub.example.org",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      expect(() =>
        readRuntimeConfig(env({ BETTER_AUTH_URL: value })),
      ).not.toThrow();
    }
  });

  it.each([
    "https://user:pass@hub.example.org",
    "https://hub.example.org/path",
    "https://hub.example.org/?x=1",
    "https://hub.example.org/#x",
    "ftp://hub.example.org",
  ])("rejects a canonical URL with extra parts: %s", (value) => {
    const issues = issuesOf({ BETTER_AUTH_URL: value });
    expect(issues).toContainEqual({
      variable: "BETTER_AUTH_URL",
      reason: "invalid",
    });
  });

  it("validates every trusted origin", () => {
    const config = readRuntimeConfig(
      env({
        TRUSTED_ORIGINS:
          "https://hub.example.org, http://localhost:3000, https://hub.example.org",
      }),
    );
    expect(config.trustedOrigins).toEqual([
      "https://hub.example.org",
      "http://localhost:3000",
    ]);

    expect(
      issuesOf({ TRUSTED_ORIGINS: "http://public.example.org" }),
    ).toContainEqual({ variable: "TRUSTED_ORIGINS", reason: "insecure" });
  });

  it("rejects a partial legacy host pair", () => {
    const issues = issuesOf({
      NAS_AGENT_URL: undefined,
      AGENT_TOKEN: "legacy-agent-token-at-least-32-characters",
    });
    expect(issues).toContainEqual({
      variable: "NAS_AGENT_URL/AGENT_TOKEN",
      reason: "incomplete_pair",
    });
  });

  it("rejects a missing host configuration", () => {
    const issues = issuesOf({
      NAS_AGENT_URL: undefined,
      AGENT_TOKEN: undefined,
    });
    expect(issues).toContainEqual({
      variable: "NAS_AGENT_URL/AGENT_TOKEN",
      reason: "missing",
    });
  });

  it("rejects invalid NAS_HOSTS JSON", () => {
    const issues = issuesOf({ NAS_HOSTS: "not-json" });
    expect(issues).toContainEqual({ variable: "NAS_HOSTS", reason: "invalid" });
  });

  it("rejects example host tokens and URLs", () => {
    expect(
      issuesOf({ AGENT_TOKEN: "the-same-secret-as-the-nas-agent" }),
    ).toContainEqual({
      variable: "NAS_AGENT_URL/AGENT_TOKEN",
      reason: "example",
    });
    expect(
      issuesOf({ NAS_AGENT_URL: "http://your-nas-tailscale-ip:9450" }),
    ).toContainEqual({
      variable: "NAS_AGENT_URL/AGENT_TOKEN",
      reason: "example",
    });
  });

  it("never includes rejected values in the diagnostic", () => {
    const error = errorFor({
      DATABASE_URL: "mysql://hub:top-secret-password@db:5432/hub",
      BETTER_AUTH_SECRET: "change-me-synthetic-value-that-must-not-leak",
    });
    expect(error.message).toContain("DATABASE_URL (invalid)");
    expect(error.message).toContain("BETTER_AUTH_SECRET (example)");
    expect(error.message).not.toContain("top-secret-password");
    expect(error.message).not.toContain("synthetic-value");
  });
});

describe("check-runtime-config preflight", () => {
  it("accepts a configuration supplied only by .env.local", async () => {
    const result = await runPreflight({ ".env.local": dotenv(fileEnv) });
    expect(result.code).toBe(0);
  });

  it("accepts a configuration supplied only by .env", async () => {
    const result = await runPreflight({ ".env": dotenv(fileEnv) });
    expect(result.code).toBe(0);
  });

  it("lets the process environment win over .env.local", async () => {
    const result = await runPreflight(
      {
        ".env.local": dotenv({
          ...fileEnv,
          BETTER_AUTH_SECRET: "change-me",
        }),
      },
      {
        BETTER_AUTH_SECRET:
          "process-auth-secret-with-at-least-32-characters",
      },
    );
    expect(result.code).toBe(0);
  });

  it("fails when the process environment carries an example value", async () => {
    const result = await runPreflight(
      { ".env.local": dotenv(fileEnv) },
      { BETTER_AUTH_SECRET: "change-me" },
    );
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("BETTER_AUTH_SECRET");
  });

  it("does not hide a higher-priority invalid value behind .env", async () => {
    const result = await runPreflight({
      ".env": dotenv(fileEnv),
      ".env.local": dotenv({
        DATABASE_URL: "postgresql://hub:change-me@127.0.0.1:5432/hub",
      }),
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("DATABASE_URL");
  });

  it("reads .env.production.local before .env.local", async () => {
    const preferred = await runPreflight({
      ".env.local": dotenv({ ...fileEnv, BETTER_AUTH_SECRET: "change-me" }),
      ".env.production.local": dotenv(fileEnv),
    });
    expect(preferred.code).toBe(0);

    const rejected = await runPreflight({
      ".env.local": dotenv(fileEnv),
      ".env.production.local": dotenv({
        ...fileEnv,
        BETTER_AUTH_SECRET: "change-me",
      }),
    });
    expect(rejected.code).not.toBe(0);
  });

  it("reads .env.production before .env", async () => {
    const result = await runPreflight({
      ".env": dotenv({ ...fileEnv, BETTER_AUTH_SECRET: "change-me" }),
      ".env.production": dotenv(fileEnv),
    });
    expect(result.code).toBe(0);
  });

  it("does not print rejected values", async () => {
    const result = await runPreflight({
      ".env.local": dotenv({
        ...fileEnv,
        DATABASE_URL:
          "postgresql://hub:top-secret-password@127.0.0.1:5432/hub",
        BETTER_AUTH_SECRET: "change-me-synthetic-value-that-must-not-leak",
      }),
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).not.toBe(0);
    expect(output).toContain("BETTER_AUTH_SECRET");
    expect(output).not.toContain("change-me");
    expect(output).not.toContain("top-secret-password");
  });

  it("fails pnpm start before Next starts when the environment is invalid", async () => {
    const result = await runProcess("pnpm", ["start"], {
      cwd: repoRoot,
      env: cleanEnv({
        ...ciEnv,
        DATABASE_URL: "postgresql://hub:change-me@127.0.0.1:5432/hub",
      }),
      timeoutMs: 30_000,
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("DATABASE_URL");
    expect(result.stdout).not.toMatch(/Ready in|started server|Local:/i);
  });

  it("keeps forwarding start arguments to next start", async () => {
    const result = await runProcess(
      "pnpm",
      ["start", "--hostname", "0.0.0.0"],
      {
        cwd: repoRoot,
        env: cleanEnv({
          ...ciEnv,
          DATABASE_URL: "postgresql://hub:change-me@127.0.0.1:5432/hub",
        }),
        timeoutMs: 30_000,
      },
    );
    expect(result.code).not.toBe(0);

    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const start = packageJson.scripts.start;
    expect(start).toContain("scripts/check-runtime-config.ts");
    expect(start.indexOf("scripts/check-runtime-config.ts")).toBeLessThan(
      start.indexOf("next start"),
    );
    expect(start.trimEnd().endsWith("next start")).toBe(true);
    expect(packageJson.scripts.build).toBe("next build");
  });
});
