import type { DockviewApi } from "dockview-react";

/** CSS owns this container's size; Dockview owns only its descendants. Lay out
 * in the ResizeObserver delivery before paint, not in the next animation frame.
 * The caller disables Dockview's deferred auto-resize and owns this subscription.
 */
export function observeDockviewContainer(
	container: HTMLElement,
	api: Pick<DockviewApi, "width" | "height" | "layout">,
): () => void {
	const observer = new ResizeObserver(([entry]) => {
		const width = Math.round(entry.contentRect.width);
		const height = Math.round(entry.contentRect.height);
		// Hidden workspaces must retain their proportions until measurable again.
		if (width <= 0 || height <= 0) return;
		if (width === api.width && height === api.height) return;
		api.layout(width, height);
	});
	observer.observe(container);
	return () => observer.disconnect();
}
