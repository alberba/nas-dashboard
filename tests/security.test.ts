import { describe, expect, it, vi, afterEach } from "vitest";
import { actionSchema, sampleInterval } from "../src/lib/validation";
import {
  nas,
  NasRejected,
  NasUnavailable,
  NasInvalidResponse,
} from "../src/lib/nas";

describe("administration boundaries", () => {
  it.each([
    "../secret",
    "/etc/passwd",
    "a/../../secret",
    ".hub-trash/data",
    "a/../b",
    "a\0b",
  ])("rejects unsafe file path %s", (path) => {
    expect(
      actionSchema.safeParse({ action: "trash", root: "media", path }).success,
    ).toBe(false);
  });
  it("rejects arbitrary roots and shell commands", () => {
    expect(
      actionSchema.safeParse({ action: "trash", root: "/", path: "etc/passwd" })
        .success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({ action: "exec", command: "reboot" }).success,
    ).toBe(false);
  });
  it("requires explicit reboot and trash-empty confirmations", () => {
    expect(actionSchema.safeParse({ action: "reboot" }).success).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "reboot",
        confirmation: "REINICIAR NAS",
      }).success,
    ).toBe(true);
    expect(actionSchema.safeParse({ action: "empty-trash" }).success).toBe(
      false,
    );
  });
  it("switches collection between 5 and 30 seconds", () => {
    expect(sampleInterval(true)).toBe(5000);
    expect(sampleInterval(false)).toBe(30000);
  });
});

describe("Effect NAS errors", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("does not retry a rejected administrative action", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Protected" }), { status: 400 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(nas("/action", { action: "stop" })).rejects.toBeInstanceOf(
      NasRejected,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains an explicit unavailable error when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(nas("/metrics")).rejects.toBeInstanceOf(NasUnavailable);
  });
  it("rejects malformed agent responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(nas("/metrics")).rejects.toBeInstanceOf(NasInvalidResponse);
  });
});
