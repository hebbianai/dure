// @vitest-environment jsdom

import {
	createDockview,
	Orientation,
	type SerializedDockview,
} from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	addPanePreservingSizes,
	removePanePreservingSizes,
} from "@/lib/workspace/pane/paneMutationSizing";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function nestedGrid(
	vertical: boolean,
	widths = [320, 320, 320, 320, 320],
	trailing = 0,
) {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("textarea"),
			init() {},
		}),
	});
	cleanups.push(() => {
		api.dispose();
		container.remove();
	});
	const panels: SerializedDockview["panels"] = {};
	const column = (size: number, index: number) => ({
		type: "branch" as const,
		size,
		data: [400, 280, 160].map((height, row) => {
			const id = `pane-${index}-${row}`;
			panels[id] = { id, contentComponent: "fixture", title: id };
			return {
				type: "leaf" as const,
				size: height,
				data: { id: `group-${index}-${row}`, views: [id], activeView: id },
			};
		}),
	});
	const columns = widths.map(column);
	// The first four columns share one root allocation, with two intervening
	// branches. Sizing its first leaf reaches the wrong same-axis splitview.
	const data: SerializedDockview["grid"]["root"]["data"] = [
		{
			type: "branch",
			size: widths.slice(0, 4).reduce((sum, width) => sum + width, 0),
			data: [{ type: "branch", size: 840, data: columns.slice(0, 4) }],
		},
		columns[4],
	];
	if (trailing) {
		panels.trailing = { id: "trailing", contentComponent: "fixture" };
		data.push({
			type: "leaf",
			size: trailing,
			data: {
				id: "trailing-group",
				views: ["trailing"],
				activeView: "trailing",
			},
		});
	}
	const length = widths.reduce((sum, width) => sum + width, trailing);
	api.layout(vertical ? 840 : length, vertical ? length : 840);
	api.fromJSON({
		panels,
		grid: {
			width: vertical ? 840 : length,
			height: vertical ? length : 840,
			orientation: vertical ? Orientation.VERTICAL : Orientation.HORIZONTAL,
			root: { type: "branch", data },
		},
	});
	const measure = () =>
		widths.map((_, index) => {
			const group = api.getPanel(`pane-${index}-0`)!.group.api;
			return vertical ? group.height : group.width;
		});
	return { api, measure, container };
}

describe("deeply nested pane size preservation", () => {
	it.each([
		[false, "right"],
		[false, "left"],
		[true, "below"],
		[true, "above"],
	] as const)(
		"resizes the intended branch, not its descendant (vertical=%s, edge=%s)",
		(vertical, direction) => {
			const { api, measure } = nestedGrid(vertical);
			expect(measure()).toEqual([320, 320, 320, 320, 320]);
			const originals = api.panels.map((panel) => ({
				panel,
				group: panel.group,
				element: panel.group.element,
			}));
			addPanePreservingSizes(api, {
				id: "added",
				component: "fixture",
				position: { direction },
			});
			for (const size of measure())
				expect(Math.abs(size - (320 * 2) / 3)).toBeLessThanOrEqual(1);
			const added = api.getPanel("added")!.group.api;
			expect(
				Math.abs((vertical ? added.height : added.width) - 1600 / 3),
			).toBeLessThanOrEqual(1);
			for (const { panel, group, element } of originals) {
				expect(api.getPanel(panel.id)).toBe(panel);
				expect(panel.group).toBe(group);
				expect(group.element).toBe(element);
				expect(element.isConnected).toBe(true);
			}
			for (const index of [0, 1, 2, 3, 4]) {
				expect(
					[0, 1, 2].map((row) => {
						const group = api.getPanel(`pane-${index}-${row}`)!.group.api;
						return vertical ? group.width : group.height;
					}),
				).toEqual([400, 280, 160]);
			}
		},
	);

	it("preserves unequal ratios inside a resized nested branch", () => {
		const before = [240, 320, 400, 320, 320];
		const { api, measure } = nestedGrid(false, before);
		expect(measure()).toEqual(before);
		addPanePreservingSizes(api, {
			id: "added",
			component: "fixture",
			position: { direction: "right" },
		});
		for (const [index, size] of measure().entries())
			expect(Math.abs(size - (before[index] * 2) / 3)).toBeLessThanOrEqual(2);
	});

	it("honours a requested right-rail width across deep nesting", () => {
		const before = [240, 320, 400, 320, 320];
		const { api, measure } = nestedGrid(false, before);
		addPanePreservingSizes(api, {
			id: "added",
			component: "fixture",
			initialWidth: 576,
			position: { direction: "right" },
		});
		for (const [index, size] of measure().entries())
			expect(Math.abs(size - before[index] * 0.64)).toBeLessThanOrEqual(2);
		expect(api.getPanel("added")!.group.api.width).toBe(576);
	});

	it("keeps input focus and selection when a background peer is added", () => {
		const { api } = nestedGrid(false);
		const panel = api.getPanel("pane-0-0")!;
		panel.api.setActive();
		const input = panel.group.element.querySelector("textarea")!;
		input.value = "keep this input";
		input.focus();
		input.setSelectionRange(2, 7);
		addPanePreservingSizes(api, {
			id: "added",
			component: "fixture",
			inactive: true,
			position: { direction: "right" },
		});
		expect(api.activePanel).toBe(panel);
		expect(document.activeElement).toBe(input);
		expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
	});

	it("keeps an explicit split local inside a deep branch", () => {
		const { api, measure } = nestedGrid(false);
		addPanePreservingSizes(api, {
			id: "added",
			component: "fixture",
			position: { referencePanel: "pane-0-0", direction: "below" },
		});
		expect(measure()).toEqual([320, 320, 320, 320, 320]);
		expect(
			["pane-0-0", "added", "pane-0-1", "pane-0-2"].map(
				(id) => api.getPanel(id)!.group.api.height,
			),
		).toEqual([200, 200, 280, 160]);
	});

	it("publishes corrected sizes through the existing layout event", async () => {
		const { api, measure } = nestedGrid(false);
		const saved = new Promise<SerializedDockview>((resolve) => {
			const subscription = api.onDidLayoutChange(() => {
				subscription.dispose();
				resolve(api.toJSON());
			});
		});
		addPanePreservingSizes(api, {
			id: "added",
			component: "fixture",
			position: { direction: "right" },
		});
		const dimensions = measure();
		api.fromJSON(await saved);
		expect(measure()).toEqual(dimensions);
		expect(api.getPanel("added")!.group.api.width).toBe(534);
	});

	it.each([false, true])(
		"keeps a nested sibling's footprint when closing a peer (vertical=%s)",
		(vertical) => {
			const { api, measure } = nestedGrid(
				vertical,
				[160, 160, 160, 160, 320],
				640,
			);
			expect(measure()).toEqual([160, 160, 160, 160, 320]);
			removePanePreservingSizes(api, api.getPanel("trailing")!);
			expect(measure()).toEqual([160, 160, 160, 160, 960]);
		},
	);
});
