// @vitest-environment jsdom

import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteHmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { applyPendingPanelFocus, peekPendingPanelFocus } from "@/lib/workspace/dock/panelFocusHandoff";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { recordPaneFocus } from "@/lib/workspace/pane/paneFocusHistory";
import { installPaneShortcuts } from "@/lib/workspace/pane/paneShortcuts";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

const paneSplitMocks = vi.hoisted(() => ({
	openSplitLauncherPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/pane/paneSplit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/pane/paneSplit")>()),
	openSplitLauncherPanel: paneSplitMocks.openSplitLauncherPanel,
}));

interface FakeGroup {
	id: string;
	api: {
		isVisible: boolean;
		location: { type: "grid" };
		setSize: ReturnType<typeof vi.fn>;
		setVisible: ReturnType<typeof vi.fn>;
		width: number;
		height: number;
	};
	element: HTMLElement;
	focus: ReturnType<typeof vi.fn>;
	activePanel: {
		id: string;
		params: Record<string, unknown>;
		api: {
			id: string;
			component: string;
			group: FakeGroup;
			getWindow: () => Window;
			setActive: ReturnType<typeof vi.fn>;
		};
		group: FakeGroup;
	};
	panels: unknown[];
}

function box(x: number, y: number, width = 100, height = 100): DOMRect {
	return {
		x,
		y,
		width,
		height,
		top: y,
		right: x + width,
		bottom: y + height,
		left: x,
		toJSON: () => ({}),
	} as DOMRect;
}

function fakeGroup(
	id: string,
	panelId: string,
	rect: DOMRect,
	params: Record<string, unknown> = {},
	component = "terminal",
): FakeGroup {
	const element = document.createElement("div");
	element.getBoundingClientRect = () => rect;
	const group = {
		id,
		api: {
			isVisible: true,
			location: { type: "grid" as const },
			setSize: vi.fn(),
			setVisible: vi.fn(),
			width: rect.width,
			height: rect.height,
		},
		element,
		focus: vi.fn(),
		activePanel: undefined as unknown as FakeGroup["activePanel"],
		panels: [] as unknown[],
	};
	const panel = {
		id: panelId,
		params,
		api: {
			id: panelId,
			component,
			group,
			getWindow: () => window,
			setActive: vi.fn(),
		},
		group,
	};
	group.activePanel = panel;
	group.panels = [panel];
	return group;
}

function serializedLayout(
	groups: readonly FakeGroup[],
	activeGroupId: string,
) {
	return {
		grid: {
			root: {
				type: "branch",
				data: groups.map((group) => ({
					type: "leaf",
					visible: group.api.isVisible,
					size: group.element.getBoundingClientRect().width,
					data: {
						id: group.id,
						views: [group.activePanel.id],
						activeView: group.activePanel.id,
					},
				})),
			},
			width: groups.reduce(
				(total, group) => total + group.element.getBoundingClientRect().width,
				0,
			),
			height: 100,
			orientation: "HORIZONTAL",
		},
		panels: Object.fromEntries(
			groups.map((group) => [
				group.activePanel.id,
				{ params: group.activePanel.params },
			]),
		),
		activeGroup: activeGroupId,
	};
}

function fakeDockview(groups: readonly FakeGroup[], activeGroupId: string) {
	const activeGroup = groups.find((group) => group.id === activeGroupId);
	if (!activeGroup) throw new Error(`missing active group ${activeGroupId}`);
	const layout = serializedLayout(groups, activeGroupId);
	const focus = vi.fn();
	const api = {
		activeGroup,
		activePanel: activeGroup.activePanel,
		focus,
		groups,
		panels: groups.map((group) => group.activePanel),
		getPanel: (panelId: string) =>
			groups.find((group) => group.activePanel.id === panelId)?.activePanel,
		toJSON: () => layout,
	} as unknown as DockviewApi;
	return { api, focus, layout };
}

const registered: { desktopId: string; api: DockviewApi }[] = [];
const disposers: (() => void)[] = [];
let sequence = 0;
let previousState: Pick<
	ReturnType<typeof useStore.getState>,
	| "activeSpaceId"
	| "agents"
	| "layouts"
	| "projects"
	| "sessionCwd"
	| "shortcutOverrides"
	| "spaceVisits"
	| "spaces"
	| "uiPrefs"
>;

function register(desktopId: string, dockview: ReturnType<typeof fakeDockview>) {
	registerDockview(desktopId, dockview.api);
	registered.push({ desktopId, api: dockview.api });
}

function dispatch(direction: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown", shiftKey = false) {
	const event = new KeyboardEvent("keydown", {
		key: direction,
		altKey: true,
		metaKey: true,
		shiftKey,
		bubbles: true,
		cancelable: true,
	});
	window.dispatchEvent(event);
	return event;
}

function dispatchBracket(key: "[" | "]") {
	const event = new KeyboardEvent("keydown", {
		key,
		metaKey: true,
		bubbles: true,
		cancelable: true,
	});
	window.dispatchEvent(event);
	return event;
}

function dispatchSplitRight() {
	const event = new KeyboardEvent("keydown", {
		key: "d",
		metaKey: true,
		bubbles: true,
		cancelable: true,
	});
	window.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	const state = useStore.getState();
	previousState = {
		activeSpaceId: state.activeSpaceId,
		agents: state.agents,
		layouts: state.layouts,
		projects: state.projects,
		sessionCwd: state.sessionCwd,
		shortcutOverrides: state.shortcutOverrides,
		spaceVisits: state.spaceVisits,
		spaces: state.spaces,
		uiPrefs: state.uiPrefs,
	};
	paneSplitMocks.openSplitLauncherPanel.mockClear();
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	for (const entry of registered.splice(0)) {
		unregisterDockview(entry.desktopId, entry.api);
	}
	useStore.setState(previousState);
	vi.restoreAllMocks();
});

describe("pane focus shortcuts across Spaces", () => {
	it("splits an explicitly referenced SSH Agent from its live authority", () => {
		const desktopId = `shortcut-agent-split-${++sequence}`;
		const binding = remoteHmuxManagedBinding(
			"remote-session",
			"remote-workspace",
			"host-current",
			"bridge-current",
		);
		const agent = agentFixture({
			id: "remote-agent",
			projectId: "remote-project",
			sessionId: binding.sessionId,
			sessionKind: "ssh",
			worktreePath: "/srv/repo",
			runtimeBinding: binding,
		});
		const dockview = fakeDockview(
			[fakeGroup("agent-group", `agent:${agent.id}`, box(0, 0), { agentRef: { agentId: agent.id } }, "agent")],
			"agent-group",
		);
		register(desktopId, dockview);
		useStore.setState({
			activeSpaceId: desktopId,
			agents: [agent],
			projects: [
				{
					id: agent.projectId,
					name: "Remote",
					path: "/srv/repo",
					kind: "ssh",
					isRepo: true,
					sshHostId: "host-current",
				},
			],
			sessionCwd: { [agent.sessionId]: "/srv/repo/live" },
			shortcutOverrides: {},
		});
		disposers.push(installPaneShortcuts());

		expect(dispatchSplitRight().defaultPrevented).toBe(true);
		expect(paneSplitMocks.openSplitLauncherPanel).toHaveBeenCalledWith(
			desktopId,
			{
				kind: "ssh",
				hostId: "host-current",
				cwd: "/srv/repo/live",
			},
			{ referencePanel: `agent:${agent.id}`, direction: "right" },
		);
	});

	it("navigates pane focus history with Command brackets", () => {
		const desktopId = `shortcut-cycle-${++sequence}`;
		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		api.layout(600, 400);
		const first = api.addPanel({ id: "term:history-first", component: "test" });
		const second = api.addPanel({
			id: "term:history-second",
			component: "test",
			position: { referencePanel: first, direction: "right" },
		});
		const third = api.addPanel({
			id: "term:history-third",
			component: "test",
			position: { referencePanel: first, direction: "below" },
		});
		first.api.setActive();
		registerDockview(desktopId, api);
		registered.push({ desktopId, api });
		const recordActivePane = () => recordPaneFocus(api, api.activePanel?.id);
		recordActivePane();
		const focusHistorySubscription = api.onDidActivePanelChange(recordActivePane);
		useStore.setState({ activeSpaceId: desktopId, shortcutOverrides: {} });
		disposers.push(installPaneShortcuts());
		disposers.push(() => focusHistorySubscription.dispose());
		disposers.push(() => {
			api.dispose();
			container.remove();
		});

		second.api.setActive();
		third.api.setActive();

		expect(dispatchBracket("[").defaultPrevented).toBe(true);
		expect(api.activePanel?.id).toBe("term:history-second");
		expect(dispatchBracket("[").defaultPrevented).toBe(true);
		expect(api.activePanel?.id).toBe("term:history-first");
		expect(dispatchBracket("]").defaultPrevented).toBe(true);
		expect(api.activePanel?.id).toBe("term:history-second");
	});

	it("does not consume history navigation before another pane was focused", () => {
		const desktopId = `shortcut-cycle-single-${++sequence}`;
		const dockview = fakeDockview(
			[fakeGroup("cycle-only", "term:cycle-only", box(0, 0))],
			"cycle-only",
		);
		register(desktopId, dockview);
		useStore.setState({ activeSpaceId: desktopId, shortcutOverrides: {} });
		disposers.push(installPaneShortcuts());

		expect(dispatchBracket("]").defaultPrevented).toBe(false);
	});

	it("crosses the right edge and hands input focus to the next Space after mount", () => {
		const prefix = `shortcut-right-${++sequence}`;
		const currentId = `${prefix}-current`;
		const nextId = `${prefix}-next`;
		const current = fakeDockview(
			[fakeGroup("current-right", "term:current-right", box(100, 0))],
			"current-right",
		);
		const nextLeft = fakeGroup("next-left", "term:next-left", box(0, 0));
		const nextRight = fakeGroup("next-right", "term:next-right", box(100, 0));
		const next = fakeDockview([nextLeft, nextRight], "next-right");
		register(currentId, current);
		useStore.setState((state) => ({
			activeSpaceId: currentId,
			layouts: {
				...state.layouts,
				[currentId]: current.layout,
				[nextId]: next.layout,
			},
			shortcutOverrides: {},
			spaceVisits: {},
			spaces: [
				{ id: currentId, name: "Current" },
				{ id: nextId, name: "Next" },
			],
			uiPrefs: { ...state.uiPrefs, tabOrder: "manual" },
		}));
		disposers.push(installPaneShortcuts());

		const event = dispatch("ArrowRight");

		expect(useStore.getState().activeSpaceId).toBe(nextId);
		expect(event.defaultPrevented).toBe(true);
		expect(peekPendingPanelFocus(nextId)).toBe("term:next-right");
		register(nextId, next);
		expect(applyPendingPanelFocus(nextId)).toBe(true);
		expect(nextRight.activePanel.api.setActive).toHaveBeenCalledOnce();
		expect(nextLeft.activePanel.api.setActive).not.toHaveBeenCalled();
		expect(next.focus).toHaveBeenCalledOnce();
	});

	it("crosses the left edge and hands input focus to the previous mounted Space", () => {
		const prefix = `shortcut-left-${++sequence}`;
		const previousId = `${prefix}-previous`;
		const currentId = `${prefix}-current`;
		const previousLeft = fakeGroup("previous-left", "term:previous-left", box(0, 0));
		const previousRight = fakeGroup(
			"previous-right",
			"term:previous-right",
			box(100, 0),
		);
		const previous = fakeDockview([previousLeft, previousRight], "previous-left");
		const current = fakeDockview(
			[fakeGroup("current-left", "term:current-left", box(0, 0))],
			"current-left",
		);
		register(previousId, previous);
		register(currentId, current);
		useStore.setState((state) => ({
			activeSpaceId: currentId,
			layouts: {
				...state.layouts,
				[previousId]: previous.layout,
				[currentId]: current.layout,
			},
			shortcutOverrides: {},
			spaceVisits: {},
			spaces: [
				{ id: previousId, name: "Previous" },
				{ id: currentId, name: "Current" },
			],
			uiPrefs: { ...state.uiPrefs, tabOrder: "manual" },
		}));
		disposers.push(installPaneShortcuts());

		expect(dispatch("ArrowLeft").defaultPrevented).toBe(true);

		expect(useStore.getState().activeSpaceId).toBe(previousId);
		expect(peekPendingPanelFocus(previousId)).toBe("term:previous-left");
		expect(applyPendingPanelFocus(previousId)).toBe(true);
		expect(previousLeft.activePanel.api.setActive).toHaveBeenCalledOnce();
		expect(previousRight.activePanel.api.setActive).not.toHaveBeenCalled();
		expect(previous.focus).toHaveBeenCalledOnce();
	});

	it.each([
		["ArrowLeft", -100, 0],
		["ArrowRight", 100, 0],
		["ArrowUp", 0, -100],
		["ArrowDown", 0, 100],
	] as const)("skips retained hidden geometry for %s without restoring it", (key, dx, dy) => {
		const id = `shortcut-hidden-${++sequence}`;
		const active = fakeGroup("active", "term:active", box(300, 300));
		const hidden = fakeGroup("hidden", "term:hidden", box(300 + dx, 300 + dy));
		hidden.api.isVisible = false;
		const visible = fakeGroup("visible", "term:visible", box(300 + dx * 2, 300 + dy * 2));
		const dockview = fakeDockview([active, hidden, visible], active.id);
		register(id, dockview);
		useStore.setState({ activeSpaceId: id, shortcutOverrides: {} });
		disposers.push(installPaneShortcuts());

		expect(dispatch(key).defaultPrevented).toBe(true);
		expect(hidden.api.setVisible).not.toHaveBeenCalled();
		expect(hidden.activePanel.api.setActive).not.toHaveBeenCalled();
		expect(visible.activePanel.api.setActive).toHaveBeenCalledOnce();
	});

	it.each([
		[false, false], [true, false], [false, true], [true, true],
	])("crosses an edge without reviving hidden panes (mounted: %s, destination all hidden: %s)", (mounted, allHidden) => {
		const id = `shortcut-hidden-edge-${++sequence}`;
		const nextId = `${id}-next`;
		const active = fakeGroup("active", "term:active", box(0, 0));
		const hidden = fakeGroup("hidden", "term:hidden", box(100, 0));
		hidden.api.isVisible = false;
		const current = fakeDockview([active, hidden], active.id);
		const nextHidden = fakeGroup("next-hidden", "term:next-hidden", box(0, 0));
		nextHidden.api.isVisible = false;
		const nextVisible = fakeGroup("next-visible", "term:next-visible", box(100, 0));
		nextVisible.api.isVisible = !allHidden;
		const next = fakeDockview([nextHidden, nextVisible], nextHidden.id);
		register(id, current);
		if (mounted) register(nextId, next);
		useStore.setState((state) => ({
			activeSpaceId: id,
			layouts: { ...state.layouts, [nextId]: next.layout },
			spaces: [{ id, name: "Current" }, { id: nextId, name: "Next" }],
			shortcutOverrides: {},
			uiPrefs: { ...state.uiPrefs, tabOrder: "manual" },
		}));
		disposers.push(installPaneShortcuts());

		expect(dispatch("ArrowRight").defaultPrevented).toBe(true);
		expect(useStore.getState().activeSpaceId).toBe(nextId);
		expect(peekPendingPanelFocus(nextId)).toBe(allHidden ? undefined : nextVisible.activePanel.id);
		if (!mounted) register(nextId, next);
		expect(applyPendingPanelFocus(nextId)).toBe(!allHidden);
		expect(nextVisible.activePanel.api.setActive).toHaveBeenCalledTimes(allHidden ? 0 : 1);
		for (const group of [hidden, nextHidden]) {
			expect(group.api.setVisible).not.toHaveBeenCalled();
			expect(group.activePanel.api.setActive).not.toHaveBeenCalled();
		}
	});

	it.each(["manual", "recent"] as const)("follows the displayed %s tab order and excludes popouts", (tabOrder) => {
		const id = `shortcut-order-${++sequence}`;
		const nextId = `${id}-next`;
		const poppedId = `${id}-popout`;
		const otherId = `${id}-other`;
		register(id, fakeDockview([fakeGroup("active", "term:active", box(0, 0))], "active"));
		useStore.setState((state) => ({
			activeSpaceId: id,
			spaces: [
				{ id, name: "Current" }, { id: poppedId, name: "Popout", kind: "popout" },
				{ id: nextId, name: "Next" }, { id: otherId, name: "Other" },
			],
			spaceVisits: { [id]: 3, [otherId]: 2, [nextId]: 1 },
			layouts: {}, shortcutOverrides: {},
			uiPrefs: { ...state.uiPrefs, tabOrder },
		}));
		disposers.push(installPaneShortcuts());
		expect(dispatch("ArrowRight").defaultPrevented).toBe(true);
		expect(useStore.getState().activeSpaceId).toBe(tabOrder === "manual" ? nextId : otherId);
	});

	it.each([false, true])("keeps directional focus inside the current Space (rebound: %s)", (rebound) => {
		const prefix = `shortcut-inside-${++sequence}`;
		const currentId = `${prefix}-current`;
		const nextId = `${prefix}-next`;
		const currentLeft = fakeGroup("current-left", "term:current-left", box(0, 0));
		const currentRight = fakeGroup(
			"current-right",
			"term:current-right",
			box(100, 0),
		);
		const current = fakeDockview([currentLeft, currentRight], "current-left");
		register(currentId, current);
		useStore.setState((state): Partial<typeof state> => ({
			activeSpaceId: currentId,
			layouts: { ...state.layouts, [currentId]: current.layout },
			shortcutOverrides: rebound
				? { "focus-pane-right": { mod: true, alt: true, shift: true, key: "arrowright" } }
				: {},
			spaceVisits: {},
			spaces: [
				{ id: currentId, name: "Current" },
				{ id: nextId, name: "Next" },
			],
			uiPrefs: { ...state.uiPrefs, tabOrder: "manual" },
		}));
		disposers.push(installPaneShortcuts());

		if (rebound) {
			expect(dispatch("ArrowRight").defaultPrevented).toBe(false);
			expect(currentRight.activePanel.api.setActive).not.toHaveBeenCalled();
		}
		const event = dispatch("ArrowRight", rebound);

		expect(event.defaultPrevented).toBe(true);
		expect(useStore.getState().activeSpaceId).toBe(currentId);
		expect(current.focus).toHaveBeenCalledOnce();
		expect(currentRight.activePanel.api.setActive).toHaveBeenCalledOnce();
		expect(peekPendingPanelFocus(nextId)).toBeUndefined();
	});

	it("does not wrap the first or last Space and leaves vertical edges unchanged", () => {
		const prefix = `shortcut-boundary-${++sequence}`;
		const firstId = `${prefix}-first`;
		const lastId = `${prefix}-last`;
		const first = fakeDockview(
			[fakeGroup("first", "term:first", box(0, 0))],
			"first",
		);
		const last = fakeDockview(
			[fakeGroup("last", "term:last", box(0, 0))],
			"last",
		);
		register(firstId, first);
		register(lastId, last);
		useStore.setState((state) => ({
			activeSpaceId: firstId,
			layouts: {
				...state.layouts,
				[firstId]: first.layout,
				[lastId]: last.layout,
			},
			shortcutOverrides: {},
			spaceVisits: {},
			spaces: [
				{ id: firstId, name: "First" },
				{ id: lastId, name: "Last" },
			],
			uiPrefs: { ...state.uiPrefs, tabOrder: "manual" },
		}));
		disposers.push(installPaneShortcuts());

		expect(dispatch("ArrowLeft").defaultPrevented).toBe(false);
		expect(dispatch("ArrowUp").defaultPrevented).toBe(false);
		expect(useStore.getState().activeSpaceId).toBe(firstId);

		useStore.setState({ activeSpaceId: lastId });
		expect(dispatch("ArrowRight").defaultPrevented).toBe(false);
		expect(useStore.getState().activeSpaceId).toBe(lastId);
	});

	it("does not cross Spaces from a dedicated popout window", () => {
		const prefix = `shortcut-popout-${++sequence}`;
		const mainId = `${prefix}-main`;
		const nextId = `${prefix}-next`;
		const popoutId = `${prefix}-popout`;
		const popout = fakeDockview(
			[fakeGroup("popout", "term:popout", box(0, 0))],
			"popout",
		);
		register(popoutId, popout);
		useStore.setState((state) => ({
			activeSpaceId: mainId,
			layouts: { ...state.layouts, [popoutId]: popout.layout },
			shortcutOverrides: {},
			spaceVisits: {},
			spaces: [
				{ id: mainId, name: "Main" },
				{ id: nextId, name: "Next" },
				{ id: popoutId, name: "Popout", kind: "popout" },
			],
			uiPrefs: { ...state.uiPrefs, tabOrder: "manual" },
		}));
		disposers.push(installPaneShortcuts(popoutId));

		expect(dispatch("ArrowRight").defaultPrevented).toBe(false);
		expect(useStore.getState().activeSpaceId).toBe(mainId);
		expect(peekPendingPanelFocus(nextId)).toBeUndefined();
	});
});
