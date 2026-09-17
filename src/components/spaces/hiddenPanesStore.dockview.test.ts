// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpaces } from "@/components/spaces/useSpaces";
import { AgentClaimPaneRegistry } from "@/lib/plugins/agentClaimPaneRegistry";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import {
	normalizeHiddenPanes,
	useHiddenPanes,
} from "@/lib/workspace/pane/hiddenPanesStore";
import { hidePaneWithRecord } from "@/lib/workspace/pane/paneHideActions";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

const initialStore = useStore.getState();
const initialHidden = useHiddenPanes.getState().hidden;
const disposers: Array<() => void> = [];
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	for (const dispose of disposers.splice(0).reverse()) dispose();
	useStore.setState(initialStore, true);
	useHiddenPanes.setState({ hidden: initialHidden });
});

function fixture(paneId: string) {
	const agent = agentFixture({
		id: "current",
		projectId: "project",
		worktreePath: "/repo",
	});
	useStore.setState({
		agents: [agent],
		projects: [
			{
				id: "project",
				name: "Repo",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		spaces: [{ id: "space", name: "Space" }],
		activeSpaceId: "space",
		layouts: {},
	});
	useHiddenPanes.setState({ hidden: {} });
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview("space", api);
	disposers.push(() => {
		unregisterDockview("space", api);
		api.dispose();
		element.remove();
	});
	const sibling = api.addPanel({
		id: "sibling",
		component: "terminal",
		params: { sessionId: "keep-sibling" },
	});
	api.addPanel({
		id: paneId,
		component: "agent",
		params: { agentRef: { agentId: agent.id } },
		floating: { x: 70, y: 80, width: 400, height: 300 },
	});
	useStore.getState().saveLayout("space", api.toJSON());
	return { api, agent, sibling };
}

describe("hidden pane identity", () => {
	it("restores the stored floating anchor through the common opener", () => {
		// jsdom has no layout engine; measure the bounds Dockview writes to the
		// overlay while keeping its real placement and serialization behavior.
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				return this.classList.contains("dv-resize-container")
					? new DOMRect(
							Number.parseFloat(this.style.left) || 0,
							Number.parseFloat(this.style.top) || 0,
							Number.parseFloat(this.style.width) || 0,
							Number.parseFloat(this.style.height) || 0,
						)
					: new DOMRect(0, 0, 1000, 700);
			},
		);
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.getBoundingClientRect().width;
			},
		);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.getBoundingClientRect().height;
			},
		);
		const { api, agent } = fixture("opaque-slot");
		hidePaneWithRecord({
			desktopId: "space",
			panelId: "opaque-slot",
			agentId: agent.id,
		});
		const hidden = useHiddenPanes.getState().hidden[agent.id];
		expect(hidden.anchor).toHaveProperty("floating");
		openAgentPanelOnDockview({ desktopId: "space", api, agent });
		expect(api.getPanel("opaque-slot")?.group.api.location.type).toBe(
			"floating",
		);
		expect(api.toJSON().floatingGroups?.[0].position).toEqual(
			hidden.anchor && "floating" in hidden.anchor
				? {
						left: hidden.anchor.floating.x,
						top: hidden.anchor.floating.y,
						width: hidden.anchor.floating.width,
						height: hidden.anchor.floating.height,
					}
				: undefined,
		);
	});

	it("retains the hidden receipt when committing the restored layout fails", () => {
		const { api, agent } = fixture("opaque-slot");
		hidePaneWithRecord({
			desktopId: "space",
			panelId: "opaque-slot",
			agentId: agent.id,
		});
		const hidden = useHiddenPanes.getState().hidden[agent.id];
		vi.spyOn(useStore.getState(), "saveLayout").mockImplementationOnce(() => {
			throw new Error("injected publication failure");
		});
		expect(() =>
			openAgentPanelOnDockview({ desktopId: "space", api, agent }),
		).toThrow("injected publication failure");
		expect(useHiddenPanes.getState().hidden[agent.id]).toBe(hidden);
		expect(api.getPanel("opaque-slot")).toBeUndefined();
		openAgentPanelOnDockview({ desktopId: "space", api, agent });
		expect(api.getPanel("opaque-slot")?.params).toEqual({
			agentRef: { agentId: agent.id },
		});
		expect(useHiddenPanes.getState().hidden[agent.id]).toBeUndefined();
		expect(useStore.getState().agents[0]).toBe(agent);
	});

	it("does not replace another target occupying the hidden pane identity", () => {
		const { api, agent } = fixture("opaque-slot");
		hidePaneWithRecord({
			desktopId: "space",
			panelId: "opaque-slot",
			agentId: agent.id,
		});
		const hidden = useHiddenPanes.getState().hidden[agent.id];
		const other = api.addPanel({
			id: "opaque-slot",
			component: "terminal",
			params: { sessionId: "do-not-touch" },
		});
		const before = api.toJSON();
		expect(() =>
			openAgentPanelOnDockview({ desktopId: "space", api, agent }),
		).toThrow();
		expect(api.getPanel("opaque-slot")).toBe(other);
		expect(api.toJSON()).toEqual(before);
		expect(useHiddenPanes.getState().hidden[agent.id]).toBe(hidden);
		expect(useStore.getState().agents[0]).toBe(agent);
	});

	it.each(["opaque-slot", "agent:previous", "launcher:previous"])(
		"retains the exact identity while hiding %s",
		(paneId) => {
			const { api, agent, sibling } = fixture(paneId);
			hidePaneWithRecord({
				desktopId: "space",
				panelId: paneId,
				agentId: agent.id,
			});
			expect(api.getPanel(paneId)).toBeUndefined();
			expect(api.getPanel(sibling.id)).toBe(sibling);
			expect(useHiddenPanes.getState().hidden[agent.id]).toMatchObject({
				paneId,
				desktopId: "space",
			});
			expect(useStore.getState().agents[0]).toBe(agent);
		},
	);

	it.each(["opaque-slot", "agent:previous", "launcher:previous"])(
		"restores %s from a durable hidden record without making an Agent alias",
		(paneId) => {
			const { api, agent, sibling } = fixture(paneId);
			hidePaneWithRecord({
				desktopId: "space",
				panelId: paneId,
				agentId: agent.id,
			});
			const record = { ...useHiddenPanes.getState().hidden[agent.id], paneId };
			useHiddenPanes.setState({
				hidden: normalizeHiddenPanes(
					JSON.parse(JSON.stringify({ [agent.id]: record })),
				),
			});
			openAgentPanelOnDockview({
				desktopId: "space",
				api,
				agent,
				position: { floating: { x: 70, y: 80, width: 400, height: 300 } },
			});
			expect(api.getPanel(paneId)?.params).toEqual({
				agentRef: { agentId: agent.id },
			});
			expect(api.getPanel(`agent:${agent.id}`)).toBeUndefined();
			expect(api.getPanel(sibling.id)).toBe(sibling);
			expect(api.panels).toHaveLength(2);
			expect(useHiddenPanes.getState().hidden[agent.id]).toBeUndefined();
			expect(useStore.getState().agents[0]).toBe(agent);
		},
	);

	it("normalizes absent legacy identity only, preserving explicit valid identity", () => {
		expect(
			normalizeHiddenPanes({
				legacy: { desktopId: "space", at: 1 },
				current: { desktopId: "space", at: 2, paneId: "opaque-slot" },
				broken: { desktopId: "space", at: 3, paneId: null },
			}),
		).toEqual({
			legacy: { desktopId: "space", at: 1, paneId: "agent:legacy" },
			current: { desktopId: "space", at: 2, paneId: "opaque-slot" },
		});
	});

	it("publishes a changed hidden identity in plugin and Spaces projections", () => {
		const { api, agent } = fixture("opaque-slot");
		hidePaneWithRecord({
			desktopId: "space",
			panelId: "opaque-slot",
			agentId: agent.id,
		});
		const registry = new AgentClaimPaneRegistry();
		const record = { desktopId: "space", at: 1, paneId: "opaque-slot" };
		act(() => useHiddenPanes.setState({ hidden: { [agent.id]: record } }));
		const hook = renderHook(() => useSpaces());
		registry.replaceSources({
			...useStore.getState(),
			hidden: useHiddenPanes.getState().hidden,
		});
		expect(registry.getSnapshot()).toEqual([
			{ id: "opaque-slot", agentId: agent.id },
		]);
		expect(
			hook.result.current.find((row) => row.agentId === agent.id),
		).toMatchObject({ key: "opaque-slot", hidden: true });
		act(() =>
			useHiddenPanes.setState({
				hidden: { [agent.id]: { ...record, paneId: "next-slot" } },
			}),
		);
		registry.replaceSources({
			...useStore.getState(),
			hidden: useHiddenPanes.getState().hidden,
		});
		expect(registry.getSnapshot()).toEqual([
			{ id: "next-slot", agentId: agent.id },
		]);
		expect(
			hook.result.current.find((row) => row.agentId === agent.id),
		).toMatchObject({ key: "next-slot", hidden: true });
		expect(api.panels.map((panel) => panel.id)).toEqual(["sibling"]);
	});
});
