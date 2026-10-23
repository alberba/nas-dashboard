import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import webpush from "web-push";
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    nas: { type: "string" },
    bind: { type: "string", default: "127.0.0.1" },
    media: { type: "string", default: "/path/to/media" },
    torrents: { type: "string", default: "/path/to/torrents" },
    output: { type: "string", default: ".env" },
    "agent-output": { type: "string", default: "agent/.env" },
  },
});
if (!values.url || !values.nas)
  throw new Error(
    "Usage: node scripts/configure.mjs --url https://hub.example.com --nas NAS_TAILSCALE_IP --bind ORACLE_TAILSCALE_IP --media /path/to/media --torrents /path/to/torrents",
  );
if (existsSync(values.output) || existsSync(values["agent-output"]))
  throw new Error("Refusing to overwrite an existing environment file");
const url = new URL(values.url);
if (url.protocol !== "https:") throw new Error("Production requires HTTPS");
const secret = () => randomBytes(32).toString("hex");
const password = secret(),
  agentToken = secret(),
  keys = webpush.generateVAPIDKeys();
const app = {
  DATABASE_URL: `postgresql://hub:${password}@db:5432/hub`,
  POSTGRES_PASSWORD: password,
  BETTER_AUTH_SECRET: secret(),
  BETTER_AUTH_URL: url.origin,
  TRUSTED_ORIGINS: url.origin,
  SETUP_TOKEN: secret(),
  NAS_AGENT_URL: `http://${values.nas}:9450`,
  AGENT_TOKEN: agentToken,
  NEXT_PUBLIC_APP_DOMAIN: url.hostname.split(".").slice(1).join("."),
  BIND_IP: values.bind,
  PORT: "4323",
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  VAPID_SUBJECT: url.origin,
};
const agent = {
  AGENT_TOKEN: agentToken,
  BIND_IP: values.nas,
  ALLOWED_IPS: `${values.bind},127.0.0.1`,
  NAS_NAME: "NAS-HOME",
  NAS_MEDIA_PATH: values.media,
  NAS_TORRENTS_PATH: values.torrents,
};
function save(path, data) {
  writeFileSync(
    path,
    Object.entries(data)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
}
save(values.output, app);
save(values["agent-output"], agent);
console.log("Environment files created with mode 0600. Keep them out of Git.");
