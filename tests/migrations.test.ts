import { readFileSync, readdirSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  dropTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "./database";

const baseUrl = testDatabaseUrl();

async function apply(client: Client, file: string) {
  const sql = readFileSync(`drizzle/${file}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}

describe.skipIf(!baseUrl)("multi-host migration", () => {
  let context: TestDatabase;
  beforeAll(async () => {
    context = await createTestDatabase(baseUrl!);
  });
  afterAll(async () => {
    await dropTestDatabase(context);
  });

  it("assigns existing samples, alerts, operations and settings to the NAS", async () => {
    const migrations = readdirSync("drizzle")
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(migrations.length).toBeGreaterThan(1);
    const latest = migrations.at(-1)!;
    const client = new Client({ connectionString: context.url });
    await client.connect();
    try {
      for (const file of migrations.slice(0, -1)) await apply(client, file);
      await client.query(`
        INSERT INTO samples ("at", data) VALUES (now(), '{"timestamp":1}'::jsonb);
        INSERT INTO alerts ("key", title, detail, severity)
          VALUES ('connection', 'El NAS no responde', 'Sin métricas', 'critical');
        INSERT INTO operations (id, "userId", action, target, status)
          VALUES ('legacy-operation', 'legacy-user', 'reboot', 'NAS', 'success');
        INSERT INTO configuration (id, value) VALUES ('settings', '{"cpu":90}'::jsonb);
      `);

      await apply(client, latest);

      for (const table of ["samples", "alerts", "operations"]) {
        const { rows } = await client.query(
          `SELECT DISTINCT "hostId" FROM ${table}`,
        );
        expect(rows.map((row) => row.hostId)).toEqual(["nas-home"]);
      }
      const settings = await client.query(
        'SELECT "hostId", id FROM configuration',
      );
      expect(settings.rows).toEqual([{ hostId: "nas-home", id: "settings" }]);

      await client.query(
        `INSERT INTO configuration ("hostId", id, value) VALUES ('apps', 'settings', '{"cpu":80}'::jsonb)`,
      );
      const hostSettings = await client.query(
        'SELECT "hostId" FROM configuration ORDER BY "hostId"',
      );
      expect(hostSettings.rows.map((row) => row.hostId)).toEqual([
        "apps",
        "nas-home",
      ]);
    } finally {
      await client.end();
    }
  });
});
