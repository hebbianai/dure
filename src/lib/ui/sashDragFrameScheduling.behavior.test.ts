// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installSashDragHighlight } from "@/lib/ui/sashDragHighlight";
import { createDockviewGridRow } from "@/test/dockviewGridRow";

function pointerEvent(type: string, clientX: number): Event {
	const event = new MouseEvent(type, {
		bubbles: true,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		clientX,
	});
	Object.defineProperty(event, "pointerId", { value: 23 });
	return event;
}

describe("Dockview sash frame scheduling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("projects only the latest move per frame and flushes the final move on release", () => {
		const frames = new Map<number, FrameRequestCallback>();
		let nextFrame = 1;
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			const handle = nextFrame++;
			frames.set(handle, callback);
			return handle;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
			frames.delete(handle);
		});
		installSashDragHighlight(document);

		const layoutWidths: number[] = [];
		const grid = createDockviewGridRow(["frame-left", "frame-right"], {
			onLayout: (width) => layoutWidths.push(width),
		});
		const sash = grid.sash();
		Object.defineProperty(sash, "setPointerCapture", { value: vi.fn() });
		Object.defineProperty(sash, "releasePointerCapture", { value: vi.fn() });
		const initialLeft = Number.parseFloat(sash.style.left);
		layoutWidths.length = 0;

		try {
			sash.dispatchEvent(pointerEvent("pointerdown", 300));
			for (const clientX of [312, 336, 372]) {
				document.body.dispatchEvent(pointerEvent("pointermove", clientX));
			}

			expect(frames).toHaveLength(1);
			expect(layoutWidths).toEqual([]);
			expect(Number.parseFloat(sash.style.left)).toBe(initialLeft);

			const [[frameHandle, frame]] = [...frames];
			frames.delete(frameHandle);
			frame(16);

			expect(layoutWidths).toHaveLength(2);
			expect(Number.parseFloat(sash.style.left)).toBe(initialLeft + 72);

			document.body.dispatchEvent(pointerEvent("pointermove", 396));
			expect(frames).toHaveLength(1);
			expect(layoutWidths).toHaveLength(2);
			document.body.dispatchEvent(pointerEvent("pointerup", 396));

			expect(frames).toHaveLength(0);
			expect(layoutWidths).toHaveLength(4);
			expect(Number.parseFloat(sash.style.left)).toBe(initialLeft + 96);
		} finally {
			grid.dispose();
		}
	});

	it.each(["lostpointercapture", "blur"] as const)(
		"flushes the latest move before Dockview tears down on %s",
		(finishCause) => {
			const frames = new Map<number, FrameRequestCallback>();
			let nextFrame = 1;
			vi.spyOn(window, "requestAnimationFrame").mockImplementation(
				(callback) => {
					const handle = nextFrame++;
					frames.set(handle, callback);
					return handle;
				},
			);
			vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
				frames.delete(handle);
			});
			installSashDragHighlight(document);

			const layoutWidths: number[] = [];
			const grid = createDockviewGridRow(
				[`${finishCause}-left`, `${finishCause}-right`],
				{ onLayout: (width) => layoutWidths.push(width) },
			);
			const sash = grid.sash();
			Object.defineProperty(sash, "setPointerCapture", { value: vi.fn() });
			Object.defineProperty(sash, "releasePointerCapture", { value: vi.fn() });
			const initialLeft = Number.parseFloat(sash.style.left);
			layoutWidths.length = 0;

			try {
				sash.dispatchEvent(pointerEvent("pointerdown", 300));
				document.body.dispatchEvent(pointerEvent("pointermove", 372));
				expect(frames).toHaveLength(1);
				expect(layoutWidths).toEqual([]);

				if (finishCause === "blur") window.dispatchEvent(new Event("blur"));
				else sash.dispatchEvent(new Event(finishCause));

				expect(frames).toHaveLength(0);
				expect(layoutWidths).toHaveLength(2);
				expect(Number.parseFloat(sash.style.left)).toBe(initialLeft + 72);
			} finally {
				grid.dispose();
			}
		},
	);
});
