import { randomBytes } from "node:crypto";
import { Client } from "pg";

/**
 * The API and migration tests need a disposable PostgreSQL database. They only
 * run against a local server so a production URL can never be touched.
 *
 * `HUB_REQUIRE_TEST_DB=1` makes a missing or non-loopback URL a hard failure
 * instead of a silent skip: a migration test that never ran is not a pass.
 */
export function testDatabaseUrl(): string | null {
  const required = process.env.HUB_REQUIRE_TEST_DB === "1";
  const value = process.env.DATABASE_URL;
  if (!value) {
    if (required)
      throw new Error(
        "HUB_REQUIRE_TEST_DB=1 requiere DATABASE_URL apuntando a PostgreSQL local",
      );
    return null;
  }
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    if (required)
      throw new Error("HUB_REQUIRE_TEST_DB=1 requiere un DATABASE_URL válido");
    return null;
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    if (required)
      throw new Error(
        "HUB_REQUIRE_TEST_DB=1 solo admite DATABASE_URL de loopback; la base de pruebas nunca toca un servidor remoto",
      );
    return null;
  }
  return value;
}

export type TestDatabase = {
  admin: Client;
  database: string;
  url: string;
};

export async function createTestDatabase(
  baseUrl: string,
): Promise<TestDatabase> {
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  const database = `hub_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const scoped = new URL(baseUrl);
  scoped.pathname = `/${database}`;
  return { admin, database, url: scoped.toString() };
}

export async function dropTestDatabase(context: TestDatabase) {
  await context.admin.query(`DROP DATABASE IF EXISTS "${context.database}"`);
  await context.admin.end();
}
