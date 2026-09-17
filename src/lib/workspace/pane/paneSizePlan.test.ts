import { describe, expect, it } from "vitest";
import {
	inheritorForRemoval,
	planSizesAfterAdd,
	planSizesAfterRemove,
	planSizesAfterSplit,
} from "@/lib/workspace/pane/paneSizePlan";

/** The reported layout: a 1200px row a=700 b=400 c=100 (2026-09-02). */
const ROW = new Map([
	["a", 700],
	["b", 400],
	["c", 100],
]);

const sizeOf = (targets: readonly { id: string; size: number }[], id: string) =>
	targets.find((t) => t.id === id)?.size;

describe("planSizesAfterAdd", () => {
	it("scales existing shares and gives the added pane their average", () => {
		expect(
			planSizesAfterAdd({
				order: ["a", "b", "c", "d"],
				before: ROW,
				addedId: "d",
			}),
		).toEqual([
			{ id: "a", size: 525 },
			{ id: "b", size: 300 },
			{ id: "c", size: 75 },
		]);
	});

	it("allocates the same shares when the new pane precedes its peers", () => {
		expect(
			planSizesAfterAdd({
				order: ["d", "a", "b", "c"],
				before: ROW,
				addedId: "d",
			}),
		).toEqual([
			{ id: "d", size: 300 },
			{ id: "a", size: 525 },
			{ id: "b", size: 300 },
		]);
	});

	it("does not invent sizes for an unknown or missing sibling", () => {
		for (const order of [["a", "unknown", "d"], ["a", "b", "c"], ["d"]]) {
			expect(planSizesAfterAdd({ order, before: ROW, addedId: "d" })).toEqual(
				[],
			);
		}
	});

	it("refuses an invalid requested share", () => {
		for (const preferredAddedSize of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-1,
		]) {
			expect(
				planSizesAfterAdd({
					order: ["a", "b", "c", "d"],
					before: ROW,
					addedId: "d",
					preferredAddedSize,
				}),
			).toEqual([]);
		}
	});
});

describe("planSizesAfterSplit", () => {
	it("takes the new pane's space from the pane that was split", () => {
		const plan = planSizesAfterSplit({
			order: ["a", "d", "b", "c"],
			before: ROW,
			referenceId: "a",
			addedId: "d",
		});
		expect(sizeOf(plan, "a")).toBe(350);
		expect(sizeOf(plan, "d")).toBe(350);
		// The panes the user did not touch keep their size — this is the defect:
		// Distribute equalised them, growing c from 100 to 300 while a shrank.
		expect(sizeOf(plan, "b")).toBe(400);
	});

	it("leaves every untouched pane alone when the split is in the middle", () => {
		const plan = planSizesAfterSplit({
			order: ["a", "b", "d", "c"],
			before: ROW,
			referenceId: "b",
			addedId: "d",
		});
		expect(sizeOf(plan, "a")).toBe(700);
		expect(sizeOf(plan, "b")).toBe(200);
		expect(sizeOf(plan, "d")).toBe(200);
	});

	it("never writes the trailing pane, which absorbs the remainder", () => {
		const plan = planSizesAfterSplit({
			order: ["a", "b", "c", "d"],
			before: ROW,
			referenceId: "c",
			addedId: "d",
		});
		expect(plan.map((t) => t.id)).toEqual(["a", "b", "c"]);
	});

	it("gives an odd pane's extra pixel to the new pane, not back to the reference", () => {
		// Rounding the reference up would make the pair exceed the space they are
		// splitting, and the trailing-pane rule would take the difference off an
		// untouched pane.
		const plan = planSizesAfterSplit({
			order: ["x", "y", "z"],
			before: new Map([
				["x", 101],
				["z", 100],
			]),
			referenceId: "x",
			addedId: "y",
		});
		expect(sizeOf(plan, "x")).toBe(50);
		expect(sizeOf(plan, "y")).toBe(51);
	});

	it("stands down when the layout is not fully known", () => {
		expect(
			planSizesAfterSplit({
				order: ["a", "d", "unknown"],
				before: ROW,
				referenceId: "a",
				addedId: "d",
			}),
		).toEqual([]);
		expect(
			planSizesAfterSplit({
				order: ["ghost", "d"],
				before: ROW,
				referenceId: "ghost",
				addedId: "d",
			}),
		).toEqual([]);
	});
});

describe("planSizesAfterRemove", () => {
	it("hands the closed pane's space to one neighbour", () => {
		const plan = planSizesAfterRemove({
			order: ["a", "c"],
			before: ROW,
			removedId: "b",
			inheritorId: "a",
		});
		expect(sizeOf(plan, "a")).toBe(1100);
		// c is trailing, so it is not written and keeps the remainder — 100.
		expect(plan.map((t) => t.id)).toEqual(["a"]);
	});

	it("keeps every other pane at its size when the last pane closes", () => {
		const plan = planSizesAfterRemove({
			order: ["a", "b"],
			before: ROW,
			removedId: "c",
			inheritorId: "b",
		});
		expect(sizeOf(plan, "a")).toBe(700);
		expect(plan.map((t) => t.id)).toEqual(["a"]);
	});

	it("stands down if the removed pane is still in the order", () => {
		expect(
			planSizesAfterRemove({
				order: ["a", "b", "c"],
				before: ROW,
				removedId: "b",
				inheritorId: "a",
			}),
		).toEqual([]);
	});
});

describe("inheritorForRemoval", () => {
	it("prefers the pane before, so closing undoes the split that opened it", () => {
		expect(inheritorForRemoval(["a", "b", "c"], "b")).toBe("a");
		expect(inheritorForRemoval(["a", "b", "c"], "c")).toBe("b");
	});

	it("uses the next pane when the first one closes", () => {
		expect(inheritorForRemoval(["a", "b", "c"], "a")).toBe("b");
	});

	it("has no inheritor for the last pane standing", () => {
		expect(inheritorForRemoval(["a"], "a")).toBeUndefined();
		expect(inheritorForRemoval(["a", "b"], "zzz")).toBeUndefined();
	});
});
