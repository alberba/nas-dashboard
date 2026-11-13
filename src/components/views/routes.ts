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
export type Route = { view: View; tab: MaintenanceTab };
export type Navigate = (view: View) => void;

const aliases: Record<string, View> = { containers: "maintenance" };

export function readRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const requested = params.get("view") ?? "summary";
  const view =
    aliases[requested] ??
    (views.includes(requested as View) ? (requested as View) : "summary");
  const tab = params.get("tab");
  return {
    view,
    tab: maintenanceTabs.includes(tab as MaintenanceTab)
      ? (tab as MaintenanceTab)
      : "status",
  };
}

export function routeHref({ view, tab }: Route) {
  if (view === "summary") return "/";
  if (view === "maintenance") return `/?view=maintenance&tab=${tab}`;
  return `/?view=${view}`;
}
