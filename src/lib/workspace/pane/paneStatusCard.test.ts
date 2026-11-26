import { describe, expect, it } from "vitest";
import {
	nextPaneStatusCard,
	PANE_STATUS_CARD_THRESHOLDS,
} from "@/lib/workspace/pane/paneStatusCard";

const { enter, leave } = PANE_STATUS_CARD_THRESHOLDS;
const active = (width: number, height: number) => ({
	width,
	height,
	runtimeActive: true,
});

describe("nextPaneStatusCard", () => {
	it("keeps a readable pane live", () => {
		expect(nextPaneStatusCard(false, active(800, 600))).toBe(false);
		expect(nextPaneStatusCard(false, active(enter.width, enter.height))).toBe(
			false,
		);
	});

	it("turns a pane that is too narrow or too short into a card", () => {
		expect(nextPaneStatusCard(false, active(enter.width - 1, 600))).toBe(true);
		expect(nextPaneStatusCard(false, active(800, enter.height - 1))).toBe(true);
	});

	it("needs both sides past the leave line before the live view returns", () => {
		// Between the two lines the pane keeps whichever mode it had.
		const between = active(enter.width + 20, enter.height + 20);
		expect(nextPaneStatusCard(true, between)).toBe(true);
		expect(nextPaneStatusCard(false, between)).toBe(false);
		expect(nextPaneStatusCard(true, active(leave.width, leave.height - 1))).toBe(
			true,
		);
		expect(nextPaneStatusCard(true, active(leave.width - 1, leave.height))).toBe(
			true,
		);
		expect(nextPaneStatusCard(true, active(leave.width, leave.height))).toBe(
			false,
		);
	});

	it("keeps the previous mode for a zero or unmeasured size", () => {
		for (const shown of [true, false]) {
			expect(nextPaneStatusCard(shown, active(0, 0))).toBe(shown);
			expect(nextPaneStatusCard(shown, active(0, 600))).toBe(shown);
			expect(nextPaneStatusCard(shown, active(800, 0))).toBe(shown);
			expect(nextPaneStatusCard(shown, active(Number.NaN, 600))).toBe(shown);
		}
	});

	it("keeps the previous mode while the pane's Space is not on screen", () => {
		for (const shown of [true, false]) {
			expect(
				nextPaneStatusCard(shown, { width: 100, height: 100, runtimeActive: false }),
			).toBe(shown);
			expect(
				nextPaneStatusCard(shown, {
					width: 1600,
					height: 900,
					runtimeActive: false,
				}),
			).toBe(shown);
		}
	});
});
