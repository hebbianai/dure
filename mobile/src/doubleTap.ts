/**
 * Two taps, close together, are one Tab.
 *
 * A touch keyboard has a Tab, but it is a chip in the tray or a cap in the
 * drawer, and completion is asked for far more often than either is reached
 * for. The owner asked for the transcript itself to take it (2026-09-05): tap
 * it twice and the session hears Tab, the same key the chip sends.
 *
 * # What counts as a double
 *
 * Two taps within [`DOUBLE_TAP_MS`] of each other and within
 * [`DOUBLE_TAP_SLOP`] of the same spot. The spot matters: two taps a screen
 * apart are two taps, not a double, and the slop is about a fingertip. The
 * second tap spends both — a third tap starts over rather than making a
 * second double out of taps two and three, or a fast triple would send two
 * Tabs.
 *
 * The first tap is still a tap. Whatever it did — raise the keyboard, most
 * often — it did; the double only adds the key. Waiting to see whether a
 * second tap follows would put the keyboard 300ms behind every single tap.
 */

/** How long after one tap a second one still pairs with it. */
export const DOUBLE_TAP_MS = 300;
/** How far apart, in CSS pixels, the two taps may land. */
export const DOUBLE_TAP_SLOP = 24;

export interface Tap {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

interface TouchTap extends Tap {
  readonly id: number;
}

/**
 * The tap that is waiting for its pair, or nothing.
 *
 * Pure: the caller feeds taps in and reads back whether this one completed a
 * double, along with what to remember for the next.
 */
export function pairTap(
  pending: Tap | undefined,
  tap: Tap,
): { readonly pending: Tap | undefined; readonly double: boolean } {
  if (
    pending !== undefined &&
    tap.at - pending.at <= DOUBLE_TAP_MS &&
    Math.abs(tap.x - pending.x) <= DOUBLE_TAP_SLOP &&
    Math.abs(tap.y - pending.y) <= DOUBLE_TAP_SLOP
  ) {
    return { pending: undefined, double: true };
  }
  return { pending: tap, double: false };
}

export interface DoubleTapHooks {
  readonly onDouble: () => void;
  /**
   * Which taps count. Taps on controls that do their own thing — the arrow
   * pill's buttons — are not taps on the transcript.
   */
  readonly counts?: (target: EventTarget | null) => boolean;
  readonly now?: () => number;
}

function primaryTouch(list: TouchList, id: number): Touch | undefined {
  for (let index = 0; index < list.length; index += 1) {
    const touch = list.item(index);
    if (touch?.identifier === id) return touch;
  }
  return undefined;
}

function isTouchDevice(): boolean {
  return navigator.maxTouchPoints > 0;
}

/** Listens for a double on `node`; returns the way to stop. */
export function attachDoubleTap(node: HTMLElement, hooks: DoubleTapHooks): () => void {
  const now = hooks.now ?? Date.now;
  let pending: Tap | undefined;
  const count = (target: EventTarget | null): boolean =>
    hooks.counts === undefined || hooks.counts(target);
  const remember = (tap: Tap): void => {
    const next = pairTap(pending, tap);
    pending = next.pending;
    if (next.double) hooks.onDouble();
  };

  if (isTouchDevice()) {
    let started: TouchTap | undefined;
    let moved = false;
    const markMoved = (touch: Touch): void => {
      if (started === undefined) return;
      moved =
        moved ||
        Math.abs(touch.clientX - started.x) > DOUBLE_TAP_SLOP ||
        Math.abs(touch.clientY - started.y) > DOUBLE_TAP_SLOP;
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (!count(event.target)) return;
      if (event.touches.length !== 1) {
        started = undefined;
        return;
      }
      const touch = event.changedTouches.item(0);
      if (touch === null) return;
      started = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        at: now(),
      };
      moved = false;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (started === undefined) return;
      const touch = primaryTouch(event.touches, started.id);
      if (touch !== undefined) markMoved(touch);
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (started === undefined) return;
      if (!count(event.target)) {
        started = undefined;
        return;
      }
      const touch = primaryTouch(event.changedTouches, started.id);
      if (touch === undefined) return;
      markMoved(touch);
      const tap = { x: touch.clientX, y: touch.clientY, at: now() };
      const held = tap.at - started.at > DOUBLE_TAP_MS;
      started = undefined;
      if (!moved && !held) remember(tap);
    };
    const onTouchCancel = (): void => {
      started = undefined;
    };
    node.addEventListener("touchstart", onTouchStart);
    node.addEventListener("touchmove", onTouchMove);
    node.addEventListener("touchend", onTouchEnd);
    node.addEventListener("touchcancel", onTouchCancel);
    return () => {
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchCancel);
    };
  }

  const onClick = (event: MouseEvent): void => {
    if (!count(event.target)) return;
    remember({ x: event.clientX, y: event.clientY, at: now() });
  };
  node.addEventListener("click", onClick);
  return () => node.removeEventListener("click", onClick);
}
