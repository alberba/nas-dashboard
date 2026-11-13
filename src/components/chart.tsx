"use client";
import { useState } from "react";
import styles from "./chart.module.css";
import {
  describeChart,
  formatSeries,
  isRate,
  type History,
  type Series,
  type SeriesField,
} from "./views/series";

export { formatSeries, type Series };

const WIDTH = 900;
const HEIGHT = 200;
const TOP = 12;
const BOTTOM = 196;

const clock = (at: string) =>
  new Date(at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
const dayClock = (at: string) =>
  new Date(at).toLocaleString("es", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Line chart with a 14 % area per series, three guide lines and a time axis,
 * exposed as `role="img"` with a description of what it shows.
 *
 * Pass `series` (and ideally `description`) for new code. The single-series
 * `field`/`label`/`color` props are kept for existing callers.
 */
export function Chart({
  id,
  history,
  series,
  description,
  field = "cpu",
  label = "CPU",
  color = "var(--accent)",
}: {
  id?: string;
  history: History;
  series?: Series[];
  description?: string;
  field?: SeriesField;
  label?: string;
  color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const lines = series ?? [{ field, label, color }];
  const spoken = description ?? describeChart(history, lines);
  const rate = lines.some((s) => isRate(s.field));
  const max = rate
    ? Math.max(
        1024,
        ...history.flatMap((p) => lines.map((s) => Number(p[s.field]) || 0)),
      ) * 1.15
    : 100;
  const x = (i: number) => (i / Math.max(1, history.length - 1)) * WIDTH;
  const y = (value: number) =>
    BOTTOM - (Math.min(max, Math.max(0, value)) / max) * (BOTTOM - TOP);

  const paths = lines.map((s) => {
    let line = "";
    let area = "";
    let run: [number, number][] = [];
    const flush = () => {
      if (!run.length) return;
      line += run.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
      area +=
        `M${run[0][0]},${BOTTOM} ` +
        run.map(([px, py]) => `L${px},${py}`).join(" ") +
        ` L${run[run.length - 1][0]},${BOTTOM} Z `;
      run = [];
    };
    history.forEach((point, i) => {
      const value = point[s.field];
      if (value === null) return flush();
      run.push([x(i), y(value)]);
    });
    flush();
    return { ...s, line, area };
  });

  const selected = hover !== null ? history[hover] : undefined;
  const first = history[0]?.at;
  const middle = history[Math.floor((history.length - 1) / 2)]?.at;
  const last = history.at(-1)?.at;
  const long =
    first &&
    last &&
    new Date(last).getTime() - new Date(first).getTime() > 24 * 3600 * 1000;
  const tick = long ? dayClock : clock;

  return (
    <div
      className={styles.chart}
      data-chart={id ?? field}
      data-points={history.length}
    >
      <div className={styles.plot}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={spoken}
          onPointerMove={(e) => {
            if (!history.length) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setHover(
              Math.max(
                0,
                Math.min(
                  history.length - 1,
                  Math.round(
                    ((e.clientX - rect.left) / rect.width) *
                      (history.length - 1),
                  ),
                ),
              ),
            );
          }}
          onPointerLeave={() => setHover(null)}
        >
          {[TOP, (TOP + BOTTOM) / 2, BOTTOM].map((gy) => (
            <line
              key={gy}
              x1="0"
              x2={WIDTH}
              y1={gy}
              y2={gy}
              className={styles.guide}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {paths.map((p) => (
            <g key={p.field}>
              <path d={p.area} fill={p.color} fillOpacity="0.14" />
              <path
                d={p.line}
                fill="none"
                stroke={p.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={TOP}
              y2={BOTTOM}
              className={styles.crosshair}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {selected && (
          <p className={styles.readout} aria-hidden="true">
            <time>{tick(selected.at)}</time>
            {lines.map((s) => (
              <span key={s.field}>
                <i className="dot" style={{ color: s.color }} />
                {formatSeries(s.field, selected[s.field])}
              </span>
            ))}
          </p>
        )}
        {!history.length && (
          <p className={styles.empty}>Sin datos en este periodo</p>
        )}
      </div>
      <div className={styles.ticks} aria-hidden="true">
        <span>{first ? tick(first) : ""}</span>
        <span>{middle && history.length > 2 ? tick(middle) : ""}</span>
        <span>ahora</span>
      </div>
    </div>
  );
}
