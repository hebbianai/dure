import { describe, expect, it } from "vitest";
import type {
	NativeAgentTranscriptSource,
	ProviderConversationTranscriptV1,
} from "../../../cli/lib/agent-transcript.mjs";
import { nativeFinalResponse } from "./nativeFinalResponse";

const source: NativeAgentTranscriptSource = {
	kind: "local",
	agentId: "agent-one",
	provider: "codex",
	conversationId: "conversation-one",
};
const transcript: ProviderConversationTranscriptV1 = {
	schemaVersion: 1,
	provider: "codex",
	conversationId: "conversation-one",
	historyComplete: true,
	finalResponse: "**Completed**",
	entries: [
		{ role: "agent", text: "Running a tool" },
		{ role: "agent", text: "Unfinished next turn" },
	],
};

describe("nativeFinalResponse", () => {
	it("uses the marked final answer, never the latest assistant preamble", () => {
		expect(nativeFinalResponse(source, transcript)).toBe("**Completed**");
		expect(
			nativeFinalResponse(source, { ...transcript, finalResponse: undefined }),
		).toBeNull();
		expect(
			nativeFinalResponse(source, { ...transcript, finalResponse: "  " }),
		).toBeNull();
	});
	it("rejects another conversation, incomplete reads, and malformed final text", () => {
		for (const patch of [
			{ conversationId: "other" },
			{ provider: "claude" },
			{ historyComplete: false },
			{ finalResponse: 42 },
		]) {
			expect(() =>
				nativeFinalResponse(source, {
					...transcript,
					...patch,
				} as ProviderConversationTranscriptV1),
			).toThrow();
		}
	});
});
