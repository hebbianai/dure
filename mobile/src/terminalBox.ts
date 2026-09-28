/**
 * The terminal's visible content box. Padding belongs to the tray and pane,
 * while the software keyboard has already reduced the host's clientHeight.
 * Measure the host rather than the painted grid so the terminal can shrink.
 * Overlay drawers leave the host box unchanged and use scroll room instead.
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
  return {
    width: Math.max(0, host.clientWidth - px(style?.paddingLeft) - px(style?.paddingRight)),
    height: Math.max(
      0,
      host.clientHeight - px(style?.paddingTop) - px(style?.paddingBottom),
    ),
  };
}
