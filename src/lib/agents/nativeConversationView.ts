import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import type { Agent } from "@/types";
import { nativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

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
