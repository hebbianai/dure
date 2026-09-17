// Shared mousedown grammar for chrome drag strips in windows without a native
// title bar (bare-root secondary windows and the main title-bar columns):
// primary button only, presses inside interactive descendants keep their own
// behavior, a double-click means maximize, a plain press starts the OS drag.

/** Descendants that must keep receiving presses inside a chrome drag strip. */
const CHROME_DRAG_INTERACTIVE_SELECTOR =
	"button, input, textarea, [data-nodrag]";

export type ChromeDragIntent = "toggle-maximize" | "start-dragging";

/**
 * Classify a mousedown on a chrome drag strip. Returns `undefined` when the
 * press must be left alone: a non-primary button, or a press that landed on
 * (or inside) an interactive descendant.
 */
export function chromeDragIntent(event: {
	button: number;
	detail: number;
	target: EventTarget | null;
}): ChromeDragIntent | undefined {
	if (event.button !== 0) return undefined;
	// Duck-typed instead of `instanceof Element` so the module stays runnable
	// without a DOM realm (per-window realms also break instanceof checks).
	const target = event.target as Partial<Element> | null;
	if (target?.closest?.(CHROME_DRAG_INTERACTIVE_SELECTOR)) return undefined;
	return event.detail === 2 ? "toggle-maximize" : "start-dragging";
}
