import type { DockviewApi } from "dockview-react";

const FLOATING_OVERLAY_SELECTOR = ".dv-resize-container";
const FLOATING_TITLEBAR_SELECTOR = ".dv-floating-titlebar";
const PANE_CHROME_SELECTOR = ".pane-chrome";
const TAB_SELECTOR = ".dv-tab";
const INTERACTIVE_SELECTOR = [
	"button",
	"a",
	"input",
	"textarea",
	"select",
	"[contenteditable]:not([contenteditable='false'])",
	"[role='button']",
	"[role='menuitem']",
	"[data-pane-drag-ignore]",
].join(",");

function isPrimaryDragStart(event: PointerEvent): boolean {
	return event.button === 0 && event.isPrimary !== false;
}

function proxyPointerDown(
	source: PointerEvent,
	target: HTMLElement,
): PointerEvent {
	const init: PointerEventInit = {
		bubbles: true,
		cancelable: true,
		composed: true,
		button: source.button,
		buttons: source.buttons,
		clientX: source.clientX,
		clientY: source.clientY,
		screenX: source.screenX,
		screenY: source.screenY,
		ctrlKey: source.ctrlKey,
		shiftKey: source.shiftKey,
		altKey: source.altKey,
		metaKey: source.metaKey,
		pointerId: source.pointerId,
		pointerType: source.pointerType,
		isPrimary: source.isPrimary,
		width: source.width,
		height: source.height,
		pressure: source.pressure,
		tangentialPressure: source.tangentialPressure,
		tiltX: source.tiltX,
		tiltY: source.tiltY,
		twist: source.twist,
	};
	const PointerEventConstructor =
		target.ownerDocument.defaultView?.PointerEvent;
	if (PointerEventConstructor) {
		return new PointerEventConstructor("pointerdown", init);
	}
	const fallback = new MouseEvent("pointerdown", init) as PointerEvent;
	Object.defineProperties(fallback, {
		isPrimary: { value: source.isPrimary },
		pointerId: { value: source.pointerId },
		pointerType: { value: source.pointerType },
	});
	return fallback;
}

/**
 * Makes the rendered PaneChrome and Dockview's blank floating titlebar share
 * one move gesture. Dockview remains the sole bounds/clamping/serialization
 * authority; this bridge only routes pointer ownership before native HTML5
 * drag can consume the first WKWebView gesture.
 */
export function installFloatingPaneHeaderDrag(
	container: HTMLElement,
	api: Pick<DockviewApi, "groups">,
): () => void {
	const view = container.ownerDocument.defaultView ?? window;
	const suspendedDragSources = new Map<HTMLElement, boolean>();
	let activePointerId: number | undefined;

	const restoreDragSources = () => {
		for (const [element, draggable] of suspendedDragSources) {
			element.draggable = draggable;
		}
		suspendedDragSources.clear();
		activePointerId = undefined;
	};
	const suspendDragSource = (element: HTMLElement, pointerId: number) => {
		if (activePointerId !== undefined && activePointerId !== pointerId) {
			restoreDragSources();
		}
		activePointerId = pointerId;
		if (!suspendedDragSources.has(element)) {
			suspendedDragSources.set(element, element.draggable);
			element.draggable = false;
		}
	};
	const finishPointer = (event: PointerEvent) => {
		if (activePointerId === undefined || event.pointerId !== activePointerId) {
			return;
		}
		restoreDragSources();
	};
	const onPointerDown = (event: PointerEvent) => {
		if (!isPrimaryDragStart(event)) return;
		const target = event.target instanceof Element ? event.target : null;
		if (!target) return;

		const titlebar = target.closest<HTMLElement>(FLOATING_TITLEBAR_SELECTOR);
		if (titlebar) {
			if (!event.shiftKey && container.contains(titlebar)) {
				suspendDragSource(titlebar, event.pointerId);
			}
			return;
		}

		const chrome = target.closest<HTMLElement>(PANE_CHROME_SELECTOR);
		const overlay = chrome?.closest<HTMLElement>(FLOATING_OVERLAY_SELECTOR);
		if (!chrome || !overlay || !container.contains(overlay)) return;
		if (target.closest(INTERACTIVE_SELECTOR)) return;
		const groupElement = chrome.closest<HTMLElement>(".dv-groupview");
		const activateSourceGroup = () =>
			api.groups
				.find((group) => group.element === groupElement)
				?.api.setActive();

		// Shift keeps Dockview's explicit tab redock gesture. Let pointerdown reach
		// the draggable tab, then stop its bubble at the source group so the outer
		// overlay's shift+content move listener cannot run alongside the redock.
		if (event.shiftKey) {
			activateSourceGroup();
			if (groupElement) {
				const stopOverlayMove = (bubbleEvent: PointerEvent) => {
					if (bubbleEvent === event) bubbleEvent.stopPropagation();
				};
				groupElement.addEventListener("pointerdown", stopOverlayMove);
				queueMicrotask(() =>
					groupElement.removeEventListener("pointerdown", stopOverlayMove),
				);
			}
			return;
		}

		const moveHandle = overlay.querySelector<HTMLElement>(
			FLOATING_TITLEBAR_SELECTOR,
		);
		if (!moveHandle) return;
		const tab = chrome.closest<HTMLElement>(TAB_SELECTOR);
		if (tab) suspendDragSource(tab, event.pointerId);
		event.preventDefault();
		event.stopPropagation();
		moveHandle.dispatchEvent(proxyPointerDown(event, moveHandle));
		// The titlebar activates its anchor group. A multi-group floating window
		// may have been grabbed from a different visible PaneChrome, so restore
		// the group the user actually touched after the proxy dispatch returns.
		activateSourceGroup();
	};

	container.addEventListener("pointerdown", onPointerDown, true);
	view.addEventListener("pointerup", finishPointer);
	view.addEventListener("pointercancel", finishPointer);
	view.addEventListener("blur", restoreDragSources);
	return () => {
		container.removeEventListener("pointerdown", onPointerDown, true);
		view.removeEventListener("pointerup", finishPointer);
		view.removeEventListener("pointercancel", finishPointer);
		view.removeEventListener("blur", restoreDragSources);
		restoreDragSources();
	};
}
