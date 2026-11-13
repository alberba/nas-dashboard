import { randomBytes } from "node:crypto";
import { Client } from "pg";

/**
 * The API and migration tests need a disposable PostgreSQL database. They only
 * run against a local server so a production URL can never be touched.
 */
export function testDatabaseUrl(): string | null {
  const value = process.env.DATABASE_URL;
  if (!value) return null;
  try {
    const host = new URL(value).hostname;
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return null;
    return value;
  } catch {
    return null;
  }
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
