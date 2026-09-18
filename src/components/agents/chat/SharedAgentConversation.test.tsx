// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedAgentConversation } from "./SharedAgentConversation";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import { setLang } from "@/lib/i18n";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { useStore } from "@/store";

const mocks = vi.hoisted(() => ({
	session: null as unknown as AgentChatSessionView,
	useSession: vi.fn(),
	accounts: vi.fn(),
	switchAccount: vi.fn(),
}));
vi.mock("./useAgentChatSession", () => ({
	useAgentChatSession: (...args: unknown[]) => {
		mocks.useSession(...args);
		return mocks.session;
	},
}));
vi.mock("@/lib/agents/chat/sharedConversationAccounts", () => ({
	sharedConversationAccounts: mocks.accounts,
	switchSharedConversationAccount: mocks.switchAccount,
}));
const target: SharedAgentConversationTarget = {
	agentId: "shared",
	authority: testDureBackendRouteAuthority("server", "generation", "team"),
	profile: {
		schemaVersion: 1,
		kind: "structured_protocol",
		backendProfileId: "team",
		interactionSessionId: "conversation",
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	setLang("en");
	useStore.setState({ accounts: [], terminalFontSize: 10 });
	mocks.accounts.mockResolvedValue([{ id: "work", name: "Team Work" }]);
	mocks.switchAccount.mockResolvedValue({
		interactionProfile: "structured_protocol",
		interactionSessionId: "replacement",
	});
	mocks.session = {
		phase: "ready",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		retryTurnAvailable: false,
		interrupting: false,
		loadingOlder: false,
		queuedMessages: [],
		draftIdentity: {
			agentId: target.agentId,
			backendProfileId: "team",
			interactionSessionId: "conversation",
		},
		page: {
			binding: {
				schemaVersion: 1,
				agentId: target.agentId,
				interactionSessionId: "conversation",
				providerId: "codex",
				executionProfile: { kind: "provider_default" },
				providerConversationRef: "provider-conversation",
				runtime: { runtimeGeneration: "runtime", providerEpoch: "provider" },
				timelineEpoch: "timeline",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			rows: [],
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			recovery: null,
			goal: null,
			latestFailure: {
				itemId: "failure",
				reason: "usage_limit",
				createdAtMs: 1,
				userInput: "Retained request",
			},
			finalCursor: { epoch: "timeline", sequence: 1 },
			hasMore: false,
		},
		putGoal: vi.fn(),
		retryConnection: vi.fn(),
		loadOlder: vi.fn(),
		send: vi.fn().mockResolvedValue(undefined),
		queueMessage: vi.fn(),
		steerOrQueue: vi.fn(),
		dequeueMessage: vi.fn(),
		loadMoreQueued: vi.fn(),
		retryTurn: vi.fn(),
		editRetryableTurn: vi.fn(),
		answerPending: vi.fn(),
		interrupt: vi.fn(),
		dismissActionError: vi.fn(),
	};
});
afterEach(cleanup);
it("offers account switching without an IDE pane and sends retained input only on explicit resend", async () => {
	render(<SharedAgentConversation target={target} />);
	fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
	fireEvent.click(await screen.findByRole("button", { name: "Team Work" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(mocks.switchAccount).toHaveBeenCalledWith(
		target,
		mocks.session.page!.binding,
		"work",
		[],
	);
	expect(mocks.useSession).toHaveBeenLastCalledWith(
		target.agentId,
		{ ...target.profile, interactionSessionId: "replacement" },
		undefined,
		target.authority,
	);
	expect(mocks.session.send).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Resend last message" }));
	expect(mocks.session.send).toHaveBeenCalledWith("Retained request");
});
it("keeps the failure and conversation after a refused switch", async () => {
	mocks.switchAccount.mockRejectedValue(
		new Error("The source has active work"),
	);
	render(<SharedAgentConversation target={target} />);
	fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
	fireEvent.click(await screen.findByRole("button", { name: "Team Work" }));
	await screen.findByText("The source has active work");
	expect(screen.getByRole("dialog")).toBeTruthy();
	expect(mocks.session.retryConnection).not.toHaveBeenCalled();
	expect(mocks.session.send).not.toHaveBeenCalled();
});
it("locks account choices while work is active", async () => {
	mocks.session.activeTurn = { turnId: "turn", clientMessageId: "input" };
	render(<SharedAgentConversation target={target} />);
	fireEvent.click(
		screen.getByRole("button", { name: "Default account (CLI as-is)" }),
	);
	const choice = await screen.findByRole("button", { name: "Team Work" });
	expect((choice as HTMLButtonElement).disabled).toBe(true);
	expect(screen.queryByText("Switching account…")).toBeNull();
	fireEvent.click(choice);
	expect(mocks.switchAccount).not.toHaveBeenCalled();
});
it("does not apply a late switch receipt to another shared task", async () => {
	let finish!: (value: unknown) => void;
	mocks.switchAccount.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const view = render(<SharedAgentConversation target={target} />);
	fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
	fireEvent.click(await screen.findByRole("button", { name: "Team Work" }));
	const next = { ...target, agentId: "other-task" };
	view.rerender(<SharedAgentConversation target={next} />);
	await act(async () => {
		finish({
			interactionProfile: "structured_protocol",
			interactionSessionId: "old-replacement",
		});
	});
	expect(mocks.useSession).toHaveBeenLastCalledWith(
		next.agentId,
		next.profile,
		undefined,
		next.authority,
	);
	expect(mocks.session.retryConnection).not.toHaveBeenCalled();
});
