// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	AgentConversationHistoryControl,
	type AgentConversationHistoryActionLease,
	useAgentConversationHistoryActionLease,
} from "@/components/agents/AgentConversationHistoryControl";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { requestConversationHistoryMenu } from "@/lib/workspace/pane/paneMenuSignals";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	launchSibling: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function testHistoryActionLease(): AgentConversationHistoryActionLease {
	let busy = false;
	return {
		get busy() {
			return busy;
		},
		async run(action) {
			if (busy) return false;
			busy = true;
			try {
				await action();
				return true;
			} finally {
				busy = false;
			}
		},
	};
}

function HistoryControlOwner({
	runtimeKey,
	...props
}: Omit<
	ComponentProps<typeof AgentConversationHistoryControl>,
	"actionLease"
> & { runtimeKey?: string }) {
	const actionLease = useAgentConversationHistoryActionLease();
	return (
		<AgentConversationHistoryControl
			key={runtimeKey}
			{...props}
			actionLease={actionLease}
		/>
	);
}

vi.mock("@/lib/sessions/managed/managedConversationLaunch", () => ({
	launchManagedConversationTargetInSibling: mocks.launchSibling,
	managedConversationLaunchFailureMessage: String,
}));

const agent: Agent = {
	id: "agent-live",
	name: "live",
	provider: "codex",
	projectId: "project-1",
	worktreePath: "/repo",
	branch: "agent/live",
	sessionId: "session-live",
	sessionKind: "pty",
	runtimeBinding: hmuxManagedBinding("session-live", "workspace-1"),
	conversationId: "conversation-live",
	started: true,
};

describe("AgentConversationHistoryControl", () => {
	it("opens an exact history item in a sibling without replacing the live pane", async () => {
		mocks.launchSibling.mockReset();
		const switchExisting = vi.fn().mockResolvedValue(undefined);
		const rendered = render(
			<HistoryControlOwner
				activeConversationId="conversation-live"
				activity="waiting"
				agent={agent}
				binding={agent.runtimeBinding}
				conversations={[
					{ id: "conversation-live", title: "Current", mtime: 2 },
					{ id: "conversation-history", title: "Previous", mtime: 1 },
				]}
				mutationAllowed
				mutationDisabledTitle="disabled"
				onError={vi.fn()}
				onLoad={vi.fn()}
				onSwitchExisting={switchExisting}
				paneDesktopId="desktop-1"
				panelId="agent:agent-1"
				projectKind="local"
				resuming={false}
			/>,
		);

		// 트리거 버튼은 이제 숨겨진 앵커다 — pane 톱바 ⋮의 "최근 작업" 항목이
		// 보내는 신호로 연다(사용자 요청 2026-08-01).
		act(() => requestConversationHistoryMenu("agent:agent-1"));
		fireEvent.click(
			await rendered.findByRole("menuitem", {
				name: /Previous.*새 pane에서 이어가기/,
			}),
		);

		await waitFor(() =>
			expect(mocks.launchSibling).toHaveBeenCalledWith({
				sourceAgentId: agent.id,
				desktopId: "desktop-1",
				referencePanelId: "agent:agent-1",
				target: { kind: "id", id: "conversation-history" },
			}),
		);
		expect(switchExisting).not.toHaveBeenCalled();
	});

	it("lets an exited managed pane attempt exact Resume without mutation admission", async () => {
		mocks.launchSibling.mockReset();
		const switchExisting = vi.fn().mockResolvedValue(undefined);
		const rendered = render(
			<HistoryControlOwner
				activeConversationId="conversation-live"
				activity="exited"
				agent={agent}
				binding={agent.runtimeBinding}
				conversations={[
					{ id: "conversation-history", title: "Previous", mtime: 1 },
				]}
				mutationAllowed={false}
				mutationDisabledTitle="disabled"
				onError={vi.fn()}
				onLoad={vi.fn()}
				onSwitchExisting={switchExisting}
				paneDesktopId="desktop-1"
				panelId="agent:agent-exited-resume"
				projectKind="local"
				resuming={false}
			/>,
		);

		act(() => requestConversationHistoryMenu("agent:agent-exited-resume"));
		const fresh = await rendered.findByRole("menuitem", {
			name: /^새 대화$/,
		});
		expect(fresh.hasAttribute("data-disabled")).toBe(true);
		fireEvent.click(
			rendered.getByRole("menuitem", {
				name: /Previous.*이어가기/,
			}),
		);

		await waitFor(() =>
			expect(switchExisting).toHaveBeenCalledWith({
				kind: "id",
				id: "conversation-history",
			}),
		);
		expect(mocks.launchSibling).not.toHaveBeenCalled();
	});

	it("uses the same sibling history action for a structured live source", async () => {
		mocks.launchSibling.mockReset();
		const structured = {
			...agent,
			runtimeBinding: undefined,
			interactionProfile: {
				schemaVersion: 1 as const,
				kind: "structured_protocol" as const,
				backendProfileId: "local",
				interactionSessionId: "interaction-live",
			},
		};
		const rendered = render(
			<AgentConversationHistoryControl
				actionLease={testHistoryActionLease()}
				activeConversationId="conversation-live"
				activity="waiting"
				agent={structured}
				binding={undefined}
				conversations={[
					{ id: "conversation-history", title: "Previous", mtime: 1 },
				]}
				mutationAllowed
				mutationDisabledTitle="disabled"
				onError={vi.fn()}
				onLoad={vi.fn()}
				onSwitchExisting={vi.fn()}
				paneDesktopId="desktop-1"
				panelId="agent:agent-structured"
				projectKind="local"
				resuming={false}
			/>,
		);

		act(() => requestConversationHistoryMenu("agent:agent-structured"));
		fireEvent.click(
			await rendered.findByRole("menuitem", {
				name: /Previous.*새 pane에서 이어가기/,
			}),
		);

		await waitFor(() =>
			expect(mocks.launchSibling).toHaveBeenCalledWith({
				sourceAgentId: structured.id,
				desktopId: "desktop-1",
				referencePanelId: "agent:agent-structured",
				target: { kind: "id", id: "conversation-history" },
			}),
		);
	});

	it("leases a controlled history action until its sibling launch settles", async () => {
		mocks.launchSibling.mockReset();
		const firstLaunch = deferred<void>();
		mocks.launchSibling
			.mockImplementationOnce(() => firstLaunch.promise)
			.mockResolvedValueOnce(undefined);
		const rendered = render(
			<HistoryControlOwner
				activeConversationId="conversation-live"
				activity="waiting"
				agent={agent}
				binding={agent.runtimeBinding}
				conversations={[]}
				mutationAllowed
				mutationDisabledTitle="disabled"
				onError={vi.fn()}
				onLoad={vi.fn()}
				onSwitchExisting={vi.fn()}
				paneDesktopId="desktop-1"
				panelId="agent:agent-action-lease"
				projectKind="local"
				resuming={false}
			/>,
		);

		act(() => requestConversationHistoryMenu("agent:agent-action-lease"));
		fireEvent.click(
			await rendered.findByRole("menuitem", {
				name: /새 pane에서 새 대화/,
			}),
		);
		await waitFor(() => expect(mocks.launchSibling).toHaveBeenCalledTimes(1));

		act(() => requestConversationHistoryMenu("agent:agent-action-lease"));
		const reopenedFresh = await rendered.findByRole("menuitem", {
			name: /새 pane에서 새 대화/,
		});
		expect(reopenedFresh.hasAttribute("data-disabled")).toBe(true);
		fireEvent.click(reopenedFresh);
		expect(mocks.launchSibling).toHaveBeenCalledTimes(1);

		await act(async () => firstLaunch.resolve());
		await waitFor(() =>
			expect(reopenedFresh.hasAttribute("data-disabled")).toBe(false),
		);
		fireEvent.click(reopenedFresh);
		await waitFor(() => expect(mocks.launchSibling).toHaveBeenCalledTimes(2));
	});

	it("keeps one launch lease when the runtime-keyed control remounts", async () => {
		mocks.launchSibling.mockReset();
		const firstLaunch = deferred<void>();
		mocks.launchSibling
			.mockImplementationOnce(() => firstLaunch.promise)
			.mockResolvedValueOnce(undefined);
		const props = {
			activeConversationId: "conversation-live",
			activity: "waiting" as const,
			agent,
			binding: agent.runtimeBinding,
			conversations: [],
			mutationAllowed: true,
			mutationDisabledTitle: "disabled",
			onError: vi.fn(),
			onLoad: vi.fn(),
			onSwitchExisting: vi.fn(),
			paneDesktopId: "desktop-1",
			panelId: "agent:agent-remount-lease",
			projectKind: "local" as const,
			resuming: false,
		};
		const rendered = render(
			<HistoryControlOwner
				runtimeKey="runtime-1"
				{...props}
			/>,
		);

		act(() => requestConversationHistoryMenu(props.panelId));
		fireEvent.click(
			await rendered.findByRole("menuitem", {
				name: /새 pane에서 새 대화/,
			}),
		);
		await waitFor(() => expect(mocks.launchSibling).toHaveBeenCalledTimes(1));

		rendered.rerender(
			<HistoryControlOwner
				runtimeKey="runtime-2"
				{...props}
			/>,
		);
		act(() => requestConversationHistoryMenu(props.panelId));
		const remountedAction = await rendered.findByRole("menuitem", {
			name: /새 pane에서 새 대화/,
		});
		expect(remountedAction.hasAttribute("data-disabled")).toBe(true);
		fireEvent.click(remountedAction);

		expect(mocks.launchSibling).toHaveBeenCalledTimes(1);
		await act(async () => firstLaunch.resolve());
	});
});
