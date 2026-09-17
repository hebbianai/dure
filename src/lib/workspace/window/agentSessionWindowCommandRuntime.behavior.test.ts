// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const sourceDesktopId = "desktop-source";
	const sourcePanelId = "agent:agent-source";
	const order: string[] = [];
	const forkedAgent = {
		id: "agent-fork",
		sessionId: "agent-fork",
		displayName: "Fork",
	};
	const state = {
		activeSpaceId: "desktop-other",
		agents: [forkedAgent],
		spaces: [{ id: sourceDesktopId }, { id: "desktop-other" }],
		layouts: {} as Record<string, unknown>,
	};
	let durablePaneDesktopId: string | null = sourceDesktopId;
	let livePaneDesktopId: string | null = null;
	let durableForkPane = false;
	let liveForkPane = false;
	let foregroundPanelId = "agent:other";
	let layoutProjected = false;
	const emptyDepartures = () => ({
		agentIds: new Set<string>(),
		projectIds: new Set<string>(),
		sessionIds: new Set<string>(),
		paneOccurrences: new Set<string>(),
		projectionSpaceIds: new Set<string>(),
	});
	const panel = {
		id: sourcePanelId,
		params: { agentRef: { agentId: "agent-source" } },
		api: { component: "agent", getParameters: () => ({}) },
	};
	const forkPanel = {
		id: `agent:${forkedAgent.id}`,
		params: { agentRef: { agentId: forkedAgent.id } },
		api: { component: "agent", getParameters: () => ({}) },
	};
	const dockviews = new Map(
		[sourceDesktopId, "desktop-moved"].map((desktopId) => [
			desktopId,
			{
				get panels() {
					return layoutProjected && livePaneDesktopId === desktopId
						? [panel, ...(liveForkPane ? [forkPanel] : [])]
						: [];
				},
				getPanel: vi.fn((panelId: string) => {
					if (!layoutProjected || livePaneDesktopId !== desktopId) {
						return undefined;
					}
					if (panelId === sourcePanelId) return panel;
					return liveForkPane && panelId === `agent:${forkedAgent.id}`
						? forkPanel
						: undefined;
				}),
			},
		]),
	);
	const installDurableState = vi.fn(async () => {
		order.push("rehydrate");
		state.layouts = {
			[sourceDesktopId]: {
				panels: {
					...(durablePaneDesktopId === sourceDesktopId
						? {
								[sourcePanelId]: {
									contentComponent: "agent",
									params: panel.params,
								},
							}
						: {}),
					...(durableForkPane
						? {
								[forkPanel.id]: {
									contentComponent: "agent",
									params: forkPanel.params,
								},
							}
						: {}),
				},
			},
			...(durablePaneDesktopId === "desktop-moved"
				? {
						"desktop-moved": {
							panels: {
								[sourcePanelId]: {
									contentComponent: "agent",
									params: panel.params,
								},
							},
						},
					}
				: {}),
		};
	});
	const projectLayoutImplementation = () => {
		order.push("project-layout");
		livePaneDesktopId = durablePaneDesktopId;
		liveForkPane = durableForkPane;
		layoutProjected = true;
		return true;
	};
	const projectLayout = vi.fn(projectLayoutImplementation);
	const waitForDesktop = vi.fn(async (desktopId: string) => {
		order.push(`wait:${desktopId}`);
		return dockviews.get(desktopId);
	});
	const navigateToPanel = vi.fn((desktopId: string, panelId: string) => {
		order.push(`source:${desktopId}:${panelId}`);
		state.activeSpaceId = desktopId;
		foregroundPanelId = panelId;
	});
	const presentAgent = vi.fn((desktopId: string, agent: { id: string }) => {
		order.push(`present:${desktopId}:${agent.id}`);
		durableForkPane = true;
		liveForkPane = true;
		foregroundPanelId = `agent:${agent.id}`;
		return layoutProjected;
	});
	const afterPresentationSettlement = vi.fn(async () => {});
	const releaseProjectionAncestor = vi.fn();
	const reloadCurrentPage = vi.fn();
	const settle = vi.fn(async () => {
		order.push("settle");
		if (presentAgent.mock.calls.length > 0) {
			await afterPresentationSettlement();
		}
		await installDurableState();
		return emptyDepartures();
	});

	return {
		sourceDesktopId,
		sourcePanelId,
		panel,
		forkPanel,
		forkedAgent,
		state,
		order,
		emptyDepartures,
		dockviews,
		installDurableState,
		projectLayout,
		waitForDesktop,
		navigateToPanel,
		presentAgent,
		afterPresentationSettlement,
		releaseProjectionAncestor,
		reloadCurrentPage,
		settle,
		setDurablePaneDesktopId(value: string | null) {
			durablePaneDesktopId = value;
		},
		setLivePaneDesktopId(value: string | null) {
			livePaneDesktopId = value;
		},
		setLayoutProjected(value: boolean) {
			layoutProjected = value;
		},
		setDurableForkPane(value: boolean) {
			durableForkPane = value;
		},
		resetProjectLayout() {
			projectLayout.mockReset().mockImplementation(projectLayoutImplementation);
		},
		foregroundPanelId: () => foregroundPanelId,
	};
});

vi.mock("@/store", () => ({
	durableAppStorage: {
		freezeProjectionAncestor: vi.fn(() => mocks.releaseProjectionAncestor),
	},
	rehydrateAppStoreFromDurableStorage: mocks.installDurableState,
	useStore: { getState: () => mocks.state },
}));

vi.mock("@/lib/platform/pageReload", () => ({
	reloadCurrentPage: mocks.reloadCurrentPage,
}));

vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.presentAgent,
}));

vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	getDockview: (desktopId: string) => mocks.dockviews.get(desktopId),
	waitForDesktopDockview: mocks.waitForDesktop,
}));

vi.mock("@/lib/workspace/dock/panelFocusHandoff", () => ({
	navigateToPanel: mocks.navigateToPanel,
}));

vi.mock("@/lib/workspace/pane/paneVisibility", () => ({
	restorePanePreservingLayout: vi.fn(() => true),
}));

vi.mock("@/lib/persistence/durableAppStateSettlement", () => ({
	settleDurableAppState: mocks.settle,
}));

import { subscribeDurableStoreLayoutProjection } from "@/lib/persistence/durableStoreRehydration";
import { executeAgentSessionWindowCommand } from "./agentSessionWindowCommandRuntime";

const command = {
	action: "present_fork" as const,
	agentId: "agent-source",
	desktopId: mocks.sourceDesktopId,
	panelId: mocks.sourcePanelId,
	forkedAgentId: mocks.forkedAgent.id,
};

describe("source-owned fork presentation", () => {
	let focus: ReturnType<typeof vi.spyOn>;
	let stopProjection: () => void;

	beforeEach(() => {
		mocks.order.length = 0;
		mocks.state.activeSpaceId = "desktop-other";
		mocks.state.layouts = {};
		mocks.setDurablePaneDesktopId(mocks.sourceDesktopId);
		mocks.setLivePaneDesktopId(null);
		mocks.setDurableForkPane(false);
		mocks.panel.params = { agentRef: { agentId: "agent-source" } };
		mocks.forkPanel.params = { agentRef: { agentId: mocks.forkedAgent.id } };
		mocks.setLayoutProjected(false);
		mocks.installDurableState.mockClear();
		mocks.resetProjectLayout();
		mocks.waitForDesktop.mockClear();
		mocks.navigateToPanel.mockClear();
		mocks.presentAgent.mockClear();
		mocks.afterPresentationSettlement.mockReset().mockResolvedValue(undefined);
		mocks.releaseProjectionAncestor.mockReset();
		mocks.reloadCurrentPage.mockReset();
		mocks.settle.mockReset().mockImplementation(async () => {
			mocks.order.push("settle");
			if (mocks.presentAgent.mock.calls.length > 0) {
				await mocks.afterPresentationSettlement();
			}
			await mocks.installDurableState();
			return mocks.emptyDepartures();
		});
		focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
		stopProjection = subscribeDurableStoreLayoutProjection(
			mocks.sourceDesktopId,
			mocks.projectLayout,
		);
	});

	afterEach(() => {
		stopProjection();
		focus.mockRestore();
	});

	it("installs the newer durable layout before presenting into its Dockview", async () => {
		await expect(executeAgentSessionWindowCommand(command)).resolves.toEqual({
			kind: "presented",
		});
		expect(mocks.projectLayout).toHaveBeenCalledTimes(2);
		expect(mocks.order.indexOf("project-layout")).toBeLessThan(
			mocks.order.indexOf(
				`present:${mocks.sourceDesktopId}:${mocks.forkedAgent.id}`,
			),
		);
		expect(mocks.navigateToPanel).toHaveBeenCalledTimes(2);
		expect(
			mocks.order.lastIndexOf(
				`source:${mocks.sourceDesktopId}:${mocks.sourcePanelId}`,
			),
		).toBeLessThan(
			mocks.order.indexOf(
				`present:${mocks.sourceDesktopId}:${mocks.forkedAgent.id}`,
			),
		);
		expect(mocks.foregroundPanelId()).toBe(`agent:${mocks.forkedAgent.id}`);
	});

	it("rejects a persistently failed target projection without touching unrelated listeners", async () => {
		mocks.setLivePaneDesktopId(mocks.sourceDesktopId);
		mocks.setLayoutProjected(true);
		mocks.projectLayout.mockImplementation(() => {
			mocks.order.push("project-layout-failed");
			return false;
		});
		const duplicateProjection = vi.fn(() => true);
		const unrelatedProjection = vi.fn(() => true);
		const stopDuplicate = subscribeDurableStoreLayoutProjection(
			mocks.sourceDesktopId,
			duplicateProjection,
		);
		const stopUnrelated = subscribeDurableStoreLayoutProjection(
			"desktop-unrelated",
			unrelatedProjection,
		);
		try {
			await expect(executeAgentSessionWindowCommand(command)).rejects.toThrow();
			expect(duplicateProjection).toHaveBeenCalledTimes(2);
			expect(unrelatedProjection).not.toHaveBeenCalled();
			expect(mocks.presentAgent).not.toHaveBeenCalled();
			expect(mocks.reloadCurrentPage).toHaveBeenCalledOnce();
		} finally {
			stopDuplicate();
			stopUnrelated();
		}
	});

	it("retries a transient target projection before presenting the fork", async () => {
		mocks.projectLayout.mockImplementationOnce(() => false);

		await expect(executeAgentSessionWindowCommand(command)).resolves.toEqual({
			kind: "presented",
		});

		expect(mocks.projectLayout).toHaveBeenCalledTimes(3);
		expect(mocks.releaseProjectionAncestor).toHaveBeenCalledTimes(2);
		expect(mocks.reloadCurrentPage).not.toHaveBeenCalled();
	});

	it("keeps ordinary background projection for unrelated mounted desktops", async () => {
		focus.mockReturnValue(false);
		const unrelatedProjection = vi.fn(() => true);
		const stopUnrelated = subscribeDurableStoreLayoutProjection(
			"desktop-unrelated",
			unrelatedProjection,
		);
		try {
			await expect(executeAgentSessionWindowCommand(command)).resolves.toEqual({
				kind: "presented",
			});
			expect(unrelatedProjection).toHaveBeenCalledTimes(2);
		} finally {
			stopUnrelated();
		}
	});

	it.each([
		["closed", null],
		["moved", "desktop-moved"],
	] as const)(
		"rejects a %s exact source pane without presenting or acknowledging success",
		async (_state, paneDesktopId) => {
			mocks.setDurablePaneDesktopId(paneDesktopId);
			mocks.setLivePaneDesktopId(paneDesktopId);
			mocks.setLayoutProjected(true);

			await expect(executeAgentSessionWindowCommand(command)).rejects.toThrow();
			expect(mocks.presentAgent).not.toHaveBeenCalled();
			expect(mocks.settle).toHaveBeenCalledOnce();
			expect(mocks.afterPresentationSettlement).not.toHaveBeenCalled();
		},
	);

	it("rejects after durable settlement repeatedly fails", async () => {
		const storageFailure = new Error("storage unavailable");
		mocks.setLivePaneDesktopId(mocks.sourceDesktopId);
		mocks.setLayoutProjected(true);
		mocks.afterPresentationSettlement.mockRejectedValue(storageFailure);

		await expect(executeAgentSessionWindowCommand(command)).rejects.toThrow();
		expect(mocks.presentAgent).toHaveBeenCalledOnce();
		expect(mocks.settle).toHaveBeenCalledTimes(3);
		expect(mocks.reloadCurrentPage).toHaveBeenCalledOnce();
	});

	it("rejects when the exact source closes during durable settlement", async () => {
		mocks.setLivePaneDesktopId(mocks.sourceDesktopId);
		mocks.setLayoutProjected(true);
		mocks.afterPresentationSettlement.mockImplementationOnce(async () => {
			mocks.setDurablePaneDesktopId(null);
		});

		await expect(executeAgentSessionWindowCommand(command)).rejects.toThrow();
		expect(mocks.presentAgent).toHaveBeenCalledOnce();
		expect(mocks.settle).toHaveBeenCalledTimes(2);
	});

	it("rejects when durable settlement removes the presented fork", async () => {
		mocks.setLivePaneDesktopId(mocks.sourceDesktopId);
		mocks.setLayoutProjected(true);
		mocks.afterPresentationSettlement.mockImplementationOnce(async () => {
			mocks.setDurableForkPane(false);
		});

		await expect(executeAgentSessionWindowCommand(command)).rejects.toThrow();
		expect(mocks.presentAgent).toHaveBeenCalledOnce();
		expect(mocks.settle).toHaveBeenCalledTimes(2);
	});

	it.each(["source", "fork"])(
		"rejects when final settlement changes the %s Agent without changing its pane ID",
		async (target) => {
			mocks.afterPresentationSettlement.mockImplementationOnce(async () => {
				const pane = target === "source" ? mocks.panel : mocks.forkPanel;
				pane.params = { agentRef: { agentId: "other-agent" } };
			});
			await expect(executeAgentSessionWindowCommand(command)).rejects.toThrow();
			expect(mocks.presentAgent).toHaveBeenCalledOnce();
			expect(mocks.settle).toHaveBeenCalledTimes(2);
		},
	);

	it("keeps the receipt pending until the source layout is durable", async () => {
		let release!: () => void;
		mocks.setLivePaneDesktopId(mocks.sourceDesktopId);
		mocks.setLayoutProjected(true);
		mocks.afterPresentationSettlement.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		let outcome = "pending";
		const execution = executeAgentSessionWindowCommand(command).then(() => {
			outcome = "presented";
		});

		await vi.waitFor(() => expect(mocks.presentAgent).toHaveBeenCalledOnce());
		await Promise.resolve();
		expect(outcome).toBe("pending");
		release();
		await execution;
		expect(outcome).toBe("presented");
	});
});
