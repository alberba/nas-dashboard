"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bell,
  ChevronRight,
  CircleCheck,
  FolderOpen,
  Grid2X2,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Settings2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { requiresVerificationForAction } from "@/lib/sensitive-actions";
import { updatePresentIncidentNotification } from "@/lib/incident-push";
import type { Alert, HostStatus, Overview } from "@/lib/types";
import { FileBrowser, type ActionRequest } from "./file-browser";
import {
  HostScopeContext,
  HostSwitcher,
  SidebarHosts,
  withHost,
  type HostScope,
} from "./host-context";
import { Settings } from "./settings";
import { AlertsView, type IncidentHubAction } from "./views/alerts";
import { AppsView } from "./views/apps";
import { CommandSearch } from "./command-search";
import {
  useSensitiveAction,
  type SensitiveActionOutcome,
} from "./sensitive-action/sensitive-action";
import { Deployments } from "./views/deployments";
import { MaintenanceStatus } from "./views/maintenance";
import { ResourcesView } from "./views/resources";
import {
  readRoute,
  routeHref,
  type MaintenanceTab,
  type Route,
  type View,
} from "./views/routes";
import { SummaryView } from "./views/summary";

const navigation: { id: View; label: string; icon: typeof Activity }[] = [
  { id: "summary", label: "Resumen", icon: LayoutDashboard },
  { id: "resources", label: "Recursos", icon: Activity },
  { id: "maintenance", label: "Mantenimiento", icon: Wrench },
  { id: "files", label: "Archivos", icon: FolderOpen },
  { id: "apps", label: "Aplicaciones", icon: Grid2X2 },
  { id: "settings", label: "Ajustes", icon: Settings2 },
];
const headings: Record<View, string> = {
  summary: "Resumen",
  resources: "Recursos",
  maintenance: "Mantenimiento",
  files: "Archivos",
  apps: "Aplicaciones",
  settings: "Ajustes",
  alerts: "Avisos",
};
const maintenanceTabs: { id: MaintenanceTab; label: string }[] = [
  { id: "status", label: "Estado" },
  { id: "deployments", label: "Despliegues" },
];

export function Dashboard({ name }: { name: string }) {
  const router = useRouter();
  const [route, setRoute] = useState<Route>({
    view: "summary",
    tab: "status",
  });
  const { view } = route;
  /** Host the visible data belongs to; null is the hub's primary host. */
  const scope = view === "maintenance" ? (route.host ?? null) : null;
  const [range, setRange] = useState("1h");
  const [snapshot, setSnapshot] = useState<{
    scope: string | null;
    data: Overview;
  } | null>(null);
  /** Point lookup for a linked episode outside the 100 recent. */
  const [incidentDetail, setIncidentDetail] = useState<{
    host: string;
    id: number;
    data: Alert | null;
    missing: boolean;
  } | null>(null);
  const [directory, setDirectory] = useState<{
    primary: string | null;
    hosts: HostStatus[];
  }>({ primary: null, hosts: [] });
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [operation, setOperation] = useState<ActionRequest | null>(null);
  /** Host an open action goes to, fixed when its dialog opens. */
  const [operationHost, setOperationHost] = useState<{
    id: string | null;
    name: string;
  }>({ id: null, name: "" });
  const [blocked, setBlocked] = useState(false);
  const [destination, setDestination] = useState("");
  const [phrase, setPhrase] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const sensitive = useSensitiveAction();
  const nav = useRef<HTMLElement>(null);
  const tabId = useRef("");
  /** Last revision already checked against the device tray, per episode. */
  const notifiedRevisions = useRef(new Map<number, number>());
  /** What the page wants right now; answers for anything else are dropped. */
  const wanted = useRef({ scope, range, route });
  useEffect(() => {
    wanted.current = { scope, range, route };
  }, [scope, range, route]);

  const go = useCallback((next: Route, scroll = true) => {
    setRoute(next);
    window.history.replaceState(null, "", routeHref(next));
    if (scroll) window.scrollTo({ top: 0 });
  }, []);

  /** On a phone the navigation scrolls sideways: keep the current item whole. */
  useEffect(() => {
    const center = () => {
      const bar = nav.current;
      const active = bar?.querySelector<HTMLElement>('[aria-current="page"]');
      if (bar && active)
        bar.scrollTo({
          left: active.offsetLeft - (bar.clientWidth - active.clientWidth) / 2,
          behavior: "auto",
        });
    };
    center();
    window.addEventListener("resize", center);
    return () => window.removeEventListener("resize", center);
  }, [view]);

  /** Rebuild the known internal route so a session expiry keeps the episode. */
  const signInAgain = useCallback(() => {
    router.replace(routeHref(readRoute(window.location.search)));
    router.refresh();
  }, [router]);

  /**
   * D-05: only a visible authenticated refresh may replace an older notice in
   * the tray. Absent or already-current notifications are left untouched and
   * no push is sent; the hub already shows the new revision.
   */
  const refreshPresentNotifications = useCallback((alerts: Alert[]) => {
    if (document.visibilityState !== "visible") return;
    for (const alert of alerts) {
      if (
        !Number.isSafeInteger(alert.id) ||
        !Number.isSafeInteger(alert.seq)
      )
        continue;
      if (notifiedRevisions.current.get(alert.id) === alert.seq) continue;
      notifiedRevisions.current.set(alert.id, alert.seq);
      void updatePresentIncidentNotification({
        hostId: alert.hostId,
        incidentId: alert.id,
        seq: alert.seq,
        title: alert.title,
        body: alert.detail,
        url: routeHref({
          view: "alerts",
          tab: "status",
          host: alert.hostId,
          incident: alert.id,
        }),
        visible: true,
      }).catch(() => {});
    }
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const current = () =>
        wanted.current.scope === scope && wanted.current.range === range;
      try {
        const response = await fetch(
          withHost(`/api/overview?range=${range}`, scope),
          { signal },
        );
        if (response.status === 401) {
          signInAgain();
          return;
        }
        const result = await response.json();
        if (!current()) return;
        if (response.status === 404 && scope) {
          // The host left the server configuration: show the primary one.
          go({ ...wanted.current.route, host: undefined }, false);
          return;
        }
        if (!response.ok) throw new Error(result.error);
        setSnapshot({ scope, data: result });
        if (Array.isArray(result.alerts))
          refreshPresentNotifications(result.alerts);
        if (Array.isArray(result.hosts))
          setDirectory((previous) => ({
            primary:
              previous.primary ?? (scope === null ? result.host?.id : null),
            hosts: result.hosts,
          }));
        setError("");
      } catch (err) {
        if (
          current() &&
          !(err instanceof DOMException && err.name === "AbortError")
        )
          setError(
            err instanceof Error
              ? err.message
              : "No se pudo actualizar el panel",
          );
      }
    },
    [range, scope, go, signInAgain, refreshPresentNotifications],
  );

  useEffect(() => {
    const requested = readRoute(window.location.search);
    queueMicrotask(() => setRoute(requested));
    const hostsRequest = new AbortController();
    void fetch("/api/hosts", { signal: hostsRequest.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json();
        if (!Array.isArray(result.hosts)) return;
        setDirectory((previous) => ({
          primary: typeof result.default === "string" ? result.default : null,
          hosts: previous.hosts.length ? previous.hosts : result.hosts,
        }));
      })
      .catch(() => {});
    tabId.current = crypto.randomUUID();
    function heartbeat() {
      void fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: tabId.current,
          visible: document.visibilityState === "visible",
        }),
        keepalive: true,
      }).catch(() => {});
    }
    heartbeat();
    const timer = setInterval(heartbeat, 15000);
    document.addEventListener("visibilitychange", heartbeat);
    function leaving() {
      void fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tabId.current, visible: false }),
        keepalive: true,
      }).catch(() => {});
    }
    window.addEventListener("pagehide", leaving);
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      hostsRequest.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", heartbeat);
      window.removeEventListener("pagehide", leaving);
      leaving();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh(controller.signal);
      if (!controller.signal.aborted)
        timer = setTimeout(
          poll,
          document.visibilityState === "visible" ? 5000 : 30000,
        );
    }
    void poll();
    function visible() {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void refresh(controller.signal);
      }
    }
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  const primary =
    directory.primary ??
    (snapshot?.scope === null ? (snapshot.data.host?.id ?? null) : null);
  const requestedIncident = view === "alerts" ? route.incident : undefined;
  const incidentHost =
    requestedIncident === undefined
      ? undefined
      : (route.host ?? primary ?? undefined);
  useEffect(() => {
    const targetId = requestedIncident;
    const targetHost = incidentHost;
    if (targetId === undefined || !targetHost) {
      queueMicrotask(() => setIncidentDetail(null));
      return;
    }
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/incidents/${targetId}?host=${encodeURIComponent(targetHost!)}`,
          { signal: controller.signal },
        );
        if (response.status === 401) {
          signInAgain();
          return;
        }
        const result = (await response.json().catch(() => null)) as {
          incident?: Alert;
        } | null;
        if (controller.signal.aborted) return;
        if (response.status === 404)
          setIncidentDetail({
            host: targetHost!,
            id: targetId!,
            data: null,
            missing: true,
          });
        else if (response.ok && result?.incident) {
          setIncidentDetail({
            host: targetHost!,
            id: targetId!,
            data: result.incident,
            missing: false,
          });
          refreshPresentNotifications([result.incident]);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }
    void load();
    return () => controller.abort();
  }, [
    requestedIncident,
    incidentHost,
    signInAgain,
    refreshPresentNotifications,
  ]);
  /**
   * Sends one operator action from Avisos. The browser supplies the Origin,
   * the session cookie authorises it and the shared API applies the same state
   * Telegram writes; the list and the linked episode are refreshed afterwards.
   */
  const runIncidentAction = useCallback(
    async (alert: Alert, action: IncidentHubAction) => {
      const verb =
        action === "acknowledge"
          ? "acknowledge"
          : action === "unsnooze"
            ? "unsnooze"
            : "snooze";
      const hours = action === "snooze-1h" ? 1 : action === "snooze-24h" ? 24 : null;
      try {
        const response = await fetch(`/api/incidents/${alert.id}/${verb}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            hours === null
              ? { host: alert.hostId }
              : { host: alert.hostId, hours },
          ),
        });
        if (response.status === 401) {
          signInAgain();
          return;
        }
        const result = (await response.json().catch(() => null)) as {
          incident?: Alert;
          error?: string;
        } | null;
        if (!response.ok) {
          setToast(result?.error ?? "No se pudo actualizar la incidencia");
          return;
        }
        const updated = result?.incident;
        if (updated)
          setIncidentDetail((previous) =>
            previous && previous.id === updated.id
              ? { ...previous, data: updated, missing: false }
              : previous,
          );
        await refresh();
      } catch {
        setToast("No se pudo actualizar la incidencia");
      }
    },
    [refresh, signInAgain],
  );

  const sameHost = (a: string | null, b: string | null) =>
    a === b || (a ?? primary) === (b ?? primary);  /** Never render one host's data while another host is selected. */
  const data =
    snapshot && sameHost(snapshot.scope, scope) ? snapshot.data : null;
  const connected = Boolean(data?.connected && !error);
  const shownId = data?.host?.id ?? scope ?? primary;
  const hosts = useMemo<HostStatus[]>(
    () =>
      (directory.hosts.length
        ? directory.hosts
        : data
          ? [
              {
                id: shownId ?? "nas-home",
                name: data.host?.name ?? "NAS-HOME",
                role: data.host?.role ?? "instance",
                connected,
                lastAt: data.lastAt,
              },
            ]
          : []
      ).map((host) =>
        // The visible snapshot is the freshest word on its own host.
        data && host.id === shownId ? { ...host, connected } : host,
      ),
    [directory.hosts, data, shownId, connected],
  );
  const selectedId = scope ?? primary;
  const selected = hosts.find((host) => host.id === shownId) ?? null;
  const hostName = selected?.name ?? "NAS-HOME";
  const canReboot = (selected?.role ?? "instance") === "instance";

  const hostScope = useMemo<HostScope>(
    () => ({
      hosts,
      host: selected,
      key: scope ?? "",
      connected,
      canMutate: connected && !busy,
      canReboot,
      withHost: (path: string) => withHost(path, scope),
    }),
    [hosts, selected, scope, connected, busy, canReboot],
  );

  function navigate(next: View) {
    go({ view: next, tab: "status", host: route.host });
  }
  function selectHost(host: string) {
    if (host === route.host && view === "maintenance") return;
    setError("");
    go({ view: "maintenance", tab: route.tab, host }, view !== "maintenance");
  }
  /** Completion notice for a sensitive action, same wording as the own dialog. */
  function settled(outcome: SensitiveActionOutcome, hostLabel: string) {
    if (outcome.status === "failed") return;
    setToast(
      outcome.status === "pending"
        ? `Acción solicitada. Esperando confirmación de ${hostLabel}.`
        : "Operación completada.",
    );
  }
  function request(action: ActionRequest) {
    const reboot = action.body.action === "reboot";
    // The server is the authority; the UI only asks for a passkey where the
    // shared manifest says the action is protected (D-07).
    if (
      requiresVerificationForAction(action.body.action) &&
      !(reboot && !canReboot)
    ) {
      const hostLabel = hostName;
      sensitive.request({
        title: action.title,
        description: hostLabel,
        consequences: [{ tone: "warn", text: action.detail }],
        confirmLabel: "Confirmar",
        destructive:
          action.body.action === "purge" ||
          action.body.action === "empty-trash",
        endpoint: withHost("/api/action", scope),
        body: action.body,
        ...(action.phrase
          ? {
              typedConfirmation: {
                label: `Escribe ${action.phrase}`,
                value: action.phrase,
              },
            }
          : {}),
        onSettled: (outcome) => {
          settled(outcome, hostLabel);
          void (async () => {
            if (outcome.status !== "failed") await action.after?.();
            await refresh();
          })();
        },
      });
      return;
    }
    setOperation(action);
    setOperationHost({ id: scope, name: hostName });
    setBlocked(reboot && !canReboot);
    setDestination(action.destination ?? "");
    setPhrase("");
    setActionError(
      reboot && !canReboot
        ? `${hostName} no se puede reiniciar desde el hub.`
        : "",
    );
    dialog.current?.showModal();
  }
  async function execute(event: React.FormEvent) {
    event.preventDefault();
    if (!operation || busy || blocked) return;
    if (!sameHost(operationHost.id, scope)) {
      // The host changed after the dialog opened: never send it elsewhere.
      setActionError(
        `La acción era para ${operationHost.name}. Ábrela de nuevo en el host seleccionado.`,
      );
      return;
    }
    setBusy(true);
    setActionError("");
    try {
      const response = await fetch(withHost("/api/action", operationHost.id), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          ...operation.body,
          ...(operation.destination !== undefined ? { destination } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      dialog.current?.close();
      setToast(
        result.status === "pending"
          ? `Acción solicitada. Esperando confirmación de ${operationHost.name}.`
          : "Operación completada.",
      );
      await operation.after?.();
      await refresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "No se pudo completar la acción",
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const metrics = data?.latest;
  const openAlerts = data?.alerts.filter((a) => !a.resolvedAt) ?? [];
  const title = headings[view];
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "example.com";
  const crumbs = [
    headings[view],
    ...(view === "maintenance"
      ? [maintenanceTabs.find((t) => t.id === route.tab)?.label ?? ""]
      : []),
  ];

  return (
    <HostScopeContext value={hostScope}>
      <div className="app-frame">
        <div className="shell">
          <aside className="sidebar">
            <div className="sidebar-top">
              <Link
                className="brand"
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("summary");
                }}
              >
                hub<span>.</span>
              </Link>
            </div>
            <nav aria-label="Navegación principal" ref={nav}>
              {navigation.map((item) => (
                <button
                  key={item.id}
                  className={
                    view === item.id ? "nav-item selected" : "nav-item"
                  }
                  aria-current={view === item.id ? "page" : undefined}
                  data-nav={item.id}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon />
                  <span>{item.label}</span>
                  {item.id === "maintenance" && data && (
                    <b data-maintenance-count="">
                      {data.openAlerts ?? openAlerts.length}
                    </b>
                  )}
                  {view === item.id && item.id !== "maintenance" && <i className="nav-dot" />}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              {hosts.length > 0 && (
                <SidebarHosts
                  hosts={hosts}
                  current={view === "maintenance" ? selectedId : null}
                  href={(host) =>
                    routeHref({ view: "maintenance", tab: route.tab, host })
                  }
                  onOpen={selectHost}
                />
              )}
              <button className="profile" onClick={() => navigate("settings")}>
                <span className="avatar">{name.charAt(0).toUpperCase()}</span>
                <span>
                  <strong>{name}</strong>
                </span>
                <Settings2 />
              </button>
            </div>
          </aside>
          <main className="workspace">
            <header className="topbar">
              <nav className="breadcrumbs" aria-label="Migas">
                <ol>
                  <li>Mi espacio</li>
                  {crumbs.map((crumb, index) => (
                    <li
                      key={crumb}
                      aria-current={
                        index === crumbs.length - 1 ? "page" : undefined
                      }
                    >
                      <ChevronRight aria-hidden="true" />
                      {crumb}
                    </li>
                  ))}
                </ol>
              </nav>
              <div className="topbar-search" data-slot="search">
                <CommandSearch
                  containers={metrics?.containers ?? []}
                  onNotice={setToast}
                  onContainer={(id) => {
                    go({ ...route, view: "maintenance", tab: "status" });
                    window.setTimeout(
                      () =>
                        document
                          .getElementById(`container-${id}`)
                          ?.scrollIntoView({ block: "center" }),
                      100,
                    );
                  }}
                />
              </div>
              <div className="toolbar">
                <span
                  className={`connection-chip ${connected ? "" : "stale"}`}
                  data-live={connected}
                >
                  <i
                    className={`status-dot ${connected ? "online" : "offline"}`}
                  />
                  {connected ? "En directo" : "Sin conexión"}
                </span>
                <button
                  className="icon-button notification-button"
                  aria-label={`Avisos, ${openAlerts.length} incidencias abiertas`}
                  onClick={() => navigate("alerts")}
                >
                  <Bell />
                  {openAlerts.length > 0 && <b>{openAlerts.length}</b>}
                </button>
                <button
                  className="icon-button"
                  aria-label="Cerrar sesión"
                  onClick={async () => {
                    await authClient.signOut();
                    router.replace("/");
                    router.refresh();
                  }}
                >
                  <LogOut />
                </button>
              </div>
            </header>
            <div
              className="page-content"
              data-view={view}
              data-subview={view === "maintenance" ? route.tab : undefined}
              data-host={data ? (shownId ?? undefined) : undefined}
            >
              <div className="page-heading">
                <div>
                  <p className="date-label">
                    {new Date().toLocaleDateString("es", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
                    {view === "maintenance" && selected && (
                      <> · {selected.name}</>
                    )}
                  </p>
                  <h1>{title}</h1>
                </div>
                <div className="heading-tools">
                  {view === "maintenance" && hosts.length > 1 && (
                    <HostSwitcher
                      hosts={hosts}
                      selected={selectedId}
                      onSelect={selectHost}
                    />
                  )}
                  {view === "maintenance" && (
                    <nav className="segmented" aria-label="Secciones">
                      {maintenanceTabs.map((tab) => (
                        <a
                          key={tab.id}
                          href={routeHref({ ...route, tab: tab.id })}
                          data-subview-link={tab.id}
                          aria-current={
                            route.tab === tab.id ? "page" : undefined
                          }
                          onClick={(event) => {
                            event.preventDefault();
                            go({ ...route, tab: tab.id });
                          }}
                        >
                          {tab.label}
                        </a>
                      ))}
                    </nav>
                  )}
                  <div className="last-update">
                    <span>Última actualización</span>
                    <time>
                      {data?.lastAt
                        ? new Date(data.lastAt).toLocaleTimeString("es", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })
                        : "Esperando datos"}
                    </time>
                  </div>
                </div>
              </div>
              {error && (
                <p className="notice error" role="alert">
                  <TriangleAlert />
                  {error}
                </p>
              )}
              {!connected && data && (
                <p className="notice warning">
                  <TriangleAlert />
                  {hostName} no responde o los datos están desactualizados.
                  Puedes consultar el historial; las acciones están
                  desactivadas.
                </p>
              )}
              {(!data || !metrics) &&
                ["summary", "resources", "maintenance"].includes(view) && (
                  <section className="panel empty-state">
                    <LoaderCircle />
                    <h2>Esperando el primer pulso.</h2>
                  </section>
                )}

              {metrics && data && view === "summary" && (
                <SummaryView
                  data={data}
                  metrics={metrics}
                  connected={connected}
                  openAlerts={openAlerts.length}
                  range={range}
                  setRange={setRange}
                  navigate={navigate}
                />
              )}
              {metrics && data && view === "resources" && (
                <ResourcesView
                  data={data}
                  metrics={metrics}
                  range={range}
                  setRange={setRange}
                />
              )}
              {metrics &&
                data &&
                view === "maintenance" &&
                route.tab === "status" && (
                  <MaintenanceStatus
                    metrics={metrics}
                    expected={data.settings.expectedContainers}
                    watchPending={data.watchPending}
                    connected={connected}
                    disabled={!connected || busy}
                    lastAt={data.lastAt}
                    request={request}
                    appDomain={appDomain}
                    onSensitiveSettled={() => void refresh()}
                  />
                )}
              {view === "maintenance" && route.tab === "deployments" && (
                <Deployments key={selectedId} />
              )}
              {view === "files" && (
                <FileBrowser connected={connected && !busy} request={request} />
              )}
              {view === "apps" && (
                <AppsView
                  appDomain={appDomain}
                  containers={connected ? metrics?.containers : undefined}
                />
              )}
              {view === "settings" && data && (
                <Settings value={data.settings} refresh={refresh} />
              )}
              {view === "alerts" && data && (
                <AlertsView
                  data={data}
                  requested={requestedIncident}
                  onAction={runIncidentAction}
                  incident={
                    incidentDetail &&
                    incidentDetail.id === requestedIncident
                      ? incidentDetail.data
                      : null
                  }
                  incidentHost={incidentDetail?.host ?? incidentHost}
                  incidentMissing={Boolean(
                    incidentDetail &&
                      incidentDetail.id === requestedIncident &&
                      incidentDetail.missing,
                  )}
                />
              )}
              <footer className="page-footer">
                <span>
                  hub<span className="accent">.</span>
                </span>
              </footer>
            </div>
          </main>
          <dialog
            ref={dialog}
            className="action-dialog"
            data-blocked={blocked}
            onCancel={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            <form onSubmit={execute} className="stack">
              <div className="section-heading">
                <h2>{operation?.title}</h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cerrar"
                  disabled={busy}
                  onClick={() => dialog.current?.close()}
                >
                  <X />
                </button>
              </div>
              <p className="subtle">{operation?.detail}</p>
              {operation?.destination !== undefined && (
                <label>
                  Ruta de destino
                  <input
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
              )}
              {operation?.phrase && (
                <label>
                  Escribe {operation.phrase}
                  <input
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
              )}
              {actionError && (
                <p className="error" role="alert">
                  {actionError}
                </p>
              )}
              <div className="toolbar">
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    busy ||
                    blocked ||
                    Boolean(operation?.phrase && phrase !== operation.phrase)
                  }
                >
                  {busy ? "Comprobando…" : "Confirmar"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => dialog.current?.close()}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </dialog>
          {sensitive.dialog}
          {toast && (
            <div className="toast" role="status" data-toast="">
              <CircleCheck />
              <span>{toast}</span>
              <button
                className="icon-button"
                aria-label="Cerrar aviso"
                onClick={() => setToast("")}
              >
                <X />
              </button>
            </div>
          )}
        </div>
      </div>
    </HostScopeContext>
  );
}
