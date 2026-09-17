// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
	beginTerminalDocumentResize,
	subscribeTerminalDocumentResizeLifecycle,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";

function pointerEvent(type: string): Event {
	const event = new MouseEvent(type, { bubbles: true, button: 0 });
	Object.defineProperty(event, "pointerId", { value: 7 });
	return event;
}

it("activates the current sash guard when HMR preserves a legacy document", async () => {
	const begins: number[] = [];
	const stopLifecycle = subscribeTerminalDocumentResizeLifecycle(document, {
		begin: (generation) => begins.push(generation),
		settle: vi.fn(),
	});
	const legacyPointerDown = (event: Event) => {
		const target = event.target;
		if (!(target instanceof Element) || !target.closest(".dv-sash")) return;
		(target as HTMLElement).setPointerCapture?.(
			(event as PointerEvent).pointerId,
		);
		beginTerminalDocumentResize(document);
	};
	document.addEventListener("pointerdown", legacyPointerDown, true);
	Object.defineProperty(document, "__dureSashDragHighlightV4", {
		configurable: true,
		value: { installed: true },
	});
	const sash = document.createElement("div");
	sash.className = "dv-sash";
	sash.setPointerCapture = vi.fn();
	document.body.appendChild(sash);

	vi.resetModules();
	const { isSashDragActive } = await import("@/lib/ui/sashDragHighlight");
	sash.dispatchEvent(pointerEvent("pointerdown"));

	expect(isSashDragActive(document)).toBe(true);
	expect(begins).toEqual([1]);
	expect(sash.setPointerCapture).toHaveBeenCalledOnce();
	const selectionDuringResize = new Event("selectstart", {
		bubbles: true,
		cancelable: true,
	});
	expect(document.body.dispatchEvent(selectionDuringResize)).toBe(false);
	document.dispatchEvent(pointerEvent("pointercancel"));
	const selectionAfterResize = new Event("selectstart", {
		bubbles: true,
		cancelable: true,
	});
	expect(document.body.dispatchEvent(selectionAfterResize)).toBe(true);
	document.removeEventListener("pointerdown", legacyPointerDown, true);
	stopLifecycle();
});
