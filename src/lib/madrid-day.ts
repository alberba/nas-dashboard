/** Europe/Madrid is the calendar used by the hub for "today". */
export const HUB_TIME_ZONE = "Europe/Madrid";

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
