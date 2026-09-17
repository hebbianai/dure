import { describe, expect, it, vi } from "vitest";
import {
	createAgentChatActionRequests,
	fingerprintAgentChatAnswer,
	parseAgentChatInput,
} from "@/lib/agents/chat/agentChatActionRequests";
import type {
	AgentPendingRequestV1,
	AgentProviderRuntimeFenceV1,
	AgentTimelineActiveTurnV1,
} from "@/lib/agents/chat/agentConversationContract";

const runtime: AgentProviderRuntimeFenceV1 = {
	runtimeGeneration: "runtime-1",
	providerEpoch: "provider-1",
};

const activeTurn: AgentTimelineActiveTurnV1 = {
	turnId: "turn-active",
	clientMessageId: "message-active",
};

const pending: AgentPendingRequestV1 = {
	interactionSessionId: "interaction-1",
	runtime,
	request: {
		requestId: "request-1",
		kind: "permission",
		turnId: "turn-active",
		clientMessageId: "message-active",
		payload: { title: "Allow command" },
		createdAtMs: 100,
	},
};

describe("agent chat action requests", () => {
	it("parses non-empty input within the byte limit", () => {
		expect(parseAgentChatInput(" hello ")).toBe(" hello ");
		expect(() => parseAgentChatInput(" \n\t ")).toThrow(
			"agent_chat_input_invalid",
		);
		const atUtf8Limit = `${"가".repeat(87_381)}x`;
		expect(parseAgentChatInput(atUtf8Limit)).toBe(atUtf8Limit);
		expect(() => parseAgentChatInput(`${atUtf8Limit}x`)).toThrow(
			"agent_chat_input_invalid",
		);
	});

	it("builds every action request from one injected session identity", () => {
		const id = vi.fn((scope: string) => `${scope}-id`);
		const requests = createAgentChatActionRequests({
			interactionSessionId: "interaction-1",
			now: () => 123,
			id,
		});
		const input = parseAgentChatInput("hello");

		expect(requests.startTurn(runtime, input)).toEqual({
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			runtime,
			turnId: "chat-turn-id",
			clientMessageId: "chat-message-id",
			input: "hello",
			requestedAtMs: 123,
		});
		expect(requests.steerTurn(runtime, activeTurn, input)).toEqual({
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			runtime,
			turnId: "turn-active",
			clientMessageId: "chat-steer-id",
			input: "hello",
			requestedAtMs: 123,
		});
		expect(requests.answerPending(pending, { approved: true })).toEqual({
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			runtime,
			requestId: "request-1",
			clientMessageId: "message-active",
			idempotencyKey: "chat-answer-id",
			answer: { approved: true },
			requestedAtMs: 123,
		});
		expect(requests.interruptTurn(runtime, activeTurn)).toEqual({
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			runtime,
			turnId: "turn-active",
			clientMessageId: "message-active",
			interruptRequestId: "chat-interrupt-id",
			requestedAtMs: 123,
		});
		expect(id.mock.calls.map(([scope]) => scope)).toEqual([
			"chat-turn",
			"chat-message",
			"chat-steer",
			"chat-answer",
			"chat-interrupt",
		]);
	});

	it("uses one stable answer fingerprint or rejects unstringifiable input", () => {
		expect(fingerprintAgentChatAnswer({ approved: true })).toBe(
			'{"approved":true}',
		);
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(fingerprintAgentChatAnswer(circular)).toBe("");
	});
});
