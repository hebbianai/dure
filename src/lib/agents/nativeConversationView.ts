import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import type { Agent } from "@/types";
import {
	type NativeAgentTranscriptSource,
	nativeAgentTranscriptSource,
	recordedAgentTranscriptSource,
} from "../../../cli/lib/agent-transcript.mjs";

export interface NativeConversationViewAvailabilityV1 {
	/** This pane can offer the observer Conversation at all: a local
	 * Claude, Codex or Pi terminal, judged from what is known at mount rather
	 * than from the runtime binding a freshly launched Agent records later. */
	offered: boolean;
	/** The Conversation can be shown now: a live managed terminal whose
	 * recorded conversation belongs to the running generation. */
	available: boolean;
}

/** One authority for the pane's View menu and the view it presents, in Basic
 * and Pro alike. The Conversation never switches the runtime. */
export function nativeConversationViewAvailability(
	agent: Agent,
	runtime: HmuxAgentRuntimeState | undefined,
	disabled = false,
): NativeConversationViewAvailabilityV1 {
	const source = nativeAgentTranscriptSource(agent, agent.runtimeBinding);
	const binding = agent.runtimeBinding;
	const conversationEpoch =
		binding?.runtime === "hmux_managed_v1"
			? binding.conversationIdentity?.terminalEpoch
			: undefined;
	const offered =
		(source.kind === "local" || source.kind === "identity_unavailable") &&
		binding?.runtime !== "hmux_standalone_v1";
	const available =
		offered &&
		source.kind === "local" &&
		binding?.runtime === "hmux_managed_v1" &&
		!disabled &&
		runtime?.lifecycle === "running" &&
		conversationEpoch === runtime.terminalEpoch;
	return { offered, available };
}

/** The conversation a native terminal Agent's record shows. */
export interface NativeConversationRecordV1 {
	source: NativeAgentTranscriptSource;
	/** The terminal generation the conversation belongs to. */
	terminalEpoch: string;
	/** What reads it again (`nativeAgentChatRefreshCursor`): the Host's
	 * completed-turn count, and whether the agent works. */
	turnCompletedCount: string | undefined;
	working: boolean;
	/** The running session, whose conversation follows the terminal and takes
	 * input. Absent once the session has ended: the record is then the last
	 * conversation it recorded, read once and only read. */
	runtime?: HmuxAgentRuntimeState;
}

/** The generation an ended conversation is read under when its record names
 * none. */
const ENDED_TERMINAL_EPOCH = "ended";

/** Which conversation a view outside the pane shows for a native terminal
 * Agent: the live one when the pane's Conversation view could show it, or,
 * once the session has ended, the last conversation the Agent recorded,
 * from its provider's own history. Nothing for a remote session, an
 * unsupported provider, or one with no recorded conversation. The pane's
 * own Conversation view stays live only (see
 * `nativeConversationViewAvailability`). */
export function nativeConversationRecord(
	agent: Agent,
	runtime: HmuxAgentRuntimeState | undefined,
	state: AgentDisplayState,
): NativeConversationRecordV1 | undefined {
	const { offered, available } = nativeConversationViewAvailability(
		agent,
		runtime,
	);
	const binding = agent.runtimeBinding;
	if (available && runtime) {
		const source = nativeAgentTranscriptSource(agent, binding);
		return source.kind === "local"
			? {
					source,
					terminalEpoch: runtime.terminalEpoch,
					turnCompletedCount: runtime.turnCompletedCount,
					working: state === "working",
					runtime,
				}
			: undefined;
	}
	if (!offered || state !== "exited") return undefined;
	const source = recordedAgentTranscriptSource(agent);
	if (source.kind !== "local") return undefined;
	return {
		source,
		terminalEpoch:
			(binding?.runtime === "hmux_managed_v1"
				? binding.conversationIdentity?.terminalEpoch
				: undefined) ?? ENDED_TERMINAL_EPOCH,
		turnCompletedCount: undefined,
		working: false,
	};
}
