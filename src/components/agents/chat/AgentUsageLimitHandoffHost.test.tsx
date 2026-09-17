// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentUsageLimitHandoffHost } from "./AgentUsageLimitHandoffHost";

const mocks = vi.hoisted(() => ({
	state: {
		agents: [] as unknown[],
		accounts: [
			{
				id: "next-account",
				name: "Next",
				provider: "codex",
				dir: "/fixture/next",
			},
		],
		autoSwitchAccounts: true,
	},
	session: {
		page: { rows: [] as unknown[] },
		sending: false,
		activeTurn: undefined,
	},
	switchAccount: vi.fn(),
	resume: vi.fn(),
}));
vi.mock("@/store", () => ({
	useStore: (selector: (state: unknown) => unknown) => selector(mocks.state),
}));
vi.mock("@/components/agents/chat/useAgentChatSession", () => ({
	useAgentChatSession: () => mocks.session,
}));
vi.mock("@/lib/agents/agentCredentialTransition", () => ({
	requestAgentCredentialTransition: mocks.switchAccount,
}));
vi.mock("@/lib/agents/agentRuntimeTransitionAction", () => ({
	recoverStructuredAgentRuntimeProjection: vi.fn(),
}));
vi.mock("@/lib/agents/chat/resumeUsageLimitTurn", () => ({
	resumeUsageLimitTurn: mocks.resume,
}));
vi.mock("@/lib/sessions/managed/managedCredentialSwitchTransition", () => ({
	useManagedCredentialSwitchTransition: () => false,
}));
vi.mock("@/lib/ipc", () => ({
	usageRecent: async () => ({ codexAccountSnapshots: [] }),
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("continues a newly failed registered conversation without mounting any pane", async () => {
	mocks.state.agents = [
		{
			id: "background-handoff-agent",
			provider: "codex",
			interactionProfile: {
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "background-session",
			},
		},
	];
	mocks.state.autoSwitchAccounts = true;
	mocks.session.page.rows = [];
	mocks.switchAccount.mockResolvedValue({
		kind: "completed",
		conversationId: "same-conversation",
	});
	mocks.resume.mockResolvedValue("accepted");
	const view = render(
		<>
			<AgentUsageLimitHandoffHost />
			<AgentUsageLimitHandoffHost />
		</>,
	);
	expect(view.container.childElementCount).toBe(0);
	expect(mocks.switchAccount).not.toHaveBeenCalled();
	const failedAt = Date.now() + 1000;
	mocks.session.page.rows = [
		{
			item: {
				body: {
					type: "message",
					role: "user",
					markdown: "Continue the exact background task",
				},
				turnId: "failed-turn",
			},
		},
		{
			item: {
				itemId: "background-failure",
				body: {
					type: "lifecycle",
					state: "turn_failed",
					detail: "usage_limit",
				},
				turnId: "failed-turn",
				createdAtMs: failedAt,
			},
		},
	];
	view.rerender(
		<>
			<AgentUsageLimitHandoffHost />
			<AgentUsageLimitHandoffHost />
		</>,
	);
	await waitFor(() =>
		expect(mocks.switchAccount).toHaveBeenCalledExactlyOnceWith({
			agentId: "background-handoff-agent",
			targetCredentialId: "next-account",
			sourcePanelId: "agent:background-handoff-agent",
		}),
	);
	await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
	expect(mocks.resume.mock.calls[0]?.[0]).toMatchObject({
		userInput: "Continue the exact background task",
	});
	view.unmount();
	render(<AgentUsageLimitHandoffHost />);
	await act(async () => {});
	expect(mocks.switchAccount).toHaveBeenCalledOnce();
	expect(mocks.resume).toHaveBeenCalledOnce();
});

it("keeps automatic recovery opt-in and does not use local accounts for remote conversations", async () => {
	mocks.state.agents = [
		{
			id: "remote-handoff-agent",
			provider: "codex",
			interactionProfile: {
				kind: "structured_protocol",
				backendProfileId: "remote",
				interactionSessionId: "remote-session",
			},
		},
	];
	mocks.state.autoSwitchAccounts = true;
	const view = render(<AgentUsageLimitHandoffHost />);
	await act(async () => {});
	expect(mocks.switchAccount).not.toHaveBeenCalled();
	mocks.state.autoSwitchAccounts = false;
	mocks.state.agents = [
		{
			id: "optout-handoff-agent",
			provider: "codex",
			interactionProfile: {
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "local-session",
			},
		},
	];
	view.rerender(<AgentUsageLimitHandoffHost />);
	await act(async () => {});
	expect(mocks.switchAccount).not.toHaveBeenCalled();
});
