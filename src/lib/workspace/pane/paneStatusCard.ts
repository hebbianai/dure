// Whether an agent pane is too small to read its terminal or conversation,
// so it shows one status card instead. Size alone decides; there is no
// per-Space setting (maintainer decision on #732). The rule has hysteresis so
// a sash dragged across the line does not flip the pane back and forth, and
// it only trusts observations of a pane that is on screen and laid out:
// anything else keeps the mode the pane already has, so a warm or occluded
// Space never releases (or re-attaches) a terminal because of a stale or zero
// measurement.

export interface PaneSize {
	readonly width: number;
	readonly height: number;
}

export interface PaneStatusCardObservation extends PaneSize {
	/** The pane's Space is the one on screen. */
	readonly runtimeActive: boolean;
}

/** Pixel sizes of the pane's content box (below its header). A pane becomes
 * a card when either side drops below `enter`, and turns back into its live
 * view only once both sides reach `leave`. New agent panes are placed at
 * 480×300 or larger, so only panes a person split further become cards. */
export const PANE_STATUS_CARD_THRESHOLDS = {
	enter: { width: 360, height: 220 },
	leave: { width: 420, height: 280 },
} as const satisfies Record<"enter" | "leave", PaneSize>;

export function nextPaneStatusCard(
	shown: boolean,
	{ width, height, runtimeActive }: PaneStatusCardObservation,
): boolean {
	if (!runtimeActive || !(width > 0) || !(height > 0)) return shown;
	const { enter, leave } = PANE_STATUS_CARD_THRESHOLDS;
	return shown
		? width < leave.width || height < leave.height
		: width < enter.width || height < enter.height;
}
