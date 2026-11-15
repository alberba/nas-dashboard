import { describe, expect, it } from "vitest";
import {
  formatSeries,
  isRate,
  isScaled,
  seriesSummary,
} from "../src/components/views/series";

const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 13, 10, minute)).toISOString();

describe("seriesSummary", () => {
  it("averages and peaks only the samples that exist", () => {
    const history = [
      { at: at(0), cpu: 10, memory: 40, rx: 100, tx: null },
      { at: at(1), cpu: null, memory: null, rx: null, tx: null },
      { at: at(2), cpu: 30, memory: 60, rx: 900, tx: null },
      { at: at(3), cpu: 20, memory: 50, rx: 500, tx: null },
    ];
    expect(seriesSummary(history, "cpu")).toEqual({
      average: 20,
      peak: 30,
      samples: 3,
    });
    expect(seriesSummary(history, "rx")).toEqual({
      average: 500,
      peak: 900,
      samples: 3,
    });
  });

  it("reports no samples when the period has no data", () => {
    const history = [{ at: at(0), cpu: null, memory: null, rx: null, tx: null }];
    expect(seriesSummary(history, "tx")).toEqual({
      average: null,
      peak: null,
      samples: 0,
    });
    expect(seriesSummary([], "cpu").samples).toBe(0);
  });

  it("formats load, latency and missing values with the right units", () => {
    expect(formatSeries("load1", 1.234)).toBe("1,23");
    expect(formatSeries("readAwait", 1.2)).toBe("1,2 ms");
    expect(formatSeries("swap", null)).toBe("sin datos");
    expect(isRate("ioRead")).toBe(true);
    expect(isScaled("load1")).toBe(true);
    expect(isScaled("memory")).toBe(false);
  });
});
