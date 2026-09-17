// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPluginClaimStatus } from "@/components/plugins/AgentPluginClaimStatus";
import { resetIssueTrackerClaimProjectionResourcesForTests } from "@/components/plugins/useIssueTrackerClaimProjection";
import { resetPluginIssueTrackerWorkspaceResourcesForTests } from "@/components/plugins/usePluginIssueTrackerWorkspace";
import type { IssueTrackerWatchEventV1 } from "@/contracts/generated/extensionContracts";
import type { DureIssueTrackerActivationEvent } from "@/lib/ipc/plugins";
import type {
	DurePluginCatalogEntry,
	DurePluginSettingsSnapshot,
} from "@/lib/plugins/durePlugins";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";
import { pluginPermissionReviewFixture } from "@/test/pluginPermissionFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	catalog: [] as DurePluginCatalogEntry[],
	activationGet: vi.fn(),
	permissionGet: vi.fn(),
	settingsGet: vi.fn(),
	settingsListen: vi.fn(),
	permissionListen: vi.fn(),
	query: vi.fn(),
	subscribe: vi.fn(),
	unsubscribe: vi.fn(),
	activationListeners: [] as Array<
		(event: DureIssueTrackerActivationEvent) => void
	>,
	settingsListeners: [] as Array<
		(snapshot: DurePluginSettingsSnapshot) => void
	>,
	permissionListeners: [] as Array<(snapshot: Record<string, unknown>) => void>,
	watchListeners: [] as Array<(event: IssueTrackerWatchEventV1) => void>,
}));

vi.mock("@/components/plugins/usePluginViewCatalog", () => ({
	usePluginViewCatalog: () => ({
		catalog: mocks.catalog,
		containers: [],
		error: null,
	}),
}));

vi.mock("@/lib/ipc", () => ({
	dureIssueTrackerActivationGet: mocks.activationGet,
	durePluginPermissionGet: mocks.permissionGet,
	durePluginSettingsGet: mocks.settingsGet,
	dureIssueTrackerQuery: mocks.query,
	dureIssueTrackerWatchSubscribe: mocks.subscribe,
	dureIssueTrackerWatchUnsubscribe: mocks.unsubscribe,
	onDureIssueTrackerActivationEvent: vi.fn(async (callback) => {
		mocks.activationListeners.push(callback);
		return vi.fn();
	}),
	onDurePluginSettingsEvent: mocks.settingsListen,
	onDurePluginPermissionEvent: mocks.permissionListen,
	onDureIssueTrackerWatchEvent: vi.fn(async (callback) => {
		mocks.watchListeners.push(callback);
		return vi.fn();
	}),
}));

const agent: Agent = {
	id: "agent-one",
	name: "agent-one",
	displayName: "Agent One",
	provider: "codex",
	projectId: "repo",
	worktreePath: "/work/repo/.worktrees/one",
	branch: "agent/one",
	sessionId: "session-one",
	sessionKind: "pty",
};
const secondAgent: Agent = {
	...agent,
	id: "agent-two",
	name: "agent-two",
	displayName: "Agent Two",
	sessionId: "session-two",
};
const workspaceIdentity = `sha256:${"b".repeat(64)}`;

const catalogEntry = {
	manifest: {
		schema_version: 2,
		id: "dure.beads",
		publisher: "dure",
		version: "0.2.0",
		display_name: "Beads",
		host_api: { min_inclusive: 1, max_inclusive: 2 },
		contributions: [
			{
				id: "dure.beads.issue-tracker",
				family: "dure.issue-tracker",
				family_api: { min_inclusive: 1, max_inclusive: 1 },
				required: true,
				placement: "workspace",
				resource: "./contributions/issue-tracker.json",
			},
			{
				id: "dure.beads.views",
				family: "dure.views",
				family_api: { min_inclusive: 1, max_inclusive: 1 },
				required: true,
				placement: "ui",
				resource: "./contributions/views.json",
			},
		],
	},
	compatibility: {
		status: "supported",
		negotiated_host_api_version: 2,
		contributions: [
			{
				id: "dure.beads.issue-tracker",
				family: "dure.issue-tracker",
				family_api_version: 1,
				placement: "workspace",
			},
			{
				id: "dure.beads.views",
				family: "dure.views",
				family_api_version: 1,
				placement: "ui",
			},
		],
		ignored_optional_contributions: [],
		enabled_agent_integrations: [],
		ignored_optional_agent_integrations: [],
	},
	distribution: "bundled",
	installed: true,
	removable: false,
	settings_contribution: {
		target: {
			identity: {
				source_id: "dure.bundled",
				candidate_id: "dure.beads.bundled",
			},
			plugin_id: "dure.beads",
			version: "0.2.0",
			contribution_id: "dure.beads.settings",
		},
		contribution_id: "dure.beads.settings",
		schema: {
			schema_version: 1,
			settings: [
				{
					kind: "boolean",
					key: "show_agent_claims",
					title: "Pane별 claim",
					description: "Pane별 claim",
					scope: "workspace",
					default: true,
				},
			],
		},
	},
	issue_tracker_contributions: [
		{
			contribution_id: "dure.beads.issue-tracker",
			provider: {
				schema_version: 1,
				provider: "beads",
				operations: ["list", "watch"],
				prefer_repository_wrapper: false,
				repository_wrapper: null,
				mutation_delivery: null,
				agent_binding: {
					kind: "scm_branch_metadata",
					metadata_key: "dure_worktree_branch",
				},
			},
		},
	],
	view_contributions: [
		{
			contribution_id: "dure.beads.views",
			views: {
				schema_version: 1,
				containers: [
					{
						id: "dure.beads.issues",
						location: "primary_sidebar",
						title: { default: "Beads" },
						icon: "list_todo",
					},
				],
				views: [
					{
						id: "dure.beads.issues.list",
						container_id: "dure.beads.issues",
						title: { default: "이슈" },
						kind: "issue_tracker",
						provider_contribution_id: "dure.beads.issue-tracker",
						default_query: "ready",
						default_query_setting_key: null,
						watch_interval_setting_key: null,
						agent_claims: {
							title: { default: "Pane별 claim" },
							setting_key: "show_agent_claims",
							statuses: ["in_progress"],
							surfaces: ["agent_pane_claim_status"],
						},
					},
				],
			},
		},
	],
} satisfies DurePluginCatalogEntry;

function settings(
	showAgentClaims: boolean,
	settingsRevision = "1",
): DurePluginSettingsSnapshot {
	return {
		target: catalogEntry.settings_contribution!.target,
		scope: "workspace",
		scope_key: workspaceIdentity,
		values: { show_agent_claims: showAgentClaims },
		settings_revision: settingsRevision,
		agent_claim_policy_epochs: {
			"dure.beads.issue-tracker": showAgentClaims ? 1 : 2,
		},
	};
}

beforeEach(() => {
	useWindowSidebarStore.setState({ open: false, tab: "spaces", pluginSelection: null });
	mocks.catalog = [catalogEntry];
	mocks.settingsListen.mockImplementation(async (callback) => {
		mocks.settingsListeners.push(callback);
		return vi.fn();
	});
	mocks.permissionListen.mockImplementation(async (callback) => {
		mocks.permissionListeners.push(callback);
		return vi.fn();
	});
	mocks.activationGet.mockResolvedValue(true);
	mocks.unsubscribe.mockResolvedValue(true);
	mocks.permissionGet.mockResolvedValue({
		plan: {
			identity: { plugin_id: "dure.beads" },
			workspace_identity: workspaceIdentity,
			digest: `sha256:${"d".repeat(64)}`,
			permissions: [],
		},
		review: pluginPermissionReviewFixture(
			`sha256:${"d".repeat(64)}`,
			`sha256:${"d".repeat(64)}`,
		),
		record_revision: "2",
		decision_revision: "1",
		enablement_epoch: "2",
		decision: "approve",
		reviewed_plan_digest: `sha256:${"d".repeat(64)}`,
		plan_comparison: "matches_reviewed_plan",
		enabled: true,
	});
	mocks.settingsGet.mockResolvedValue(settings(true));
	mocks.query.mockResolvedValue({
		kind: "list",
		issues: [
			{
				id: "bd-1",
				title: "Claimed work",
				status: "in_progress",
				priority: 1,
				issue_type: "task",
				assignee: null,
				updated_at: null,
				dependency_count: 0,
				dependent_count: 0,
				agent_binding: { kind: "scm_branch", branch: "agent/one" },
			},
		],
		complete: true,
	});
	useStore.setState({
		spaces: [],
		projects: [
			{
				id: "repo",
				name: "Repo",
				path: "/work/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [agent],
		layouts: {},
	});
	useHiddenPanes.setState({ hidden: {} });
});

afterEach(() => {
	cleanup();
	resetIssueTrackerClaimProjectionResourcesForTests();
	resetPluginIssueTrackerWorkspaceResourcesForTests();
	useHiddenPanes.setState({ hidden: {} });
	useStore.setState({ spaces: [], projects: [], agents: [], layouts: {} });
	mocks.activationListeners.length = 0;
	mocks.settingsListeners.length = 0;
	mocks.permissionListeners.length = 0;
	mocks.watchListeners.length = 0;
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("AgentPluginClaimStatus", () => {
	it("opens the sidebar from the claim badge without issuing another claim read", async () => {
		const onNavigate = vi.fn();
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" onNavigate={onNavigate} />);
		const badge = await screen.findByLabelText(/bd-1/);
		const reads = mocks.query.mock.calls.length;
		fireEvent.click(badge);
		expect(useWindowSidebarStore.getState().open).toBe(true);
		expect(useWindowSidebarStore.getState().tab).toBe("plugin");
		expect(useWindowSidebarStore.getState().pluginSelection).toEqual({
			containerKey: JSON.stringify(["dure.beads", "dure.beads.views", "dure.beads.issues"]),
			viewId: "dure.beads.issues.list",
		});
		expect(onNavigate).toHaveBeenCalledOnce();
		expect(badge.tagName).toBe("BUTTON");
		expect(mocks.query).toHaveBeenCalledTimes(reads);
	});

	it("lets multiple claim sources choose their exact tracker view", async () => {
		const entry = structuredClone(catalogEntry);
		const views = entry.view_contributions[0].views.views;
		views.push({ ...views[0], id: "other-view", title: { default: "Other claims" } });
		mocks.catalog = [entry];
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);
		await waitFor(() => expect(screen.getByRole("button", { name: /bd-1/ }).textContent).toBe("2"));
		fireEvent.keyDown(screen.getByRole("button", { name: /bd-1/ }), { key: "ArrowDown" });
		fireEvent.click(await screen.findByRole("menuitem", { name: "Beads · Other claims" }));
		expect(useWindowSidebarStore.getState()).toMatchObject({
			open: true, tab: "plugin", pluginSelection: { viewId: "other-view" },
		});
	});

	it("shows the exact branch-bound claim and stops rendering on a live setting event", async () => {
		mocks.subscribe.mockResolvedValue({
			workspace_key: "local:local:repo",
			generation: 7,
			reused_watcher: false,
			latest: null,
		});
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);
		// The chip is icon plus count; the ids live in the tooltip.
		const chip = await screen.findByLabelText(/bd-1/);
		expect(chip.textContent).toBe("1");
		expect(screen.getByLabelText(/Claimed work/)).toBeTruthy();
		expect(mocks.query).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(mocks.subscribe).toHaveBeenCalledWith(
				expect.objectContaining({
					include_agent_claims: true,
					agent_claim_policy_epoch: 1,
				}),
			),
		);
		expect(mocks.query).toHaveBeenCalledWith(
			expect.objectContaining({ agent_claim_policy_epoch: 1 }),
		);

		act(() => {
			mocks.settingsListeners[0](settings(false, "2"));
		});
		await waitFor(() => expect(screen.queryByLabelText(/bd-1/)).toBeNull());
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it("performs zero claim reads when disabled or not explicitly activated", async () => {
		mocks.settingsGet.mockResolvedValue(settings(false));
		const first = render(
			<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />,
		);
		await waitFor(() => expect(mocks.settingsGet).toHaveBeenCalled());
		expect(mocks.query).not.toHaveBeenCalled();
		first.unmount();
		resetPluginIssueTrackerWorkspaceResourcesForTests();
		mocks.settingsGet.mockResolvedValue(settings(true));
		mocks.activationGet.mockResolvedValue(false);

		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);
		await waitFor(() => expect(mocks.activationGet).toHaveBeenCalledTimes(2));
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("fails closed when the settings snapshot has no claim policy epoch", async () => {
		const staleSettings = settings(true);
		delete staleSettings.agent_claim_policy_epochs;
		mocks.settingsGet.mockResolvedValue(staleSettings);

		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);
		await waitFor(() => expect(mocks.settingsGet).toHaveBeenCalled());

		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
		// No claims means no chip, even for an incomplete read (owner decision
		// 2026-09-03): the chip carries a count or nothing.
		expect(document.querySelector('[data-agent-id="agent-one"]')).toBeNull();
	});

	it("renders no chip and performs zero claim reads when claim visibility settings cannot be read", async () => {
		mocks.settingsGet.mockRejectedValue(new Error("settings unavailable"));
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);

		await waitFor(() => expect(mocks.settingsGet).toHaveBeenCalled());
		await waitFor(() => expect(mocks.activationGet).toHaveBeenCalled());
		expect(document.querySelector('[data-agent-id="agent-one"]')).toBeNull();
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("performs zero claim reads when setting changes cannot be observed", async () => {
		vi.useFakeTimers();
		mocks.settingsListen.mockRejectedValue(
			new Error("settings event unavailable"),
		);
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(mocks.settingsListen).toHaveBeenCalled();
		expect(mocks.settingsGet).not.toHaveBeenCalled();
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		expect(mocks.settingsGet).toHaveBeenCalled();
		expect(document.querySelector('[data-agent-id="agent-one"]')).toBeNull();
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
	});

	it("performs zero claim reads when permission changes cannot be observed", async () => {
		mocks.permissionListen.mockRejectedValue(
			new Error("permission event unavailable"),
		);
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);

		await waitFor(() => expect(mocks.permissionListen).toHaveBeenCalled());
		expect(mocks.permissionGet).not.toHaveBeenCalled();
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
	});

	it("keeps a claim unmatched while a hidden pane has the same branch", async () => {
		useStore.setState({
			agents: [agent, secondAgent],
			spaces: [{ id: "desktop-2", name: "Cold" }],
		});
		useHiddenPanes.setState({
			hidden: {
				[secondAgent.id]: { desktopId: "desktop-2", paneId: `agent:${secondAgent.id}`, at: 1 },
			},
		});
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);
		await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
		expect(screen.queryByLabelText(/bd-1/)).toBeNull();

		act(() => useHiddenPanes.setState({ hidden: {} }));
		expect(await screen.findByLabelText(/bd-1/)).toBeTruthy();
	});

	it("keeps a claim unmatched for a same-branch pane on an unmounted desktop", async () => {
		useStore.setState({
			agents: [agent, secondAgent],
			spaces: [{ id: "desktop-cold", name: "Cold" }],
			layouts: {
				"desktop-cold": {
					panels: {
						"agent:agent-two": { contentComponent: "agent", params: { agentRef: { agentId: secondAgent.id } } },
					},
				},
			},
		});
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);
		await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
		expect(screen.queryByLabelText(/bd-1/)).toBeNull();

		act(() => useStore.setState({ layouts: {} }));
		expect(await screen.findByLabelText(/bd-1/)).toBeTruthy();
	});

	it("ignores same-branch pane ghosts owned by a deleted desktop", async () => {
		useStore.setState({
			agents: [agent, secondAgent],
			spaces: [],
			layouts: {
				"desktop-deleted": {
					panels: {
						"agent:agent-two": { contentComponent: "agent", params: { agentRef: { agentId: secondAgent.id } } },
					},
				},
			},
		});
		useHiddenPanes.setState({
			hidden: {
				[secondAgent.id]: { desktopId: "desktop-deleted", paneId: `agent:${secondAgent.id}`, at: 1 },
			},
		});
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);

		expect(await screen.findByLabelText(/bd-1/)).toBeTruthy();
	});

	it("renders no chip for a partial result with no matched claims", async () => {
		mocks.query.mockResolvedValue({
			kind: "list",
			issues: [],
			complete: false,
		});
		render(<AgentPluginClaimStatus agent={agent} paneId="agent:agent-one" />);
		await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
		// Nothing is shown rather than a count of zero, so a partial read never
		// reads as "no claims".
		expect(document.querySelector('[data-agent-id="agent-one"]')).toBeNull();
		expect(screen.queryByLabelText(/bd-1/)).toBeNull();
	});
});
