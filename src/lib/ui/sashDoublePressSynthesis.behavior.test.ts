// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installSashDragHighlight } from "@/lib/ui/sashDragHighlight";
import { createDockviewGridRow } from "@/test/dockviewGridRow";

// WKWebView does not emit a native `dblclick` after the sash took pointer
// capture during its presses. sashDragHighlight must recover the equalise
// gesture from the pointer stream. These tests drive only pointer events —
// never a synthesised MouseEvent("dblclick") — so a regression here means the
// gesture is dead on WebKit even though the vendor patch is correct.

function pointer(type: string, x: number, y = 300): PointerEvent {
	const event = new MouseEvent(type, {
		bubbles: true,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		clientX: x,
		clientY: y,
	}) as unknown as PointerEvent;
	Object.defineProperty(event, "pointerId", { value: 7 });
	return event;
}

function press(sash: HTMLElement, x: number, y = 300): void {
	sash.dispatchEvent(pointer("pointerdown", x, y));
	document.body.dispatchEvent(pointer("pointerup", x, y));
}

describe("sash double-press synthesises the equalise on WebKit", () => {
	afterEach(() => vi.useRealTimers());

	it("equalises the touching panes from two rapid presses without a native dblclick", () => {
		vi.useFakeTimers();
		installSashDragHighlight(document);
		const grid = createDockviewGridRow(["left", "right"]);
		try {
			const left = grid.panels[0];
			left?.group.api.setSize({ width: 450 });
			expect(grid.widths()).toEqual([450, 150]);
			const sash = grid.sash();
			const bounds = sash.getBoundingClientRect();
			const x = bounds.left + bounds.width / 2 || 300;

			press(sash, x);
			press(sash, x);
			vi.runAllTimers();

			expect(grid.widths()).toEqual([300, 300]);
		} finally {
			grid.dispose();
		}
	});

	it("does not equalise on a single press", () => {
		vi.useFakeTimers();
		installSashDragHighlight(document);
		const grid = createDockviewGridRow(["left", "right"]);
		try {
			grid.panels[0]?.group.api.setSize({ width: 450 });
			const sash = grid.sash();
			const bounds = sash.getBoundingClientRect();
			const x = bounds.left + bounds.width / 2 || 300;

			press(sash, x);
			vi.runAllTimers();

			expect(grid.widths()).toEqual([450, 150]);
		} finally {
			grid.dispose();
		}
	});

	it("does not equalise when the two presses are far apart in time", () => {
		vi.useFakeTimers();
		installSashDragHighlight(document);
		const grid = createDockviewGridRow(["left", "right"]);
		try {
			grid.panels[0]?.group.api.setSize({ width: 450 });
			const sash = grid.sash();
			const bounds = sash.getBoundingClientRect();
			const x = bounds.left + bounds.width / 2 || 300;

			press(sash, x);
			vi.advanceTimersByTime(800);
			press(sash, x);
			vi.runAllTimers();

			expect(grid.widths()).toEqual([450, 150]);
		} finally {
			grid.dispose();
		}
	});
});
