import { execFile, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ingestEnvelope,
  signIngest,
  verifyIngest,
} from "@/lib/notification-ingest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repoRoot, "scripts/ingest-test-event.sh");

// Contract vector fixed by plan 08-01.
const SECRET = "ingest-contract-secret-0123456789abcdef";
const TIMESTAMP = "1700000000";
const VECTOR_BODY =
  '{"v":1,"source":"backup","eventId":"backup-failed:1700000000","hostId":"nas-home","key":"backup-failed","state":"open","data":{"errors":["restic backup failed (exit 1)"]}}';
const VECTOR_SIGNATURE =
  "4525b5167d3882979d6b063dde511c6c28d2bec94d65811d2f512581b76eada1";
const VECTOR_FLAGS = [
  "--source",
  "backup",
  "--host-id",
  "nas-home",
  "--key",
  "backup-failed",
  "--state",
  "open",
  "--event-id",
  "backup-failed:1700000000",
  "--error",
  "restic backup failed (exit 1)",
];

function baseEnv(extra: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...extra,
  };
  return env;
}

function dryRun(
  args: string[],
  env: Record<string, string | undefined> = {
    NOTIFY_INGEST_SECRET: SECRET,
    INGEST_TIMESTAMP: TIMESTAMP,
  },
) {
  return spawnSync("sh", [script, ...args], {
    env: baseEnv({ INGEST_DRY_RUN: "1", ...env }),
    encoding: "utf8",
  });
}

/** Headers and body of each request a dry run printed, three lines apiece. */
function requests(stdout: string) {
  const lines = stdout.split("\n").filter((line) => line !== "");
  expect(lines.length % 3).toBe(0);
  const out: Array<{ timestamp: string; signature: string; body: string }> = [];
  for (let index = 0; index < lines.length; index += 3) {
    const timestamp = /^X-Ingest-Timestamp: (\d{10})$/.exec(lines[index]);
    const signature = /^X-Ingest-Signature: v1=([0-9a-f]{64})$/.exec(
      lines[index + 1],
    );
    expect(timestamp).not.toBeNull();
    expect(signature).not.toBeNull();
    out.push({
      timestamp: timestamp![1],
      signature: signature![1],
      body: lines[index + 2],
    });
  }
  return out;
}

describe("scripts/ingest-test-event.sh", () => {
  it("is executable and its tools exist", () => {
    expect(() => accessSync(script, constants.X_OK)).not.toThrow();
    for (const tool of ["jq", "openssl"])
      expect(spawnSync(tool, ["--version"]).error, tool).toBeUndefined();
  });

  it("signs the contract vector byte for byte", () => {
    const result = dryRun(VECTOR_FLAGS);
    expect(result.status).toBe(0);
    expect(requests(result.stdout)).toEqual([
      { timestamp: TIMESTAMP, signature: VECTOR_SIGNATURE, body: VECTOR_BODY },
    ]);
  });

  it("agrees with the hub's signIngest on other bodies", () => {
    const result = dryRun([
      "--source",
      "issue-automator",
      "--host-id",
      "nas-home",
      "--key",
      "issue:seerr:42",
      "--state",
      "resolved",
      "--event-id",
      "issue:seerr:42:closed",
      "--subject",
      "Sin sonido en «Dune»",
      "--reported-by",
      "ana",
      "--problem",
      "Audio",
    ]);
    expect(result.status).toBe(0);
    const [only] = requests(result.stdout);
    expect(JSON.parse(only.body)).toEqual({
      v: 1,
      source: "issue-automator",
      eventId: "issue:seerr:42:closed",
      hostId: "nas-home",
      key: "issue:seerr:42",
      state: "resolved",
      data: {
        subject: "Sin sonido en «Dune»",
        reportedBy: "ana",
        problem: "Audio",
      },
    });
    expect(only.signature).toBe(signIngest(SECRET, only.timestamp, only.body));
    expect(ingestEnvelope.safeParse(JSON.parse(only.body)).success).toBe(true);
  });

  it("refuses to sign without the secret", () => {
    const result = dryRun(VECTOR_FLAGS, { INGEST_TIMESTAMP: TIMESTAMP });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/X-Ingest-Signature/);
  });

  it("rejects the secret as an argument", () => {
    for (const flags of [["--secret", SECRET], [`--secret=${SECRET}`]]) {
      const result = dryRun([...VECTOR_FLAGS, ...flags]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("sends open and then resolved for --state both, with distinct valid event ids", () => {
    const result = dryRun([
      ...VECTOR_FLAGS.filter((_, index) => ![6, 7].includes(index)),
      "--state",
      "both",
    ]);
    expect(result.status).toBe(0);
    const sent = requests(result.stdout).map((request) =>
      ingestEnvelope.parse(JSON.parse(request.body)),
    );
    expect(sent.map((event) => event.state)).toEqual(["open", "resolved"]);
    expect(new Set(sent.map((event) => event.eventId)).size).toBe(2);
    for (const request of requests(result.stdout))
      expect(request.signature).toBe(
        signIngest(SECRET, request.timestamp, request.body),
      );
  });

  it("rejects an unknown source, state or flag before signing", () => {
    for (const flags of [
      ["--source", "other"],
      ["--state", "closed"],
      ["--bogus", "1"],
    ]) {
      const result = dryRun([...VECTOR_FLAGS, ...flags]);
      expect(result.status, flags.join(" ")).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});

describe("scripts/ingest-test-event.sh against a live endpoint", () => {
  async function runAgainst(
    status: number,
    extra: string[],
  ): Promise<{
    code: number;
    stdout: string;
    received: Array<{ headers: Record<string, string>; body: string }>;
  }> {
    const received: Array<{ headers: Record<string, string>; body: string }> =
      [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          headers: {
            timestamp: String(request.headers["x-ingest-timestamp"]),
            signature: String(request.headers["x-ingest-signature"]),
          },
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "stub" }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const outcome = await new Promise<{ code: number; stdout: string }>(
        (resolve) => {
          execFile(
            "sh",
            [
              script,
              "--url",
              `http://127.0.0.1:${port}/api/notifications/ingest`,
              ...extra,
            ],
            {
              env: baseEnv({ NOTIFY_INGEST_SECRET: SECRET }),
              encoding: "utf8",
            },
            (error, stdout) =>
              resolve({
                code: error ? Number((error as { code?: number }).code) : 0,
                stdout,
              }),
          );
        },
      );
      return { ...outcome, received };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const sequence = [
    "--source",
    "backup",
    "--host-id",
    "nas-home",
    "--key",
    "backup-failed",
    "--state",
    "both",
    "--error",
    "prueba",
  ];

  it("posts two requests the hub would verify and exits 0 on 2xx", async () => {
    const { code, stdout, received } = await runAgainst(202, sequence);
    expect(code).toBe(0);
    expect(stdout).toMatch(/202/);
    expect(received).toHaveLength(2);
    for (const request of received)
      expect(
        verifyIngest({
          secrets: { secret: SECRET, previous: null },
          timestamp: request.headers.timestamp,
          signature: request.headers.signature,
          body: request.body,
          now: Number(request.headers.timestamp),
        }),
      ).toBe(true);
    expect(
      received.map(
        (request) => ingestEnvelope.parse(JSON.parse(request.body)).state,
      ),
    ).toEqual(["open", "resolved"]);
  });

  it("exits non-zero and stops after a non-2xx response", async () => {
    const { code, received } = await runAgainst(409, sequence);
    expect(code).not.toBe(0);
    expect(received).toHaveLength(1);
  });
});

describe("cutover and rotation documents", () => {
  const documents = [
    "docs/media-stack-cutover.md",
    "docs/rotacion-token-y-secreto.md",
  ];

  it("name the script and both secret variables", () => {
    for (const file of documents) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      for (const identifier of [
        "scripts/ingest-test-event.sh",
        "NOTIFY_INGEST_SECRET",
        "NOTIFY_INGEST_SECRET_PREVIOUS",
      ])
        expect(text, `${file} names ${identifier}`).toContain(identifier);
    }
  });

  it("never pass the secret as a command argument", () => {
    for (const file of documents) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      expect(text, file).not.toMatch(/--secret\b/);
    }
  });
});
