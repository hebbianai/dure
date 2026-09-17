const hoverBounds = new WeakMap<DragEvent, WeakMap<HTMLElement, DOMRect>>();

/** Share one hover's coordinate frame between recommendation and insertion.
 * Overlay writes between their capture handlers must not trigger another layout
 * read. A new native event or a different workspace always measures its own box.
 */
export function readPaneDragGeometry(
	event: DragEvent,
	container: HTMLElement,
): DOMRect {
	let workspaces = hoverBounds.get(event);
	if (!workspaces) {
		workspaces = new WeakMap();
		hoverBounds.set(event, workspaces);
	}

	let box = workspaces.get(container);
	if (!box) {
		box = container.getBoundingClientRect();
		workspaces.set(container, box);
	}
	return box;
}
