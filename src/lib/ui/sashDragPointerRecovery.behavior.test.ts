// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	beginTerminalDocumentResize,
	subscribeTerminalDocumentResizeLifecycle,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import {
	installSashDragHighlight,
	isSashDragActive,
} from "@/lib/ui/sashDragHighlight";
import { createDockviewGridRow } from "@/test/dockviewGridRow";

function pointerEvent(
	type: string,
	clientX = 0,
	buttons = type === "pointerdown" || type === "pointermove" ? 1 : 0,
): Event {
	const event = new MouseEvent(type, {
		bubbles: true,
		button: 0,
		buttons,
		clientX,
	});
	Object.defineProperty(event, "pointerId", { value: 17 });
	return event;
}

describe("Dockview sash pointer recovery", () => {
	it("adopts a legacy live transaction without a second begin or capture", () => {
		const isolated = document.implementation.createHTMLDocument();
		const begins: number[] = [];
		const stopLifecycle = subscribeTerminalDocumentResizeLifecycle(isolated, {
			begin: (generation) => begins.push(generation),
			settle: vi.fn(),
		});
		const legacyPointerDown = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Element) || !target.closest(".dv-sash")) return;
			(target as HTMLElement).setPointerCapture?.(
				(event as PointerEvent).pointerId,
			);
			beginTerminalDocumentResize(isolated);
		};
		isolated.addEventListener("pointerdown", legacyPointerDown, true);
		Object.defineProperty(isolated, "__dureSashDragHighlightV4", {
			configurable: true,
			value: { installed: true },
		});
		const sash = isolated.createElement("div");
		sash.className = "dv-sash";
		sash.setPointerCapture = vi.fn();
		isolated.body.appendChild(sash);
		installSashDragHighlight(isolated);

		sash.dispatchEvent(pointerEvent("pointerdown"));

		expect(begins).toEqual([1]);
		expect(sash.setPointerCapture).toHaveBeenCalledOnce();
		isolated.dispatchEvent(pointerEvent("pointercancel"));
		isolated.removeEventListener("pointerdown", legacyPointerDown, true);
		stopLifecycle();
		sash.remove();
	});

	it("installs the current guard over a legacy live-document state", () => {
		Object.defineProperty(document, "__dureSashDragHighlightV4", {
			configurable: true,
			value: { installed: true },
		});
		const sash = document.createElement("div");
		sash.className = "dv-sash";
		document.body.appendChild(sash);

		installSashDragHighlight(document);
		sash.dispatchEvent(pointerEvent("pointerdown"));

		expect(isSashDragActive(document)).toBe(true);
		document.dispatchEvent(pointerEvent("pointercancel"));
		expect(isSashDragActive(document)).toBe(false);
		sash.remove();
	});

	it("restores pane hit targets when pointer capture is lost", () => {
		installSashDragHighlight(document);
		const grid = createDockviewGridRow(["left", "right"]);
		const [left, right] = grid.panels;
		const sash = grid.sash();
		const paneHitTargets = [
			left?.group.element.parentElement,
			right?.group.element.parentElement,
		];

		sash.dispatchEvent(pointerEvent("pointerdown"));
		expect(
			paneHitTargets.map((element) => element?.style.pointerEvents),
		).toEqual(["none", "none"]);
		sash.dispatchEvent(new Event("lostpointercapture"));

		expect(
			paneHitTargets.map((element) => element?.style.pointerEvents),
		).toEqual(["", ""]);
		grid.dispose();
	});

	it("cancels Dockview when the pointer returns after an external release", () => {
		installSashDragHighlight(document);
		const grid = createDockviewGridRow(["reentry-left", "reentry-right"]);
		const [left, right] = grid.panels;
		const sash = grid.sash();
		const paneHitTargets = [
			left?.group.element.parentElement,
			right?.group.element.parentElement,
		];
		const initialLeft = sash.style.left;

		sash.dispatchEvent(pointerEvent("pointerdown", 200));
		expect(
			paneHitTargets.map((element) => element?.style.pointerEvents),
		).toEqual(["none", "none"]);
		document.body.dispatchEvent(pointerEvent("pointermove", 260, 0));

		expect(
			paneHitTargets.map((element) => element?.style.pointerEvents),
		).toEqual(["", ""]);
		expect(isSashDragActive(document)).toBe(false);
		expect(sash.style.left).toBe(initialLeft);
		grid.dispose();
	});

	it("ends an active sash before a layout replacement retires its split view", () => {
		installSashDragHighlight(document);
		const grid = createDockviewGridRow(["replace-left", "replace-right"]);
		const { api } = grid;
		const layout = api.toJSON();
		const sash = grid.sash();
		const errors: unknown[] = [];
		const onError = (event: ErrorEvent) => {
			errors.push(event.error ?? event.message);
			event.preventDefault();
		};
		window.addEventListener("error", onError);

		sash.dispatchEvent(pointerEvent("pointerdown", 200));
		api.fromJSON(layout, { reuseExistingPanels: true });
		document.body.dispatchEvent(pointerEvent("pointermove", 260));

		expect(errors).toEqual([]);
		window.removeEventListener("error", onError);
		grid.dispose();
	});
});
