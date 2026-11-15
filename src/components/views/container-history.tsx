"use client";
import { useEffect, useState } from "react";
import type { ContainerHistoryPoint, Overview } from "@/lib/types";
import { Chart } from "../chart";
import { Panel } from "../ui";
import styles from "./overview.module.css";
import { SeriesKey, describeChart } from "./shared";
import type { History, Series } from "./series";

const cpu: Series = {
  field: "containerCpu",
  label: "CPU",
  color: "var(--accent)",
};
const memory: Series = {
  field: "containerMemory",
  label: "RAM",
  color: "var(--lilac)",
};
const received: Series = {
  field: "containerRx",
  label: "Entrada",
  color: "var(--gain)",
};
const sent: Series = {
  field: "containerTx",
  label: "Salida",
  color: "var(--peach)",
};

export function ContainerHistoryPanel({
  data,
  range,
}: {
  data: Overview;
  range: string;
}) {
  const running = (data.latest?.containers ?? []).filter(
    (container) => container.state === "running",
  );
  const first = running[0]?.name ?? "";
  const [selected, setSelected] = useState("");
  const [history, setHistory] = useState<ContainerHistoryPoint[]>([]);
  const [error, setError] = useState(false);
  const active = selected || first;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    fetch(
      `/api/container-history?host=${encodeURIComponent(data.host.id)}&name=${encodeURIComponent(active)}&range=${range}`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!response.ok) throw new Error("container history");
        return response.json();
      })
      .then((body) => {
        setHistory(body.history ?? []);
        setError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistory([]);
          setError(true);
        }
      });
    return () => controller.abort();
  }, [active, data.host.id, range]);

  const points: History = history.map((point) => ({
    at: point.at,
    containerCpu: point.cpu,
    containerMemory: point.memory,
    containerRx: point.rx,
    containerTx: point.tx,
  }));

  return (
    <Panel
      id="containers-history-title"
      title="Contenedores"
      tools={
        <select
          aria-label="Contenedor"
          value={active}
          onChange={(event) => setSelected(event.target.value)}
          className={styles.containerSelect}
        >
          {running.map((container) => (
            <option key={container.name} value={container.name}>
              {container.name}
            </option>
          ))}
        </select>
      }
    >
      {running.length ? (
        <div className={styles.historyGrid} data-container-history="">
          <div className={styles.chartCell}>
            <div className={styles.seriesKeys}>
              <SeriesKey history={points} series={cpu} />
            </div>
            <Chart
              id="container-cpu"
              history={points}
              series={[cpu]}
              description={describeChart(points, [cpu], range)}
            />
          </div>
          <div className={styles.chartCell}>
            <div className={styles.seriesKeys}>
              <SeriesKey history={points} series={memory} />
            </div>
            <Chart
              id="container-memory"
              history={points}
              series={[memory]}
              description={describeChart(points, [memory], range)}
            />
          </div>
          <div className={styles.chartCell}>
            <div className={styles.seriesKeys}>
              <SeriesKey history={points} series={received} measure="peak" />
              <SeriesKey history={points} series={sent} measure="peak" />
            </div>
            <Chart
              id="container-network"
              history={points}
              series={[received, sent]}
              description={describeChart(points, [received, sent], range)}
            />
          </div>
        </div>
      ) : (
        <p className={styles.emptyNote}>Sin contenedores en ejecución.</p>
      )}
      {error && (
        <p className={styles.emptyNote} data-container-history-error="">
          No se pudo leer el histórico de este contenedor.
        </p>
      )}
    </Panel>
  );
}
