import { describe, expect, it } from "vitest";
import {
  appendLines,
  filterLines,
  logLevel,
  logsRequestPath,
  logsText,
} from "@/lib/log-viewer";
import type { LogLine } from "@/lib/logs";

const line = (message: string, at: string | null = null): LogLine => ({
  stream: "stdout",
  at,
  message,
});
const ID = "ab".repeat(32);

describe("logsRequestPath", () => {
  it("omits since on the first read", () => {
    const url = new URL(
      logsRequestPath({ id: ID, lines: 200, cursor: null }),
      "http://hub.invalid",
    );
    expect(url.pathname).toBe("/api/logs");
    expect(url.searchParams.get("id")).toBe(ID);
    expect(url.searchParams.get("lines")).toBe("200");
    expect(url.searchParams.has("since")).toBe(false);
  });

  it("returns the opaque cursor untouched, encoding the # separator", () => {
    const cursor = "2026-11-13T10:00:00.000000002Z#1";
    const path = logsRequestPath({ id: ID, lines: 50, cursor });
    expect(path).not.toContain("#");
    expect(new URL(path, "http://hub.invalid").searchParams.get("since")).toBe(
      cursor,
    );
  });
});

describe("appendLines", () => {
  it("keeps only the newest lines up to the limit", () => {
    const merged = appendLines(
      [line("a"), line("b")],
      [line("c"), line("d")],
      3,
    );
    expect(merged.map((l) => l.message)).toEqual(["b", "c", "d"]);
  });

  it("never exceeds the 5000-line ceiling", () => {
    const many = Array.from({ length: 6000 }, (_, i) => line(String(i)));
    const merged = appendLines([], many, 9999);
    expect(merged).toHaveLength(5000);
    expect(merged.at(-1)?.message).toBe("5999");
  });
});

describe("logLevel", () => {
  it.each([
    ["2026 ERROR connection refused", "error"],
    ["level=error msg=boom", "error"],
    ["[FATAL] out of memory", "error"],
    ["WARN cache miss", "warn"],
    ["level=warning slow query", "warn"],
    ["Starting service", null],
    ["0 errors found in terrain", null],
  ])("%s → %s", (message, expected) => {
    expect(logLevel(message)).toBe(expected);
  });
});

describe("filterLines", () => {
  const lines = [line("GET /health 200"), line("WARN Disk almost full")];
  it("matches text ignoring case", () => {
    expect(filterLines(lines, "disk").map((l) => l.message)).toEqual([
      "WARN Disk almost full",
    ]);
  });
  it("returns everything for an empty or blank filter", () => {
    expect(filterLines(lines, "  ")).toHaveLength(2);
  });
});

describe("logsText", () => {
  it("serialises one line per entry, with the time when known", () => {
    const text = logsText([
      line("boot", "2026-11-13T10:00:00.000000001Z"),
      line("tty output"),
    ]);
    expect(text.split("\n")).toEqual([
      "2026-11-13T10:00:00.000000001Z boot",
      "tty output",
      "",
    ]);
  });
});
