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
export const maintenanceTabs = ["status"] as const;
export type MaintenanceTab = (typeof maintenanceTabs)[number];
/**
 * `host` is the host chosen in Mantenimiento. It is kept while the Operador
 * visits other views so returning to Mantenimiento shows the same host, but
 * only Mantenimiento puts it in the URL. Missing means the hub's primary host.
 */
export type Route = { view: View; tab: MaintenanceTab; host?: string };
export type Navigate = (view: View) => void;

const aliases: Record<string, View> = { containers: "maintenance" };
/** Same shape as the server's host identifiers (`src/lib/hosts.ts`). */
const hostId = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function readRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const requested = params.get("view") ?? "summary";
  const view =
    aliases[requested] ??
    (views.includes(requested as View) ? (requested as View) : "summary");
  const tab = params.get("tab");
  const host = params.get("host");
  return {
    view,
    tab: maintenanceTabs.includes(tab as MaintenanceTab)
      ? (tab as MaintenanceTab)
      : "status",
    ...(host && hostId.test(host) ? { host } : {}),
  };
}

export function routeHref({ view, tab, host }: Route) {
  if (view === "summary") return "/";
  if (view === "maintenance")
    return `/?view=maintenance&tab=${tab}${host ? `&host=${encodeURIComponent(host)}` : ""}`;
  return `/?view=${view}`;
}
