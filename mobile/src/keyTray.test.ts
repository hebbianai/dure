import { describe, expect, it } from "vitest";
import { DEFAULT_GROUP, type KeyGroup, groupKeys, load, reorderKeys, save, toggleKey } from "./keyTray";
import { TERMINAL_KEYS } from "./terminalKeys";

const EMPTY: KeyGroup = { id: "g", name: "새 그룹", keyIds: [] };

describe("keyTray", () => {
  it("adds a key, and pressing it again takes it out", () => {
    const added = toggleKey(EMPTY, "ctrl-c");
    expect(added.keyIds).toEqual(["ctrl-c"]);
    expect(toggleKey(added, "ctrl-c").keyIds).toEqual([]);
  });

  /**
   * 개수 제한 없음 (Figma 3272:85019). The strip scrolls, so a press that
   * visibly does nothing has nothing left to justify it. Filled from the table
   * so this cannot quietly stop at whatever the old cap was.
   */
  it("takes every key it is offered, in the order they were pressed", () => {
    const picks = TERMINAL_KEYS.filter((key) => !key.modifier)
      .slice(0, 20)
      .map((key) => key.id);
    let group: KeyGroup = EMPTY;
    for (const id of picks) group = toggleKey(group, id);

    expect(group.keyIds).toEqual(picks);
  });

  it("refuses a key it already holds rather than adding it twice", () => {
    const twice = toggleKey(toggleKey(toggleKey(EMPTY, "esc"), "tab"), "esc");

    expect(twice.keyIds).toEqual(["tab"]);
  });

  /** Dragging a chip past its neighbour is how the strip is ordered by hand. */
  it("takes the order the chips ended up in", () => {
    const group: KeyGroup = { ...EMPTY, keyIds: ["ctrl", "esc", "tab"] };

    expect(reorderKeys(group, ["tab", "ctrl", "esc"]).keyIds).toEqual(["tab", "ctrl", "esc"]);
  });

  /**
   * A saved id this build cannot draw has no chip, so the finger cannot name
   * its position. It keeps the slot it had, and the drawn keys move around it —
   * an index-based move would have reordered the wrong keys instead.
   */
  it("keeps an undrawable key where it was", () => {
    const group: KeyGroup = { ...EMPTY, keyIds: ["ctrl", "from-the-future", "esc", "tab"] };

    expect(reorderKeys(group, ["tab", "esc", "ctrl"]).keyIds).toEqual([
      "tab",
      "from-the-future",
      "esc",
      "ctrl",
    ]);
  });

  /**
   * 기본 트레이는 사용자가 직접 지정한 값이다(2026-08-29). 표에서 id 가
   * 사라지면 `groupKeys` 가 조용히 그 칩을 빼므로, 여기서 **여덟 개가 다
   * 살아 있는지** 확인한다 — 캡이 하나 없어진 트레이는 아무도 못 알아챈다.
   */
  it("기본 트레이는 여덟 개가 다 그려진다", () => {
    expect(DEFAULT_GROUP.keyIds).toEqual([
      "shift-tab",
      "question",
      "slash",
      "esc",
      "tab",
      "ctrl",
      "alt",
      "ctrl-c",
    ]);
    expect(DEFAULT_GROUP.keyIds).toHaveLength(8);
    expect(groupKeys(DEFAULT_GROUP).map((key) => key.label)).toEqual([
      "⇧Tab",
      "?",
      "/",
      "Esc",
      "Tab",
      "Ctrl",
      "Opt",
      "^C",
    ]);
  });

  it("refuses a key this build does not know", () => {
    expect(toggleKey(EMPTY, "no-such-key").keyIds).toEqual([]);
  });

  /** A saved id from another build must not render a cap that sends nothing. */
  it("skips saved ids it can no longer resolve", () => {
    const keys = groupKeys({ id: "g", name: "n", keyIds: ["esc", "from-the-future"] });

    expect(keys.map((key) => key.id)).toEqual(["esc"]);
  });

  /**
   * A session screen with no keys is one a phone cannot drive — worse than
   * ignoring a corrupt value.
   */
  it("falls back to the default tray rather than to an empty one", () => {
    expect(load({ getItem: () => null })).toEqual(DEFAULT_GROUP);
    expect(load({ getItem: () => "not json" })).toEqual(DEFAULT_GROUP);
    expect(load({ getItem: () => JSON.stringify({ id: 1 }) })).toEqual(DEFAULT_GROUP);
    expect(
      load({
        getItem: () => {
          throw new Error("private mode");
        },
      }),
    ).toEqual(DEFAULT_GROUP);
  });

  /**
   * Two chips carrying one id is a strip that cannot be edited: tapping either
   * makes `toggleKey` filter both out, and `reorderKeys` cannot tell them
   * apart. Deduped where the value is parsed, not wherever it is drawn.
   */
  it("drops a duplicate id the store came back with", () => {
    const written = JSON.stringify({ id: "g", name: "n", keyIds: ["esc", "tab", "esc"] });

    expect(load({ getItem: () => written }).keyIds).toEqual(["esc", "tab"]);
  });

  it("round-trips a strip longer than the old cap", () => {
    const keyIds = TERMINAL_KEYS.slice(0, 12).map((key) => key.id);
    let written = "";
    save({ id: "g", name: "에이전트 제어", keyIds }, { setItem: (_key, value) => (written = value) });

    const read = load({ getItem: () => written });
    expect(read.name).toBe("에이전트 제어");
    expect(read.keyIds).toEqual(keyIds);
  });

  it("does not throw when the store refuses a write", () => {
    expect(() =>
      save(DEFAULT_GROUP, {
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });
});
