import type { ExactHmuxManagedSessionV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	DecisionAnswerProjection,
	InteractionAudienceGrant,
	InteractionProjection,
	InteractionTargetProjection,
} from "@/lib/interactions/interactionProjection";
import type {
	DureBackendIdentity,
	DureRequestFailureV1,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

export type OrchestrationSessionGenerationV1 = ExactHmuxManagedSessionV1;

export const MAX_DISPATCH_CONTEXT_BATCH_ITEMS = 32;
export const MAX_READ_EVENTS_BATCH_ITEMS = 32;

export interface WorkerEndpointFenceV1 {
	endpointRef: string;
	sessionIdentity: string;
	generation: number;
	deliveryCapability: string;
	acknowledgementCapability: string;
}

export interface InteractionAudienceGrantAccessV1
	extends InteractionAudienceGrant {
	capabilities: string[];
	deliveryCapability: string;
}

export interface IntegrationCapabilityReceiptV1 {
	installRootRef: string;
	version: string;
	digest: string;
	channel: string;
	capabilities: string[];
}

export interface DispatchContextReceiptV1 {
	schemaVersion: 1;
	target: InteractionTargetProjection;
	dispatchRevision: number;
	dispatchState: "active" | "blocked" | "completed";
	successorRequired: boolean;
	participant: string;
	interactionCapability: string;
	completionCapability: string;
	deliveryCapability: string;
	acknowledgementCapability: string;
	wakeCapability?: string;
	endpointFence: WorkerEndpointFenceV1;
	coordinatorGrant: InteractionAudienceGrantAccessV1;
	coordinatorReplyCapability: string;
	integrationReceipt: IntegrationCapabilityReceiptV1;
}

export interface DispatchContextCandidateV1 {
	agentId: string;
	session: OrchestrationSessionGenerationV1;
	expectedDispatch?: {
		taskId: string;
		dispatchId: string;
		generation: number;
	};
}

type DispatchContextBatchResultV1 =
	| {
			outcome: "found";
			candidate: DispatchContextCandidateV1;
			context: DispatchContextReceiptV1;
	  }
	| {
			outcome: "failed";
			candidate: DispatchContextCandidateV1;
			code: string;
			message: string;
			failure: Extract<DureRequestFailureV1, { kind: "operation" }>;
	  };

export interface DispatchContextBatchReceiptV1 {
	schemaVersion: 1;
	results: DispatchContextBatchResultV1[];
}

export interface OpenExactSessionMessageRequestV1 {
	schemaVersion: 1;
	session: OrchestrationSessionGenerationV1;
	expectedEndpointRef: string;
	idempotencyKey: string;
	interactionId: string;
	title: string;
	descriptionMarkdown: string;
	openedAtMs: number;
}

export type OrchestrationEventKindV1 =
	| { kind: "run_created"; workflowKindRef: string }
	| { kind: "interaction_opened"; interactionId: string }
	| { kind: "dispatch_blocked"; decisionId: string }
	| { kind: "decision_answered"; decisionId: string }
	| { kind: "dispatch_unblocked"; decisionId: string }
	| { kind: "dispatch_completed"; messageId: string };

export interface OrchestrationEventV1 {
	cursor: number;
	target: InteractionTargetProjection;
	actor: string;
	kind: OrchestrationEventKindV1;
	recordedAtMs: number;
}

export interface DeliveryReceiptV1 {
	receiptId: string;
	eventCursor: number;
	participant: string;
	state: "queued" | "observed" | "acknowledged";
	endpoint?: {
		endpointRef: string;
		sessionIdentity: string;
		generation: number;
	};
	wake?: {
		state: "pending" | "uncertain" | "triggered" | "queued_until_next_turn";
		effectRef?: string;
		reasonCode?: string;
		updatedAtMs: number;
	};
}

export interface EnrollManagedSessionRequestV1 {
	session: OrchestrationSessionGenerationV1;
	integrationReceipt: IntegrationCapabilityReceiptV1;
	idempotencyKey: string;
	createdAtMs: number;
}

export interface CreateRunReceiptV1 {
	context: DispatchContextReceiptV1;
	event: OrchestrationEventV1;
	deliveries: DeliveryReceiptV1[];
	idempotent: boolean;
}

interface EventAcknowledgementV1 {
	through: number;
	idempotencyKey: string;
	acknowledgementCapability: string;
}

export interface EventAcknowledgementReceiptV1 {
	through: number;
	delivery: DeliveryReceiptV1;
	idempotent: boolean;
}

export interface ReadEventsRequestV1 {
	authority: InteractionTargetProjection["authority"];
	target?: InteractionTargetProjection;
	participant: string;
	deliveryCapability: string;
	endpointFence?: WorkerEndpointFenceV1;
	after: number;
	acknowledgement?: EventAcknowledgementV1;
	limit: number;
}

export interface ReadEventsReceiptV1 {
	events: OrchestrationEventV1[];
	deliveries: DeliveryReceiptV1[];
	nextCursor: number;
	acknowledgement?: EventAcknowledgementReceiptV1;
}

interface ReadEventsBatchItemV1 {
	correlationId: string;
	request: ReadEventsRequestV1;
}

export interface ReadEventsBatchRequestV1 {
	authority: InteractionTargetProjection["authority"];
	requests: readonly ReadEventsBatchItemV1[];
}

type ReadEventsBatchResultV1 =
	| {
			outcome: "read";
			correlationId: string;
			receipt: ReadEventsReceiptV1;
	  }
	| {
			outcome: "failed";
			correlationId: string;
			code: string;
			message: string;
			failure: Extract<DureRequestFailureV1, { kind: "operation" }>;
	  };

export interface ReadEventsBatchReceiptV1 {
	schemaVersion: 1;
	authority: InteractionTargetProjection["authority"];
	results: ReadEventsBatchResultV1[];
}

interface ReadEventsRouteBatchItemV1 {
	correlationId: string;
	request: ReadEventsBatchRequestV1;
}

export interface ReadEventsRouteBatchRequestV1 {
	batches: readonly ReadEventsRouteBatchItemV1[];
}

type ReadEventsRouteBatchResultV1 =
	| {
			outcome: "read";
			correlationId: string;
			receipt: ReadEventsBatchReceiptV1;
	  }
	| {
			outcome: "failed";
			correlationId: string;
			authority: InteractionTargetProjection["authority"];
			code: string;
			message: string;
			failure: Extract<DureRequestFailureV1, { kind: "operation" }>;
	  };

export interface ReadEventsRouteBatchReceiptV1 {
	schemaVersion: 1;
	results: ReadEventsRouteBatchResultV1[];
}

export interface InteractionRecordReceiptV1 {
	interaction: InteractionProjection;
	replyCapability?: string;
}

export interface AnswerExactSessionDecisionRequestV1 {
	schemaVersion: 1;
	session: OrchestrationSessionGenerationV1;
	expectedDispatchRevision: number;
	expectedReplyCapability: string;
	idempotencyKey: string;
	interactionId: string;
	expectedRevision: number;
	answer: DecisionAnswerProjection;
	answeredAtMs: number;
}

export interface AnswerDecisionReceiptV1 {
	interaction: InteractionProjection;
	dispatchState: "active";
	events: OrchestrationEventV1[];
	deliveries: DeliveryReceiptV1[];
	idempotent: boolean;
}

export interface OpenInteractionReceiptV1 {
	interaction: InteractionProjection;
	dispatchState: "active";
	events: OrchestrationEventV1[];
	deliveries: DeliveryReceiptV1[];
	idempotent: boolean;
}

export interface OrchestrationCall<T> {
	backend: DureBackendIdentity;
	receipt: T;
}

export interface DureOrchestrationTransport {
	getDispatchContext(
		routeAuthority: DureBackendRouteAuthorityV1,
		session: OrchestrationSessionGenerationV1,
	): Promise<OrchestrationCall<DispatchContextReceiptV1>>;
	getDispatchContexts(
		routeAuthority: DureBackendRouteAuthorityV1,
		candidates: readonly DispatchContextCandidateV1[],
	): Promise<OrchestrationCall<DispatchContextBatchReceiptV1>>;
	enrollManagedSession(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: EnrollManagedSessionRequestV1,
	): Promise<OrchestrationCall<CreateRunReceiptV1>>;
	getExactDispatchContext(
		routeAuthority: DureBackendRouteAuthorityV1,
		session: OrchestrationSessionGenerationV1,
	): Promise<OrchestrationCall<DispatchContextReceiptV1>>;
	openExactSessionMessage(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: OpenExactSessionMessageRequestV1,
	): Promise<OrchestrationCall<OpenInteractionReceiptV1>>;
	readEvents(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: ReadEventsRequestV1,
	): Promise<OrchestrationCall<ReadEventsReceiptV1>>;
	readEventsBatch(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: ReadEventsBatchRequestV1,
	): Promise<OrchestrationCall<ReadEventsBatchReceiptV1>>;
	readEventsRouteBatch(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: ReadEventsRouteBatchRequestV1,
	): Promise<OrchestrationCall<ReadEventsRouteBatchReceiptV1>>;
	getInteraction(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: {
			authority: InteractionTargetProjection["authority"];
			interactionId: string;
			participant: string;
			readCapability: string;
		},
	): Promise<OrchestrationCall<InteractionRecordReceiptV1>>;
	answerDecision(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: AnswerExactSessionDecisionRequestV1,
	): Promise<OrchestrationCall<AnswerDecisionReceiptV1>>;
}
