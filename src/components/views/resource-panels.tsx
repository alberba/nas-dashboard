import { bytes, percent } from "@/lib/format";
import type { Metrics, Overview } from "@/lib/types";
import { Panel, StatusDot } from "../ui";
import styles from "./overview.module.css";
import {
  Meter,
  celsius,
  levelTone,
  occupation,
  temperatureLevel,
  volumeLevel,
  type Level,
} from "./shared";

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
const breakdownWords: [keyof NonNullable<Metrics["cpuBreakdown"]>, string][] = [
  ["user", "usuario"],
  ["system", "sistema"],
  ["iowait", "iowait"],
  ["steal", "steal"],
  ["idle", "inactivo"],
  ["irq", "irq"],
  ["softirq", "softirq"],
  ["nice", "nice"],
];

const milliseconds = (value: number | null | undefined) =>
  value == null
    ? "—"
    : `${value.toLocaleString("es", { maximumFractionDigits: 1 })} ms`;

export function volumesOf(metrics: Metrics) {
  if (metrics.filesystems?.length)
    return metrics.filesystems.map((volume) => ({
      ...volume,
      root: volume.name,
    }));
  return metrics.disks;
}

export function CpuPanel({ metrics }: { metrics: Metrics }) {
  const cores = metrics.cpuCores ?? [];
  const breakdown = metrics.cpuBreakdown;
  return (
    <Panel
      id="cpu-title"
      title="CPU"
      count={cores.length ? `${cores.length} hilos` : undefined}
    >
      {cores.length ? (
        <div className={styles.cores} data-cpu-cores="">
          {cores.map((value, index) => (
            <div className={styles.core} key={index} data-cpu-core={index}>
              <span className={styles.coreValue}>{percent(value)}</span>
              <span className={styles.coreBar}>
                <i
                  style={{
                    blockSize: `${Math.min(100, Math.max(0, value ?? 0))}%`,
                  }}
                />
              </span>
              <span className={styles.coreName}>{index}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.emptyNote}>Sin datos por núcleo.</p>
      )}
      {breakdown && (
        <div className={styles.chips} data-cpu-breakdown="">
          {breakdownWords.map(([key, label]) => (
            <span className={styles.chip} key={key}>
              {label} <b>{percent(breakdown[key])}</b>
            </span>
          ))}
        </div>
      )}
      {metrics.load && (
        <div className={styles.chips} data-load="">
          <span className={styles.chip}>
            carga{" "}
            <b>
              {metrics.load
                .map((value) =>
                  value.toLocaleString("es", { maximumFractionDigits: 2 }),
                )
                .join(" · ")}
            </b>
          </span>
        </div>
      )}
    </Panel>
  );
}

export function MemoryPanel({ metrics }: { metrics: Metrics }) {
  const memory = metrics.memory;
  const cache = memory.cache;
  const swap = memory.swap;
  const used = (memory.used / memory.total) * 100;
  const cachePct =
    cache === undefined ? 0 : (cache / memory.total) * 100;
  const freePct = Math.max(0, 100 - used - cachePct);
  return (
    <Panel id="memory-title" title="Memoria" count={percent(used)}>
      <div className={styles.metricGrid}>
        <div data-memory="used">
          <span className={styles.metricLabel}>En uso</span>
          <span className={styles.metricValue}>{bytes(memory.used)}</span>
          <span className={styles.metricNote}>
            {percent(used)} de {bytes(memory.total)}
          </span>
        </div>
        {cache !== undefined && (
          <div data-memory="cache">
            <span className={styles.metricLabel}>Caché</span>
            <span className={styles.metricValue}>{bytes(cache)}</span>
            <span className={styles.metricNote}>buffers y caché reclamable</span>
          </div>
        )}
        {swap && (
          <div data-memory="swap">
            <span className={styles.metricLabel}>Swap</span>
            <span className={styles.metricValue}>{bytes(swap.used)}</span>
            <span className={styles.metricNote}>
              de {bytes(swap.total)} ·{" "}
              {percent(swap.total ? (swap.used / swap.total) * 100 : 0)}
            </span>
          </div>
        )}
      </div>
      {cache !== undefined && (
        <>
          <div
            className={styles.stack}
            role="img"
            aria-label={`Memoria: ${bytes(memory.used)} en uso, ${bytes(cache)} en caché y ${percent(freePct)} libre`}
          >
            <i style={{ inlineSize: `${used}%`, background: "var(--lilac)" }} />
            <i style={{ inlineSize: `${cachePct}%`, background: "var(--peach)" }} />
            <i style={{ inlineSize: `${freePct}%`, background: "var(--panel2)" }} />
          </div>
          <div className={styles.legend}>
            <span>
              <i className="dot" style={{ color: "var(--lilac)" }} />
              usada <b>{bytes(memory.used)}</b>
            </span>
            <span>
              <i className="dot" style={{ color: "var(--peach)" }} />
              caché <b>{bytes(cache)}</b>
            </span>
            <span>
              <i className="dot" style={{ color: "var(--panel2)" }} />
              libre <b>{percent(freePct)}</b>
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

export function NetworkPanel({ metrics }: { metrics: Metrics }) {
  const interfaces = metrics.network.interfaces ?? [];
  return (
    <Panel
      id="network-title"
      title="Red por interfaz"
      count={interfaces.length || undefined}
    >
      <div className="table-scroll">
        <table className={`data-table ${styles.table}`} data-network-table="">
          <thead>
            <tr>
              <th scope="col">Interfaz</th>
              <th scope="col" className="numeric">
                Entrada
              </th>
              <th scope="col" className="numeric">
                Salida
              </th>
              <th scope="col" className="numeric">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {interfaces.map((network) => (
              <tr key={network.name} data-interface={network.name}>
                <td className="name-cell">
                  <span className="row-title">
                    <StatusDot tone={network.rx ? "gain" : "muted"} />
                    <strong>{network.name}</strong>
                  </span>
                  <span className="row-meta">
                    {bytes(network.rx, true)} de entrada
                  </span>
                </td>
                <td className="numeric">{bytes(network.rx, true)}</td>
                <td className="numeric">{bytes(network.tx, true)}</td>
                <td className="numeric mono soft">
                  {bytes(network.rxTotal + network.txTotal)}
                </td>
              </tr>
            ))}
            {!interfaces.length && (
              <tr className="empty-row">
                <td colSpan={4}>Sin interfaces</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function LatencyPanel({ metrics }: { metrics: Metrics }) {
  const latency = metrics.io.latency;
  const devices = latency?.devices ?? [];
  return (
    <Panel
      id="latency-title"
      title="Latencia de discos"
      count={latency ? percent(latency.utilization) : undefined}
    >
      <div className="table-scroll">
        <table className={`data-table ${styles.table}`} data-latency-table="">
          <thead>
            <tr>
              <th scope="col">Disco</th>
              <th scope="col" className="numeric">
                Lectura
              </th>
              <th scope="col" className="numeric">
                Escritura
              </th>
              <th scope="col" className="numeric">
                Uso
              </th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.name} data-latency={device.name}>
                <td className="name-cell">
                  <span className="row-title">
                    <StatusDot
                      tone={
                        device.utilization && device.utilization > 80
                          ? "loss"
                          : "gain"
                      }
                    />
                    <strong>{device.name}</strong>
                  </span>
                </td>
                <td className="numeric">{milliseconds(device.readMs)}</td>
                <td className="numeric">{milliseconds(device.writeMs)}</td>
                <td className="numeric">
                  {percent(device.utilization)}
                </td>
              </tr>
            ))}
            {!devices.length && (
              <tr className="empty-row">
                <td colSpan={4}>Sin datos de latencia</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function RaidPanel({ metrics }: { metrics: Metrics }) {
  const raid = metrics.raid ?? [];
  return (
    <Panel id="raid-title" title="RAID" count={raid.length || undefined}>
      <div className={styles.raidList}>
        {raid.map((array) => {
          const healthy = ["clean", "active"].includes(
            (array.state ?? "").toLowerCase(),
          );
          return (
            <div className={styles.raidRow} key={array.name} data-raid={array.name}>
              <div>
                <span className={styles.raidName}>
                  <StatusDot tone={healthy ? "gain" : "peach"} />
                  {array.name}
                </span>
                <span className={styles.raidMeta}>
                  {[array.level, bytes(array.capacity)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <span className={healthy ? "gain" : "warn"}>
                {array.state ?? "—"} · {array.disks ?? "—"} discos
              </span>
            </div>
          );
        })}
        {!raid.length && (
          <p className={styles.emptyNote}>Sin arrays.</p>
        )}
      </div>
    </Panel>
  );
}

export function SystemPanel({ metrics }: { metrics: Metrics }) {
  const system = metrics.system;
  return (
    <Panel id="system-title" title="Sistema">
      {system ? (
        <div className={styles.systemList} data-system="">
          <div data-system-field="cpu">
            <span className={styles.metricLabel}>Procesador</span>
            <span className={styles.systemValue}>{system.cpuModel ?? "—"}</span>
            <span className={styles.metricNote}>
              {[
                system.cores && `${system.cores} núcleos`,
                system.threads && `${system.threads} hilos`,
                system.sockets && `${system.sockets} socket`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <div data-system-field="kernel">
            <span className={styles.metricLabel}>Kernel</span>
            <span className={styles.systemValue}>{system.kernel ?? "—"}</span>
            <span className={styles.metricNote}>{system.arch ?? "—"}</span>
          </div>
          <div data-system-field="os">
            <span className={styles.metricLabel}>Sistema operativo</span>
            <span className={styles.systemValue}>{system.osName ?? "—"}</span>
            <span className={styles.metricNote}>
              {bytes(system.memoryTotal)} de RAM
            </span>
          </div>
        </div>
      ) : (
        <p className={styles.emptyNote}>Sin datos del sistema.</p>
      )}
    </Panel>
  );
}

export function VolumesPanel({
  metrics,
  settings,
}: {
  metrics: Metrics;
  settings: Overview["settings"];
}) {
  const volumes = volumesOf(metrics);
  return (
    <Panel id="volumes-title" title="Volúmenes" count={volumes.length}>
      <div className="table-scroll">
        <table className={`data-table ${styles.table}`} data-volume-table="">
          <thead>
            <tr>
              <th scope="col">Volumen</th>
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
            {volumes.map((volume) => {
              const used = occupation(volume);
              const level = volumeLevel(used, settings.disk);
              const tone = levelTone[level];
              return (
                <tr
                  key={volume.root}
                  data-volume={volume.root}
                  data-level={level}
                >
                  <td className="name-cell">
                    <span className="row-title">
                      <StatusDot tone={tone} />
                      <strong>{volume.name}</strong>
                    </span>
                    <span className={`row-meta ${tone}`}>
                      {volumeWords[level]} · {bytes(volume.free)} libres de{" "}
                      {bytes(volume.total)}
                    </span>
                  </td>
                  <td className="numeric">{bytes(volume.used)}</td>
                  <td className="numeric">{bytes(volume.free)}</td>
                  <td className="numeric">{bytes(volume.total)}</td>
                  <td className={styles.compactValue}>
                    <span className={styles.usage}>
                      <Meter
                        label={`Ocupación de ${volume.name}`}
                        value={used}
                        tone={tone}
                      />
                      <span className={tone}>{percent(Math.round(used))}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
            {!volumes.length && (
              <tr className="empty-row">
                <td colSpan={5}>Sin volúmenes</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function TemperaturesPanel({
  metrics,
  settings,
}: {
  metrics: Metrics;
  settings: Overview["settings"];
}) {
  return (
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
                settings.temperature,
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
  );
}

export function IoPanel({ metrics }: { metrics: Metrics }) {
  return (
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
  );
}

