import { vi } from "vitest";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import {
	claudeModelCatalog,
	codexModelCatalog,
} from "@/test/providerModelCatalogFixtures";

export function chatComposerSessionFixture(
	providerId: string,
): AgentChatSessionView {
	return {
		draftIdentity: {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		},
		phase: "ready",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		putGoal: vi.fn(async () => true),
		retryTurnAvailable: false,
		interrupting: false,
		loadingOlder: false,
		queuedMessages: [],
		page: {
			binding: {
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				agentId: "agent-1",
				providerId,
				executionProfile: { kind: "provider_default" },
				providerConversationRef: null,
				runtime: { runtimeGeneration: "runtime-1", providerEpoch: "query-1" },
				timelineEpoch: "timeline-1",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			rows: [
				{
					cursor: { epoch: "timeline-1", sequence: 1 },
					item: {
						itemId: "catalog",
						turnId: null,
						clientMessageId: null,
						providerMessageId: null,
						createdAtMs: 1,
						body: {
							type: "provider_evidence",
							namespace: `provider.${providerId}`,
							kind: "provider_catalog",
							value: {
								models:
									providerId === "codex"
										? codexModelCatalog
										: claudeModelCatalog,
							},
						},
					},
				},
			],
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			goal: null,
			finalCursor: { epoch: "timeline-1", sequence: 1 },
			hasMore: false,
		},
		retryConnection: vi.fn(),
		loadOlder: vi.fn(async () => {}),
		send: vi.fn(async () => {}),
		retryTurn: vi.fn(async () => {}),
		editRetryableTurn: vi.fn(() => undefined),
		answerPending: vi.fn(async () => {}),
		interrupt: vi.fn(async () => {}),
		dismissActionError: vi.fn(),
		queueMessage: vi.fn(),
		steerOrQueue: vi.fn(async () => "queued" as const),
		dequeueMessage: vi.fn(() => undefined),
	};
}
