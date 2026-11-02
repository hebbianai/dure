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
	readonly transcript: ProviderConversationTranscriptV1;
	readonly turnCompletedCount: string | undefined;
}

/** A prompt the Host confirmed writing that the transcript has not shown yet. */
export interface NativeAgentChatPendingPrompt {
	readonly text: string;
	readonly sentAtMs: number;
	/** User entries in the newest transcript at send time; null if none loaded. */
	readonly userEntriesAtSend: number | null;
	readonly turnCompletedCountAtSend: string | undefined;
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

/** The pending prompt is gone once the transcript holds a newer user entry,
 * or once the Host completed a turn after the send and the transcript read at
 * that count still lacks it (for example a TUI-only command). */
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

/** Refusal tokens from `agent_runtime.native.input` and the Host prompt
 * admission. An unknown token renders verbatim; a known one keeps the token
 * as its diagnostic detail. */
const INPUT_ERROR_COPY: Record<string, string> = {
	agent_runtime_native_changed: "agents.nativeChat.error.changed",
	hmux_agent_prompt_runtime_changed: "agents.nativeChat.error.changed",
	agent_runtime_native_conversation_missing:
		"agents.nativeChat.error.conversationMissing",
	hmux_agent_prompt_refused: "agents.nativeChat.error.refused",
	hmux_input_draft_pending: "agents.nativeChat.error.terminalDraft",
	agent_runtime_native_input_unconfirmed: "agents.nativeChat.error.unconfirmed",
	backend_request_deadline_exceeded: "agents.nativeChat.error.unconfirmed",
};

export function presentNativeAgentInputError(code: string): {
	readonly message: string;
	readonly detail?: string;
} {
	const key = INPUT_ERROR_COPY[code];
	return key ? { message: t(key), detail: code } : { message: code };
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
 * does not yet hold closes that turn and opens a pending one. Provider
 * entries carry no timestamps, so durations stay unset rather than invented. */
export function nativeAgentChatPage({
	source,
	transcript,
	terminalEpoch,
	working,
	pending,
}: {
	source: NativeAgentTranscriptSource;
	transcript: ProviderConversationTranscriptV1;
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
	entries.forEach((entry, index) => {
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
	if (pending) {
		openTurn(PENDING_ITEM_ID, pending.sentAtMs);
		push({
			itemId: PENDING_ITEM_ID,
			turnId,
			clientMessageId: turnId,
			body: { type: "message", role: "user", markdown: pending.text },
			createdAtMs: pending.sentAtMs,
		});
	} else if (!working) {
		closeTurn();
	}

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
