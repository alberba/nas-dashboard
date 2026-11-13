import { bytes, percent, uptime } from "@/lib/format";
import type { Metrics, Overview } from "@/lib/types";
import { Chart } from "../chart";
import { Panel, StatusDot, StatusStrip } from "../ui";
import styles from "./overview.module.css";
import {
  Meter,
  Range,
  SeriesKey,
  celsius,
  describeChart,
  levelTone,
  occupation,
  temperatureLevel,
  volumeLevel,
  type Level,
} from "./shared";
import type { Series } from "./series";

const charts: { series: Series; measure: "average" | "peak" }[] = [
  {
    series: { field: "cpu", label: "CPU", color: "var(--accent)" },
    measure: "average",
  },
  {
    series: { field: "memory", label: "Memoria", color: "var(--lilac)" },
    measure: "average",
  },
  {
    series: { field: "rx", label: "Red · entrada", color: "var(--gain)" },
    measure: "peak",
  },
  {
    series: { field: "tx", label: "Red · salida", color: "var(--peach)" },
    measure: "peak",
  },
];

const temperatureWords: Record<Level, string> = {
  normal: "normal",
  watch: "vigilar",
  high: "alta",
};
const volumeWords: Record<Level, string> = {
  normal: "con espacio",
  watch: "vigilar",
  high: "casi lleno",
};

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
  const memory = (metrics.memory.used / metrics.memory.total) * 100;
  const fullest = metrics.disks.reduce<Metrics["disks"][number] | null>(
    (top, disk) => (!top || occupation(disk) > occupation(top) ? disk : top),
    null,
  );
  const fullestLevel = fullest
    ? volumeLevel(occupation(fullest), data.settings.disk)
    : null;
  const hottest = metrics.temperatures.reduce<
    Metrics["temperatures"][number] | null
  >((top, sensor) => (!top || sensor.value > top.value ? sensor : top), null);
  const heat = hottest
    ? temperatureLevel(hottest.value, data.settings.temperature)
    : null;

  return (
    <div className="page-stack">
      <StatusStrip
        label={`Valores actuales de ${data.host?.name ?? "NAS-HOME"}`}
        segments={[
          {
            id: "cpu",
            label: "CPU",
            value: percent(metrics.cpu),
            detail: "uso ahora",
          },
          {
            id: "memory",
            label: "Memoria",
            value: bytes(metrics.memory.used),
            detail: `${percent(memory)} de ${bytes(metrics.memory.total)}`,
          },
          {
            id: "network",
            label: "Red",
            value: bytes(metrics.network.rx, true),
            detail: `entrada · ${bytes(metrics.network.tx, true)} salida`,
          },
          {
            id: "io",
            label: "Discos",
            value: bytes(metrics.io.read, true),
            detail: `lectura · ${bytes(metrics.io.write, true)} escritura`,
          },
          {
            id: "volumes",
            label: "Volumen más lleno",
            tone: fullestLevel ? levelTone[fullestLevel] : "muted",
            value: fullest ? percent(occupation(fullest)) : "—",
            detail: fullest ? fullest.name : "sin volúmenes",
          },
          {
            id: "temperature",
            label: "Temperatura",
            tone: heat ? levelTone[heat] : "muted",
            value: hottest ? celsius(hottest.value) : "—",
            detail: hottest ? hottest.name : "sin sensores",
          },
          {
            id: "uptime",
            label: "En marcha",
            value: uptime(metrics.uptime),
          },
        ]}
      />
      <Panel
        id="history-title"
        title="Historial"
        tools={<Range value={range} set={setRange} />}
      >
        <div className={styles.historyGrid}>
          {charts.map(({ series, measure }) => (
            <div className={styles.chartCell} key={series.field}>
              <SeriesKey
                history={data.history}
                series={series}
                measure={measure}
              />
              <Chart
                id={series.field}
                history={data.history}
                series={[series]}
                description={describeChart(data.history, [series], range)}
              />
            </div>
          ))}
        </div>
      </Panel>
      <div className="columns">
        <Panel
          id="volumes-title"
          title="Volúmenes"
          count={metrics.disks.length}
          className="main-column"
        >
          <div className="table-scroll">
            <table className={`data-table ${styles.table}`} data-volume-table="">
              <thead>
                <tr>
                  <th scope="col">Volumen</th>
                  <th scope="col">Ruta</th>
                  <th scope="col" className="numeric">
                    Ocupado
                  </th>
                  <th scope="col" className="numeric">
                    Libre
                  </th>
                  <th scope="col" className="numeric">
                    Capacidad
                  </th>
                  <th scope="col">Uso</th>
                </tr>
              </thead>
              <tbody>
                {metrics.disks.map((disk) => {
                  const used = occupation(disk);
                  const level = volumeLevel(used, data.settings.disk);
                  const tone = levelTone[level];
                  return (
                    <tr key={disk.root} data-volume={disk.root} data-level={level}>
                      <td className="name-cell">
                        <span className="row-title">
                          <StatusDot tone={tone} />
                          <strong>{disk.name}</strong>
                        </span>
                        <span className={`row-meta ${tone}`}>
                          {volumeWords[level]} · {bytes(disk.free)} libres de{" "}
                          {bytes(disk.total)}
                        </span>
                      </td>
                      <td className="mono soft">{disk.root}</td>
                      <td className="numeric">{bytes(disk.used)}</td>
                      <td className="numeric">{bytes(disk.free)}</td>
                      <td className="numeric">{bytes(disk.total)}</td>
                      <td className={styles.compactValue}>
                        <span className={styles.usage}>
                          <Meter
                            label={`Ocupación de ${disk.name}`}
                            value={used}
                            tone={tone}
                          />
                          <span className={tone}>{percent(Math.round(used))}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!metrics.disks.length && (
                  <tr className="empty-row">
                    <td colSpan={6}>Sin volúmenes</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="side-column">
          <Panel
            id="temperatures-title"
            title="Temperaturas"
            count={metrics.temperatures.length}
          >
            <div className="table-scroll">
              <table className={`data-table ${styles.table}`} data-sensor-table="">
                <thead>
                  <tr>
                    <th scope="col">Sensor</th>
                    <th scope="col" className="numeric">
                      Valor
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.temperatures.map((sensor) => {
                    const level = temperatureLevel(
                      sensor.value,
                      data.settings.temperature,
                    );
                    return (
                      <tr
                        key={sensor.name}
                        data-sensor={sensor.name}
                        data-level={level}
                      >
                        <td className="name-cell">
                          <span className="row-title">
                            <StatusDot tone={levelTone[level]} />
                            <strong>{sensor.name}</strong>
                          </span>
                          <span className={`row-meta ${levelTone[level]}`}>
                            {temperatureWords[level]}
                          </span>
                        </td>
                        <td className={`numeric ${styles.compactValue}`}>
                          {celsius(sensor.value)}
                        </td>
                      </tr>
                    );
                  })}
                  {!metrics.temperatures.length && (
                    <tr className="empty-row">
                      <td colSpan={2}>Sin sensores</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel id="io-title" title="Actividad de discos">
            <div className="table-scroll">
              <table className={`data-table ${styles.table}`} data-io-table="">
                <thead>
                  <tr>
                    <th scope="col">Medida</th>
                    <th scope="col" className="numeric">
                      Ahora
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["read", "Lectura", metrics.io.read],
                      ["write", "Escritura", metrics.io.write],
                    ] as const
                  ).map(([id, label, value]) => (
                    <tr key={id} data-io={id}>
                      <td className="name-cell">
                        <span className="row-title">
                          <StatusDot tone={value ? "accent" : "muted"} />
                          <strong>{label}</strong>
                        </span>
                      </td>
                      <td className={`numeric ${styles.compactValue}`}>
                        {bytes(value, true)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
