import {
  ArrowUpRight,
  Box,
  ChevronRight,
  CircleCheck,
  Database,
  HardDrive,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { bytes, percent, uptime } from "@/lib/format";
import type { Metrics, Overview } from "@/lib/types";
import { Chart } from "../chart";
import type { Navigate } from "./routes";
import { MetricCards, Range, Storage } from "./shared";

export function SummaryView({
  data,
  metrics,
  connected,
  openAlerts,
  range,
  setRange,
  navigate,
}: {
  data: Overview;
  metrics: Metrics;
  connected: boolean;
  openAlerts: number;
  range: string;
  setRange: (range: string) => void;
  navigate: Navigate;
}) {
  return (
    <div className="stack section-gap">
      <div className="overview-grid">
        <section className="panel storage-panel">
          <div className="section-heading">
            <h2>
              <HardDrive />
              Un lugar para todo
            </h2>
          </div>
          <Storage metrics={metrics} />
          <div className="storage-footer">
            <span className="with-icon">
              <Database />
              Biblioteca y descargas
            </span>
            <button className="text-button" onClick={() => navigate("files")}>
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
            className={`health-icon ${openAlerts || !connected ? "warn" : ""}`}
          >
            {openAlerts || !connected ? <TriangleAlert /> : <CircleCheck />}
          </div>
          <h3>
            {!connected
              ? "Sin conexión"
              : openAlerts
                ? "Hay algo que revisar"
                : "Todo en su sitio"}
          </h3>
          <div className="health-facts">
            <span>
              En marcha<strong>{uptime(metrics.uptime)}</strong>
            </span>
            <span>
              Servicios activos
              <strong>
                {metrics.containers.filter((c) => c.state === "running").length}
                <small> / {metrics.containers.length}</small>
              </strong>
            </span>
          </div>
          <button className="text-button" onClick={() => navigate("alerts")}>
            Ver avisos
            <ChevronRight />
          </button>
        </section>
      </div>
      <MetricCards metrics={metrics} />
      <section className="panel">
        <div className="section-heading wrap">
          <h2>Actividad reciente</h2>
          <Range value={range} set={setRange} />
        </div>
        <Chart history={data.history} />
        <div className="chart-legend">
          <span>
            <i className="legend-dot accent-bg" />
            CPU
          </span>
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Lo que más está trabajando</h2>
          <button
            className="text-button"
            onClick={() => navigate("maintenance")}
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
  );
}
