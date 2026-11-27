import { describe, expect, it } from "vitest";
import {
  TELEGRAM_ACTIONS,
  generateActionToken,
  issueActionTokens,
  keyboardActions,
  parseCallbackData,
  renderActionRows,
  type KeyboardState,
  type TelegramAction,
} from "@/lib/telegram-keyboard";
import { hostActionsFor, intentActionIds } from "@/lib/telegram-intents";

/**
 * Pure matrix of the notice keyboard: which action each state offers and where
 * the buttons land. No database; a button is identified by the action its token
 * stands for, never by its label.
 */

const base: KeyboardState = {
  resolved: false,
  acknowledged: false,
  snoozed: false,
};
const OFFERED = hostActionsFor("container:plex");
const CONFIRM = { text: "enlace", url: "https://hub.example.com/#intent=x" };

/** Renders with a token per offered action and names every button by action. */
function layout(state: KeyboardState, withConfirm = false) {
  const issued: Partial<Record<TelegramAction, string>> = {};
  for (const action of keyboardActions(state)) issued[action] = `token-${action}`;
  const rows = renderActionRows(issued, withConfirm ? { confirm: CONFIRM } : {});
  return rows.map((row) =>
    row.map((button) =>
      "url" in button ? "url" : button.callbackData.replace(/^token-/, ""),
    ),
  );
}

const flat = (state: KeyboardState, withConfirm = false) => layout(state, withConfirm).flat();

describe("keyboard matrix", () => {
  it("offers an open notice with actions the menu entry and no host action", () => {
    const shown = flat({ ...base, offered: OFFERED });
    expect(shown).toContain("menu_open");
    expect(shown).toContain("ack");
    expect(shown).toContain("why");
    expect(shown.some((action) => action.startsWith("act_"))).toBe(false);
    expect(shown).not.toContain("menu_close");
  });

  it("offers an open notice without actions exactly the current keyboard", () => {
    expect(layout({ ...base })).toEqual([["ack"], ["snooze_1h", "snooze_24h"], ["why"]]);
    expect(layout({ ...base, offered: [] })).toEqual([
      ["ack"],
      ["snooze_1h", "snooze_24h"],
      ["why"],
    ]);
  });

  it("swaps the menu entry for the host actions and the way back in the menu view", () => {
    const shown = flat({ ...base, offered: OFFERED, view: "actions" });
    expect(shown).not.toContain("menu_open");
    expect(shown).toContain("act_start");
    expect(shown).toContain("act_restart");
    expect(shown).toContain("menu_close");
  });

  it("shows only the live link and its cancel while an intent is live", () => {
    const state = { ...base, offered: OFFERED, view: "actions", liveIntent: true } as const;
    const shown = flat(state, true);
    expect(shown).toContain("url");
    expect(shown).toContain("intent_cancel");
    expect(shown).not.toContain("menu_open");
    expect(shown).not.toContain("menu_close");
    expect(shown.some((action) => action.startsWith("act_"))).toBe(false);
  });

  it("keeps only the explanation on a resolved notice without an intent", () => {
    expect(layout({ ...base, resolved: true, offered: OFFERED })).toEqual([["why"]]);
  });

  it("keeps the link, the cancel and the explanation when an intent outlives the episode", () => {
    const shown = layout({ ...base, resolved: true, offered: OFFERED, liveIntent: true }, true);
    expect(shown).toEqual([["url"], ["intent_cancel", "why"]]);
  });

  it("replaces both silence buttons with one removal while silenced", () => {
    const shown = flat({ ...base, snoozed: true, offered: OFFERED });
    expect(shown).toContain("unsnooze");
    expect(shown).not.toContain("snooze_1h");
    expect(shown).not.toContain("snooze_24h");
  });

  it("drops the acknowledge button once the notice is acknowledged", () => {
    const shown = flat({ ...base, acknowledged: true, offered: OFFERED });
    expect(shown).not.toContain("ack");
    expect(shown).toContain("menu_open");
  });

  it("never lets a state offer a menu action on a resolved notice", () => {
    for (const liveIntent of [false, true])
      for (const view of ["normal", "actions"] as const) {
        const offered = keyboardActions({
          ...base,
          resolved: true,
          offered: OFFERED,
          view,
          liveIntent,
        });
        expect(offered).not.toContain("menu_open");
        expect(offered).not.toContain("menu_close");
        expect(offered.some((action) => action.startsWith("act_"))).toBe(false);
      }
  });
});

describe("callback data of the menu buttons", () => {
  it("is v1 plus 22 characters and 25 bytes for every action", async () => {
    const rows: Array<{ tokenHash: string }> = [];
    const executor = {
      insert: () => ({
        values: async (values: Array<{ tokenHash: string }>) => {
          rows.push(...values);
        },
      }),
    };
    const issued = await issueActionTokens(
      executor as unknown as Parameters<typeof issueActionTokens>[0],
      { incidentId: 1, chatId: "1", actions: TELEGRAM_ACTIONS },
    );
    expect(Object.keys(issued).sort()).toEqual([...TELEGRAM_ACTIONS].sort());
    for (const action of ["menu_open", "menu_close", "intent_cancel", ...TELEGRAM_ACTIONS.filter((a) => a.startsWith("act_"))]) {
      const token = issued[action as TelegramAction]!;
      expect(token).toMatch(/^v1:[A-Za-z0-9_-]{22}$/);
      expect(Buffer.byteLength(token)).toBe(25);
      expect(parseCallbackData(token)).toBe(token);
    }
    expect(Buffer.byteLength(generateActionToken())).toBeLessThanOrEqual(64);
  });
});

describe("host actions of the menu", () => {
  it("never include updating an image, stopping or removing", () => {
    const everything = ["container:plex", "backup-failed", "deploy-failed", "reboot-pending", "connection"]
      .flatMap(hostActionsFor)
      .map(String);
    for (const forbidden of ["update", "update-container", "stop", "remove"]) {
      expect(everything).not.toContain(forbidden);
      expect(intentActionIds).not.toContain(forbidden);
    }
    expect([...TELEGRAM_ACTIONS].filter((a) => /update|stop|remove/.test(a))).toEqual([]);
  });
});
