import { ArrowUpRight } from "lucide-react";
import { applications } from "@/lib/apps";
import { bytes, percent, uptime } from "@/lib/format";
import type { Alert, Metrics, Overview } from "@/lib/types";
import { Chart } from "../chart";
import { Panel, StatusDot, StatusStrip, type Tone } from "../ui";
import styles from "./overview.module.css";
import type { Navigate } from "./routes";
import { seriesSummary, type Series } from "./series";
import {
  Meter,
  Range,
  SeriesKey,
  ViewLink,
  celsius,
  describeChart,
  levelTone,
  occupation,
  temperatureLevel,
  volumeLevel,
} from "./shared";

const activity: Series[] = [
  { field: "cpu", label: "CPU", color: "var(--accent)" },
  { field: "memory", label: "Memoria", color: "var(--lilac)" },
];
const shortcuts = 6;

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
  const running = metrics.containers.filter((c) => c.state === "running");
  const stopped = metrics.containers.length - running.length;
  const memory = (metrics.memory.used / metrics.memory.total) * 100;
  const cpuAverage = seriesSummary(data.history, "cpu").average;
  const hottest = metrics.temperatures.reduce<
    Metrics["temperatures"][number] | null
  >((top, sensor) => (!top || sensor.value > top.value ? sensor : top), null);
  const heat = hottest
    ? temperatureLevel(hottest.value, data.settings.temperature)
    : null;
  const health = !connected ? "offline" : openAlerts ? "attention" : "ok";
  const healthTone: Tone = { offline: "muted", attention: "peach", ok: "gain" }[
    health
  ] as Tone;
  const since = new Date(metrics.timestamp - metrics.uptime * 1000);
  const busiest = [...running]
    .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))
    .slice(0, 5);
  const alerts = data.alerts.filter((a) => !a.resolvedAt);
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "example.com";

  return (
    <div className={`page-stack ${styles.summary}`}>
      <StatusStrip
        label={`Estado de ${data.host?.name ?? "NAS-HOME"}`}
        segments={[
          {
            id: "health",
            label: "Estado general",
            tone: healthTone,
            value: (
              <span data-health-state={health}>
                {health === "offline"
                  ? "Sin conexión"
                  : health === "attention"
                    ? `${openAlerts} ${openAlerts === 1 ? "aviso" : "avisos"}`
                    : "Todo en orden"}
              </span>
            ),
            detail: (
              <ViewLink view="alerts" navigate={navigate}>
                Ver avisos
              </ViewLink>
            ),
          },
          {
            id: "uptime",
            label: "En marcha",
            value: uptime(metrics.uptime),
            detail: `desde el ${since.toLocaleDateString("es", { day: "numeric", month: "short" })}`,
          },
          {
            id: "services",
            label: "Servicios",
            value: `${running.length}/${metrics.containers.length}`,
            detail: (
              <ViewLink view="maintenance" navigate={navigate}>
                {stopped
                  ? `${stopped} ${stopped === 1 ? "detenido" : "detenidos"}`
                  : "todos activos"}
              </ViewLink>
            ),
          },
          {
            id: "cpu",
            label: "CPU",
            value: percent(metrics.cpu),
            detail:
              cpuAverage === null ? "sin historial" : `media ${percent(cpuAverage)}`,
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
            id: "temperature",
            label: "Temperatura",
            tone: heat ? levelTone[heat] : "muted",
            value: hottest ? celsius(hottest.value) : "—",
            detail: hottest ? hottest.name : "sin sensores",
          },
        ]}
      />
      <div className="columns">
        <div className={`main-column ${styles.column}`}>
          <Panel
            id="activity-title"
            title="Actividad reciente"
            tools={<Range value={range} set={setRange} />}
          >
            <div className={styles.chartBody}>
              <div className={styles.seriesKeys}>
                {activity.map((series) => (
                  <SeriesKey
                    key={series.field}
                    history={data.history}
                    series={series}
                  />
                ))}
              </div>
              <Chart
                id="activity"
                history={data.history}
                series={activity}
                description={describeChart(data.history, activity, range)}
              />
            </div>
          </Panel>
          <Panel
            id="busy-title"
            title="Lo que más está trabajando"
            count={busiest.length}
            tools={
              <ViewLink view="maintenance" navigate={navigate}>
                Todos los servicios
              </ViewLink>
            }
          >
            <div className="table-scroll">
              <table className={`data-table ${styles.table}`} data-busy-table="">
                <thead>
                  <tr>
                    <th scope="col">Servicio</th>
                    <th scope="col">Estado</th>
                    <th scope="col" className="numeric">
                      CPU
                    </th>
                    <th scope="col" className="numeric">
                      RAM
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {busiest.map((c) => (
                    <tr key={c.id} data-top-service={c.name}>
                      <td className="name-cell">
                        <span className="row-title">
                          <StatusDot tone="gain" />
                          <strong>{c.name}</strong>
                        </span>
                        <span className="row-meta gain">
                          Activo · {percent(c.cpu)} CPU
                        </span>
                      </td>
                      <td className="gain">Activo</td>
                      <td className="numeric">{percent(c.cpu)}</td>
                      <td className={`numeric ${styles.compactValue}`}>
                        {bytes(c.memory)}
                      </td>
                    </tr>
                  ))}
                  {!busiest.length && (
                    <tr className="empty-row">
                      <td colSpan={4}>Ningún servicio en marcha</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
        <div className="side-column">
          <Panel
            id="alerts-title"
            title="Avisos"
            count={alerts.length}
            tools={
              <ViewLink view="alerts" navigate={navigate}>
                Ver todos
              </ViewLink>
            }
          >
            <ul className={styles.feed}>
              {alerts.slice(0, 5).map((alert) => (
                <AlertItem key={alert.id} alert={alert} />
              ))}
              {!alerts.length && (
                <li className={styles.feedRow} data-alert-empty="">
                  <span className={styles.feedTime} />
                  <StatusDot tone="gain" />
                  <span className={styles.feedText}>Sin avisos abiertos</span>
                </li>
              )}
            </ul>
          </Panel>
          <Panel
            id="storage-title"
            title="Almacenamiento"
            count={metrics.disks.length}
            tools={
              <ViewLink view="files" navigate={navigate}>
                Archivos
              </ViewLink>
            }
          >
            <ul className={styles.volumes}>
              {metrics.disks.map((disk) => {
                const used = occupation(disk);
                const level = volumeLevel(used, data.settings.disk);
                return (
                  <li
                    key={disk.root}
                    className={styles.volume}
                    data-volume={disk.root}
                    data-level={level}
                  >
                    <span className={styles.volumeLine}>
                      <strong>{disk.name}</strong>
                      <span className={levelTone[level]}>{percent(used)}</span>
                    </span>
                    <Meter
                      label={`Ocupación de ${disk.name}`}
                      value={used}
                      tone={levelTone[level]}
                    />
                    <span className={styles.volumeMeta}>
                      {bytes(disk.free)} libres de {bytes(disk.total)}
                    </span>
                  </li>
                );
              })}
              {!metrics.disks.length && (
                <li className={`${styles.volume} muted`}>Sin volúmenes</li>
              )}
            </ul>
          </Panel>
          <Panel
            id="shortcuts-title"
            title="Accesos"
            tools={
              <ViewLink view="apps" navigate={navigate}>
                Todas
              </ViewLink>
            }
          >
            <ul className={styles.shortcuts}>
              {applications.slice(0, shortcuts).map((app) => (
                <li key={app.host}>
                  <a
                    className={styles.shortcut}
                    data-shortcut={app.host}
                    href={`https://${app.host}.${appDomain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className={`${styles.letter} ${app.tone}`} aria-hidden="true">
                      {app.letter}
                    </span>
                    <span className={styles.shortcutName}>
                      <strong>{app.name}</strong>
                      <span>{app.category}</span>
                    </span>
                    <ArrowUpRight aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Hour for today's alerts, day and month for older ones. */
function when(at: string) {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("es", { day: "numeric", month: "short" });
}

function AlertItem({ alert }: { alert: Alert }) {
  const tone: Tone = alert.severity === "critical" ? "loss" : "peach";
  return (
    <li className={styles.feedRow} data-alert={alert.id} data-severity={alert.severity}>
      <time className={styles.feedTime} dateTime={alert.at}>
        {when(alert.at)}
      </time>
      <StatusDot tone={tone} />
      <span className={styles.feedText}>
        <strong>{alert.title}</strong>
        {alert.detail && <span className="muted"> · {alert.detail}</span>}
      </span>
    </li>
  );
}
