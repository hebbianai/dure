import { describe, expect, it } from "vitest";
import { projectAgentChatTranscript } from "@/lib/agents/chat/agentChatProjection";
import {
	type NativeAgentChatPendingPrompt,
	nativeAgentChatComposerReason,
	nativeAgentChatComposerState,
	nativeAgentChatPage,
	nativeAgentChatPendingSettled,
	nativeAgentChatRefreshCursor,
	nativeAgentPromptBackendProfileId,
	nativeTranscriptUserEntries,
	presentNativeAgentInputError,
} from "@/lib/agents/chat/nativeAgentChat";
import { t } from "@/lib/i18n";
import type { Agent } from "@/types";
import type { ProviderConversationTranscriptV1 } from "../../../../cli/lib/agent-transcript.mjs";

const source = {
	kind: "local",
	agentId: "agent-one",
	provider: "claude",
	conversationId: "conversation-one",
} as const;

function transcript(
	entries: ProviderConversationTranscriptV1["entries"],
	overrides: Partial<ProviderConversationTranscriptV1> = {},
): ProviderConversationTranscriptV1 {
	return {
		schemaVersion: 1,
		provider: "claude",
		conversationId: "conversation-one",
		historyComplete: true,
		finalResponse: null,
		entries,
		...overrides,
	};
}

const conversation = transcript([
	{ role: "user", text: "First question" },
	{ role: "agent", text: "Looking." },
	{ role: "agent", text: "First answer" },
	{ role: "user", text: "Second question" },
	{ role: "agent", text: "Second answer" },
]);

function blocks(page: ReturnType<typeof nativeAgentChatPage>) {
	return projectAgentChatTranscript(page.rows).map((block) =>
		block.kind === "turn"
			? {
					state: block.state,
					messages: block.rows.flatMap(({ timeline }) =>
						timeline.item.body.type === "message"
							? [`${timeline.item.body.role}:${timeline.item.body.markdown}`]
							: [],
					),
					assistantMarkdown: block.assistantMarkdown,
					workedMs: block.workedMs,
				}
			: { row: block.row.timeline.item.body.type },
	);
}

const pending = (
	overrides: Partial<NativeAgentChatPendingPrompt> = {},
): NativeAgentChatPendingPrompt => ({
	text: "Third question",
	sentAtMs: 1_000,
	userEntriesAtSend: 2,
	turnCompletedCountAtSend: "2",
	...overrides,
});

describe("native conversation timeline", () => {
	it("groups provider messages into completed turns for the shared chat rows", () => {
		const page = nativeAgentChatPage({
			source,
			transcript: conversation,
			terminalEpoch: "epoch-one",
			working: false,
		});
		expect(blocks(page)).toEqual([
			{
				state: "completed",
				messages: [
					"user:First question",
					"assistant:Looking.",
					"assistant:First answer",
				],
				assistantMarkdown: "Looking.\n\nFirst answer",
				workedMs: 0,
			},
			{
				state: "completed",
				messages: ["user:Second question", "assistant:Second answer"],
				assistantMarkdown: "Second answer",
				workedMs: 0,
			},
		]);
		expect(page.binding).toMatchObject({
			agentId: "agent-one",
			providerId: "claude",
			providerConversationRef: "conversation-one",
			historyComplete: true,
		});
		expect(page.finalCursor.sequence).toBe(page.rows.length);
		expect(page.hasMore).toBe(false);
	});

	it("keeps the newest turn open while the agent works", () => {
		const page = nativeAgentChatPage({
			source,
			transcript: conversation,
			terminalEpoch: "epoch-one",
			working: true,
		});
		expect(
			blocks(page).map((block) => "state" in block && block.state),
		).toEqual(["completed", "active"]);
	});

	it("appends a Host-confirmed prompt as its own pending turn", () => {
		const page = nativeAgentChatPage({
			source,
			transcript: conversation,
			terminalEpoch: "epoch-one",
			working: false,
			pending: pending(),
		});
		const projected = blocks(page);
		expect(projected[projected.length - 1]).toEqual({
			state: "active",
			messages: ["user:Third question"],
			assistantMarkdown: "",
			workedMs: null,
		});
		expect(projected[projected.length - 2]).toMatchObject({
			state: "completed",
			workedMs: 0,
		});
	});

	it("marks a bounded provider history and leaves leading agent text outside a turn", () => {
		const page = nativeAgentChatPage({
			source,
			transcript: transcript(
				[
					{ role: "agent", text: "Earlier answer" },
					{ role: "agent", text: "   " },
					{ role: "user", text: "Next" },
				],
				{ historyComplete: false },
			),
			terminalEpoch: "epoch-one",
			working: false,
		});
		expect(blocks(page)).toEqual([
			{ row: "history_boundary" },
			{ row: "message" },
			{
				state: "completed",
				messages: ["user:Next"],
				assistantMarkdown: "",
				workedMs: 0,
			},
		]);
	});

	it("refuses a transcript for another conversation or provider", () => {
		for (const mismatched of [
			transcript([], { conversationId: "conversation-two" }),
			transcript([], { provider: "codex" }),
		]) {
			expect(() =>
				nativeAgentChatPage({
					source,
					transcript: mismatched,
					terminalEpoch: "epoch-one",
					working: false,
				}),
			).toThrow();
		}
	});
});

describe("native conversation refresh and pending prompt", () => {
	it("re-reads on Host completion and on work start/stop only", () => {
		const base = {
			conversationId: "conversation-one",
			terminalEpoch: "epoch-one",
			turnCompletedCount: "1",
			working: false,
		};
		const cursor = nativeAgentChatRefreshCursor(base);
		expect(nativeAgentChatRefreshCursor({ ...base })).toBe(cursor);
		for (const changed of [
			{ turnCompletedCount: "2" },
			{ working: true },
			{ terminalEpoch: "epoch-two" },
			{ conversationId: "conversation-two" },
		]) {
			expect(nativeAgentChatRefreshCursor({ ...base, ...changed })).not.toBe(
				cursor,
			);
		}
	});

	it("stays pending until the transcript holds the prompt or a later turn completed", () => {
		expect(nativeTranscriptUserEntries(conversation)).toBe(2);
		expect(nativeAgentChatPendingSettled(pending(), undefined)).toBe(false);
		expect(
			nativeAgentChatPendingSettled(pending(), {
				transcript: conversation,
				turnCompletedCount: "2",
			}),
		).toBe(false);
		expect(
			nativeAgentChatPendingSettled(pending(), {
				transcript: transcript([
					...conversation.entries,
					{ role: "user", text: "Third question" },
				]),
				turnCompletedCount: "2",
			}),
		).toBe(true);
		expect(
			nativeAgentChatPendingSettled(pending(), {
				transcript: conversation,
				turnCompletedCount: "10",
			}),
		).toBe(true);
		expect(
			nativeAgentChatPendingSettled(
				pending({
					userEntriesAtSend: null,
					turnCompletedCountAtSend: undefined,
				}),
				{ transcript: conversation, turnCompletedCount: "0" },
			),
		).toBe(false);
	});
});

describe("native conversation composer", () => {
	const idle = { lifecycle: "running", attention: "none" } as const;
	it("is ready only at an idle prompt with no attention", () => {
		expect(
			nativeAgentChatComposerState({
				runtime: idle,
				state: "waiting",
				sending: false,
				pending: false,
			}),
		).toEqual({ kind: "ready" });
	});

	it.each([
		[{ runtime: undefined, state: "waiting" }, "unavailable"],
		[
			{ runtime: { ...idle, lifecycle: "exited" }, state: "waiting" },
			"unavailable",
		],
		[{ state: "waiting", sending: true }, "sending"],
		[
			{
				runtime: { ...idle, attention: "approval_required" },
				state: "blocked",
			},
			"attention",
		],
		[{ state: "input" }, "attention"],
		[{ state: "error" }, "attention"],
		[{ state: "working" }, "working"],
		[{ state: "working", pending: true }, "working"],
		[{ state: "waiting", pending: true }, "pending"],
		[{ state: "unknown" }, "unavailable"],
		[{ state: "connecting" }, "unavailable"],
	] as const)("explains a closed composer (%o → %s)", (input, reason) => {
		const state = nativeAgentChatComposerState({
			runtime: "runtime" in input ? input.runtime : idle,
			state: input.state,
			sending: "sending" in input ? input.sending : false,
			pending: "pending" in input ? input.pending : false,
		});
		expect(state).toEqual({ kind: "disabled", reason });
		expect(nativeAgentChatComposerReason(state)).toBe(
			t(`agents.nativeChat.reason.${reason}`),
		);
	});

	it("humanizes known refusals and keeps unknown tokens verbatim", () => {
		expect(presentNativeAgentInputError("hmux_agent_prompt_refused")).toEqual({
			message: t("agents.nativeChat.error.refused"),
			detail: "hmux_agent_prompt_refused",
		});
		expect(presentNativeAgentInputError("hmux_input_draft_pending")).toEqual({
			message: t("agents.nativeChat.error.terminalDraft"),
			detail: "hmux_input_draft_pending",
		});
		expect(presentNativeAgentInputError("hmux_capability_missing")).toEqual({
			message: "hmux_capability_missing",
		});
	});

	it("routes to the recorded local control plane", () => {
		const binding = {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "session-one",
			workspaceId: "workspace-one",
		} as const;
		expect(
			nativeAgentPromptBackendProfileId({ runtimeBinding: binding } as Agent),
		).toBe("local");
		expect(
			nativeAgentPromptBackendProfileId({
				runtimeBinding: { ...binding, backendProfileId: "qa-profile" },
			} as Agent),
		).toBe("qa-profile");
	});
});
