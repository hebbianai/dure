import { describe, expect, it } from "vitest";
import { terminalViewportFillObservation } from "./terminalViewportFill";

describe("terminalViewportFillObservation", () => {
	it("accepts only the sub-row remainder of an integer terminal grid", () => {
		expect(
			terminalViewportFillObservation({
				containerHeight: 503,
				gridHeight: 493,
				rows: 29,
			}),
		).toMatchObject({ fillsContainer: true, unfilledHeight: 10 });
	});

	it("rejects a stale row grid that leaves a large blank footer", () => {
		expect(
			terminalViewportFillObservation({
				containerHeight: 900,
				gridHeight: 510,
				rows: 30,
			}),
		).toMatchObject({ fillsContainer: false, unfilledHeight: 390 });
	});

	it("includes the terminal block insets in the fitted surface", () => {
		expect(
			terminalViewportFillObservation({
				containerHeight: 511,
				gridHeight: 493,
				blockInsets: 8,
				rows: 29,
			}),
		).toMatchObject({
			fillsContainer: true,
			effectiveGridHeight: 501,
			unfilledHeight: 10,
		});
	});

	it("rejects a grid that overflows and clips the pane", () => {
		expect(
			terminalViewportFillObservation({
				containerHeight: 500,
				gridHeight: 520,
				blockInsets: 8,
				rows: 30,
			}),
		).toMatchObject({ fillsContainer: false, overflowHeight: 28 });
	});

	it("fails closed before the grid is measurable", () => {
		expect(
			terminalViewportFillObservation({
				containerHeight: 500,
				gridHeight: 0,
				rows: 0,
			}).fillsContainer,
		).toBe(false);
	});
});
