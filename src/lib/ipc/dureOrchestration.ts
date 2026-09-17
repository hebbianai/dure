import { t } from "@/lib/i18n";
import type {
	DecisionAnswerProjection,
	DecisionResponseProjection,
	InteractionTargetProjection,
} from "@/lib/interactions/interactionProjection";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
	DureBackendRequestError,
	type DureRequestFailureV1,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type {
	AnswerDecisionReceiptV1,
	AnswerExactSessionDecisionRequestV1,
	CreateRunReceiptV1,
	DeliveryReceiptV1,
	DispatchContextBatchReceiptV1,
	DispatchContextCandidateV1,
	DispatchContextReceiptV1,
	DureOrchestrationTransport,
	EnrollManagedSessionRequestV1,
	EventAcknowledgementReceiptV1,
	IntegrationCapabilityReceiptV1,
	InteractionAudienceGrantAccessV1,
	InteractionRecordReceiptV1,
	OpenExactSessionMessageRequestV1,
	OpenInteractionReceiptV1,
	OrchestrationCall,
	OrchestrationEventKindV1,
	OrchestrationEventV1,
	OrchestrationSessionGenerationV1,
	ReadEventsBatchReceiptV1,
	ReadEventsBatchRequestV1,
	ReadEventsReceiptV1,
	ReadEventsRequestV1,
	ReadEventsRouteBatchReceiptV1,
	ReadEventsRouteBatchRequestV1,
	WorkerEndpointFenceV1,
} from "@/lib/ipc/dureOrchestrationContract";
import {
	MAX_DISPATCH_CONTEXT_BATCH_ITEMS,
	MAX_READ_EVENTS_BATCH_ITEMS,
} from "@/lib/ipc/dureOrchestrationContract";
import { isDureDomainIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import {
	positiveInteger as positive,
	asRecord as record,
	nonNegativeInteger as timestamp,
} from "@/lib/payloadGuards";

import {
	createOrchestrationRequest,
	isOrchestrationResponse,
} from "../../../cli/lib/contracts/orchestration-envelope.mjs";

export type {
	DispatchContextReceiptV1,
	DureOrchestrationTransport,
	OpenInteractionReceiptV1,
	OrchestrationEventV1,
	OrchestrationSessionGenerationV1,
} from "@/lib/ipc/dureOrchestrationContract";

export {
	MAX_DISPATCH_CONTEXT_BATCH_ITEMS,
	MAX_READ_EVENTS_BATCH_ITEMS,
} from "@/lib/ipc/dureOrchestrationContract";

const MAX_REFERENCE_BYTES = 256;
const MAX_MARKDOWN_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const READ_EVENTS_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const encoder = new TextEncoder();
const SESSION_FIELDS = [
	"sessionId",
	"workspaceId",
	"providerId",
	"runnerPrincipal",
	"runnerInstance",
	"channelEpoch",
	"hostInstanceId",
	"terminalEpoch",
] as const satisfies readonly (keyof OrchestrationSessionGenerationV1)[];

export class DureOrchestrationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly failure: DureRequestFailureV1,
	) {
		super(message);
		this.name = "DureOrchestrationError";
	}
}

function bytes(value: string): number {
	return encoder.encode(value).length;
}

function reference(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		bytes(value) === 0 ||
		bytes(value) > MAX_REFERENCE_BYTES
	) {
		return false;
	}
	return !Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

function contextDispatchState(
	value: unknown,
): value is DispatchContextReceiptV1["dispatchState"] {
	return value === "active" || value === "blocked" || value === "completed";
}

function boundedText(
	value: unknown,
	maximum: number,
	allowEmpty: boolean,
	allowLayout = false,
): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		bytes(value) <= maximum &&
		!value.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				(code < 32 || code === 127) &&
				!(
					allowLayout &&
					(character === "\n" || character === "\r" || character === "\t")
				)
			);
		})
	);
}

function uniqueReferences(
	value: unknown,
	maximum: number,
): string[] | undefined {
	if (
		!Array.isArray(value) ||
		value.length > maximum ||
		!value.every(reference)
	) {
		return undefined;
	}
	return new Set(value).size === value.length ? value : undefined;
}

function authority(
	value: unknown,
): InteractionTargetProjection["authority"] | undefined {
	const candidate = record(value);
	if (!candidate || !reference(candidate.workspaceId)) return undefined;
	if (candidate.tenantRef !== undefined && !reference(candidate.tenantRef)) {
		return undefined;
	}
	return {
		workspaceId: candidate.workspaceId,
		...(typeof candidate.tenantRef === "string"
			? { tenantRef: candidate.tenantRef }
			: {}),
	};
}

function target(value: unknown): InteractionTargetProjection | undefined {
	const candidate = record(value);
	const parsedAuthority = authority(candidate?.authority);
	return candidate &&
		parsedAuthority &&
		reference(candidate.runId) &&
		reference(candidate.taskId) &&
		reference(candidate.dispatchId) &&
		positive(candidate.generation)
		? {
				authority: parsedAuthority,
				runId: candidate.runId,
				taskId: candidate.taskId,
				dispatchId: candidate.dispatchId,
				generation: candidate.generation,
			}
		: undefined;
}

function audienceGrant(
	value: unknown,
): InteractionAudienceGrantAccessV1 | undefined {
	const candidate = record(value);
	const roles = uniqueReferences(candidate?.roles, 16);
	const capabilities = uniqueReferences(candidate?.capabilities, 16);
	if (
		!candidate ||
		!reference(candidate.membershipRef) ||
		!reference(candidate.participant) ||
		!roles ||
		!capabilities ||
		!reference(candidate.deliveryCapability) ||
		!capabilities.includes(candidate.deliveryCapability)
	) {
		return undefined;
	}
	return {
		membershipRef: candidate.membershipRef,
		participant: candidate.participant,
		roles,
		capabilities,
		deliveryCapability: candidate.deliveryCapability,
	};
}

function responseSpec(value: unknown): DecisionResponseProjection | undefined {
	const candidate = record(value);
	if (
		candidate?.kind === "text" &&
		Number.isSafeInteger(candidate.minBytes) &&
		Number(candidate.minBytes) >= 0 &&
		positive(candidate.maxBytes) &&
		Number(candidate.minBytes) <= Number(candidate.maxBytes) &&
		Number(candidate.maxBytes) <= MAX_TEXT_BYTES
	) {
		return {
			kind: "text",
			minBytes: Number(candidate.minBytes),
			maxBytes: Number(candidate.maxBytes),
		};
	}
	if (
		candidate?.kind !== "select" ||
		!Array.isArray(candidate.options) ||
		candidate.options.length === 0 ||
		candidate.options.length > 64 ||
		!Number.isSafeInteger(candidate.minSelections) ||
		Number(candidate.minSelections) < 0 ||
		!positive(candidate.maxSelections) ||
		Number(candidate.minSelections) > Number(candidate.maxSelections) ||
		Number(candidate.maxSelections) > candidate.options.length
	) {
		return undefined;
	}
	const ids = new Set<string>();
	const options = candidate.options.flatMap((option) => {
		const entry = record(option);
		if (
			!entry ||
			!reference(entry.id) ||
			ids.has(entry.id) ||
			!boundedText(entry.label, 512, false) ||
			(entry.descriptionMarkdown !== undefined &&
				!boundedText(entry.descriptionMarkdown, MAX_MARKDOWN_BYTES, true, true))
		) {
			return [];
		}
		ids.add(entry.id);
		return [
			{
				id: entry.id,
				label: entry.label,
				...(typeof entry.descriptionMarkdown === "string"
					? { descriptionMarkdown: entry.descriptionMarkdown }
					: {}),
			},
		];
	});
	return options.length === candidate.options.length
		? {
				kind: "select",
				options,
				minSelections: Number(candidate.minSelections),
				maxSelections: Number(candidate.maxSelections),
			}
		: undefined;
}

function answer(value: unknown): DecisionAnswerProjection | undefined {
	const candidate = record(value);
	if (
		candidate?.kind === "text" &&
		boundedText(candidate.value, MAX_TEXT_BYTES, true, true)
	) {
		return { kind: "text", value: candidate.value };
	}
	const optionIds =
		candidate?.kind === "select"
			? uniqueReferences(candidate.optionIds, 64)
			: undefined;
	return optionIds ? { kind: "select", optionIds } : undefined;
}

function answerMatchesResponse(
	parsedAnswer: DecisionAnswerProjection,
	response: DecisionResponseProjection,
): boolean {
	if (parsedAnswer.kind !== response.kind) return false;
	if (parsedAnswer.kind === "text" && response.kind === "text") {
		const length = bytes(parsedAnswer.value);
		return length >= response.minBytes && length <= response.maxBytes;
	}
	if (parsedAnswer.kind === "select" && response.kind === "select") {
		const optionIds = new Set(response.options.map((option) => option.id));
		return (
			parsedAnswer.optionIds.length >= response.minSelections &&
			parsedAnswer.optionIds.length <= response.maxSelections &&
			parsedAnswer.optionIds.every((optionId) => optionIds.has(optionId))
		);
	}
	return false;
}

function interactionRecord(
	value: unknown,
	participant?: string,
): InteractionRecordReceiptV1 | undefined {
	const candidate = record(value);
	const common = record(candidate?.common);
	const parsedTarget = target(common?.target);
	if (
		!candidate ||
		!common ||
		!parsedTarget ||
		!reference(common.id) ||
		!reference(common.author) ||
		!positive(common.revision) ||
		!timestamp(common.createdAtMs) ||
		!boundedText(common.title, 512, false) ||
		!boundedText(common.descriptionMarkdown, MAX_MARKDOWN_BYTES, true, true)
	) {
		return undefined;
	}
	const rawAudience = record(common.audience)?.grants;
	if (
		!Array.isArray(rawAudience) ||
		rawAudience.length === 0 ||
		rawAudience.length > 64
	) {
		return undefined;
	}
	const grants = rawAudience.flatMap((grant) => {
		const parsed = audienceGrant(grant);
		return parsed
			? [
					{
						membershipRef: parsed.membershipRef,
						participant: parsed.participant,
						roles: parsed.roles,
					},
				]
			: [];
	});
	if (grants.length !== rawAudience.length) return undefined;
	const projectedGrants = participant
		? grants.filter((grant) => grant.participant === participant)
		: grants;
	if (projectedGrants.length === 0) return undefined;
	const parsedCommon = {
		id: common.id,
		target: parsedTarget,
		revision: common.revision,
		title: common.title,
		descriptionMarkdown: common.descriptionMarkdown,
		author: common.author,
		audience: { grants: projectedGrants },
		createdAtMs: common.createdAtMs,
	};
	if (
		candidate.kind === "message" &&
		(candidate.purpose === "update" ||
			candidate.purpose === "completion_report")
	) {
		return {
			interaction: {
				kind: "message",
				common: parsedCommon,
				purpose: candidate.purpose,
			},
		};
	}
	const parsedResponse = responseSpec(candidate.response);
	const state = record(candidate.state);
	if (
		candidate.kind !== "decision" ||
		!parsedResponse ||
		!reference(candidate.replyCapability) ||
		!state ||
		(state.state !== "open" && state.state !== "answered")
	) {
		return undefined;
	}
	let parsedAnswer: DecisionAnswerProjection | undefined;
	if (state.state === "answered") {
		const receipt = record(state.receipt);
		parsedAnswer = answer(receipt?.answer);
		if (
			!receipt ||
			!parsedAnswer ||
			!answerMatchesResponse(parsedAnswer, parsedResponse) ||
			!reference(receipt.answeredBy) ||
			!timestamp(receipt.answeredAtMs)
		) {
			return undefined;
		}
	} else if (state.receipt !== undefined) {
		return undefined;
	}
	return {
		interaction: {
			kind: "decision",
			common: parsedCommon,
			response: parsedResponse,
			state: state.state,
			...(parsedAnswer ? { answer: parsedAnswer } : {}),
		},
		replyCapability: candidate.replyCapability,
	};
}

function dispatchContext(
	value: unknown,
	_session: OrchestrationSessionGenerationV1,
): DispatchContextReceiptV1 | undefined {
	const candidate = record(value);
	const parsedTarget = target(candidate?.target);
	const dispatchState = candidate?.dispatchState ?? "active";
	const successorRequired = candidate?.successorRequired ?? false;
	const fence = record(candidate?.endpointFence);
	const grant = audienceGrant(candidate?.coordinatorGrant);
	const integration = integrationCapabilityReceipt(
		candidate?.integrationReceipt,
	);
	if (
		candidate?.schemaVersion !== 1 ||
		!parsedTarget ||
		!positive(candidate.dispatchRevision) ||
		!contextDispatchState(dispatchState) ||
		typeof successorRequired !== "boolean" ||
		(successorRequired && dispatchState !== "completed") ||
		!reference(candidate.participant) ||
		!reference(candidate.interactionCapability) ||
		!reference(candidate.completionCapability) ||
		!reference(candidate.deliveryCapability) ||
		!reference(candidate.acknowledgementCapability) ||
		!fence ||
		!reference(fence.endpointRef) ||
		!reference(fence.sessionIdentity) ||
		fence.generation !== parsedTarget.generation ||
		fence.deliveryCapability !== candidate.deliveryCapability ||
		fence.acknowledgementCapability !== candidate.acknowledgementCapability ||
		(candidate.wakeCapability !== undefined &&
			!reference(candidate.wakeCapability)) ||
		!grant ||
		!reference(candidate.coordinatorReplyCapability) ||
		!grant.capabilities.includes(candidate.coordinatorReplyCapability) ||
		!integration
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		target: parsedTarget,
		dispatchRevision: candidate.dispatchRevision,
		dispatchState,
		successorRequired,
		participant: candidate.participant,
		interactionCapability: candidate.interactionCapability,
		completionCapability: candidate.completionCapability,
		deliveryCapability: candidate.deliveryCapability,
		acknowledgementCapability: candidate.acknowledgementCapability,
		...(reference(candidate.wakeCapability)
			? { wakeCapability: candidate.wakeCapability }
			: {}),
		endpointFence: {
			endpointRef: fence.endpointRef,
			sessionIdentity: fence.sessionIdentity,
			generation: fence.generation,
			deliveryCapability: fence.deliveryCapability as string,
			acknowledgementCapability: fence.acknowledgementCapability as string,
		},
		coordinatorGrant: grant,
		coordinatorReplyCapability: candidate.coordinatorReplyCapability,
		integrationReceipt: {
			installRootRef: integration.installRootRef,
			version: integration.version,
			digest: integration.digest,
			channel: integration.channel,
			capabilities: integration.capabilities,
		},
	};
}

function exactSessionEcho(
	value: unknown,
	expected: OrchestrationSessionGenerationV1,
): boolean {
	const candidate = record(value);
	if (!candidate) return false;
	const keys = Object.keys(candidate);
	return (
		keys.length === SESSION_FIELDS.length &&
		keys.every((key) =>
			SESSION_FIELDS.includes(key as keyof OrchestrationSessionGenerationV1),
		) &&
		SESSION_FIELDS.every((field) => candidate[field] === expected[field])
	);
}

function exactExpectedDispatchEcho(
	value: unknown,
	expected: DispatchContextCandidateV1["expectedDispatch"],
): boolean {
	if (!expected) return value === undefined;
	const candidate = record(value);
	return Boolean(
		candidate &&
			Object.keys(candidate).length === 3 &&
			isDureDomainIdV1(candidate.taskId) &&
			candidate.taskId === expected.taskId &&
			isDureDomainIdV1(candidate.dispatchId) &&
			candidate.dispatchId === expected.dispatchId &&
			positive(candidate.generation) &&
			candidate.generation === expected.generation,
	);
}

function exactDispatchContextCandidateEcho(
	value: unknown,
	expected: DispatchContextCandidateV1,
): boolean {
	const candidate = record(value);
	const expectedKeyCount = expected.expectedDispatch ? 3 : 2;
	return Boolean(
		candidate &&
			Object.keys(candidate).length === expectedKeyCount &&
			isDureDomainIdV1(candidate.agentId) &&
			candidate.agentId === expected.agentId &&
			exactSessionEcho(candidate.session, expected.session) &&
			exactExpectedDispatchEcho(
				candidate.expectedDispatch,
				expected.expectedDispatch,
			),
	);
}

function operationDisposition(
	value: unknown,
): "unassigned" | "stale_generation" | "retry_same" | "terminal" | undefined {
	return value === "unassigned" ||
		value === "stale_generation" ||
		value === "retry_same" ||
		value === "terminal"
		? value
		: undefined;
}

function operationError(value: unknown):
	| {
			code: string;
			message: string;
			failure: Extract<DureRequestFailureV1, { kind: "operation" }>;
	  }
	| undefined {
	const candidate = record(value);
	const details = record(candidate?.details);
	const disposition = operationDisposition(details?.disposition);
	return candidate &&
		reference(candidate.code) &&
		boundedText(candidate.message, MAX_TEXT_BYTES, false, true) &&
		disposition
		? {
				code: candidate.code,
				message: candidate.message,
				failure: { kind: "operation", disposition },
			}
		: undefined;
}

function dispatchContextBatch(
	value: unknown,
	candidates: readonly DispatchContextCandidateV1[],
): DispatchContextBatchReceiptV1 | undefined {
	const candidate = record(value);
	if (
		candidate?.schemaVersion !== 1 ||
		!Array.isArray(candidate.results) ||
		candidate.results.length !== candidates.length
	) {
		return undefined;
	}
	const results: DispatchContextBatchReceiptV1["results"] = [];
	for (const [index, rawResult] of candidate.results.entries()) {
		const expectedCandidate = candidates[index];
		const result = record(rawResult);
		if (
			!expectedCandidate ||
			!result ||
			!exactDispatchContextCandidateEcho(
				result.candidate,
				expectedCandidate,
			)
		) {
			return undefined;
		}
		if (result.outcome === "found") {
			const context = dispatchContext(
				result.context,
				expectedCandidate.session,
			);
			if (!context || result.error !== undefined) return undefined;
			results.push({
				outcome: "found",
				candidate: expectedCandidate,
				context,
			});
			continue;
		}
		const error = operationError(result.error);
		if (
			result.outcome !== "failed" ||
			result.context !== undefined ||
			!error
		) {
			return undefined;
		}
		results.push({
			outcome: "failed",
			candidate: expectedCandidate,
			...error,
		});
	}
	return { schemaVersion: 1, results };
}

function integrationCapabilityReceipt(
	value: unknown,
): IntegrationCapabilityReceiptV1 | undefined {
	const candidate = record(value);
	const capabilities = uniqueReferences(candidate?.capabilities, 16);
	return candidate &&
		reference(candidate.installRootRef) &&
		reference(candidate.version) &&
		reference(candidate.channel) &&
		typeof candidate.digest === "string" &&
		/^[0-9a-f]{64}$/u.test(candidate.digest) &&
		capabilities?.includes("event_cursor_v1") &&
		capabilities.includes("idempotent_delivery_receipt_v1")
		? {
				installRootRef: candidate.installRootRef,
				version: candidate.version,
				digest: candidate.digest,
				channel: candidate.channel,
				capabilities,
			}
		: undefined;
}

function eventKind(value: unknown): OrchestrationEventKindV1 | undefined {
	const candidate = record(value);
	if (
		candidate?.kind === "run_created" &&
		reference(candidate.workflowKindRef)
	) {
		return { kind: candidate.kind, workflowKindRef: candidate.workflowKindRef };
	}
	if (
		candidate?.kind === "interaction_opened" &&
		reference(candidate.interactionId)
	) {
		return { kind: candidate.kind, interactionId: candidate.interactionId };
	}
	if (
		(candidate?.kind === "dispatch_blocked" ||
			candidate?.kind === "decision_answered" ||
			candidate?.kind === "dispatch_unblocked") &&
		reference(candidate.decisionId)
	) {
		return { kind: candidate.kind, decisionId: candidate.decisionId };
	}
	if (
		candidate?.kind === "dispatch_completed" &&
		reference(candidate.messageId)
	) {
		return { kind: candidate.kind, messageId: candidate.messageId };
	}
	return undefined;
}

function orchestrationEvent(value: unknown): OrchestrationEventV1 | undefined {
	const candidate = record(value);
	const parsedTarget = target(candidate?.target);
	const kind = eventKind(candidate?.kind);
	return candidate &&
		positive(candidate.cursor) &&
		parsedTarget &&
		reference(candidate.actor) &&
		kind &&
		timestamp(candidate.recordedAtMs)
		? {
				cursor: candidate.cursor,
				target: parsedTarget,
				actor: candidate.actor,
				kind,
				recordedAtMs: candidate.recordedAtMs,
			}
		: undefined;
}

function delivery(value: unknown): DeliveryReceiptV1 | undefined {
	const candidate = record(value);
	const endpoint =
		candidate?.endpoint === undefined ? undefined : record(candidate.endpoint);
	const wake =
		candidate?.wake === undefined ? undefined : record(candidate.wake);
	const wakeState = wake?.state;
	const wakeShapeIsValid =
		wake === undefined ||
		((wakeState === "pending" || wakeState === "uncertain") &&
			wake.effectRef === undefined &&
			wake.reasonCode === undefined) ||
		(wakeState === "triggered" &&
			reference(wake.effectRef) &&
			wake.reasonCode === undefined) ||
		(wakeState === "queued_until_next_turn" &&
			wake.effectRef === undefined &&
			reference(wake.reasonCode));
	if (
		!candidate ||
		!reference(candidate.receiptId) ||
		!positive(candidate.eventCursor) ||
		!reference(candidate.participant) ||
		!(
			candidate.state === "queued" ||
			candidate.state === "observed" ||
			candidate.state === "acknowledged"
		) ||
		(candidate.endpoint !== undefined &&
			(!endpoint ||
				!reference(endpoint.endpointRef) ||
				!reference(endpoint.sessionIdentity) ||
				!positive(endpoint.generation))) ||
		(candidate.wake !== undefined &&
			(!endpoint || !wake || !wakeShapeIsValid || !timestamp(wake.updatedAtMs)))
	) {
		return undefined;
	}
	return {
		receiptId: candidate.receiptId,
		eventCursor: candidate.eventCursor,
		participant: candidate.participant,
		state: candidate.state,
		...(endpoint
			? {
					endpoint: {
						endpointRef: endpoint.endpointRef as string,
						sessionIdentity: endpoint.sessionIdentity as string,
						generation: endpoint.generation as number,
					},
				}
			: {}),
		...(wake
			? {
					wake: {
						state: wake.state as NonNullable<
							DeliveryReceiptV1["wake"]
						>["state"],
						...(reference(wake.effectRef) ? { effectRef: wake.effectRef } : {}),
						...(reference(wake.reasonCode)
							? { reasonCode: wake.reasonCode }
							: {}),
						updatedAtMs: wake.updatedAtMs as number,
					},
				}
			: {}),
	};
}

function eventList(value: unknown): OrchestrationEventV1[] | undefined {
	if (!Array.isArray(value) || value.length > 128) return undefined;
	const events = value.flatMap((entry) => {
		const parsed = orchestrationEvent(entry);
		return parsed ? [parsed] : [];
	});
	return events.length === value.length &&
		events.every(
			(event, index) =>
				index === 0 || (events[index - 1]?.cursor ?? 0) < event.cursor,
		)
		? events
		: undefined;
}

function deliveryList(value: unknown): DeliveryReceiptV1[] | undefined {
	if (!Array.isArray(value) || value.length > 256) return undefined;
	const deliveries = value.flatMap((entry) => {
		const parsed = delivery(entry);
		return parsed ? [parsed] : [];
	});
	return deliveries.length === value.length ? deliveries : undefined;
}

function createRunReceipt(
	value: unknown,
	request: EnrollManagedSessionRequestV1,
): CreateRunReceiptV1 | undefined {
	const candidate = record(value);
	const context = dispatchContext(candidate?.context, request.session);
	const event = orchestrationEvent(candidate?.event);
	const deliveries = deliveryList(candidate?.deliveries);
	if (
		!candidate ||
		!context ||
		context.integrationReceipt.installRootRef !==
			request.integrationReceipt.installRootRef ||
		context.integrationReceipt.version !== request.integrationReceipt.version ||
		context.integrationReceipt.digest !== request.integrationReceipt.digest ||
		context.integrationReceipt.channel !== request.integrationReceipt.channel ||
		context.integrationReceipt.capabilities.join("\0") !==
			request.integrationReceipt.capabilities.join("\0") ||
		!event ||
		event.kind.kind !== "run_created" ||
		event.kind.workflowKindRef !== "workflow.existing-session-reporting" ||
		!sameTarget(event.target, context.target) ||
		event.actor !== context.coordinatorGrant.participant ||
		!deliveries ||
		deliveries.length < 2 ||
		new Set(deliveries.map((delivery) => delivery.receiptId)).size !==
			deliveries.length ||
		!deliveries.every((delivery) => delivery.eventCursor === event.cursor) ||
		!deliveries.some(
			(delivery) =>
				delivery.participant === context.coordinatorGrant.participant &&
				delivery.endpoint === undefined,
		) ||
		!deliveries.some(
			(delivery) =>
				delivery.participant === context.participant &&
				endpointMatchesFence(delivery, context.endpointFence),
		) ||
		typeof candidate.idempotent !== "boolean"
	) {
		return undefined;
	}
	return {
		context,
		event,
		deliveries,
		idempotent: candidate.idempotent,
	};
}

function endpointMatchesFence(
	delivery: DeliveryReceiptV1,
	fence: WorkerEndpointFenceV1,
): boolean {
	return (
		delivery.endpoint?.endpointRef === fence.endpointRef &&
		delivery.endpoint.sessionIdentity === fence.sessionIdentity &&
		delivery.endpoint.generation === fence.generation
	);
}

function acknowledgementReceipt(
	value: unknown,
	request: ReadEventsRequestV1,
): EventAcknowledgementReceiptV1 | undefined {
	const candidate = record(value);
	const parsedDelivery = delivery(candidate?.delivery);
	return candidate &&
		request.acknowledgement &&
		positive(candidate.through) &&
		candidate.through === request.acknowledgement.through &&
		parsedDelivery?.eventCursor === candidate.through &&
		parsedDelivery.participant === request.participant &&
		parsedDelivery.state === "acknowledged" &&
		(!request.endpointFence ||
			endpointMatchesFence(parsedDelivery, request.endpointFence)) &&
		typeof candidate.idempotent === "boolean"
		? {
				through: candidate.through,
				delivery: parsedDelivery,
				idempotent: candidate.idempotent,
			}
		: undefined;
}

function readEventsReceipt(
	value: unknown,
	request: ReadEventsRequestV1,
): ReadEventsReceiptV1 | undefined {
	const candidate = record(value);
	const events = eventList(candidate?.events);
	const deliveries = deliveryList(candidate?.deliveries);
	const parsedAcknowledgement =
		candidate?.acknowledgement === undefined
			? undefined
			: acknowledgementReceipt(candidate.acknowledgement, request);
	const endpointFence = request.endpointFence;
	if (!candidate || !events || !deliveries || !timestamp(candidate.nextCursor))
		return undefined;
	const deliveryByCursor = new Map(
		deliveries.map((receipt) => [receipt.eventCursor, receipt]),
	);
	if (
		(request.target &&
			!sameAuthority(request.target.authority, request.authority)) ||
		events.some(
			(event) =>
				event.cursor <= request.after ||
				!sameAuthority(event.target.authority, request.authority) ||
				(request.target !== undefined &&
					!sameTarget(event.target, request.target)) ||
				deliveryByCursor.get(event.cursor)?.participant !== request.participant,
		) ||
		(endpointFence &&
			deliveries.some(
				(delivery) => !endpointMatchesFence(delivery, endpointFence),
			)) ||
		deliveryByCursor.size !== deliveries.length ||
		deliveries.length !== events.length ||
		candidate.nextCursor !==
			(events[events.length - 1]?.cursor ?? request.after) ||
		(request.acknowledgement
			? !parsedAcknowledgement
			: candidate.acknowledgement !== undefined)
	) {
		return undefined;
	}
	return {
		events,
		deliveries,
		nextCursor: candidate.nextCursor,
		...(parsedAcknowledgement
			? { acknowledgement: parsedAcknowledgement }
			: {}),
	};
}

function readEventsBatchReceipt(
	value: unknown,
	request: ReadEventsBatchRequestV1,
): ReadEventsBatchReceiptV1 | undefined {
	const candidate = record(value);
	const parsedAuthority = authority(candidate?.authority);
	if (
		candidate?.schemaVersion !== 1 ||
		!parsedAuthority ||
		!sameAuthority(parsedAuthority, request.authority) ||
		!Array.isArray(candidate.results) ||
		candidate.results.length !== request.requests.length
	) {
		return undefined;
	}
	const results: ReadEventsBatchReceiptV1["results"] = [];
	for (const [index, rawResult] of candidate.results.entries()) {
		const expected = request.requests[index];
		const result = record(rawResult);
		if (!expected || !result || result.correlationId !== expected.correlationId) {
			return undefined;
		}
		if (result.outcome === "read") {
			const receipt = readEventsReceipt(result.receipt, expected.request);
			if (!receipt || result.error !== undefined) return undefined;
			results.push({
				outcome: "read",
				correlationId: expected.correlationId,
				receipt,
			});
			continue;
		}
		const error = operationError(result.error);
		if (
			result.outcome !== "failed" ||
			result.receipt !== undefined ||
			!error
		) {
			return undefined;
		}
		results.push({
			outcome: "failed",
			correlationId: expected.correlationId,
			...error,
		});
	}
	return { schemaVersion: 1, authority: parsedAuthority, results };
}

function readEventsRouteBatchReceipt(
	value: unknown,
	request: ReadEventsRouteBatchRequestV1,
): ReadEventsRouteBatchReceiptV1 | undefined {
	const candidate = record(value);
	if (
		candidate?.schemaVersion !== 1 ||
		!Array.isArray(candidate.results) ||
		candidate.results.length !== request.batches.length
	) {
		return undefined;
	}
	const results: ReadEventsRouteBatchReceiptV1["results"] = [];
	for (const [index, rawResult] of candidate.results.entries()) {
		const expected = request.batches[index];
		const result = record(rawResult);
		if (!expected || !result || result.correlationId !== expected.correlationId) {
			return undefined;
		}
		if (result.outcome === "read") {
			const receipt = readEventsBatchReceipt(result.receipt, expected.request);
			if (!receipt || result.error !== undefined) return undefined;
			results.push({
				outcome: "read",
				correlationId: expected.correlationId,
				receipt,
			});
			continue;
		}
		const parsedAuthority = authority(result.authority);
		const error = operationError(result.error);
		if (
			result.outcome !== "failed" ||
			result.receipt !== undefined ||
			!parsedAuthority ||
			!sameAuthority(parsedAuthority, expected.request.authority) ||
			!error
		) {
			return undefined;
		}
		results.push({
			outcome: "failed",
			correlationId: expected.correlationId,
			authority: parsedAuthority,
			...error,
		});
	}
	return { schemaVersion: 1, results };
}

function sameAuthority(
	left: InteractionTargetProjection["authority"],
	right: InteractionTargetProjection["authority"],
): boolean {
	return (
		left.workspaceId === right.workspaceId && left.tenantRef === right.tenantRef
	);
}

function sameTarget(
	left: InteractionTargetProjection,
	right: InteractionTargetProjection,
): boolean {
	return (
		sameAuthority(left.authority, right.authority) &&
		left.runId === right.runId &&
		left.taskId === right.taskId &&
		left.dispatchId === right.dispatchId &&
		left.generation === right.generation
	);
}

function validReadEventsBatchRequest(request: ReadEventsBatchRequestV1): boolean {
	return (
		request.requests.length > 0 &&
		request.requests.length <= MAX_READ_EVENTS_BATCH_ITEMS &&
		new Set(request.requests.map((item) => item.correlationId)).size ===
			request.requests.length &&
		request.requests.every(
			(item) =>
				READ_EVENTS_CORRELATION_ID.test(item.correlationId) &&
				sameAuthority(item.request.authority, request.authority) &&
				(item.request.target === undefined ||
					sameAuthority(item.request.target.authority, request.authority)),
		)
	);
}

function validReadEventsRouteBatchRequest(
	request: ReadEventsRouteBatchRequestV1,
): boolean {
	if (
		request.batches.length === 0 ||
		request.batches.length > MAX_READ_EVENTS_BATCH_ITEMS
	) {
		return false;
	}
	const correlations = new Set<string>();
	const leafCorrelations = new Set<string>();
	const authorities: ReadEventsBatchRequestV1["authority"][] = [];
	let leafCount = 0;
	for (const batch of request.batches) {
		if (
			!READ_EVENTS_CORRELATION_ID.test(batch.correlationId) ||
			correlations.has(batch.correlationId) ||
			!validReadEventsBatchRequest(batch.request) ||
			authorities.some((candidate) =>
				sameAuthority(candidate, batch.request.authority),
			)
		) {
			return false;
		}
		correlations.add(batch.correlationId);
		authorities.push(batch.request.authority);
		leafCount += batch.request.requests.length;
		for (const item of batch.request.requests) {
			if (leafCorrelations.has(item.correlationId)) return false;
			leafCorrelations.add(item.correlationId);
		}
	}
	return leafCount <= MAX_READ_EVENTS_BATCH_ITEMS;
}

function wireReadEventsBatchRequest(request: ReadEventsBatchRequestV1) {
	return {
		schemaVersion: 1,
		authority: request.authority,
		requests: request.requests.map((item) => ({
			correlationId: item.correlationId,
			request: { schemaVersion: 1, ...item.request },
		})),
	};
}

function sameAnswer(
	left: DecisionAnswerProjection | undefined,
	right: DecisionAnswerProjection,
): boolean {
	if (!left || left.kind !== right.kind) return false;
	if (left.kind === "text" && right.kind === "text") {
		return left.value === right.value;
	}
	return left.kind === "select" && right.kind === "select"
		? [...left.optionIds].sort().join("\0") ===
				[...right.optionIds].sort().join("\0")
		: false;
}

function isAnswerEventPair(
	events: OrchestrationEventV1[],
	request: AnswerExactSessionDecisionRequestV1,
	target: InteractionTargetProjection,
	answeredBy: string,
): boolean {
	const [answered, unblocked] = events;
	return Boolean(
		answered &&
			unblocked &&
			answered.kind.kind === "decision_answered" &&
			answered.kind.decisionId === request.interactionId &&
			answered.actor === answeredBy &&
			answered.recordedAtMs === request.answeredAtMs &&
			unblocked.kind.kind === "dispatch_unblocked" &&
			unblocked.kind.decisionId === request.interactionId &&
			unblocked.actor === answeredBy &&
			unblocked.recordedAtMs === request.answeredAtMs &&
			events.every((event) => sameTarget(event.target, target)),
	);
}

function answerReceipt(
	value: unknown,
	request: AnswerExactSessionDecisionRequestV1,
): AnswerDecisionReceiptV1 | undefined {
	const candidate = record(value);
	const parsed = interactionRecord(candidate?.interaction);
	const events = eventList(candidate?.events);
	const deliveries = deliveryList(candidate?.deliveries);
	const interaction = parsed?.interaction;
	const rawState = record(record(candidate?.interaction)?.state);
	const rawAnswerReceipt = record(rawState?.receipt);
	const answeredBy = rawAnswerReceipt?.answeredBy;
	if (
		!candidate ||
		!parsed ||
		interaction?.kind !== "decision" ||
		parsed.replyCapability !== request.expectedReplyCapability ||
		interaction.common.id !== request.interactionId ||
		interaction.common.revision !== request.expectedRevision + 1 ||
		interaction.state !== "answered" ||
		!sameAnswer(interaction.answer, request.answer) ||
		!reference(answeredBy) ||
		!interaction.common.audience.grants.some(
			(grant) => grant.participant === answeredBy,
		) ||
		rawAnswerReceipt?.answeredAtMs !== request.answeredAtMs ||
		candidate.dispatchState !== "active" ||
		!events ||
		events.length !== 2 ||
		!isAnswerEventPair(
			events,
			request,
			interaction.common.target,
			answeredBy,
		) ||
		!deliveries ||
		typeof candidate.idempotent !== "boolean"
	) {
		return undefined;
	}
	const eventCursors = new Set(events.map((event) => event.cursor));
	const answeredCursor = events[0]?.cursor;
	if (
		!answeredCursor ||
		!deliveries.some(
			(delivery) =>
				delivery.eventCursor === answeredCursor &&
				delivery.participant === answeredBy,
		) ||
		!deliveries.every((delivery) => eventCursors.has(delivery.eventCursor))
	) {
		return undefined;
	}
	return {
		interaction,
		dispatchState: "active",
		events,
		deliveries,
		idempotent: candidate.idempotent,
	};
}

function exactSessionMessageReceipt(
	value: unknown,
	request: OpenExactSessionMessageRequestV1,
): OpenInteractionReceiptV1 | undefined {
	const candidate = record(value);
	const parsed = interactionRecord(candidate?.interaction);
	const interaction = parsed?.interaction;
	const events = eventList(candidate?.events);
	const deliveries = deliveryList(candidate?.deliveries);
	const [event] = events ?? [];
	const [delivery] = deliveries ?? [];
	const [grant] = interaction?.common.audience.grants ?? [];
	if (
		!candidate ||
		interaction?.kind !== "message" ||
		interaction.purpose !== "update" ||
		interaction.common.id !== request.interactionId ||
		interaction.common.revision !== 1 ||
		interaction.common.title !== request.title ||
		interaction.common.descriptionMarkdown !== request.descriptionMarkdown ||
		interaction.common.createdAtMs !== request.openedAtMs ||
		!grant ||
		interaction.common.audience.grants.length !== 1 ||
		candidate.dispatchState !== "active" ||
		!event ||
		events?.length !== 1 ||
		event.kind.kind !== "interaction_opened" ||
		event.kind.interactionId !== request.interactionId ||
		event.actor !== interaction.common.author ||
		event.recordedAtMs !== request.openedAtMs ||
		!sameTarget(event.target, interaction.common.target) ||
		!delivery ||
		deliveries?.length !== 1 ||
		delivery.eventCursor !== event.cursor ||
		delivery.participant !== grant.participant ||
		delivery.endpoint?.endpointRef !== request.expectedEndpointRef ||
		delivery.endpoint.generation !== interaction.common.target.generation ||
		typeof candidate.idempotent !== "boolean"
	) {
		return undefined;
	}
	return {
		interaction,
		dispatchState: "active",
		events,
		deliveries,
		idempotent: candidate.idempotent,
	};
}

function orchestrationError(error: unknown): DureOrchestrationError {
	if (error instanceof DureBackendRequestError) {
		return new DureOrchestrationError(error.code, error.message, error.failure);
	}
	return new DureOrchestrationError(
		"orchestration_transport_failed",
		error instanceof Error && error.message
			? error.message
			: t("ipc.dureOrchestration.requestFailed"),
		{ kind: "transport" },
	);
}

export function createDureOrchestrationTransport(options?: {
	profileId?: string;
	invokeCommand?: DureBackendInvoke;
}): DureOrchestrationTransport {
	const backendRequest = createDureBackendRequester({
		profileId: options?.profileId ?? "local",
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "orchestration_response_invalid",
		invalidResponseMessage: t("ipc.dureOrchestration.invalidResponse"),
		backendChangedCode: "orchestration_backend_changed",
		backendChangedMessage: t(
			"ipc.dureOrchestration.authorityGenerationChanged",
		),
		requestFailedCode: "orchestration_transport_failed",
		requestFailedMessage: t("ipc.dureOrchestration.requestFailed"),
	});
	const request = async <T>(
		method: string,
		body: Record<string, unknown>,
		parse: (value: unknown) => T | undefined,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<OrchestrationCall<T>> => {
		try {
			const response = await backendRequest(
				"orchestration.invoke",
				createOrchestrationRequest({ method, body }),
				{ kind: "exact", authority: routeAuthority },
			);
			if (!isOrchestrationResponse(response.result, method)) {
				throw new DureOrchestrationError(
					"orchestration_response_invalid",
					t("ipc.dureOrchestration.apiResponseMismatch"),
					{ kind: "contract" },
				);
			}
			const receipt = parse(response.result.receipt);
			if (!receipt) {
				throw new DureOrchestrationError(
					"orchestration_receipt_invalid",
					t("ipc.dureOrchestration.receiptContractMismatch"),
					{ kind: "contract" },
				);
			}
			return { backend: response.backend, receipt };
		} catch (error) {
			if (error instanceof DureOrchestrationError) throw error;
			throw orchestrationError(error);
		}
	};

	return {
		getDispatchContext: (routeAuthority, session) =>
			request(
				"dispatch.context.get",
				{ schemaVersion: 1, session },
				(value) => dispatchContext(value, session),
				routeAuthority,
			),
		getDispatchContexts: async (routeAuthority, candidates) => {
			if (
				candidates.length === 0 ||
				candidates.length > MAX_DISPATCH_CONTEXT_BATCH_ITEMS ||
				candidates.some(
					(candidate, index) =>
						!exactDispatchContextCandidateEcho(candidate, candidate) ||
						candidates
						.slice(0, index)
						.some((prior) =>
							exactDispatchContextCandidateEcho(prior, candidate),
						),
				)
			) {
				throw new DureOrchestrationError(
					"orchestration_request_invalid",
					t("ipc.dureOrchestration.requestFailed"),
					{ kind: "contract" },
				);
			}
			return request(
				"dispatch.context.get.batch",
				{ schemaVersion: 1, candidates },
				(value) => dispatchContextBatch(value, candidates),
				routeAuthority,
			);
		},
		enrollManagedSession: (routeAuthority, body) =>
			request(
				"run.create",
				{
					schemaVersion: 1,
					workflowKindRef: "workflow.existing-session-reporting",
					task: {
						summary: "Report the current managed session",
						instructions:
							"Publish durable Markdown Messages and Decisions through the orchestration service.",
					},
					session: body.session,
					integrationReceipt: body.integrationReceipt,
					runtimeRef: "runtime.hmux",
					targetReference: "orchestration.current-session",
					idempotencyKey: body.idempotencyKey,
					createdAtMs: body.createdAtMs,
				},
				(value) => createRunReceipt(value, body),
				routeAuthority,
			),
		getExactDispatchContext: (routeAuthority, session) =>
			request(
				"dispatch.context.get.exact-session",
				{ schemaVersion: 1, session },
				(value) => dispatchContext(value, session),
				routeAuthority,
			),
		openExactSessionMessage: (routeAuthority, body) =>
			request(
				"interaction.message.open.exact-session",
				{ ...body },
				(value) => exactSessionMessageReceipt(value, body),
				routeAuthority,
			),
		readEvents: (routeAuthority, body) =>
			request(
				"events.read",
				{
					schemaVersion: 1,
					...body,
				},
				(value) => readEventsReceipt(value, body),
				routeAuthority,
			),
		readEventsBatch: async (routeAuthority, body) => {
			if (!validReadEventsBatchRequest(body)) {
				throw new DureOrchestrationError(
					"orchestration_request_invalid",
					t("ipc.dureOrchestration.requestFailed"),
					{ kind: "contract" },
				);
			}
			return request(
				"events.read.batch",
				wireReadEventsBatchRequest(body),
				(value) => readEventsBatchReceipt(value, body),
				routeAuthority,
			);
		},
		readEventsRouteBatch: async (routeAuthority, body) => {
			if (!validReadEventsRouteBatchRequest(body)) {
				throw new DureOrchestrationError(
					"orchestration_request_invalid",
					t("ipc.dureOrchestration.requestFailed"),
					{ kind: "contract" },
				);
			}
			return request(
				"events.read.route.batch",
				{
					schemaVersion: 1,
					batches: body.batches.map((batch) => ({
						correlationId: batch.correlationId,
						request: wireReadEventsBatchRequest(batch.request),
					})),
				},
				(value) => readEventsRouteBatchReceipt(value, body),
				routeAuthority,
			);
		},
		getInteraction: (routeAuthority, body) =>
			request(
				"interaction.get",
				{ schemaVersion: 1, ...body },
				(value) => {
					const parsed = interactionRecord(value, body.participant);
					return parsed &&
						parsed.interaction.common.id === body.interactionId &&
						sameAuthority(
							parsed.interaction.common.target.authority,
							body.authority,
						)
						? parsed
						: undefined;
				},
				routeAuthority,
			),
		answerDecision: (routeAuthority, body) =>
			request(
				"interaction.decision.answer.exact-session",
				{ ...body },
				(value) => answerReceipt(value, body),
				routeAuthority,
			),
	};
}

export function eventInteractionId(
	event: OrchestrationEventV1,
): string | undefined {
	switch (event.kind.kind) {
		case "run_created":
			return undefined;
		case "interaction_opened":
			return event.kind.interactionId;
		case "dispatch_completed":
			return event.kind.messageId;
		default:
			return event.kind.decisionId;
	}
}
