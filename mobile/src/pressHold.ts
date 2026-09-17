/**
 * Press and hold a session row to open its menu. Figma `dure-UI` 3356:85254.
 *
 * # Why this is a module and not six lines inside the row
 *
 * The reason [`keyStripDrag`] gives for itself: jsdom lays nothing out, so a
 * gesture written inside a view can only be checked by a browser nobody runs
 * in CI. What can go wrong here is not the drawing — it is the arithmetic and
 * the order of the states. A press that fires twice opens two menus; a press
 * cancelled by a scroll opens one nobody asked for; and the click the browser
 * still owes after a hold opens the session *behind* the menu. All three are
 * states a test can step through once they live away from the row.
 *
 * The menu opens against the row, and only the caller knows what it opens, so
 * the row's rectangle is measured once — at the moment the hold fires, before
 * anything can re-render — and handed over. This module reads and writes no
 * app state: it knows one node and one callback.
 */

/**
 * How long the finger stays down before the row means "menu", not "open".
 *
 * Half a second is what both phone platforms call a long press, so it is what
 * a thumb already expects. Shorter turns an unhurried tap into a menu; longer
 * and the finger has given up and lifted before anything happened.
 */
export const HOLD_DELAY_MS = 500;

/**
 * How far the finger may drift and still count as held still.
 *
 * `keyStripDrag.DRAG_THRESHOLD` is 6px too, for a different gesture — the
 * point where a chip stops being tapped and starts being dragged. The two
 * agree today about what a resting thumb does, not because either derives from
 * the other, and this one has a scrolling list under it to answer to. Sharing
 * the constant would make a future change to one silently change the other.
 */
export const HOLD_CANCEL_PX = 6;

/** Samsung Android 16 finishes its native selection about 220ms after Dure's menu opens. */
const NATIVE_SELECTION_SETTLE_MS = 300;

export interface PressHoldHooks {
  /** Held long enough. `rect` is the row as it stood when the press ripened. */
  readonly hold: (rect: DOMRect) => void;
  readonly now?: () => number;
}

export interface PressHold {
  dispose(): void;
}

/**
 * Turn presses on `node` into holds.
 *
 * Every listener sits on `node`, and the pointer is captured, so a press
 * survives the finger sliding off the row — a list that scrolls moves the row
 * out from under a thumb that has not moved at all.
 */
export function bindPressHold(node: HTMLElement, hooks: PressHoldHooks): PressHold {
  const now = hooks.now ?? Date.now;
  /** Where the finger went down, or `undefined` when no press is running. */
  let origin: { readonly x: number; readonly y: number } | undefined;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  /** A hold has fired and the browser still owes this node its click. */
  let swallowClick = false;

  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    origin = undefined;
  };

  const clearSelection = (): void => node.ownerDocument.getSelection()?.removeAllRanges();

  const settleNativeSelection = (): void => {
    clearSelection();
    if (selectionTimer !== undefined) return;
    selectionTimer = setTimeout(() => {
      selectionTimer = undefined;
      clearSelection();
    }, NATIVE_SELECTION_SETTLE_MS);
  };

  const finish = (): void => {
    // Android may commit its native selection after the hold timer, but before
    // the finger comes up — or as the pointer-up default action completes.
    if (swallowClick) settleNativeSelection();
    cancel();
  };

  const ripen = (): void => {
    if (origin === undefined) return;
    const left = deadline - now();
    if (left > 0) {
      // The clock says when the press is old enough; the timer only wakes us
      // up to ask. `setTimeout` is allowed to run a shade early and a busy
      // phone runs it late, and a menu that opened at 490ms is a menu the
      // finger had not yet asked for.
      timer = setTimeout(ripen, left);
      return;
    }
    const rect = node.getBoundingClientRect();
    // Settled before `hold` runs, never after. The menu opening is itself
    // pointer traffic on this row, and tidying up once the callback returns
    // would sweep away the press that opening it began.
    cancel();
    swallowClick = true;
    // Samsung's Android WebView can enter native selection action mode even
    // after CSS, `selectstart`, and `contextmenu` all refused selection. Clear
    // the range at the moment Dure takes over the long press; this dismisses
    // the native handles and toolbar without disabling intentional selection
    // elsewhere (for example the SSH public-key screen).
    // Queue the settled clear before `hold` replaces this row and its pointer
    // listeners with the menu. Android's later `pointercancel` then has no row
    // to reach, but the document-owned selection is still cleared.
    settleNativeSelection();
    hooks.hold(rect);
  };

  const onDown = (event: PointerEvent): void => {
    cancel();
    // Cleared on the way in rather than when the click arrives: a hold whose
    // click the browser never sends would leave the flag standing, and it
    // would eat the next ordinary tap — the bug `keyStripView.ts` carries a
    // comment about at its own `pointerdown`.
    swallowClick = false;
    origin = { x: event.clientX, y: event.clientY };
    deadline = now() + HOLD_DELAY_MS;
    timer = setTimeout(ripen, HOLD_DELAY_MS);
    node.setPointerCapture?.(event.pointerId);
  };

  const onMove = (event: PointerEvent): void => {
    if (origin === undefined) return;
    // Distance from the down point, not each axis on its own: 6px of drift on
    // both axes is 8px of travel, and a finger that has gone that far
    // diagonally is scrolling the list.
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <= HOLD_CANCEL_PX) return;
    cancel();
  };

  const onClick = (event: MouseEvent): void => {
    if (!swallowClick) return;
    event.preventDefault();
    event.stopPropagation();
  };

  // Android WebView does not consistently honor the CSS selection guards on
  // a long-pressed button. Cancel both browser events at the gesture owner so
  // the native selection handles and toolbar cannot cover Dure's row menu.
  const onNativeLongPress = (event: Event): void => {
    event.preventDefault();
  };

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);
  node.addEventListener("selectstart", onNativeLongPress);
  node.addEventListener("contextmenu", onNativeLongPress);
  // Capture, so the click is stopped on the way down — before the row's own
  // handler, wherever the row hung it. A bubble-phase listener here would be
  // racing that handler for registration order instead.
  node.addEventListener("click", onClick, true);

  return {
    dispose(): void {
      cancel();
      if (selectionTimer !== undefined) clearTimeout(selectionTimer);
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", finish);
      node.removeEventListener("pointercancel", finish);
      node.removeEventListener("selectstart", onNativeLongPress);
      node.removeEventListener("contextmenu", onNativeLongPress);
      node.removeEventListener("click", onClick, true);
    },
  };
}
