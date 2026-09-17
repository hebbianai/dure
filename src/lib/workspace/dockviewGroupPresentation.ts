const DOCKVIEW_GROUP_SELECTOR = ".dv-groupview";

export const SPACES_PANE_HOVER_ATTRIBUTE = "data-spaces-pane-hovered";

/**
 * Reflect a pane-local presentation state onto its Dockview group.
 *
 * A direct group attribute keeps WebKit's style invalidation bounded to the
 * group chrome. A descendant `:has(...)` selector made every xterm class
 * change rescan the terminal's large DOM subtree during focus handoff.
 */
export function syncSpacesPaneHoverGroup(
	source: Element,
	active: boolean,
): () => void {
	const group = source.closest<HTMLElement>(DOCKVIEW_GROUP_SELECTOR);
	if (!group) return () => {};

	if (active) group.setAttribute(SPACES_PANE_HOVER_ATTRIBUTE, "");
	else group.removeAttribute(SPACES_PANE_HOVER_ATTRIBUTE);

	return () => {
		if (active) group.removeAttribute(SPACES_PANE_HOVER_ATTRIBUTE);
	};
}
