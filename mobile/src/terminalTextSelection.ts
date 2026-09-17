/** The browser owns selection; terminal gestures yield while it is active. */
export function hasTerminalTextSelection(host: HTMLElement): boolean {
	const selection = host.ownerDocument.getSelection();
	return (
		!!selection &&
		!selection.isCollapsed &&
		host.contains(selection.anchorNode) &&
		host.contains(selection.focusNode)
	);
}
