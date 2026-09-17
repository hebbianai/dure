import { describe, expect, it } from "vitest";
import {
	canStartTerminalSelection,
	terminalSelectionMove,
	terminalSelectionScrollDirection,
} from "./terminalSelectionGesture";

const origin = { pointerId: 1, originX: 20, originY: 30, moved: false };
const point = { pointerId: 1, buttons: 1, clientX: 23, clientY: 30 };

describe("terminal selection gesture admission", () => {
	it("admits primary presses but not context menus or touch scrolling", () => {
		expect(canStartTerminalSelection({ button: 0, ctrlKey: false })).toBe(true);
		for (const event of [
			{ button: 1, ctrlKey: false },
			{ button: 2, ctrlKey: false },
			{ button: 0, ctrlKey: true },
			{ button: 0, ctrlKey: false, pointerType: "touch" },
		])
			expect(canStartTerminalSelection(event)).toBe(false);
	});
	it("distinguishes click jitter from intentional drag without dropping an admitted drag", () => {
		expect(terminalSelectionMove(origin, point)).toBe("pending");
		expect(terminalSelectionMove(origin, { ...point, clientX: 26 })).toBe(
			"drag",
		);
		expect(terminalSelectionMove({ ...origin, moved: true }, point)).toBe(
			"drag",
		);
	});
	it("retires released buttons even after a missed pointerup and ignores another pointer", () => {
		expect(
			terminalSelectionMove(
				{ ...origin, moved: true },
				{ ...point, buttons: 0 },
			),
		).toBe("cancel");
		expect(terminalSelectionMove(origin, { ...point, buttons: 2 })).toBe(
			"cancel",
		);
		expect(
			terminalSelectionMove(origin, { ...point, pointerId: 2, buttons: 0 }),
		).toBe("unrelated");
	});
});

describe("selection scroll direction", () => {
	const history = { hasMoreBefore: true, hasMoreAfter: true };
	const bounds = { top: 0, bottom: 100 };
	it("keeps horizontal and inward drags in an edge row local", () => {
		for (const [originY, clientY] of [
			[1, 1],
			[1, 5],
			[99, 99],
			[99, 95],
		]) {
			expect(
				terminalSelectionScrollDirection(
					{ originY, clientY },
					bounds,
					20,
					history,
				),
			).toBe(0);
		}
	});
	it("keeps a local selection area even in a one-row viewport", () => {
		const smallBounds = { top: 0, bottom: 20 };
		for (const clientY of [6, 14]) {
			expect(
				terminalSelectionScrollDirection(
					{ originY: 10, clientY },
					smallBounds,
					20,
					history,
				),
			).toBe(0);
		}
		expect(
			terminalSelectionScrollDirection(
				{ originY: 10, clientY: 1 },
				smallBounds,
				20,
				history,
			),
		).toBe(1);
		expect(
			terminalSelectionScrollDirection(
				{ originY: 10, clientY: 19 },
				smallBounds,
				20,
				history,
			),
		).toBe(-1);
	});
});
