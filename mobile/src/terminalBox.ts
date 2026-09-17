import { KEYBOARD_LIFT_PROPERTY } from "./transcriptLift";

/**
 * The box the session is sized to: the transcript at rest.
 *
 * Two corrections to what the host reports, and they pull in opposite
 * directions.
 *
 * **The padding comes off.** `clientHeight` includes it, and the host carries
 * the pane's 16 plus the pill the tray floats on. Reading the grid instead —
 * which is what this used to do — cannot work: the grid is as tall as the frame
 * already painted and carries `min-height`, so it answers "how big is the
 * terminal" with "as big as the terminal". The number could grow and could
 * never shrink.
 *
 * **The keyboard goes back on.** It is the one thing standing on the transcript
 * that takes the host's own room: the visual viewport shrinks and the whole
 * screen with it. The session is not allowed to hear about that — the keys are
 * scroll room, not a smaller terminal (`transcriptLift.ts` says why) — so what
 * they cover is added back and the size stays the at-rest one.
 *
 * A drawer is *not* added back, and the asymmetry is the layout's, not a
 * choice: the tray is absolutely positioned, so a drawer covers the transcript
 * without ever taking a pixel of its box. There is nothing to give back. It
 * still lifts the grid's floor, because that is what the newest line scrolls
 * clear of.
 */
export interface TerminalContentBox {
  readonly width: number;
  readonly height: number;
}

export function terminalContentBox(host: HTMLElement): TerminalContentBox {
  const style = host.ownerDocument.defaultView?.getComputedStyle(host);
  // A length the browser has not resolved yet reads as "", and `NaN` would
  // silently become a one-row terminal. Absent is none.
  const px = (value: string | undefined): number => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  // Custom properties inherit, so the host sees what the document published.
  const lift = px(style?.getPropertyValue(KEYBOARD_LIFT_PROPERTY));
  return {
    width: Math.max(0, host.clientWidth - px(style?.paddingLeft) - px(style?.paddingRight)),
    height: Math.max(
      0,
      host.clientHeight - px(style?.paddingTop) - px(style?.paddingBottom) + lift,
    ),
  };
}
