import { describe, expect, it } from "vitest";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	observedConversationActivity,
	observedConversationTitle,
	observedProviderCatalog,
	observedSessionInit,
} from "@/lib/agents/chat/observedRuntimeFacts";

describe("observedConversationActivity", () => {
	it("does not count attach time or provider metadata as work", () => {
		const snapshot = page([
			evidence("init", 100, "provider_session_initialized", {}),
			evidence("title", 200, "conversation_title", { title: "Renamed" }),
			{ cursor: { epoch: "timeline-1", sequence: 3 }, item: {
				itemId: "ready", turnId: null, clientMessageId: null,
				providerMessageId: null, createdAtMs: 250,
				body: { type: "lifecycle", state: "session_ready", detail: null },
			} },
		]);
		snapshot.binding.createdAtMs = 300;
		expect(observedConversationActivity(snapshot).at).toBeUndefined();
	});

	it("uses durable and streaming provider timestamps with the latest prompt", () => {
		const snapshot = page([{
			cursor: { epoch: "timeline-1", sequence: 1 },
			item: { itemId: "prompt", turnId: "turn", clientMessageId: null,
				providerMessageId: null, createdAtMs: 100,
				body: { type: "message", role: "user", markdown: "Review this" } },
		}]);
		expect(observedConversationActivity(snapshot)).toEqual({ text: "Review this", at: 100 });
		snapshot.liveText = [{ streamId: "stream", itemId: "answer", kind: "assistant",
			text: "Reviewing", turnId: "turn", clientMessageId: null,
			providerMessageId: "response", updatedAtMs: 200 }];
		expect(observedConversationActivity(snapshot)).toEqual({ text: "Review this", at: 200 });
	});
});

function page(rows: AgentTimelinePageV1["rows"]): AgentTimelinePageV1 {
	return {
		binding: {
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			agentId: "agent-1",
			providerId: "claude",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: null,
			runtime: { runtimeGeneration: "runtime-1", providerEpoch: "query-1" },
			timelineEpoch: "timeline-1",
			bindingRevision: 1,
			historyComplete: true,
			createdAtMs: 1,
			updatedAtMs: 1,
		},
		rows,
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		recovery: null,
		latestFailure: null,
		goal: null,
		finalCursor: { epoch: "timeline-1", sequence: rows.length },
		hasMore: false,
	};
}

function evidence(
	itemId: string,
	sequence: number,
	kind: string,
	value: unknown,
): AgentTimelinePageV1["rows"][number] {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId,
			turnId: null,
			clientMessageId: null,
			providerMessageId: null,
			body: {
				type: "provider_evidence",
				namespace: "provider.claude",
				kind,
				value,
			},
			createdAtMs: sequence,
		},
	};
}

describe("observedSessionInit", () => {
	it("reads the newest session-initialized report", () => {
		expect(
			observedSessionInit(
				page([
					evidence("init-1", 1, "provider_session_initialized", {
						model: "claude-opus-4-6",
						permissionMode: "default",
					}),
					evidence("init-2", 2, "provider_session_initialized", {
						model: "claude-fable-5",
						permissionMode: "bypassPermissions",
					}),
				]),
			),
		).toEqual({ model: "claude-fable-5", permissionMode: "bypassPermissions" });
	});

	it("never guesses from other evidence or malformed payloads", () => {
		expect(
			observedSessionInit(
				page([
					evidence("other", 1, "command_lifecycle", { model: "nope" }),
					evidence("bad", 2, "provider_session_initialized", "not object"),
				]),
			),
		).toEqual({ model: null, permissionMode: null });
		expect(observedSessionInit(undefined)).toEqual({
			model: null,
			permissionMode: null,
		});
	});
});

describe("observedProviderCatalog", () => {
	it("parses the newest provider catalog and drops malformed entries", () => {
		expect(
			observedProviderCatalog(
				page([
					evidence("catalog-1", 1, "provider_catalog", {
						models: [{ value: "opus", displayName: "Opus" }],
					}),
					evidence("catalog-2", 2, "provider_catalog", {
						models: [
							{
								value: "fable",
								resolvedModel: "claude-fable-5",
								displayName: "Fable",
								supportsEffort: true,
								supportedEffortLevels: ["xhigh", 7, "max"],
							},
							{ displayName: "no value" },
						],
					}),
				]),
			),
		).toEqual([
			{
				value: "fable",
				resolvedModel: "claude-fable-5",
				displayName: "Fable",
				supportsEffort: true,
				supportedEffortLevels: ["xhigh", "max"],
			},
		]);
	});

	it("distinguishes missing evidence from an authoritative empty catalog", () => {
		expect(observedProviderCatalog(undefined)).toBeNull();
		expect(
			observedProviderCatalog(
				page([evidence("other", 1, "provider_event", { type: "system" })]),
			),
		).toBeNull();
		expect(
			observedProviderCatalog(
				page([evidence("empty", 1, "provider_catalog", { models: [] })]),
			),
		).toEqual([]);
	});

	it("reads the newest provider-reported conversation title", () => {
		expect(
			observedConversationTitle(
				page([
					evidence("title-1", 1, "conversation_title", { title: "Old title" }),
					evidence("title-2", 2, "conversation_title", { title: "Ship steering" }),
				]),
			),
		).toBe("Ship steering");
		expect(observedConversationTitle(undefined)).toBeNull();
		expect(
			observedConversationTitle(
				page([evidence("blank", 1, "conversation_title", { title: "  " })]),
			),
		).toBeNull();
	});
});
