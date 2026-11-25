export const views = [
  "summary",
  "resources",
  "maintenance",
  "files",
  "apps",
  "settings",
  "alerts",
] as const;
export type View = (typeof views)[number];
export const maintenanceTabs = ["status", "deployments"] as const;
export type MaintenanceTab = (typeof maintenanceTabs)[number];
/**
 * `host` is the host chosen in Mantenimiento. It is kept while the Operador
 * visits other views so returning to Mantenimiento shows the same host, but
 * only Mantenimiento puts it in the URL. Missing means the hub's primary host.
 */
export type Route = {
  view: View;
  tab: MaintenanceTab;
  host?: string;
  /** Episode selected in Avisos, when the link points at one. */
  incident?: number;
};
export type Navigate = (view: View) => void;

const aliases: Record<string, View> = { containers: "maintenance" };
/** Same shape as the server's host identifiers (`src/lib/hosts.ts`). */
const hostIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const incidentIdPattern = /^[1-9]\d{0,9}$/;
/** `incidents.id` is a PostgreSQL integer; deeper ids cannot exist. */
const MAX_INCIDENT_ID = 2_147_483_647;

function incidentIdFrom(value: string): number | null {
  if (!incidentIdPattern.test(value)) return null;
  const incidentId = Number(value);
  return Number.isSafeInteger(incidentId) && incidentId <= MAX_INCIDENT_ID
    ? incidentId
    : null;
}

export function readRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const requested = params.get("view") ?? "summary";
  const view =
    aliases[requested] ??
    (views.includes(requested as View) ? (requested as View) : "summary");
  const tab = params.get("tab");
  const host = params.get("host");
  const incident = params.get("incident");
  const parsedIncident = incident ? incidentIdFrom(incident) : null;
  return {
    view,
    tab: maintenanceTabs.includes(tab as MaintenanceTab)
      ? (tab as MaintenanceTab)
      : "status",
    ...(host && hostIdPattern.test(host) ? { host } : {}),
    ...(parsedIncident !== null ? { incident: parsedIncident } : {}),
  };
}

export function routeHref({ view, tab, host, incident }: Route) {
  if (view === "summary") return "/";
  if (view === "maintenance")
    return `/?view=maintenance&tab=${tab}${host ? `&host=${encodeURIComponent(host)}` : ""}`;
  if (view === "alerts") {
    const query = new URLSearchParams({ view: "alerts" });
    if (host && hostIdPattern.test(host)) query.set("host", host);
    if (
      incident &&
      Number.isSafeInteger(incident) &&
      incident > 0 &&
      incident <= MAX_INCIDENT_ID
    )
      query.set("incident", String(incident));
    return `/?${query.toString()}`;
  }
  return `/?view=${view}`;
}

/**
 * Absolute, token-free link to one episode in Avisos. The base URL is the
 * canonical `BETTER_AUTH_URL` the runtime already validated; the path stays
 * internal and requires an authenticated session when the browser opens it.
 */
export function incidentHref(
  betterAuthUrl: string,
  hostId: string,
  incidentId: number,
): string {
  let base: URL;
  try {
    base = new URL(betterAuthUrl);
  } catch {
    throw new Error("BETTER_AUTH_URL no es una URL válida");
  }
  if (base.username || base.password || base.search || base.hash)
    throw new Error("BETTER_AUTH_URL no puede llevar credenciales ni consulta");
  if (base.protocol !== "https:" && base.protocol !== "http:")
    throw new Error("BETTER_AUTH_URL debe usar HTTP o HTTPS");
  if (!hostIdPattern.test(hostId))
    throw new Error("El host del aviso no es válido");
  if (!Number.isSafeInteger(incidentId) || incidentId <= 0)
    throw new Error("La incidencia del aviso no es válida");
  const url = new URL("/", base.origin);
  url.searchParams.set("view", "alerts");
  url.searchParams.set("host", hostId);
  url.searchParams.set("incident", String(incidentId));
  return url.toString();
}
