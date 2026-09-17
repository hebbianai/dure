import type {
	AgentPendingRequestV1,
	AgentProviderRuntimeFenceV1,
	AgentTimelineActiveTurnV1,
} from "@/lib/agents/chat/agentConversationContract";
import type {
	AgentConversationAnswerPendingV1,
	AgentConversationInterruptTurnV1,
	AgentConversationStartTurnV1,
} from "@/lib/ipc/dureAgentConversation";

const MAX_INPUT_BYTES = 256 * 1024;
const encoder = new TextEncoder();

declare const validAgentChatInput: unique symbol;
export type AgentChatInput = string & {
	readonly [validAgentChatInput]: true;
};

export function parseAgentChatInput(input: string): AgentChatInput {
	if (
		input.trim().length === 0 ||
		encoder.encode(input).byteLength > MAX_INPUT_BYTES
	) {
		throw new Error("agent_chat_input_invalid");
	}
	return input as AgentChatInput;
}

export function fingerprintAgentChatAnswer(answer: unknown): string {
	try {
		return JSON.stringify(answer);
	} catch {
		return "";
	}
}

interface AgentChatActionRequestDependencies {
	readonly interactionSessionId: string;
	readonly now: () => number;
	readonly id: (scope: string) => string;
}

interface AgentChatActionRequests {
	startTurn(
		runtime: AgentProviderRuntimeFenceV1,
		input: AgentChatInput,
	): AgentConversationStartTurnV1;
	steerTurn(
		runtime: AgentProviderRuntimeFenceV1,
		turn: AgentTimelineActiveTurnV1,
		input: AgentChatInput,
	): AgentConversationStartTurnV1;
	answerPending(
		pending: AgentPendingRequestV1,
		answer: unknown,
	): AgentConversationAnswerPendingV1;
	interruptTurn(
		runtime: AgentProviderRuntimeFenceV1,
		turn: AgentTimelineActiveTurnV1,
	): AgentConversationInterruptTurnV1;
}

/** Builds protocol request intents from the controller's injected clock and
 * id source. It owns no mutable session state; the controller remains the sole
 * authority for retaining and retrying the returned requests unchanged. */
export function createAgentChatActionRequests(
	dependencies: AgentChatActionRequestDependencies,
): AgentChatActionRequests {
	const { interactionSessionId, now, id } = dependencies;
	return {
		startTurn: (runtime, input) => ({
			schemaVersion: 1,
			interactionSessionId,
			runtime,
			turnId: id("chat-turn"),
			clientMessageId: id("chat-message"),
			input,
			requestedAtMs: now(),
		}),
		steerTurn: (runtime, turn, input) => ({
			schemaVersion: 1,
			interactionSessionId,
			runtime,
			turnId: turn.turnId,
			clientMessageId: id("chat-steer"),
			input,
			requestedAtMs: now(),
		}),
		answerPending: (pending, answer) => ({
			schemaVersion: 1,
			interactionSessionId,
			runtime: pending.runtime,
			requestId: pending.request.requestId,
			clientMessageId: pending.request.clientMessageId,
			idempotencyKey: id("chat-answer"),
			answer,
			requestedAtMs: now(),
		}),
		interruptTurn: (runtime, turn) => ({
			schemaVersion: 1,
			interactionSessionId,
			runtime,
			turnId: turn.turnId,
			clientMessageId: turn.clientMessageId,
			interruptRequestId: id("chat-interrupt"),
			requestedAtMs: now(),
		}),
	};
}
