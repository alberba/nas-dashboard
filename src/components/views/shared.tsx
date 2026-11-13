import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Thermometer,
} from "lucide-react";
import { bytes, percent } from "@/lib/format";
import type { Metrics } from "@/lib/types";
import { Segmented, type Tone } from "../ui";
import styles from "./overview.module.css";
import { routeHref, type Navigate, type View } from "./routes";
import {
  formatSeries,
  ranges,
  seriesSummary,
  type History,
  type Series,
} from "./series";

export { describeChart, ranges } from "./series";

export function Range({
  value,
  set,
}: {
  value: string;
  set: (value: string) => void;
}) {
  return (
    <div className={styles.range}>
      <Segmented
        label="Periodo del historial"
        options={ranges.map((range) => ({
          id: range.id,
          label: <span data-range={range.id}>{range.label}</span>,
        }))}
        value={value}
        onSelect={set}
      />
    </div>
  );
}

/** Link to another section that keeps the client-side navigation. */
export function ViewLink({
  view,
  navigate,
  children,
  className,
}: {
  view: View;
  navigate: Navigate;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={className ?? styles.viewLink}
      href={routeHref({ view, tab: "status" })}
      data-view-link={view}
      onClick={(event) => {
        event.preventDefault();
        navigate(view);
      }}
    >
      {children}
    </a>
  );
}

/** Legend entry for a chart panel: series dot, name and a summary value. */
export function SeriesKey({
  history,
  series,
  measure = "average",
}: {
  history: History;
  series: Series;
  measure?: "average" | "peak";
}) {
  const summary = seriesSummary(history, series.field);
  return (
    <span className={styles.seriesKey} data-series={series.field}>
      <i className="dot" style={{ color: series.color }} aria-hidden="true" />
      <span className={styles.seriesName}>{series.label}</span>
      <span className={styles.seriesValue}>
        {measure === "peak" ? "pico" : "media"}{" "}
        {formatSeries(
          series.field,
          measure === "peak" ? summary.peak : summary.average,
        )}
      </span>
    </span>
  );
}

export function occupation(disk: { used: number; total: number }) {
  return disk.total > 0 ? (disk.used / disk.total) * 100 : 0;
}

export type Level = "normal" | "watch" | "high";
export const levelTone: Record<Level, Tone> = {
  normal: "gain",
  watch: "peach",
  high: "loss",
};

export function volumeLevel(percentUsed: number, limit: number): Level {
  if (percentUsed >= limit) return "high";
  if (percentUsed >= limit - 10) return "watch";
  return "normal";
}

export function temperatureLevel(value: number, limit: number): Level {
  if (value >= limit) return "high";
  if (value >= limit - 10) return "watch";
  return "normal";
}

export const celsius = (value: number) =>
  `${value.toLocaleString("es", { maximumFractionDigits: 1 })} °C`;

/** Capacity bar; the value is also exposed as a meter for assistive tech. */
export function Meter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: Tone;
}) {
  const rounded = Math.round(value);
  return (
    <span
      className={`${styles.meter} ${tone}`}
      role="meter"
      aria-label={label}
      aria-valuenow={rounded}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i style={{ inlineSize: `${Math.min(100, Math.max(0, value))}%` }} />
    </span>
  );
}

/*
 * Earlier card components, kept unchanged for callers outside Resumen and
 * Recursos. New pages use the status strip and the tables above.
 */
export function Storage({ metrics }: { metrics: Metrics }) {
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
export function MetricCards({ metrics }: { metrics: Metrics }) {
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
