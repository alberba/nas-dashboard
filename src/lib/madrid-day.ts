/** Europe/Madrid is the calendar used by the hub for "today". */
export const HUB_TIME_ZONE = "Europe/Madrid";

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type MadridDay = {
  /** Calendar date in Europe/Madrid, as YYYY-MM-DD. */
  date: string;
  /** First instant of the day, inclusive. */
  start: Date;
  /** First instant of the next day, exclusive. */
  end: Date;
  timeZone: typeof HUB_TIME_ZONE;
};

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: HUB_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: HUB_TIME_ZONE,
  timeZoneName: "longOffset",
});

function dayParts(instant: Date): [number, number, number] {
  const parts = new Map(
    dayFormat
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return [parts.get("year")!, parts.get("month")!, parts.get("day")!];
}

/** Milliseconds that Europe/Madrid is ahead of UTC at an instant. */
function zoneOffset(instant: Date): number {
  const name =
    offsetFormat
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "-" ? -minutes : minutes) * 60_000;
}

function startOfMadridDay(year: number, month: number, day: number): Date {
  const wallClock = Date.UTC(year, month - 1, day);
  let instant = wallClock - zoneOffset(new Date(wallClock));
  // The offset at the guessed instant may differ around a transition; settle it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = wallClock - zoneOffset(new Date(instant));
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/** Calendar date (YYYY-MM-DD) of an instant in Europe/Madrid. */
export function madridDateOf(now: number | Date = Date.now()): string {
  const instant = now instanceof Date ? now : new Date(now);
  const [year, month, day] = dayParts(instant);
  return civilDate(year, month, day);
}

function civilDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Splits a YYYY-MM-DD civil date, or returns null when it is malformed. */
export function parseCivilDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = CIVIL_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Reject impossible dates such as 2026-02-30 instead of rolling them over.
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

/**
 * Shifts a civil date by whole calendar days. The arithmetic stays in UTC so
 * neither a process time zone nor a daylight-saving change can move the day.
 */
export function shiftCivilDate(date: string, days: number): string {
  const parts = parseCivilDate(date);
  if (!parts) throw new Error("Fecha civil no válida");
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return civilDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/**
 * Instant of a wall-clock time (`hour:minute`) in Europe/Madrid on a civil
 * date. The civil date and the time are the target: adding milliseconds to
 * midnight would drift by an hour on the daylight-saving Sundays.
 */
export function madridTarget(
  date: string,
  hour: number,
  minute: number,
): Date {
  const parts = parseCivilDate(date);
  if (!parts)
    throw new Error("Fecha civil no válida");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new Error("Hora no válida");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59)
    throw new Error("Minuto no válido");
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
  let instant = wallClock - zoneOffset(new Date(wallClock));
  // The offset at the guessed instant may belong to the other side of a
  // transition; settle it before returning.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = wallClock - zoneOffset(new Date(instant));
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/** Start and end of the Europe/Madrid calendar day that contains `now`. */
export function madridDay(now: number | Date = Date.now()): MadridDay {
  const instant = now instanceof Date ? now : new Date(now);
  const [year, month, day] = dayParts(instant);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const start = startOfMadridDay(year, month, day);
  return {
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    start,
    end: startOfMadridDay(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
    ),
    timeZone: HUB_TIME_ZONE,
  };
}
