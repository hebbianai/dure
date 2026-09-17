// @vitest-environment jsdom
//
// Against a real dockview, because the defect is in dockview's own sizing:
// `Sizing.Distribute` equalises rather than scaling, so adding a pane grows the
// small panes and shrinks the large ones (user report 2026-09-02: "어떤 pane
// 들은 커지고 어떤 pane 들은 작아지기도 해"). A mocked grid could not show that.

import { createDockview } from "dockview-react";
import { describe, expect, it } from "vitest";
import {
	addPanePreservingSizes,
	removePanePreservingSizes,
} from "@/lib/workspace/pane/paneMutationSizing";
import {
	capturePaneGrid,
	preserveSizesAfterRemove,
	preserveSizesAfterSplit,
} from "@/lib/workspace/pane/panePreservedSizes";

type Api = ReturnType<typeof createDockview>;

function makeDockview(width = 1200, height = 800): Api {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => {
			const element = document.createElement("div");
			return {
				element,
				init() {},
				dispose() {
					element.remove();
				},
			};
		},
	});
	api.layout(width, height);
	return api;
}

const widths = (api: Api) =>
	Object.fromEntries(
		api.panels.map((p) => [p.id, Math.round(p.group.api.width)]),
	);
const heights = (api: Api) =>
	Object.fromEntries(
		api.panels.map((p) => [p.id, Math.round(p.group.api.height)]),
	);
const groupOf = (api: Api, panelId: string) =>
	api.getPanel(panelId)?.group.id ?? "";

/** A deliberately uneven row: a=700 b=400 c=100 across 1200px. */
function unevenRow(): Api {
	const api = makeDockview();
	api.addPanel({ id: "a", component: "t" });
	api.addPanel({
		id: "b",
		component: "t",
		position: { referencePanel: "a", direction: "right" },
	});
	api.addPanel({
		id: "c",
		component: "t",
		position: { referencePanel: "b", direction: "right" },
	});
	api.getPanel("a")?.group.api.setSize({ width: 700 });
	api.getPanel("c")?.group.api.setSize({ width: 100 });
	return api;
}

describe("pane sizes across a split", () => {
	it("takes the new pane's space from the pane that was split", () => {
		const api = unevenRow();
		expect(widths(api)).toEqual({ a: 700, b: 400, c: 100 });
		const before = capturePaneGrid(api);
		const reference = groupOf(api, "a");
		api.addPanel({
			id: "d",
			component: "t",
			position: { referencePanel: "a", direction: "right" },
		});
		preserveSizesAfterSplit(api, before, reference, groupOf(api, "d"));
		expect(widths(api)).toEqual({ a: 350, b: 400, c: 100, d: 350 });
	});

	it("leaves both neighbours alone when the split is in the middle", () => {
		const api = unevenRow();
		const before = capturePaneGrid(api);
		const reference = groupOf(api, "b");
		api.addPanel({
			id: "d",
			component: "t",
			position: { referencePanel: "b", direction: "right" },
		});
		preserveSizesAfterSplit(api, before, reference, groupOf(api, "d"));
		expect(widths(api)).toEqual({ a: 700, b: 200, c: 100, d: 200 });
	});

	it("never grows a pane the user did not touch", () => {
		// The reported symptom, stated directly: before the fix c grew 100 -> 300
		// while a shrank 700 -> 300.
		const api = unevenRow();
		const before = widths(api);
		const snapshot = capturePaneGrid(api);
		const reference = groupOf(api, "a");
		api.addPanel({
			id: "d",
			component: "t",
			position: { referencePanel: "a", direction: "right" },
		});
		preserveSizesAfterSplit(api, snapshot, reference, groupOf(api, "d"));
		const after = widths(api);
		for (const id of ["b", "c"]) {
			expect(after[id], `${id} moved`).toBe(before[id]);
		}
	});

	it("splits a column on its own axis", () => {
		const api = makeDockview();
		api.addPanel({ id: "a", component: "t" });
		api.addPanel({
			id: "b",
			component: "t",
			position: { referencePanel: "a", direction: "below" },
		});
		api.addPanel({
			id: "c",
			component: "t",
			position: { referencePanel: "b", direction: "below" },
		});
		api.getPanel("a")?.group.api.setSize({ height: 500 });
		const before = capturePaneGrid(api);
		const heightsBefore = heights(api);
		const reference = groupOf(api, "a");
		api.addPanel({
			id: "d",
			component: "t",
			position: { referencePanel: "a", direction: "below" },
		});
		preserveSizesAfterSplit(api, before, reference, groupOf(api, "d"));
		const after = heights(api);
		expect(after.a + after.d).toBe(heightsBefore.a);
		expect(after.b).toBe(heightsBefore.b);
		expect(after.c).toBe(heightsBefore.c);
	});

	it("stands down where dockview already keeps the other panes", () => {
		// A split that nests a new branch (opening below a pane in a row) never
		// disturbed its siblings, so the restore must not invent sizes for it.
		const api = makeDockview();
		api.addPanel({ id: "a", component: "t" });
		api.addPanel({
			id: "b",
			component: "t",
			position: { referencePanel: "a", direction: "right" },
		});
		api.getPanel("a")?.group.api.setSize({ width: 800 });
		const before = capturePaneGrid(api);
		const reference = groupOf(api, "b");
		api.addPanel({
			id: "d",
			component: "t",
			position: { referencePanel: "b", direction: "below" },
		});
		preserveSizesAfterSplit(api, before, reference, groupOf(api, "d"));
		expect(widths(api)).toEqual({ a: 800, b: 400, d: 400 });
	});
});

describe("pane sizes across a close", () => {
	it("hands the closed pane's space to one neighbour", () => {
		const api = unevenRow();
		const before = capturePaneGrid(api);
		const removed = groupOf(api, "b");
		api.removePanel(api.getPanel("b") as never);
		preserveSizesAfterRemove(api, before, removed);
		expect(widths(api)).toEqual({ a: 1100, c: 100 });
	});

	it("keeps the far pane at its size when the last pane closes", () => {
		const api = unevenRow();
		const before = capturePaneGrid(api);
		const removed = groupOf(api, "c");
		api.removePanel(api.getPanel("c") as never);
		preserveSizesAfterRemove(api, before, removed);
		expect(widths(api)).toEqual({ a: 700, b: 500 });
	});

	it("gives the first pane's space to the one after it", () => {
		const api = unevenRow();
		const before = capturePaneGrid(api);
		const removed = groupOf(api, "a");
		api.removePanel(api.getPanel("a") as never);
		preserveSizesAfterRemove(api, before, removed);
		expect(widths(api)).toEqual({ b: 1100, c: 100 });
	});

	it("survives closing the only pane", () => {
		const api = makeDockview();
		api.addPanel({ id: "a", component: "t" });
		const before = capturePaneGrid(api);
		const removed = groupOf(api, "a");
		api.removePanel(api.getPanel("a") as never);
		expect(() => preserveSizesAfterRemove(api, before, removed)).not.toThrow();
	});
});

describe("pane sizes across an edge placement", () => {
	// General addition is not an explicit split: keep the existing sibling
	// ratios and allocate a peer-sized share to the new pane.
	it.each(["right", "left"])(
		"preserves sibling ratios when adding at the %s edge",
		(direction) => {
			const api = unevenRow();
			api.getPanel("a")?.group.api.setSize({ width: 600 });
			expect(widths(api)).toEqual({ a: 600, b: 400, c: 200 });
			const added = addPanePreservingSizes(api, {
				id: "d",
				component: "t",
				position: { direction },
			});
			expect(widths(api)).toEqual({ a: 450, b: 300, c: 150, d: 300 });
			removePanePreservingSizes(api, added);
			expect(widths(api)).toEqual(
				direction === "right"
					? { a: 450, b: 300, c: 450 }
					: { a: 750, b: 300, c: 150 },
			);
		},
	);

	it.each(["below", "above"])(
		"preserves a column's proportions when adding %s",
		(direction) => {
			const api = makeDockview(800, 1200);
			api.addPanel({ id: "a", component: "t" });
			api.addPanel({
				id: "b",
				component: "t",
				position: { referencePanel: "a", direction: "below" },
			});
			api.addPanel({
				id: "c",
				component: "t",
				position: { referencePanel: "b", direction: "below" },
			});
			api.getPanel("a")?.group.api.setSize({ height: 600 });
			api.getPanel("b")?.group.api.setSize({ height: 400 });
			expect(heights(api)).toEqual({ a: 600, b: 400, c: 200 });
			addPanePreservingSizes(api, {
				id: "d",
				component: "t",
				position: { direction },
			});
			expect(heights(api)).toEqual({ a: 450, b: 300, c: 150, d: 300 });
		},
	);

	it("adds peers to equal panes without repeatedly halving the edge pane", () => {
		const api = makeDockview();
		api.addPanel({ id: "a", component: "t" });
		api.addPanel({ id: "b", component: "t", position: { direction: "right" } });
		for (const id of ["c", "d"]) {
			addPanePreservingSizes(api, {
				id,
				component: "t",
				position: { direction: "right" },
			});
		}
		expect(widths(api)).toEqual({ a: 300, b: 300, c: 300, d: 300 });
	});

	it("preserves a nested column's internal ratio while scaling its root allocation", () => {
		const api = makeDockview(1200, 800);
		api.addPanel({ id: "a", component: "t" });
		api.addPanel({
			id: "b",
			component: "t",
			position: { referencePanel: "a", direction: "right" },
		});
		api.addPanel({
			id: "c",
			component: "t",
			position: { referencePanel: "b", direction: "below" },
		});
		api.getPanel("a")?.group.api.setSize({ width: 800 });
		api.getPanel("b")?.group.api.setSize({ height: 500 });
		addPanePreservingSizes(api, {
			id: "d",
			component: "t",
			position: { direction: "right" },
		});
		const result = widths(api);
		expect(Math.abs(result.a / result.b - 2)).toBeLessThan(0.02);
		expect(result.b).toBe(result.c);
		expect(result.d).toBeCloseTo(400, 0);
		expect(heights(api)).toEqual({ a: 800, b: 500, c: 300, d: 800 });
	});

	it("honours a requested right-rail width instead of averaging sibling count", () => {
		const api = unevenRow();
		api.getPanel("a")?.group.api.setSize({ width: 600 });
		expect(widths(api)).toEqual({ a: 600, b: 400, c: 200 });
		addPanePreservingSizes(api, {
			id: "d",
			component: "t",
			initialWidth: 432,
			position: { direction: "right" },
		});
		expect(widths(api)).toEqual({ a: 384, b: 256, c: 128, d: 432 });
	});

	it("wraps a vertical layout with one full-height right rail", () => {
		const api = makeDockview(1600, 800);
		api.addPanel({ id: "a", component: "t" });
		api.addPanel({
			id: "b",
			component: "t",
			position: { referencePanel: "a", direction: "below" },
		});
		api.getPanel("a")?.group.api.setSize({ height: 500 });
		addPanePreservingSizes(api, {
			id: "d",
			component: "t",
			initialWidth: 576,
			position: { direction: "right" },
		});
		expect(widths(api)).toEqual({ a: 1024, b: 1024, d: 576 });
		expect(heights(api)).toEqual({ a: 500, b: 300, d: 800 });
	});

	it("keeps explicit splits local to the referenced pane", () => {
		const api = unevenRow();
		addPanePreservingSizes(api, {
			id: "d",
			component: "t",
			position: { referencePanel: "a", direction: "right" },
		});
		expect(widths(api)).toEqual({ a: 350, b: 400, c: 100, d: 350 });
	});

	it("does not redistribute when adding a tab to an existing group", () => {
		const api = unevenRow();
		addPanePreservingSizes(api, {
			id: "d",
			component: "t",
			position: { referencePanel: "b", direction: "within" },
		});
		expect(widths(api)).toEqual({ a: 700, b: 400, c: 100, d: 400 });
	});

	it("respects Dockview minimum sizes when exact proportions cannot fit", () => {
		const api = unevenRow();
		addPanePreservingSizes(api, {
			id: "d",
			component: "t",
			position: { direction: "right" },
		});
		const result = widths(api);
		for (const width of Object.values(result))
			expect(width).toBeGreaterThanOrEqual(100);
		expect(Object.values(result).reduce((sum, width) => sum + width, 0)).toBe(
			1200,
		);
		expect(result.a).toBeGreaterThan(result.b);
		expect(result.b).toBeGreaterThan(result.c);
	});
});
