import { readFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/lib/db";
import { user, account, session } from "../src/lib/schema";
try {
  if (process.stdin.isTTY)
    throw new Error(
      "Pass the new password through standard input, never as a command-line argument.",
    );
  const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (password.length < 12 || password.length > 128)
    throw new Error("Password must have 12–128 characters");
  const users = await db.select({ id: user.id }).from(user);
  if (users.length !== 1)
    throw new Error("Expected exactly one configured user");
  const hashed = await hashPassword(password);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(account)
      .set({ password: hashed, updatedAt: new Date() })
      .where(
        and(
          eq(account.userId, users[0].id),
          eq(account.providerId, "credential"),
        ),
      )
      .returning({ id: account.id });
    if (!updated.length) throw new Error("No password account found");
    await tx.delete(session).where(eq(session.userId, users[0].id));
  });
  console.log(
    "Password changed. All sessions revoked. Existing passkeys remain registered.",
  );
} finally {
  await pool.end();
}
