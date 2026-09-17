// @vitest-environment jsdom

import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import { assertHiddenBranchLayout } from "@/qa/workspacePerformance/hiddenBranchLayout";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function workspace() {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	cleanups.push(() => {
		api.dispose();
		container.remove();
	});
	api.addPanel({ id: "top", component: "test" });
	api.addPanel({
		id: "bottom",
		component: "test",
		position: { referencePanel: "top", direction: "below" },
	});
	api.addPanel({
		id: "hidden-top",
		component: "test",
		position: { referencePanel: "top", direction: "right" },
	});
	api.addPanel({
		id: "hidden-bottom",
		component: "test",
		position: { referencePanel: "hidden-top", direction: "below" },
	});
	api.layout(1_000, 700);
	return api;
}

function footprint(api: DockviewApi, id: string) {
	const group = api.getPanel(id)!.group.api;
	return { width: group.width, height: group.height, visible: group.isVisible };
}

function hideBranch(api: DockviewApi) {
	api.getPanel("hidden-top")!.group.api.setVisible(false);
	api.getPanel("hidden-bottom")!.group.api.setVisible(false);
}

describe("hidden nested Dockview branches", () => {
	it("runs the same restore/move probe used by the native sash smoke", () => {
		expect(() => assertHiddenBranchLayout(document)).not.toThrow();
	});

	it("does not collapse or lock the visible row when restoring hidden descendants", () => {
		const api = workspace();
		hideBranch(api);
		const top = footprint(api, "top");
		const bottom = footprint(api, "bottom");
		api.fromJSON(api.toJSON());
		expect(footprint(api, "top")).toEqual(top);
		expect(footprint(api, "bottom")).toEqual(bottom);
		api.getPanel("top")!.group.api.setSize({ height: top.height + 70 });
		expect(footprint(api, "top").height).toBe(top.height + 70);
	});

	it("retains the hidden branch footprint and placement across reload and restore", () => {
		const api = workspace();
		const original = api.toJSON().grid;
		hideBranch(api);
		api.fromJSON(api.toJSON());
		api.getPanel("hidden-bottom")!.group.api.setVisible(true);
		api.getPanel("hidden-top")!.group.api.setVisible(true);
		expect(api.toJSON().grid).toEqual(original);
	});

	it.each([false, true])(
		"does not reserve a blank row after a move (reload: %s)",
		(reload) => {
			const api = workspace();
			hideBranch(api);
			if (reload) api.fromJSON(api.toJSON());
			api
				.getPanel("top")!
				.api.moveTo({
					group: api.getPanel("bottom")!.group,
					position: "right",
				});
			for (const id of ["top", "bottom"]) {
				expect(footprint(api, id).height).toBe(700);
			}
			expect(api.panels.map((p) => p.id).sort()).toEqual([
				"bottom",
				"hidden-bottom",
				"hidden-top",
				"top",
			]);
		},
	);

	it("recovers legacy hidden branches even without a serialized parent visibility flag", () => {
		const api = workspace();
		hideBranch(api);
		const top = footprint(api, "top");
		const legacy = api.toJSON();
		// Old snapshots retained hidden leaf flags but exposed their parent slot.
		if (!Array.isArray(legacy.grid.root.data)) throw new Error("fixture root");
		const row = legacy.grid.root.data[0];
		if (!Array.isArray(row.data) || !Array.isArray(row.data[0].data))
			throw new Error("fixture topology");
		const hidden = row.data[0].data[1];
		delete hidden.visible;
		hidden.size = 400;
		api.fromJSON(legacy);
		expect(footprint(api, "top")).toEqual(top);
		api.fromJSON(api.toJSON());
		expect(footprint(api, "top")).toEqual(top);
		api.getPanel("top")!.group.api.setSize({ height: 350 });
		expect(footprint(api, "top").height).toBe(350);
	});
});
