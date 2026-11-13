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
import { Segmented } from "../ui";

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
const ranges = [
  { id: "1h", label: "1 h" },
  { id: "6h", label: "6 h" },
  { id: "24h", label: "24 h" },
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
];
export function Range({
  value,
  set,
}: {
  value: string;
  set: (value: string) => void;
}) {
  return (
    <Segmented
      label="Periodo del historial"
      options={ranges}
      value={value}
      onSelect={set}
    />
  );
}
