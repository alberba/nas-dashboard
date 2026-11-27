import { z } from "zod";
import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
// Zod probes `new Function` to decide whether it can compile validators. Under
// the document CSP that probe is a securitypolicyviolation, so keep zod
// interpreted in the browser: the hub validates on the server and the client
// only reads the same schemas.
z.config({ jitless: true });
export const authClient = createAuthClient({ plugins: [passkeyClient()] });
