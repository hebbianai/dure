// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	registerTerminalDocumentResizeSurface,
	terminalDocumentResizePhase,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import {
	installSashDragHighlight,
	isSashDragActive,
} from "@/lib/ui/sashDragHighlight";

function pointerEvent(
	type: string,
	buttons = type === "pointerup" ? 0 : 1,
): Event {
	const event = new MouseEvent(type, {
		bubbles: true,
		button: 0,
		buttons,
	});
	Object.defineProperty(event, "pointerId", { value: 11 });
	return event;
}

describe("document sash transaction", () => {
	afterEach(() => vi.useRealTimers());

	it("starts the final commit after the release event without a correctness timer", async () => {
		vi.useFakeTimers();
		const doc = document.implementation.createHTMLDocument();
		installSashDragHighlight(doc);
		const ownerCommit = vi.fn(async () => true);
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-1",
			sessionKey: "session-1",
			canCommit: () => true,
			commit: ownerCommit,
		});
		const sash = doc.createElement("div");
		sash.className = "dv-sash";
		doc.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		registration.noteGeometryChanged();
		doc.body.dispatchEvent(pointerEvent("pointerup"));
		await Promise.resolve();

		expect(vi.getTimerCount()).toBe(0);
		expect(ownerCommit).toHaveBeenCalledOnce();
		registration.dispose();
	});

	it("commits a dirty session through the current replacement view", async () => {
		vi.useFakeTimers();
		const doc = document.implementation.createHTMLDocument();
		installSashDragHighlight(doc);
		const oldCommit = vi.fn(async () => true);
		const currentCommit = vi.fn(async () => true);
		const oldRegistration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-1",
			sessionKey: "session-1",
			canCommit: () => true,
			commit: oldCommit,
		});
		const sash = doc.createElement("div");
		sash.className = "dv-sash";
		doc.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		oldRegistration.noteGeometryChanged();
		oldRegistration.dispose();
		const currentRegistration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-1",
			sessionKey: "session-1",
			canCommit: () => true,
			commit: currentCommit,
		});
		doc.body.dispatchEvent(pointerEvent("pointerup"));
		await Promise.resolve();
		await Promise.resolve();

		expect(oldCommit).not.toHaveBeenCalled();
		expect(currentCommit).toHaveBeenCalledOnce();
		currentRegistration.dispose();
	});

	it("brackets a sash double-click so its relayout commits at settle", async () => {
		const doc = document.implementation.createHTMLDocument();
		installSashDragHighlight(doc);
		const commit = vi.fn(async () => true);
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-dblclick",
			sessionKey: "session-dblclick",
			canCommit: () => true,
			commit,
		});
		const sash = doc.createElement("div");
		sash.className = "dv-sash";
		doc.body.appendChild(sash);
		// Dockview equalises the panes from its own sash listener; the document
		// transaction must already be open when that relayout dirties a surface.
		const phaseDuringRelayout: string[] = [];
		sash.addEventListener("dblclick", () => {
			phaseDuringRelayout.push(terminalDocumentResizePhase(doc));
			registration.noteGeometryChanged();
		});

		// The double-click's own clicks open and close a zero-move transaction
		// first, exactly as in the browser.
		sash.dispatchEvent(pointerEvent("pointerdown"));
		doc.body.dispatchEvent(pointerEvent("pointerup"));
		sash.dispatchEvent(
			new MouseEvent("dblclick", { bubbles: true, button: 0 }),
		);

		expect(phaseDuringRelayout).toEqual(["dragging"]);
		expect(terminalDocumentResizePhase(doc)).toBe("settling");
		await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
		expect(terminalDocumentResizePhase(doc)).toBe("idle");
		registration.dispose();
	});

	it("starts the blur commit before releasing retained authority", async () => {
		vi.useFakeTimers();
		installSashDragHighlight(document);
		const lifecycle: string[] = [];
		let active = false;
		const registration = registerTerminalDocumentResizeSurface(document, {
			surfaceKey: "surface-blur",
			sessionKey: "session-blur",
			canCommit: () => true,
			commit: () => {
				lifecycle.push("commit-start");
				return true;
			},
			onPhaseChange: (phase) => {
				if (phase === "dragging" && !active) {
					active = true;
					lifecycle.push("retain");
				}
				if (phase === "idle" && active) {
					active = false;
					lifecycle.push("release");
				}
			},
		});
		const sash = document.createElement("div");
		sash.className = "dv-sash";
		document.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		registration.noteGeometryChanged();
		window.dispatchEvent(new Event("blur"));
		await vi.waitFor(() =>
			expect(lifecycle).toEqual(["retain", "commit-start", "release"]),
		);

		expect(lifecycle).toEqual(["retain", "commit-start", "release"]);
		registration.dispose();
		sash.remove();
	});

	it("recovers terminal geometry when a released pointer returns to the WebView", async () => {
		const doc = document.implementation.createHTMLDocument();
		installSashDragHighlight(doc);
		const commit = vi.fn(async () => true);
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-reentry",
			sessionKey: "session-reentry",
			canCommit: () => true,
			commit,
		});
		const sash = doc.createElement("div");
		sash.className = "dv-sash";
		doc.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		registration.noteGeometryChanged();
		expect(terminalDocumentResizePhase(doc)).toBe("dragging");

		// WKWebView can miss the release outside its native boundary. The first
		// hover move back inside is authoritative proof that the button is up.
		doc.body.dispatchEvent(pointerEvent("pointermove", 0));

		await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
		expect(isSashDragActive(doc)).toBe(false);
		expect(terminalDocumentResizePhase(doc)).toBe("idle");
		registration.dispose();
	});
});
