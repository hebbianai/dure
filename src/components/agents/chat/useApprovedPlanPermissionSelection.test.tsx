// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useApprovedPlanPermissionSelection } from "@/components/agents/chat/useApprovedPlanPermissionSelection";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/ipc/dureAgentRuntime";

function row(
	itemId: string,
	sequence: number,
	body: AgentTimelineRowV1["item"]["body"],
): AgentTimelineRowV1 {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId,
			turnId: "turn-1",
			clientMessageId: null,
			providerMessageId: null,
			body,
			createdAtMs: sequence,
		},
	};
}

function planTimeline(decision: "allow" | "deny"): AgentTimelineRowV1[] {
	return [
		row("init", 1, {
			type: "provider_evidence",
			namespace: "provider.claude",
			kind: "provider_session_initialized",
			value: { permissionMode: "plan" },
		}),
		row("answer", 2, {
			type: "pending_answer",
			idempotencyKey: "answer-key",
			request: {
				interactionSessionId: "interaction-1",
				runtime: { runtimeGeneration: "runtime-1", providerEpoch: "query-1" },
				request: {
					requestId: "plan-request",
					kind: "permission",
					turnId: "turn-1",
					clientMessageId: "message-1",
					payload: { toolName: "ExitPlanMode", input: { plan: "# Plan" } },
					createdAtMs: 2,
				},
			},
			answer: { decision },
		}),
		...(decision === "allow"
			? [
					row("mode", 3, {
						type: "provider_evidence",
						namespace: "provider.claude",
						kind: "provider_permission_mode",
						value: {
							permissionMode: "default",
							providerPermissionMode: "default",
						},
					}),
				]
			: []),
	];
}

function session(rows: AgentTimelineRowV1[]): AgentChatSessionView {
	return {
		activeTurn: { turnId: "turn-1", clientMessageId: "message-1" },
		page: { rows },
	} as unknown as AgentChatSessionView;
}

function launch(
	overrides: Partial<AgentRuntimeLaunchSelectionView> = {},
): AgentRuntimeLaunchSelectionView {
	return {
		ownerKey: "owner-1",
		paneId: "pane-1",
		selectionRevision: 4,
		conversationId: "conversation-1",
		loaded: true,
		hydrationError: false,
		model: null,
		effort: "high",
		permissionMode: "plan",
		switching: false,
		error: null,
		switchSelection: vi.fn(async () => ({ outcome: "pending" as const })),
		retryHydration: vi.fn(),
		dismissError: vi.fn(),
		...overrides,
	};
}

const planSource: DureAgentRuntimeLaunchSelectionV1 = {
	model: null,
	effort: "high",
	permissionMode: "plan",
};

describe("useApprovedPlanPermissionSelection", () => {
	it("moves the selection to the mode Claude continues in once a plan is approved", () => {
		const view = launch();
		const { rerender } = renderHook(
			({ chat, selection }) =>
				useApprovedPlanPermissionSelection(chat, selection),
			{
				initialProps: { chat: session(planTimeline("allow")), selection: view },
			},
		);

		expect(view.switchSelection).toHaveBeenCalledTimes(1);
		const [update, expected] = vi.mocked(view.switchSelection).mock.calls[0]!;
		expect(update(planSource)).toEqual({
			...planSource,
			permissionMode: "default",
		});
		// A source that already left plan mode is not overwritten.
		expect(update({ ...planSource, permissionMode: "auto_edit" })).toEqual({
			...planSource,
			permissionMode: "auto_edit",
		});
		expect(expected).toEqual({
			expectedSourceRevision: 4,
			expectedConversationId: "conversation-1",
		});

		rerender({
			chat: session(planTimeline("allow")),
			selection: launch({ switchSelection: view.switchSelection }),
		});
		expect(view.switchSelection).toHaveBeenCalledTimes(1);
	});

	it("leaves plan mode selected when the person keeps planning", () => {
		const view = launch();
		renderHook(() =>
			useApprovedPlanPermissionSelection(session(planTimeline("deny")), view),
		);
		expect(view.switchSelection).not.toHaveBeenCalled();
	});

	it("waits for a pending settings change and only follows a plan selection", () => {
		const switchSelection = vi.fn(async () => ({
			outcome: "pending" as const,
		}));
		const chat = session(planTimeline("allow"));
		const { rerender } = renderHook(
			({ selection }) => useApprovedPlanPermissionSelection(chat, selection),
			{
				initialProps: {
					selection: launch({
						switchSelection,
						pending: {
							requestId: "pending-1",
							selection: { ...planSource, permissionMode: "auto_edit" },
						},
					}),
				},
			},
		);
		rerender({
			selection: launch({ switchSelection, permissionMode: "default" }),
		});
		expect(switchSelection).not.toHaveBeenCalled();

		rerender({ selection: launch({ switchSelection }) });
		expect(switchSelection).toHaveBeenCalledTimes(1);
	});
});
