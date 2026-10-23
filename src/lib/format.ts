export function bytes(value: number | null | undefined, rate = false) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index =
    value > 0
      ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
      : 0;
  return `${(value / 1024 ** index).toLocaleString("es", { maximumFractionDigits: index > 0 ? 1 : 0 })} ${units[index]}${rate ? "/s" : ""}`;
}
export function percent(value: number | null | undefined) {
  return value == null
    ? "—"
    : value.toLocaleString("es", { maximumFractionDigits: 1 }) + " %";
}
export function uptime(value: number) {
  const days = Math.floor(value / 86400),
    hours = Math.floor(value / 3600) % 24;
  return days
    ? `${days} d ${hours} h`
    : `${hours} h ${Math.floor(value / 60) % 60} min`;
}
