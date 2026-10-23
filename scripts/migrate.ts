import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/lib/db";
try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migraciones aplicadas");
} finally {
  await pool.end();
}
