// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDureClientPresentation } from "@/lib/persistence/dureClientPresentation";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import { registerDockview, unregisterDockview } from "./dockRegistry";
import { openAgentPanelOnDockview } from "./openAgentPanel";

const fixtures: { api: DockviewApi; id: string; element: HTMLElement }[] = [];
const initialLayouts = useStore.getState().layouts;
let sequence = 0;

function setup() {
	const id = `agent-reference-fixture-${++sequence}`;
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(id, api);
	fixtures.push({ api, id, element });
	return { api, id };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const { api, id, element } of fixtures.splice(0)) {
		unregisterDockview(id, api);
		api.dispose();
		element.remove();
	}
	useStore.setState({ layouts: initialLayouts });
});

describe("Agent pane presentation reference with actual Dockview", () => {
	it("restores the launcher after a failed layout publication and accepts a new exact-handle retry", () => {
		const { api, id } = setup();
		const launcher = api.addPanel({
			id: "slot",
			component: "launcher",
			params: { cwd: "/repo" },
		});
		const sibling = api.addPanel({
			id: "sibling",
			component: "terminal",
			position: { referencePanel: launcher.id, direction: "right" },
		});
		launcher.api.setActive();
		const before = api.toJSON();
		const agent = agentFixture({ id: "accepted-runtime" });
		vi.spyOn(useStore.getState(), "saveLayout").mockImplementationOnce(() => {
			throw new Error("injected publication failure");
		});
		expect(() =>
			openAgentPanelOnDockview({
				desktopId: id,
				api,
				agent,
				position: { replacement: launcher.api },
			}),
		).toThrow("injected publication failure");
		expect(api.toJSON()).toEqual(before);
		expect(api.getPanel(sibling.id)).toBe(sibling);
		const restored = api.getPanel(launcher.id)!;
		expect(restored.api.component).toBe("launcher");
		expect(
			openAgentPanelOnDockview({
				desktopId: id,
				api,
				agent,
				position: { replacement: restored.api },
			}),
		).toBe(launcher.id);
		expect(api.panels).toHaveLength(2);
		expect(api.getPanel(launcher.id)?.params).toEqual({
			agentRef: { agentId: agent.id },
		});
	});

	it.each(["slot", "launcher:previous", "agent:previous"])(
		"completes launcher %s in place and replays only the accepted Agent target",
		(paneId) => {
			const { api, id } = setup();
			const slot = api.addPanel({ id: paneId, component: "launcher" });
			const sibling = api.addPanel({
				id: "sibling",
				component: "terminal",
				position: { referencePanel: paneId, direction: "right" },
			});
			slot.api.setActive();
			const position = { replacement: slot.api };
			const open = (agentId: string) =>
				openAgentPanelOnDockview({
					desktopId: id,
					api,
					agent: agentFixture({ id: agentId }),
					position,
				});
			expect(open("current")).toBe(paneId);
			const current = api.getPanel(paneId)!;
			const before = api.toJSON();
			expect(current.api.component).toBe("agent");
			expect(current.params).toEqual({ agentRef: { agentId: "current" } });
			expect(useStore.getState().layouts[id]).toEqual(before);
			expect(open("current")).toBe(paneId);
			expect(api.getPanel(paneId)).toBe(current);
			expect(api.getPanel(sibling.id)).toBe(sibling);
			expect(api.toJSON()).toEqual(before);
			expect(() => open("late")).toThrow();
			expect(api.toJSON()).toEqual(before);
		},
	);

	it.each(["agent:previous", "launcher:previous", "pane:opaque"])(
		"opens the current Agent in %s without adding another pane",
		(paneId) => {
			const { api, id } = setup();
			const pane = api.addPanel({
				id: paneId,
				component: "agent",
				params: { agentRef: { agentId: "current" } },
			});
			const sibling = api.addPanel({
				id: "agent:current",
				component: "terminal",
				params: { sessionId: "keep-sibling" },
				position: { referencePanel: paneId, direction: "right" },
			});
			pane.api.updateParameters({ titleHint: "merged parameters" });
			const before = api.toJSON();
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(
					openAgentPanelOnDockview({
						desktopId: id,
						api,
						agent: agentFixture({ id: "current" }),
					}),
				).toBe(paneId);
				expect(api.activePanel).toBe(pane);
				expect(api.panels).toHaveLength(2);
				expect(api.getPanel(sibling.id)).toBe(sibling);
				expect(api.toJSON().grid).toEqual(before.grid);
				expect(api.toJSON().panels).toEqual(before.panels);
			}
		},
	);

	it.each([
		{ component: "terminal", params: {} },
		{ component: "agent", params: { agentRef: null } },
		{ component: "agent", params: { agentRef: { agentId: "other" } } },
	])(
		"opens a separate view while preserving an occupied historical ID with $component / $params",
		(content) => {
			const { api, id } = setup();
			const occupied = api.addPanel<Record<string, unknown>>({
				id: "agent:current",
				...content,
			});
			const sibling = api.addPanel({
				id: "pane:sibling",
				component: "terminal",
			});
			const before = api.toJSON();
			const panelId = openAgentPanelOnDockview({
				desktopId: id,
				api,
				agent: agentFixture({ id: "current" }),
			});
			expect(panelId).not.toBe(false);
			expect(panelId).not.toBe(occupied.id);
			expect(api.getPanel(String(panelId))?.params).toEqual({
				agentRef: { agentId: "current" },
			});
			expect(api.getPanel(occupied.id)).toBe(occupied);
			expect(api.getPanel(sibling.id)).toBe(sibling);
			expect(api.toJSON().panels).toMatchObject(before.panels);
		},
	);

	it("creates and saves only an Agent reference; repeated opening preserves the existing pane", () => {
		const { api, id } = setup();
		const agent = agentFixture({ id: "current" });
		const panelId = openAgentPanelOnDockview({ desktopId: id, api, agent });
		expect(panelId).not.toBe(false);
		expect(panelId).not.toMatch(/^(agent|term|terminal|launcher):/);
		const pane = api.getPanel(String(panelId))!;
		expect(pane.params).toEqual({ agentRef: { agentId: "current" } });
		const saved = useStore.getState().layouts[id] as ReturnType<
			DockviewApi["toJSON"]
		>;
		expect(saved.panels[pane.id].params).toEqual(pane.params);
		openAgentPanelOnDockview({ desktopId: id, api, agent });
		expect(api.panels).toEqual([pane]);
		expect(api.getPanel(pane.id)).toBe(pane);
		expect(api.toJSON().grid).toEqual(saved.grid);
	});

	it.each(["agent:previous", "launcher:previous", "pane:opaque"])(
		"restores the target of %s without changing its identity, geometry or sibling",
		(paneId) => {
			const { api } = setup();
			api.addPanel({
				id: paneId,
				component: "agent",
				params: { agentRef: { agentId: "current" } },
			});
			api.addPanel({
				id: "term:sibling",
				component: "terminal",
				params: { sessionId: "sibling-session", cwd: "/sibling" },
				position: { referencePanel: paneId, direction: "right" },
			});
			const saved = api.toJSON();
			const restoredFixture = setup();
			const restored = restoredFixture.api;
			restored.fromJSON(
				normalizePersistedPaneLayout(
					JSON.parse(JSON.stringify(saved)),
				) as ReturnType<DockviewApi["toJSON"]>,
			);
			expect(restored.toJSON()).toEqual(saved);
			expect(restored.getPanel(paneId)?.params).toEqual({
				agentRef: { agentId: "current" },
			});
			const projection = buildDureClientPresentation({
				spaces: [{ id: "space", name: "Work" }],
				layouts: { space: restored.toJSON() },
				agents: [],
			});
			expect(projection.spaces[0].panes[0]).toMatchObject({
				id: paneId,
				type: "agent",
				agentId: "current",
				binding: null,
			});
			const pane = restored.getPanel(paneId);
			openAgentPanelOnDockview({
				desktopId: restoredFixture.id,
				api: restored,
				agent: agentFixture({ id: "current" }),
			});
			expect(restored.activePanel).toBe(pane);
			expect(restored.panels).toHaveLength(2);
			expect(restored.toJSON().grid).toEqual(saved.grid);
		},
	);
});
