/** The hmux bar caps a panel that hosts a terminal, so it takes the colour the
 *  terminal actually paints and joins it without a seam. That used to be
 *  bg-background, which held only while the terminal painted the app floor;
 *  once the default terminal moved onto glass/pane (2026-09-01) the bar was
 *  left a darker strip above a lighter terminal. --terminal-background follows
 *  the canvas in every theme, including a scheme whose terminal is its own
 *  background rather than any derived surface; bg-surface-terminal is that
 *  colour with the user's surface alpha folded in (lib/theme/surfaceOpacity),
 *  the same alpha the canvas paints, so the join holds at any opacity. */
export function agentPanelSecondaryBarTone(hmux: boolean): string {
	return hmux
		? "border-transparent bg-surface-terminal"
		: "border-border/60 bg-glass-pane";
}
