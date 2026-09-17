/**
 * The menu a long press opens over a session row. Figma `dure-UI` 3356:85387
 * (a reachable session) and 3356:85535 (an unreachable one), in the frames
 * 3356:85254 and 3356:85402.
 *
 * # Why the held row is copied and not lifted
 *
 * 3356:85374 draws the row again above the scrim, at the pixel it already
 * occupies, while the rest of the list dims behind it. That is a *copy*, not
 * the list's own node moved up: a render replaces the whole tree, so the node
 * the finger was on is gone by the next paint, and a menu holding a reference
 * to it would be holding a node that belongs to no screen. The caller measures
 * the row it is about to lose and hands the rectangle over as `anchor`.
 *
 * # Why nothing here takes focus
 *
 * The screen underneath keeps redrawing — the census ticks — and every render
 * blurs whatever held focus. A menu that focused its first item would spend the
 * whole long press fighting those renders for the screen reader's cursor, and
 * the reader would be dragged back to the top of the menu on each tick. So the
 * menu is announced by its role and left alone; the reader walks into it.
 *
 * That is also why Escape is caught on the document rather than on the host: no
 * key ever reaches an element nothing has focused.
 */

import { element, glyph } from "./dom";
import { type MenuAnchor, type MenuViewport, placeRowMenu } from "./sessionRowMenuPlacement";
import "./sessionRowMenu.css";

export interface RowMenuItem {
  readonly id: string;
  /** Already through `t()`. The menu owns no copy, so a new item adds none. */
  readonly label: string;
  /** An imported SVG. `glyph` paints it as a mask, so it takes the item's colour. */
  readonly icon: string;
  readonly destructive?: true;
  /**
   * Opens the group under the hairline, the way 3356:85398 separates 세션 종료.
   * Every item from here down belongs to that group, and takes its taller row.
   */
  readonly separated?: true;
  readonly run: () => void;
}

export interface RowMenuModel {
  /** Where the held row stood, measured before the render that takes it. */
  readonly anchor: MenuAnchor;
  /** The row's first line, and — redrawn over the scrim — what names the menu. */
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly RowMenuItem[];
}

/** The copied row's title names the menu, so there is only ever one of these. */
const TITLE_ID = "row-menu-title";

export function renderSessionRowMenu(
  model: RowMenuModel,
  actions: { readonly dismiss: () => void },
): HTMLElement {
  const host = element("div", "row-menu");
  host.setAttribute("role", "dialog");
  // `aria-modal` is only honoured on a window role, which is why the scrim
  // carries `dialog` on top of holding the menu: without it the announcement
  // is "menu", and the list behind it stays in the reader's reach.
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-labelledby", TITLE_ID);
  // `sheetShell`'s test, for the same reason: the scrim is the whole screen, so
  // a press that landed on the card has already bubbled through here.
  host.addEventListener("click", (event) => {
    if (event.target === host) actions.dismiss();
  });

  const card = menuCard(model);
  host.append(liftedRow(model), card);

  /**
   * Ask [`placeRowMenu`] where the card goes, with the height it actually has.
   *
   * Twice, because a detached card measures zero: this returns the host before
   * the caller has put it anywhere, so the first pass has nothing to measure
   * and the second — a microtask later, once the caller has appended it — has
   * the laid-out card. In jsdom both passes read zero, because jsdom lays
   * nothing out; the real height only exists on a device, and the placement
   * function is what keeps a card of any height on the screen.
   */
  const place = (): void => {
    const placement = placeRowMenu(model.anchor, card.offsetHeight, viewportOf(host));
    card.style.top = `${placement.top}px`;
    card.style.left = `${placement.left}px`;
    card.classList.toggle("row-menu__card--above", placement.above);
  };
  place();
  queueMicrotask(place);

  // On the document, and self-unhooking: nothing here is focused, so the key
  // arrives at the body, and the render that throws this host away never tells
  // the menu it is gone. The first key after that removes the listener.
  const onKeydown = (event: KeyboardEvent): void => {
    if (!host.isConnected) {
      host.ownerDocument.removeEventListener("keydown", onKeydown, true);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    actions.dismiss();
  };
  host.ownerDocument.addEventListener("keydown", onKeydown, true);

  return host;
}

/**
 * The row as it stood, drawn again over the scrim.
 *
 * Absolutely placed inside a host that is itself pinned to the viewport, so the
 * anchor's viewport coordinates go through unchanged. It takes no presses: it
 * is a picture of a row, and a tap on it is a tap outside the card, which is
 * what cancels.
 */
function liftedRow(model: RowMenuModel): HTMLElement {
  const row = element("div", "row-menu__row");
  row.style.top = `${model.anchor.top}px`;
  row.style.left = `${model.anchor.left}px`;
  row.style.width = `${model.anchor.width}px`;
  row.style.height = `${model.anchor.height}px`;

  const title = element("p", "row-menu__row-title", model.title);
  title.id = TITLE_ID;
  row.append(title);
  if (model.subtitle !== undefined) {
    row.append(element("p", "row-menu__row-subtitle", model.subtitle));
  }
  return row;
}

function menuCard(model: RowMenuModel): HTMLElement {
  const card = element("div", "row-menu__card");
  card.setAttribute("role", "menu");

  // Latching, not per item: the divider is what makes the actions under it a
  // second group, and 3356:85387 gives that whole group the taller row. An item
  // marked `separated` brings its own hairline, so two of them read as two
  // groups rather than one line drawn twice.
  let belowDivider = false;
  for (const item of model.items) {
    if (item.separated === true) {
      const divider = element("div", "row-menu__divider");
      divider.setAttribute("role", "separator");
      card.append(divider);
      belowDivider = true;
    }
    card.append(menuItem(item, belowDivider));
  }
  return card;
}

function menuItem(item: RowMenuItem, belowDivider: boolean): HTMLElement {
  const classes = ["row-menu__item"];
  if (belowDivider) classes.push("row-menu__item--below");
  if (item.destructive === true) classes.push("row-menu__item--destructive");

  const button = element("button", classes.join(" "));
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.append(
    glyph(item.icon, 16, "row-menu__icon"),
    element("span", "row-menu__label", item.label),
  );
  // Runs the action and nothing else. What an action does to the menu is the
  // caller's: 이름 바꾸기 opens a sheet over it, and a menu that had already
  // torn itself down would take the row that sheet is about with it.
  button.addEventListener("click", () => item.run());
  return button;
}

/**
 * The screen the card has to land on.
 *
 * `env(safe-area-inset-*)` is reachable only from CSS, so the stylesheet
 * republishes both as custom properties for this to read back. A detached host
 * — and jsdom, which resolves no custom property — reads nothing, and nothing
 * becomes zero, which is what a phone without a notch reports anyway.
 */
function viewportOf(host: HTMLElement): MenuViewport {
  const style = getComputedStyle(host);
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    safeTop: pixels(style.getPropertyValue("--row-menu-safe-top")),
    safeBottom: pixels(style.getPropertyValue("--row-menu-safe-bottom")),
  };
}

function pixels(value: string): number {
  const measure = Number.parseFloat(value);
  return Number.isFinite(measure) ? measure : 0;
}
