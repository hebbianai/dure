// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
	beginTerminalDocumentResize,
	finishTerminalDocumentResize,
	type TerminalDocumentResizeFinishCause,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import { installWorkspaceLayoutPersistence } from "./workspaceLayoutPersistence";

function pointerEvent(type: string): Event {
	const event = new MouseEvent(type, { bubbles: true, button: 0 });
	Object.defineProperty(event, "pointerId", { value: 7 });
	return event;
}

type FinishCause =
	| "pointerup"
	| "pointercancel"
	| "lostpointercapture"
	| "blur";

function finishDrag(sash: HTMLElement, cause: FinishCause): void {
	if (cause === "lostpointercapture") {
		sash.dispatchEvent(new Event(cause));
		return;
	}
	if (cause === "blur") {
		window.dispatchEvent(new Event(cause));
		return;
	}
	document.body.dispatchEvent(pointerEvent(cause));
}

function installPreHmrSashListener(doc: Document, view: Window): void {
	Object.defineProperty(doc, "__dureSashDragHighlightV3", {
		configurable: true,
		value: { installed: true, active: false },
	});
	doc.addEventListener(
		"pointerdown",
		(event) => {
			const sash = (event.target as Element | null)?.closest(".dv-sash");
			if (!sash) return;
			beginTerminalDocumentResize(doc);
			let finished = false;
			let cause: TerminalDocumentResizeFinishCause = "pointercancel";
			const release = () => {
				if (finished) return;
				finished = true;
				doc.removeEventListener("pointercancel", release, true);
				sash.removeEventListener("lostpointercapture", cancel);
				view.removeEventListener("blur", cancel);
				finishTerminalDocumentResize(doc, cause);
			};
			const cancel = (event: Event) => {
				cause = event.type === "blur" ? "blur" : "lostpointercapture";
				sash.dispatchEvent(new Event("pointercancel", { bubbles: true }));
				release();
			};
			doc.addEventListener("pointercancel", release, true);
			sash.addEventListener("lostpointercapture", cancel);
			view.addEventListener("blur", cancel);
		},
		true,
	);
}

describe("workspace layout persistence", () => {
	it("commits ordinary non-resize layout changes", () => {
		const layoutListeners = new Set<() => void>();
		const mutationStartListeners = new Set<() => void>();
		const mutationEndListeners = new Set<() => void>();
		const commitOrdinary = vi.fn();
		const stop = installWorkspaceLayoutPersistence({
			document,
			onLayoutChange: (listener) => {
				layoutListeners.add(listener);
				return { dispose: () => layoutListeners.delete(listener) };
			},
			onWillMutateLayout: (listener) => {
				mutationStartListeners.add(listener);
				return { dispose: () => mutationStartListeners.delete(listener) };
			},
			onDidMutateLayout: (listener) => {
				mutationEndListeners.add(listener);
				return { dispose: () => mutationEndListeners.delete(listener) };
			},
			commitOrdinary,
			captureResizeCommit: vi.fn(),
		});

		for (const listener of layoutListeners) listener();
		stop();

		expect(commitOrdinary).toHaveBeenCalledOnce();
	});

	it("commits one final snapshot after a structural mutation", () => {
		const layoutListeners = new Set<() => void>();
		const mutationStartListeners = new Set<() => void>();
		const mutationEndListeners = new Set<() => void>();
		const commitOrdinary = vi.fn();
		const stop = installWorkspaceLayoutPersistence({
			document,
			onLayoutChange: (listener) => {
				layoutListeners.add(listener);
				return { dispose: () => layoutListeners.delete(listener) };
			},
			onWillMutateLayout: (listener) => {
				mutationStartListeners.add(listener);
				return { dispose: () => mutationStartListeners.delete(listener) };
			},
			onDidMutateLayout: (listener) => {
				mutationEndListeners.add(listener);
				return { dispose: () => mutationEndListeners.delete(listener) };
			},
			commitOrdinary,
			captureResizeCommit: vi.fn(),
		});

		for (const listener of mutationStartListeners) listener();
		for (const listener of layoutListeners) listener();
		for (const listener of layoutListeners) listener();
		expect(commitOrdinary).not.toHaveBeenCalled();
		for (const listener of mutationEndListeners) listener();

		stop();
		expect(commitOrdinary).toHaveBeenCalledOnce();
	});

	it.each<FinishCause>([
		"pointerup",
		"pointercancel",
		"lostpointercapture",
		"blur",
	])(
		"serializes no drag moves and commits the final layout once on %s",
		async (cause) => {
			const layoutListeners = new Set<() => void>();
			const commitOrdinary = vi.fn();
			const serialize = vi.fn(() => ({ width: currentWidth }));
			const save = vi.fn();
			let currentWidth = 300;
			let writerFocused = true;
			const captureResizeCommit = vi.fn(() => {
				if (!writerFocused) return undefined;
				return () => save(serialize());
			});
			const stop = installWorkspaceLayoutPersistence({
				document,
				onLayoutChange: (listener) => {
					layoutListeners.add(listener);
					return { dispose: () => layoutListeners.delete(listener) };
				},
				onWillMutateLayout: () => ({ dispose() {} }),
				onDidMutateLayout: () => ({ dispose() {} }),
				commitOrdinary,
				captureResizeCommit,
			});
			const sash = document.createElement("div");
			sash.className = "dv-sash";
			Object.defineProperty(sash, "setPointerCapture", { value: vi.fn() });
			Object.defineProperty(sash, "releasePointerCapture", { value: vi.fn() });
			document.body.appendChild(sash);
			const finalizationEvent =
				cause === "pointerup" ? "pointerup" : "pointercancel";
			const finalizeDockviewLayout = () => {
				currentWidth = 351;
			};
			document.addEventListener(finalizationEvent, finalizeDockviewLayout);

			try {
				sash.dispatchEvent(pointerEvent("pointerdown"));
				for (let move = 0; move < 50; move += 1) {
					currentWidth += 1;
					for (const listener of layoutListeners) listener();
				}
				// Authority is captured while this window is the focused writer. Losing
				// focus at the finish boundary must not discard the geometry just drawn.
				writerFocused = false;
				finishDrag(sash, cause);

				await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
				expect(save).toHaveBeenCalledWith({ width: 351 });
				expect(serialize).toHaveBeenCalledOnce();
				expect(captureResizeCommit).toHaveBeenCalledOnce();
				expect(commitOrdinary).not.toHaveBeenCalled();

				finishDrag(sash, cause);
				await Promise.resolve();
				expect(save).toHaveBeenCalledOnce();
			} finally {
				document.removeEventListener(finalizationEvent, finalizeDockviewLayout);
				stop();
				sash.remove();
			}
		},
	);

	it.each(["lostpointercapture", "blur"] as const)(
		"reads final %s geometry with an already-installed pre-HMR sash listener",
		async (cause) => {
			const frame = document.createElement("iframe");
			document.body.appendChild(frame);
			const doc = frame.contentDocument;
			const view = frame.contentWindow;
			if (!doc || !view) throw new Error("iframe document unavailable");
			installPreHmrSashListener(doc, view);
			const layoutListeners = new Set<() => void>();
			const commitOrdinary = vi.fn();
			let width = 300;
			const serialize = vi.fn(() => ({ width }));
			const save = vi.fn();
			const stop = installWorkspaceLayoutPersistence({
				document: doc,
				onLayoutChange: (listener) => {
					layoutListeners.add(listener);
					return { dispose: () => layoutListeners.delete(listener) };
				},
				onWillMutateLayout: () => ({ dispose() {} }),
				onDidMutateLayout: () => ({ dispose() {} }),
				commitOrdinary,
				captureResizeCommit: () => () => save(serialize()),
			});
			const sash = doc.createElement("div");
			sash.className = "dv-sash";
			doc.body.appendChild(sash);
			doc.addEventListener("pointercancel", () => {
				width = 351;
			});
			let stopped = false;

			try {
				sash.dispatchEvent(pointerEvent("pointerdown"));
				for (let move = 0; move < 50; move += 1) {
					width += 1;
					for (const listener of layoutListeners) listener();
				}
				if (cause === "blur") view.dispatchEvent(new Event("blur"));
				else sash.dispatchEvent(new Event(cause));
				stop();
				stopped = true;

				await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
				expect(save).toHaveBeenCalledWith({ width: 351 });
				expect(serialize).toHaveBeenCalledOnce();
				expect(commitOrdinary).not.toHaveBeenCalled();
			} finally {
				if (!stopped) stop();
				frame.remove();
			}
		},
	);
});
