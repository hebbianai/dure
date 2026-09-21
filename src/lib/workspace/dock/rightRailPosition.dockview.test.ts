// @vitest-environment jsdom

import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { rightRailPosition } from "@/lib/workspace/dock/gridPanePlacement";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import { placementOptions } from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

const fixtures: { api: DockviewApi; id: string; element: HTMLElement }[] = [];
let sequence = 0;
const initialLayouts = useStore.getState().layouts;

function setup(width = 1200) {
	const id = `right-rail-qa-${++sequence}`;
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("textarea"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(width, 800);
	registerDockview(id, api);
	fixtures.push({ id, api, element });
	const addAgent = (
		agentId: string,
		position?: Parameters<typeof openAgentPanelOnDockview>[0]["position"],
	) => {
		const panelId = openAgentPanelOnDockview({
			desktopId: id,
			api,
			agent: agentFixture({ id: agentId, provider: "codex" }),
			position,
		});
		expect(panelId).not.toBe(false);
		return api.getPanel(String(panelId))!;
	};
	return { api, id, addAgent };
}

afterEach(() => {
	for (const { api, id, element } of fixtures.splice(0)) {
		unregisterDockview(id, api);
		api.dispose();
		element.remove();
	}
	useStore.setState({ layouts: initialLayouts });
});

describe("ordinary right rail with installed Dockview", () => {
	it.each([800, 1200, 1800])(
		"shares a %ipx workspace between the first two Codex panes",
		(width) => {
			const { api, id, addAgent } = setup(width);
			const first = addAgent("first");
			const firstElement = first.group.element;
			const second = addAgent("second");
			expect(first.group.api.width).toBeCloseTo(width / 2, 0);
			expect(second.group.api.width).toBeCloseTo(width / 2, 0);
			expect(api.getPanel(first.id)).toBe(first);
			expect(first.group.element).toBe(firstElement);
			const savedLayout = useStore.getState().layouts[id] as ReturnType<
				DockviewApi["toJSON"]
			>;
			expect(savedLayout.grid).toEqual(api.toJSON().grid);

			const restored = setup(width).api;
			restored.fromJSON(savedLayout);
			expect(restored.getPanel(first.id)!.group.api.width).toBeCloseTo(
				width / 2,
				0,
			);
			expect(restored.getPanel(second.id)!.group.api.width).toBeCloseTo(
				width / 2,
				0,
			);
		},
	);

	it("keeps repeated ordinary additions peer-sized without collapsing earlier panes", () => {
		const { api, addAgent } = setup();
		for (let count = 1; count <= 5; count += 1) {
			addAgent(`agent-${count}`);
			for (const pane of api.panels) {
				expect(
					pane.group.api.width,
					`${pane.id} at ${count} panes`,
				).toBeCloseTo(1200 / count, 0);
			}
		}
	});

	it.each([
		{ component: "agent", widths: [400, 400, 400] },
		{ component: "terminal", widths: [400, 400, 400] },
		{ component: "agent", widths: [600, 400, 200] },
	])(
		"adds a peer-width $component rail beside terminal columns $widths",
		({ component, widths }) => {
			const { api, id, addAgent } = setup();
			const top = api.addPanel({ id: "term:top", component: "terminal" });
			const bottom = api.addPanel({
				id: "term:bottom",
				component: "terminal",
				position: { referencePanel: top.id, direction: "below" },
			});
			for (const first of [top, bottom]) {
				const second = api.addPanel({
					id: `${first.id}-middle`,
					component: "terminal",
					position: { referencePanel: first.id, direction: "right" },
				});
				const third = api.addPanel({
					id: `${first.id}-right`,
					component: "terminal",
					position: { referencePanel: second.id, direction: "right" },
				});
				first.group.api.setSize({ width: widths[0] });
				second.group.api.setSize({ width: widths[1] });
				expect(
					[first, second, third].map((panel) => panel.group.api.width),
				).toEqual(widths);
			}
			top.group.api.setSize({ height: 500 });
			const existing = api.panels.map((panel) => ({
				panel,
				element: panel.group.element,
				height: panel.group.api.height,
				width: panel.group.api.width,
			}));

			const rail =
				component === "agent"
					? addAgent("first-agent")
					: addPanePreservingSizes(api, {
							id: "term:new",
							component,
							...placementOptions(rightRailPosition(api)),
						});
			expect(rail.group.api.width).toBeCloseTo(300, 0);
			expect(rail.group.api.height).toBeCloseTo(800, 0);
			for (const { panel, element, height, width } of existing) {
				expect(api.getPanel(panel.id)).toBe(panel);
				expect(panel.group.element).toBe(element);
				expect(panel.group.api.width).toBeCloseTo(width * 0.75, 0);
				expect(panel.group.api.height).toBeCloseTo(height, 0);
			}
			if (component === "agent") {
				const saved = useStore.getState().layouts[id] as ReturnType<
					DockviewApi["toJSON"]
				>;
				expect(saved.grid).toEqual(api.toJSON().grid);
				const restored = setup().api;
				restored.fromJSON(saved);
				for (const panel of api.panels) {
					const group = restored.getPanel(panel.id)!.group.api;
					expect(group.width).toBeCloseTo(panel.group.api.width, 0);
					expect(group.height).toBeCloseTo(panel.group.api.height, 0);
				}
			}
		},
	);

	it("matches the post-add agent mean while preserving an uneven row's proportions", () => {
		const { api, addAgent } = setup();
		const first = addAgent("first");
		const second = addAgent("second", {
			referencePanel: first.id,
			direction: "right",
		});
		first.group.api.setSize({ width: 800 });
		const third = addAgent("third");
		expect(third.group.api.width).toBeCloseTo(400, 0);
		expect(
			Math.abs(first.group.api.width / second.group.api.width - 2),
		).toBeLessThan(0.01);
		expect(third.group.api.width).toBeCloseTo(
			(first.group.api.width + second.group.api.width) / 2,
			0,
		);
		expect(api.groups).toHaveLength(3);
	});

	it("counts a tabbed agent group once and preserves the space used by non-agent panes", () => {
		const { api, addAgent } = setup();
		const agent = addAgent("first");
		api.addPanel({
			id: "agent:tab",
			component: "agent",
			position: { referencePanel: agent.id, direction: "within" },
		});
		const other = api.addPanel({
			id: "file:readme",
			component: "file",
			position: { referencePanel: agent.id, direction: "right" },
		});
		const next = addAgent("next");
		for (const panel of [agent, other, next])
			expect(panel.group.api.width).toBeCloseTo(400, 0);
	});

	it("leaves a vertical stack's heights intact while adding a peer-width full-height rail", () => {
		const { addAgent } = setup();
		const top = addAgent("top");
		const bottom = addAgent("bottom", {
			referencePanel: top.id,
			direction: "below",
		});
		top.group.api.setSize({ height: 500 });
		const rail = addAgent("rail");
		for (const pane of [top, bottom, rail])
			expect(pane.group.api.width).toBeCloseTo(600, 0);
		expect(top.group.api.height).toBeCloseTo(500, 0);
		expect(bottom.group.api.height).toBeCloseTo(300, 0);
		expect(rail.group.api.height).toBeCloseTo(800, 0);
	});

	it("applies the same allocation to ordinary terminals without restoring hidden agents", () => {
		const { api, addAgent } = setup();
		const first = addAgent("first");
		const hidden = addAgent("hidden", {
			referencePanel: first.id,
			direction: "below",
		});
		hidden.group.api.setVisible(false);
		const terminal = addPanePreservingSizes(api, {
			id: "term:new",
			component: "terminal",
			...placementOptions(rightRailPosition(api)),
		});
		expect(first.group.api.width).toBeCloseTo(600, 0);
		expect(terminal.group.api.width).toBeCloseTo(600, 0);
		expect(hidden.group.api.isVisible).toBe(false);
	});

	it("preserves explicit split placement and absolute widths", () => {
		const { api, addAgent } = setup();
		const first = addAgent("first");
		const split = addAgent("split", {
			referencePanel: first.id,
			direction: "right",
		});
		expect(first.group.api.width).toBeCloseTo(600, 0);
		expect(split.group.api.width).toBeCloseTo(600, 0);
		const explicit = addPanePreservingSizes(api, {
			id: "term:explicit",
			component: "terminal",
			initialWidth: 420,
			position: { direction: "right" },
		});
		expect(explicit.group.api.width).toBeCloseTo(420, 0);
	});
});
