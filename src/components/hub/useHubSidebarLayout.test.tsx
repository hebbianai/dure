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

const mocks = vi.hoisted(() => ({
	history: { entries: [] as ProviderConversationRecord[], loadState: "ready" },
	spaces: [] as (LayoutSpace & { key: string; kind: "term" })[],
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
		});
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
