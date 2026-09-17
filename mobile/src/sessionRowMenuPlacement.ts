/**
 * Where the long-press menu card stands relative to the row that was held.
 * Figma `dure-UI` 3356:85374 (the lifted row) and 3356:85387 (the card).
 *
 * # Why this is a module and not four lines in the view
 *
 * The same reason the strip's drag is one (`keyStripDrag.ts`): jsdom lays
 * nothing out, so every rectangle a test could read from the real view is
 * zero, and the one thing worth testing here is which side of the row the card
 * takes. Written as arithmetic over numbers, a test can state "a row near the
 * bottom of a 852pt phone" and read the answer back.
 *
 * # Why it may overlap the row but never leave the screen
 *
 * The card is the only way out of a long press — every action the gesture
 * offers is on it — so a card half under the home indicator is a dead end,
 * while a card sitting over the row it belongs to is merely ugly. When neither
 * side has room the card takes the roomier one and is pushed back inside the
 * safe area, rather than being drawn where it was asked for.
 */

/**
 * The space between the lifted row and the card.
 *
 * Figma has the row's bottom at y=213 and the card's top at y=221.
 */
export const MENU_GAP = 8;

/** The card's width in the spec, fixed rather than the row's. */
export const MENU_WIDTH = 262;

/**
 * How far the card is held off either edge.
 *
 * The spec starts it at x=12, which is the project group's own horizontal
 * inset: the card lines up with the group the held row lives in, so it reads
 * as belonging to that list and not to the screen.
 */
export const MENU_INSET = 12;

/** The held row, in viewport coordinates. */
export interface MenuAnchor {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** The screen the card has to land on, less whatever the OS owns. */
export interface MenuViewport {
  readonly width: number;
  readonly height: number;
  readonly safeTop: number;
  readonly safeBottom: number;
}

export interface MenuPlacement {
  readonly top: number;
  readonly left: number;
  /** The card took the room above the row, so its tail points down. */
  readonly above: boolean;
}

/**
 * Place a card of `menuHeight` against `anchor`.
 *
 * Below the row by default, above it when below would run past the safe area,
 * and — when the row is tall enough that neither side holds the card — on
 * whichever side has more room, clamped back inside.
 */
export function placeRowMenu(
  anchor: MenuAnchor,
  menuHeight: number,
  viewport: MenuViewport,
): MenuPlacement {
  const floor = viewport.height - viewport.safeBottom;
  const under = anchor.top + anchor.height + MENU_GAP;
  const over = anchor.top - MENU_GAP - menuHeight;
  const roomUnder = floor - under;
  const roomOver = anchor.top - MENU_GAP - viewport.safeTop;
  // Below unless the card overruns the floor and there is more room over the
  // row than under it — one that fits above but not below is already on the
  // roomier side. A tie goes below, which is where the spec draws it.
  const above = menuHeight > roomUnder && roomOver > roomUnder;
  return {
    top: clamp(above ? over : under, viewport.safeTop, floor - menuHeight),
    // The card keeps the spec's width, so how far right it may start is set by
    // that width and not by how wide the row happens to be.
    left: clamp(anchor.left, MENU_INSET, viewport.width - MENU_WIDTH - MENU_INSET),
    above,
  };
}

/**
 * `low` wins when the bounds cross — which they do whenever the card is taller
 * than the safe area, or the screen narrower than the card and its insets. A
 * card pinned to the top-left is still reachable; one pinned to the far side
 * has its first action off screen.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}
