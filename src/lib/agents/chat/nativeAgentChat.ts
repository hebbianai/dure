import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type {
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import {
	compareDecimalStrings,
	isCanonicalDecimalString,
} from "@/lib/decimalString";
import { t } from "@/lib/i18n";
import type {
	ProviderConversationActivity,
	ProviderToolCall,
	ProviderToolCallState,
} from "@/lib/ipc/conversations";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import type { Agent } from "@/types";
import {
	agentTranscriptFromProvider,
	type NativeAgentTranscriptSource,
	type ProviderConversationTranscriptV1,
} from "../../../../cli/lib/agent-transcript.mjs";

/** Observer chat for a native terminal Agent (Claude Code / Codex TUI). The
 * provider-owned transcript is the only source of rows and the Host's idle
 * prompt admission the only input path; nothing here owns the process. */

const TIMELINE_EPOCH = "provider-transcript-v1";
const PENDING_ITEM_ID = "native-pending-prompt";

/** One transcript read, fenced to the Host completion count it was read at. */
export interface NativeAgentChatSnapshot {
	readonly transcript: ProviderConversationActivity;
	readonly turnCompletedCount: string | undefined;
	/** The refresh cursor this read answered; a view that mounts again at the
	 * same cursor reuses the read instead of repeating it. */
	readonly cursor?: string;
}

/** A prompt the Host confirmed writing that the transcript has not shown yet. */
export interface NativeAgentChatPendingPrompt {
	readonly text: string;
	readonly sentAtMs: number;
	/** User entries in the newest transcript at send time; null if none loaded. */
	readonly userEntriesAtSend: number | null;
	readonly turnCompletedCountAtSend: string | undefined;
	/** The runtime stayed idle through the grace period without the
	 * transcript or the Host count showing the prompt. The composer reopens;
	 * the row stays as a sent message until a read or a newer send replaces
	 * it. */
	readonly released?: boolean;
}

/** The transcript is re-read when the Host completes a turn and when work
 * starts or stops, never on a timer. A new conversation or terminal
 * generation is a new cursor. */
export function nativeAgentChatRefreshCursor({
	conversationId,
	terminalEpoch,
	turnCompletedCount,
	working,
}: {
	conversationId: string;
	terminalEpoch: string;
	turnCompletedCount: string | undefined;
	working: boolean;
}): string {
	return JSON.stringify([
		conversationId,
		terminalEpoch,
		turnCompletedCount ?? null,
		working,
	]);
}

/** Local managed native panes route to their recorded control plane, or the
 * local one for records that predate the field. */
export function nativeAgentPromptBackendProfileId(agent: Agent): string {
	const binding = agent.runtimeBinding;
	return (
		(binding?.runtime === "hmux_managed_v1" &&
			binding.source === "local" &&
			binding.backendProfileId) ||
		"local"
	);
}

export function nativeTranscriptUserEntries(
	transcript: ProviderConversationTranscriptV1,
): number {
	return transcript.entries.filter((entry) => entry.role === "user").length;
}

/** The composer's draft lives in the shared chat draft store, keyed to the
 * pane's Agent rather than one conversation, so it survives pane moves,
 * layout restores, a new terminal generation and a provider-side new chat. */
export function nativeAgentChatDraftIdentity(agent: Agent) {
	return {
		agentId: agent.id,
		backendProfileId: nativeAgentPromptBackendProfileId(agent),
		interactionSessionId: `native:${agent.id}`,
	};
}

/** How long the runtime must stay at an idle prompt after a send before a
 * prompt nothing has recorded stops holding the composer. Generous on
 * purpose: a loaded desktop can report `working` seconds after the Host
 * wrote the prompt, and releasing too early would reopen the composer while
 * the prompt is still being taken up. */
export const NATIVE_AGENT_PENDING_IDLE_GRACE_MS = 10_000;

/** When a pending prompt that neither the transcript nor the Host count has
 * shown releases the composer: a TUI-only input (`/help`, `/status`,
 * `/cost`) is written and answered in the terminal but never opens a turn.
 * The deadline is the grace period counted from the later of the send and
 * the moment the runtime last became idle. Undefined while the runtime is
 * not idle, or once the prompt was released. */
export function nativeAgentChatPendingIdleDeadline(
	pending: Pick<NativeAgentChatPendingPrompt, "sentAtMs" | "released">,
	idleSinceMs: number | undefined,
): number | undefined {
	return idleSinceMs === undefined || pending.released
		? undefined
		: Math.max(pending.sentAtMs, idleSinceMs) +
				NATIVE_AGENT_PENDING_IDLE_GRACE_MS;
}

function trailingUserText(
	transcript: ProviderConversationTranscriptV1,
): string | undefined {
	for (let index = transcript.entries.length - 1; index >= 0; index -= 1) {
		const entry = transcript.entries[index];
		if (entry.role === "user") return entry.text.trim();
	}
	return undefined;
}

/** A prompt sent before any transcript loaded cannot be told apart from an
 * earlier identical prompt ("continue" after "continue"), so text never
 * settles it. When the transcript already ends with the same text, the row
 * is shown once and the composer stays closed until the Host count or the
 * idle grace settles it. */
export function nativeAgentChatPendingEchoed(
	pending: Pick<NativeAgentChatPendingPrompt, "text" | "userEntriesAtSend">,
	transcript: ProviderConversationTranscriptV1,
): boolean {
	return (
		pending.userEntriesAtSend === null &&
		trailingUserText(transcript) === pending.text.trim()
	);
}

/** The pending prompt is gone once the transcript holds a newer user entry
 * than at send time, or once the Host completed a turn after the send and
 * the transcript read at that count still lacks it. */
export function nativeAgentChatPendingSettled(
	pending: NativeAgentChatPendingPrompt,
	snapshot: NativeAgentChatSnapshot | undefined,
): boolean {
	if (!snapshot) return false;
	if (
		pending.userEntriesAtSend !== null &&
		nativeTranscriptUserEntries(snapshot.transcript) > pending.userEntriesAtSend
	) {
		return true;
	}
	const before = pending.turnCompletedCountAtSend ?? "0";
	const after = snapshot.turnCompletedCount;
	return (
		isCanonicalDecimalString(after) &&
		isCanonicalDecimalString(before) &&
		compareDecimalStrings(after, before) > 0
	);
}

export type NativeAgentChatComposerState =
	| { readonly kind: "ready" }
	| {
			readonly kind: "disabled";
			readonly reason:
				| "sending"
				| "pending"
				| "working"
				| "attention"
				| "unavailable";
	  };

/** Input is offered only while the Host reports an idle prompt with no
 * attention. The Host still decides admission; this only explains why the
 * composer is closed. */
export function nativeAgentChatComposerState({
	runtime,
	state,
	sending,
	pending,
}: {
	runtime: Pick<HmuxAgentRuntimeState, "lifecycle" | "attention"> | undefined;
	state: AgentDisplayState;
	sending: boolean;
	pending: boolean;
}): NativeAgentChatComposerState {
	if (runtime?.lifecycle !== "running") {
		return { kind: "disabled", reason: "unavailable" };
	}
	if (sending) return { kind: "disabled", reason: "sending" };
	if (
		runtime.attention !== "none" ||
		state === "blocked" ||
		state === "input" ||
		state === "error"
	) {
		return { kind: "disabled", reason: "attention" };
	}
	if (state === "working") return { kind: "disabled", reason: "working" };
	if (pending) return { kind: "disabled", reason: "pending" };
	return state === "waiting"
		? { kind: "ready" }
		: { kind: "disabled", reason: "unavailable" };
}

/** The Host reports an idle prompt with no attention, the only state in
 * which it admits a prompt: the composer would be ready with nothing sent or
 * in flight. */
export function nativeAgentChatIdle({
	runtime,
	state,
}: {
	runtime: Pick<HmuxAgentRuntimeState, "lifecycle" | "attention"> | undefined;
	state: AgentDisplayState;
}): boolean {
	return (
		nativeAgentChatComposerState({
			runtime,
			state,
			sending: false,
			pending: false,
		}).kind === "ready"
	);
}

const COMPOSER_REASON_COPY: Record<
	Extract<NativeAgentChatComposerState, { kind: "disabled" }>["reason"],
	string
> = {
	sending: "agents.nativeChat.reason.sending",
	pending: "agents.nativeChat.reason.pending",
	working: "agents.nativeChat.reason.working",
	attention: "agents.nativeChat.reason.attention",
	unavailable: "agents.nativeChat.reason.unavailable",
};

export function nativeAgentChatComposerReason(
	state: NativeAgentChatComposerState,
): string | null {
	return state.kind === "ready" ? null : t(COMPOSER_REASON_COPY[state.reason]);
}

/** A refused or failed send: the typed token plus the message the error
 * carried (already translated for refusals raised in the client). */
export interface NativeAgentInputFailure {
	readonly code: string;
	readonly message?: string;
}

export function nativeAgentInputFailure(
	cause: unknown,
): NativeAgentInputFailure {
	const value =
		cause !== null && typeof cause === "object"
			? (cause as { code?: unknown; message?: unknown })
			: undefined;
	const code =
		typeof value?.code === "string" && value.code
			? value.code
			: "agent_runtime_native_input_failed";
	const message =
		typeof value?.message === "string" && value.message.trim()
			? value.message
			: undefined;
	return message ? { code, message } : { code };
}

/** Refusal tokens from `agent_runtime.native.input` and the Host prompt
 * admission. A catalogued token reads as its translated sentence; any other
 * token shows the message its error carried; a bare unknown token renders
 * verbatim. The token stays as the diagnostic detail whenever it is not
 * already the message. */
const INPUT_ERROR_COPY: Record<string, string> = {
	agent_runtime_native_changed: "agents.nativeChat.error.changed",
	hmux_agent_prompt_runtime_changed: "agents.nativeChat.error.changed",
	agent_runtime_native_conversation_missing:
		"agents.nativeChat.error.conversationMissing",
	agent_runtime_native_request_invalid:
		"agents.nativeChat.error.requestInvalid",
	hmux_agent_prompt_refused: "agents.nativeChat.error.refused",
	hmux_input_draft_pending: "agents.nativeChat.error.terminalDraft",
	agent_runtime_native_input_unconfirmed: "agents.nativeChat.error.unconfirmed",
	backend_request_deadline_exceeded: "agents.nativeChat.error.unconfirmed",
};

export function presentNativeAgentInputError({
	code,
	message,
}: NativeAgentInputFailure): {
	readonly message: string;
	readonly detail?: string;
} {
	const key = INPUT_ERROR_COPY[code];
	if (key) return { message: t(key), detail: code };
	return message && message !== code
		? { message, detail: code }
		: { message: code };
}

const TOOL_CALL_STATES: ReadonlySet<string> = new Set<ProviderToolCallState>([
	"running",
	"completed",
	"failed",
	"canceled",
]);
const MAX_TOOL_ID_LENGTH = 256;

function boundedToolText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_TOOL_ID_LENGTH
	);
}

/** The tool calls of one transcript read, checked at the boundary: a call
 * that is malformed, repeats an earlier call's id or sits outside the read's
 * messages is left out on its own, so one bad record never costs the
 * conversation. Kept in transcript order. */
export function nativeTranscriptToolCalls(
	tools: unknown,
	entryCount: number,
): ProviderToolCall[] {
	if (!Array.isArray(tools)) return [];
	const calls: ProviderToolCall[] = [];
	const seen = new Set<string>();
	for (const candidate of tools) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const { afterEntries, callId, name, state, input } = candidate as Record<
			string,
			unknown
		>;
		if (
			!Number.isSafeInteger(afterEntries) ||
			(afterEntries as number) < 0 ||
			(afterEntries as number) > entryCount ||
			!boundedToolText(callId) ||
			!boundedToolText(name) ||
			typeof state !== "string" ||
			!TOOL_CALL_STATES.has(state) ||
			seen.has(callId)
		) {
			continue;
		}
		seen.add(callId);
		calls.push({
			afterEntries: afterEntries as number,
			callId,
			name,
			state: state as ProviderToolCallState,
			input: input ?? null,
		});
	}
	return calls.sort((left, right) => left.afterEntries - right.afterEntries);
}

function row(
	sequence: number,
	item: Omit<AgentTimelineRowV1["item"], "providerMessageId">,
): AgentTimelineRowV1 {
	return {
		cursor: { epoch: TIMELINE_EPOCH, sequence },
		item: { ...item, providerMessageId: null },
	};
}

/** Projects the bounded provider transcript into the timeline page the shared
 * chat rows already render. Each user message opens a turn; the newest turn
 * stays open while the Agent works. A Host-confirmed prompt the transcript
 * does not yet hold closes that turn and opens a pending one, which stays
 * open until the prompt is released (then it reads as a sent message). A
 * prompt the transcript already ends with (see `nativeAgentChatPendingEchoed`)
 * is shown once. Tool calls read with the transcript sit between the
 * messages they were made between, so the shared rows collapse each run of
 * them into one burst line; a call without a recorded result reads as
 * running only in the newest turn and as canceled in an earlier one. Provider
 * entries carry no timestamps, so durations stay unset rather than
 * invented. */
export function nativeAgentChatPage({
	source,
	transcript,
	terminalEpoch,
	working,
	pending,
}: {
	source: NativeAgentTranscriptSource;
	transcript: ProviderConversationActivity;
	terminalEpoch: string;
	working: boolean;
	pending?: NativeAgentChatPendingPrompt;
}): AgentTimelinePageV1 {
	const { entries } = agentTranscriptFromProvider({
		source,
		transcript,
		entryLimit: null,
	});
	const rows: AgentTimelineRowV1[] = [];
	let turnId: string | null = null;
	const push = (item: Omit<AgentTimelineRowV1["item"], "providerMessageId">) =>
		rows.push(row(rows.length + 1, item));
	// Provider turns open and close at 0: without provider timestamps the
	// projection's worked-for duration stays 0 and is never shown.
	const closeTurn = () => {
		if (turnId === null) return;
		push({
			itemId: `${turnId}:completed`,
			turnId,
			clientMessageId: turnId,
			body: { type: "lifecycle", state: "turn_completed", detail: null },
			createdAtMs: 0,
		});
		turnId = null;
	};
	const openTurn = (id: string, createdAtMs: number) => {
		closeTurn();
		turnId = id;
		push({
			itemId: `${id}:started`,
			turnId: id,
			clientMessageId: id,
			body: { type: "lifecycle", state: "turn_started", detail: null },
			createdAtMs,
		});
	};

	if (!transcript.historyComplete) {
		push({
			itemId: "native-history-boundary",
			turnId: null,
			clientMessageId: null,
			body: {
				type: "history_boundary",
				reason: "provider_transcript_bounded",
				requestedAfterProviderSequence: 0,
				droppedThroughProviderSequence: 0,
			},
			createdAtMs: 0,
		});
	}
	const tools = nativeTranscriptToolCalls(transcript.tools, entries.length);
	// Only the newest turn can still have a call running in it (or waiting on
	// an approval); an earlier turn's call without a result was cut off.
	let newestTurnStart = 0;
	entries.forEach((entry, index) => {
		if (entry.kind === "message" && entry.role === "user") {
			newestTurnStart = index + 1;
		}
	});
	let nextTool = 0;
	const pushToolsThrough = (position: number) => {
		for (; nextTool < tools.length; nextTool += 1) {
			const tool = tools[nextTool] as ProviderToolCall;
			if (tool.afterEntries > position) return;
			push({
				itemId: `native-tool:${tool.callId}`,
				turnId,
				clientMessageId: turnId,
				body: {
					type: "tool",
					toolCallId: tool.callId,
					name: tool.name,
					state:
						tool.state === "running" && tool.afterEntries < newestTurnStart
							? "canceled"
							: tool.state,
					input: tool.input,
					output: null,
				},
				createdAtMs: 0,
			});
		}
	};
	entries.forEach((entry, index) => {
		pushToolsThrough(index);
		if (entry.kind !== "message" || !entry.text.trim()) return;
		if (entry.role === "user") openTurn(`native-turn:${index + 1}`, 0);
		push({
			itemId: `native-entry:${index + 1}`,
			turnId,
			clientMessageId: turnId,
			body: { type: "message", role: entry.role, markdown: entry.text },
			createdAtMs: 0,
		});
	});
	pushToolsThrough(entries.length);
	const pendingRow =
		pending && !nativeAgentChatPendingEchoed(pending, transcript)
			? pending
			: undefined;
	if (pendingRow) {
		openTurn(PENDING_ITEM_ID, pendingRow.sentAtMs);
		push({
			itemId: PENDING_ITEM_ID,
			turnId,
			clientMessageId: turnId,
			body: { type: "message", role: "user", markdown: pendingRow.text },
			createdAtMs: pendingRow.sentAtMs,
		});
	}
	if (!working && (!pendingRow || pendingRow.released)) closeTurn();

	return {
		binding: {
			schemaVersion: 1,
			interactionSessionId: `native:${source.agentId}:${source.conversationId}`,
			agentId: source.agentId,
			providerId: source.provider,
			executionProfile: { kind: "provider_default" },
			providerConversationRef: source.conversationId,
			runtime: { runtimeGeneration: terminalEpoch, providerEpoch: "native" },
			timelineEpoch: TIMELINE_EPOCH,
			bindingRevision: 1,
			historyComplete: transcript.historyComplete,
			createdAtMs: 0,
			updatedAtMs: 0,
		},
		rows,
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		latestFailure: null,
		recovery: null,
		goal: null,
		finalCursor: { epoch: TIMELINE_EPOCH, sequence: rows.length },
		hasMore: false,
	};
}
