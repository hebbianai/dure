import { expect, it, vi } from "vitest";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type {
	AgentInteractionBindingV1,
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "./agentConversationContract";
import { resumeUsageLimitTurn } from "./resumeUsageLimitTurn";
import { latestTurnFailure } from "./turnFailureReason";

function fixture() {
	const route = testDureBackendRouteAuthority(
		"backend-team",
		"generation-team",
	);
	const binding: AgentInteractionBindingV1 = {
		schemaVersion: 1,
		interactionSessionId: "conversation-successor",
		agentId: "agent-one",
		providerId: "codex",
		executionProfile: {
			kind: "credential_reference",
			reference_id: "account-next",
			credential_generation: "credential-v2-next",
		},
		providerConversationRef: "provider-conversation",
		runtime: { runtimeGeneration: "runtime-next", providerEpoch: "epoch-next" },
		timelineEpoch: "timeline-next",
		bindingRevision: 2,
		historyComplete: true,
		createdAtMs: 1,
		updatedAtMs: 2,
	};
	const rows: AgentTimelineRowV1[] = [
		{
			cursor: { epoch: "timeline-next", sequence: 1 },
			item: {
				itemId: "replayed-user",
				turnId: "turn-failed",
				clientMessageId: "request-old",
				providerMessageId: null,
				createdAtMs: 10,
				body: { type: "message", role: "user", markdown: "Finish the report" },
			},
		},
		{
			cursor: { epoch: "timeline-next", sequence: 2 },
			item: {
				itemId: "replayed-failure",
				turnId: "turn-failed",
				clientMessageId: "request-old",
				providerMessageId: null,
				createdAtMs: 20,
				body: {
					type: "lifecycle",
					state: "turn_failed",
					detail: "usage_limit",
				},
			},
		},
	];
	const failure = { ...latestTurnFailure(rows)!, itemId: "original-failure" };
	const page: AgentTimelinePageV1 = {
		binding,
		rows,
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		goal: null,
		queuedInputs: {
			interactionSessionId: binding.interactionSessionId,
			inputs: [],
			nextAfter: null,
		},
		finalCursor: { epoch: "timeline-next", sequence: 2 },
		hasMore: false,
	};
	const sent: Record<string, unknown>[] = [];
	const invoke = vi.fn(
		async (_command: string, args: Record<string, unknown>) => {
			expect(args.route).toEqual({ kind: "exact", authority: route });
			const body = args.body as Record<string, unknown>;
			let result: Record<string, unknown>;
			if (args.operation === "agent_conversation.read")
				result = { read: { type: "page", page } };
			else if (args.operation === "agent_conversation.start_turn") {
				sent.push(body);
				result = { receipt: { intent: body, state: "accepted" } };
			} else throw new Error(String(args.operation));
			return {
				schemaVersion: 1,
				backendId: route.backend.id,
				backendGeneration: route.backend.generation,
				routeAuthority: route,
				result: { schemaVersion: 1, ...result },
			};
		},
	);
	const client = createDureAgentConversationClient({
		profileId: route.profileId,
		routeAuthority: route,
		invokeCommand: invoke,
	});
	const result: AgentCredentialTransitionResult = {
		kind: "completed",
		conversationId: "provider-conversation",
		runtime: {
			interactionProfile: "structured_protocol",
			agentId: binding.agentId,
			providerId: "codex",
			executionProfile: binding.executionProfile,
			providerConversationRef: binding.providerConversationRef,
			interactionSessionId: binding.interactionSessionId,
			binding: structuredClone(binding),
			selectionRevision: 2,
			backend: { id: route.backend.id, generation: route.backend.generation },
			backendProfileId: route.profileId,
			routeAuthority: route,
			launchSelection: { model: null, effort: null, permissionMode: "default" },
		},
	};
	return { binding, page, failure, result, client, invoke, sent };
}

it("submits the captured failed request to the exact successor and uses a stable id across duplicate observers", async () => {
	const f = fixture();
	expect(await resumeUsageLimitTurn(f.failure, f.result, f.client)).toBe(
		"accepted",
	);
	expect(await resumeUsageLimitTurn(f.failure, f.result, f.client)).toBe(
		"accepted",
	);
	expect(f.sent).toHaveLength(2);
	expect(f.sent[0]).toEqual(f.sent[1]);
	expect(f.sent[0]).toMatchObject({
		interactionSessionId: "conversation-successor",
		runtime: f.binding.runtime,
		input: "Finish the report",
	});
});
it.each([
	"completed",
	"new-input",
	"replaced-runtime",
	"different-conversation",
])("does not revive the old failure after %s", async (change) => {
	const f = fixture();
	if (change === "completed")
		f.page.rows[f.page.rows.length - 1].item.body = {
			type: "lifecycle",
			state: "turn_completed",
			detail: null,
		};
	if (change === "new-input")
		f.page.rows[f.page.rows.length - 1].item.body = {
			type: "message",
			role: "user",
			markdown: "A teammate continued",
		};
	if (change === "replaced-runtime")
		f.binding.runtime.runtimeGeneration = "runtime-unrelated";
	if (change === "different-conversation")
		f.binding.providerConversationRef = "another-conversation";
	expect(await resumeUsageLimitTurn(f.failure, f.result, f.client)).toBe(
		"not_sent",
	);
	expect(f.sent).toEqual([]);
});
it("retains an uncertain send without issuing another request", async () => {
	const f = fixture();
	const start = vi
		.spyOn(f.client, "startTurn")
		.mockRejectedValue(new Error("receipt lost"));
	await expect(
		resumeUsageLimitTurn(f.failure, f.result, f.client),
	).resolves.toBe("uncertain");
	expect(start).toHaveBeenCalledTimes(1);
});

it.each(["prepared", "failed", "uncertain"] as const)(
	"does not report %s delivery as resumed",
	async (state) => {
		const f = fixture();
		vi.spyOn(f.client, "startTurn").mockResolvedValue(state);
		expect(await resumeUsageLimitTurn(f.failure, f.result, f.client)).toBe(
			state === "failed" ? "not_sent" : "uncertain",
		);
	},
);
