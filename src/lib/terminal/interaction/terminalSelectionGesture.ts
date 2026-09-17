interface SelectionGestureOrigin {
	readonly pointerId: number;
	readonly originX: number;
	readonly originY: number;
	readonly moved: boolean;
}

/** Local selection starts with a primary-button press, not a context-menu or
 * touch-scroll gesture. Ctrl-click retains the platform's context-menu action. */
export function canStartTerminalSelection(event: {
	readonly button: number;
	readonly ctrlKey: boolean;
	readonly pointerType?: string;
}): boolean {
	return event.button === 0 && !event.ctrlKey && event.pointerType !== "touch";
}

/** Six CSS pixels of click slop keep small focus-click movements from selecting
 * a whole terminal cell. Once admitted, a drag stays active until release. */
export function terminalSelectionMove(
	origin: SelectionGestureOrigin,
	event: Pick<PointerEvent, "pointerId" | "buttons" | "clientX" | "clientY">,
): "unrelated" | "cancel" | "pending" | "drag" {
	if (origin.pointerId !== event.pointerId) return "unrelated";
	if ((event.buttons & 1) === 0) return "cancel";
	return origin.moved ||
		Math.hypot(
			event.clientX - origin.originX,
			event.clientY - origin.originY,
		) >= 6
		? "drag"
		: "pending";
}

/** A drag can reach an inside edge even when the pane fills the screen. Keep
 * horizontal selection in an edge row local; only outward movement scrolls. */
export function terminalSelectionScrollDirection(
	drag: { readonly originY: number; readonly clientY: number },
	bounds: { readonly top: number; readonly bottom: number },
	rowHeight: number,
	history: { readonly hasMoreBefore: boolean; readonly hasMoreAfter: boolean },
): 1 | -1 | 0 {
	const edge = Math.min(rowHeight, (bounds.bottom - bounds.top) / 4);
	if (
		drag.clientY < drag.originY &&
		drag.clientY < bounds.top + edge &&
		history.hasMoreBefore
	)
		return 1;
	if (
		drag.clientY > drag.originY &&
		drag.clientY >= bounds.bottom - edge &&
		history.hasMoreAfter
	)
		return -1;
	return 0;
}
