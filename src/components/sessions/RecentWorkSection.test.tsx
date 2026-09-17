// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	copyTextToClipboard: vi.fn(),
	listProviderConversations: vi.fn(),
	loadProviderConversationDetails: vi.fn(),
	launchDiscovered: vi.fn(),
	message: vi.fn(),
	navigateToPanel: vi.fn(),
	openAgentPanel: vi.fn(),
	openPath: vi.fn(),
	openAgentPanelOnDesktop: vi.fn(),
	showToast: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mocks.openPath }));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: mocks.listProviderConversations,
	loadProviderConversationDetails: mocks.loadProviderConversationDetails,
}));
vi.mock("@/lib/sessions/launch/discoveredConversationLaunch", () => ({
	launchDiscoveredLocalConversationPane: mocks.launchDiscovered,
}));
vi.mock("@/lib/sessions/managed/managedConversationLaunch", () => ({
	managedConversationLaunchFailureMessage: (error: unknown) => String(error),
}));
vi.mock("@/lib/platform/clipboardWrite", () => ({
	copyTextToClipboard: mocks.copyTextToClipboard,
}));
vi.mock("@/lib/toast", () => ({ showToast: mocks.showToast }));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.openAgentPanel,
	openAgentPanelOnDesktop: mocks.openAgentPanelOnDesktop,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	mountedDockviewEntries: () => [],
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/panelFocusHandoff")>()),
	navigateToPanel: mocks.navigateToPanel,
}));

import { SessionsPane } from "@/components/sessions/SessionsPane";
import { resetRecentSessionHistoryForTests } from "@/lib/sessions/recentSessionHistoryResource";
import { useRecentSessionVisibilityStore } from "@/lib/sessions/recentSessionVisibilityStore";
import { useStore } from "@/store";

beforeEach(() => {
	resetRecentSessionHistoryForTests();
	useRecentSessionVisibilityStore.setState({ hidden: [] });
	mocks.listProviderConversations.mockResolvedValue([
		{
			provider: "claude",
			id: "conversation-before-dure",
			title: "Existing provider work",
			mtime: Date.now() / 1000,
			cwd: "/repo/packages/app",
			repositoryRoot: "/repo",
			resumeCapability: "exact",
			executionLocation: "local",
			workingDirectoryAvailable: true,
		},
	]);
	mocks.launchDiscovered.mockResolvedValue({});
	mocks.loadProviderConversationDetails.mockResolvedValue({
		subagents: [],
		totalCount: 0,
	});
	useStore.setState({
		projects: [],
		agents: [],
		agentActivity: {},
		layouts: {},
		spaces: [{ id: "desktop-active", name: "Product" }],
		activeSpaceId: "desktop-active",
		sshHosts: [],
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** Filters the list through the pane's search field, as a reader does. */
function searchSessions(value: string) {
	fireEvent.change(screen.getByRole("textbox"), { target: { value } });
}

describe("RecentWorkSection in the Sessions pane", () => {
	it("labels the section even when refresh belongs to the parent pane", async () => {
		render(<SessionsPane />);

		const card = await screen.findByRole("article", { name: /Existing provider work/ });
		// The label is a section label on the files tab's "Recent files" tier,
		// the peer of "External sessions" below it (owner call 2026-09-09). It
		// used to be omitted here as redundant with the pane title.
		expect(screen.getByText(/^(?:최근 세션|Recent sessions)$/)).toBeTruthy();
		expect(
			screen
				.getByRole("region", {
					name: /최근 세션|Recent sessions/i,
				})
				.contains(card),
		).toBe(true);
	});

	it("reuses the last successful provider snapshot across panel remounts", async () => {
		const firstMount = render(
			<SessionsPane />,
		);

		await screen.findByRole("article", { name: /Existing provider work/ });
		expect(mocks.listProviderConversations).toHaveBeenCalledTimes(1);
		firstMount.unmount();

		render(<SessionsPane />);

		expect(screen.getByRole("article", { name: /Existing provider work/ })).toBeTruthy();
		expect(mocks.listProviderConversations).toHaveBeenCalledTimes(1);
	});

	it("rescans and replaces the warm snapshot on explicit refresh", async () => {
		render(<SessionsPane />);
		await screen.findByRole("article", { name: /Existing provider work/ });
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "codex",
				id: "refreshed-conversation",
				title: "Refreshed provider work",
				mtime: Date.now() / 1000,
				cwd: "/repo/packages/app",
				repositoryRoot: "/repo",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
		]);

		fireEvent.click(
			screen.getByRole("button", { name: /새로고침|Refresh/i }),
		);

		expect(await screen.findByRole("article", { name: /Refreshed provider work/ })).toBeTruthy();
		expect(screen.queryByRole("article", { name: /Existing provider work/ })).toBeNull();
		expect(mocks.listProviderConversations).toHaveBeenCalledTimes(2);
	});

	it("uses the preview and lower metadata as one Details disclosure target", async () => {
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "conversation-before-dure",
				title: "Existing provider work",
				mtime: Date.now() / 1000,
				cwd: "/repo/packages/app",
				repositoryRoot: "/repo",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
				recentTurns: [
					{ role: "user", text: "Click this lower preview to inspect it." },
				],
			},
		]);
		render(<SessionsPane />);

		const preview = await screen.findByText(
			"Click this lower preview to inspect it.",
		);
		const card = screen.getByRole("article", { name: /Existing provider work/ });
		fireEvent.click(preview);

		expect(card.querySelector("[data-session-details]")).toBeTruthy();
		fireEvent.click(within(card).getByRole("img", { name: /Claude/ }));
		expect(card.querySelector("[data-session-details]")).toBeNull();
	});

	it("groups session history by project without losing the existing rows", async () => {
		const now = Date.now() / 1000;
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "repo-plan",
				title: "Plan the release",
				mtime: now,
				cwd: "/repo/.worktrees/plan",
				repositoryRoot: "/repo/.worktrees/plan",
				repositoryCommonDir: "/repo/.git",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
			{
				provider: "codex",
				id: "repo-review",
				title: "Review the release",
				mtime: now - 1,
				cwd: "/repo/.worktrees/review",
				repositoryRoot: "/repo/.worktrees/review",
				repositoryCommonDir: "/repo/.git",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
			{
				provider: "claude",
				id: "docs-copy",
				title: "Rewrite onboarding",
				mtime: now - 2,
				cwd: "/docs",
				repositoryRoot: "/docs",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
		]);

		render(<SessionsPane />);

		const repoGroup = await screen.findByRole("button", { name: /^repo$/i });
		const docsGroup = screen.getByRole("button", { name: /^docs$/i });
		expect(repoGroup.getAttribute("aria-expanded")).toBe("true");
		expect(docsGroup.getAttribute("aria-expanded")).toBe("false");
		const planCard = screen.getByRole("article", { name: /Plan the release/ });
		const reviewCard = screen.getByRole("article", { name: /Review the release/ });
		// The preview carries the last turn without a provider prefix; the
		// provider is the glyph, and a local session names no location.
		expect(planCard.textContent).toMatch(/plan/);
		expect(reviewCard.textContent).toMatch(/review/);
		expect(planCard.querySelector('[role="img"][aria-label*="Claude"]')).toBeTruthy();
		expect(reviewCard.querySelector('[role="img"][aria-label*="Codex"]')).toBeTruthy();
		expect(planCard.textContent).not.toMatch(/로컬|Local/);
		expect(screen.queryByRole("article", { name: "Rewrite onboarding" })).toBeNull();

		fireEvent.click(docsGroup);
		expect(screen.getByRole("article", { name: /Rewrite onboarding/ })).toBeTruthy();
	});

	it("keeps every matching project group expanded while searching", async () => {
		const now = Date.now() / 1000;
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "repo-result",
				title: "Shared search result",
				mtime: now,
				cwd: "/repo",
				repositoryRoot: "/repo",
				resumeCapability: "exact",
				executionLocation: "local",
			},
			{
				provider: "claude",
				id: "docs-result",
				title: "Shared documentation result",
				mtime: now - 1,
				cwd: "/docs",
				repositoryRoot: "/docs",
				resumeCapability: "exact",
				executionLocation: "local",
			},
		]);

		render(<SessionsPane />);
		searchSessions("shared");

		expect(await screen.findByRole("article", { name: /Shared search result/ })).toBeTruthy();
		expect(screen.getByRole("article", { name: /Shared documentation result/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^repo$/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /^docs$/i })).toBeNull();
	});

	it("groups session history and reveals recent turns before resuming", async () => {
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "conversation-before-dure",
				title: "Existing provider work",
				mtime: Date.now() / 1000,
				cwd: "/repo/packages/app",
				repositoryRoot: "/repo",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
				model: "claude-opus-5",
				effort: "xhigh",
				branch: "agent/session-history",
				recentTurns: [
					{ role: "user", text: "Oldest context should stay hidden." },
					{ role: "agent", text: "Earlier context remains useful." },
					{ role: "user", text: "Can you group these sessions?" },
					{
						role: "agent",
						text: "Grouped by workspace and ready to resume.",
					},
				],
				subagentCount: 1,
			},
			{
				provider: "codex",
				id: "conversation-api",
				title: "API follow-up",
				mtime: Date.now() / 1000 - 1,
				cwd: "/repo/packages/api",
				repositoryRoot: "/repo",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
				recentTurns: [{ role: "user", text: "Check the API too." }],
			},
			{
				provider: "codex",
				id: "conversation-other-repo",
				title: "Other repository task",
				mtime: Date.now() / 1000 - 2,
				cwd: "/other/packages/app",
				repositoryRoot: "/other",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
		]);
		mocks.loadProviderConversationDetails.mockResolvedValueOnce({
			totalCount: 1,
			subagents: [
				{
					id: "subagent-explore",
					title: "Trace the session handoff",
					kind: "Explore",
					status: "completed",
					mtime: Date.now() / 1000,
				},
			],
		});

		render(<SessionsPane />);

		const group = await screen.findByRole("button", { name: /^repo$/i });
		expect(group.getAttribute("aria-expanded")).toBe("true");
		const otherGroup = screen.getByRole("button", { name: /^other$/i });
		expect(otherGroup.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Other repository task")).toBeNull();
		expect(
			screen.getByText("Grouped by workspace and ready to resume."),
		).toBeTruthy();
		// Model and effort live in the details, not on the collapsed card.
		expect(screen.queryByText(/xhigh/)).toBeNull();

		const disclosure = screen.getByRole("button", {
			name: /(?:세부 정보|Details).*Existing provider work/i,
		});
		expect(
			screen.queryByRole("button", {
				name: /(?:새 pane에서 이어가기|Continue in a new pane).*Existing provider work/i,
			}),
		).toBeNull();
		fireEvent.click(disclosure);

		expect(screen.getByText("Can you group these sessions?")).toBeTruthy();
		expect(screen.queryByText("Oldest context should stay hidden.")).toBeNull();
		expect(screen.getByText(/최근 턴|Latest turns/i)).toBeTruthy();
		expect(screen.getByText(/하위 에이전트|Subagents/i)).toBeTruthy();
		expect(await screen.findByText("Trace the session handoff")).toBeTruthy();
		expect(screen.getByText("Explore")).toBeTruthy();
		// Model and effort are not shown at all; the branch sits on the row's
		// info line, and the folder chip names the part of the path that
		// differs from the group (owner decision 2026-09-09).
		expect(screen.queryByText("claude-opus-5 · xhigh")).toBeNull();
		expect(screen.getByText("agent/session-history")).toBeTruthy();
		expect(screen.queryByText("/repo")).toBeNull();
		expect(screen.queryByText("packages/app")).toBeNull();
		expect(
			within(screen.getByRole("article", { name: /Existing provider work/ })).getByText("app"),
		).toBeTruthy();
		expect(
			screen.getByRole("button", {
				name: /(?:새 pane에서 이어가기|Continue in a new pane).*Existing provider work/i,
			}),
		).toBeTruthy();
		expect(mocks.launchDiscovered).not.toHaveBeenCalled();
		expect(mocks.loadProviderConversationDetails).toHaveBeenCalledWith(
			{
				provider: "claude",
				conversationId: "conversation-before-dure",
				executionLocation: "local",
			},
			[],
		);

		fireEvent.click(group);
		expect(group.getAttribute("aria-expanded")).toBe("false");
		expect(
			screen.queryByRole("button", {
				name: /(?:세부 정보|Details).*Existing provider work/i,
			}),
		).toBeNull();
	});

	it("offers Dure-native session actions from the row context menu", async () => {
		mocks.copyTextToClipboard.mockResolvedValue(true);
		mocks.openPath.mockResolvedValue(undefined);
		render(<SessionsPane />);

		const card = await screen.findByRole("article", { name: /Existing provider work/ });
		fireEvent.contextMenu(card);
		const menu = await screen.findByRole("menu");
		expect(
			Array.from(
				menu.querySelectorAll<HTMLElement>("[role='menuitem']"),
				(item) => item.textContent,
			),
		).toEqual([
			expect.stringMatching(/새 pane에서 이어가기|Continue in a new pane/),
			expect.stringMatching(/세부 정보 보기|Show details/),
			expect.stringMatching(/대화 ID 복사|Copy conversation ID/),
			expect.stringMatching(/작업 폴더 복사|Copy working directory/),
			expect.stringMatching(/작업 폴더 열기|Open working directory/),
			expect.stringMatching(/최근 세션에서 제거|Remove from recent sessions/),
		]);

		fireEvent.click(
			screen.getByRole("menuitem", {
				name: /대화 ID 복사|Copy conversation ID/,
			}),
		);
		await waitFor(() =>
			expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
				"conversation-before-dure",
			),
		);

		fireEvent.contextMenu(card);
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: /작업 폴더 열기|Open working directory/,
			}),
		);
		expect(mocks.openPath).toHaveBeenCalledWith("/repo/packages/app");
		expect(mocks.launchDiscovered).not.toHaveBeenCalled();
	});

	it("dismisses the row menu on the first outside pointer gesture", async () => {
		render(<SessionsPane />);

		fireEvent.contextMenu(await screen.findByRole("article", { name: /Existing provider work/ }));
		expect(await screen.findByRole("menu")).toBeTruthy();
		fireEvent.pointerDown(document.body);

		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	});

	it("removes one exact record without touching provider data and restores it", async () => {
		render(<SessionsPane />);

		const card = await screen.findByRole("article", { name: /Existing provider work/ });
		fireEvent.contextMenu(card);
		const remove = await screen.findByRole("menuitem", {
			name: /최근 세션에서 제거|Remove from recent sessions/,
		});
		expect(remove.getAttribute("data-variant")).toBe("destructive");
		fireEvent.click(remove);

		await waitFor(() =>
			expect(screen.queryByRole("article", { name: /Existing provider work/ })).toBeNull(),
		);
		expect(mocks.launchDiscovered).not.toHaveBeenCalled();
		expect(mocks.openPath).not.toHaveBeenCalled();
		expect(mocks.showToast).toHaveBeenCalledWith(
			expect.stringMatching(
				/provider.*pane.*작업 폴더|provider.*pane.*working folder/i,
			),
		);

		fireEvent.click(screen.getByRole("button", { name: /새로고침|Refresh/i }));
		await waitFor(() =>
			expect(mocks.listProviderConversations).toHaveBeenCalledTimes(2),
		);
		expect(screen.queryByRole("article", { name: /Existing provider work/ })).toBeNull();

		fireEvent.click(
			screen.getByRole("button", {
				name: /제거한 최근 세션 1개 복원|Restore 1 removed recent session/i,
			}),
		);
		expect(await screen.findByRole("article", { name: /Existing provider work/ })).toBeTruthy();
		expect(mocks.showToast).toHaveBeenCalledWith(
			expect.stringMatching(/최근 세션 목록에 복원|Restored removed sessions/i),
		);
	});

	it("starts pane placement only from an explicit row drag", async () => {
		render(<SessionsPane />);

		const card = await screen.findByRole("article", { name: /Existing provider work/ });
		const dataTransfer = {
			setData: vi.fn(),
			setDragImage: vi.fn(),
			effectAllowed: "none",
		};
		fireEvent.dragStart(card, { dataTransfer });

		expect(card.getAttribute("draggable")).toBe("true");
		expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
		const [mime, encoded] = dataTransfer.setData.mock.calls[0];
		expect(mime).toBe("text/plain");
		expect(JSON.parse(String(encoded).replace(/^dure:/, ""))).toMatchObject({
			type: "recent-session",
			provider: "claude",
			conversationId: "conversation-before-dure",
			executionLocation: "local",
			cwd: "/repo/packages/app",
			workspaceRoot: "/repo",
		});
		expect(dataTransfer.effectAllowed).toBe("copyMove");
		expect(card.hasAttribute("data-pane-dragging")).toBe(true);
		expect(mocks.launchDiscovered).not.toHaveBeenCalled();

		fireEvent.dragEnd(card);
		expect(card.hasAttribute("data-pane-dragging")).toBe(false);
		fireEvent.click(
			screen.getByRole("button", {
				name: /(?:세부 정보|Details).*Existing provider work/i,
			}),
		);
		expect(mocks.launchDiscovered).not.toHaveBeenCalled();
		expect(card.querySelector("[data-session-details]")).toBeTruthy();
	});

	it("requests expanded details from the session's exact SSH host", async () => {
		const remoteHost = {
			id: "remote-history",
			name: "Build Mac",
			host: "build.test",
			port: 22,
			user: "agent",
			auth: "auto" as const,
		};
		useStore.setState({ sshHosts: [remoteHost] });
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "remote-conversation",
				title: "Remote provider work",
				mtime: Date.now() / 1000,
				cwd: "/srv/repo",
				repositoryRoot: "/srv/repo",
				resumeCapability: "exact",
				executionLocation: "ssh",
				hostId: "remote-history",
				workingDirectoryAvailable: true,
				subagentCount: 1,
			},
		]);
		mocks.loadProviderConversationDetails.mockResolvedValueOnce({
			totalCount: 1,
			subagents: [
				{
					id: "agent-remote",
					title: "Inspect remote history",
					status: "running",
					mtime: Date.now() / 1000,
				},
			],
		});

		render(<SessionsPane />);

		fireEvent.click(
			await screen.findByRole("button", {
				name: /(?:세부 정보|Details).*Remote provider work/i,
			}),
		);
		expect(await screen.findByText("Inspect remote history")).toBeTruthy();
		expect(mocks.listProviderConversations).toHaveBeenCalledWith([remoteHost]);
		expect(mocks.loadProviderConversationDetails).toHaveBeenCalledWith(
			{
				provider: "claude",
				conversationId: "remote-conversation",
				executionLocation: "ssh",
				hostId: "remote-history",
			},
			[remoteHost],
		);
	});

	it("omits local filesystem actions from an SSH session menu", async () => {
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "remote-conversation",
				title: "Remote provider work",
				mtime: Date.now() / 1000,
				cwd: "/srv/repo",
				repositoryRoot: "/srv/repo",
				resumeCapability: "exact",
				executionLocation: "ssh",
				hostId: "remote-history",
				workingDirectoryAvailable: true,
			},
		]);

		render(<SessionsPane />);
		const remoteCard = await screen.findByRole("article", { name: /Remote provider work/ });
		expect(remoteCard.getAttribute("draggable")).toBe("false");
		fireEvent.contextMenu(remoteCard);
		await screen.findByRole("menuitem", {
			name: /작업 폴더 복사|Copy working directory/,
		});
		expect(
			screen.queryByRole("menuitem", {
				name: /작업 폴더 열기|Open working directory/,
			}),
		).toBeNull();
	});

	// User report (2026-08-15): a provider conversation already represented by
	// a pane was indistinguishable from history that would create a new pane.
	it.each(["agent:agent-open-1", "slot", "launcher:previous", "agent:previous"])("identifies a session shown in the current %s pane", async (panelId) => {
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "app",
					path: "/repo",
					kind: "local" as const,
					isRepo: true,
				},
			],
			agents: [
				{
					id: "agent-open-1",
					name: "open-agent",
					provider: "claude" as const,
					projectId: "project-1",
					worktreePath: "/repo/packages/app",
					branch: "main",
					sessionId: "session-open-1",
					sessionKind: "pty" as const,
					conversationId: "conversation-before-dure",
				},
			],
			layouts: {
				"desktop-active": {
					panels: {
						[panelId]: {
							contentComponent: "agent",
							params: { agentRef: { agentId: "agent-open-1" } },
						},
					},
				},
			},
		});
		render(<SessionsPane />);

		await waitFor(() =>
			expect(screen.getByText(/pane에 표시 중|Shown in a pane/)).toBeTruthy(),
		);
		expect(screen.queryByText(/pane에서 열림|Open in pane/)).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: /(?:세부 정보|Details).*Existing provider work/i,
			}),
		);
		expect(
			screen.getByRole("button", {
				name: /(?:Product.*pane 열기|Open pane in Product).*Existing provider work/i,
			}),
		).toBeTruthy();
		expect(screen.queryByText(/이어가기|Continue/)).toBeNull();
	});

	it("names the new-pane outcome when a live session has no pane", async () => {
		const liveAgent = {
			id: "agent-without-pane",
			name: "unopened-agent",
			provider: "claude" as const,
			projectId: "project-1",
			worktreePath: "/repo/packages/app",
			branch: "main",
			sessionId: "session-without-pane",
			sessionKind: "pty" as const,
			conversationId: "conversation-before-dure",
		};
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "app",
					path: "/repo",
					kind: "local" as const,
					isRepo: true,
				},
			],
			agents: [liveAgent],
			agentActivity: { "agent-without-pane": "working" },
		});
		render(<SessionsPane />);

		expect(screen.queryByText(/pane에 표시 중|Shown in a pane/)).toBeNull();
		fireEvent.click(
			await screen.findByRole("button", {
				name: /(?:세부 정보|Details).*Existing provider work/i,
			}),
		);
		const open = await screen.findByRole("button", {
			name: /(?:새 pane에서 열기|Open in a new pane).*Existing provider work/i,
		});
		fireEvent.click(open);

		expect(mocks.openAgentPanelOnDesktop).toHaveBeenCalledWith(
			"desktop-active",
			liveAgent,
		);
		expect(mocks.navigateToPanel).not.toHaveBeenCalled();
	});

	it("opens an unregistered local provider session without an import-required state", async () => {
		const exactOwner = {
			id: "agent-exact-owner",
			name: "claude-resume",
			provider: "claude" as const,
			projectId: "project-1",
			worktreePath: "/repo/packages/app",
			branch: "",
			sessionId: "agent-exact-owner",
			sessionKind: "pty" as const,
			conversationId: "conversation-before-dure",
		};
		mocks.launchDiscovered.mockImplementationOnce(async () => {
			useStore.setState({ agents: [exactOwner] });
			return exactOwner;
		});
		render(<SessionsPane />);

		fireEvent.click(
			await screen.findByRole("button", {
				name: /(?:세부 정보|Details).*Existing provider work/i,
			}),
		);
		const resume = await screen.findByRole("button", {
			name: /(?:새 pane에서 이어가기|Continue in a new pane).*Existing provider work/i,
		});
		expect(screen.queryByText(/가져오기 필요|Import required/)).toBeNull();
		expect(screen.getByText(/이어가기|Continue/)).toBeTruthy();
		expect(
			screen
				.getByRole("button", {
					name: /(?:세부 정보|Details).*Existing provider work/i,
				})
				.getAttribute("aria-expanded"),
		).toBe("true");

		fireEvent.click(resume);
		await waitFor(() =>
			expect(mocks.launchDiscovered).toHaveBeenCalledWith({
				provider: "claude",
				conversationId: "conversation-before-dure",
				cwd: "/repo/packages/app",
				workspaceRoot: "/repo",
				desktopId: "desktop-active",
				existingOwner: "return",
			}),
		);
		expect(mocks.openAgentPanelOnDesktop).toHaveBeenCalledWith(
			"desktop-active",
			exactOwner,
		);
		expect(mocks.message).not.toHaveBeenCalled();
	});

	it("marks an exact working pane before routing through lifecycle resolution", async () => {
		mocks.listProviderConversations.mockResolvedValueOnce([
			{
				provider: "claude",
				id: "conversation-design-labs",
				title: "Design labs continuation",
				mtime: Date.now() / 1000,
				cwd: "/repo/.worktrees/design-labs",
				repositoryRoot: "/repo/.worktrees/design-labs",
				resumeCapability: "exact",
				executionLocation: "local",
				workingDirectoryAvailable: true,
			},
		]);
		const stale = {
			id: "agent-import",
			name: "design-labs",
			provider: "claude" as const,
			projectId: "project-1",
			worktreePath: "/repo/.worktrees/design-labs",
			branch: "agent/design-labs",
			sessionId: "agent-import",
			sessionKind: "pty" as const,
			conversationId: "conversation-design-labs",
			started: true,
			runtimeBinding: {
				schemaVersion: 1 as const,
				runtime: "hmux_managed_v1" as const,
				source: "local" as const,
				hostId: "local" as const,
				sessionId: "agent-import",
				workspaceId: "workspace-design-labs",
				createIdempotencyKey: "agent-import",
			},
		};
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local" as const,
					isRepo: true,
				},
			],
			agents: [stale],
			agentActivity: { "agent-import": "working" },
			layouts: {
				"desktop-active": {
					panels: {
						"agent:agent-import": {
							contentComponent: "agent",
							params: { agentId: "agent-import" },
						},
					},
				},
			},
		});
		mocks.launchDiscovered.mockResolvedValueOnce(stale);

		render(<SessionsPane />);
		searchSessions("design-labs");
		expect(await screen.findByText(/pane에 표시 중|Shown in a pane/)).toBeTruthy();
		fireEvent.click(
			await screen.findByRole("button", {
				name: /(?:세부 정보|Details).*Design labs continuation/i,
			}),
		);
		const open = await screen.findByRole("button", {
			name: /(?:Product.*pane 열기|Open pane in Product).*Design labs continuation/i,
		});
		expect(screen.queryByText(/이어가기|Continue/)).toBeNull();
		fireEvent.click(open);

		await waitFor(() =>
			expect(mocks.launchDiscovered).toHaveBeenCalledWith({
				provider: "claude",
				cwd: "/repo/.worktrees/design-labs",
				workspaceRoot: "/repo/.worktrees/design-labs",
				desktopId: "desktop-active",
				conversationId: "conversation-design-labs",
				existingOwner: "return",
			}),
		);
		expect(mocks.navigateToPanel).toHaveBeenCalledWith(
			"desktop-active",
			"agent:agent-import",
		);
		expect(mocks.openAgentPanelOnDesktop).not.toHaveBeenCalled();
	});
});
