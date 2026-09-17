// @vitest-environment jsdom
import {
	createDockview,
	Orientation,
	type SerializedDockview,
} from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import { balancePaneSizes } from "@/lib/workspace/pane/paneBalance";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

type Node = SerializedDockview["grid"]["root"];
function leaf(id: string, size: number, visible = true): Node {
	return {
		type: "leaf",
		size,
		visible,
		data: { id, views: [id], activeView: id },
	};
}
function branch(size: number, ...data: Node[]): Node {
	return { type: "branch", size, data };
}
function fixture(root: Node, vertical = false) {
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
	function collect(node: Node) {
		if (node.type === "branch") (node.data as Node[]).forEach(collect);
		else {
			const id = (node.data as { id: string }).id;
			panels[id] = { id, contentComponent: "fixture", title: id };
		}
	}
	collect(root);
	api.layout(vertical ? 800 : 1200, vertical ? 1200 : 800);
	api.fromJSON({
		panels,
		grid: {
			root,
			width: vertical ? 800 : 1200,
			height: vertical ? 1200 : 800,
			orientation: vertical ? Orientation.VERTICAL : Orientation.HORIZONTAL,
		},
	});
	const sizes = (...ids: string[]) =>
		ids.map((id) => {
			const group = api.getPanel(id)!.group.api;
			return vertical ? group.height : group.width;
		});
	return { api, sizes };
}

describe("balance pane sizes", () => {
	it.each([false, true])(
		"balances parallel splits (vertical=%s) without remounting or losing input",
		(vertical) => {
			const { api, sizes } = fixture(
				branch(800, leaf("a", 700), leaf("b", 350), leaf("c", 150)),
				vertical,
			);
			const originals = api.panels.map((panel) => ({
				panel,
				element: panel.group.element,
			}));
			const active = api.getPanel("b")!;
			active.api.setActive();
			const input = active.group.element.querySelector("textarea")!;
			input.value = "retained selection";
			input.focus();
			input.setSelectionRange(2, 7);
			balancePaneSizes(api);
			expect(sizes("a", "b", "c")).toEqual([400, 400, 400]);
			expect(api.activePanel).toBe(active);
			expect(document.activeElement).toBe(input);
			expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
			for (const { panel, element } of originals) {
				expect(api.getPanel(panel.id)).toBe(panel);
				expect(panel.group.element).toBe(element);
				expect(element.isConnected).toBe(true);
			}
			const balanced = api.toJSON();
			balancePaneSizes(api);
			expect(api.toJSON()).toEqual(balanced);
		},
	);

	it.each([false, true])(
		"aligns deeply nested tracks and perpendicular splits (vertical=%s)",
		(vertical) => {
			const column = (id: string, size: number) =>
				branch(size, leaf(`${id}1`, 600), leaf(`${id}2`, 200));
			const { api, sizes } = fixture(
				branch(
					800,
					branch(900, branch(800, column("a", 500), column("b", 400))),
					column("c", 300),
				),
				vertical,
			);
			balancePaneSizes(api);
			expect(sizes("a1", "b1", "c1")).toEqual([400, 400, 400]);
			for (const panel of api.panels) {
				expect(vertical ? panel.group.api.width : panel.group.api.height).toBe(
					400,
				);
			}
		},
	);

	it("excludes hidden branches and floating groups, and counts tab groups once", () => {
		const { api, sizes } = fixture(
			branch(800, leaf("a", 900), leaf("b", 300), {
				...branch(
					200,
					leaf("hidden1", 400, false),
					leaf("hidden2", 400, false),
				),
				visible: false,
			}),
		);
		api.addPanel({
			id: "tab",
			component: "fixture",
			position: { referencePanel: "a", direction: "within" },
		});
		const floating = api.addPanel({
			id: "floating",
			component: "fixture",
			floating: { width: 280, height: 250, x: 10, y: 20 },
		});
		const hiddenBefore = (api.toJSON().grid.root.data as Node[])[2];
		const floatingBefore = {
			width: floating.api.width,
			height: floating.api.height,
		};
		balancePaneSizes(api);
		expect(sizes("a", "b")).toEqual([600, 600]);
		expect(api.getPanel("tab")!.group).toBe(api.getPanel("a")!.group);
		expect((api.toJSON().grid.root.data as Node[])[2]).toEqual(hiddenBefore);
		expect({ width: floating.api.width, height: floating.api.height }).toEqual(
			floatingBefore,
		);
	});

	it("respects minimum sizes", () => {
		const { api, sizes } = fixture(branch(800, leaf("a", 900), leaf("b", 300)));
		api.getPanel("a")!.group.api.setConstraints({ minimumWidth: 750 });
		balancePaneSizes(api);
		expect(sizes("a", "b")).toEqual([750, 450]);
	});

	it("keeps empty, single-pane and maximized layouts unchanged", () => {
		for (const root of [branch(800), branch(800, leaf("a", 1200))]) {
			const { api } = fixture(root);
			const before = api.toJSON();
			balancePaneSizes(api);
			expect(api.toJSON()).toEqual(before);
		}
		const { api } = fixture(branch(800, leaf("a", 900), leaf("b", 300)));
		api.maximizeGroup(api.getPanel("a")!);
		const before = api.toJSON();
		balancePaneSizes(api);
		expect(api.toJSON()).toEqual(before);
	});
});
