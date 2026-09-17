// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StructuredAgentChatSurface } from "@/components/agents/chat/StructuredAgentChatSurface";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

function pending(requestId: string): AgentPendingRequestV1 {
	return {
		interactionSessionId: "interaction-1",
		runtime: {
			runtimeGeneration: "runtime-1",
			providerEpoch: "query-1",
		},
		request: {
			requestId,
			kind: "permission",
			turnId: null,
			clientMessageId: "message-1",
			payload: { toolName: "Bash", input: { command: "pwd" } },
			createdAtMs: 1,
		},
	};
}

function session(
	pendingRequests = [pending("request-1")],
): AgentChatSessionView {
	return {
		draftIdentity: { agentId: "agent-1", backendProfileId: "local", interactionSessionId: "interaction-1" },
		phase: "ready",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		putGoal: vi.fn(async () => true),
		retryTurnAvailable: false,
		interrupting: false,
		loadingOlder: false,
		queuedMessages: [],
		page: {
			binding: {
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				agentId: "agent-1",
				providerId: "claude",
				executionProfile: { kind: "provider_default" },
				providerConversationRef: null,
				runtime: pendingRequests[0]?.runtime ?? {
					runtimeGeneration: "runtime-1",
					providerEpoch: "query-1",
				},
				timelineEpoch: "timeline-1",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			rows: [],
			liveText: [],
			pendingRequests,
			activeTurn: null,
			goal: null,
			finalCursor: { epoch: "timeline-1", sequence: 0 },
			hasMore: false,
		},
		retryConnection: vi.fn(),
		loadOlder: vi.fn(async () => {}),
		send: vi.fn(async () => {}),
		retryTurn: vi.fn(async () => {}),
		editRetryableTurn: vi.fn(() => undefined),
		answerPending: vi.fn(async () => {}),
		interrupt: vi.fn(async () => {}),
		dismissActionError: vi.fn(),
		queueMessage: vi.fn(),
		steerOrQueue: vi.fn(async () => "queued" as const),
		dequeueMessage: vi.fn(() => undefined),
	};
}

describe("StructuredAgentChatSurface", () => {
	beforeEach(() => {
		// jsdom has no layout; expose a visible viewport to the real virtualizer.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-index") ? 32 : 600;
			},
		);
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("routes a card answer through its exact pending request", () => {
		const value = session();
		render(<StructuredAgentChatSurface session={value} />);

		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.allow") }),
		);

		expect(value.answerPending).toHaveBeenCalledWith("request-1", {
			decision: "allow",
		});
	});

	it("projects the controller's one busy lane across every pending card", () => {
		const value = session([pending("request-1"), pending("request-2")]);
		value.answeringRequestId = "request-1";
		render(<StructuredAgentChatSurface session={value} />);

		for (const name of [t("agents.chat.deny"), t("agents.chat.allow")]) {
			const controls = screen.getAllByRole("button", { name });
			expect(controls).toHaveLength(2);
			for (const control of controls) {
				expect((control as HTMLButtonElement).disabled).toBe(true);
			}
		}
	});
});

beforeEach(() => useStore.setState({ chatDrafts: {} }));
