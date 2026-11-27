/**
 * Client side of the Telegram handoff (BOT-07). The notice button opens the hub
 * with `#intent=<token>`: the fragment never reaches the server, so only the
 * browser can read it. The token is kept in `sessionStorage` until the intent
 * reaches a terminal state, so it survives the login and a reload, and it is
 * removed from the address bar as soon as it is captured (T-07-17).
 *
 * Every function takes `location`, `history` and `storage` as arguments so the
 * module runs, and is tested, without a DOM.
 */

export const HANDOFF_STORAGE_KEY = "hub.handoff";

const FRAGMENT_PREFIX = "#intent=";
/** 32 random bytes in base64url, the shape `inspect` and `execute` accept. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type HandoffLocation = {
  hash: string;
  pathname: string;
  search: string;
};
export type HandoffHistory = {
  replaceState(data: unknown, unused: string, url?: string | null): void;
};
export type HandoffReader = { getItem(key: string): string | null };
export type HandoffWriter = HandoffReader & {
  setItem(key: string, value: string): void;
};
export type HandoffEraser = { removeItem(key: string): void };

const unavailableStorage: HandoffWriter & HandoffEraser = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/**
 * The tab's `sessionStorage`. Browsers that block storage throw on the property
 * access itself, so the handoff then lives only for the current page load.
 */
export function handoffStorage(): HandoffWriter & HandoffEraser {
  try {
    return window.sessionStorage;
  } catch {
    return unavailableStorage;
  }
}

/** The token of a `#intent=<token>` fragment, or null for anything else. */
export function parseHandoffFragment(hash: string): string | null {
  if (!hash.startsWith(FRAGMENT_PREFIX)) return null;
  const value = hash.slice(FRAGMENT_PREFIX.length);
  return TOKEN_PATTERN.test(value) ? value : null;
}

/** The token kept by an earlier capture, or null when there is none. */
export function readStoredHandoff(storage: HandoffReader): string | null {
  try {
    const value = storage.getItem(HANDOFF_STORAGE_KEY);
    return value !== null && TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Forgets the token; called when the intent reaches a terminal state. */
export function clearHandoff(storage: HandoffEraser) {
  try {
    storage.removeItem(HANDOFF_STORAGE_KEY);
  } catch {
    // Nothing to clean when the storage is unavailable.
  }
}

/**
 * Takes the token from the address bar, stores it and removes the fragment
 * while keeping the path and the query (`view`, `host` and `incident`).
 * Idempotent: without a valid fragment, which is what a second call sees (React
 * runs effects twice in development), it returns the stored token and leaves
 * the URL alone. A storage that throws never breaks the flow: the token
 * captured now is still returned.
 */
export function captureHandoff(
  location: HandoffLocation,
  history: HandoffHistory,
  storage: HandoffWriter,
): string | null {
  const token = parseHandoffFragment(location.hash);
  if (token === null) return readStoredHandoff(storage);
  try {
    storage.setItem(HANDOFF_STORAGE_KEY, token);
  } catch {
    // The panel can still use the token for this page load.
  }
  history.replaceState(null, "", location.pathname + location.search);
  return token;
}
