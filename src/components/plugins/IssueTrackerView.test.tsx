// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";

const mocks = vi.hoisted(() => ({
	activate: vi.fn(),
	activationGet: vi.fn(),
	permissionGet: vi.fn(),
	query: vi.fn(),
	settings: vi.fn(),
	subscribe: vi.fn(),
	unsubscribe: vi.fn(),
	listen: vi.fn(),
	listenActivation: vi.fn(),
	listenSettings: vi.fn(),
	listenPermission: vi.fn(),
	activationListeners: [] as Array<(event: Record<string, unknown>) => void>,
	settingsListeners: [] as Array<(event: Record<string, unknown>) => void>,
	permissionListeners: [] as Array<(event: Record<string, unknown>) => void>,
	useSpaces: vi.fn(),
	copyText: vi.fn(),
	openCommandPane: vi.fn(),
	openAgent: vi.fn(),
	quickDispatch: vi.fn(),
	readFile: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	dureIssueTrackerActivate: mocks.activate,
	dureIssueTrackerActivationGet: mocks.activationGet,
	durePluginPermissionGet: mocks.permissionGet,
	dureIssueTrackerQuery: mocks.query,
	dureIssueTrackerWatchSubscribe: mocks.subscribe,
	dureIssueTrackerWatchUnsubscribe: mocks.unsubscribe,
	durePluginSettingsGet: mocks.settings,
	onDureIssueTrackerWatchEvent: mocks.listen,
	onDureIssueTrackerActivationEvent: mocks.listenActivation,
	onDurePluginSettingsEvent: mocks.listenSettings,
	onDurePluginPermissionEvent: mocks.listenPermission,
	readFile: mocks.readFile,
}));

// Store writes stay real; this jsdom fixture has no native peer window to notify.
vi.mock("@/lib/workspace/window/durableStoreBroadcast", () => ({
	publishDurableStoreChanged: vi.fn(async () => undefined),
}));

vi.mock("@/components/spaces/useSpaces", () => ({
	useSpaces: mocks.useSpaces,
}));

vi.mock("@/lib/platform/clipboardWrite", () => ({
	copyTextToClipboard: mocks.copyText,
}));

vi.mock("@/lib/workspace/dock/openCommandTerminal", () => ({
	openCommandTerminalPanel: mocks.openCommandPane,
}));

vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanelOnDesktop: mocks.openAgent,
}));

vi.mock("@/lib/agents/quickDispatch/quickDispatchActivation", () => ({
	requestQuickDispatch: mocks.quickDispatch,
}));

import { IssueTrackerView } from "@/components/plugins/IssueTrackerView";
import { resetIssueTrackerClaimProjectionResourcesForTests } from "@/components/plugins/useIssueTrackerClaimProjection";
import { resetPluginIssueTrackerWorkspaceResourcesForTests } from "@/components/plugins/usePluginIssueTrackerWorkspace";
import type { IssueTrackerWatchEventV1 } from "@/contracts/generated/extensionContracts";
import type { DurePluginSettingsTargetV2 } from "@/lib/plugins/durePlugins";
import { useStore } from "@/store";
import { pluginPermissionReviewFixture } from "@/test/pluginPermissionFixtures";

const summary = {
	id: "hebbian-frontend-kacd.4",
	title: "Dure plugin catalog와 설치 lifecycle 구현",
	status: "in_progress",
	priority: 1,
	issue_type: "feature",
	assignee: "codex",
	updated_at: null,
	dependency_count: 1,
	dependent_count: 0,
	agent_binding: null,
};
const counts = { ready: 7, open: 12, blocked: 3 };
const settingsTarget: DurePluginSettingsTargetV2 = {
	identity: {
		source_id: "dure.bundled",
		candidate_id: "dure.beads.bundled",
	},
	plugin_id: "dure.beads",
	version: "0.2.0",
	contribution_id: "dure.beads.settings",
};
const workspaceIdentity = `sha256:${"b".repeat(64)}`;

type TrackerProps = ComponentProps<typeof IssueTrackerView>;

/** Renders the tracker with the canonical Beads wiring; overrides vary one axis per test. */
const renderTracker = (overrides: Partial<TrackerProps> = {}) =>
	render(
		<IssueTrackerView
			pluginName="Beads"
			pluginId="dure.beads"
			viewContributionId="dure.beads.views"
			contributionId="dure.beads.issue-tracker"
			viewId="dure.beads.issues.list"
			defaultQuery="ready"
			settingsTarget={settingsTarget}
			operations={["ready", "list", "show"]}
			{...overrides}
		/>,
	);

const paneClaims: TrackerProps["agentClaims"] = {
	title: "Pane별 claim",
	settingKey: "show_agent_claims",
	statuses: ["in_progress"],
	defaultVisible: true,
};

/** Workspace-scoped settings payload; value overrides and the claim policy epoch are the axes. */
const settingsPayload = (values: Record<string, unknown> = {}, epoch = 1) => ({
	target: settingsTarget,
	scope: "workspace",
	scope_key: workspaceIdentity,
	values: {
		default_view: "ready",
		watch_interval_seconds: 30,
		show_agent_claims: true,
		...values,
	},
	settings_revision: "1",
	agent_claim_policy_epochs: { "dure.beads.issue-tracker": epoch },
});

const subscribeResult = (
	generation: number,
	reused = false,
	latest: IssueTrackerWatchEventV1 | null = null,
) => ({
	workspace_key: "local:local:repo",
	generation,
	reused_watcher: reused,
	latest,
});

const snapshotOf = (issues: (typeof summary)[]) => ({
	issues,
	issues_complete: true,
	human_issues: [],
	human_issues_complete: true,
	agent_claim_issues: [],
	agent_claim_issues_complete: true,
});

const watchSnapshotEvent = ({
	generation,
	revision,
	snapshot,
	digest = `digest-${revision}`,
	pluginId = "dure.beads",
	contributionId = "dure.beads.issue-tracker",
	workspaceKey = "local:local:repo",
}: {
	generation: number;
	revision: number;
	snapshot: ReturnType<typeof snapshotOf>;
	digest?: string;
	pluginId?: string;
	contributionId?: string;
	workspaceKey?: string;
}): IssueTrackerWatchEventV1 => ({
	plugin_id: pluginId,
	contribution_id: contributionId,
	workspace_key: workspaceKey,
	generation,
	revision,
	state: { kind: "snapshot", revision_digest: digest, snapshot },
});

/** Moves the store focus to the unrelated /work/other local repo. */
const switchWorkspaceToOther = () =>
	act(() => {
		useStore.setState({
			focusCtx: { cwd: "/work/other", source: "local", label: "Other" },
			projects: [
				{
					id: "other",
					name: "Other",
					path: "/work/other",
					kind: "local",
					isRepo: true,
				},
			],
		});
	});

/** Registers the single codex agent pane the claim projection reads. */
const installAgentPane = (extra: { displayName?: string } = {}) => {
	useStore.setState({
		agents: [
			{
				id: "agent-one",
				name: "agent-one",
				provider: "codex",
				projectId: "repo",
				worktreePath: "/work/repo/.worktrees/one",
				branch: "agent/one",
				sessionId: "session-one",
				sessionKind: "pty",
				...extra,
			},
		],
	});
	mocks.useSpaces.mockReturnValue([
		{ key: "agent:agent-one", kind: "agent", agentId: "agent-one" },
	]);
};

/** The full tracker query request for the fixture workspace. */
const queryRequest = (
	query: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) => ({
	plugin_id: "dure.beads",
	contribution_id: "dure.beads.issue-tracker",
	workspace_root: "/work/repo",
	...extra,
	query,
});

beforeEach(() => {
	useWindowSidebarStore.setState({ pluginSelection: null });
	useStore.setState({
		activeSpaceId: "space-1",
		focusCtx: {
			cwd: "/work/repo",
			source: "local",
			label: "Repo",
		},
		projects: [
			{
				id: "repo",
				name: "Repo",
				path: "/work/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [],
	});
	mocks.activationGet.mockResolvedValue(true);
	mocks.unsubscribe.mockResolvedValue(true);
	mocks.permissionGet.mockImplementation(
		async ({ plugin_id }: { plugin_id: string }) => ({
		plan: {
			schema_version: 2,
			identity: {
				plugin_id,
				publisher: "dure",
				version: "0.2.0",
			},
			authority: {
				authority: "dure.release",
				catalog_snapshot_sha256: `sha256:${"a".repeat(64)}`,
			},
			workspace_identity: workspaceIdentity,
			catalog_selection: {
				source_id: "dure.bundled",
				candidate_id: "dure.beads.bundled",
			},
			applied_policy_digest: `sha256:${"c".repeat(64)}`,
			negotiated_host_api_version: 2,
			activation: [],
			contributions: [],
			ignored_optional_contributions: [],
			agent_integrations: [],
			ignored_optional_agent_integrations: [],
			permissions: [],
			digest: `sha256:${"d".repeat(64)}`,
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
		}),
	);
	mocks.listenActivation.mockImplementation(async (callback) => {
		mocks.activationListeners.push(callback);
		return vi.fn();
	});
	mocks.listenSettings.mockImplementation(async (callback) => {
		mocks.settingsListeners.push(callback);
		return vi.fn();
	});
	mocks.listenPermission.mockImplementation(async (callback) => {
		mocks.permissionListeners.push(callback);
		return vi.fn();
	});
	mocks.activate.mockImplementation(async (request) => {
		for (const listener of mocks.activationListeners) {
			listener({ ...request, active: true });
		}
		return true;
	});
	mocks.useSpaces.mockReturnValue([]);
	mocks.settings.mockResolvedValue(settingsPayload());
	mocks.query.mockImplementation(
		async ({ query }: { query: { kind: string } }) =>
			query.kind === "counts"
				? { kind: "counts", counts }
				: query.kind === "show"
				? {
						kind: "show",
						issue: {
							summary,
							description: "플러그인이 자신의 UI를 선언합니다.",
							design: null,
							acceptance_criteria: null,
							notes: null,
						},
					}
				: { kind: query.kind, issues: [summary], complete: true },
	);
});

afterEach(() => {
	cleanup();
	resetIssueTrackerClaimProjectionResourcesForTests();
	resetPluginIssueTrackerWorkspaceResourcesForTests();
	mocks.activationListeners.length = 0;
	mocks.settingsListeners.length = 0;
	mocks.permissionListeners.length = 0;
	vi.resetAllMocks();
	vi.useRealTimers();
	useStore.setState({ focusCtx: null, projects: [], agents: [] });
});

describe("plugin-declared query titles", () => {
	it("names a tab in the plugin's words and falls back to the host label", async () => {
		renderTracker({ queryTitles: { ready: "Assigned to me" } });
		// The accessible name carries the tab's count after the label.
		const named = (label: string) =>
			new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
		await screen.findByRole("radio", { name: named("Assigned to me") });
		expect(
			screen.queryByRole("radio", {
				name: named(t("plugins.issueTracker.mode.ready")),
			}),
		).toBeNull();
		// The list tab was not renamed, so the host label stands.
		expect(
			screen.getByRole("radio", {
				name: named(t("plugins.issueTracker.mode.openIssues")),
			}),
		).toBeTruthy();
	});
});

describe("issues without a priority", () => {
	it("draws no priority chip instead of a fake P0", async () => {
		mocks.query.mockImplementation(async ({ query }: { query: { kind: string } }) => ({
			kind: query.kind,
			issues: [{ ...summary, priority: null }],
			complete: true,
		}));
		renderTracker();
		await screen.findByText(summary.title);
		expect(screen.queryByText(/^P\d+$/)).toBeNull();
	});
});

describe("IssueTrackerView", () => {
	it("does not flash an error while native observation retries during open", async () => {
		vi.useFakeTimers();
		mocks.listenSettings.mockRejectedValueOnce(
			new Error("event transport down"),
		);
		renderTracker();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(mocks.listenSettings).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(mocks.query).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(250);
		});
		expect(mocks.listenSettings).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText(summary.title)).toBeTruthy();
	});

	it("keeps tracker IDs out of compact issue rows", async () => {
		renderTracker();

		expect(await screen.findByText(summary.title)).toBeTruthy();
		expect(screen.queryByText(summary.id)).toBeNull();
	});

	it("shows authoritative counts and replaces decisions with blocked work", async () => {
		renderTracker({
			operations: ["ready", "list", "human", "show"],
		});

		expect(
			await screen.findByRole("radio", { name: "진행 가능 7" }),
		).toBeTruthy();
		expect(screen.getByRole("radio", { name: "열린 이슈 12" })).toBeTruthy();
		expect(
			screen.getByRole("radio", { name: "차단됨 3" }),
		).toBeTruthy();
		expect(screen.queryByRole("radio", { name: "결정 필요" })).toBeNull();
		expect(mocks.query).toHaveBeenCalledWith(queryRequest({ kind: "counts" }));

		fireEvent.click(screen.getByRole("radio", { name: "차단됨 3" }));
		await waitFor(() =>
			expect(mocks.query).toHaveBeenCalledWith(
				queryRequest({
					kind: "list_by_status",
					statuses: ["blocked"],
					limit: 100,
				}),
			),
		);
	});

	it("queries the manifest-selected provider and opens issue details", async () => {
		renderTracker();

		const title = await screen.findByText(summary.title);
		expect(mocks.query).toHaveBeenCalledWith(
			queryRequest({ kind: "ready", limit: 100 }),
		);

		fireEvent.click(title);
		await waitFor(() =>
			expect(mocks.query).toHaveBeenCalledWith(
				queryRequest({ kind: "show", issue_id: summary.id }),
			),
		);
		expect(
			await screen.findByText("플러그인이 자신의 UI를 선언합니다."),
		).toBeTruthy();
	});

	it("returns from an issue detail when the same tracker is explicitly opened again", async () => {
		renderTracker();
		fireEvent.click(await screen.findByText(summary.title));
		await screen.findByText("플러그인이 자신의 UI를 선언합니다.");
		act(() => useWindowSidebarStore.getState().openPluginView({
			containerKey: JSON.stringify(["dure.beads", "dure.beads.views", "dure.beads.issues"]),
			viewId: "dure.beads.issues.list",
		}));
		expect(await screen.findByText(summary.title)).toBeTruthy();
		expect(screen.queryByText("플러그인이 자신의 UI를 선언합니다.")).toBeNull();
	});

	it("starts a Beads issue through the canonical Quick Dispatch surface", async () => {
		renderTracker();

		fireEvent.click(await screen.findByRole("button", { name: "시작" }));

		expect(mocks.quickDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "repo",
				typedName: "beads-hebbian-frontend-kacd.4",
				promptText: expect.stringContaining(summary.id),
			}),
		);
	});

	it("opens the exact running task pane instead of starting a duplicate", async () => {
		const agent = {
			id: "agent-task",
			name: "beads-hebbian-frontend-kacd.4",
			provider: "codex" as const,
			projectId: "repo",
			worktreePath: "/work/repo/.worktrees/beads-task",
			branch: "agent/beads-hebbian-frontend-kacd-4",
			sessionId: "session-task",
			sessionKind: "pty" as const,
		};
		act(() => {
			useStore.setState({ activeSpaceId: "space-1", agents: [agent] });
		});
		renderTracker();

		fireEvent.click(await screen.findByRole("button", { name: "열기" }));

		expect(mocks.openAgent).toHaveBeenCalledWith("space-1", agent);
		expect(mocks.quickDispatch).not.toHaveBeenCalled();
	});

	it("filters the active query in place without adding a second data source", async () => {
		const other = {
			...summary,
			id: "hebbian-frontend-search",
			title: "Repair task watcher",
			priority: 3,
		};
		mocks.query.mockImplementation(
			async ({ query }: { query: { kind: string } }) =>
				query.kind === "counts"
					? { kind: "counts", counts }
					: { kind: query.kind, issues: [summary, other], complete: true },
		);
		renderTracker();
		await screen.findByText(other.title);

		fireEvent.change(screen.getByRole("searchbox", { name: "이슈 검색" }), {
			target: { value: "watcher p3" },
		});

		expect(screen.queryByText(summary.title)).toBeNull();
		expect(screen.getByText(other.title)).toBeTruthy();
		expect(screen.getByLabelText("결과 1개").textContent).toBe("1");
		expect(mocks.query).toHaveBeenCalledTimes(2);
	});

	it("copies the issue ID from the detail header", async () => {
		renderTracker();

		fireEvent.click(await screen.findByText(summary.title));
		fireEvent.click(
			await screen.findByRole("button", { name: "이슈 ID 복사" }),
		);

		expect(mocks.copyText).toHaveBeenCalledOnce();
		expect(mocks.copyText).toHaveBeenCalledWith(summary.id);
	});

	it("does not query again when pane focus stays in the same workspace", async () => {
		mocks.subscribe.mockResolvedValue(subscribeResult(4));
		renderTracker({
			operations: ["ready", "list", "watch"],
			agentClaims: paneClaims,
		});

		expect(await screen.findByText(summary.title)).toBeTruthy();
		await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(3));
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));

		act(() => {
			useStore.setState({
				focusCtx: {
					cwd: "/work/repo/packages/app",
					source: "local",
					label: "Another pane",
				},
			});
		});

		await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(3));
		expect(mocks.subscribe).toHaveBeenCalledTimes(1);
		expect(mocks.unsubscribe).not.toHaveBeenCalled();
	});

	it("shows a configuration warning when workspace settings cannot be read", async () => {
		mocks.settings.mockRejectedValue(new Error("settings unavailable"));
		renderTracker({ operations: ["ready", "list"] });

		expect(
			await screen.findByText("플러그인 설정을 불러오지 못했습니다."),
		).toBeTruthy();
		expect(await screen.findByText(summary.title)).toBeTruthy();
	});

	it("does not start claim reads when settings changes cannot be observed", async () => {
		vi.useFakeTimers();
		mocks.listenSettings.mockRejectedValue(new Error("event transport down"));
		renderTracker({ operations: ["ready", "list"], agentClaims: paneClaims });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(mocks.query).not.toHaveBeenCalled();
		await act(async () => {
			await vi.runAllTimersAsync();
		});

		expect(
			screen.getByText("플러그인 설정을 불러오지 못했습니다."),
		).toBeTruthy();
		expect(screen.getByText(summary.title)).toBeTruthy();
		expect(
			mocks.query.mock.calls.some(
				([request]) => request.query.kind === "agent_claims",
			),
		).toBe(false);
		expect(mocks.subscribe).not.toHaveBeenCalled();
	});

	it("does not start reads when permission changes cannot be observed", async () => {
		mocks.listenPermission.mockRejectedValue(
			new Error("permission event transport down"),
		);
		renderTracker({
			operations: ["ready", "list", "watch"],
			agentClaims: paneClaims,
		});

		expect(
			await screen.findByText(/플러그인 권한 상태를 불러오지 못했습니다/),
		).toBeTruthy();
		expect(mocks.permissionGet).not.toHaveBeenCalled();
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
	});

	it("does not start reads when activation changes cannot be observed", async () => {
		vi.useFakeTimers();
		mocks.listenActivation.mockRejectedValue(
			new Error("activation event transport down"),
		);
		renderTracker({ operations: ["ready", "list", "watch"] });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(mocks.query).not.toHaveBeenCalled();
		await act(async () => {
			await vi.runAllTimersAsync();
		});

		expect(screen.getByText(/Beads 이슈 읽기 시작/)).toBeTruthy();
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
	});

	it("clears rendered issue data and stops its watcher on a live permission downgrade", async () => {
		const stopListening = vi.fn();
		mocks.listen.mockResolvedValue(stopListening);
		mocks.subscribe.mockResolvedValue(subscribeResult(1));
		renderTracker({ operations: ["ready", "show", "watch"] });

		const title = await screen.findByText(summary.title);
		fireEvent.click(title);
		expect(
			await screen.findByText("플러그인이 자신의 UI를 선언합니다."),
		).toBeTruthy();
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(mocks.permissionListeners).toHaveLength(1));
		const loadedPermission = await mocks.permissionGet.mock.results[0].value;

		act(() => {
			mocks.permissionListeners[0]({
				...loadedPermission,
				record_revision: "3",
				enablement_epoch: "3",
				enabled: false,
			});
		});

		expect(await screen.findByRole("button", { name: "플러그인 켜기" })).toBeTruthy();
		const permissionScrollArea = document.querySelector(
			'[data-slot="scroll-area"][data-sidebar-scroll-area]',
		);
		expect(permissionScrollArea?.className).toContain("min-h-0");
		expect(permissionScrollArea?.className).toContain("flex-1");
		expect(
			permissionScrollArea
				?.querySelector('[data-slot="scroll-area-viewport"]')
				?.className,
		).toContain("pb-3");
		expect(screen.queryByText(summary.title)).toBeNull();
		expect(screen.queryByText("플러그인이 자신의 UI를 선언합니다.")).toBeNull();
		await waitFor(() => expect(stopListening).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
	});

	it("runs a settings-less view without settings IPC or subscriptions", async () => {
		renderTracker({
			pluginName: "Settings-less tracker",
			pluginId: "example.settings-less",
			viewContributionId: "example.settings-less.views",
			contributionId: "example.settings-less.issue-tracker",
			viewId: "example.settings-less.issues",
			defaultQuery: "list",
			settingsTarget: null,
			operations: ["list"],
		});

		expect(await screen.findByText(summary.title)).toBeTruthy();
		expect(mocks.settings).not.toHaveBeenCalled();
		expect(mocks.listenSettings).not.toHaveBeenCalled();
	});

	it("keeps the focused pane claims first as focus changes without rereading claims", async () => {
		installAgentPane({ displayName: "Agent One" });
		const first = useStore.getState().agents[0];
		useStore.setState({
			agents: [first, { ...first, id: "agent-two", displayName: "Agent Two", branch: "agent/two" }],
			focusCtx: { key: "agent:agent-two", cwd: "/work/repo/.worktrees/two", source: "local", label: "Agent Two" },
		});
		mocks.useSpaces.mockReturnValue([
			{ key: "agent:agent-one", kind: "agent", agentId: "agent-one" },
			{ key: "agent:agent-two", kind: "agent", agentId: "agent-two" },
		]);
		mocks.query.mockImplementation(async ({ query }: { query: { kind: string } }) => ({
			kind: query.kind === "agent_claims" ? "list" : query.kind,
			issues: query.kind === "agent_claims" ? ["one", "two"].map((name) => ({
				...summary, id: name, title: `Claim ${name}`,
				agent_binding: { kind: "scm_branch", branch: `agent/${name}` },
			})) : [summary],
			complete: true,
		}));
		renderTracker({ agentClaims: paneClaims });
		await screen.findByRole("button", { name: "Claim two" });
		const claimTitles = () => screen.getAllByRole("button", { name: /^Claim (one|two)$/ }).map((row) => row.textContent);
		expect(claimTitles()).toEqual(["Claim two", "Claim one"]);
		const reads = mocks.query.mock.calls.length;
		act(() => useStore.setState({ focusCtx: { key: "agent:agent-one", cwd: "/work/repo/.worktrees/one", source: "local", label: "Agent One" } }));
		expect(claimTitles()).toEqual(["Claim one", "Claim two"]);
		expect(mocks.query).toHaveBeenCalledTimes(reads);
	});

	it("shows branch-bound claims by agent pane when the plugin setting is enabled", async () => {
		const claimed = {
			...summary,
			id: "hebbian-frontend-claim",
			title: "Pane claim",
			agent_binding: { kind: "scm_branch" as const, branch: "agent/one" },
		};
		installAgentPane({ displayName: "Agent One" });
		mocks.query.mockImplementation(
			async ({ query }: { query: { kind: string } }) => ({
				kind: query.kind === "agent_claims" ? "list" : query.kind,
				issues: query.kind === "agent_claims" ? [claimed] : [summary],
				complete: true,
			}),
		);

		renderTracker({ agentClaims: paneClaims });

		expect(await screen.findByText("Pane별 claim")).toBeTruthy();
		expect(await screen.findByText("Agent One")).toBeTruthy();
		expect(await screen.findByText("Pane claim")).toBeTruthy();
		expect(screen.queryByText(claimed.id)).toBeNull();
		expect(screen.queryByText("Claim 없음")).toBeNull();
		expect(mocks.query).toHaveBeenCalledWith(
			queryRequest(
				{ kind: "agent_claims", statuses: ["in_progress"], limit: 100 },
				{ agent_claim_policy_epoch: 1 },
			),
		);
	});

	it("uses a defaults-only policy epoch in an unregistered local workspace", async () => {
		useStore.setState({ projects: [] });
		mocks.settings.mockResolvedValue(settingsPayload({}, 7));

		renderTracker({ operations: ["ready", "list"], agentClaims: paneClaims });

		await waitFor(() =>
				expect(mocks.settings).toHaveBeenCalledWith(
					settingsTarget,
					"workspace",
					workspaceIdentity,
				"/work/repo",
			),
		);
		await waitFor(() =>
			expect(mocks.query).toHaveBeenCalledWith(
				expect.objectContaining({
					agent_claim_policy_epoch: 7,
					query: expect.objectContaining({ kind: "agent_claims" }),
				}),
			),
		);
	});

	const mutationDelivery = {
		kind: "terminal_command" as const,
		requires_package_script: "beads",
		close: [
			"pnpm",
			"beads",
			"--",
			"mutate",
			"update",
			"{issue_id}",
			"--status",
			"closed",
		],
		delete: ["pnpm", "beads", "--", "mutate", "delete", "{issue_id}", "--force"],
	};

	it("closes an issue straight from the menu and deletes only after a confirm", async () => {
		act(() => {
			useStore.setState({ activeSpaceId: "space-1" });
		});
		mocks.readFile.mockResolvedValue({
			content: JSON.stringify({ scripts: { beads: "node scripts/x.mjs" } }),
		});
		renderTracker({ mutationDelivery });
		const row = await screen.findByText(summary.title);

		fireEvent.contextMenu(row);
		// Closing is reversible, so it runs with no confirm step.
		fireEvent.click(await screen.findByText("이슈 닫기"));

		expect(mocks.openCommandPane).toHaveBeenCalledWith("space-1", {
			title: `${summary.id} 닫기`,
			command: `pnpm beads -- mutate update ${summary.id} --status closed`,
			cwd: "/work/repo",
			closeOnSuccess: true,
		});

		mocks.openCommandPane.mockClear();
		fireEvent.contextMenu(row);
		fireEvent.click(await screen.findByText("이슈 삭제…"));
		expect(mocks.openCommandPane).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "삭제" }));

		expect(mocks.openCommandPane).toHaveBeenCalledWith("space-1", {
			title: `${summary.id} 삭제`,
			command: `pnpm beads -- mutate delete ${summary.id} --force`,
			cwd: "/work/repo",
			closeOnSuccess: true,
		});
	});

	it("offers no row mutation in a workspace that cannot run the wrapper", async () => {
		// A workspace without the declared package script would only ever see
		// the command fail, so the menu carries nothing at all.
		mocks.readFile.mockResolvedValue({
			content: JSON.stringify({ scripts: { build: "vite build" } }),
		});
		renderTracker({ mutationDelivery });
		const row = await screen.findByText(summary.title);

		fireEvent.contextMenu(row);

		await waitFor(() => expect(mocks.readFile).toHaveBeenCalled());
		expect(screen.queryByText("이슈 닫기")).toBeNull();
		expect(screen.queryByText("이슈 삭제…")).toBeNull();
	});

	it("does not query or render pane claims when the workspace plugin setting is off", async () => {
		mocks.settings.mockResolvedValue(
			settingsPayload({ show_agent_claims: false }, 2),
		);

		renderTracker({ agentClaims: paneClaims });

		expect(await screen.findByText(summary.title)).toBeTruthy();
		await waitFor(() => expect(mocks.settings).toHaveBeenCalled());
		expect(screen.queryByText("Pane별 claim")).toBeNull();
		expect(
			mocks.query.mock.calls.some(
				([request]) => request.query.kind === "agent_claims",
			),
		).toBe(false);
		expect(mocks.useSpaces).not.toHaveBeenCalled();
	});

	it("requires an explicit workspace activation before any tracker query", async () => {
		mocks.activationGet.mockResolvedValue(false);

		renderTracker();

		const activate = await screen.findByRole("button", {
			name: "이슈 읽기 시작",
		});
		expect(mocks.query).not.toHaveBeenCalled();
		fireEvent.click(activate);

		await waitFor(() =>
			expect(mocks.activate).toHaveBeenCalledWith({
				plugin_id: "dure.beads",
				contribution_id: "dure.beads.issue-tracker",
				workspace_root: "/work/repo",
			}),
		);
		expect(await screen.findByText(summary.title)).toBeTruthy();
	});

	it("does not let a delayed activation mark a replacement workspace active", async () => {
		let resolveActivation: (value: boolean) => void = () => undefined;
		mocks.activationGet.mockResolvedValue(false);
		mocks.activate.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					resolveActivation = resolve;
				}),
		);

		renderTracker({ operations: ["ready", "list"] });
		fireEvent.click(
			await screen.findByRole("button", { name: "이슈 읽기 시작" }),
		);
		await waitFor(() => expect(mocks.activate).toHaveBeenCalled());

		switchWorkspaceToOther();
		await waitFor(() =>
			expect(mocks.activationGet).toHaveBeenCalledWith(
				expect.objectContaining({ workspace_root: "/work/other" }),
			),
		);
		expect(
			await screen.findByRole("button", { name: "이슈 읽기 시작" }),
		).toBeTruthy();

		await act(async () => {
			resolveActivation(true);
			await Promise.resolve();
		});
		expect(screen.getByRole("button", { name: "이슈 읽기 시작" })).toBeTruthy();
		expect(
			mocks.query.mock.calls.some(
				([request]) => request.workspace_root === "/work/other",
			),
		).toBe(false);
	});

	it("clears the previous workspace before a replacement workspace query fails", async () => {
		mocks.query.mockImplementation(
			async ({
				workspace_root,
				query,
			}: {
				workspace_root: string;
				query: { kind: string };
			}) => {
				if (workspace_root === "/work/other")
					throw new Error("fixture failure");
				return { kind: query.kind, issues: [summary], complete: true };
			},
		);

		renderTracker({ operations: ["ready", "list"] });
		expect(await screen.findByText(summary.title)).toBeTruthy();

		switchWorkspaceToOther();

		await waitFor(() =>
			expect(mocks.query).toHaveBeenCalledWith(
				expect.objectContaining({ workspace_root: "/work/other" }),
			),
		);
		expect(screen.queryByText(summary.title)).toBeNull();
		expect(await screen.findByText("이슈를 불러오지 못했습니다.")).toBeTruthy();
	});

	it("applies watcher snapshots only for the exact plugin contribution lease", async () => {
		let listener: ((event: IssueTrackerWatchEventV1) => void) | undefined;
		mocks.settings.mockImplementation(async () =>
			settingsPayload({ default_view: "list", show_agent_claims: false }, 2),
		);
		mocks.listen.mockImplementation(async (callback) => {
			listener = callback;
			return vi.fn();
		});
		mocks.subscribe.mockResolvedValue(subscribeResult(7));
		const snapshot = snapshotOf([
			{ ...summary, id: "hebbian-frontend-watched", title: "Watched issue" },
		]);

		renderTracker({ defaultQuery: "list", operations: ["list", "watch"] });
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());
		expect(mocks.subscribe).toHaveBeenCalledWith(
			expect.objectContaining({ include_agent_claims: false }),
		);
		expect(listener).toBeDefined();

		act(() => {
			listener?.(
				watchSnapshotEvent({
					generation: 7,
					revision: 1,
					snapshot,
					digest: "other",
					pluginId: "dure.other",
					contributionId: "dure.other.issue-tracker",
					workspaceKey: "local:local:other",
				}),
			);
		});
		expect(screen.queryByText("Watched issue")).toBeNull();

		act(() => {
			listener?.(watchSnapshotEvent({ generation: 7, revision: 2, snapshot }));
		});
		expect(await screen.findByText("Watched issue")).toBeTruthy();
	});

	it("refreshes tab counts after an accepted watcher snapshot", async () => {
		let listener: ((event: IssueTrackerWatchEventV1) => void) | undefined;
		let currentCounts = counts;
		mocks.settings.mockImplementation(async () =>
			settingsPayload({ default_view: "list", show_agent_claims: false }, 2),
		);
		mocks.query.mockImplementation(
			async ({ query }: { query: { kind: string } }) =>
				query.kind === "counts"
					? { kind: "counts", counts: currentCounts }
					: { kind: query.kind, issues: [summary], complete: true },
		);
		mocks.listen.mockImplementation(async (callback) => {
			listener = callback;
			return vi.fn();
		});
		mocks.subscribe.mockResolvedValue(subscribeResult(12));

		renderTracker({
			defaultQuery: "list",
			operations: ["ready", "list", "human", "watch"],
		});
		expect(
			await screen.findByRole("radio", { name: "진행 가능 7" }),
		).toBeTruthy();
		await waitFor(() => expect(listener).toBeDefined());
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());

		currentCounts = { ready: 8, open: 13, blocked: 4 };
		act(() => {
			listener?.(
				watchSnapshotEvent({
					generation: 12,
					revision: 1,
					snapshot: snapshotOf([summary]),
				}),
			);
		});

		expect(
			await screen.findByRole("radio", { name: "진행 가능 8" }),
		).toBeTruthy();
		expect(screen.getByRole("radio", { name: "열린 이슈 13" })).toBeTruthy();
		expect(screen.getByRole("radio", { name: "차단됨 4" })).toBeTruthy();
	});

	it("does not let an older list query overwrite a newer watcher snapshot", async () => {
		let listener: ((event: IssueTrackerWatchEventV1) => void) | undefined;
		let resolveQuery: (result: {
			kind: "list";
			issues: (typeof summary)[];
			complete: boolean;
		}) => void = () => undefined;
		mocks.settings.mockResolvedValue(
			settingsPayload({ default_view: "list", show_agent_claims: false }, 2),
		);
		mocks.query.mockReturnValue(
			new Promise((resolve) => {
				resolveQuery = resolve;
			}),
		);
		mocks.listen.mockImplementation(async (callback) => {
			listener = callback;
			return vi.fn();
		});
		mocks.subscribe.mockResolvedValue(subscribeResult(11));
		const watched = { ...summary, id: "watched-new", title: "New snapshot" };

		renderTracker({ defaultQuery: "list", operations: ["list", "watch"] });
		await waitFor(() => expect(listener).toBeDefined());
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());
		act(() => {
			listener?.(
				watchSnapshotEvent({
					generation: 11,
					revision: 2,
					snapshot: snapshotOf([watched]),
					digest: "new",
				}),
			);
		});
		expect(await screen.findByText("New snapshot")).toBeTruthy();
		await act(async () => {
			resolveQuery({ kind: "list", issues: [summary], complete: true });
		});
		expect(screen.getByText("New snapshot")).toBeTruthy();
		expect(screen.queryByText(summary.title)).toBeNull();
	});

	it("buffers pre-subscribe events and never applies an older watcher revision", async () => {
		let listener: ((event: IssueTrackerWatchEventV1) => void) | undefined;
		let resolveSubscribe: (value: ReturnType<typeof subscribeResult>) => void =
			() => undefined;
		mocks.listen.mockImplementation(async (callback) => {
			listener = callback;
			return vi.fn();
		});
		mocks.subscribe.mockImplementation(
			() =>
				new Promise<Parameters<typeof resolveSubscribe>[0]>((resolve) => {
					resolveSubscribe = resolve;
				}),
		);
		const eventFor = (revision: number, title: string) =>
			watchSnapshotEvent({
				generation: 9,
				revision,
				snapshot: snapshotOf([{ ...summary, id: `issue-${title}`, title }]),
			});

		renderTracker({ defaultQuery: "list", operations: ["list", "watch"] });
		await waitFor(() => expect(listener).toBeDefined());
		act(() => listener?.(eventFor(2, "Newer watched issue")));
		act(() => {
			resolveSubscribe(
				subscribeResult(9, true, eventFor(1, "Older watched issue")),
			);
		});

		expect(await screen.findByText("Newer watched issue")).toBeTruthy();
		act(() => listener?.(eventFor(1, "Stale watched issue")));
		expect(screen.queryByText("Older watched issue")).toBeNull();
		expect(screen.queryByText("Stale watched issue")).toBeNull();
		expect(screen.getByText("Newer watched issue")).toBeTruthy();
	});

	it("uses a newer epoch when an older subscription resolves after a replacement effect", async () => {
		let resolveFirst: (value: ReturnType<typeof subscribeResult>) => void =
			() => undefined;
		mocks.settings.mockResolvedValue(
			settingsPayload({ default_view: "list", show_agent_claims: false }, 2),
		);
		mocks.listen.mockResolvedValue(vi.fn());
		mocks.subscribe
			.mockImplementationOnce(
				() =>
					new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValue(subscribeResult(1, true));

		renderTracker({
			defaultQuery: "list",
			operations: ["list", "human", "watch"],
		});
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
		switchWorkspaceToOther();
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));

		const firstLease = mocks.subscribe.mock.calls[0][0];
		const secondLease = mocks.subscribe.mock.calls[1][0];
		expect(firstLease.subscriber_id).toBe(secondLease.subscriber_id);
		expect(secondLease.subscriber_epoch).toBeGreaterThan(
			firstLease.subscriber_epoch,
		);
		act(() => {
			resolveFirst(subscribeResult(1));
		});
		await waitFor(() =>
			expect(mocks.unsubscribe).toHaveBeenCalledWith(
				expect.objectContaining({
					subscriber_id: firstLease.subscriber_id,
					subscriber_epoch: firstLease.subscriber_epoch,
					generation: 1,
				}),
			),
		);
		expect(
			mocks.unsubscribe.mock.calls.some(
				([request]) =>
					request.subscriber_epoch === secondLease.subscriber_epoch,
			),
		).toBe(false);
	});

	it("never reports an empty pane claim as authoritative when the result is partial", async () => {
		installAgentPane();
		mocks.query.mockImplementation(
			async ({ query }: { query: { kind: string } }) => ({
				kind: query.kind === "agent_claims" ? "list" : query.kind,
				issues: query.kind === "agent_claims" ? [] : [summary],
				complete: query.kind !== "agent_claims",
			}),
		);

		renderTracker({ agentClaims: paneClaims });

		expect(await screen.findByText("Claim 확인 불완전")).toBeTruthy();
		expect(screen.queryByText("Claim 없음")).toBeNull();
	});
});
