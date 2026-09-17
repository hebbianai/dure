import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import { type KeyStripActions, renderKeyStripScreen } from "./keyStripView";
import type { KeyGroup } from "./keyTray";
import { KEY_CATEGORIES } from "./terminalKeys";

const GROUP: KeyGroup = { id: "g", name: "기본", keyIds: ["ctrl", "esc", "tab"] };

const noActions: KeyStripActions = {
  back: () => {},
  edit: () => {},
  askReset: () => {},
  remember: () => {},
};

/** Every edit the screen makes, as the strip it would save. */
function record(): { edits: KeyGroup[]; actions: KeyStripActions } {
  const edits: KeyGroup[] = [];
  return { edits, actions: { ...noActions, edit: (next) => edits.push(next) } };
}

const chips = (screen: HTMLElement): (string | null)[] =>
  [...screen.querySelectorAll(".key-strip__chip")].map((chip) => chip.textContent);

const cell = (screen: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...screen.querySelectorAll<HTMLButtonElement>(".key-strip__cell")].find(
    (candidate) => candidate.textContent === label,
  );

/**
 * One finger, pressed on a chip and moved along the row.
 *
 * jsdom has no `PointerEvent` constructor, and the handlers read one field —
 * `clientX` — so a `MouseEvent` dispatched under the pointer type goes down the
 * real listener path. `setPointerCapture` is absent there too, which the view
 * already calls optionally.
 */
function drag(chip: HTMLElement | null, [from, to]: readonly [number, number]): void {
  if (!chip) throw new Error("no chip to drag");
  const at = (type: string, clientX: number) =>
    chip.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
  at("pointerdown", from);
  at("pointermove", to);
  at("pointerup", to);
}

describe("key strip screen", () => {
  it("previews the strip in its saved order", () => {
    const screen = renderKeyStripScreen({ group: GROUP }, noActions);

    expect(chips(screen)).toEqual(["Ctrl", "Esc", "Tab"]);
  });

  /** A bare pill reads as a screen that failed to load. */
  it("says so when the strip is empty", () => {
    const screen = renderKeyStripScreen({ group: { ...GROUP, keyIds: [] } }, noActions);

    expect(chips(screen)).toEqual([]);
    expect(screen.querySelector(".key-strip__empty")?.textContent).toBe(
      t("스트립이 비어 있습니다"),
    );
  });

  it("draws one card per category, in the frame's order", () => {
    const screen = renderKeyStripScreen({ group: GROUP }, noActions);

    expect([...screen.querySelectorAll(".key-strip__card-label")].map((n) => n.textContent)).toEqual(
      KEY_CATEGORIES.map((category) => t(category.label)),
    );
  });

  /**
   * The tile is what says "still available", so a key already in the strip
   * gives it up — that is the whole of the picked state (3272:85019).
   */
  it("marks the keys the strip already holds", () => {
    const screen = renderKeyStripScreen({ group: GROUP }, noActions);

    expect(cell(screen, "Esc")?.getAttribute("aria-pressed")).toBe("true");
    expect(cell(screen, "Del")?.getAttribute("aria-pressed")).toBe("false");
    expect(cell(screen, "Esc")?.classList.contains("key-strip__cell--picked")).toBe(true);
  });

  /** No 개수 제한: every key stays pressable however long the strip is. */
  it("keeps every cell pressable when the strip is long", () => {
    const long: KeyGroup = { ...GROUP, keyIds: ["ctrl", "esc", "tab", "up", "down", "f1", "f2", "f3", "f4"] };
    const screen = renderKeyStripScreen({ group: long }, noActions);

    const cells = [...screen.querySelectorAll<HTMLButtonElement>(".key-strip__cell")];
    expect(cells.length).toBeGreaterThan(9);
    expect(cells.some((candidate) => candidate.disabled)).toBe(false);
  });

  it("adds a key when an untaken cell is pressed, and removes one that is taken", () => {
    const { edits, actions } = record();
    const screen = renderKeyStripScreen({ group: GROUP }, actions);

    cell(screen, "Del")?.click();
    cell(screen, "Esc")?.click();

    expect(edits.map((group) => group.keyIds)).toEqual([
      ["ctrl", "esc", "tab", "del"],
      ["ctrl", "tab"],
    ]);
  });

  /** Only an added key animates — a removal has nothing to pop in. */
  it("names the added key, and only when one was added", () => {
    const added: (string | undefined)[] = [];
    const screen = renderKeyStripScreen(
      { group: GROUP },
      { ...noActions, edit: (_next, justAdded) => added.push(justAdded) },
    );

    cell(screen, "Del")?.click();
    cell(screen, "Esc")?.click();

    expect(added).toEqual(["del", undefined]);
  });

  /** Tapping a chip in the preview is how a key leaves the strip. */
  it("removes a key when its preview chip is tapped", () => {
    const { edits, actions } = record();
    const screen = renderKeyStripScreen({ group: GROUP }, actions);

    screen.querySelectorAll<HTMLButtonElement>(".key-strip__chip")[1]?.click();

    expect(edits.map((group) => group.keyIds)).toEqual([["ctrl", "tab"]]);
  });

  /**
   * jsdom lays nothing out, so every chip centre is 0 and a pointer at +50
   * reads as "past every neighbour" — which is exactly the drag that carries a
   * chip to the end of the row. The geometry itself is `keyStripDrag`'s test;
   * what this covers is the wiring: the gesture saves the row's new order.
   */
  it("saves the order a drag leaves the chips in", () => {
    const { edits, actions } = record();
    const screen = renderKeyStripScreen({ group: GROUP }, actions);
    const first = screen.querySelector<HTMLButtonElement>(".key-strip__chip");

    drag(first, [0, 50]);

    expect(edits.map((group) => group.keyIds)).toEqual([["esc", "tab", "ctrl"]]);
  });

  /** 6px is what stands between "I meant to move this" and a key vanishing. */
  it("does not remove a chip that was dragged rather than tapped", () => {
    const { edits, actions } = record();
    const screen = renderKeyStripScreen({ group: GROUP }, actions);
    const first = screen.querySelector<HTMLButtonElement>(".key-strip__chip");

    drag(first, [0, 50]);
    first?.click();

    expect(edits).toHaveLength(1);
    expect(edits[0]?.keyIds).toContain("ctrl");
  });

  it("pops in the key that was just added", () => {
    const screen = renderKeyStripScreen({ group: GROUP, added: "tab" }, noActions);

    const popped = [...screen.querySelectorAll(".key-strip__chip--new")].map((n) => n.textContent);
    expect(popped).toEqual(["Tab"]);
  });

  /**
   * 재설정 asks first (Figma 3202:81879). Throwing away a strip somebody
   * arranged by hand is the press that most deserves a question, and this
   * screen must not answer it on their behalf.
   */
  it("asks before putting the default strip back", () => {
    const { edits, actions } = record();
    let asked = 0;
    const screen = renderKeyStripScreen(
      { group: GROUP },
      { ...actions, askReset: () => (asked += 1) },
    );

    screen.querySelector<HTMLButtonElement>(".key-strip__reset")?.click();

    expect(asked).toBe(1);
    expect(edits).toEqual([]);
  });
});
