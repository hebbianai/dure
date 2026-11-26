// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import { publishConversationTitle } from "@/lib/agents/chat/conversationPresentationState";
import { UNOPENED_DESKTOP, type LayoutSpace, type SidebarLayout } from "@/lib/hub/sidebarLayout";
import { useStore } from "@/store";
import { managedAgentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Project } from "@/types";
import { useHubSidebarLayout } from "@/components/hub/useHubSidebarLayout";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import { setAgentNotificationsMuted } from "@/lib/agents/agentNotificationMute";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";

const mocks = vi.hoisted(() => ({
	history: { entries: [] as ProviderConversationRecord[], loadState: "ready" },
	spaces: [] as (LayoutSpace & { key: string; kind: "term"; notificationsMuted?: true })[],
}));

// Most fixtures have no open panes, so agent rows use unopened presentation.
vi.mock("@/components/spaces/useSpaces", () => ({ useSpaces: () => mocks.spaces }));
vi.mock("@/components/sessions/useRecentSessionHistory", () => ({
	useRecentSessionHistory: () => mocks.history,
}));

const project: Project = {
	id: "project-1",
	name: "dure-internal",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

/** An agent the way the app registers one: named after its worktree. */
const agent = managedAgentFixture({
	id: "agent-1",
	name: "codex-14",
	provider: "claude",
	projectId: project.id,
	worktreePath: "/repo/.worktrees/codex-14",
	branch: "agent/codex-14",
	conversationId: "conversation-1",
	runtimeBinding: managedBindingFixture({ sessionId: "hmux-1" }),
});

const history: ProviderConversationRecord = {
	provider: "claude",
	id: "conversation-1",
	cwd: "/repo/.worktrees/codex-14",
	title: "결제 API 리트라이 로직 수정",
	mtime: 100,
	resumeCapability: "exact",
	executionLocation: "local",
};

function lastSent(send: ReturnType<typeof vi.fn>): SidebarLayout {
	return send.mock.calls[send.mock.calls.length - 1]?.[0] as SidebarLayout;
}

describe("useHubSidebarLayout — mobile presentation", () => {
	beforeEach(() => {
		mocks.spaces = [];
		mocks.history = { entries: [history], loadState: "ready" };
		useStore.setState({
			agents: [agent],
			projects: [project],
			desktops: [],
			sshHosts: [],
			gitStatuses: {},
			sessionTitle: {},
			pinnedPanes: {},
			sessionAgentRuntimeState: {},
		});
		useAgentAttention.setState({ recoveryWaits: {} });
	});

	it("publishes pin and unpin changes for the exact Space and pane", () => {
		mocks.spaces = [{
			key: "term:one", kind: "term", desktopId: "work", projectName: "Dure",
			title: "Pinned terminal", hmuxSessionId: "terminal-1",
		}];
		useStore.setState({ desktops: [{ id: "work", name: "Work" }], agents: [] });
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const presentation = () => lastSent(send).placements["terminal-1"].presentation;
		expect(presentation()).toMatchObject({ pinned: false });
		act(() => useStore.setState({ pinnedPanes: { "other:term:one": true } }));
		expect(presentation()).toMatchObject({ pinned: false });
		act(() => useStore.setState({ pinnedPanes: { "work:term:one": true } }));
		expect(presentation()).toMatchObject({ pinned: true });
		act(() => useStore.setState({ pinnedPanes: {} }));
		expect(presentation()).toMatchObject({ pinned: false });
	});

	it("publishes changing Git observations without moving the session's placement", () => {
		useDiffBadges.setState({ badges: {} });
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const before = lastSent(send).placements["hmux-1"];
		expect(before.presentation?.git).toBeUndefined();
		act(() => useDiffBadges.getState().setBadge(agent.id, {
			added: 3, deleted: 1, binary: 0, files: 3,
			committed: { added: 1, deleted: 0, binary: 0, files: 1 },
			worktree: { added: 2, deleted: 1, binary: 0, files: 2 },
			ahead: 1, behind: 6,
		}));
		const after = lastSent(send).placements["hmux-1"];
		expect(after.presentation?.git).toEqual({ committed: 1, worktree: 2, ahead: 1, behind: 6 });
		expect([after.desktop, after.project, after.order]).toEqual([before.desktop, before.project, before.order]);
		act(() => useDiffBadges.getState().setBadge(agent.id, null));
		expect(lastSent(send).placements["hmux-1"].presentation?.git).toBeUndefined();
	});

	/** #287: the account line is what lets a phone offer the switch, and it
	 * follows the selector's state — including a switch queued behind a turn. */
	it("publishes the session's account line and its queued switch", () => {
		useStore.setState({
			accounts: [
				{ id: "acct-work", provider: "claude", name: "Work", dir: "/profiles/work" },
				{ id: "acct-spare", provider: "claude", name: "Spare", dir: "/profiles/spare" },
			],
			agents: [{
				...agent,
				runtimeBinding: managedBindingFixture({ sessionId: "hmux-1", credentialId: "acct-work" }),
			}],
		});
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const account = () => lastSent(send).placements["hmux-1"].presentation?.account;
		expect(account()).toEqual({ label: "Work" });
		act(() => useStore.setState((state) => ({
			agents: state.agents.map((one) => ({
				...one,
				pendingCredentialSwitch: { targetCredentialId: "acct-spare", sourceCredentialId: "acct-work" },
			} as typeof one)),
		})));
		expect(account()).toEqual({ label: "Work", pending: { label: "Spare" } });
		expect(JSON.stringify(lastSent(send))).not.toContain("/profiles/");
	});

	/** #626: the phone's home answers the approval the row waits on, so the
	 * row carries the Host's attention id and request while it is pending. */
	it("publishes the Host's pending approval and drops it once answered", () => {
		const waiting = {
			terminalEpoch: "terminal-1", revision: "4", observedThroughOutputSeq: "9",
			lifecycle: "running", activity: "waiting", attention: "approval_required",
			attentionId: "attention-7", source: "provider_event",
			approvalRequest: { toolName: "Bash", summary: "cargo test", choices: ["approve", "deny"] },
		} as const;
		useStore.setState({ sessionAgentRuntimeState: { [agent.sessionId]: waiting } });
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const approval = () => lastSent(send).placements["hmux-1"].presentation?.approval;
		expect(approval()).toEqual({
			attentionId: "attention-7",
			request: { toolName: "Bash", summary: "cargo test", choices: ["approve", "deny"] },
		});
		act(() => useStore.setState({
			sessionAgentRuntimeState: {
				[agent.sessionId]: { ...waiting, revision: "5", activity: "working", attention: "none", attentionId: undefined, approvalRequest: undefined },
			},
		}));
		expect(approval()).toBeUndefined();
	});

	/** #729: the phone honours the computer's mute for its own alerts, so the
	 * row carries it while muted and drops it once unmuted. */
	it("publishes the agent's notification mute for open and unopened rows", () => {
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const muted = (key: string) => lastSent(send).placements[key].presentation?.notificationsMuted;
		expect(muted("hmux-1")).toBeUndefined();
		act(() => setAgentNotificationsMuted(agent.id, true));
		expect(muted("hmux-1")).toBe(true);
		act(() => setAgentNotificationsMuted(agent.id, false));
		expect(muted("hmux-1")).toBeUndefined();

		// An open row carries the flag its sidebar row was given.
		mocks.spaces = [{
			key: "term:one", kind: "term", desktopId: "work", projectName: "Dure",
			title: "Open agent", hmuxSessionId: "terminal-1", notificationsMuted: true,
		}];
		act(() => useStore.setState({ desktops: [{ id: "work", name: "Work" }] }));
		expect(muted("terminal-1")).toBe(true);
	});

	/** #726: the phone's needs-person authority leaves out an error the
	 * computer's backend continues after the reset, so each Agent row carries
	 * that backend's wait, open or unopened, and drops it once it ends. */
	it("publishes each Agent's recovery wait for open and unopened rows", () => {
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const wait = (key: string) => lastSent(send).placements[key].presentation?.continuesAtMs;
		expect(wait("hmux-1")).toBeUndefined();
		act(() => useAgentAttention.getState().setRecoveryWaits({ [agent.id]: 1_700_000_600_000 }));
		expect(wait("hmux-1")).toBe(1_700_000_600_000);

		// An open pane carries the backend's wait, not the row's words for it.
		mocks.spaces = [{
			key: "agent:one", kind: "term", desktopId: "work", projectName: "Dure",
			title: "Open agent", hmuxSessionId: "hmux-1", agentId: agent.id,
		} as (typeof mocks.spaces)[number]];
		act(() => useStore.setState({ desktops: [{ id: "work", name: "Work" }] }));
		expect(wait("hmux-1")).toBe(1_700_000_600_000);
		act(() => useAgentAttention.getState().setRecoveryWaits({}));
		expect(wait("hmux-1")).toBeUndefined();
	});

	/** #732 S8: the phone builds who manages whom from each row's Agent and
	 * the display manager the relation owner picked, open or unopened, and
	 * hears when a Run parent appears. */
	it("publishes each row's Agent and its display manager", () => {
		const worker = managedAgentFixture({
			id: "agent-2",
			name: "codex-15",
			provider: "claude",
			projectId: project.id,
			worktreePath: "/repo/.worktrees/codex-15",
			runtimeBinding: managedBindingFixture({ sessionId: "hmux-2" }),
		});
		useStore.setState({ agents: [agent, worker] });
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const presented = (key: string) => lastSent(send).placements[key].presentation;
		expect(presented("hmux-1")).toMatchObject({ agentId: "agent-1" });
		expect(presented("hmux-2")).toMatchObject({ agentId: "agent-2" });
		expect(presented("hmux-2")?.managerAgentId).toBeUndefined();

		// The worker turns out to be a Run started from the lead's Session.
		const parent = agent.runtimeBinding as { sessionId: string; workspaceId: string };
		act(() => useStore.setState({
			agents: [agent, { ...worker, runParent: { sessionId: parent.sessionId, workspaceId: parent.workspaceId } }],
		}));
		expect(presented("hmux-2")).toMatchObject({ agentId: "agent-2", managerAgentId: "agent-1" });
		expect(presented("hmux-1")?.managerAgentId).toBeUndefined();

		// An open pane names the same relation.
		mocks.spaces = [{
			key: "agent:two", kind: "term", desktopId: "work", projectName: "Dure",
			title: "Open worker", hmuxSessionId: "hmux-2", agentId: "agent-2",
		} as (typeof mocks.spaces)[number]];
		act(() => useStore.setState({ desktops: [{ id: "work", name: "Work" }] }));
		expect(presented("hmux-2")).toMatchObject({ agentId: "agent-2", managerAgentId: "agent-1" });
	});

	/**
	 * The sidebar names this row by its conversation; the phone must get the
	 * same name, not the worktree slug the agent is registered under.
	 */
	it("sends the sidebar's title, not the agent's worktree name", () => {
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));

		const seat = lastSent(send).placements["hmux-1"];
		expect(seat.desktop).toBe(UNOPENED_DESKTOP);
		expect(seat.project).toBe("dure-internal");
		expect(seat.branch).toBe("agent/codex-14");
		expect(seat.title).toBe("결제 API 리트라이 로직 수정");
	});

	/** A title the conversation earns while the app runs reaches the phone. */
	it("re-sends when a live conversation title is published", () => {
		const send = vi.fn();
		renderHook(() => useHubSidebarLayout(send));
		const before = send.mock.calls.length;

		act(() => publishConversationTitle("agent-1", "Retry the payment API"));

		expect(send.mock.calls.length).toBeGreaterThan(before);
		expect(lastSent(send).placements["hmux-1"].title).toBe("Retry the payment API");
	});
});
