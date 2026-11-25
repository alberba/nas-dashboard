import { headers } from "next/headers";
import { count } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/lib/schema";
import { Login } from "@/components/login";
import { Dashboard } from "@/components/dashboard";
import { readRoute, routeHref } from "@/components/views/routes";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value)) {
      for (const entry of value) query.append(key, entry);
    }
  }
  // Only the known internal route is rebuilt; the login form never receives a
  // raw URL from the address bar.
  const next = routeHref(readRoute(`?${query.toString()}`));
  if (session) return <Dashboard name={session.user.name} />;
  const [{ value }] = await db.select({ value: count() }).from(user);
  return <Login setup={value === 0} next={next} />;
}
