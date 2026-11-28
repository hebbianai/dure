import { describe, expect, it } from "vitest";
import { rowSnappedHeight } from "@/lib/ui/rowSnappedHeight";

describe("rowSnappedHeight", () => {
	it("ends a capped list on the last row that fits whole", () => {
		// Rows of different heights: 50, 66, 50, 50.
		const bottoms = [50, 116, 166, 216];
		expect(rowSnappedHeight(bottoms, 200)).toBe(166);
		expect(rowSnappedHeight(bottoms, 166)).toBe(166);
		expect(rowSnappedHeight(bottoms, 140)).toBe(116);
	});

	it("leaves a list that fits at its natural height", () => {
		expect(rowSnappedHeight([50, 116], 200)).toBeUndefined();
		expect(rowSnappedHeight([50, 116.4], 116)).toBeUndefined();
		expect(rowSnappedHeight([], 200)).toBeUndefined();
		expect(rowSnappedHeight([50, 116], Number.NaN)).toBeUndefined();
	});

	it("keeps the cap when not even the first row fits", () => {
		expect(rowSnappedHeight([80, 160], 60)).toBe(60);
	});
});
