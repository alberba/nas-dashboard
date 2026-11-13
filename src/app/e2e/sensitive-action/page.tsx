import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Harness } from "./harness";

/**
 * Test-only mount point for the sensitive-action confirmation. It exists only
 * when the server runs with HUB_E2E_HARNESS=1 (Playwright); everywhere else it
 * is a 404. It still requires a session, like every hub page.
 */
export default async function SensitiveActionHarness() {
  const requestHeaders = await headers();
  if (process.env.HUB_E2E_HARNESS !== "1") notFound();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/");
  return <Harness />;
}
