import {
	agentTranscriptFromProvider,
	type NativeAgentTranscriptSource,
	type ProviderConversationTranscriptV1,
} from "../../../cli/lib/agent-transcript.mjs";

/** Validate the exact transcript identity before displaying provider-marked
 * final text. Older adapters and interrupted/tool-only turns stay in Terminal. */
export function nativeFinalResponse(
	source: NativeAgentTranscriptSource,
	transcript: ProviderConversationTranscriptV1,
): string | null {
	agentTranscriptFromProvider({ source, transcript, entryLimit: 1 });
	if (!transcript.historyComplete)
		throw new Error("provider_transcript_incomplete");
	if (transcript.finalResponse == null) return null;
	if (typeof transcript.finalResponse !== "string") {
		throw new Error("provider_final_response_invalid");
	}
	return transcript.finalResponse.trim() ? transcript.finalResponse : null;
}
