import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
const globalDb = globalThis as unknown as { hubPool?: Pool };
export const pool =
  globalDb.hubPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
if (process.env.NODE_ENV !== "production") globalDb.hubPool = pool;
export const db = drizzle(pool, { schema });
