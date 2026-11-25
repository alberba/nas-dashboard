import { spawn } from "node:child_process";
import { createECDH } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
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
const workerScript = path.join(repoRoot, "src", "worker.ts");

const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

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

function without(
  record: Record<string, string>,
  key: string,
): Record<string, string> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function vapidPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
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

/**
 * Opens a real TCP port that stands in for PostgreSQL. A worker that validates
 * its configuration first never connects to it, which is the observable
 * contract: the port would record a connection if `pool.connect` ran.
 */
async function withDatabaseProbe<T>(
  run: (databaseUrl: string, connections: () => number) => Promise<T>,
): Promise<T> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(
      `postgresql://hub:top-secret-password@127.0.0.1:${address.port}/hub`,
      () => connections,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    expect(config.telegram).toBeNull();
    expect(config.vapid).toBeNull();
    expect(config.pushWarnings).toBe(false);
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

describe("optional delivery channels", () => {
  it("keeps Telegram disabled when the whole group is omitted", () => {
    const config = readRuntimeConfig(
      env({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }),
    );
    expect(config.telegram).toBeNull();
  });

  it("accepts a complete Telegram group with a signed numeric chat", () => {
    const config = readRuntimeConfig(
      env({
        TELEGRAM_BOT_TOKEN: telegramToken,
        TELEGRAM_CHAT_ID: "-1001234567890",
      }),
    );
    expect(config.telegram).toEqual({
      botToken: telegramToken,
      chatId: "-1001234567890",
    });
  });

  it("rejects a partial Telegram group", () => {
    expect(
      issuesOf({
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_CHAT_ID: "-1001234567890",
      }),
    ).toContainEqual({
      variable: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID",
      reason: "incomplete_pair",
    });
    expect(
      issuesOf({
        TELEGRAM_BOT_TOKEN: telegramToken,
        TELEGRAM_CHAT_ID: undefined,
      }),
    ).toContainEqual({
      variable: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID",
      reason: "incomplete_pair",
    });
  });

  it("rejects a non-numeric Telegram chat", () => {
    expect(
      issuesOf({
        TELEGRAM_BOT_TOKEN: telegramToken,
        TELEGRAM_CHAT_ID: "@channel",
      }),
    ).toContainEqual({ variable: "TELEGRAM_CHAT_ID", reason: "invalid" });
  });

  it("rejects a Telegram bot token without the provider shape", () => {
    expect(
      issuesOf({
        TELEGRAM_BOT_TOKEN: "not-a-bot-token",
        TELEGRAM_CHAT_ID: "-1001234567890",
      }),
    ).toContainEqual({ variable: "TELEGRAM_BOT_TOKEN", reason: "invalid" });
  });

  it("rejects an example Telegram bot token", () => {
    expect(
      issuesOf({
        TELEGRAM_BOT_TOKEN:
          "123456:replace-with-the-token-from-botfather-0000000000",
        TELEGRAM_CHAT_ID: "-1001234567890",
      }),
    ).toContainEqual({ variable: "TELEGRAM_BOT_TOKEN", reason: "example" });
  });

  it("keeps VAPID disabled when both keys and push warnings are off", () => {
    const config = readRuntimeConfig(
      env({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }),
    );
    expect(config.vapid).toBeNull();
    expect(config.pushWarnings).toBe(false);
  });

  it("requires VAPID when PUSH_WARNINGS is enabled", () => {
    expect(
      issuesOf({
        PUSH_WARNINGS: "true",
        VAPID_PUBLIC_KEY: undefined,
        VAPID_PRIVATE_KEY: undefined,
      }),
    ).toContainEqual({
      variable: "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY",
      reason: "required_with_push_warnings",
    });
  });

  it("accepts a coherent VAPID pair with PUSH_WARNINGS=true", () => {
    const pair = vapidPair();
    const config = readRuntimeConfig(
      env({
        PUSH_WARNINGS: "true",
        VAPID_PUBLIC_KEY: pair.publicKey,
        VAPID_PRIVATE_KEY: pair.privateKey,
      }),
    );
    expect(config.pushWarnings).toBe(true);
    expect(config.vapid).toEqual(pair);
  });

  it("rejects a partial VAPID pair", () => {
    const pair = vapidPair();
    expect(
      issuesOf({
        VAPID_PUBLIC_KEY: pair.publicKey,
        VAPID_PRIVATE_KEY: undefined,
      }),
    ).toContainEqual({
      variable: "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY",
      reason: "incomplete_pair",
    });
  });

  it("rejects a mismatched VAPID pair", () => {
    const first = vapidPair();
    const second = vapidPair();
    expect(
      issuesOf({
        VAPID_PUBLIC_KEY: first.publicKey,
        VAPID_PRIVATE_KEY: second.privateKey,
      }),
    ).toContainEqual({
      variable: "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY",
      reason: "incoherent_pair",
    });
  });

  it("rejects a malformed VAPID public key", () => {
    expect(
      issuesOf({
        VAPID_PUBLIC_KEY: "not-a-vapid-key",
        VAPID_PRIVATE_KEY: vapidPair().privateKey,
      }),
    ).toContainEqual({ variable: "VAPID_PUBLIC_KEY", reason: "invalid" });
  });

  it("only accepts true and false for PUSH_WARNINGS", () => {
    const pair = vapidPair();
    expect(
      readRuntimeConfig(
        env({
          PUSH_WARNINGS: "true",
          VAPID_PUBLIC_KEY: pair.publicKey,
          VAPID_PRIVATE_KEY: pair.privateKey,
        }),
      ).pushWarnings,
    ).toBe(true);
    expect(
      readRuntimeConfig(env({ PUSH_WARNINGS: "false" })).pushWarnings,
    ).toBe(false);
    expect(
      readRuntimeConfig(env({ PUSH_WARNINGS: undefined })).pushWarnings,
    ).toBe(false);
    for (const value of ["1", "0", "yes", "on", "enabled"]) {
      expect(issuesOf({ PUSH_WARNINGS: value })).toContainEqual({
        variable: "PUSH_WARNINGS",
        reason: "invalid",
      });
    }
  });

  it("never prints channel credentials or keys", () => {
    const pair = vapidPair();
    const error = errorFor({
      TELEGRAM_BOT_TOKEN: telegramToken,
      TELEGRAM_CHAT_ID: "not-numeric-secret-chat",
      VAPID_PUBLIC_KEY: pair.publicKey,
      VAPID_PRIVATE_KEY: pair.privateKey,
    });
    expect(error.message).toContain("TELEGRAM_CHAT_ID");
    expect(error.message).not.toContain(telegramToken);
    expect(error.message).not.toContain("not-numeric-secret-chat");
    expect(error.message).not.toContain(pair.publicKey);
    expect(error.message).not.toContain(pair.privateKey);
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

  it("rejects a partial Telegram group", async () => {
    const result = await runPreflight({
      ".env.local": dotenv({ ...fileEnv, TELEGRAM_BOT_TOKEN: telegramToken }),
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID",
    );
  });

  it("rejects PUSH_WARNINGS=true without VAPID", async () => {
    const result = await runPreflight({
      ".env.local": dotenv({ ...fileEnv, PUSH_WARNINGS: "true" }),
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY",
    );
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

describe("worker startup", () => {
  it("stops before the database when required configuration is missing", async () => {
    await withDatabaseProbe(async (databaseUrl, connections) => {
      const result = await runProcess(tsxBin, [workerScript], {
        cwd: repoRoot,
        env: cleanEnv({
          ...without(ciEnv, "SETUP_TOKEN"),
          DATABASE_URL: databaseUrl,
          BETTER_AUTH_SECRET: "worker-secret-that-must-not-leak-32-chars",
        }),
        timeoutMs: 20_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code).not.toBe(0);
      expect(output).toContain("SETUP_TOKEN");
      expect(output).not.toContain("top-secret-password");
      expect(output).not.toContain("worker-secret-that-must-not-leak");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(connections()).toBe(0);
    });
  });

  it("stops before the database on a partial Telegram group", async () => {
    await withDatabaseProbe(async (databaseUrl, connections) => {
      const result = await runProcess(tsxBin, [workerScript], {
        cwd: repoRoot,
        env: cleanEnv({
          ...ciEnv,
          DATABASE_URL: databaseUrl,
          TELEGRAM_BOT_TOKEN: telegramToken,
        }),
        timeoutMs: 20_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code).not.toBe(0);
      expect(output).toContain("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID");
      expect(output).not.toContain(telegramToken);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(connections()).toBe(0);
    });
  });

  it("stops before the database when PUSH_WARNINGS requires VAPID", async () => {
    await withDatabaseProbe(async (databaseUrl, connections) => {
      const result = await runProcess(tsxBin, [workerScript], {
        cwd: repoRoot,
        env: cleanEnv({
          ...ciEnv,
          DATABASE_URL: databaseUrl,
          PUSH_WARNINGS: "true",
        }),
        timeoutMs: 20_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code).not.toBe(0);
      expect(output).toContain("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(connections()).toBe(0);
    });
  });
});
