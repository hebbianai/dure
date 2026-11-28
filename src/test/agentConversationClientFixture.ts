import { vi } from "vitest";
import {
	type AgentChatSubmission,
	type AgentChatSubmissionStore,
	agentChatSubmissionKey,
} from "@/lib/agents/chat/agentChatSubmission";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import type { DureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

/** A conversation client over the page `current()` returns, so a test can
 * change it between reads. Inspect, read and subscribe answer with that page,
 * recover answers with the binding it was asked about, and every effect is a
 * `vi.fn()`. `overrides` replaces any of them. */
export function conversationClientFixture(
	current: () => AgentTimelinePageV1,
	overrides: Partial<DureAgentConversationClient> = {},
	routeAuthority: DureBackendRouteAuthorityV1 = testDureBackendRouteAuthority(
		"backend",
		"one",
	),
): DureAgentConversationClient {
	const backend = routeAuthority.backend;
	return {
		inspectInput: vi.fn(async () => null),
		readQueue: vi.fn(),
		readProviderHistory: vi.fn(),
		enqueueTurn: vi.fn(),
		cancelQueuedTurn: vi.fn(),
		inspect: async () => ({
			backend,
			routeAuthority,
			binding: current().binding,
		}),
		recover: vi.fn(async (binding) => binding),
		read: async () => ({
			backend,
			routeAuthority,
			read: { type: "page", page: current() },
		}),
		subscribe: async () => ({
			backend,
			routeAuthority,
			initial: { type: "page", page: current() },
			subscriptionId: "test",
			close: async () => {},
		}),
		continueTurn: async () => {
			throw new Error("Unexpected automatic continuation in this fixture");
		},
		startTurn: vi.fn(),
		steerTurn: vi.fn(),
		answerPending: vi.fn(),
		interruptTurn: vi.fn(),
		putGoal: vi.fn(),
		...overrides,
	};
}

/** An in-memory submission store, keyed as the real one keys submissions. */
export function memorySubmissionStore(
	initial: readonly AgentChatSubmission[] = [],
): {
	store: AgentChatSubmissionStore;
	stored: Map<string, AgentChatSubmission>;
} {
	const stored = new Map(
		initial.map((input) => [agentChatSubmissionKey(input), input] as const),
	);
	return {
		stored,
		store: {
			subscribe: () => () => {},
			list: async () => [...stored.values()],
			put: async (input) => {
				stored.set(agentChatSubmissionKey(input), input);
			},
			remove: async (input) => {
				stored.delete(agentChatSubmissionKey(input));
			},
		},
	};
}
