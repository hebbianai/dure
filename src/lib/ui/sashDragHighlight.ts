// pane 분할선(sash) 드래그 하이라이트 (사용자 요청) — dockview는 드래그 중
// 상태 클래스를 붙이지 않아 CSS :active만으로는 포인터가 선을 벗어나는 순간
// 하이라이트가 꺼진다. 전역 캡처 리스너로 드래그 수명 동안 클래스를 유지한다.
// 창(웹뷰)마다 문서가 다르므로 문서 단위로 1회 설치한다.

import {
	beginTerminalDocumentResize,
	finishTerminalDocumentResize,
	subscribeTerminalDocumentResizeLifecycle,
	type TerminalDocumentResizeFinishCause,
	type TerminalDocumentResizeLifecycleListener,
	terminalDocumentResizePhase,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";

const DRAGGING_CLASS = "dv-sash-dragging";
const HIGHLIGHT_STATE_PROPERTY = "__dureSashDragHighlightV5";
const PROJECTED_MOVE_PROPERTY = "__dureSashProjectedMoveV1";
export type SashDragTransactionListener =
	TerminalDocumentResizeLifecycleListener;
interface SashDragHighlightState {
	installed: boolean;
	active: boolean;
}
type SashDragHighlightDocument = Document & {
	[HIGHLIGHT_STATE_PROPERTY]?: SashDragHighlightState;
};
type ProjectedPointerMove = Event & {
	[PROJECTED_MOVE_PROPERTY]?: true;
};

function projectPointerMove(doc: Document, source: PointerEvent): Event {
	const view = doc.defaultView;
	const init: PointerEventInit = {
		bubbles: true,
		cancelable: true,
		composed: true,
		clientX: source.clientX,
		clientY: source.clientY,
		screenX: source.screenX,
		screenY: source.screenY,
		button: source.button,
		buttons: source.buttons,
		ctrlKey: source.ctrlKey,
		shiftKey: source.shiftKey,
		altKey: source.altKey,
		metaKey: source.metaKey,
		pointerId: source.pointerId,
		pointerType: source.pointerType || "mouse",
		isPrimary: source.isPrimary,
		width: source.width,
		height: source.height,
		pressure: source.pressure,
		tangentialPressure: source.tangentialPressure,
		tiltX: source.tiltX,
		tiltY: source.tiltY,
		twist: source.twist,
	};
	const PointerEventConstructor = view?.PointerEvent ?? globalThis.PointerEvent;
	let projected: Event;
	if (typeof PointerEventConstructor === "function") {
		projected = new PointerEventConstructor("pointermove", init);
	} else {
		const MouseEventConstructor = view?.MouseEvent ?? globalThis.MouseEvent;
		projected = new MouseEventConstructor("pointermove", init);
		Object.defineProperty(projected, "pointerId", {
			value: source.pointerId,
		});
	}
	Object.defineProperty(projected, PROJECTED_MOVE_PROPERTY, { value: true });
	return projected;
}

function isProjectedPointerMove(event: Event): boolean {
	return (event as ProjectedPointerMove)[PROJECTED_MOVE_PROPERTY] === true;
}

function highlightStateFor(doc: Document): SashDragHighlightState {
	const highlightDocument = doc as SashDragHighlightDocument;
	let state = highlightDocument[HIGHLIGHT_STATE_PROPERTY];
	if (!state) {
		state = { installed: false, active: false };
		Object.defineProperty(highlightDocument, HIGHLIGHT_STATE_PROPERTY, {
			configurable: true,
			value: state,
		});
	}
	return state;
}

export function isSashDragActive(doc: Document = document): boolean {
	return highlightStateFor(doc).active;
}

export function subscribeSashDragTransaction(
	doc: Document,
	listener: SashDragTransactionListener,
): () => void {
	installSashDragHighlight(doc);
	return subscribeTerminalDocumentResizeLifecycle(doc, listener);
}

export function installSashDragHighlight(doc: Document = document): void {
	const highlight = highlightStateFor(doc);
	if (highlight.installed) return;
	highlight.installed = true;
	let cancelActiveDrag: (() => void) | undefined;
	// WKWebView does not synthesise a `dblclick` on an element that took pointer
	// capture during its presses (we capture the sash to keep drags alive across
	// the native window edge), so the vendor patch's equalise gesture never fires
	// there. Detect the second press on the same sash from the pointer stream we
	// already own and dispatch the `dblclick` ourselves. A native `dblclick`, on
	// engines that do emit one, only re-equalises an already-even pair — a no-op.
	const DOUBLE_PRESS_WINDOW_MS = 500;
	const DOUBLE_PRESS_SLOP_PX = 4;
	// The press target is reliably the sash (that is where the pointer went
	// down); the release target is not, since pointer capture retargets it.
	// So recognise the pair on pointerdown and fire once the release lands.
	let lastSashPress: { sash: Element; at: number; x: number; y: number } | null =
		null;
	let pendingEqualizeSash: Element | null = null;
	doc.addEventListener(
		"pointerdown",
		(event) => {
			if (event.button !== 0) return;
			const target = event.target;
			const sash =
				target instanceof Element ? target.closest(".dv-sash") : null;
			if (!sash) {
				lastSashPress = null;
				pendingEqualizeSash = null;
				return;
			}
			const now = event.timeStamp || Date.now();
			const previous = lastSashPress;
			if (
				previous &&
				previous.sash === sash &&
				now - previous.at <= DOUBLE_PRESS_WINDOW_MS &&
				Math.abs(event.clientX - previous.x) <= DOUBLE_PRESS_SLOP_PX &&
				Math.abs(event.clientY - previous.y) <= DOUBLE_PRESS_SLOP_PX
			) {
				lastSashPress = null;
				pendingEqualizeSash = sash;
				return;
			}
			lastSashPress = { sash, at: now, x: event.clientX, y: event.clientY };
		},
		true,
	);
	doc.addEventListener(
		"pointerup",
		(event) => {
			if (event.button !== 0 || pendingEqualizeSash === null) return;
			const sash = pendingEqualizeSash;
			pendingEqualizeSash = null;
			// Let this click's own resize transaction settle before the equalise so
			// its bracketing (below) opens a clean transaction of its own, matching
			// how a native dblclick would arrive after the release completes.
			const dispatchDoubleClick = () => {
				if (!sash.isConnected) return;
				sash.dispatchEvent(
					new MouseEvent("dblclick", { bubbles: true, button: 0 }),
				);
			};
			const view = doc.defaultView;
			if (view && typeof view.setTimeout === "function") {
				view.setTimeout(dispatchDoubleClick, 0);
			} else {
				dispatchDoubleClick();
			}
		},
		true,
	);
	// A sash double-click equalises its two panes inside Dockview (vendor
	// patch) after the click's own transaction has already finished. Bracket
	// that relayout in the same document transaction as a drag so terminal
	// geometry and layout persistence commit at settle instead of racing a
	// still-settling predecessor.
	let doubleClickGeneration: number | undefined;
	doc.addEventListener(
		"dblclick",
		(event) => {
			if (event.button !== 0) return;
			const target = event.target;
			if (!(target instanceof Element) || !target.closest(".dv-sash")) return;
			if (terminalDocumentResizePhase(doc) === "dragging") return;
			doubleClickGeneration = beginTerminalDocumentResize(doc);
		},
		true,
	);
	doc.addEventListener("dblclick", () => {
		if (doubleClickGeneration === undefined) return;
		const generation = doubleClickGeneration;
		doubleClickGeneration = undefined;
		finishTerminalDocumentResize(doc, "dblclick", generation);
	});
	doc.addEventListener(
		"pointerdown",
		(event) => {
			if (event.button !== 0) return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			const sash = target.closest(".dv-sash");
			if (!sash) return;
			// Dockview 7 listens on the document during a grid-sash drag but does
			// not capture the pointer. WKWebView can therefore lose the release at
			// a native-window boundary and leave both its listeners and disabled
			// pane hit targets behind. End any leaked predecessor before tracking
			// the new gesture, then keep this pointer routed through the sash.
			cancelActiveDrag?.();
			sash.classList.add(DRAGGING_CLASS);
			highlight.active = true;
			const inheritedTransaction =
				terminalDocumentResizePhase(doc) === "dragging";
			const sashContainer = sash.parentElement;
			const sashIndex = sashContainer
				? Array.from(sashContainer.children).indexOf(sash)
				: -1;
			const sashCount = sashContainer?.childElementCount ?? 0;
			const pointerId = event.pointerId;
			const preventSelection = (selectionEvent: Event) => {
				selectionEvent.preventDefault();
			};
			let pendingMove: Event | undefined;
			let pendingFrame: number | undefined;
			let pendingMicrotask = false;
			let captured = false;
			if (
				!inheritedTransaction &&
				typeof sash.setPointerCapture === "function"
			) {
				try {
					sash.setPointerCapture(pointerId);
					captured = true;
				} catch {
					// Pointer capture is a resilience aid. Dockview's document listeners
					// remain the fallback when a browser refuses it.
				}
			}
			let finished = false;
			let forcedFinishCause: TerminalDocumentResizeFinishCause | undefined;
			const cancelPendingFrame = () => {
				const view = doc.defaultView;
				if (pendingFrame !== undefined && view) {
					view.cancelAnimationFrame(pendingFrame);
				}
				pendingFrame = undefined;
			};
			const flushPendingMove = () => {
				cancelPendingFrame();
				pendingMicrotask = false;
				const projected = pendingMove;
				pendingMove = undefined;
				if (!projected || finished || !sash.isConnected) return;
				sash.dispatchEvent(projected);
			};
			const schedulePendingMove = () => {
				if (pendingFrame !== undefined || pendingMicrotask) return;
				const view = doc.defaultView;
				if (view && typeof view.requestAnimationFrame === "function") {
					pendingFrame = view.requestAnimationFrame(() => {
						pendingFrame = undefined;
						flushPendingMove();
					});
					return;
				}
				pendingMicrotask = true;
				Promise.resolve().then(() => {
					if (!pendingMicrotask) return;
					flushPendingMove();
				});
			};
			const cancelRetiredTopology = () => {
				if (
					sash.isConnected &&
					sashContainer?.isConnected &&
					sashContainer.childElementCount === sashCount &&
					sashContainer.children.item(sashIndex) === sash
				) {
					return;
				}
				// Dockview captures its split-view array at pointerdown. A layout
				// replacement retires that array, so finish its document listeners
				// before the original pointermove reaches them.
				doc.dispatchEvent(new Event("pointercancel"));
			};
			let cancel: (event?: Event) => void;
			const projectLatestMove = (event: PointerEvent) => {
				if (isProjectedPointerMove(event) || event.pointerId !== pointerId)
					return;
				// WKWebView can drop pointerup outside its native boundary. A re-entry
				// move with the primary-button bit clear is the missing release itself.
				if ((event.buttons & 1) === 0) {
					event.stopImmediatePropagation();
					cancel(event);
					return;
				}
				pendingMove = projectPointerMove(doc, event);
				event.stopImmediatePropagation();
				schedulePendingMove();
			};
			const release = (event?: Event) => {
				if (finished) return;
				// Pointerup can arrive before the scheduled paint. Apply the latest
				// coordinate first so Dockview saves and publishes exact final geometry.
				flushPendingMove();
				finished = true;
				const cause =
					forcedFinishCause ??
					(event?.type === "pointercancel"
						? "pointercancel"
						: event?.type === "contextmenu"
							? "contextmenu"
							: "pointerup");
				sash.classList.remove(DRAGGING_CLASS);
				doc.removeEventListener("pointerup", release, true);
				doc.removeEventListener("pointercancel", release, true);
				doc.removeEventListener("contextmenu", release, true);
				doc.removeEventListener("pointermove", cancelRetiredTopology, true);
				doc.removeEventListener("pointermove", projectLatestMove, true);
				doc.removeEventListener("selectstart", preventSelection, true);
				sash.removeEventListener("lostpointercapture", cancel);
				doc.defaultView?.removeEventListener("blur", cancel);
				if (captured && typeof sash.releasePointerCapture === "function") {
					try {
						sash.releasePointerCapture(pointerId);
					} catch {
						// The browser may have released it before delivering the event.
					}
				}
				if (cancelActiveDrag === cancel) {
					cancelActiveDrag = undefined;
					highlight.active = false;
				}
				finishTerminalDocumentResize(doc, cause);
			};
			cancel = (event?: Event) => {
				if (finished) return;
				forcedFinishCause =
					event?.type === "blur"
						? "blur"
						: event?.type === "pointermove"
							? "pointercancel"
							: "lostpointercapture";
				// Dockview removes its document move listener on pointercancel. Project
				// the last unpainted coordinate while that consumer is still alive.
				flushPendingMove();
				// Dockview's private end callback restores pane pointer events, saves
				// proportions, and removes its document listeners on pointercancel. Let
				// that callback finish before resize-settle observers snapshot the layout.
				doc.removeEventListener("pointercancel", release, true);
				sash.dispatchEvent(new Event("pointercancel", { bubbles: true }));
				release();
			};
			cancelActiveDrag = cancel;
			// Pointer capture and text selection are separate browser lifecycles.
			// If WKWebView refuses or loses capture, a move over a selectable pane
			// can otherwise start native selection and take the gesture from Dockview.
			// This gesture owner suppresses only new selection starts and releases the
			// suppression through the same pointerup/cancel/blur cleanup path.
			doc.addEventListener("selectstart", preventSelection, true);
			doc.addEventListener("pointermove", cancelRetiredTopology, true);
			// Dockview 7 performs a complete split-tree layout synchronously for
			// every native move. Project only the latest coordinate immediately
			// before paint: the sash still follows the pointer at display cadence,
			// while pane layout cannot backlog faster than the screen can show it.
			doc.addEventListener("pointermove", projectLatestMove, true);
			doc.addEventListener("pointerup", release, true);
			doc.addEventListener("pointercancel", release, true);
			doc.addEventListener("contextmenu", release, true);
			sash.addEventListener("lostpointercapture", cancel);
			doc.defaultView?.addEventListener("blur", cancel);
			if (!inheritedTransaction) beginTerminalDocumentResize(doc);
		},
		true,
	);
}

// Fast Refresh preserves the Document and Dockview instance, so module
// evaluation must upgrade an older listener without waiting for onReady again.
if (typeof document !== "undefined") installSashDragHighlight(document);
