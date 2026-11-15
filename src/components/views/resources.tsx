import { bytes, percent, uptime } from "@/lib/format";
import type { Metrics, Overview } from "@/lib/types";
import { Chart } from "../chart";
import { Panel, StatusStrip } from "../ui";
import styles from "./overview.module.css";
import {
  CpuPanel,
  IoPanel,
  LatencyPanel,
  MemoryPanel,
  NetworkPanel,
  RaidPanel,
  SystemPanel,
  TemperaturesPanel,
  VolumesPanel,
  volumesOf,
} from "./resource-panels";
import {
  Range,
  SeriesKey,
  celsius,
  describeChart,
  levelTone,
  occupation,
  temperatureLevel,
  volumeLevel,
} from "./shared";
import type { Series } from "./series";

const charts: { series: Series[]; measure: "average" | "peak" }[] = [
  {
    series: [{ field: "cpu", label: "CPU", color: "var(--accent)" }],
    measure: "average",
  },
  {
    series: [
      { field: "memory", label: "Memoria", color: "var(--lilac)" },
      { field: "swap", label: "Swap", color: "var(--peach)" },
    ],
    measure: "average",
  },
  {
    series: [
      { field: "load1", label: "Carga 1 min", color: "var(--accent)" },
      { field: "load5", label: "Carga 5 min", color: "var(--peach)" },
      { field: "load15", label: "Carga 15 min", color: "var(--lilac)" },
    ],
    measure: "average",
  },
  {
    series: [
      { field: "rx", label: "Red · entrada", color: "var(--gain)" },
      { field: "tx", label: "Red · salida", color: "var(--peach)" },
    ],
    measure: "peak",
  },
  {
    series: [
      { field: "ioRead", label: "Disco · lectura", color: "var(--gain)" },
      { field: "ioWrite", label: "Disco · escritura", color: "var(--peach)" },
    ],
    measure: "peak",
  },
  {
    series: [
      { field: "readAwait", label: "Lectura", color: "var(--gain)" },
      { field: "writeAwait", label: "Escritura", color: "var(--peach)" },
    ],
    measure: "average",
  },
];

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
  const volumes = volumesOf(metrics);
  const fullest = volumes.reduce<(typeof volumes)[number] | null>(
    (top, volume) => (!top || occupation(volume) > occupation(top) ? volume : top),
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
  const swap = metrics.memory.swap;

  return (
    <div className="page-stack">
      <StatusStrip
        label={`Valores actuales de ${data.host?.name ?? "NAS-HOME"}`}
        segments={[
          {
            id: "cpu",
            label: "CPU",
            value: percent(metrics.cpu),
            detail: metrics.load
              ? `carga ${metrics.load[0].toLocaleString("es", { maximumFractionDigits: 2 })}`
              : "uso ahora",
          },
          {
            id: "memory",
            label: "Memoria",
            value: bytes(metrics.memory.used),
            detail: `${percent(memory)} de ${bytes(metrics.memory.total)}`,
          },
          ...(swap
            ? [
                {
                  id: "swap",
                  label: "Swap",
                  value: bytes(swap.used),
                  detail: `${percent(swap.total ? (swap.used / swap.total) * 100 : 0)} de ${bytes(swap.total)}`,
                },
              ]
            : []),
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
            <div className={styles.chartCell} key={series[0].field}>
              <div className={styles.seriesKeys}>
                {series.map((item) => (
                  <SeriesKey
                    key={item.field}
                    history={data.history}
                    series={item}
                    measure={measure}
                  />
                ))}
              </div>
              <Chart
                id={series[0].field}
                history={data.history}
                series={series}
                description={describeChart(data.history, series, range)}
              />
            </div>
          ))}
        </div>
      </Panel>
      <div className="columns">
        <div className={`main-column ${styles.column}`}>
          <CpuPanel metrics={metrics} />
          <MemoryPanel metrics={metrics} />
          <NetworkPanel metrics={metrics} />
          <LatencyPanel metrics={metrics} />
        </div>
        <div className="side-column">
          <RaidPanel metrics={metrics} />
          <SystemPanel metrics={metrics} />
          <TemperaturesPanel metrics={metrics} settings={data.settings} />
          <IoPanel metrics={metrics} />
        </div>
      </div>
      <VolumesPanel metrics={metrics} settings={data.settings} />
    </div>
  );
}
