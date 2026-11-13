"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bell,
  ChevronRight,
  CircleCheck,
  FolderOpen,
  Grid2X2,
  HardDrive,
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
import type { Overview } from "@/lib/types";
import { FileBrowser, type ActionRequest } from "./file-browser";
import { Settings } from "./settings";
import { AlertsView } from "./views/alerts";
import { AppsView } from "./views/apps";
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
];

export function Dashboard({ name }: { name: string }) {
  const router = useRouter();
  const [route, setRoute] = useState<Route>({
    view: "summary",
    tab: "status",
  });
  const { view } = route;
  const [range, setRange] = useState("1h");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [operation, setOperation] = useState<ActionRequest | null>(null);
  const [destination, setDestination] = useState("");
  const [phrase, setPhrase] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const tabId = useRef("");

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`/api/overview?range=${range}`, {
          signal,
        });
        if (response.status === 401) {
          router.replace("/");
          router.refresh();
          return;
        }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setData(result);
        setError("");
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError"))
          setError(
            err instanceof Error
              ? err.message
              : "No se pudo actualizar el panel",
          );
      }
    },
    [range, router],
  );

  useEffect(() => {
    const requested = readRoute(window.location.search);
    queueMicrotask(() => setRoute(requested));
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

  function go(next: Route) {
    setRoute(next);
    window.history.replaceState(null, "", routeHref(next));
    window.scrollTo({ top: 0 });
  }
  function navigate(next: View) {
    go({ view: next, tab: "status" });
  }
  function request(action: ActionRequest) {
    setOperation(action);
    setDestination(action.destination ?? "");
    setPhrase("");
    setActionError("");
    dialog.current?.showModal();
  }
  async function execute(event: React.FormEvent) {
    event.preventDefault();
    if (!operation || busy) return;
    setBusy(true);
    setActionError("");
    try {
      const response = await fetch("/api/action", {
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
          ? "Acción solicitada. Esperando confirmación del NAS."
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
  const connected = Boolean(data?.connected && !error);
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
          <nav aria-label="Navegación principal">
            {navigation.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-item selected" : "nav-item"}
                aria-current={view === item.id ? "page" : undefined}
                data-nav={item.id}
                onClick={() => navigate(item.id)}
              >
                <item.icon />
                <span>{item.label}</span>
                {view === item.id && <i className="nav-dot" />}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="server-label">
              <HardDrive />
              <div>
                <strong>NAS-HOME</strong>
                <span>
                  <i
                    className={`status-dot ${connected ? "online" : "offline"}`}
                  />
                  {connected ? "Conectado" : "Sin conexión"}
                </span>
              </div>
            </div>
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
            <div className="topbar-search" data-slot="search" />
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
          >
            <div className="page-heading">
              <div>
                <p className="date-label">
                  {new Date().toLocaleDateString("es", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })}
                </p>
                <h1>{title}</h1>
              </div>
              <div className="heading-tools">
                {view === "maintenance" && (
                  <nav className="segmented" aria-label="Secciones">
                    {maintenanceTabs.map((tab) => (
                      <a
                        key={tab.id}
                        href={routeHref({ view, tab: tab.id })}
                        data-subview-link={tab.id}
                        aria-current={route.tab === tab.id ? "page" : undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          go({ view, tab: tab.id });
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
                El NAS no responde o los datos están desactualizados. Puedes
                consultar el historial; las acciones están desactivadas.
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
            {metrics && data && view === "maintenance" && (
              <MaintenanceStatus
                metrics={metrics}
                expected={data.settings.expectedContainers}
                connected={connected}
                disabled={!connected || busy}
                lastAt={data.lastAt}
                request={request}
              />
            )}
            {view === "files" && (
              <FileBrowser connected={connected && !busy} request={request} />
            )}
            {view === "apps" && <AppsView appDomain={appDomain} />}
            {view === "settings" && data && (
              <Settings value={data.settings} refresh={refresh} />
            )}
            {view === "alerts" && data && <AlertsView data={data} />}
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
        {toast && (
          <div className="toast" role="status">
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
  );
}
