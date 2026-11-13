import { describe, expect, it } from "vitest";
import { madridDay } from "@/lib/madrid-day";

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
