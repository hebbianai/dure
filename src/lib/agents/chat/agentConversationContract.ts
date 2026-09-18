import {
	hasOnlyKeys,
	nonNegativeInteger,
	positiveInteger,
	asRecord as record,
} from "@/lib/payloadGuards";

const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_TOKEN_BYTES = 512;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_PAGE_ROWS = 128;
const MAX_LIVE_TEXT = 64;
const MAX_PENDING_REQUESTS = 32;
const encoder = new TextEncoder();

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

type AgentTimelineLifecycleStateV1 =
	| "session_ready"
	| "session_failed"
	| "session_exited"
	| "turn_started"
	| "turn_completed"
	| "turn_failed"
	| "turn_canceled";

type AgentTimelineToolStateV1 = "running" | "completed" | "failed" | "canceled";

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

interface AgentTimelineLiveTextV1 {
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

type AgentGoalStatusV1 = "active" | "paused" | "complete" | "failed";

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

export function parseAgentGoalRecordV1(
	value: unknown,
): AgentGoalRecordV1 | undefined {
	const goal = record(value);
	const activationCursor = parseAgentTimelineCursorV1(goal?.activationCursor);
	if (
		!goal ||
		!hasOnlyKeys(goal, [
			"schemaVersion",
			"agentId",
			"revision",
			"objective",
			"status",
			"detail",
			"activationCursor",
			"createdAtMs",
			"updatedAtMs",
		]) ||
		goal.schemaVersion !== 1 ||
		!domainId(goal.agentId) ||
		!positiveInteger(goal.revision) ||
		!boundedText(goal.objective, 16 * 1024, false) ||
		!goal.objective.trim() ||
		!["active", "paused", "complete", "failed"].includes(String(goal.status)) ||
		!(goal.detail === null || boundedText(goal.detail, 16 * 1024)) ||
		!activationCursor ||
		!nonNegativeInteger(goal.createdAtMs) ||
		!nonNegativeInteger(goal.updatedAtMs) ||
		goal.updatedAtMs < goal.createdAtMs
	)
		return undefined;
	return {
		schemaVersion: 1,
		agentId: goal.agentId,
		revision: goal.revision,
		objective: goal.objective,
		status: goal.status as AgentGoalStatusV1,
		detail: goal.detail,
		activationCursor,
		createdAtMs: goal.createdAtMs,
		updatedAtMs: goal.updatedAtMs,
	};
}

type AgentQueuedTurnStateV1 = "queued" | "dispatched" | "canceled";

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

export function sameAgentStartTurnIntent(
	a: AgentStartTurnIntentV1,
	b: AgentStartTurnIntentV1,
): boolean {
	return (
		a.schemaVersion === b.schemaVersion &&
		a.interactionSessionId === b.interactionSessionId &&
		a.runtime.runtimeGeneration === b.runtime.runtimeGeneration &&
		a.runtime.providerEpoch === b.runtime.providerEpoch &&
		a.clientMessageId === b.clientMessageId &&
		a.turnId === b.turnId &&
		a.input === b.input &&
		a.requestedAtMs === b.requestedAtMs
	);
}

export function parseAgentStartTurnIntentV1(
	value: unknown,
): AgentStartTurnIntentV1 | undefined {
	const intent = record(value);
	const runtime = parseAgentRuntimeFenceV1(intent?.runtime);
	if (
		!intent ||
		!hasOnlyKeys(intent, [
			"schemaVersion",
			"interactionSessionId",
			"runtime",
			"turnId",
			"clientMessageId",
			"input",
			"requestedAtMs",
		]) ||
		intent.schemaVersion !== 1 ||
		!domainId(intent.interactionSessionId) ||
		!domainId(intent.turnId) ||
		!domainId(intent.clientMessageId) ||
		!boundedText(intent.input, MAX_TEXT_BYTES, false) ||
		!nonNegativeInteger(intent.requestedAtMs) ||
		!runtime
	)
		return undefined;
	return {
		schemaVersion: 1,
		interactionSessionId: intent.interactionSessionId,
		runtime,
		turnId: intent.turnId,
		clientMessageId: intent.clientMessageId,
		input: intent.input,
		requestedAtMs: intent.requestedAtMs,
	};
}

export function parseAgentQueuedTurnRecordV1(
	value: unknown,
): AgentQueuedTurnRecordV1 | undefined {
	const candidate = record(value);
	const intent = parseAgentStartTurnIntentV1(candidate?.intent);
	const timelineCursor = parseAgentTimelineCursorV1(candidate?.timelineCursor);
	if (
		!candidate ||
		!hasOnlyKeys(candidate, ["intent", "state", "timelineCursor"]) ||
		!["queued", "dispatched", "canceled"].includes(String(candidate.state)) ||
		!intent ||
		!timelineCursor
	)
		return undefined;
	return {
		intent,
		state: candidate.state as AgentQueuedTurnStateV1,
		timelineCursor,
	};
}

export interface AgentTimelinePageV1 {
	binding: AgentInteractionBindingV1;
	rows: AgentTimelineRowV1[];
	liveText: AgentTimelineLiveTextV1[];
	pendingRequests: AgentPendingRequestV1[];
	activeTurn: AgentTimelineActiveTurnV1 | null;
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

export function parseAgentQueuedInputPageV1(
	value: unknown,
	interactionSessionId: string,
	afterSequence = 0,
): AgentQueuedInputPageV1 | undefined {
	const page = record(value);
	if (
		!page ||
		!hasOnlyKeys(page, ["interactionSessionId", "inputs", "nextAfter"]) ||
		page.interactionSessionId !== interactionSessionId ||
		!Array.isArray(page.inputs) ||
		page.inputs.length > 64
	)
		return undefined;
	const inputs: AgentQueuedInputV1[] = [];
	const seen = new Set<string>();
	let previous = afterSequence;
	for (const value of page.inputs) {
		const input = record(value);
		if (
			!input ||
			!hasOnlyKeys(input, ["clientMessageId", "sequence", "preview"]) ||
			!domainId(input.clientMessageId) ||
			seen.has(input.clientMessageId) ||
			!nonNegativeInteger(input.sequence) ||
			input.sequence <= previous ||
			!boundedText(input.preview, 2048, false)
		)
			return undefined;
		inputs.push({
			clientMessageId: input.clientMessageId,
			sequence: input.sequence,
			preview: input.preview,
		});
		seen.add(input.clientMessageId);
		previous = input.sequence;
	}
	if (
		page.nextAfter !== null &&
		(inputs.length !== 64 || page.nextAfter !== previous)
	)
		return undefined;
	return {
		interactionSessionId,
		inputs,
		nextAfter: page.nextAfter === null ? null : previous,
	};
}

export type AgentTimelineReadV1 =
	| { type: "page"; page: AgentTimelinePageV1 }
	| { type: "reset"; binding: AgentInteractionBindingV1; reason: string };

function boundedText(
	value: unknown,
	maximum = MAX_TEXT_BYTES,
	allowEmpty = true,
): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		encoder.encode(value).byteLength <= maximum
	);
}

function domainId(value: unknown): value is string {
	return typeof value === "string" && DOMAIN_ID.test(value);
}

/** Canonical durable credential identity shared by execution-profile boundaries. */
export function isAgentCredentialReferenceV1(value: unknown): value is string {
	return domainId(value);
}

function token(value: unknown): value is string {
	return (
		boundedText(value, MAX_TOKEN_BYTES, false) &&
		!Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	);
}

function nullableDomainId(value: unknown): value is string | null {
	return value === null || domainId(value);
}

function boundedJson(value: unknown): boolean {
	try {
		const source = JSON.stringify(value);
		return (
			source !== undefined &&
			encoder.encode(source).byteLength <= MAX_JSON_BYTES
		);
	} catch {
		return false;
	}
}

export function parseAgentRuntimeFenceV1(
	value: unknown,
): AgentProviderRuntimeFenceV1 | undefined {
	const candidate = record(value);
	return candidate &&
		token(candidate.runtimeGeneration) &&
		token(candidate.providerEpoch)
		? {
				runtimeGeneration: candidate.runtimeGeneration,
				providerEpoch: candidate.providerEpoch,
			}
		: undefined;
}

export function parseAgentExecutionProfileV1(
	value: unknown,
): AgentExecutionProfileV1 | undefined {
	const candidate = record(value);
	if (candidate?.kind === "provider_default") {
		return { kind: "provider_default" };
	}
	if (
		candidate?.kind === "credential_reference" &&
		isAgentCredentialReferenceV1(candidate.reference_id) &&
		(candidate.credential_generation === null ||
			token(candidate.credential_generation))
	) {
		return {
			kind: "credential_reference",
			reference_id: candidate.reference_id,
			credential_generation: candidate.credential_generation,
		};
	}
	return undefined;
}

export function sameAgentExecutionProfileV1(
	left: AgentExecutionProfileV1,
	right: AgentExecutionProfileV1,
): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "provider_default" ||
			(right.kind === "credential_reference" &&
				left.reference_id === right.reference_id &&
				left.credential_generation === right.credential_generation))
	);
}

export function parseAgentInteractionBindingV1(
	value: unknown,
): AgentInteractionBindingV1 | undefined {
	const candidate = record(value);
	const executionProfile = parseAgentExecutionProfileV1(
		candidate?.executionProfile,
	);
	const runtime = parseAgentRuntimeFenceV1(candidate?.runtime);
	if (
		candidate?.schemaVersion !== 1 ||
		!domainId(candidate.interactionSessionId) ||
		!domainId(candidate.agentId) ||
		!domainId(candidate.providerId) ||
		!executionProfile ||
		!(
			candidate.providerConversationRef === null ||
			token(candidate.providerConversationRef)
		) ||
		!runtime ||
		!domainId(candidate.timelineEpoch) ||
		!positiveInteger(candidate.bindingRevision) ||
		typeof candidate.historyComplete !== "boolean" ||
		!nonNegativeInteger(candidate.createdAtMs) ||
		!nonNegativeInteger(candidate.updatedAtMs) ||
		candidate.updatedAtMs < candidate.createdAtMs
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		interactionSessionId: candidate.interactionSessionId,
		agentId: candidate.agentId,
		providerId: candidate.providerId,
		executionProfile,
		providerConversationRef: candidate.providerConversationRef,
		runtime,
		timelineEpoch: candidate.timelineEpoch,
		bindingRevision: candidate.bindingRevision,
		historyComplete: candidate.historyComplete,
		createdAtMs: candidate.createdAtMs,
		updatedAtMs: candidate.updatedAtMs,
	};
}

export function parseAgentTimelineCursorV1(
	value: unknown,
): AgentTimelineCursorV1 | undefined {
	const candidate = record(value);
	return candidate &&
		hasOnlyKeys(candidate, ["epoch", "sequence"]) &&
		domainId(candidate.epoch) &&
		nonNegativeInteger(candidate.sequence)
		? { epoch: candidate.epoch, sequence: candidate.sequence }
		: undefined;
}

function parseTimelineBody(
	value: unknown,
): AgentTimelineItemBodyV1 | undefined {
	const candidate = record(value);
	if (!candidate || typeof candidate.type !== "string") return undefined;
	switch (candidate.type) {
		case "lifecycle":
			return hasOnlyKeys(candidate, ["type", "state", "detail"]) &&
				[
					"session_ready",
					"session_failed",
					"session_exited",
					"turn_started",
					"turn_completed",
					"turn_failed",
					"turn_canceled",
				].includes(String(candidate.state)) &&
				(candidate.detail === null || boundedText(candidate.detail))
				? {
						type: "lifecycle",
						state: candidate.state as AgentTimelineLifecycleStateV1,
						detail: candidate.detail,
					}
				: undefined;
		case "message":
			return hasOnlyKeys(candidate, ["type", "role", "markdown"]) &&
				(candidate.role === "user" || candidate.role === "assistant") &&
				boundedText(candidate.markdown)
				? {
						type: "message",
						role: candidate.role,
						markdown: candidate.markdown,
					}
				: undefined;
		case "goal_continuation":
			return hasOnlyKeys(candidate, ["type", "objective", "goal_revision"]) &&
				boundedText(candidate.objective) &&
				positiveInteger(candidate.goal_revision)
				? {
						type: "goal_continuation",
						objective: candidate.objective,
						goalRevision: candidate.goal_revision,
					}
				: undefined;
		case "queued_input":
			return hasOnlyKeys(candidate, ["type", "state"]) &&
				["queued", "dispatched", "canceled"].includes(String(candidate.state))
				? {
						type: "queued_input",
						state: candidate.state as AgentQueuedTurnStateV1,
					}
				: undefined;
		case "reasoning":
			return hasOnlyKeys(candidate, ["type", "text"]) &&
				boundedText(candidate.text)
				? { type: "reasoning", text: candidate.text }
				: undefined;
		case "pending_answer": {
			const pending = parsePending(candidate.request);
			return hasOnlyKeys(candidate, [
				"type",
				"idempotency_key",
				"request",
				"answer",
			]) &&
				token(candidate.idempotency_key) &&
				pending &&
				boundedJson(candidate.answer)
				? {
						type: "pending_answer",
						idempotencyKey: candidate.idempotency_key,
						request: pending,
						answer: candidate.answer,
					}
				: undefined;
		}
		case "tool": {
			const inputValid =
				candidate.input === null || boundedJson(candidate.input);
			const outputValid =
				candidate.output === null || boundedJson(candidate.output);
			return hasOnlyKeys(candidate, [
				"type",
				"tool_call_id",
				"name",
				"state",
				"input",
				"output",
			]) &&
				token(candidate.tool_call_id) &&
				boundedText(candidate.name, MAX_TOKEN_BYTES, false) &&
				["running", "completed", "failed", "canceled"].includes(
					String(candidate.state),
				) &&
				inputValid &&
				outputValid
				? {
						type: "tool",
						toolCallId: candidate.tool_call_id,
						name: candidate.name,
						state: candidate.state as AgentTimelineToolStateV1,
						input: candidate.input,
						output: candidate.output,
					}
				: undefined;
		}
		case "tool_input":
			return hasOnlyKeys(candidate, ["type", "json_text"]) &&
				boundedText(candidate.json_text)
				? { type: "tool_input", jsonText: candidate.json_text }
				: undefined;
		case "plan":
			return hasOnlyKeys(candidate, ["type", "value"]) &&
				boundedJson(candidate.value)
				? { type: "plan", value: candidate.value }
				: undefined;
		case "error":
			return hasOnlyKeys(candidate, ["type", "code", "message"]) &&
				token(candidate.code) &&
				boundedText(candidate.message)
				? {
						type: "error",
						code: candidate.code,
						message: candidate.message,
					}
				: undefined;
		case "history_boundary":
			return hasOnlyKeys(candidate, [
				"type",
				"reason",
				"requested_after_provider_sequence",
				"dropped_through_provider_sequence",
			]) &&
				token(candidate.reason) &&
				nonNegativeInteger(candidate.requested_after_provider_sequence) &&
				nonNegativeInteger(candidate.dropped_through_provider_sequence) &&
				candidate.dropped_through_provider_sequence >
					candidate.requested_after_provider_sequence
				? {
						type: "history_boundary",
						reason: candidate.reason,
						requestedAfterProviderSequence:
							candidate.requested_after_provider_sequence,
						droppedThroughProviderSequence:
							candidate.dropped_through_provider_sequence,
					}
				: undefined;
		case "provider_evidence":
			return hasOnlyKeys(candidate, ["type", "namespace", "kind", "value"]) &&
				token(candidate.namespace) &&
				token(candidate.kind) &&
				boundedJson(candidate.value)
				? {
						type: "provider_evidence",
						namespace: candidate.namespace,
						kind: candidate.kind,
						value: candidate.value,
					}
				: undefined;
		default:
			return undefined;
	}
}

function parseRow(value: unknown): AgentTimelineRowV1 | undefined {
	const candidate = record(value);
	const item = record(candidate?.item);
	const cursor = parseAgentTimelineCursorV1(candidate?.cursor);
	const body = parseTimelineBody(item?.body);
	if (
		!candidate ||
		!hasOnlyKeys(candidate, ["cursor", "item"]) ||
		!cursor ||
		!item ||
		!hasOnlyKeys(item, [
			"itemId",
			"turnId",
			"clientMessageId",
			"providerMessageId",
			"body",
			"createdAtMs",
		]) ||
		!domainId(item.itemId) ||
		!nullableDomainId(item.turnId) ||
		!nullableDomainId(item.clientMessageId) ||
		!nullableDomainId(item.providerMessageId) ||
		!body ||
		!nonNegativeInteger(item.createdAtMs)
	) {
		return undefined;
	}
	return {
		cursor,
		item: {
			itemId: item.itemId,
			turnId: item.turnId,
			clientMessageId: item.clientMessageId,
			providerMessageId: item.providerMessageId,
			body,
			createdAtMs: item.createdAtMs,
		},
	};
}

function parseLiveText(value: unknown): AgentTimelineLiveTextV1 | undefined {
	const candidate = record(value);
	if (
		!candidate ||
		!hasOnlyKeys(candidate, [
			"streamId",
			"itemId",
			"kind",
			"text",
			"turnId",
			"clientMessageId",
			"providerMessageId",
			"updatedAtMs",
		]) ||
		!domainId(candidate.streamId) ||
		!domainId(candidate.itemId) ||
		!["assistant", "reasoning", "tool_input"].includes(
			String(candidate.kind),
		) ||
		!boundedText(candidate.text) ||
		!nullableDomainId(candidate.turnId) ||
		!nullableDomainId(candidate.clientMessageId) ||
		!domainId(candidate.providerMessageId) ||
		!nonNegativeInteger(candidate.updatedAtMs)
	) {
		return undefined;
	}
	return {
		streamId: candidate.streamId,
		itemId: candidate.itemId,
		kind: candidate.kind as AgentTimelineLiveTextV1["kind"],
		text: candidate.text,
		turnId: candidate.turnId,
		clientMessageId: candidate.clientMessageId,
		providerMessageId: candidate.providerMessageId,
		updatedAtMs: candidate.updatedAtMs,
	};
}

function parsePending(value: unknown): AgentPendingRequestV1 | undefined {
	const candidate = record(value);
	const runtime = parseAgentRuntimeFenceV1(candidate?.runtime);
	const request = record(candidate?.request);
	if (
		!candidate ||
		!hasOnlyKeys(candidate, ["interactionSessionId", "runtime", "request"]) ||
		!domainId(candidate.interactionSessionId) ||
		!runtime ||
		!request ||
		!hasOnlyKeys(request, [
			"requestId",
			"kind",
			"turnId",
			"clientMessageId",
			"payload",
			"createdAtMs",
		]) ||
		!domainId(request.requestId) ||
		!(request.kind === "permission" || request.kind === "question") ||
		!nullableDomainId(request.turnId) ||
		!domainId(request.clientMessageId) ||
		!boundedJson(request.payload) ||
		!nonNegativeInteger(request.createdAtMs)
	) {
		return undefined;
	}
	return {
		interactionSessionId: candidate.interactionSessionId,
		runtime,
		request: {
			requestId: request.requestId,
			kind: request.kind,
			turnId: request.turnId,
			clientMessageId: request.clientMessageId,
			payload: request.payload,
			createdAtMs: request.createdAtMs,
		},
	};
}

function parseActiveTurn(
	value: unknown,
): AgentTimelineActiveTurnV1 | undefined {
	const candidate = record(value);
	return candidate &&
		hasOnlyKeys(candidate, ["turnId", "clientMessageId"]) &&
		domainId(candidate.turnId) &&
		domainId(candidate.clientMessageId)
		? {
				turnId: candidate.turnId,
				clientMessageId: candidate.clientMessageId,
			}
		: undefined;
}

export function parseAgentTimelineReadV1(
	value: unknown,
	request: AgentTimelineReadRequestV1,
): AgentTimelineReadV1 | undefined {
	const candidate = record(value);
	if (candidate?.type === "reset") {
		const binding = parseAgentInteractionBindingV1(candidate.binding);
		return hasOnlyKeys(candidate, ["type", "binding", "reason"]) &&
			binding &&
			token(candidate.reason)
			? { type: "reset", binding, reason: candidate.reason }
			: undefined;
	}
	if (candidate?.type !== "page" || !hasOnlyKeys(candidate, ["type", "page"])) {
		return undefined;
	}
	const page = record(candidate.page);
	const binding = parseAgentInteractionBindingV1(page?.binding);
	const finalCursor = parseAgentTimelineCursorV1(page?.finalCursor);
	const goal = page?.goal === null ? null : parseAgentGoalRecordV1(page?.goal);
	const activeTurn =
		page?.activeTurn === null ? null : parseActiveTurn(page?.activeTurn);
	if (
		!page ||
		!hasOnlyKeys(page, [
			"binding",
			"rows",
			"liveText",
			"pendingRequests",
			"activeTurn",
			"goal",
			"queuedInputs",
			"finalCursor",
			"hasMore",
		]) ||
		!binding ||
		!Array.isArray(page.rows) ||
		page.rows.length > MAX_PAGE_ROWS ||
		!Array.isArray(page.liveText) ||
		page.liveText.length > MAX_LIVE_TEXT ||
		!Array.isArray(page.pendingRequests) ||
		page.pendingRequests.length > MAX_PENDING_REQUESTS ||
		activeTurn === undefined ||
		goal === undefined ||
		(goal !== null && goal.agentId !== binding.agentId) ||
		!finalCursor ||
		typeof page.hasMore !== "boolean"
	) {
		return undefined;
	}
	const rows = page.rows.map(parseRow);
	const liveText = page.liveText.map(parseLiveText);
	const pendingRequests = page.pendingRequests.map(parsePending);
	const queuedInputs = parseAgentQueuedInputPageV1(
		page.queuedInputs,
		binding.interactionSessionId,
	);
	if (
		rows.some((row) => !row) ||
		liveText.some((head) => !head) ||
		pendingRequests.some((request) => !request) ||
		!queuedInputs
	) {
		return undefined;
	}
	const parsedRows = rows as AgentTimelineRowV1[];
	const requestedCursor = request.cursor;
	const firstSequence = parsedRows[0]?.cursor.sequence;
	const lastSequence = parsedRows[parsedRows.length - 1]?.cursor.sequence;
	const rowsAreAscending = parsedRows.every(
		(row, index) =>
			row.cursor.epoch === binding.timelineEpoch &&
			(index === 0 ||
				parsedRows[index - 1]!.cursor.sequence < row.cursor.sequence),
	);
	const windowIsValid = (() => {
		if (
			request.interactionSessionId !== binding.interactionSessionId ||
			finalCursor.epoch !== binding.timelineEpoch ||
			!rowsAreAscending ||
			(page.hasMore && parsedRows.length === 0)
		) {
			return false;
		}
		switch (request.direction) {
			case "tail":
				return (
					requestedCursor === null &&
					(lastSequence === undefined
						? finalCursor.sequence === 0
						: lastSequence === finalCursor.sequence)
				);
			case "after":
				return (
					requestedCursor !== null &&
					requestedCursor.epoch === binding.timelineEpoch &&
					parsedRows.every(
						(row) => row.cursor.sequence > requestedCursor.sequence,
					) &&
					finalCursor.sequence === (lastSequence ?? requestedCursor.sequence)
				);
			case "before":
				return (
					requestedCursor !== null &&
					requestedCursor.epoch === binding.timelineEpoch &&
					parsedRows.every(
						(row) => row.cursor.sequence < requestedCursor.sequence,
					) &&
					finalCursor.sequence === (firstSequence ?? requestedCursor.sequence)
				);
		}
	})();
	if (
		!windowIsValid ||
		pendingRequests.some(
			(request) =>
				request?.interactionSessionId !== binding.interactionSessionId ||
				request.runtime.runtimeGeneration !==
					binding.runtime.runtimeGeneration ||
				request.runtime.providerEpoch !== binding.runtime.providerEpoch,
		)
	) {
		return undefined;
	}
	return {
		type: "page",
		page: {
			binding,
			rows: parsedRows,
			liveText: liveText as AgentTimelineLiveTextV1[],
			pendingRequests: pendingRequests as AgentPendingRequestV1[],
			activeTurn,
			goal,
			queuedInputs,
			finalCursor,
			hasMore: page.hasMore,
		},
	};
}
