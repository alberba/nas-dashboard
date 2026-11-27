import { createECDH } from "node:crypto";
import { HostConfigError, parseHosts, type HostConfig } from "./hosts";

/** Finite reasons a startup configuration can be rejected. */
export type RuntimeConfigIssueReason =
  | "missing"
  | "example"
  | "invalid"
  | "insecure"
  | "incomplete_pair"
  | "incoherent_pair"
  | "required_with_push_warnings";

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

export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

export type VapidConfig = {
  publicKey: string;
  privateKey: string;
};

export type RuntimeConfig = {
  databaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  setupToken: string;
  trustedOrigins: string[];
  hosts: HostConfig[];
  /** The Telegram group is optional, but it is either fully present or absent. */
  telegram: TelegramConfig | null;
  /** VAPID is optional unless `PUSH_WARNINGS` is enabled. */
  vapid: VapidConfig | null;
  pushWarnings: boolean;
  /** Civil time of the daily digest in Europe/Madrid, always `HH:mm`. */
  digestTime: string;
};

/** The daily digest runs at 08:00 Europe/Madrid unless configured otherwise. */
export const DEFAULT_DIGEST_TIME = "08:00";
const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
 * Reads the optional Telegram group. Both values or neither: an operator who
 * disables the channel omits the whole group instead of leaving a half
 * configuration that would fail on the first send.
 */
function telegram(
  env: Record<string, string | undefined>,
  issues: IssueList,
): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken && !chatId) return null;
  if (!botToken || !chatId) {
    issues.add("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID", "incomplete_pair");
    return null;
  }
  if (isExampleValue(botToken)) {
    issues.add("TELEGRAM_BOT_TOKEN", "example");
    return null;
  }
  // Bot API tokens are `<numeric bot id>:<provider secret>`.
  if (!/^\d{5,12}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    issues.add("TELEGRAM_BOT_TOKEN", "invalid");
    return null;
  }
  // Supergroups and channels use negative numeric identifiers.
  if (!/^-?[1-9]\d{0,19}$/.test(chatId)) {
    issues.add("TELEGRAM_CHAT_ID", "invalid");
    return null;
  }
  return { botToken, chatId };
}

/**
 * Direct execution from the chat is not available: the callback only opens the
 * handoff in the hub. The variable exists so that nobody turns it on by mistake,
 * and so it is never read anywhere else: absent, empty or `0` is valid and any
 * other value stops the startup (D-00a).
 */
function telegramDirectActions(
  env: Record<string, string | undefined>,
  issues: IssueList,
): void {
  const raw = env.TELEGRAM_DIRECT_ACTIONS?.trim();
  if (raw && raw !== "0") issues.add("TELEGRAM_DIRECT_ACTIONS", "invalid");
}

function pushWarningsEnabled(
  env: Record<string, string | undefined>,
  issues: IssueList,
): boolean {
  const raw = env.PUSH_WARNINGS?.trim();
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  issues.add("PUSH_WARNINGS", "invalid");
  return false;
}

/**
 * Civil time of the daily digest. Absent means the 08:00 default; an empty or
 * malformed value is rejected by name and reason, never by echoing it.
 */
function digestTime(
  env: Record<string, string | undefined>,
  issues: IssueList,
): string {
  if (!("DIGEST_TIME" in env)) return DEFAULT_DIGEST_TIME;
  const raw = env.DIGEST_TIME?.trim() ?? "";
  if (!DIGEST_TIME_PATTERN.test(raw)) {
    issues.add("DIGEST_TIME", "invalid");
    return DEFAULT_DIGEST_TIME;
  }
  return raw;
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return undefined;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

/** A VAPID public key is the uncompressed P-256 point derived from its secret. */
function coherentVapidPair(publicKey: Buffer, privateKey: Buffer): boolean {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privateKey);
    return ecdh.getPublicKey().equals(publicKey);
  } catch {
    return false;
  }
}

function vapid(
  env: Record<string, string | undefined>,
  pushWarnings: boolean,
  issues: IssueList,
): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey && !privateKey) {
    if (pushWarnings) {
      issues.add(
        "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY",
        "required_with_push_warnings",
      );
    }
    return null;
  }
  if (!publicKey || !privateKey) {
    issues.add("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY", "incomplete_pair");
    return null;
  }
  if (isExampleValue(publicKey) || isExampleValue(privateKey)) {
    issues.add("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY", "example");
    return null;
  }
  const decodedPublic = decodeBase64Url(publicKey);
  const decodedPrivate = decodeBase64Url(privateKey);
  if (
    !decodedPublic ||
    decodedPublic.length !== 65 ||
    decodedPublic[0] !== 0x04
  ) {
    issues.add("VAPID_PUBLIC_KEY", "invalid");
    return null;
  }
  if (!decodedPrivate || decodedPrivate.length !== 32) {
    issues.add("VAPID_PRIVATE_KEY", "invalid");
    return null;
  }
  if (!coherentVapidPair(decodedPublic, decodedPrivate)) {
    issues.add("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY", "incoherent_pair");
    return null;
  }
  return { publicKey, privateKey };
}


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
  const pushWarnings = pushWarningsEnabled(env, issues);
  const digestAt = digestTime(env, issues);
  const telegramConfig = telegram(env, issues);
  telegramDirectActions(env, issues);
  const vapidConfig = vapid(env, pushWarnings, issues);
  if (issues.length > 0) throw new RuntimeConfigError(issues.list());

  return {
    databaseUrl: database!,
    betterAuthSecret: betterAuthSecret!,
    betterAuthUrl: betterAuthUrl!,
    setupToken: setupToken!,
    trustedOrigins: origins,
    hosts: parsedHosts,
    telegram: telegramConfig,
    vapid: vapidConfig,
    pushWarnings,
    digestTime: digestAt,
  };
}
