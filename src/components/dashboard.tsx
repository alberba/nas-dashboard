"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Box,
  ChevronRight,
  CircleCheck,
  Cpu,
  Database,
  FolderOpen,
  Grid2X2,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MemoryStick,
  Network,
  Play,
  Power,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Thermometer,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { applications } from "@/lib/apps";
import { bytes, percent, uptime } from "@/lib/format";
import type { Overview, Metrics, Container } from "@/lib/types";
import { Chart } from "./chart";
import { FileBrowser, type ActionRequest } from "./file-browser";
import { Settings } from "./settings";

const navigation = [
  { id: "summary", label: "Resumen", icon: LayoutDashboard },
  { id: "resources", label: "Recursos", icon: Activity },
  { id: "containers", label: "Contenedores", icon: Box },
  { id: "files", label: "Archivos", icon: FolderOpen },
  { id: "apps", label: "Aplicaciones", icon: Grid2X2 },
  { id: "settings", label: "Ajustes", icon: Settings2 },
];
const headings: Record<string, [string, string]> = {
  summary: [
    "Todo, bajo control.",
    "El pulso de tu NAS, sin perder de vista lo importante.",
  ],
  resources: [
    "El pulso de tu NAS.",
    "Recursos, actividad e historial para entender qué está pasando.",
  ],
  containers: [
    "Cada servicio, en su sitio.",
    "Consulta su estado y actúa cuando lo necesites.",
  ],
  files: [
    "Tu espacio, en orden.",
    "Biblioteca, descargas y una segunda oportunidad en la papelera.",
  ],
  apps: ["Tu casa digital.", "Todos tus servicios, a un paso."],
  settings: [
    "A tu manera.",
    "Acceso, notificaciones y los avisos que te importan.",
  ],
  alerts: [
    "Lo que necesita atención.",
    "Incidencias, recuperaciones y actividad reciente.",
  ],
};

export function Dashboard({ name }: { name: string }) {
  const router = useRouter();
  const [view, setView] = useState("summary");
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
    const requested = new URLSearchParams(window.location.search).get("view");
    if (requested && headings[requested])
      queueMicrotask(() => setView(requested));
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

  function navigate(next: string) {
    setView(next);
    window.history.replaceState(
      null,
      "",
      next === "summary" ? "/" : `/?view=${next}`,
    );
    window.scrollTo({ top: 0 });
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
  const title = headings[view] ?? headings.summary;
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "example.com";

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
            <span className="sidebar-subtitle">Tu NAS, a la vista</span>
          </div>
          <nav aria-label="Navegación principal">
            {navigation.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-item selected" : "nav-item"}
                aria-current={view === item.id ? "page" : undefined}
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
                <small>Tu espacio personal</small>
              </span>
              <Settings2 />
            </button>
          </div>
        </aside>
        <main className="workspace">
          <header className="topbar">
            <span className="subtle">
              Mi espacio <ChevronRight />
              {view === "alerts"
                ? "Avisos"
                : navigation.find((n) => n.id === view)?.label}
            </span>
            <div className="toolbar">
              <span className={`connection-chip ${connected ? "" : "stale"}`}>
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
          <div className="page-content">
            <div className="page-heading">
              <div>
                <p className="date-label">
                  {new Date().toLocaleDateString("es", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })}
                </p>
                <h1>{title[0]}</h1>
                <p className="lede">{title[1]}</p>
              </div>
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
                <small>
                  {connected
                    ? `Cada ${data?.interval ?? 5} segundos`
                    : "Mostrando el último dato disponible"}
                </small>
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
              ["summary", "resources", "containers"].includes(view) && (
                <section className="panel empty-state">
                  <LoaderCircle />
                  <h2>Esperando el primer pulso.</h2>
                  <p className="subtle">
                    Las métricas reales aparecerán cuando Oracle reciba la
                    primera muestra del NAS.
                  </p>
                </section>
              )}

            {metrics && data && view === "summary" && (
              <div className="stack section-gap">
                <div className="overview-grid">
                  <section className="panel storage-panel">
                    <div className="section-heading">
                      <h2>
                        <HardDrive />
                        Un lugar para todo
                      </h2>
                      <span className="subtle">Almacenamiento</span>
                    </div>
                    <Storage metrics={metrics} />
                    <div className="storage-footer">
                      <span className="with-icon">
                        <Database />
                        Biblioteca y descargas
                      </span>
                      <button
                        className="text-button"
                        onClick={() => navigate("files")}
                      >
                        Ver archivos
                        <ArrowUpRight />
                      </button>
                    </div>
                  </section>
                  <section className="panel health-panel">
                    <div className="section-heading">
                      <h2>Estado general</h2>
                      <ShieldCheck />
                    </div>
                    <div
                      className={`health-icon ${openAlerts.length || !connected ? "warn" : ""}`}
                    >
                      {openAlerts.length || !connected ? (
                        <TriangleAlert />
                      ) : (
                        <CircleCheck />
                      )}
                    </div>
                    <h3>
                      {!connected
                        ? "Sin conexión"
                        : openAlerts.length
                          ? "Hay algo que revisar"
                          : "Todo en su sitio"}
                    </h3>
                    <p className="subtle">
                      {!connected
                        ? "Oracle conserva el último estado recibido."
                        : openAlerts.length
                          ? `${openAlerts.length} incidencia${openAlerts.length === 1 ? "" : "s"} necesita${openAlerts.length === 1 ? "" : "n"} tu atención.`
                          : "Los recursos están dentro de los umbrales configurados."}
                    </p>
                    <div className="health-facts">
                      <span>
                        En marcha<strong>{uptime(metrics.uptime)}</strong>
                      </span>
                      <span>
                        Servicios activos
                        <strong>
                          {
                            metrics.containers.filter(
                              (c) => c.state === "running",
                            ).length
                          }
                          <small> / {metrics.containers.length}</small>
                        </strong>
                      </span>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("alerts")}
                    >
                      Ver avisos
                      <ChevronRight />
                    </button>
                  </section>
                </div>
                <MetricCards metrics={metrics} />
                <section className="panel">
                  <div className="section-heading wrap">
                    <div>
                      <h2>Actividad reciente</h2>
                      <p className="subtle">Cómo respira tu servidor.</p>
                    </div>
                    <Range value={range} set={setRange} />
                  </div>
                  <Chart history={data.history} />
                  <div className="chart-legend">
                    <span>
                      <i className="legend-dot accent-bg" />
                      CPU
                    </span>
                    <span>Historial de 30 días</span>
                  </div>
                </section>
                <section className="panel">
                  <div className="section-heading">
                    <h2>Lo que más está trabajando</h2>
                    <button
                      className="text-button"
                      onClick={() => navigate("containers")}
                    >
                      Todos los servicios
                      <ArrowUpRight />
                    </button>
                  </div>
                  {[...metrics.containers]
                    .filter((c) => c.state === "running")
                    .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))
                    .slice(0, 5)
                    .map((c) => (
                      <div className="service-row" key={c.id}>
                        <span className="service-icon">
                          <Box />
                        </span>
                        <div className="service-name">
                          <strong>{c.name}</strong>
                          <small className="subtle">En ejecución</small>
                        </div>
                        <span className="service-cpu">
                          {percent(c.cpu)}
                          <small>CPU</small>
                        </span>
                        <span className="service-memory">
                          {bytes(c.memory)}
                          <small>RAM</small>
                        </span>
                        <span className="status-badge">Activo</span>
                      </div>
                    ))}
                </section>
              </div>
            )}

            {metrics && data && view === "resources" && (
              <div className="stack section-gap">
                <MetricCards metrics={metrics} />
                <div className="toolbar wrap">
                  <h2>Tu historial</h2>
                  <div className="push-end">
                    <Range value={range} set={setRange} />
                  </div>
                </div>
                <section className="panel">
                  <Chart history={data.history} />
                  <Chart
                    history={data.history}
                    field="memory"
                    label="Memoria"
                    color="var(--lilac)"
                  />
                </section>
                <section className="panel">
                  <Chart
                    history={data.history}
                    field="rx"
                    label="Red · entrada"
                    color="var(--gain)"
                  />
                  <Chart
                    history={data.history}
                    field="tx"
                    label="Red · salida"
                    color="var(--peach)"
                  />
                </section>
                <div className="settings-grid">
                  <section className="panel stack">
                    <h2>
                      <Thermometer />
                      Temperaturas
                    </h2>
                    {metrics.temperatures.length ? (
                      metrics.temperatures.map((sensor, i) => (
                        <div className="setting-row" key={i}>
                          <span>{sensor.name}</span>
                          <strong
                            className={
                              sensor.value >= data.settings.temperature
                                ? "danger-text"
                                : ""
                            }
                          >
                            {sensor.value.toLocaleString("es")} °C
                          </strong>
                        </div>
                      ))
                    ) : (
                      <p className="subtle">
                        No hay sensores de temperatura disponibles.
                      </p>
                    )}
                  </section>
                  <section className="panel stack">
                    <h2>
                      <HardDrive />
                      Actividad de discos
                    </h2>
                    <div className="setting-row">
                      <span>Lectura</span>
                      <strong>{bytes(metrics.io.read, true)}</strong>
                    </div>
                    <div className="setting-row">
                      <span>Escritura</span>
                      <strong>{bytes(metrics.io.write, true)}</strong>
                    </div>
                    <div className="setting-row">
                      <span>Tiempo en marcha</span>
                      <strong>{uptime(metrics.uptime)}</strong>
                    </div>
                  </section>
                </div>
                <section className="panel">
                  <h2>Capacidad de tus volúmenes</h2>
                  <Storage metrics={metrics} />
                </section>
              </div>
            )}

            {metrics && view === "containers" && (
              <div className="stack section-gap">
                <div className="toolbar wrap">
                  <span className="subtle">
                    {
                      metrics.containers.filter((c) => c.state === "running")
                        .length
                    }{" "}
                    activos de {metrics.containers.length} servicios · consumo
                    actualizado cada 10 s
                  </span>
                  <button
                    className="secondary danger-text push-end"
                    disabled={!connected || busy}
                    onClick={() =>
                      request({
                        body: {
                          action: "reboot",
                          confirmation: "REINICIAR NAS",
                        },
                        title: "Reiniciar el NAS",
                        detail:
                          "Se interrumpirán las reproducciones, las descargas y el acceso por NPM. Oracle seguirá funcionando. El resultado se comprobará cuando el NAS vuelva a responder.",
                        phrase: "REINICIAR NAS",
                      })
                    }
                  >
                    <Power />
                    Reiniciar NAS
                  </button>
                </div>
                <section className="panel">
                  {[...metrics.containers]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((container) => (
                      <ContainerRow
                        key={container.id}
                        container={container}
                        disabled={!connected || busy}
                        request={request}
                      />
                    ))}
                </section>
                <p className="fineprint">
                  NPM, Tailscale y el agente están protegidos para conservar la
                  conexión. Las acciones no se repiten automáticamente si se
                  pierde la respuesta.
                </p>
              </div>
            )}
            {view === "files" && (
              <FileBrowser connected={connected && !busy} request={request} />
            )}
            {view === "apps" && (
              <div className="apps-grid">
                {applications.map((app) => (
                  <a
                    key={app.host}
                    href={`https://${app.host}.${appDomain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="panel app-card"
                  >
                    <div className="section-heading">
                      <span className={`app-letter ${app.tone}`}>
                        {app.letter}
                      </span>
                      <ArrowUpRight />
                    </div>
                    <span className="subtle app-category">{app.category}</span>
                    <h2>{app.name}</h2>
                    <p className="subtle">{app.description}</p>
                    <span className="app-url">
                      {app.host}.{appDomain}
                    </span>
                  </a>
                ))}
              </div>
            )}
            {view === "settings" && data && (
              <Settings value={data.settings} refresh={refresh} />
            )}
            {view === "alerts" && data && (
              <div className="stack section-gap">
                <section className="panel stack">
                  <h2>Incidencias y recuperaciones</h2>
                  {!data.alerts.length && (
                    <div className="empty-state">
                      <CircleCheck />
                      <h3>Sin incidencias registradas</h3>
                      <p className="subtle">
                        Aquí verás lo que necesite atención y cuándo se
                        recupere.
                      </p>
                    </div>
                  )}
                  {data.alerts.map((alert) => (
                    <div className="alert-row" key={alert.id}>
                      {alert.resolvedAt ? (
                        <CircleCheck className="gain" />
                      ) : (
                        <TriangleAlert className="danger-text" />
                      )}
                      <div>
                        <strong>{alert.title}</strong>
                        <p className="subtle">{alert.detail}</p>
                        <time>
                          {new Date(alert.at).toLocaleString("es")}
                          {alert.resolvedAt
                            ? ` · Resuelto ${new Date(alert.resolvedAt).toLocaleString("es")}`
                            : " · Pendiente"}
                        </time>
                      </div>
                    </div>
                  ))}
                </section>
                <section className="panel stack">
                  <h2>Acciones recientes</h2>
                  {!data.operations.length && (
                    <p className="subtle">
                      Las acciones que realices aparecerán aquí.
                    </p>
                  )}
                  {data.operations.map((op) => (
                    <div className="alert-row" key={op.id}>
                      <RefreshCw />
                      <div>
                        <strong>
                          {(
                            {
                              start: "Iniciar",
                              stop: "Detener",
                              restart: "Reiniciar",
                              reboot: "Reiniciar NAS",
                              move: "Mover",
                              trash: "Enviar a papelera",
                              restore: "Restaurar",
                              purge: "Eliminar definitivamente",
                              "empty-trash": "Vaciar papelera",
                            } as Record<string, string>
                          )[op.action] ?? op.action}
                        </strong>
                        <p className="subtle">
                          {op.target.length === 64
                            ? "Contenedor " + op.target.slice(0, 12)
                            : op.target}{" "}
                          · {op.detail}
                        </p>
                        <time>
                          {new Date(op.at).toLocaleString("es")} ·{" "}
                          {op.status === "success"
                            ? "Completada"
                            : op.status === "failed"
                              ? "No realizada"
                              : "Pendiente de verificar"}
                        </time>
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            )}
            <footer className="page-footer">
              <span>
                hub<span className="accent">.</span> Hecho para tenerlo cerca.
              </span>
              <span>NAS-HOME · Historial de 30 días</span>
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

function Storage({ metrics }: { metrics: Metrics }) {
  return (
    <div className="storage-list">
      {metrics.disks.map((disk) => {
        const occupied = (disk.used / disk.total) * 100;
        return (
          <div className="disk" key={disk.root}>
            <div className="disk-top">
              <span className="disk-symbol">
                <HardDrive />
                <i />
              </span>
              <div>
                <h3>{disk.name}</h3>
                <p className="subtle">{bytes(disk.total)} de capacidad</p>
              </div>
              <span className="disk-percent">
                {Math.round(occupied)}
                <small>%</small>
              </span>
            </div>
            <div
              className="capacity-bar"
              role="meter"
              aria-label={`Ocupación de ${disk.name}`}
              aria-valuenow={Math.round(occupied)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                style={{ inlineSize: `${occupied}%` }}
                className={occupied > 90 ? "full" : ""}
              />
            </div>
            <div className="disk-numbers">
              <span>
                <i className="legend-dot accent-bg" />
                {bytes(disk.used)} <small>ocupados</small>
              </span>
              <span>
                <i className="legend-dot neutral-bg" />
                {bytes(disk.free)} <small>libres</small>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
function MetricCards({ metrics }: { metrics: Metrics }) {
  const memory = (metrics.memory.used / metrics.memory.total) * 100;
  const highestTemperature = metrics.temperatures.length
    ? Math.max(...metrics.temperatures.map((t) => t.value))
    : null;
  return (
    <div className="metrics-grid">
      <article className="metric">
        <span>
          <Cpu />
          Procesador
        </span>
        <strong>{percent(metrics.cpu)}</strong>
        <div className="mini-meter">
          <i style={{ inlineSize: `${metrics.cpu ?? 0}%` }} />
        </div>
        <small>Uso de CPU</small>
      </article>
      <article className="metric">
        <span>
          <MemoryStick />
          Memoria
        </span>
        <strong>{bytes(metrics.memory.used)}</strong>
        <div className="mini-meter lilac-meter">
          <i style={{ inlineSize: `${memory}%` }} />
        </div>
        <small>
          {percent(memory)} de {bytes(metrics.memory.total)}
        </small>
      </article>
      <article className="metric">
        <span>
          <Network />
          Red
        </span>
        <strong>{bytes(metrics.network.rx, true)}</strong>
        <small className="network-rates">
          <ArrowDown />
          Entrada <ArrowUp />
          {bytes(metrics.network.tx, true)} de salida
        </small>
      </article>
      <article className="metric">
        <span>
          <Thermometer />
          Temperatura
        </span>
        <strong>
          {highestTemperature !== null
            ? highestTemperature.toLocaleString("es") + " °C"
            : "—"}
        </strong>
        <small>
          {highestTemperature !== null
            ? "Sensor con mayor temperatura"
            : "Sin sensores disponibles"}
        </small>
      </article>
    </div>
  );
}
function Range({
  value,
  set,
}: {
  value: string;
  set: (value: string) => void;
}) {
  return (
    <div
      className="segmented range"
      role="group"
      aria-label="Periodo del historial"
    >
      {[
        ["1h", "1 h"],
        ["6h", "6 h"],
        ["24h", "24 h"],
        ["7d", "7 días"],
        ["30d", "30 días"],
      ].map(([id, label]) => (
        <button key={id} aria-pressed={id === value} onClick={() => set(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
function ContainerRow({
  container: c,
  disabled,
  request,
}: {
  container: Container;
  disabled: boolean;
  request: (action: ActionRequest) => void;
}) {
  return (
    <div className="container-row">
      <span className="service-icon">
        <Box />
      </span>
      <div className="service-name">
        <strong>{c.name}</strong>
        <small className="subtle">{c.image}</small>
      </div>
      <span
        className={`status-badge ${c.state === "running" ? "" : "stopped"}`}
      >
        {c.state === "running"
          ? "Activo"
          : c.state === "exited"
            ? "Detenido"
            : c.state}
      </span>
      <span className="service-cpu">
        {percent(c.cpu)}
        <small>CPU</small>
      </span>
      <span className="service-memory">
        {bytes(c.memory)}
        <small>RAM</small>
      </span>
      <div className="row-actions">
        {c.state !== "running" ? (
          <button
            className="icon-button"
            aria-label={`Iniciar ${c.name}`}
            disabled={disabled || c.protected}
            onClick={() =>
              request({
                body: { action: "start", id: c.id },
                title: `Iniciar ${c.name}`,
                detail: "Se iniciará el contenedor y se comprobará su estado.",
              })
            }
          >
            <Play />
          </button>
        ) : (
          <>
            <button
              className="icon-button"
              aria-label={`Reiniciar ${c.name}`}
              disabled={disabled || c.protected}
              onClick={() =>
                request({
                  body: { action: "restart", id: c.id },
                  title: `Reiniciar ${c.name}`,
                  detail:
                    "El servicio se interrumpirá durante el reinicio. Las reproducciones o descargas que dependan de él podrían detenerse.",
                })
              }
            >
              <RefreshCw />
            </button>
            <button
              className="icon-button danger-text"
              aria-label={`Detener ${c.name}`}
              disabled={disabled || c.protected}
              onClick={() =>
                request({
                  body: { action: "stop", id: c.id },
                  title: `Detener ${c.name}`,
                  detail:
                    "El servicio dejará de estar disponible hasta que vuelvas a iniciarlo. Esta parada se considerará intencionada.",
                })
              }
            >
              <Square />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
