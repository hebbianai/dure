import { describe, expect, it } from "vitest";
import { EMPTY_LEDGER, ENTER_CLASS, markEntrances, SCREEN_CLASS } from "./enterMotion";

function viewWith(...classes: string[]): HTMLElement {
  const view = document.createElement("div");
  for (const className of classes) {
    const node = document.createElement("div");
    node.className = className;
    view.append(node);
  }
  return view;
}

const entering = (view: HTMLElement, selector: string) =>
  view.querySelector(selector)?.classList.contains(ENTER_CLASS);

describe("enter motion", () => {
  it("animates an overlay on the render where it first appears", () => {
    const view = viewWith("sheet");
    const ledger = markEntrances(view, "home", EMPTY_LEDGER);
    expect(entering(view, ".sheet")).toBe(true);
    expect([...ledger.overlays]).toEqual(["sheet"]);
  });

  it("keeps an overlay still when a later render rebuilds it", () => {
    const first = viewWith("sheet");
    const ledger = markEntrances(first, "home", EMPTY_LEDGER);
    const rebuilt = viewWith("sheet");
    markEntrances(rebuilt, "home", ledger);
    expect(entering(rebuilt, ".sheet")).toBe(false);
  });

  it("animates the overlay again once it has been away", () => {
    let ledger = markEntrances(viewWith("sheet"), "home", EMPTY_LEDGER);
    ledger = markEntrances(viewWith(), "home", ledger);
    const back = viewWith("sheet");
    markEntrances(back, "home", ledger);
    expect(entering(back, ".sheet")).toBe(true);
  });

  it("treats every drawer as one entrance", () => {
    const keys = viewWith("tray__panel");
    const ledger = markEntrances(keys, "terminal", EMPTY_LEDGER);
    expect(entering(keys, ".tray__panel")).toBe(true);
    const history = viewWith("tray__panel tray__panel--sessions");
    markEntrances(history, "terminal", ledger);
    expect(entering(history, ".tray__panel")).toBe(false);
  });

  it("keys the view menu's card by its axis", () => {
    const card = (facet: string) => {
      const view = viewWith("home-menu__card");
      const node = view.querySelector<HTMLElement>(".home-menu__card");
      if (node) node.dataset.facet = facet;
      return view;
    };
    const grouping = card("grouping");
    let ledger = markEntrances(grouping, "home", EMPTY_LEDGER);
    expect(entering(grouping, ".home-menu__card")).toBe(true);
    const rebuilt = card("grouping");
    ledger = markEntrances(rebuilt, "home", ledger);
    expect(entering(rebuilt, ".home-menu__card")).toBe(false);
    const ordering = card("ordering");
    markEntrances(ordering, "home", ledger);
    expect(entering(ordering, ".home-menu__card")).toBe(true);
  });

  it("fades the view only when the screen kind changes", () => {
    const first = viewWith();
    let ledger = markEntrances(first, "home", EMPTY_LEDGER);
    expect(first.classList.contains(SCREEN_CLASS)).toBe(false);
    const same = viewWith();
    ledger = markEntrances(same, "home", ledger);
    expect(same.classList.contains(SCREEN_CLASS)).toBe(false);
    const next = viewWith();
    markEntrances(next, "terminal", ledger);
    expect(next.classList.contains(SCREEN_CLASS)).toBe(true);
  });

  it("takes the class off when the animation ends", () => {
    const view = viewWith("confirm-dialog");
    markEntrances(view, "home", EMPTY_LEDGER);
    const dialog = view.querySelector(".confirm-dialog");
    dialog?.dispatchEvent(new Event("animationend"));
    expect(dialog?.classList.contains(ENTER_CLASS)).toBe(false);
  });

  it("ignores a child's animation ending, which bubbles", () => {
    const view = viewWith("sheet");
    const sheet = view.querySelector(".sheet");
    const panel = document.createElement("div");
    sheet?.append(panel);
    markEntrances(view, "terminal", { overlays: new Set(), screen: "home" });
    panel.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(sheet?.classList.contains(ENTER_CLASS)).toBe(true);
    expect(view.classList.contains(SCREEN_CLASS)).toBe(true);
    sheet?.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(sheet?.classList.contains(ENTER_CLASS)).toBe(false);
    expect(view.classList.contains(SCREEN_CLASS)).toBe(true);
  });
});
