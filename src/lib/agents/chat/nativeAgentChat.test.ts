import { describe, expect, it } from "vitest";
import {
	projectAgentChatTranscript,
	segmentAgentChatRows,
} from "@/lib/agents/chat/agentChatProjection";
import {
	NATIVE_AGENT_PENDING_IDLE_GRACE_MS,
	type NativeAgentChatPendingPrompt,
	nativeAgentChatComposerReason,
	nativeAgentChatComposerState,
	nativeAgentChatDraftIdentity,
	nativeAgentChatIdle,
	nativeAgentChatPage,
	nativeAgentChatPendingEchoed,
	nativeAgentChatPendingIdleDeadline,
	nativeAgentChatPendingSettled,
	nativeAgentChatRefreshCursor,
	nativeAgentInputFailure,
	nativeAgentPromptBackendProfileId,
	nativeTranscriptToolCalls,
	nativeTranscriptUserEntries,
	presentNativeAgentInputError,
} from "@/lib/agents/chat/nativeAgentChat";
import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
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

	it("keeps a released prompt as a sent message, open again while the agent works", () => {
		const released = pending({ released: true });
		const idle = blocks(
			nativeAgentChatPage({
				source,
				transcript: conversation,
				terminalEpoch: "epoch-one",
				working: false,
				pending: released,
			}),
		);
		expect(idle[idle.length - 1]).toMatchObject({
			state: "completed",
			messages: ["user:Third question"],
		});
		const working = blocks(
			nativeAgentChatPage({
				source,
				transcript: conversation,
				terminalEpoch: "epoch-one",
				working: true,
				pending: released,
			}),
		);
		expect(working[working.length - 1]).toMatchObject({
			state: "active",
			messages: ["user:Third question"],
		});
	});

	it("shows a prompt sent before any transcript loaded once when the transcript ends with it", () => {
		const repeated = transcript([
			{ role: "user", text: "continue" },
			{ role: "agent", text: "Done." },
		]);
		const unread = pending({ text: "continue\n", userEntriesAtSend: null });
		expect(nativeAgentChatPendingEchoed(unread, repeated)).toBe(true);
		expect(nativeAgentChatPendingEchoed(unread, conversation)).toBe(false);
		// A known send-time count never hides the row: the count settles it.
		expect(
			nativeAgentChatPendingEchoed(
				pending({ text: "continue", userEntriesAtSend: 1 }),
				repeated,
			),
		).toBe(false);
		const page = nativeAgentChatPage({
			source,
			transcript: repeated,
			terminalEpoch: "epoch-one",
			working: false,
			pending: unread,
		});
		expect(
			page.rows.filter(
				(row) =>
					row.item.body.type === "message" &&
					row.item.body.markdown.trim() === "continue",
			),
		).toHaveLength(1);
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

const call = (
	afterEntries: number,
	callId: string,
	name: string,
	state: string,
	input: unknown = null,
) => ({ afterEntries, callId, name, state, input });

/** A message, or one collapsed burst of calls as `name:state` each. */
type Turn = (string | string[])[];

/** Each turn as its segments: a message, or one collapsed burst of calls. */
function turnSegments(page: ReturnType<typeof nativeAgentChatPage>) {
	return projectAgentChatTranscript(page.rows).map((block) =>
		block.kind === "turn"
			? segmentAgentChatRows(block.rows).flatMap((segment): Turn => {
					if (segment.kind === "tools") {
						return [
							segment.rows.map(({ timeline }) =>
								timeline.item.body.type === "tool"
									? `${timeline.item.body.name}:${timeline.item.body.state}`
									: "?",
							),
						];
					}
					const body = segment.row.timeline.item.body;
					return body.type === "message"
						? [`${body.role}:${body.markdown}`]
						: [];
				})
			: block.row.timeline.item.body.type,
	);
}

describe("native conversation tool activity", () => {
	it("places tool calls between the messages they were made between, one burst per run", () => {
		const page = nativeAgentChatPage({
			source,
			transcript: {
				...conversation,
				tools: [
					call(2, "toolu_1", "Read", "completed", { file_path: "/repo/a.ts" }),
					call(2, "toolu_2", "Bash", "failed", { command: "pnpm test" }),
					call(4, "toolu_3", "Edit", "completed"),
				],
			},
			terminalEpoch: "epoch-one",
			working: false,
		});
		expect(turnSegments(page)).toEqual([
			[
				"user:First question",
				"assistant:Looking.",
				["Read:completed", "Bash:failed"],
				"assistant:First answer",
			],
			["user:Second question", ["Edit:completed"], "assistant:Second answer"],
		]);
		const read = page.rows.find(
			(row) => row.item.itemId === "native-tool:toolu_1",
		);
		expect(read?.item.body).toEqual({
			type: "tool",
			toolCallId: "toolu_1",
			name: "Read",
			state: "completed",
			input: { file_path: "/repo/a.ts" },
			output: null,
		});
		// The answer text the turn reads as is the messages' alone.
		expect(blocks(page)[0]).toMatchObject({
			assistantMarkdown: "Looking.\n\nFirst answer",
		});
	});

	it("reads a call without a result as running in the newest turn only", () => {
		const page = nativeAgentChatPage({
			source,
			transcript: {
				...conversation,
				tools: [
					call(2, "toolu_cut", "Bash", "running"),
					call(5, "toolu_waiting", "Bash", "running"),
				],
			},
			terminalEpoch: "epoch-one",
			working: false,
		});
		expect(turnSegments(page)).toEqual([
			[
				"user:First question",
				"assistant:Looking.",
				["Bash:canceled"],
				"assistant:First answer",
			],
			["user:Second question", "assistant:Second answer", ["Bash:running"]],
		]);
	});

	it("leaves out a malformed, repeated or out-of-range call on its own", () => {
		const long = "x".repeat(257);
		expect(
			nativeTranscriptToolCalls(
				[
					call(2, "late", "Bash", "completed"),
					call(0, "early", "Read", "completed", { path: "a" }),
					call(-1, "negative", "Bash", "completed"),
					call(6, "past-the-end", "Bash", "completed"),
					call(1.5, "fraction", "Bash", "completed"),
					call(1, "", "Bash", "completed"),
					call(1, "long-name", long, "completed"),
					call(1, "unknown-state", "Bash", "paused"),
					call(3, "late", "Read", "failed"),
					null,
					"call",
					{
						afterEntries: 1,
						callId: "no-input",
						name: "Glob",
						state: "running",
					},
				],
				5,
			),
		).toEqual([
			call(0, "early", "Read", "completed", { path: "a" }),
			call(1, "no-input", "Glob", "running"),
			call(2, "late", "Bash", "completed"),
		]);
		expect(nativeTranscriptToolCalls(undefined, 5)).toEqual([]);
		expect(nativeTranscriptToolCalls({ length: 1 }, 5)).toEqual([]);
	});

	it("reads a transcript without tool calls exactly as before", () => {
		const withoutTools = nativeAgentChatPage({
			source,
			transcript: conversation,
			terminalEpoch: "epoch-one",
			working: false,
		});
		const emptyTools = nativeAgentChatPage({
			source,
			transcript: { ...conversation, tools: [] },
			terminalEpoch: "epoch-one",
			working: false,
		});
		expect(emptyTools).toEqual(withoutTools);
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

	it("never settles a prompt sent before any transcript loaded on matching text alone", () => {
		// "continue" after an earlier "continue": the older entry must not
		// settle the new prompt while the Host is still taking it up.
		const unread = pending({
			text: "continue",
			userEntriesAtSend: null,
			turnCompletedCountAtSend: "2",
		});
		const repeated = transcript([
			...conversation.entries,
			{ role: "user", text: "continue" },
			{ role: "agent", text: "Done." },
		]);
		expect(
			nativeAgentChatPendingSettled(unread, {
				transcript: repeated,
				turnCompletedCount: "2",
			}),
		).toBe(false);
		expect(
			nativeAgentChatPendingSettled(unread, {
				transcript: repeated,
				turnCompletedCount: "3",
			}),
		).toBe(true);
	});

	it("releases a prompt nothing records once the runtime stayed idle through the grace period", () => {
		expect(NATIVE_AGENT_PENDING_IDLE_GRACE_MS).toBeGreaterThanOrEqual(10_000);
		const sent = pending({ sentAtMs: 10_000 });
		// Not idle: no deadline, the prompt stays pending.
		expect(nativeAgentChatPendingIdleDeadline(sent, undefined)).toBeUndefined();
		// Idle since before the send (a TUI-only input never starts work).
		expect(nativeAgentChatPendingIdleDeadline(sent, 4_000)).toBe(
			10_000 + NATIVE_AGENT_PENDING_IDLE_GRACE_MS,
		);
		// Idle again after the work the prompt started.
		expect(nativeAgentChatPendingIdleDeadline(sent, 25_000)).toBe(
			25_000 + NATIVE_AGENT_PENDING_IDLE_GRACE_MS,
		);
		// Released once; no second deadline.
		expect(
			nativeAgentChatPendingIdleDeadline({ ...sent, released: true }, 4_000),
		).toBeUndefined();
	});
});

describe("native conversation composer", () => {
	const idle = { lifecycle: "running", attention: "none" } as const;
	it("is ready only at an idle prompt with no attention", () => {
		expect(nativeAgentChatIdle({ runtime: idle, state: "waiting" })).toBe(true);
		for (const [runtime, state] of [
			[undefined, "waiting"],
			[{ ...idle, lifecycle: "exited" }, "waiting"],
			[{ ...idle, attention: "approval_required" }, "waiting"],
			[idle, "working"],
			[idle, "blocked"],
		] as const) {
			expect(nativeAgentChatIdle({ runtime, state })).toBe(false);
		}
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

	it("humanizes known refusals, shows a carried message, and keeps bare unknown tokens verbatim", () => {
		expect(
			presentNativeAgentInputError({ code: "hmux_agent_prompt_refused" }),
		).toEqual({
			message: t("agents.nativeChat.error.refused"),
			detail: "hmux_agent_prompt_refused",
		});
		expect(
			presentNativeAgentInputError({
				code: "hmux_input_draft_pending",
				message: "Host text",
			}),
		).toEqual({
			message: t("agents.nativeChat.error.terminalDraft"),
			detail: "hmux_input_draft_pending",
		});
		expect(
			presentNativeAgentInputError({
				code: "agent_runtime_native_request_invalid",
			}),
		).toEqual({
			message: t("agents.nativeChat.error.requestInvalid"),
			detail: "agent_runtime_native_request_invalid",
		});
		for (const code of [
			"agent_runtime_native_input_failed",
			"hmux_capability_missing",
			"backend_transport_unavailable",
		]) {
			expect(
				presentNativeAgentInputError({ code, message: "Carried sentence." }),
			).toEqual({ message: "Carried sentence.", detail: code });
		}
		expect(
			presentNativeAgentInputError({ code: "hmux_capability_missing" }),
		).toEqual({ message: "hmux_capability_missing" });
		expect(
			presentNativeAgentInputError({
				code: "hmux_capability_missing",
				message: "hmux_capability_missing",
			}),
		).toEqual({ message: "hmux_capability_missing" });
	});

	it("keeps a failure's token and its carried message", () => {
		expect(
			nativeAgentInputFailure(
				new DureBackendRequestError("hmux_capability_missing", "Translated.", {
					kind: "transport",
				}),
			),
		).toEqual({ code: "hmux_capability_missing", message: "Translated." });
		expect(
			nativeAgentInputFailure({ code: "hmux_agent_prompt_refused" }),
		).toEqual({ code: "hmux_agent_prompt_refused" });
		expect(nativeAgentInputFailure(new Error(""))).toEqual({
			code: "agent_runtime_native_input_failed",
		});
		expect(nativeAgentInputFailure("boom")).toEqual({
			code: "agent_runtime_native_input_failed",
		});
	});

	it("keys the draft to the pane's Agent and control plane, not one conversation", () => {
		const agent = {
			id: "agent-one",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "local",
				hostId: "local",
				sessionId: "session-one",
				workspaceId: "workspace-one",
				backendProfileId: "qa-profile",
			},
		} as Agent;
		expect(nativeAgentChatDraftIdentity(agent)).toEqual({
			agentId: "agent-one",
			backendProfileId: "qa-profile",
			interactionSessionId: "native:agent-one",
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
