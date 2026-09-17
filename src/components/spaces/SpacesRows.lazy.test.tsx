// @vitest-environment jsdom
//
// Lazy-cost contracts for the row components (Batch 5 items 5 and 6):
// - the context menu of a row is built only when the menu actually opens,
// - the rename dialog mounts only after the user asks for it, and
// - re-expanding an unopened agent's details reuses the session-scoped
//   provider-record cache instead of re-reading provider files.
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	message: vi.fn(),
	open: vi.fn(),
}));
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => ["claude", "codex"],
}));

const mocks = vi.hoisted(() => ({
	loadRecord: vi.fn(),
	loadDetails: vi.fn(),
	renameDialog: vi.fn(() => null),
}));

vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	loadProviderConversationRecord: mocks.loadRecord,
	loadProviderConversationDetails: mocks.loadDetails,
}));
vi.mock("@/components/agents/AgentRenameDialog", () => ({
	AgentRenameDialog: mocks.renameDialog,
}));
vi.mock("@/lib/spaces/spacesActions", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/spaces/spacesActions")>();
	return {
		...original,
		buildSpaceMenu: vi.fn(original.buildSpaceMenu),
	};
});

import {
	OpenSpaceRow,
	type SpaceMenuHandlers,
	type SpaceRowView,
	UnopenedAgentRow,
} from "@/components/spaces/SpacesRows";
import { buildSpaceMenu } from "@/lib/spaces/spacesActions";
import { useStore } from "@/store";

const menuBuildCalls = () => vi.mocked(buildSpaceMenu).mock.calls.length;

const handlers: SpaceMenuHandlers = {
	onViewDiff: vi.fn(),
	onMoveToDesktop: vi.fn(),
	onMoveToNewDesktop: vi.fn(),
	onRestart: vi.fn(),
	onFork: vi.fn(),
	onPromoteManaged: vi.fn(),
	onSwitchAccount: vi.fn(),
	onKill: vi.fn(),
};

const space: SpaceRowView = {
	key: "term:standalone-1",
	desktopId: "desktop-1",
	desktopName: "One",
	kind: "term",
	title: "Codex",
	detail: "detail",
	detailSource: "activity",
	cwd: "/repo",
	projectId: undefined,
	projectName: "repo",
	relativePath: "/repo",
	branch: undefined,
	hostId: undefined,
	hostLabel: "local",
	hostBuild: undefined,
	provider: "codex",
	managedPromotion: "eligible",
	displayState: "waiting",
	unread: false,
	agentId: undefined,
	activityAt: undefined,
};

function openRow() {
	return (
		<OpenSpaceRow
			space={space}
			visibleFields={[]}
			groupBy="repository"
			spaceHeading
			showSpaces
			canViewDiff={false}
			isSelected={false}
			isContextTarget={false}
			selectionCount={1}
			promotionEligibleCount={1}
			promotionDeferredCount={0}
			promotionBusy={false}
			onSpaceClick={vi.fn()}
			onContextMenuOpenChange={vi.fn()}
			onRowDragStart={vi.fn()}
			onRowDragEnd={vi.fn()}
			menuHandlers={handlers}
		/>
	);
}

const agent: Agent = {
	id: "agent-lazy",
	name: "Claude Code",
	provider: "claude",
	projectId: "project-1",
	worktreePath: "/repo/worktree",
	branch: "agent/lazy",
	sessionId: "session-lazy",
	sessionKind: "pty",
};

function unopenedRow(rowAgent: Agent = agent) {
	return (
		<UnopenedAgentRow
			remote={false}
			agent={rowAgent}
			displayState="waiting"
			unread={false}
			projectName="repo"
			detail="repo · agent/lazy"
			onOpen={vi.fn()}
			onViewDiff={vi.fn()}
			onFork={vi.fn()}
			onHide={vi.fn()}
			onKill={vi.fn()}
		/>
	);
}

afterEach(() => {
	cleanup();
	useStore.setState({ sessionActivity: {} });
	vi.clearAllMocks();
});

describe("OpenSpaceRow lazy context menu", () => {
	it("does not build menu entries or subscribe menu inputs before opening", () => {
		useStore.setState({ accounts: [], activeAccounts: {} });
		render(openRow());
		expect(menuBuildCalls()).toBe(0);
	});

	it("builds the menu when it opens and routes its actions", async () => {
		useStore.setState({ accounts: [], activeAccounts: {} });
		const { container } = render(openRow());
		fireEvent.contextMenu(
			container.querySelector(`[data-space-key="${space.key}"]`) as Element,
		);
		expect(
			await screen.findByRole("menuitem", { name: "관리 세션으로 전환" }),
		).toBeTruthy();
		expect(menuBuildCalls()).toBeGreaterThan(0);
	});

	it("treats the checked credential as a semantic no-op", async () => {
		useStore.setState({
			accounts: [
				{
					id: "account-current",
					provider: "codex",
					name: "Current account",
					dir: "/tmp/account-current",
				},
				{
					id: "account-other",
					provider: "codex",
					name: "Other account",
					dir: "/tmp/account-other",
				},
			],
			activeAccounts: { codex: "account-current" },
		});
		const { container } = render(openRow());
		fireEvent.contextMenu(
			container.querySelector(`[data-space-key="${space.key}"]`) as Element,
		);

		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Current account" }),
		);

		expect(handlers.onSwitchAccount).not.toHaveBeenCalled();
	});
});

describe("UnopenedAgentRow lazy rename dialog", () => {
	it("does not mount the rename dialog for rows that never asked for it", () => {
		render(unopenedRow());
		expect(mocks.renameDialog).not.toHaveBeenCalled();
	});

	it("mounts the dialog open when rename is selected from the menu", async () => {
		const { container } = render(unopenedRow());
		fireEvent.contextMenu(
			container.querySelector(`[data-agent-id="${agent.id}"]`) as Element,
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "이름 변경…" }),
		);
		await waitFor(() => {
			expect(mocks.renameDialog).toHaveBeenCalled();
		});
		const calls = mocks.renameDialog.mock.calls as unknown as [
			{ open: boolean },
		][];
		expect(calls[calls.length - 1]?.[0]?.open).toBe(true);
	});
});

describe("UnopenedAgentDetails record cache", () => {
	// The cache is module-scoped on purpose — each test uses its own
	// conversation identity so entries never leak between tests.
	function historyAgent(conversationId: string): Agent {
		return {
			...agent,
			conversationId,
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "legacy_session_v1",
				source: "local",
				hostId: "local",
				sessionId: agent.sessionId,
			} as unknown as Agent["runtimeBinding"],
		};
	}

	function stubRecord(conversationId: string) {
		mocks.loadRecord.mockResolvedValue({
			provider: "claude",
			id: conversationId,
			cwd: "/repo/worktree",
			title: "Inspect the repository",
			mtime: 100,
			resumeCapability: "exact",
			executionLocation: "local",
			recentTurns: [{ role: "user", text: "Inspect this repository." }],
			subagentCount: 0,
		});
		mocks.loadDetails.mockResolvedValue({ subagents: [], totalCount: 0 });
	}

	it("loads the record once across collapse and re-expand", async () => {
		stubRecord("conversation-reexpand");
		const { container } = render(
			unopenedRow(historyAgent("conversation-reexpand")),
		);
		const toggle = () =>
			fireEvent.click(
				container.querySelector(
					`[data-agent-id="${agent.id}"] > button`,
				) as Element,
			);

		toggle();
		expect(await screen.findByText("Inspect this repository.")).toBeTruthy();
		toggle();
		expect(screen.queryByText("Inspect this repository.")).toBeNull();
		toggle();
		expect(await screen.findByText("Inspect this repository.")).toBeTruthy();

		expect(mocks.loadRecord).toHaveBeenCalledTimes(1);
	});

	it("reloads when newer session activity invalidates the cached record", async () => {
		stubRecord("conversation-invalidate");
		const { container } = render(
			unopenedRow(historyAgent("conversation-invalidate")),
		);
		const toggle = () =>
			fireEvent.click(
				container.querySelector(
					`[data-agent-id="${agent.id}"] > button`,
				) as Element,
			);

		toggle();
		expect(await screen.findByText("Inspect this repository.")).toBeTruthy();
		toggle();

		act(() => {
			useStore.setState({
				sessionActivity: {
					[agent.sessionId]: { text: "fresh prompt", at: Date.now() },
				},
			});
		});
		toggle();
		expect(await screen.findByText("Inspect this repository.")).toBeTruthy();

		expect(mocks.loadRecord).toHaveBeenCalledTimes(2);
	});
});
