// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listProviderConversations: vi.fn(),
	loadProviderConversationDetails: vi.fn(),
	census: vi.fn(),
}));

vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: mocks.listProviderConversations,
	loadProviderConversationDetails: mocks.loadProviderConversationDetails,
}));
vi.mock("@/lib/hmux/identity/hmuxControlPlaneCensusObservation", () => ({
	requestHmuxControlPlaneCensus: mocks.census,
}));

import { SessionsPane } from "@/components/sessions/SessionsPane";
import { setLang } from "@/lib/i18n";
import { resetRecentSessionHistoryForTests } from "@/lib/sessions/recentSessionHistoryResource";
import { DEFAULT_SESSIONS_VIEW_OPTIONS } from "@/lib/sessions/sessionsViewOptions";
import { useStore } from "@/store";

beforeEach(() => {
	resetRecentSessionHistoryForTests();
	setLang("en");
	useStore.setState({
		projects: [],
		agents: [],
		agentActivity: {},
		layouts: {},
		spaces: [{ id: "desktop-active", name: "Product" }],
		activeSpaceId: "desktop-active",
		sshHosts: [],
		uiPrefs: {
			...useStore.getState().uiPrefs,
			sessionsViewOptions: DEFAULT_SESSIONS_VIEW_OPTIONS,
		},
	});
	mocks.listProviderConversations.mockResolvedValue([
		{
			provider: "codex",
			id: "recent-session",
			title: "Recent work",
			mtime: Date.now() / 1000,
			cwd: "/repo",
			repositoryRoot: "/repo",
			resumeCapability: "exact",
			executionLocation: "local",
			workingDirectoryAvailable: true,
		},
	]);
	mocks.loadProviderConversationDetails.mockResolvedValue({
		subagents: [],
		totalCount: 0,
	});
	mocks.census.mockRejectedValue(
		new Error("hmux_discovery_census_worker_failed"),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SessionsPane view options", () => {
	it("browses, searches and refreshes provider history without loading runtime sessions", async () => {
		render(<SessionsPane />);
		await screen.findByRole("article", { name: /Recent work/ });
		expect(mocks.census).not.toHaveBeenCalled();

		const search = screen.getByRole("textbox");
		fireEvent.change(search, { target: { value: "unrelated conversation" } });
		await waitFor(() =>
			expect(screen.queryByRole("article", { name: /Recent work/ })).toBeNull(),
		);
		fireEvent.change(search, { target: { value: "Recent" } });
		await screen.findByRole("article", { name: /Recent work/ });

		const reads = mocks.listProviderConversations.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(mocks.listProviderConversations.mock.calls.length).toBeGreaterThan(
				reads,
			),
		);
		expect(mocks.census).not.toHaveBeenCalled();
	});

	it("offers the Sessions list view controls from the pane header", async () => {
		render(<SessionsPane />);

		await screen.findByRole("article", { name: /Recent work/ });
		expect(
			screen.getByRole("button", { name: /Session view options/i }),
		).toBeTruthy();
	});

	it("filters out a session only when its exact Agent pane exists", async () => {
		const now = Date.now() / 1000;
		useStore.setState({
			projects: [
				{
					id: "project-open",
					name: "repo-a",
					path: "/repo-a",
					kind: "local" as const,
					isRepo: true,
				},
			],
			agents: [
				{
					id: "agent-open",
					name: "open-agent",
					provider: "claude" as const,
					projectId: "project-open",
					worktreePath: "/repo-a",
					branch: "main",
					sessionId: "runtime-open",
					sessionKind: "pty" as const,
					conversationId: "conversation-open",
				},
			],
			agentActivity: { "agent-open": "exited" },
			layouts: {
				"desktop-active": {
					panels: {
						"agent:agent-open": {
							contentComponent: "agent",
							params: { agentRef: { agentId: "agent-open" } },
						},
					},
				},
			},
		});
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "conversation-open",
				title: "Alpha open pane",
				mtime: now,
				cwd: "/repo-a",
				repositoryRoot: "/repo-a",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
			{
				provider: "codex",
				id: "conversation-closed",
				title: "Zulu closed pane",
				mtime: now - 1,
				cwd: "/repo-b",
				repositoryRoot: "/repo-b",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
		]);

		render(<SessionsPane />);
		await screen.findByRole("article", { name: /Alpha open pane/ });
		fireEvent.pointerDown(
			screen.getByRole("button", { name: "Session view options" }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Filter" }), {
			pointerType: "mouse",
		});
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: "Exclude sessions open in panes",
			}),
		);

		expect(await screen.findByRole("article", { name: /Zulu closed pane/ })).toBeTruthy();
		expect(screen.queryByRole("article", { name: /Alpha open pane/ })).toBeNull();
		expect(useStore.getState().uiPrefs.sessionsViewOptions.paneFilter).toBe(
			"exclude_open",
		);
	});

	it("collapses and expands all projected session groups from the header", async () => {
		const now = Date.now() / 1000;
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "repo-a-session",
				title: "Repository A session",
				mtime: now,
				cwd: "/repo-a",
				repositoryRoot: "/repo-a",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
			{
				provider: "codex",
				id: "repo-b-session",
				title: "Repository B session",
				mtime: now - 1,
				cwd: "/repo-b",
				repositoryRoot: "/repo-b",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
		]);

		render(<SessionsPane />);
		await screen.findByRole("article", { name: /Repository A session/ });
		fireEvent.pointerDown(
			screen.getByRole("button", { name: "Session view options" }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Collapse all" }));
		await waitFor(() =>
			expect(screen.queryByRole("article", { name: /Repository A session/ })).toBeNull(),
		);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: "Session view options" }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Expand all" }));
		expect(await screen.findByRole("article", { name: /Repository A session/ })).toBeTruthy();
		expect(screen.getByRole("article", { name: /Repository B session/ })).toBeTruthy();
	});
});
