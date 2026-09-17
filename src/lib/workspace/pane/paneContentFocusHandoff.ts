import {
	installTerminalRecoveryFocusTracking,
	terminalRecoveryFocusTracker,
} from "@/lib/terminal/terminalRecoveryFocus";

export interface PaneContentFocusHandle {
	readonly group: { readonly element: HTMLElement };
	getWindow(): Window;
}

export interface PaneContentFocusRequest {
	readonly generation: symbol;
	readonly focusRevision: number;
	readonly requestedAt: number;
}

const requests = new WeakMap<object, PaneContentFocusRequest>();

/** Retains one exact content-focus capability across a late React mount. */
export function beginPaneContentFocus(
	handle: PaneContentFocusHandle,
): PaneContentFocusRequest {
	installTerminalRecoveryFocusTracking(handle.getWindow().document);
	const request = {
		generation: Symbol("pane-content-focus"),
		focusRevision: terminalRecoveryFocusTracker.snapshot(),
		requestedAt: performance.now(),
	};
	requests.set(handle, request);
	return request;
}

export function currentPaneContentFocus(
	handle: PaneContentFocusHandle,
): PaneContentFocusRequest | undefined {
	return requests.get(handle);
}

/**
 * Dockview may focus its exact group element when the pane component has not
 * mounted yet. Advance only across that expected focus event; an outside input
 * remains a newer owner and invalidates the request.
 */
export function settlePaneContentFocus(
	handle: PaneContentFocusHandle,
	expected: PaneContentFocusRequest,
): void {
	if (requests.get(handle) !== expected) return;
	const ownerDocument = handle.getWindow().document;
	if (ownerDocument.activeElement !== handle.group.element) return;
	requests.set(handle, {
		generation: expected.generation,
		focusRevision: terminalRecoveryFocusTracker.snapshot(),
		requestedAt: expected.requestedAt,
	});
}

export function consumePaneContentFocus(
	handle: PaneContentFocusHandle,
	expected: PaneContentFocusRequest,
): boolean {
	if (requests.get(handle) !== expected) return false;
	requests.delete(handle);
	return true;
}

export function cancelPaneContentFocus(
	handle: PaneContentFocusHandle,
	expected?: PaneContentFocusRequest,
): void {
	if (expected !== undefined && requests.get(handle) !== expected) return;
	requests.delete(handle);
}
