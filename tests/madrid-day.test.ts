import { describe, expect, it } from "vitest";
import * as madridDayModule from "@/lib/madrid-day";
import {
  madridDateOf,
  madridDay,
  madridTarget,
  parseCivilDate,
  shiftCivilDate,
} from "@/lib/madrid-day";

/**
 * The acknowledgement clock is asserted through its public behaviour: the
 * module must expose the formatter and it must return the `HH:mm` of
 * Europe/Madrid, whatever the process time zone is.
 */
type ClockModule = { madridClock?: (at: number | Date) => string };
const madridClock = (madridDayModule as unknown as ClockModule).madridClock;

describe("today's events day window", () => {
  it("uses the Europe/Madrid calendar day in winter", () => {
    const day = madridDay(new Date("2026-11-13T10:00:00Z"));
    expect(day.date).toBe("2026-11-13");
    expect(day.start.toISOString()).toBe("2026-11-12T23:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-11-13T23:00:00.000Z");
  });

  it("uses the Europe/Madrid calendar day in summer", () => {
    const day = madridDay(new Date("2026-07-15T10:00:00Z"));
    expect(day.date).toBe("2026-07-15");
    expect(day.start.toISOString()).toBe("2026-07-14T22:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-07-15T22:00:00.000Z");
  });

  it("rolls over the calendar day before UTC does", () => {
    const day = madridDay(new Date("2026-11-13T23:30:00Z"));
    expect(day.date).toBe("2026-11-14");
    expect(day.start.toISOString()).toBe("2026-11-13T23:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-11-14T23:00:00.000Z");
  });

  it("keeps 23 and 25 hour days across daylight-saving changes", () => {
    const spring = madridDay(new Date("2026-03-29T12:00:00Z"));
    const autumn = madridDay(new Date("2026-10-25T12:00:00Z"));
    expect(
      (spring.end.getTime() - spring.start.getTime()) / 3_600_000,
    ).toBe(23);
    expect(
      (autumn.end.getTime() - autumn.start.getTime()) / 3_600_000,
    ).toBe(25);
  });
});

describe("configured target in Europe/Madrid", () => {
  // Spain moves the clock at 01:00 UTC in 2026: 2026-03-29 and 2026-10-25.
  it("resolves the default 08:00 on both transition days", () => {
    expect(madridTarget("2026-03-29", 8, 0).toISOString()).toBe(
      "2026-03-29T06:00:00.000Z",
    );
    expect(madridTarget("2026-10-25", 8, 0).toISOString()).toBe(
      "2026-10-25T07:00:00.000Z",
    );
    expect(madridTarget("2026-11-26", 8, 0).toISOString()).toBe(
      "2026-11-26T07:00:00.000Z",
    );
  });

  it("shifts a wall clock that does not exist by the jump", () => {
    // 02:30 and 02:45 never happen on 2026-03-29: they move forward one hour.
    expect(madridTarget("2026-03-29", 2, 30).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(madridTarget("2026-03-29", 2, 45).toISOString()).toBe(
      "2026-03-29T01:45:00.000Z",
    );
  });

  it("uses the first occurrence when the wall clock repeats", () => {
    // 02:30 and 02:45 happen twice on 2026-10-25: 00:30Z/00:45Z come first.
    expect(madridTarget("2026-10-25", 2, 30).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(madridTarget("2026-10-25", 2, 45).toISOString()).toBe(
      "2026-10-25T00:45:00.000Z",
    );
  });

  it("keeps the calendar date independent of the process time zone", () => {
    expect(madridDateOf(new Date("2026-11-26T23:30:00Z"))).toBe("2026-11-27");
    expect(madridDateOf(new Date("2026-11-26T22:59:59Z"))).toBe("2026-11-26");
  });

  it("shifts civil dates without a time zone or a daylight-saving change", () => {
    expect(shiftCivilDate("2026-11-26", -1)).toBe("2026-11-25");
    expect(shiftCivilDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftCivilDate("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftCivilDate("2026-10-25", -1)).toBe("2026-10-24");
    expect(shiftCivilDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("rejects impossible dates and clock values", () => {
    expect(parseCivilDate("2026-02-30")).toBeNull();
    expect(parseCivilDate("2026-13-01")).toBeNull();
    expect(parseCivilDate("26-11-30")).toBeNull();
    expect(() => madridTarget("2026-02-30", 8, 0)).toThrow();
    expect(() => madridTarget("2026-11-26", 24, 0)).toThrow();
    expect(() => madridTarget("2026-11-26", 8, 60)).toThrow();
  });
});

describe("acknowledgement clock in Europe/Madrid", () => {
  it("formats the wall clock with two digits in winter and summer", () => {
    expect(madridClock?.(new Date("2026-11-26T09:32:00Z"))).toBe("10:32");
    expect(madridClock?.(new Date("2026-07-15T07:05:00Z"))).toBe("09:05");
    expect(madridClock?.(new Date("2026-11-26T23:05:00Z"))).toBe("00:05");
  });

  it("follows both 2026 daylight-saving changes", () => {
    // 2026-03-29: 02:00 Europe/Madrid jumps to 03:00 (01:00 UTC).
    expect(madridClock?.(new Date("2026-03-29T00:59:00Z"))).toBe("01:59");
    expect(madridClock?.(new Date("2026-03-29T01:00:00Z"))).toBe("03:00");
    // 2026-10-25: 03:00 falls back to 02:00 (01:00 UTC).
    expect(madridClock?.(new Date("2026-10-24T23:30:00Z"))).toBe("01:30");
    expect(madridClock?.(new Date("2026-10-25T01:00:00Z"))).toBe("02:00");
  });

  it("returns the same value for a Date and its millisecond instant", () => {
    const at = new Date("2026-11-26T09:32:00Z");
    expect(madridClock?.(at)).toBe("10:32");
    expect(madridClock?.(at.getTime())).toBe("10:32");
  });
});
