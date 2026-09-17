/**
 * 설정 → 키 스트립. Figma `dure-UI` 3272:85021, with the state spec at
 * 3272:85019.
 *
 * A screen, where this used to be a sheet over the session (2888:77951). The
 * strip is a setting — it belongs beside 언어 and 글꼴 크기 — and a full screen
 * is what lets the picker show every key the app can send at once instead of
 * five drawers of a tab bar.
 *
 * # It edits the live strip
 *
 * There is no 저장 here, and no draft. The frame gives the screen a *preview*
 * of the real strip and a 기본값으로 재설정 button, which is a design that only
 * makes sense if a press lands immediately — a preview of a copy nobody has
 * saved yet is just a second strip. The sheet's draft existed because the sheet
 * covered the tray it was changing; a screen does not.
 *
 * # The preview is the session's own pill
 *
 * Same glass as the shortcut pill in the agent window (`.tray__pill`), by the
 * owner's instruction: the point of a preview is that it is not a drawing of
 * the thing, it is the thing on a different screen.
 */

import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconRotateCcw from "./assets/icon-rotate-ccw.svg";
import { element, fadeWhileScrollable, glyph } from "./dom";
import { t } from "./i18n";
import { DRAG_THRESHOLD, dropIndex } from "./keyStripDrag";
import { type KeyGroup, groupKeys, reorderKeys, toggleKey } from "./keyTray";
import { KEY_CATEGORIES, TERMINAL_KEYS } from "./terminalKeys";
import "./keyStripView.css";

export interface KeyStripModel {
  /** The strip as it is saved right now. */
  readonly group: KeyGroup;
  /**
   * The key added by the press that produced this render, if any.
   *
   * The frame pops a new chip in and scrolls the strip to it, and a re-rendered
   * row cannot tell on its own which chip is new.
   */
  readonly added?: string;
  /**
   * How far the page was scrolled when the press was made.
   *
   * Every edit redraws the whole screen. Without this, choosing a symbol —
   * five cards down — throws the person back to the top of the screen, and the
   * second symbol is a scroll away from the first.
   */
  readonly scrollTop?: number;
}

export interface KeyStripActions {
  readonly back: () => void;
  /**
   * Save this strip.
   *
   * One action rather than add/remove/move, because the screen is the only
   * thing that knows what the gesture meant and the app is the only thing that
   * writes: the view composes the next strip out of `keyTray`'s pure functions
   * and hands over the whole of it. `added` is set only when a key went *in* —
   * that is the one case the frame animates.
   */
  readonly edit: (next: KeyGroup, added?: string) => void;
  /**
   * Ask before putting the default strip back. Figma 3202:81879.
   *
   * The screen does not reset anything itself: throwing away a strip somebody
   * arranged by hand is exactly the press that deserves a question, and the
   * dialog belongs to the app that owns the screen stack.
   */
  readonly askReset: () => void;
  /**
   * Where the page now stands, for a redraw this screen did not ask for.
   *
   * Anything else can redraw while the screen is open — a census answering, a
   * host check landing — and that redraw rebuilds the screen from the app's
   * state. Remembering only at the moment of a press would put somebody back
   * where they last tapped instead of where they now are. It must not itself
   * redraw.
   */
  readonly remember: (scrollTop: number) => void;
}

export function renderKeyStripScreen(
  model: KeyStripModel,
  actions: KeyStripActions,
): HTMLElement {
  const screen = element("section", "pair-screen key-strip");

  const bar = element("header", "pair-bar key-strip__bar");
  const back = element("button", "icon-tap");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.append(glyph(iconChevronLeft, 20));
  back.addEventListener("click", actions.back);
  bar.append(back, element("h1", "pair-bar__title", t("키 스트립")));
  screen.append(bar);

  screen.addEventListener("scroll", () => actions.remember(screen.scrollTop));

  const body = element("div", "key-strip__body");
  body.append(preview(model, actions));

  const cards = element("div", "key-strip__cards");
  for (const category of KEY_CATEGORIES) {
    const keys = TERMINAL_KEYS.filter((key) => key.category === category.id);
    if (keys.length === 0) continue;
    const card = element("section", "key-strip__card");
    card.append(element("h2", "key-strip__card-label", t(category.label)));
    const grid = element("div", "key-strip__grid");
    for (const key of keys) {
      const cell = element("button", "key-strip__cell", key.label);
      cell.type = "button";
      const picked = model.group.keyIds.includes(key.id);
      // Picked reads as *taken*: the tile is what says "this one is still
      // available", so a key already in the strip loses it (3272:85019).
      if (picked) cell.classList.add("key-strip__cell--picked");
      cell.setAttribute("aria-pressed", String(picked));
      cell.setAttribute(
        "aria-label",
        picked ? t("{key} 빼기", { key: key.label }) : t("{key} 추가", { key: key.label }),
      );
      cell.addEventListener("click", () =>
        actions.edit(toggleKey(model.group, key.id), picked ? undefined : key.id),
      );
      grid.append(cell);
    }
    card.append(grid);
    cards.append(card);
  }
  body.append(cards);

  const note = element("p", "key-strip__note");
  note.append(
    t("키를 누르면 스트립에 추가되고, 다시 누르면 빠집니다."),
    element("br"),
    t("미리보기의 칩은 끌어서 순서를 바꾸고, 탭하면 제거됩니다."),
  );
  body.append(note);

  const reset = element("button", "key-strip__reset");
  reset.type = "button";
  reset.append(glyph(iconRotateCcw, 14), element("span", undefined, t("기본값으로 재설정")));
  reset.addEventListener("click", actions.askReset);
  body.append(reset);

  screen.append(body);
  if (model.scrollTop) {
    // After the caller has put the screen in the document — `scrollTop` on a
    // node nobody has laid out is dropped on the floor.
    const top = model.scrollTop;
    queueMicrotask(() => {
      screen.scrollTop = top;
    });
  }
  return screen;
}

/** The strip as the session draws it, over the session's own glass. */
function preview(model: KeyStripModel, actions: KeyStripActions): HTMLElement {
  const field = element("div", "key-strip__field");
  field.append(element("div", "key-strip__label", t("미리보기")));

  const pill = element("div", "key-strip__preview");
  const keys = groupKeys(model.group);
  if (keys.length === 0) {
    // An empty strip is a state somebody can reach by removing the last chip,
    // and a bare pill would read as a screen that failed to load.
    pill.append(element("span", "key-strip__empty", t("스트립이 비어 있습니다")));
    field.append(pill);
    return field;
  }
  // The pill is the glass; the row inside it is what scrolls and fades, as the
  // session's `.tray__keys` does inside `.tray__pill`. A mask on the pill
  // itself faded its own rim and ground at the end along with the last chip
  // (2026-09-15 승연: "탭 자체에 흐림이 들어가는게 아니라 텍스트에만"), and
  // faded even a strip that fit; the fade is the chips passing under the rim,
  // only while there are more of them.
  const row = element("div", "key-strip__keys");
  fadeWhileScrollable(row, "key-strip__keys--cut");
  for (const key of keys) {
    const chip = element("button", "key-strip__chip", key.label);
    chip.type = "button";
    chip.dataset.keyId = key.id;
    chip.setAttribute("aria-label", t("{key} 빼기", { key: key.label }));
    dragToReorder(chip, row, model, actions);
    if (key.id === model.added) popIn(chip, row);
    row.append(chip);
  }
  pill.append(row);
  field.append(pill);
  return field;
}

/**
 * Tap to remove, drag to reorder — told apart by [`DRAG_THRESHOLD`].
 *
 * The row is re-ordered in the DOM as the finger moves and the state is told
 * once, on release: asking the app to re-render on every pointermove would
 * rebuild the node under the finger and drop the capture mid-gesture.
 *
 * # What moves, and how
 *
 * The held chip rides under the finger (a transform off its slot) instead of
 * jumping slot to slot; the chips it passes slide into the room it left
 * (`slide`, FLIP); and on release it settles into its slot before the state
 * is told, since a re-render mid-settle would snap it there (2026-09-15 승연:
 * "꾹 눌렀을때 이동이 스무스하게"). The slot arithmetic is layout, not the
 * transformed boxes, so a chip mid-slide still counts where it will land. A
 * tapped chip pops out the way a new one pops in, and only then leaves the
 * state (승연: "눌렀을때 갑자기 사라지는거처럼 느껴지지 않게").
 */
function dragToReorder(
  chip: HTMLButtonElement,
  row: HTMLElement,
  model: KeyStripModel,
  actions: KeyStripActions,
): void {
  let startX = 0;
  let startIndex = 0;
  let dragging = false;
  /** The finger's x less the chip's slot's left, at the press. */
  let grab = 0;

  const follow = (pointerX: number): void => {
    chip.style.transform = `translateX(${pointerX - grab - slotLeft(row, chip)}px)`;
  };

  chip.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
    startIndex = [...row.children].indexOf(chip);
    grab = event.clientX - slotLeft(row, chip);
    dragging = false;
    // Cleared here rather than only in `click`: a gesture the browser cancels
    // never produces one, and a flag left standing would eat the next tap —
    // which is how a key is removed.
    delete chip.dataset.dragged;
    chip.setPointerCapture?.(event.pointerId);
  });

  chip.addEventListener("pointermove", (event) => {
    if (!dragging && Math.abs(event.clientX - startX) < DRAG_THRESHOLD) return;
    if (!dragging) {
      dragging = true;
      row.classList.add("key-strip__keys--dragging");
      chip.classList.add("key-strip__chip--dragging");
    }
    // A finger at the edge of a row that overflows drags it along: without
    // this, a chip cannot be carried past the fade and the far end of a long
    // strip is somewhere the drag can never reach.
    scrollAtEdge(row, event.clientX);
    follow(event.clientX);
    // Re-measured every move: moving a chip is what changes the centres.
    const chips = [...row.children] as HTMLElement[];
    const current = chips.indexOf(chip);
    const centers = chips.map((node) => slotLeft(row, node) + node.offsetWidth / 2);
    const target = dropIndex(centers, current, event.clientX);
    if (target === current) return;
    const anchor = chips[target];
    if (!anchor) return;
    const before = new Map(chips.map((node) => [node, node.offsetLeft]));
    row.insertBefore(chip, target > current ? anchor.nextSibling : anchor);
    for (const node of chips) {
      const from = before.get(node);
      if (node === chip || from === undefined) continue;
      slide(node, from - node.offsetLeft);
    }
    // Its slot moved under it; keep it under the finger.
    follow(event.clientX);
  });

  const release = (): void => {
    if (!dragging) return;
    dragging = false;
    // The browser still fires a click after the drag ends. Remembered here so
    // that click can be told from a tap — and a tap removes a key.
    chip.dataset.dragged = "yes";
    row.classList.remove("key-strip__keys--dragging");
    const landed = [...row.children].indexOf(chip);
    // The row of ids, not a pair of indices: a saved key this build cannot
    // draw has no chip, and `reorderKeys` is what keeps its slot.
    const order = [...row.children].map((node) => (node as HTMLElement).dataset.keyId ?? "");
    settle(chip, () => {
      chip.classList.remove("key-strip__chip--dragging");
      if (landed < 0 || landed === startIndex) return;
      actions.edit(reorderKeys(model.group, order));
    });
  };
  chip.addEventListener("pointerup", release);
  chip.addEventListener("pointercancel", release);

  chip.addEventListener("click", () => {
    if (chip.dataset.dragged === "yes") {
      delete chip.dataset.dragged;
      return;
    }
    popOut(chip, row, () => actions.edit(toggleKey(model.group, chip.dataset.keyId ?? "")));
  });
}

/** Where a chip's slot starts on the screen — its layout, whatever transform rides it. */
function slotLeft(row: HTMLElement, node: HTMLElement): number {
  return row.getBoundingClientRect().left - row.scrollLeft + node.offsetLeft;
}

/**
 * The motion tokens as numbers, so the gesture keeps the stylesheet's pace and
 * its reduced-motion override (1ms there). Zero where there is no stylesheet
 * (a test), and every animation below then completes at once.
 */
function motion(): { readonly fast: number; readonly base: number; readonly ease: string } {
  if (typeof getComputedStyle !== "function") return { fast: 0, base: 0, ease: "ease-out" };
  const style = getComputedStyle(document.documentElement);
  const ms = (token: string): number => parseFloat(style.getPropertyValue(token)) || 0;
  return {
    fast: ms("--motion-fast"),
    base: ms("--motion-base"),
    ease: style.getPropertyValue("--ease-decelerate").trim() || "ease-out",
  };
}

/** A chip that made way slides from where it was to where it is. */
function slide(node: HTMLElement, shift: number): void {
  const { fast, ease } = motion();
  if (shift === 0 || fast <= 1 || typeof node.animate !== "function") return;
  for (const running of node.getAnimations()) running.cancel();
  node.animate([{ transform: `translateX(${shift}px)` }, { transform: "none" }], {
    duration: fast,
    easing: ease,
  });
}

/** The held chip glides the last of the way into its slot, then `done`. */
function settle(chip: HTMLElement, done: () => void): void {
  const from = chip.style.transform;
  chip.style.transform = "";
  const { fast, ease } = motion();
  if (!from || fast <= 1 || typeof chip.animate !== "function") {
    done();
    return;
  }
  const glide = chip.animate([{ transform: from }, { transform: "none" }], {
    duration: fast,
    easing: ease,
  });
  glide.finished.then(done, done);
}

/**
 * The frame's pop-in, backwards: the chip shrinks and fades as the row closes
 * over its room, and only then is the key gone from the state. Without it a
 * tap made the chip vanish between two frames.
 */
function popOut(chip: HTMLButtonElement, row: HTMLElement, done: () => void): void {
  const { base } = motion();
  if (base <= 1 || typeof chip.animate !== "function") {
    done();
    return;
  }
  // A second tap mid-exit would remove the key that took its place.
  chip.disabled = true;
  chip.style.overflow = "hidden";
  chip.style.minWidth = "0";
  const own = getComputedStyle(chip);
  const gap = getComputedStyle(row).columnGap;
  const exit = chip.animate(
    [
      {
        width: `${chip.offsetWidth}px`,
        paddingLeft: own.paddingLeft,
        paddingRight: own.paddingRight,
        marginRight: "0px",
        opacity: 1,
        transform: "scale(1)",
      },
      {
        width: "0px",
        paddingLeft: "0px",
        paddingRight: "0px",
        marginRight: `-${gap}`,
        opacity: 0,
        transform: "scale(0.7)",
      },
    ],
    { duration: base, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
  );
  exit.finished.then(done, done);
}

/** How near the end of the row a dragging finger starts pulling it along. */
const EDGE = 32;
/** How far one move pulls it. A whole chip's width would overshoot the drop. */
const EDGE_STEP = 12;

function scrollAtEdge(row: HTMLElement, pointerX: number): void {
  const box = row.getBoundingClientRect();
  // Zero-width means nothing has been laid out (a test, or a row not yet
  // painted); there is no edge to be near.
  if (box.width === 0) return;
  if (pointerX > box.right - EDGE) row.scrollLeft += EDGE_STEP;
  else if (pointerX < box.left + EDGE) row.scrollLeft -= EDGE_STEP;
}

/**
 * The frame's pop-in, and the scroll that makes a chip past the edge visible.
 *
 * The *row* is scrolled to its end rather than the chip scrolled into view: a
 * new key always lands last, and `scrollIntoView` would drag the page itself
 * back up to the preview — undoing the scroll the person was left at when they
 * pressed a cap five cards down.
 */
function popIn(chip: HTMLElement, row: HTMLElement): void {
  chip.classList.add("key-strip__chip--new");
  queueMicrotask(() => {
    if (typeof row.scrollTo === "function") {
      row.scrollTo({ left: row.scrollWidth, behavior: "smooth" });
    }
  });
}
