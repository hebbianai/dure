import type { RecoveryObservation } from "@/lib/agents/accountRecoveryContract";
import type { AgentTimelineFailureV1 } from "./turnFailureReason";

export interface AgentProviderRuntimeFenceV1 {
	runtimeGeneration: string;
	providerEpoch: string;
}

export type AgentExecutionProfileV1 =
	| { kind: "provider_default" }
	| {
			kind: "credential_reference";
			reference_id: string;
			credential_generation: string | null;
	  };

export interface AgentInteractionBindingV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	agentId: string;
	providerId: string;
	executionProfile: AgentExecutionProfileV1;
	providerConversationRef: string | null;
	runtime: AgentProviderRuntimeFenceV1;
	timelineEpoch: string;
	bindingRevision: number;
	historyComplete: boolean;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface AgentTimelineCursorV1 {
	epoch: string;
	sequence: number;
}

export interface AgentTimelineReadRequestV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	direction: "after" | "before" | "tail";
	cursor: AgentTimelineCursorV1 | null;
	limit: number;
}

export type AgentTimelineLifecycleStateV1 =
	| "session_ready"
	| "session_failed"
	| "session_exited"
	| "turn_started"
	| "turn_completed"
	| "turn_failed"
	| "turn_canceled";

export type AgentTimelineToolStateV1 =
	| "running"
	| "completed"
	| "failed"
	| "canceled";

export type AgentTimelineItemBodyV1 =
	| {
			type: "lifecycle";
			state: AgentTimelineLifecycleStateV1;
			detail: string | null;
	  }
	| { type: "message"; role: "user" | "assistant"; markdown: string }
	| { type: "goal_continuation"; objective: string; goalRevision: number }
	| { type: "queued_input"; state: AgentQueuedTurnStateV1 }
	| {
			type: "pending_answer";
			idempotencyKey: string;
			request: AgentPendingRequestV1;
			answer: unknown;
	  }
	| { type: "reasoning"; text: string }
	| {
			type: "tool";
			toolCallId: string;
			name: string;
			state: AgentTimelineToolStateV1;
			input: unknown | null;
			output: unknown | null;
	  }
	| { type: "tool_input"; jsonText: string }
	| { type: "plan"; value: unknown }
	| { type: "error"; code: string; message: string }
	| {
			type: "history_boundary";
			reason: string;
			requestedAfterProviderSequence: number;
			droppedThroughProviderSequence: number;
	  }
	| {
			type: "provider_evidence";
			namespace: string;
			kind: string;
			value: unknown;
	  };

interface AgentTimelineItemV1 {
	itemId: string;
	turnId: string | null;
	clientMessageId: string | null;
	providerMessageId: string | null;
	body: AgentTimelineItemBodyV1;
	createdAtMs: number;
}

export interface AgentTimelineRowV1 {
	cursor: AgentTimelineCursorV1;
	item: AgentTimelineItemV1;
}

export interface AgentTimelineLiveTextV1 {
	streamId: string;
	itemId: string;
	kind: "assistant" | "reasoning" | "tool_input";
	text: string;
	turnId: string | null;
	clientMessageId: string | null;
	providerMessageId: string;
	updatedAtMs: number;
}

export interface AgentPendingRequestV1 {
	interactionSessionId: string;
	runtime: AgentProviderRuntimeFenceV1;
	request: {
		requestId: string;
		kind: "permission" | "question";
		turnId: string | null;
		clientMessageId: string;
		payload: unknown;
		createdAtMs: number;
	};
}

export interface AgentTimelineActiveTurnV1 {
	turnId: string;
	clientMessageId: string;
}

export type AgentGoalStatusV1 = "active" | "paused" | "complete" | "failed";

export interface AgentGoalRecordV1 {
	schemaVersion: 1;
	agentId: string;
	revision: number;
	objective: string;
	status: AgentGoalStatusV1;
	detail: string | null;
	activationCursor: AgentTimelineCursorV1;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface AgentGoalUpdateV1 {
	objective: string;
	status: AgentGoalStatusV1;
	expectedRevision: number;
}

export interface AgentGoalPutRequestV1 extends AgentGoalUpdateV1 {
	schemaVersion: 1;
	agentId: string;
	idempotencyKey: string;
	detail: string | null;
}

export type AgentQueuedTurnStateV1 = "queued" | "dispatched" | "canceled";

export interface AgentStartTurnIntentV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	runtime: AgentProviderRuntimeFenceV1;
	turnId: string;
	clientMessageId: string;
	input: string;
	requestedAtMs: number;
}

export interface AgentContinueTurnRequestV1 {
	intent: AgentStartTurnIntentV1;
	expectedCursor: AgentTimelineCursorV1;
}

export interface AgentQueuedTurnRecordV1 {
	intent: AgentStartTurnIntentV1;
	state: AgentQueuedTurnStateV1;
	timelineCursor: AgentTimelineCursorV1;
}

export interface AgentInputReadRequestV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	clientMessageId: string;
}

export type AgentInputObservationV1 =
	| {
			kind: "queued";
			intent: AgentStartTurnIntentV1;
			state: "queued" | "dispatched" | "canceled";
	  }
	| {
			kind: "turn";
			intent: AgentStartTurnIntentV1;
			state: "prepared" | "accepted" | "failed" | "uncertain";
	  };

export interface AgentTimelinePageV1 {
	binding: AgentInteractionBindingV1;
	rows: AgentTimelineRowV1[];
	liveText: AgentTimelineLiveTextV1[];
	pendingRequests: AgentPendingRequestV1[];
	activeTurn: AgentTimelineActiveTurnV1 | null;
	latestFailure: AgentTimelineFailureV1 | null;
	recovery: RecoveryObservation | null;
	goal: AgentGoalRecordV1 | null;
	queuedInputs?: AgentQueuedInputPageV1;
	finalCursor: AgentTimelineCursorV1;
	hasMore: boolean;
}

export interface AgentQueuedInputV1 {
	clientMessageId: string;
	sequence: number;
	preview: string;
}

export interface AgentQueuedInputPageV1 {
	interactionSessionId: string;
	inputs: AgentQueuedInputV1[];
	nextAfter: number | null;
}

export interface AgentQueueReadRequestV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	afterSequence: number;
}

export type AgentTimelineReadV1 =
	| { type: "page"; page: AgentTimelinePageV1 }
	| { type: "reset"; binding: AgentInteractionBindingV1; reason: string };
