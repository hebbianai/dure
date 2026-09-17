// @vitest-environment jsdom

import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	commitDesktopPaneMove,
	movePanelsToDesktop,
} from "@/lib/workspace/dock";
import { planDesktopPaneMove } from "@/lib/workspace/desktop/desktopPaneMove";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";
import { popOutPanels } from "@/lib/workspace/window/popout";
import { useHiddenFilePanes } from "./hiddenFilePanesStore";
import { markPaneHidden, useHiddenPanes } from "./hiddenPanesStore";
import { commitDesktopPaneDrop } from "./paneDropCommit";
import {
	hidePanePreservingLayout,
	retargetMovedHiddenPanes,
	restorePanePreservingLayout,
} from "./paneVisibility";

const handoff = vi.hoisted(() => ({ afterCommit: () => {} }));
vi.mock("@/lib/agents/chat/agentChatDraftMoveCoordinator", () => ({
	withAgentChatDraftMoves: async (
		_items: unknown,
		_destination: unknown,
		commit: () => unknown,
	) => {
		const receipt = await commit();
		handoff.afterCommit();
		return receipt;
	},
}));
vi.mock("@/lib/workspace/window/windows", () => ({
	openPopoutWindow: async () => true,
}));

const cleanup: Array<() => void> = [];
const file = { path: "/fixture/report.txt", source: "local" as const };

function dock(desktopId: string): DockviewApi {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(900, 600);
	registerDockview(desktopId, api);
	cleanup.push(() => {
		unregisterDockview(desktopId, api);
		api.dispose();
		element.remove();
	});
	return api;
}

function sourcePane(
	id = "pane-stable",
	component = "agent",
	params = {
		agentRef: { agentId: "current" },
	} as Record<string, unknown>,
) {
	const api = dock("source");
	api.addPanel({ id, component, params });
	useStore.getState().saveLayout("source", api.toJSON());
	return api;
}

function movedPlan(api: DockviewApi, panelId: string) {
	return planDesktopPaneMove(
		{ source: api.toJSON() },
		[{ panelId, fromDesktopId: "source" }],
		"target",
	);
}

beforeEach(() => {
	handoff.afterCommit = () => {};
	useStore.setState({
		agents: [],
		projects: [],
		spaces: ["source", "target", "other"].map((id) => ({ id, name: id })),
		activeSpaceId: "source",
		layouts: {},
		chatDrafts: {},
		chatDraftMoves: {},
	});
	useHiddenPanes.setState({
		hidden: {
			old: { desktopId: "source", paneId: "agent:old", at: 1 },
			current: { desktopId: "source", paneId: "pane-stable", at: 2 },
			other: { desktopId: "other", paneId: "agent:other", at: 3 },
		},
	});
	useHiddenFilePanes.setState({ hidden: {} });
});

afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
	useHiddenPanes.setState({ hidden: {} });
	useHiddenFilePanes.setState({ hidden: {} });
	vi.restoreAllMocks();
});

describe("restoring current pane content", () => {
	it.each([
		["pane-stable", "agent", { agentRef: { agentId: "current" } }, "current"],
		["agent:old", "agent", { agentRef: { agentId: "current" } }, "current"],
		["file:old", "agent", { agentRef: { agentId: "current" } }, "current"],
		["agent:old", "agent", {}, undefined],
		["agent:old", "agent", { agentRef: null }, undefined],
		["agent:old", "agent", { agentRef: {} }, undefined],
		["agent:old", "terminal", { agentRef: { agentId: "current" } }, undefined],
		["agent:old", "launcher", {}, undefined],
		["agent:old", "unknown", {}, undefined],
	] as const)(
		"uses current %s / %s content and reference (%j)",
		(id, component, params, cleared) => {
			const api = sourcePane(id, component, params);
			api.addPanel({
				id: "sibling",
				component: "terminal",
				position: { referencePanel: id, direction: "right" },
			});
			const before = { ...useHiddenPanes.getState().hidden };
			expect(hidePanePreservingLayout(api, id)).toBe(true);
			api.fromJSON(api.toJSON());
			const panel = api.getPanel(id)!;
			expect(panel.group.api.isVisible).toBe(false);
			expect(restorePanePreservingLayout(api, id)).toBe(true);
			expect(panel.group.api.isVisible).toBe(true);
			expect(api.activePanel?.id).toBe(id);
			expect(api.getPanel("sibling")).toBeDefined();
			if (cleared) delete before[cleared];
			expect(useHiddenPanes.getState().hidden).toEqual(before);
			const after = useHiddenPanes.getState().hidden;
			expect(restorePanePreservingLayout(api, id)).toBe(true);
			expect(useHiddenPanes.getState().hidden).toBe(after);
		},
	);

	it("reads the model's current Agent reference after a parameter update", () => {
		const api = sourcePane("agent:old", "agent", {
			agentRef: { agentId: "old" },
		});
		api
			.getPanel("agent:old")!
			.api.updateParameters({ agentRef: { agentId: "current" } });
		restorePanePreservingLayout(api, "agent:old");
		expect(useHiddenPanes.getState().hidden.current).toBeUndefined();
		expect(useHiddenPanes.getState().hidden.old).toEqual({
			desktopId: "source",
			paneId: "agent:old",
			at: 1,
		});
	});

	it.each([
		["pane-file", "fileviewer", true],
		["agent:old", "fileviewer", true],
		["file:old", "terminal", false],
		["file:old", "unknown", false],
	] as const)(
		"clears only the restored file content (%s / %s)",
		(id, component, cleared) => {
			const api = sourcePane(id, component, file);
			const record = { desktopId: "source", at: 4, file };
			useHiddenFilePanes.setState({ hidden: { [id]: record } });
			const agents = useHiddenPanes.getState().hidden;
			restorePanePreservingLayout(api, id);
			expect(useHiddenFilePanes.getState().hidden[id]).toEqual(
				cleared ? undefined : record,
			);
			expect(useHiddenPanes.getState().hidden).toBe(agents);
		},
	);
});

describe("projecting the committed movement of hidden panes", () => {
	it.each([
		["pane-stable", "agent", { agentRef: { agentId: "current" } }, "current"],
		["agent:old", "agent", { agentRef: { agentId: "current" } }, "current"],
		["agent:old", "agent", {}, "old"],
		["agent:old", "agent", { agentRef: null }, undefined],
		["agent:old", "terminal", {}, undefined],
		["agent:old", "unknown", {}, undefined],
	] as const)(
		"follows committed %s / %s content (%j)",
		(id, component, params, moved) => {
			const api = sourcePane(id, component, params);
			const before = { ...useHiddenPanes.getState().hidden };
			const plan = movedPlan(api, id);
			expect(
				retargetMovedHiddenPanes(plan, "target", plan.updates.target),
			).toBe(plan);
			if (moved) {
				expect(useHiddenPanes.getState().hidden[moved]).toMatchObject({
					desktopId: "target",
				});
				delete before[moved];
			}
			for (const [agentId, record] of Object.entries(before))
				expect(useHiddenPanes.getState().hidden[agentId]).toBe(record);
			const after = useHiddenPanes.getState().hidden;
			retargetMovedHiddenPanes(plan, "target", plan.updates.target);
			expect(useHiddenPanes.getState().hidden).toBe(after);
		},
	);

	it("preserves a hidden record belonging to an unaffected Space", () => {
		const api = sourcePane("agent:other", "agent", {
			agentRef: { agentId: "other" },
		});
		const before = useHiddenPanes.getState().hidden;
		const plan = movedPlan(api, "agent:other");
		retargetMovedHiddenPanes(plan, "target", plan.updates.target);
		expect(useHiddenPanes.getState().hidden).toBe(before);
	});

	it("does not manufacture a move from missing, failed or uncommitted receipt IDs", () => {
		const api = sourcePane("agent:old");
		const plan = movedPlan(api, "agent:old");
		const before = useHiddenPanes.getState().hidden;
		retargetMovedHiddenPanes(
			{ ...plan, movedPanelIds: [] },
			"target",
			plan.updates.target,
		);
		retargetMovedHiddenPanes({ ...plan, updates: {} }, "target", undefined);
		retargetMovedHiddenPanes(
			{ ...plan, movedPanelIds: ["agent:missing"] },
			"target",
			plan.updates.target,
		);
		expect(useHiddenPanes.getState().hidden).toBe(before);
	});

	it("leaves target-only and missing panes out of a partial move's hidden records", () => {
		const source = sourcePane("agent:old");
		const target = dock("target");
		target.addPanel({
			id: "agent:other",
			component: "agent",
			params: { agentRef: { agentId: "other" } },
		});
		const other = useHiddenPanes.getState().hidden.other;
		const plan = planDesktopPaneMove(
			{ source: source.toJSON(), target: target.toJSON() },
			[
				{ panelId: "agent:old", fromDesktopId: "source" },
				{ panelId: "agent:missing", fromDesktopId: "source" },
			],
			"target",
		);
		expect(plan.movedPanelIds).toEqual(["agent:old"]);
		expect(plan.missingPanelIds).toEqual(["agent:missing"]);
		retargetMovedHiddenPanes(plan, "target", plan.updates.target);
		expect(useHiddenPanes.getState().hidden.current?.desktopId).toBe("target");
		expect(useHiddenPanes.getState().hidden.other).toBe(other);
	});

	it.each([
		["pane-file", "fileviewer", true],
		["agent:old", "fileviewer", true],
		["file:old", "terminal", false],
	] as const)(
		"moves only committed file content (%s / %s)",
		(id, component, moved) => {
			const api = sourcePane(id, component, file);
			const record = { desktopId: "source", at: 4, file };
			useHiddenFilePanes.setState({ hidden: { [id]: record } });
			const plan = movedPlan(api, id);
			retargetMovedHiddenPanes(plan, "target", plan.updates.target);
			expect(useHiddenFilePanes.getState().hidden[id]).toMatchObject({
				desktopId: moved ? "target" : "source",
				file,
			});
			expect(useHiddenPanes.getState().hidden.old?.desktopId).toBe("source");
		},
	);

	it("updates the hidden record with the durable move even if a mounted projection fails", () => {
		const api = sourcePane();
		const plan = movedPlan(api, "pane-stable");
		vi.spyOn(api, "fromJSON").mockImplementation(() => {
			throw new Error("projection unavailable");
		});
		const receipt = commitDesktopPaneMove(plan, "target");
		expect(receipt.projectionFailedDesktopIds).toEqual(["source"]);
		expect(panelsFromLayout(useStore.getState().layouts.source)).toEqual([]);
		expect(useHiddenPanes.getState().hidden.current?.desktopId).toBe("target");
	});

	it.each([true, false])(
		"includes target-owned drop (source mounted: %s)",
		(mounted) => {
			const source = sourcePane();
			if (!mounted) unregisterDockview("source", source);
			const target = dock("target");
			target.addPanel({ id: "target-sibling", component: "terminal" });
			const receipt = commitDesktopPaneDrop(
				{ panelId: "pane-stable", fromDesktopId: "source" },
				"target",
				{ direction: "right" },
			);
			expect(receipt.error).toBeUndefined();
			expect(receipt.movedPanelIds).toEqual(["pane-stable"]);
			expect(target.getPanel("pane-stable")?.params).toEqual({
				agentRef: { agentId: "current" },
			});
			expect(panelsFromLayout(useStore.getState().layouts.source)).toEqual([]);
			expect(useHiddenPanes.getState().hidden.current?.desktopId).toBe(
				"target",
			);
		},
	);

	it("keeps hidden records and the source when the target rejects the drop", () => {
		const source = sourcePane();
		const target = dock("target");
		const before = source.toJSON();
		const hidden = useHiddenPanes.getState().hidden;
		vi.spyOn(target, "addPanel").mockImplementation(() => {
			throw new Error("target refused");
		});
		const receipt = commitDesktopPaneDrop(
			{ panelId: "pane-stable", fromDesktopId: "source" },
			"target",
			{ direction: "right" },
		);
		expect(receipt.error?.code).toBe("target_projection_failed");
		expect(source.toJSON()).toEqual(before);
		expect(useHiddenPanes.getState().hidden).toBe(hidden);
	});

	it("retargets a hidden record when duplicate cleanup leaves the existing target unchanged", async () => {
		sourcePane("agent:current");
		const target = dock("target");
		const panel = target.addPanel({
			id: "agent:current",
			component: "agent",
			params: { agentRef: { agentId: "current" } },
		});
		useStore.getState().saveLayout("target", target.toJSON());
		const receipt = await movePanelsToDesktop(
			[{ panelId: "agent:current", fromDesktopId: "source" }],
			"target",
		);
		expect(receipt.movedPanelIds).toEqual(["agent:current"]);
		expect(receipt.updates.target).toBeUndefined();
		expect(target.getPanel("agent:current")).toBe(panel);
		expect(useHiddenPanes.getState().hidden.current?.desktopId).toBe("target");
	});

	it.each(["ordinary", "popout"] as const)(
		"does not overwrite a later hide after delayed %s completion",
		async (kind) => {
			sourcePane("agent:current");
			let desktopAtCommit: string | undefined;
			handoff.afterCommit = () => {
				desktopAtCommit = useHiddenPanes.getState().hidden.current?.desktopId;
				markPaneHidden("current", "other", "agent:current", {
					referencePanelId: "new-neighbor",
					direction: "left",
				});
			};
			let target: string | null = "target";
			if (kind === "popout") {
				target = await popOutPanels("source", ["agent:current"]);
			} else {
				await movePanelsToDesktop(
					[{ panelId: "agent:current", fromDesktopId: "source" }],
					target,
				);
			}
			expect(target).toBeTruthy();
			expect(desktopAtCommit).toBe(target);
			expect(useHiddenPanes.getState().hidden.current).toMatchObject({
				desktopId: "other",
				anchor: { referencePanelId: "new-neighbor", direction: "left" },
			});
		},
	);
});
