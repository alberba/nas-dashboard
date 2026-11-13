import { bytes, percent } from "@/lib/format";
import type { Overview } from "@/lib/types";

export type History = Overview["history"];
export type SeriesField = "cpu" | "memory" | "rx" | "tx";
export type Series = { field: SeriesField; label: string; color: string };

/** History periods offered by the period picker, in display order. */
export const ranges = [
  { id: "1h", label: "1h", spoken: "la última hora" },
  { id: "6h", label: "6h", spoken: "las últimas 6 horas" },
  { id: "24h", label: "24h", spoken: "las últimas 24 horas" },
  { id: "7d", label: "7d", spoken: "los últimos 7 días" },
  { id: "30d", label: "30d", spoken: "los últimos 30 días" },
];

export const isRate = (field: SeriesField) => field === "rx" || field === "tx";

export function seriesSummary(history: History, field: SeriesField) {
  const values = history
    .map((point) => point[field])
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (!values.length) return { average: null, peak: null, samples: 0 };
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
    samples: values.length,
  };
}

export function formatSeries(field: SeriesField, value: number | null) {
  if (value === null) return "sin datos";
  return isRate(field) ? bytes(value, true) : percent(value);
}

/** Spoken description of a chart for `role="img"`, built from its data. */
export function describeChart(
  history: History,
  series: Series[],
  range?: string,
) {
  const parts = series.map((s) => {
    const summary = seriesSummary(history, s.field);
    return summary.samples
      ? `${s.label}: media ${formatSeries(s.field, summary.average)}, pico ${formatSeries(s.field, summary.peak)}`
      : `${s.label}: sin datos`;
  });
  const period = range
    ? (ranges.find((r) => r.id === range)?.spoken ?? range)
    : null;
  return `${parts.join(". ")}. ${period ? `Historial de ${period}` : "Historial"}; los huecos son periodos sin datos.`;
}
