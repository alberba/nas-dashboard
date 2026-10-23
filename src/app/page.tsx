import { headers } from "next/headers";
import { count } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/lib/schema";
import { Login } from "@/components/login";
import { Dashboard } from "@/components/dashboard";
export const dynamic = "force-dynamic";
export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) return <Dashboard name={session.user.name} />;
  const [{ value }] = await db.select({ value: count() }).from(user);
  return <Login setup={value === 0} />;
}
