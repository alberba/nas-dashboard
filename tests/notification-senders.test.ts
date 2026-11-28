import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-22: only the notification dispatcher and the digest runner may send to
 * Telegram or through Web Push, so every notice goes through the policy. This
 * scan fails when any other module of `src/` gains a sender.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN: Record<string, RegExp> = {
  "telegram sender":
    /\b(?:sendTelegramMessage|editTelegramMessage|sendTelegramReply)\b/,
  "push sender": /\bdeliverPush\b/,
  "web-push module": /["']web-push["']/,
  "telegram api host": /api\.telegram\.org/,
};

const ALLOWED: Record<string, string> = {
  "src/lib/notification-dispatch.ts":
    "D-22 sender: delivers the outbox to Telegram and Web Push",
  "src/lib/digest-runs.ts":
    "D-22 sender: delivers the daily digest to Telegram",
  "src/lib/telegram.ts": "defines the Telegram transport and its senders",
  "src/lib/push.ts": "defines the Web Push transport and its sender",
};

function withoutComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** The names of the forbidden patterns the source matches, comments aside. */
function findViolations(_file: string, text: string): string[] {
  const code = withoutComments(text);
  return Object.entries(FORBIDDEN)
    .filter(([, pattern]) => pattern.test(code))
    .map(([name]) => name);
}

function sourceFiles(): string[] {
  return readdirSync(path.join(repoRoot, "src"), { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((entry) => /\.tsx?$/.test(entry))
    .map((entry) => `src/${entry}`);
}

function read(file: string) {
  return withoutComments(readFileSync(path.join(repoRoot, file), "utf8"));
}

describe("notification senders (D-22)", () => {
  it("flags every kind of sender in a synthetic source", () => {
    const samples: Array<[string, string]> = [
      ["telegram sender", 'await sendTelegramMessage(chat, "hola");'],
      ["telegram sender", "await editTelegramMessage(a, b);"],
      ["telegram sender", "await sendTelegramReply(a, b);"],
      ["push sender", "await deliverPush(payload, options);"],
      ["web-push module", 'import webpush from "web-push";'],
      ["web-push module", "const lib = require('web-push');"],
      ["web-push module", 'const lib = await import("web-push");'],
      [
        "telegram api host",
        'const url = "https://api.telegram.org/bot" + token;',
      ],
    ];
    for (const [expected, text] of samples)
      expect(findViolations("src/lib/other.ts", text)).toContain(expected);
  });

  it("does not flag a sender named only in a comment", () => {
    const text = [
      "// sendTelegramMessage is the dispatcher's job",
      "/* deliverPush and api.telegram.org live elsewhere,",
      '   as does "web-push" */',
      "const x = 1; // editTelegramMessage",
      "const url = 'https://example.org/path';",
    ].join("\n");
    expect(findViolations("src/lib/other.ts", text)).toEqual([]);
  });

  it("keeps a // inside a string from hiding what follows it", () => {
    const text = 'const u = "https://api.telegram.org/bot";';
    expect(findViolations("src/lib/other.ts", text)).toEqual([
      "telegram api host",
    ]);
  });

  it("finds no sender in src outside the allowed files", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    const offenders = files
      .filter((file) => !Object.hasOwn(ALLOWED, file))
      .map((file) => ({
        file,
        found: findViolations(
          file,
          readFileSync(path.join(repoRoot, file), "utf8"),
        ),
      }))
      .filter((entry) => entry.found.length > 0);
    expect(offenders).toEqual([]);
  });

  it("is not empty: every allowed file still uses or defines its senders", () => {
    const dispatch = read("src/lib/notification-dispatch.ts");
    expect(dispatch).toMatch(/\bdeliverPush\b/);
    expect(dispatch).toMatch(
      /\b(?:sendTelegramMessage|editTelegramMessage|sendTelegramReply)\b/,
    );
    expect(read("src/lib/digest-runs.ts")).toMatch(/\bsendTelegramMessage\b/);

    const telegram = read("src/lib/telegram.ts");
    for (const sender of [
      "sendTelegramMessage",
      "editTelegramMessage",
      "sendTelegramReply",
    ])
      expect(telegram).toMatch(
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${sender}\\b`),
      );
    expect(telegram).toMatch(/api\.telegram\.org/);

    const push = read("src/lib/push.ts");
    expect(push).toMatch(/export\s+(?:async\s+)?function\s+deliverPush\b/);
    expect(push).toMatch(/["']web-push["']/);
  });

  it("lists only files that exist, each with a reason", () => {
    const existing = new Set(sourceFiles());
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(existing.has(file), file).toBe(true);
      expect(reason.trim().length, file).toBeGreaterThan(0);
    }
  });
});
