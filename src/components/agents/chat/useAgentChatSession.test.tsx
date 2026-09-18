// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import type { AgentConversationInvalidationV1 } from "@/lib/ipc/dureAgentConversation";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { useSpaces } from "@/components/spaces/useSpaces";
import { useStore } from "@/store";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	read: vi.fn(),
	subscribe: vi.fn(),
	startTurn: vi.fn(),
	answerPending: vi.fn(),
	interruptTurn: vi.fn(),
	recover: vi.fn(),
	close: vi.fn(),
	createClient: vi.fn(),
	invalidation: undefined as
		| ((event: AgentConversationInvalidationV1) => void)
		| undefined,
}));

vi.mock("@/lib/ipc/dureAgentConversation", () => ({
	createDureAgentConversationClient: mocks.createClient,
}));

const backend = { id: "backend", generation: "one" };
const routeAuthority = testDureBackendRouteAuthority(
	backend.id,
	backend.generation,
	"strict-profile",
);
const initial = {
	type: "page" as const,
	page: {
		binding: {
			schemaVersion: 1 as const,
			interactionSessionId: "interaction-strict",
			agentId: "agent-strict",
			providerId: "codex" as const,
			executionProfile: { kind: "provider_default" as const },
			providerConversationRef: "conversation-strict",
			runtime: {
				runtimeGeneration: "runtime-1",
				providerEpoch: "provider-1",
			},
			timelineEpoch: "timeline-1",
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
		latestFailure: null,
		goal: null,
		finalCursor: { epoch: "timeline-1", sequence: 0 },
		hasMore: false,
	},
};

describe("useAgentChatSession", () => {
	beforeEach(() => {
		mocks.invalidation = undefined;
		mocks.inspect.mockReset().mockResolvedValue({
			backend,
			routeAuthority,
			binding: initial.page.binding,
		});
		mocks.read
			.mockReset()
			.mockResolvedValue({ backend, routeAuthority, read: initial });
		mocks.subscribe
			.mockReset()
			.mockImplementation(
				async (
					_request: unknown,
					onInvalidation: (event: AgentConversationInvalidationV1) => void,
				) => {
					mocks.invalidation = onInvalidation;
					return {
						subscriptionId: "subscription-strict",
						backend,
						routeAuthority,
						initial,
						close: mocks.close,
					};
				},
			);
		mocks.startTurn.mockReset().mockResolvedValue(undefined);
		mocks.answerPending.mockReset().mockResolvedValue(undefined);
		mocks.interruptTurn.mockReset().mockResolvedValue(undefined);
		mocks.recover.mockReset();
		mocks.close.mockReset().mockResolvedValue(undefined);
		mocks.createClient.mockReset().mockReturnValue({
			inspect: mocks.inspect,
			read: mocks.read,
			subscribe: mocks.subscribe,
			startTurn: mocks.startTurn,
			answerPending: mocks.answerPending,
			interruptTurn: mocks.interruptTurn,
			recover: mocks.recover,
		});
	});

	afterEach(() => {
		cleanup();
		useStore.setState({ agents: [], layouts: {}, sessionActivity: {} });
	});

	it.each(["agent", "backend", "interaction"])(
		"does not render the previous controller under a new %s draft identity",
		async (change) => {
			const original = {
				agentId: `agent-draft-${change}`,
				backendProfileId: `profile-draft-${change}`,
				interactionSessionId: `interaction-draft-${change}`,
			};
			const firstPage = { ...initial, page: { ...initial.page,
				binding: { ...initial.page.binding, agentId: original.agentId, interactionSessionId: original.interactionSessionId },
			} };
			mocks.inspect.mockResolvedValue({ backend, routeAuthority, binding: firstPage.page.binding });
			mocks.read.mockResolvedValue({ backend, routeAuthority, read: firstPage });
			mocks.subscribe.mockResolvedValue({ subscriptionId: `subscription-draft-${change}`, backend, routeAuthority, initial: firstPage, close: mocks.close });
			const renders: Array<{ phase: string; page: unknown }> = [];
			const hook = renderHook((identity: typeof original) => {
				const view = useAgentChatSession(identity.agentId, {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: identity.backendProfileId,
					interactionSessionId: identity.interactionSessionId,
				});
				renders.push({ phase: view.phase, page: "page" in view ? view.page : undefined });
				return view;
			}, { initialProps: original });
			await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
			mocks.inspect.mockImplementationOnce(() => new Promise(() => {}));
			renders.length = 0;
			hook.rerender({
				...original,
				...(change === "agent" ? { agentId: "other-agent", interactionSessionId: "other-agent-interaction" } : {}),
				...(change === "backend" ? { backendProfileId: "other-profile" } : {}),
				...(change === "interaction" ? { interactionSessionId: "other-interaction" } : {}),
			});
			expect(renders[0]).toEqual({ phase: "detached", page: undefined });
			expect(mocks.startTurn).not.toHaveBeenCalled();
		},
	);

	it("projects the provider timestamp into Spaces for Chat without a terminal prompt hook", async () => {
		const activityInitial = { ...initial, page: { ...initial.page,
			binding: { ...initial.page.binding, agentId: "agent-activity", interactionSessionId: "interaction-activity", createdAtMs: 300 },
			rows: [{ cursor: { epoch: "timeline-1", sequence: 1 }, item: {
				itemId: "prompt", turnId: "turn", clientMessageId: null,
				providerMessageId: null, createdAtMs: 100,
				body: { type: "message" as const, role: "user" as const, markdown: "Review" },
			} }],
			finalCursor: { epoch: "timeline-1", sequence: 1 },
		} };
		mocks.inspect.mockResolvedValue({ backend, routeAuthority, binding: activityInitial.page.binding });
		mocks.read.mockResolvedValue({ backend, routeAuthority, read: activityInitial });
		mocks.subscribe.mockResolvedValue({ subscriptionId: "activity-subscription", backend, routeAuthority, initial: activityInitial, close: mocks.close });
		const profile = {
			schemaVersion: 1 as const, kind: "structured_protocol" as const,
			backendProfileId: "strict-profile", interactionSessionId: "interaction-activity",
		};
		useStore.setState({
			spaces: [{ id: "chat-space", name: "Chat" }], activeSpaceId: "chat-space",
			agents: [{ id: "agent-activity", name: "Chat", provider: "codex",
				projectId: "repo", worktreePath: "/repo", branch: "main",
				sessionId: "chat-session", sessionKind: "pty", interactionProfile: profile }],
			layouts: { "chat-space": { panels: { "agent:agent-activity": { contentComponent: "agent", params: { agentRef: { agentId: "agent-activity" } } } } } },
			sessionActivity: {},
		});
		const hook = renderHook(() => {
			const chat = useAgentChatSession("agent-activity", profile);
			return { chat, rows: useSpaces() };
		});
		await waitFor(() => expect(hook.result.current.chat.phase).toBe("ready"));
		expect(hook.result.current.rows[0]?.activityAt).toBe(100);
	});

	it("owns one StrictMode-safe runtime listener for each mounted view lease", async () => {
		const invalidated = vi.fn();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<StrictMode>{children}</StrictMode>
		);
		const session = renderHook(
			() =>
				useAgentChatSession(
					"agent-strict",
					{
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "strict-profile",
						interactionSessionId: "interaction-strict",
					},
					invalidated,
				),
			{ wrapper },
		);
		await waitFor(() => expect(session.result.current.phase).toBe("ready"));
		expect(invalidated).toHaveBeenCalledOnce();
		invalidated.mockClear();
		const siblingInvalidated = vi.fn();
		const sibling = renderHook(() =>
			useAgentChatSession(
				"agent-strict",
				{
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: "strict-profile",
					interactionSessionId: "interaction-strict",
				},
				siblingInvalidated,
			),
		);
		await waitFor(() => expect(siblingInvalidated).toHaveBeenCalledOnce());

		mocks.invalidation?.({
			kind: "changed",
			interactionSessionId: "interaction-strict",
			timelineCursor: { epoch: "timeline-1", sequence: 1 },
			kinds: ["runtime"],
		});
		expect(invalidated).toHaveBeenCalledOnce();
		expect(siblingInvalidated).toHaveBeenCalledTimes(2);

		session.unmount();
		sibling.unmount();
		mocks.invalidation?.({
			kind: "changed",
			interactionSessionId: "interaction-strict",
			timelineCursor: { epoch: "timeline-1", sequence: 2 },
			kinds: ["runtime"],
		});
		expect(invalidated).toHaveBeenCalledOnce();
	});
});
