// @vitest-environment jsdom
//
// Against a real dockview, because the defect is dockview's: `removeView`
// assumes no branch below the root ever holds a single child, so closing the
// last pane inside such a wrapper leaves an empty branch on screen at its full
// size (user report 2026-09-10: the closed session's column stayed blank and
// the neighbours never expanded). The wrapper itself came from our serialized
// removal, which dropped a leaf from a two-child branch without collapsing it.

import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendPanelToLayout,
	pruneEmptyDockviewGroups,
	removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { removePanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";

type Api = ReturnType<typeof createDockview>;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeDockview(width = 2000, height = 1300): Api {
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
	cleanups.push(() => {
		api.dispose();
		container.remove();
	});
	api.layout(width, height);
	return api;
}

const widths = (api: Api) =>
	Object.fromEntries(
		api.panels.map((p) => [p.id, Math.round(p.group.api.width)]),
	);

type Node = { type: string; data: Node[] | { views: string[] }; size?: number };
const shape = (node: Node): string =>
	node.type === "leaf"
		? (node.data as { views: string[] }).views.join("+")
		: `[${(node.data as Node[]).map(shape).join(",")}]`;
const gridShape = (api: Api) =>
	shape((api.toJSON().grid as unknown as { root: Node }).root);

const leaf = (id: string, size: number) => ({
	type: "leaf",
	data: { views: [id], activeView: id, id: `g-${id}` },
	size,
});
const panels = (...ids: string[]) =>
	Object.fromEntries(ids.map((id) => [id, { id, contentComponent: "t" }]));

/** root(H)[ V[a,b] , V[ H[c,d] ] , e ]: the middle column is a wrapper
 *  around a row. Dockview never serializes such a wrapper itself; only this
 *  repository's serialized writers did (pre-fix removal, placeGridPanel's
 *  no-reference root fallback), and fromJSON accepts it as given. */
function wrappedRowLayout() {
	return {
		grid: {
			root: {
				type: "branch",
				data: [
					{ type: "branch", data: [leaf("a", 650), leaf("b", 650)], size: 600 },
					{
						type: "branch",
						data: [
							{
								type: "branch",
								data: [leaf("c", 300), leaf("d", 300)],
								size: 1300,
							},
						],
						size: 600,
					},
					leaf("e", 800),
				],
				size: 1300,
			},
			width: 2000,
			height: 1300,
			orientation: "HORIZONTAL",
		},
		panels: panels("a", "b", "c", "d", "e"),
		activeGroup: "g-c",
	};
}

describe("single-child wrapper branches", () => {
	it("serialized removal collapses the wrapper it would otherwise leave", () => {
		const removed = removePanelIdsFromLayout(
			wrappedRowLayout(),
			new Set(["d"]),
		);
		const api = makeDockview();
		api.fromJSON(removed as never);
		expect(gridShape(api)).toBe("[[a,b],c,e]");
		expect(widths(api)).toEqual({ a: 600, b: 600, c: 600, e: 800 });
	});

	it("closing the last pane of a persisted wrapper hands its space on", () => {
		// The shape a pre-fix removal persisted, as the Workspace restores it.
		const stored = JSON.parse(JSON.stringify(wrappedRowLayout()));
		stored.grid.root.data[1].data[0].data.splice(1, 1);
		delete stored.panels.d;
		const api = makeDockview();
		api.fromJSON(pruneEmptyDockviewGroups(stored) as never);
		expect(widths(api).c).toBe(600);

		removePanePreservingSizes(api, api.getPanel("c")!);

		expect(gridShape(api)).toBe("[[a,b],e]");
		// The closed pane's space goes to the neighbour before it (paneSizePlan).
		expect(widths(api)).toEqual({ a: 1200, b: 1200, e: 800 });
	});

	it("collapses a wrapper around a same-axis row into its parent", () => {
		const stored = {
			grid: {
				root: {
					type: "branch",
					data: [
						leaf("a", 500),
						{
							type: "branch",
							data: [
								{
									type: "branch",
									data: [leaf("b", 300), leaf("c", 900)],
									size: 1300,
								},
							],
							size: 1500,
						},
					],
					size: 1300,
				},
				width: 2000,
				height: 1300,
				orientation: "HORIZONTAL",
			},
			panels: panels("a", "b", "c"),
			activeGroup: "g-a",
		};
		const api = makeDockview();
		api.fromJSON(pruneEmptyDockviewGroups(stored) as never);
		expect(gridShape(api)).toBe("[a,b,c]");
		expect(widths(api)).toEqual({ a: 500, b: 375, c: 1125 });
	});

	it("appending below a lone root pane without a reference leaves no wrapper", () => {
		const single = {
			grid: {
				root: { type: "branch", data: [leaf("a", 1300)], size: 1300 },
				width: 2000,
				height: 1300,
				orientation: "HORIZONTAL",
			},
			panels: panels("a"),
			activeGroup: "g-a",
		};
		const appended = appendPanelToLayout(
			single,
			"b",
			{ id: "b", contentComponent: "t" },
			{ direction: "below" },
		);
		expect(appended).not.toBeNull();
		expect(pruneEmptyDockviewGroups(appended)).toBe(appended);
		const api = makeDockview();
		api.fromJSON(appended as never);
		expect(gridShape(api)).toBe("[a,b]");
		removePanePreservingSizes(api, api.getPanel("a")!);
		expect(gridShape(api)).toBe("[b]");
		expect(Math.round(api.getPanel("b")!.group.api.height)).toBe(1300);
	});
});
