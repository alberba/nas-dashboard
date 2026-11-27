import { describe, expect, it, vi } from "vitest";
import {
  captureHandoff,
  clearHandoff,
  HANDOFF_STORAGE_KEY,
  parseHandoffFragment,
  readStoredHandoff,
} from "@/lib/telegram-handoff-client";

const token = "A".repeat(43);
const other = "b-_".repeat(14) + "c";

function fakeStorage({ throws = false }: { throws?: boolean } = {}) {
  const values = new Map<string, string>();
  const fail = () => {
    if (throws) throw new Error("storage blocked");
  };
  return {
    values,
    getItem: (key: string) => {
      fail();
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      fail();
      values.set(key, value);
    },
    removeItem: (key: string) => {
      fail();
      values.delete(key);
    },
  };
}

const route = {
  pathname: "/",
  search: "?view=alerts&host=nas-home&incident=7",
};

describe("parseHandoffFragment", () => {
  it("returns the token of a #intent= fragment with 43 base64url characters", () => {
    expect(parseHandoffFragment(`#intent=${token}`)).toBe(token);
    expect(parseHandoffFragment(`#intent=${other}`)).toBe(other);
  });

  it.each([
    ["an empty hash", ""],
    ["a bare hash", "#"],
    ["an empty value", "#intent="],
    ["a short token", `#intent=${"A".repeat(42)}`],
    ["a long token", `#intent=${"A".repeat(44)}`],
    ["a character outside base64url", `#intent=${"A".repeat(42)}+`],
    ["a padded token", `#intent=${"A".repeat(42)}=`],
    ["a second parameter", `#intent=${token}&view=alerts`],
    ["a repeated parameter", `#intent=${token}#intent=${token}`],
    ["another fragment kind", `#setup=${token}`],
    ["a parameter without the hash", `intent=${token}`],
  ])("returns null for %s", (_name, hash) => {
    expect(parseHandoffFragment(hash)).toBeNull();
  });
});

describe("captureHandoff", () => {
  it("stores the token, rewrites the URL without the fragment and returns the token", () => {
    const storage = fakeStorage();
    const replaceState = vi.fn();

    const captured = captureHandoff(
      { ...route, hash: `#intent=${token}` },
      { replaceState },
      storage,
    );

    expect(captured).toBe(token);
    expect(storage.values.get(HANDOFF_STORAGE_KEY)).toBe(token);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/?view=alerts&host=nas-home&incident=7",
    );
  });

  it("is idempotent: a second call reads the stored token and leaves the URL alone", () => {
    const storage = fakeStorage();
    const replaceState = vi.fn();
    captureHandoff(
      { ...route, hash: `#intent=${token}` },
      { replaceState },
      storage,
    );

    const second = captureHandoff(
      { ...route, hash: "" },
      { replaceState },
      storage,
    );

    expect(second).toBe(token);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("stores nothing and leaves the URL alone for an invalid fragment", () => {
    const storage = fakeStorage();
    const replaceState = vi.fn();

    const captured = captureHandoff(
      { ...route, hash: "#intent=short" },
      { replaceState },
      storage,
    );

    expect(captured).toBeNull();
    expect(storage.values.size).toBe(0);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("keeps an earlier token when a later fragment is invalid", () => {
    const storage = fakeStorage();
    storage.values.set(HANDOFF_STORAGE_KEY, token);
    const replaceState = vi.fn();

    const captured = captureHandoff(
      { ...route, hash: "#setup=abc" },
      { replaceState },
      storage,
    );

    expect(captured).toBe(token);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("returns the captured token and still cleans the URL when the storage throws", () => {
    const storage = fakeStorage({ throws: true });
    const replaceState = vi.fn();

    const captured = captureHandoff(
      { ...route, hash: `#intent=${token}` },
      { replaceState },
      storage,
    );

    expect(captured).toBe(token);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("returns null without a fragment when the storage throws", () => {
    const captured = captureHandoff(
      { ...route, hash: "" },
      { replaceState: vi.fn() },
      fakeStorage({ throws: true }),
    );

    expect(captured).toBeNull();
  });
});

describe("clearHandoff", () => {
  it("leaves nothing for readStoredHandoff to find", () => {
    const storage = fakeStorage();
    captureHandoff(
      { ...route, hash: `#intent=${token}` },
      { replaceState: vi.fn() },
      storage,
    );
    expect(readStoredHandoff(storage)).toBe(token);

    clearHandoff(storage);

    expect(readStoredHandoff(storage)).toBeNull();
  });

  it("does not throw when the storage does", () => {
    expect(() => clearHandoff(fakeStorage({ throws: true }))).not.toThrow();
  });
});

describe("readStoredHandoff", () => {
  it("ignores a stored value that is not a token", () => {
    const storage = fakeStorage();
    storage.values.set(HANDOFF_STORAGE_KEY, "not-a-token");

    expect(readStoredHandoff(storage)).toBeNull();
  });
});
