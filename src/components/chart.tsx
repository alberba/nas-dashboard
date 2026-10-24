"use client";
import { useState } from "react";
import type { Overview } from "@/lib/types";
export function Chart({
  history,
  field = "cpu",
  label = "CPU",
  color = "var(--accent)",
}: {
  history: Overview["history"];
  field?: "cpu" | "memory" | "rx" | "tx";
  label?: string;
  color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const isRate = field === "rx" || field === "tx";
  const max = isRate
    ? Math.max(1024, ...history.map((p) => Number(p[field]) || 0)) * 1.15
    : 100;
  const points = history.map((p, i) => ({
    x: (i / Math.max(1, history.length - 1)) * 900,
    y: 170 - (Math.min(max, Number(p[field])) / max) * 150,
    value: p[field],
  }));
  let path = "";
  let connected = false;
  for (const point of points) {
    if (point.value === null) {
      connected = false;
      continue;
    }
    path += `${connected ? "L" : "M"}${point.x},${point.y} `;
    connected = true;
  }
  const selected = hover !== null ? history[hover] : undefined;
  return (
    <div className="chart-wrap">
      <div className="chart-caption">
        <span>{label}</span>
        <span>
          {selected
            ? `${new Date(selected.at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })} · ${selected[field] === null ? "Sin datos" : isRate ? (Number(selected[field]) / 1048576).toFixed(2) + " MB/s" : Number(selected[field]).toFixed(1) + " %"}`
            : "Pasa por el gráfico para explorar"}
        </span>
      </div>
      <svg
        viewBox="0 0 900 190"
        role="img"
        aria-label={`Historial de ${label}. Los huecos indican periodos sin datos.`}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(
                history.length - 1,
                Math.round(
                  ((e.clientX - rect.left) / rect.width) * (history.length - 1),
                ),
              ),
            ),
          );
        }}
        onPointerLeave={() => setHover(null)}
      >
        {[20, 70, 120, 170].map((y) => (
          <line key={y} x1="0" x2="900" y1={y} y2={y} className="chart-grid" />
        ))}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && points[hover] && (
          <line
            x1={points[hover].x}
            x2={points[hover].x}
            y1="10"
            y2="180"
            className="chart-crosshair"
          />
        )}
      </svg>
      <div className="chart-axis">
        <time>
          {history[0] &&
            new Date(history[0].at).toLocaleString("es", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
        </time>
        <span>{isRate ? "Tráfico de red" : "0–100 %"}</span>
        <time>Ahora</time>
      </div>
    </div>
  );
}
