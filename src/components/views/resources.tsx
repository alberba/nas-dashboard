import { HardDrive, Thermometer } from "lucide-react";
import { bytes, uptime } from "@/lib/format";
import type { Metrics, Overview } from "@/lib/types";
import { Chart } from "../chart";
import { MetricCards, Range, Storage } from "./shared";

export function ResourcesView({
  data,
  metrics,
  range,
  setRange,
}: {
  data: Overview;
  metrics: Metrics;
  range: string;
  setRange: (range: string) => void;
}) {
  return (
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
            <p className="subtle">Sin sensores</p>
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
  );
}
