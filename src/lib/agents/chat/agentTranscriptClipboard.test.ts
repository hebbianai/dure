import { describe, expect, it, vi } from "vitest";
import {
	copyAgentTranscriptToClipboard,
	copyProviderTranscriptToClipboard,
	createPaneTranscriptCopyAction,
} from "@/lib/agents/chat/agentTranscriptClipboard";
import type { Agent } from "@/types";

const binding = {
	schemaVersion: 1 as const,
	interactionSessionId: "interaction-1",
	agentId: "agent-1",
	providerId: "codex",
	executionProfile: { kind: "provider_default" as const },
	providerConversationRef: "thread-1",
	runtime: { runtimeGeneration: "runtime-1", providerEpoch: "provider-1" },
	timelineEpoch: "timeline-1",
	bindingRevision: 1,
	historyComplete: true,
	createdAtMs: 1,
	updatedAtMs: 1,
};

describe("agent transcript clipboard adapter", () => {
	it("exposes the pane action only for an exact local native authority", () => {
		const agent = {
			id: "agent-native",
			provider: "codex",
			sessionKind: "pty",
			conversationId: "stale-conversation",
			runtimeBinding: { source: "local" },
		} as unknown as Agent;

		expect(
			createPaneTranscriptCopyAction(agent, {
				source: "local",
				conversationIdentity: {
					providerId: "codex",
					conversationId: "conversation-exact",
				},
			}),
		).toEqual(expect.any(Function));
		expect(createPaneTranscriptCopyAction(agent)).toBeUndefined();
	});

	it("copies the shared Markdown projection from the committed backend profile", async () => {
		const read = vi.fn().mockResolvedValue({
			read: {
				type: "page",
				page: {
					binding,
					rows: [
						{
							cursor: { epoch: "timeline-1", sequence: 1 },
							item: {
								itemId: "item-1",
								turnId: null,
								clientMessageId: null,
								providerMessageId: null,
								body: { type: "message", role: "assistant", markdown: "done" },
								createdAtMs: 1,
							},
						},
					],
					liveText: [],
					pendingRequests: [],
					activeTurn: null,
					latestFailure: null,
					goal: null,
					finalCursor: { epoch: "timeline-1", sequence: 1 },
					hasMore: false,
				},
			},
		});
		const createClient = vi.fn(() => ({ read }));
		const copyText = vi.fn().mockResolvedValue(true);

		await expect(
			copyAgentTranscriptToClipboard(
				{
					agentId: "agent-1",
					providerId: "codex",
					profile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "remote-a",
						interactionSessionId: "interaction-1",
					},
				},
				20,
				{ createClient, copyText },
			),
		).resolves.toBe(true);

		expect(createClient).toHaveBeenCalledWith({ profileId: "remote-a" });
		expect(copyText).toHaveBeenCalledWith(
			expect.stringContaining("## Assistant\n\ndone"),
		);
	});

	it("copies a native pane's exact provider conversation through the same projection", async () => {
		const readProviderTranscript = vi.fn().mockResolvedValue({
			schemaVersion: 1,
			provider: "codex",
			conversationId: "conversation-1",
			historyComplete: true,
			entries: [
				{ role: "user", text: "first" },
				{ role: "agent", text: "second" },
				{ role: "user", text: "third" },
			],
		});
		const copyText = vi.fn().mockResolvedValue(true);

		await expect(
			copyProviderTranscriptToClipboard(
				{
					kind: "local",
					agentId: "agent-1",
					provider: "codex",
					conversationId: "conversation-1",
				},
				2,
				{ readProviderTranscript, copyText },
			),
		).resolves.toBe(true);

		expect(readProviderTranscript).toHaveBeenCalledWith(
			"codex",
			"conversation-1",
		);
		expect(copyText).toHaveBeenCalledWith(expect.not.stringContaining("first"));
		expect(copyText).toHaveBeenCalledWith(
			expect.stringContaining("## Assistant\n\nsecond"),
		);
	});
});
