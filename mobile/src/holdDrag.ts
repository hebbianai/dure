/**
 * Hold the transcript, drag: the arrow keys, without the keyboard.
 *
 * The space-bar trackpad (`spaceTrackpad.ts`) needs the keys up. The owner
 * asked for the same gesture on the transcript itself (2026-09-05): press and
 * hold anywhere on it, then drag — up and down are ↑/↓, left and right are
 * ←/→, and the pill lights the way, exactly as the space bar does it.
 *
 * # Hold first, so a scroll is still a scroll
 *
 * A drag that starts moving at once is the transcript scrolling, and it must
 * stay that. The gesture arms only after the finger has rested
 * [`HOLD_MS`] without moving more than [`HOLD_SLOP`]; from then until it
 * lifts, its movement is cells and the transcript does not scroll under it.
 *
 * # The same cells, the same gain
 *
 * A row is [`ROW_PX`] tall and a column [`COL_PX`] wide — the space-bar pad's
 * cells — so a line of history costs the same finger either way, and the
 * moves go through `trackpadMove`, which owns the 45° split and the gain.
 */

import {
  FAST_GAIN,
  IDLE_GESTURE,
  type TrackpadDirection,
  type TrackpadGesture,
  trackpadMove,
} from "./spaceTrackpad";

/** How long the finger rests before the drag arms. */
export const HOLD_MS = 400;
/** How far it may drift while resting and still count as resting. */
export const HOLD_SLOP = 10;
/** One line of history, in CSS pixels of finger. */
export const ROW_PX = 28;
/** One character of cursor. */
export const COL_PX = 16;

export interface HoldDragHooks {
  readonly press: (direction: TrackpadDirection) => void;
  /** Open at the hold threshold; hand off on release or dismiss on cancellation. */
  readonly hold?: (point: { x: number; y: number }) => { dismiss(): void; release(): void };
  /** Which way the drag is going, or `undefined` once it has ended. */
  readonly direction: (direction: TrackpadDirection | undefined, fast: boolean) => void;
  /** Which presses count. A press on a control is that control's. */
  readonly counts?: (target: EventTarget | null) => boolean;
  readonly now?: () => number;
}

/** Cells crossed since the hold began, for a finger at (`x`, `y`). */
export function cellsFrom(origin: { x: number; y: number }, x: number, y: number) {
  return {
    rows: Math.trunc((y - origin.y) / ROW_PX),
    cols: Math.trunc((x - origin.x) / COL_PX),
  };
}

/** Listens on `node`; returns the way to stop. */
export function attachHoldDrag(node: HTMLElement, hooks: HoldDragHooks): () => void {
  const now = hooks.now ?? Date.now;
  let origin: { x: number; y: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  let seen = { rows: 0, cols: 0 };
  let gesture: TrackpadGesture = IDLE_GESTURE;
  let consumeClick = false;
  let heldAction: ReturnType<NonNullable<HoldDragHooks["hold"]>> | undefined;

  const closeHold = (): void => {
    heldAction?.dismiss();
    heldAction = undefined;
  };

  const reset = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    origin = undefined;
    if (armed) hooks.direction(undefined, false);
    armed = false;
  };

  const onDown = (event: PointerEvent): void => {
    consumeClick = false;
    closeHold();
    if (hooks.counts !== undefined && !hooks.counts(event.target)) return;
    reset();
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      timer = undefined;
      armed = true;
      seen = { rows: 0, cols: 0 };
      gesture = IDLE_GESTURE;
      if (origin) heldAction = hooks.hold?.(origin);
    }, HOLD_MS);
  };

  const onMove = (event: PointerEvent): void => {
    if (origin === undefined) return;
    if (!armed) {
      // Moving before the hold is a scroll. Let it be one.
      if (
        Math.abs(event.clientX - origin.x) > HOLD_SLOP ||
        Math.abs(event.clientY - origin.y) > HOLD_SLOP
      ) {
        reset();
      }
      return;
    }
    const cells = cellsFrom(origin, event.clientX, event.clientY);
    const rows = cells.rows - seen.rows;
    const cols = cells.cols - seen.cols;
    seen = cells;
    if (rows === 0 && cols === 0) return;
    const move = trackpadMove(gesture, rows, cols, now());
    gesture = move.gesture;
    if (move.presses.length === 0) return;
    closeHold();
    for (const press of move.presses) hooks.press(press);
    hooks.direction(move.presses[move.presses.length - 1], move.gain >= FAST_GAIN);
  };

  // The finger is ours once the drag has armed: the transcript must not
  // scroll under it. Only reachable through the touch event, and only if the
  // listener is not passive. Capture runs before `terminalScroll.ts`, whose
  // scroll owner reads `defaultPrevented` and yields to the armed hold.
  const onTouchMove = (event: TouchEvent): void => {
    if (armed && event.cancelable) event.preventDefault();
  };

  const onUp = (): void => {
    consumeClick = armed;
    heldAction?.release();
    heldAction = undefined;
    reset();
  };
  const onCancel = (): void => {
    closeHold();
    reset();
  };
  const onClick = (event: MouseEvent): void => {
    if (!consumeClick) return;
    consumeClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onContextMenu = (event: MouseEvent): void => {
    if (hooks.hold && (hooks.counts?.(event.target) ?? true)) event.preventDefault();
  };

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onCancel);
  node.addEventListener("click", onClick, true);
  node.addEventListener("contextmenu", onContextMenu);
  node.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
  return () => {
    onCancel();
    node.removeEventListener("pointerdown", onDown);
    node.removeEventListener("pointermove", onMove);
    node.removeEventListener("pointerup", onUp);
    node.removeEventListener("pointercancel", onCancel);
    node.removeEventListener("click", onClick, true);
    node.removeEventListener("contextmenu", onContextMenu);
    node.removeEventListener("touchmove", onTouchMove, { capture: true });
  };
}
