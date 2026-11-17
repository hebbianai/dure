// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanelOnDesktop: vi.fn(),
	openSshTerminalPanelOnDesktop: vi.fn(),
	openTerminalPanelOnDesktop: vi.fn(),
}));
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => ["claude", "codex"],
}));

import {
	type SpacesRowListBindings,
	SpacesOpenRowList,
} from "@/components/spaces/SpacesOpenRowList";
import { useSpaces } from "@/components/spaces/useSpaces";
import { t } from "@/lib/i18n";
import { useSpacesCollapsedGroups } from "@/lib/spaces/spacesCollapsedGroupsStore";
import { leadWorkersFoldKey } from "@/lib/spaces/spacesHierarchy";
import { useStore } from "@/store";

function agent(
	id: string,
	sessionId: string,
	runParent?: Agent["runParent"],
): Agent {
	return {
		id,
		name: id,
		provider: "claude",
		projectId: "repo",
		worktreePath: "/repo",
		branch: "main",
		sessionId,
		sessionKind: "pty",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId,
			workspaceId: "ws",
		},
		...(runParent ? { runParent } : {}),
	};
}

const parent = { sessionId: "s-lead", workspaceId: "ws" };

function seed() {
	// Store order is start order: work-551, work-552, work-553.
	const agents = [
		agent("lead", "s-lead"),
		agent("work-551", "s-551", parent),
		agent("work-552", "s-552", parent),
		agent("work-553", "s-553", parent),
		agent("solo", "s-solo"),
	];
	// Dockview order scatters the workers around the lead.
	const panelOrder = ["work-553", "solo", "lead", "work-551", "work-552"];
	useStore.setState({
		spaces: [{ id: "desk-1", name: "Build" }],
		activeSpaceId: "desk-1",
		projects: [{ id: "repo", name: "Repo", path: "/repo", kind: "local", isRepo: true }],
		agents,
		layouts: {
			"desk-1": {
				panels: Object.fromEntries(
					panelOrder.map((id) => [`agent:${id}`, { contentComponent: "agent", params: {} }]),
				),
			},
		},
		// The provider's terminal title is the same for every worker.
		sessionTitle: Object.fromEntries(
			agents.map((entry) => [entry.sessionId, "Claude Code"]),
		),
	});
}

const bindings: SpacesRowListBindings = {
	visibleFields: ["details"],
	showSpaces: true,
	diffCapabilities: new Map(),
	selected: new Set(),
	contextMenuKey: null,
	conversionBusyKeys: new Set(),
	selectedPromotionEligible: 0,
	selectedPromotionDeferred: 0,
	onSpaceClick: vi.fn(),
	onContextMenuOpenChange: vi.fn(),
	onRowDragStart: vi.fn(),
	onRowDragEnd: vi.fn(),
	menuHandlers: {
		onViewDiff: vi.fn(),
		onMoveToDesktop: vi.fn(),
		onMoveToNewDesktop: vi.fn(),
		onRestart: vi.fn(),
		onFork: vi.fn(),
		onPromoteManaged: vi.fn(),
		onSwitchAccount: vi.fn(),
		onKill: vi.fn(),
	},
	killConfirm: null,
	onKillConfirm: vi.fn(),
	onKillCancel: vi.fn(),
};

function Sidebar() {
	const rows = useSpaces();
	return <SpacesOpenRowList spaces={rows} spaceHeading {...bindings} />;
}

function drawnRows(): string[] {
	return [...document.querySelectorAll<HTMLElement>("[data-space-key]")].map(
		(row) => row.dataset.spaceKey ?? "",
	);
}

afterEach(() => {
	cleanup();
	useSpacesCollapsedGroups.setState({ collapsed: {} });
	useStore.setState({ agents: [], layouts: {}, projects: [], sessionTitle: {}, focusCtx: null });
});

describe("lead and worker rows", () => {
	it("nests a lead's three workers under it in start order, each named for its Run", () => {
		seed();
		render(<Sidebar />);

		expect(drawnRows()).toEqual([
			"agent:solo",
			"agent:lead",
			"agent:work-551",
			"agent:work-552",
			"agent:work-553",
		]);
		const fold = document.querySelector('[data-slot="lead-workers"]');
		for (const name of ["work-551", "work-552", "work-553"]) {
			const row = document.querySelector(`[data-space-key="agent:${name}"]`);
			expect(fold?.contains(row)).toBe(true);
			// The Run name is the title; the provider's title moves to the info line.
			expect(row?.textContent).toContain(name);
			expect(row?.textContent).toContain("Claude Code");
		}
		// Agents without a parent keep the provider's title and stay top-level.
		const solo = document.querySelector('[data-space-key="agent:solo"]');
		expect(fold?.contains(solo)).toBe(false);
		expect(solo?.textContent).toContain("Claude Code");
		expect(solo?.textContent).not.toContain("solo");
	});

	it("folds the workers behind an \"N workers\" summary that holds per lead", () => {
		seed();
		render(<Sidebar />);

		const label = t("spaces.workers.other", { n: 3 });
		const summary = screen.getByText(label);
		act(() => {
			fireEvent.click(summary);
			const details = summary.closest("details");
			if (details) details.open = false;
			details?.dispatchEvent(new Event("toggle"));
		});

		expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({
			[leadWorkersFoldKey("lead")]: true,
		});
		expect(drawnRows()).toEqual(["agent:solo", "agent:lead"]);
		expect(screen.getByText(label)).toBeTruthy();
	});

	it("keeps the focused worker in sight behind a closed fold", () => {
		seed();
		useSpacesCollapsedGroups.setState({
			collapsed: { [leadWorkersFoldKey("lead")]: true },
		});
		useStore.setState({ focusCtx: { key: "agent:work-552", kind: "agent" } as never });
		render(<Sidebar />);

		expect(drawnRows()).toEqual(["agent:solo", "agent:lead", "agent:work-552"]);
	});
});
