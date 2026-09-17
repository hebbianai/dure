import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	launchDiscovered: vi.fn(),
	mountedEntries: vi.fn(),
	moveAcross: vi.fn(),
	moveWithin: vi.fn(),
	navigateToPanel: vi.fn(),
	openAgentPanel: vi.fn(),
	openAgentPanelOnDesktop: vi.fn(),
}));

vi.mock("@/lib/sessions/launch/discoveredConversationLaunch", () => ({
	launchDiscoveredLocalConversationPane: mocks.launchDiscovered,
}));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.openAgentPanel,
	openAgentPanelOnDesktop: mocks.openAgentPanelOnDesktop,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	mountedDockviewEntries: mocks.mountedEntries,
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/panelFocusHandoff")
	>()),
	navigateToPanel: mocks.navigateToPanel,
}));
vi.mock("@/lib/workspace/pane/paneDropCoordinator", () => ({
	movePanelToDesktopDrop: mocks.moveAcross,
	movePanelWithinDesktopDrop: mocks.moveWithin,
}));

import { launchRecentSessionPane } from "@/lib/sessions/launch/recentSessionPaneLaunch";
import type { RecentSessionDragPayload } from "@/lib/sessions/recentSessionDrag";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const agent: Agent = {
	id: "agent-owner",
	name: "owner",
	provider: "claude",
	projectId: project.id,
	worktreePath: "/repo/app",
	branch: "main",
	sessionId: "session-owner",
	sessionKind: "pty",
	conversationId: "conversation-1",
};

const payload: RecentSessionDragPayload = {
	type: "recent-session",
	provider: "claude",
	conversationId: "conversation-1",
	executionLocation: "local",
	cwd: "/repo/app",
	workspaceRoot: "/repo",
};

const position = {
	referenceGroup: { id: "group-target" },
	direction: "right",
};

function mountedPane(
	id = "agent:agent-owner",
	component = "agent",
	params: Record<string, unknown> = { agentRef: { agentId: agent.id } },
) {
	const panel = { id, params, api: { component, getParameters: () => params } };
	return {
		panels: [panel],
		getPanel: (panelId: string) => (panelId === id ? panel : undefined),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useStore.setState({
		agents: [],
		projects: [],
		layouts: {},
	});
	mocks.mountedEntries.mockReturnValue([]);
	mocks.openAgentPanel.mockReturnValue(true);
	mocks.moveWithin.mockReturnValue(true);
	mocks.moveAcross.mockResolvedValue({
		updates: {},
		movedPanelIds: ["agent:agent-owner"],
		alreadyAtTargetPanelIds: [],
		missingPanelIds: [],
		touchedDesktopIds: ["desktop-source", "desktop-target"],
		projectedDesktopIds: ["desktop-target"],
		projectionFailedDesktopIds: [],
	});
});

describe("launchRecentSessionPane", () => {
	it("passes a new conversation through the existing exact drop placement", async () => {
		mocks.launchDiscovered.mockResolvedValue(agent);

		await launchRecentSessionPane(payload, {
			desktopId: "desktop-target",
			position,
		});

		expect(mocks.launchDiscovered).toHaveBeenCalledWith({
			provider: "claude",
			conversationId: "conversation-1",
			cwd: "/repo/app",
			workspaceRoot: "/repo",
			desktopId: "desktop-target",
			existingOwner: "return",
			position,
		});
		expect(mocks.openAgentPanel).toHaveBeenCalledWith(
			"desktop-target",
			agent,
			position,
		);
	});

	it("moves an already-open exact owner instead of creating a duplicate", async () => {
		useStore.setState({ agents: [agent], projects: [project] });
		mocks.mountedEntries.mockReturnValue([["desktop-source", mountedPane()]]);

		await launchRecentSessionPane(
			{ ...payload, ownerAgentId: agent.id },
			{ desktopId: "desktop-target", position },
		);

		expect(mocks.moveAcross).toHaveBeenCalledWith(
			{
				panelId: "agent:agent-owner",
				fromDesktopId: "desktop-source",
			},
			"desktop-target",
			position,
		);
		expect(mocks.navigateToPanel).toHaveBeenCalledWith(
			"desktop-target",
			"agent:agent-owner",
		);
		expect(mocks.launchDiscovered).not.toHaveBeenCalled();
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("moves an owner opened concurrently on another desktop to the drop target", async () => {
		mocks.launchDiscovered.mockResolvedValue(agent);
		mocks.mountedEntries.mockReturnValue([["desktop-source", mountedPane()]]);

		await launchRecentSessionPane(payload, {
			desktopId: "desktop-target",
			position,
		});

		expect(mocks.moveAcross).toHaveBeenCalledWith(
			{
				panelId: "agent:agent-owner",
				fromDesktopId: "desktop-source",
			},
			"desktop-target",
			position,
		);
		expect(mocks.navigateToPanel).toHaveBeenCalledWith(
			"desktop-target",
			"agent:agent-owner",
		);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("keeps an ordinary click as navigation without pane movement", async () => {
		useStore.setState({ agents: [agent], projects: [project] });
		useStore.setState({
			layouts: {
				"desktop-existing": {
					panels: {
						"agent:agent-owner": { contentComponent: "agent", params: {} },
					},
				},
			},
		});

		await launchRecentSessionPane(
			{ ...payload, ownerAgentId: agent.id },
			{ desktopId: "desktop-target" },
		);

		expect(mocks.navigateToPanel).toHaveBeenCalledWith(
			"desktop-existing",
			"agent:agent-owner",
		);
		expect(mocks.moveAcross).not.toHaveBeenCalled();
		expect(mocks.moveWithin).not.toHaveBeenCalled();
	});

	it.each(["slot", "launcher:previous", "term:previous", "agent:previous"])(
		"moves the current Agent reference in %s without creating another pane",
		async (panelId) => {
			useStore.setState({ agents: [agent], projects: [project] });
			mocks.mountedEntries.mockReturnValue([
				["desktop-source", mountedPane(panelId)],
			]);
			mocks.moveAcross.mockResolvedValueOnce({ movedPanelIds: [panelId] });
			await launchRecentSessionPane(
				{ ...payload, ownerAgentId: agent.id },
				{ desktopId: "desktop-target", position },
			);
			expect(mocks.moveAcross).toHaveBeenCalledWith(
				{ panelId, fromDesktopId: "desktop-source" },
				"desktop-target",
				position,
			);
			expect(mocks.navigateToPanel).toHaveBeenCalledWith(
				"desktop-target",
				panelId,
			);
			expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		},
	);

	it.each(["agent", "terminal", "launcher"])(
		"does not navigate to a historical Agent ID with invalid or changed %s content",
		async (component) => {
			useStore.setState({ agents: [agent], projects: [project] });
			mocks.mountedEntries.mockReturnValue([
				[
					"desktop-source",
					mountedPane("agent:agent-owner", component, { agentRef: null }),
				],
			]);
			await launchRecentSessionPane(
				{ ...payload, ownerAgentId: agent.id },
				{ desktopId: "desktop-target" },
			);
			expect(mocks.navigateToPanel).not.toHaveBeenCalled();
			expect(mocks.openAgentPanelOnDesktop).toHaveBeenCalledWith(
				"desktop-target",
				agent,
			);
		},
	);

	it("uses mounted absence instead of a stale saved pane, while retaining an unmounted exact pane", async () => {
		useStore.setState({
			agents: [agent],
			projects: [project],
			layouts: {
				"desktop-stale": {
					panels: {
						"agent:agent-owner": { contentComponent: "agent", params: {} },
					},
				},
				"desktop-current": {
					panels: {
						"retained-slot": {
							contentComponent: "agent",
							params: { agentRef: { agentId: agent.id } },
						},
					},
				},
			},
		});
		mocks.mountedEntries.mockReturnValue([
			["desktop-stale", { panels: [], getPanel: () => undefined }],
		]);
		await launchRecentSessionPane(
			{ ...payload, ownerAgentId: agent.id },
			{ desktopId: "desktop-target" },
		);
		expect(mocks.navigateToPanel).toHaveBeenCalledWith(
			"desktop-current",
			"retained-slot",
		);
		expect(mocks.openAgentPanelOnDesktop).not.toHaveBeenCalled();
	});

	it("fails closed when the projected owner no longer matches", async () => {
		useStore.setState({
			agents: [{ ...agent, conversationId: "conversation-changed" }],
			projects: [project],
		});

		await expect(
			launchRecentSessionPane(
				{ ...payload, ownerAgentId: agent.id },
				{ desktopId: "desktop-target", position },
			),
		).rejects.toThrow("recent_session_owner_changed");
		expect(mocks.moveAcross).not.toHaveBeenCalled();
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});
});
