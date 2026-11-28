import { handleIngest } from "@/lib/notification-ingest";

/** Signed producer events. No session: the HMAC is the authentication. */
export async function POST(request: Request) {
  return handleIngest(request);
}
