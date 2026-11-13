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
    "apps-url": { type: "string" },
    "apps-name": { type: "string", default: "Apps" },
    "apps-output": { type: "string", default: "agent/.env.apps" },
  },
});
if (!values.url || !values.nas)
  throw new Error(
    "Usage: node scripts/configure.mjs --url https://hub.example.com --nas NAS_TAILSCALE_IP --bind ORACLE_TAILSCALE_IP --media /path/to/media --torrents /path/to/torrents [--apps-url http://hub-agent-apps:9450]",
  );
if (
  existsSync(values.output) ||
  existsSync(values["agent-output"]) ||
  (values["apps-url"] && existsSync(values["apps-output"]))
)
  throw new Error("Refusing to overwrite an existing environment file");
const url = new URL(values.url);
if (url.protocol !== "https:") throw new Error("Production requires HTTPS");
if (values["apps-url"]) {
  const apps = new URL(values["apps-url"]);
  if (!["http:", "https:"].includes(apps.protocol))
    throw new Error("--apps-url must use HTTP or HTTPS");
}
const secret = () => randomBytes(32).toString("hex");
const password = secret(),
  nasToken = secret(),
  appsToken = secret(),
  keys = webpush.generateVAPIDKeys();
const hosts = [
  {
    id: "nas-home",
    name: "NAS-HOME",
    role: "instance",
    url: `http://${values.nas}:9450`,
    token: nasToken,
  },
];
if (values["apps-url"])
  hosts.push({
    id: "apps",
    name: values["apps-name"],
    role: "apps-server",
    url: values["apps-url"],
    token: appsToken,
  });
const app = {
  DATABASE_URL: `postgresql://hub:${password}@db:5432/hub`,
  POSTGRES_PASSWORD: password,
  BETTER_AUTH_SECRET: secret(),
  BETTER_AUTH_URL: url.origin,
  TRUSTED_ORIGINS: url.origin,
  SETUP_TOKEN: secret(),
  NAS_HOSTS: JSON.stringify(hosts),
  NEXT_PUBLIC_APP_DOMAIN: url.hostname.split(".").slice(1).join("."),
  BIND_IP: values.bind,
  PORT: "4323",
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  VAPID_SUBJECT: url.origin,
};
const agent = {
  AGENT_TOKEN: nasToken,
  BIND_IP: values.nas,
  ALLOWED_IPS: `${values.bind},127.0.0.1`,
  NAS_NAME: "NAS-HOME",
  FILES_ENABLED: "true",
  ALLOW_REBOOT: "true",
  NAS_MEDIA_PATH: values.media,
  NAS_TORRENTS_PATH: values.torrents,
};
const apps = {
  AGENT_TOKEN: appsToken,
  BIND_IP: "0.0.0.0",
  ALLOWED_IPS: "127.0.0.1,172.16.0.0/12",
  NAS_NAME: values["apps-name"],
  FILES_ENABLED: "false",
  ALLOW_REBOOT: "false",
  PROTECTED_CONTAINERS:
    "nas-dashboard-app-1,nas-dashboard-db-1,nas-dashboard-worker-1,nas-dashboard-migrate-1",
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
if (values["apps-url"]) save(values["apps-output"], apps);
console.log("Environment files created with mode 0600. Keep them out of Git.");
if (values["apps-url"])
  console.log(
    "Apps agent: copy agent/ to the apps server and run docker compose -f compose.apps.yaml up -d --build.",
  );
