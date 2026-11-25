import { HostConfigError, parseHosts, type HostConfig } from "./hosts";

/** Finite reasons a startup configuration can be rejected. */
export type RuntimeConfigIssueReason =
  | "missing"
  | "example"
  | "invalid"
  | "insecure"
  | "incomplete_pair";

export type RuntimeConfigIssue = {
  /** Environment variable or pair that carries the problem. */
  variable: string;
  reason: RuntimeConfigIssueReason;
};

/**
 * Startup configuration error. The message only names variables and finite
 * reasons: it never includes the rejected value, a URL with credentials or a
 * provider body.
 */
export class RuntimeConfigError extends Error {
  constructor(readonly issues: RuntimeConfigIssue[]) {
    super(
      `Configuración de arranque no válida: ${issues
        .map((issue) => `${issue.variable} (${issue.reason})`)
        .join(", ")}`,
    );
    this.name = "RuntimeConfigError";
  }
}

export type RuntimeConfig = {
  databaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  setupToken: string;
  trustedOrigins: string[];
  hosts: HostConfig[];
};

const EXAMPLE_MARKERS = [
  "change-me",
  "replace-with-",
  "build-placeholder",
  "the-same-secret-as-the-nas-agent",
] as const;

const EXAMPLE_HOSTS = [
  "example.com",
  "your-nas-tailscale-ip",
  "your-apps-tailscale-ip",
] as const;

const MIN_SECRET_LENGTH = 32;

/** Decodes URL-encoded values so `change%2Dme` is caught like `change-me`. */
function decodedVariants(value: string): string[] {
  const variants = [value];
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      variants.push(next);
      current = next;
    } catch {
      break;
    }
  }
  return variants;
}

function isExampleValue(value: string): boolean {
  return decodedVariants(value).some((variant) => {
    const normalized = variant.trim().toLowerCase();
    return EXAMPLE_MARKERS.some((marker) => normalized.includes(marker));
  });
}

function isExampleHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return EXAMPLE_HOSTS.some(
    (example) => normalized === example || normalized.endsWith(`.${example}`),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

class IssueList {
  private readonly entries = new Map<string, RuntimeConfigIssue>();

  add(variable: string, reason: RuntimeConfigIssueReason): void {
    this.entries.set(`${variable}\u0000${reason}`, { variable, reason });
  }

  get length(): number {
    return this.entries.size;
  }

  list(): RuntimeConfigIssue[] {
    return [...this.entries.values()];
  }
}

function databaseUrl(
  env: Record<string, string | undefined>,
  issues: IssueList,
): string | undefined {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) {
    issues.add("DATABASE_URL", "missing");
    return undefined;
  }
  if (isExampleValue(raw)) {
    issues.add("DATABASE_URL", "example");
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.add("DATABASE_URL", "invalid");
    return undefined;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    issues.add("DATABASE_URL", "invalid");
    return undefined;
  }
  // The driver needs a user, a password and a database name; a missing part
  // would make the service start and then fail on the first query instead.
  const database = parsed.pathname.replace(/^\/+/, "");
  if (!parsed.username || !parsed.password || !database) {
    issues.add("DATABASE_URL", "invalid");
    return undefined;
  }
  return raw;
}

function secret(
  env: Record<string, string | undefined>,
  name: "BETTER_AUTH_SECRET" | "SETUP_TOKEN",
  issues: IssueList,
): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    issues.add(name, "missing");
    return undefined;
  }
  if (isExampleValue(raw)) {
    issues.add(name, "example");
    return undefined;
  }
  if (raw.length < MIN_SECRET_LENGTH) {
    issues.add(name, "invalid");
    return undefined;
  }
  return raw;
}

function origin(
  value: string,
  variable: string,
  issues: IssueList,
): string | undefined {
  const raw = value.trim();
  if (!raw) {
    issues.add(variable, "missing");
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.add(variable, "invalid");
    return undefined;
  }
  if (isExampleHostname(parsed.hostname)) {
    issues.add(variable, "example");
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    issues.add(variable, "invalid");
    return undefined;
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    issues.add(variable, "invalid");
    return undefined;
  }
  if (parsed.protocol === "http:") {
    // Plain HTTP is only acceptable for local development over loopback.
    if (!isLoopbackHostname(parsed.hostname)) {
      issues.add(variable, "insecure");
      return undefined;
    }
  } else if (parsed.protocol !== "https:") {
    issues.add(variable, "invalid");
    return undefined;
  }
  return parsed.origin;
}

function trustedOrigins(
  env: Record<string, string | undefined>,
  canonical: string | undefined,
  issues: IssueList,
): string[] {
  const raw = env.TRUSTED_ORIGINS?.trim();
  if (!raw) return canonical ? [canonical] : [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    issues.add("TRUSTED_ORIGINS", "invalid");
    return [];
  }
  const origins: string[] = [];
  for (const value of values) {
    const parsed = origin(value, "TRUSTED_ORIGINS", issues);
    if (parsed && !origins.includes(parsed)) origins.push(parsed);
  }
  return origins;
}

function hosts(
  env: Record<string, string | undefined>,
  issues: IssueList,
): HostConfig[] {
  const usingHosts = Boolean(env.NAS_HOSTS?.trim());
  const legacyUrl = env.NAS_AGENT_URL?.trim();
  const legacyToken = env.AGENT_TOKEN?.trim();
  const variable = usingHosts ? "NAS_HOSTS" : "NAS_AGENT_URL/AGENT_TOKEN";
  let parsed: HostConfig[];
  try {
    parsed = parseHosts(env);
  } catch (error) {
    if (!(error instanceof HostConfigError)) throw error;
    if (!usingHosts && Boolean(legacyUrl) !== Boolean(legacyToken)) {
      issues.add(variable, "incomplete_pair");
    } else if (!usingHosts && !legacyUrl && !legacyToken) {
      issues.add(variable, "missing");
    } else {
      issues.add(variable, "invalid");
    }
    return [];
  }
  const exampleToken = parsed.some((host) => isExampleValue(host.token));
  const exampleUrl = parsed.some((host) => {
    if (isExampleValue(host.url)) return true;
    try {
      return isExampleHostname(new URL(host.url).hostname);
    } catch {
      return false;
    }
  });
  if (exampleToken || exampleUrl) issues.add(variable, "example");
  return parsed;
}

/**
 * Reads and validates the startup configuration from an injectable
 * environment. `parseHosts` stays the single owner of the host list so the
 * legacy single-agent pair keeps working unchanged.
 */
export function readRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const issues = new IssueList();
  const database = databaseUrl(env, issues);
  const betterAuthSecret = secret(env, "BETTER_AUTH_SECRET", issues);
  const setupToken = secret(env, "SETUP_TOKEN", issues);

  let betterAuthUrl: string | undefined;
  const authUrlValue = env.BETTER_AUTH_URL?.trim();
  if (authUrlValue) {
    betterAuthUrl = origin(authUrlValue, "BETTER_AUTH_URL", issues);
  } else {
    issues.add("BETTER_AUTH_URL", "missing");
  }

  const origins = trustedOrigins(env, betterAuthUrl, issues);
  const parsedHosts = hosts(env, issues);
  if (issues.length > 0) throw new RuntimeConfigError(issues.list());

  return {
    databaseUrl: database!,
    betterAuthSecret: betterAuthSecret!,
    betterAuthUrl: betterAuthUrl!,
    setupToken: setupToken!,
    trustedOrigins: origins,
    hosts: parsedHosts,
  };
}
