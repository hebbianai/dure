import { Channel, invoke } from "@tauri-apps/api/core";
import {
	type AgentGoalPutRequestV1,
	type AgentGoalRecordV1,
	type AgentInteractionBindingV1,
	type AgentProviderRuntimeFenceV1,
	type AgentTimelineCursorV1,
	type AgentTimelineReadRequestV1,
	type AgentTimelineReadV1,
	parseAgentGoalRecordV1,
	parseAgentInteractionBindingV1,
	parseAgentRuntimeFenceV1,
	parseAgentTimelineCursorV1,
	parseAgentTimelineReadV1,
} from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	DureBackendAuthorityFence,
	type DureBackendIdentity,
	type DureBackendInvoke,
	DureBackendRequestError,
	dureBackendInvokeFailure,
	parseDureBackendEnvelope,
} from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	selectedDureBackendRoute,
} from "@/lib/ipc/dureBackendRoute";
import {
	hasOnlyKeys,
	nonNegativeInteger,
	asRecord as record,
} from "@/lib/payloadGuards";

const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const MAX_QUEUED_EVENTS = 64;

type AgentConversationReadRequestV1 = AgentTimelineReadRequestV1;

export interface AgentConversationStartTurnV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	runtime: AgentProviderRuntimeFenceV1;
	turnId: string;
	clientMessageId: string;
	input: string;
	requestedAtMs: number;
}

export interface AgentConversationAnswerPendingV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	runtime: AgentProviderRuntimeFenceV1;
	requestId: string;
	clientMessageId: string;
	idempotencyKey: string;
	answer: unknown;
	requestedAtMs: number;
}

export interface AgentConversationInterruptTurnV1 {
	schemaVersion: 1;
	interactionSessionId: string;
	runtime: AgentProviderRuntimeFenceV1;
	turnId: string;
	clientMessageId: string;
	interruptRequestId: string;
	requestedAtMs: number;
}

export type AgentConversationInvalidationV1 =
	| {
			kind: "changed";
			interactionSessionId: string;
			timelineCursor: AgentTimelineCursorV1;
			kinds: Array<
				| "timeline"
				| "live_text"
				| "pending_requests"
				| "history_gap"
				| "runtime"
				| "goal"
			>;
	  }
	| {
			kind: "reset_required";
			interactionSessionId: string;
			backendReplaced?: boolean;
	  }
	| { kind: "error"; error: DureBackendRequestError };

export interface AgentConversationSubscriptionV1 {
	subscriptionId: string;
	backend: DureBackendIdentity;
	routeAuthority: DureBackendRouteAuthorityV1;
	initial: AgentTimelineReadV1;
	close(): Promise<void>;
}

export interface DureAgentConversationClient {
	putGoal(
		request: AgentGoalPutRequestV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<AgentGoalRecordV1>;
	inspect(agentId: string): Promise<{
		backend: DureBackendIdentity;
		routeAuthority: DureBackendRouteAuthorityV1;
		binding: AgentInteractionBindingV1 | null;
	}>;
	recover(
		expectedBinding: AgentInteractionBindingV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<AgentInteractionBindingV1>;
	read(request: AgentConversationReadRequestV1): Promise<{
		backend: DureBackendIdentity;
		routeAuthority: DureBackendRouteAuthorityV1;
		read: AgentTimelineReadV1;
	}>;
	subscribe(
		request: AgentConversationReadRequestV1,
		onInvalidation: (event: AgentConversationInvalidationV1) => void,
	): Promise<AgentConversationSubscriptionV1>;
	startTurn(
		request: AgentConversationStartTurnV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void>;
	/** Delivers one user message into the RUNNING turn; the provider applies
	 * it at its next tool boundary. Rejects when the provider has no
	 * mid-turn channel — callers fall back to queueing. */
	steerTurn(
		request: AgentConversationStartTurnV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void>;
	answerPending(
		request: AgentConversationAnswerPendingV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void>;
	interruptTurn(
		request: AgentConversationInterruptTurnV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void>;
}

interface ConversationChannel {
	onmessage: (message: unknown) => void;
}

type ConversationChannelFactory = () => ConversationChannel;

function domainId(value: unknown): value is string {
	return typeof value === "string" && DOMAIN_ID.test(value);
}

function token(value: unknown): value is string {
	return typeof value === "string" && TOKEN.test(value);
}

function contractError(code = "agent_conversation_response_invalid") {
	return new DureBackendRequestError(
		code,
		t("ipc.agentConversation.invalidResponse"),
		{ kind: "contract" },
	);
}

function sameRuntime(
	left: AgentProviderRuntimeFenceV1 | undefined,
	right: AgentProviderRuntimeFenceV1,
): boolean {
	return (
		left?.runtimeGeneration === right.runtimeGeneration &&
		left.providerEpoch === right.providerEpoch
	);
}

function parseSubscriptionEvent(
	value: unknown,
	expected: {
		subscriptionId: string;
		backend: DureBackendIdentity;
		interactionSessionId: string;
		timelineEpoch: string;
	},
): AgentConversationInvalidationV1 | undefined {
	const candidate = record(value);
	if (
		candidate?.schemaVersion !== 1 ||
		candidate.subscriptionId !== expected.subscriptionId
	) {
		return undefined;
	}
	if (candidate.kind === "error") {
		const error = record(candidate.error);
		return hasOnlyKeys(candidate, [
			"schemaVersion",
			"kind",
			"subscriptionId",
			"error",
		]) &&
			error &&
			hasOnlyKeys(error, ["code", "message", "details"]) &&
			token(error.code) &&
			typeof error.message === "string" &&
			error.message.length <= 512
			? {
					kind: "error",
					error: new DureBackendRequestError(
						error.code,
						error.message,
						{ kind: "transport" },
						record(error.details),
					),
				}
			: undefined;
	}
	if (
		candidate.kind !== "event" ||
		!hasOnlyKeys(candidate, [
			"schemaVersion",
			"kind",
			"subscriptionId",
			"backendId",
			"backendGeneration",
			"event",
		]) ||
		candidate.backendId !== expected.backend.id ||
		!token(candidate.backendGeneration)
	) {
		return undefined;
	}
	const event = record(candidate.event);
	if (
		event?.schemaVersion !== 1 ||
		typeof event.topic !== "string" ||
		!token(event.subscriptionRequestId)
	) {
		return undefined;
	}
	if (event.topic === "agent_conversation.reset_required") {
		return hasOnlyKeys(event, [
			"schemaVersion",
			"topic",
			"subscriptionRequestId",
			"interactionSessionId",
		]) &&
			domainId(event.interactionSessionId) &&
			event.interactionSessionId === expected.interactionSessionId
			? {
					kind: "reset_required",
					interactionSessionId: event.interactionSessionId,
					backendReplaced:
						candidate.backendGeneration !== expected.backend.generation,
				}
			: undefined;
	}
	if (event.topic !== "agent_conversation.changed") return undefined;
	if (candidate.backendGeneration !== expected.backend.generation) {
		return undefined;
	}
	if (
		!hasOnlyKeys(event, [
			"schemaVersion",
			"topic",
			"subscriptionRequestId",
			"notification",
		])
	) {
		return undefined;
	}
	const notification = record(event.notification);
	const timelineCursor = parseAgentTimelineCursorV1(
		notification?.timelineCursor,
	);
	const kinds = notification?.kinds;
	if (
		!notification ||
		!hasOnlyKeys(notification, [
			"interactionSessionId",
			"timelineCursor",
			"kinds",
		]) ||
		notification.interactionSessionId !== expected.interactionSessionId ||
		!timelineCursor ||
		timelineCursor.epoch !== expected.timelineEpoch ||
		!Array.isArray(kinds) ||
		kinds.length > 6 ||
		new Set(kinds).size !== kinds.length ||
		kinds.some(
			(kind) =>
				![
					"timeline",
					"live_text",
					"pending_requests",
					"history_gap",
					"runtime",
					"goal",
				].includes(String(kind)),
		)
	) {
		return undefined;
	}
	return {
		kind: "changed",
		interactionSessionId: notification.interactionSessionId,
		timelineCursor,
		kinds: kinds as Array<
			| "timeline"
			| "live_text"
			| "pending_requests"
			| "history_gap"
			| "runtime"
			| "goal"
		>,
	};
}

function assertMutationReceipt(
	value: unknown,
	expected: {
		interactionSessionId: string;
		runtime: AgentProviderRuntimeFenceV1;
		clientMessageId: string;
	},
): Record<string, unknown> {
	const receipt = record(value);
	const intent = record(receipt?.intent ?? receipt?.request);
	const runtime = parseAgentRuntimeFenceV1(intent?.runtime);
	if (
		!receipt ||
		!intent ||
		intent.interactionSessionId !== expected.interactionSessionId ||
		intent.clientMessageId !== expected.clientMessageId ||
		!sameRuntime(runtime, expected.runtime)
	) {
		throw contractError("agent_conversation_receipt_invalid");
	}
	return receipt;
}

function defaultChannelFactory(): ConversationChannel {
	return new Channel<unknown>();
}

export function createDureAgentConversationClient(options?: {
	profileId?: string;
	routeAuthority?: DureBackendRouteAuthorityV1;
	invokeCommand?: DureBackendInvoke;
	channelFactory?: ConversationChannelFactory;
	authority?: DureBackendAuthorityFence;
	subscriptionId?: () => string;
}): DureAgentConversationClient {
	const profileId = options?.profileId ?? "local";
	const invokeCommand =
		options?.invokeCommand ??
		((command: string, arguments_: Record<string, unknown>) =>
			invoke(command, arguments_));
	const channelFactory = options?.channelFactory ?? defaultChannelFactory;
	const authority = options?.authority ?? new DureBackendAuthorityFence();
	const backendRequest = createDureBackendRequester({
		profileId,
		invokeCommand,
		invalidResponseCode: "agent_conversation_response_invalid",
		invalidResponseMessage: t("ipc.agentConversation.invalidResponse"),
		backendChangedCode: "agent_conversation_backend_changed",
		backendChangedMessage: t("ipc.dureBackend.generationChanged"),
		requestFailedCode: "agent_conversation_transport_failed",
		requestFailedMessage: t("ipc.agentConversation.requestFailed"),
		authority,
	});
	const newSubscriptionId =
		options?.subscriptionId ??
		(() => `chat-subscription-${crypto.randomUUID()}`);

	const requestEffect = async (
		operation: string,
		body: Record<string, unknown>,
		routeAuthority: DureBackendRouteAuthorityV1,
	) =>
		backendRequest(operation, body, {
			kind: "exact",
			authority: routeAuthority,
		});

	return {
		async putGoal(request, routeAuthority) {
			const response = await requestEffect(
				"agent_goal.put",
				{ ...request },
				routeAuthority,
			);
			const goal = parseAgentGoalRecordV1(response.result.goal);
			if (
				!goal ||
				goal.agentId !== request.agentId ||
				goal.revision !== request.expectedRevision + 1 ||
				goal.objective !== request.objective ||
				goal.status !== request.status
			)
				throw contractError();
			return goal;
		},
		async inspect(agentId) {
			if (!domainId(agentId))
				throw contractError("agent_conversation_request_invalid");
			const response = await backendRequest(
				"agent_conversation.inspect",
				{
					schemaVersion: 1,
					agentId,
				},
				options?.routeAuthority
					? { kind: "exact", authority: options.routeAuthority }
					: { kind: "complete_selected_snapshot" },
			);
			const binding =
				response.result.binding === null
					? null
					: parseAgentInteractionBindingV1(response.result.binding);
			if (binding === undefined || (binding && binding.agentId !== agentId)) {
				throw contractError();
			}
			return {
				backend: response.backend,
				routeAuthority: response.routeAuthority,
				binding,
			};
		},

		async recover(expectedBinding, routeAuthority) {
			const response = await requestEffect(
				"agent_conversation.recover",
				{
					schemaVersion: 1,
					expectedBinding,
				},
				routeAuthority,
			);
			const recovered = parseAgentInteractionBindingV1(response.result.binding);
			if (
				!recovered ||
				recovered.agentId !== expectedBinding.agentId ||
				recovered.interactionSessionId !== expectedBinding.interactionSessionId
			) {
				throw contractError("agent_conversation_recover_receipt_invalid");
			}
			return recovered;
		},

		async read(readRequest) {
			const response = await backendRequest(
				"agent_conversation.read",
				readRequest as unknown as Record<string, unknown>,
				options?.routeAuthority
					? { kind: "exact", authority: options.routeAuthority }
					: { kind: "complete_selected_snapshot" },
			);
			const read = parseAgentTimelineReadV1(response.result.read, readRequest);
			if (
				!read ||
				(read.type === "page"
					? read.page.binding.interactionSessionId
					: read.binding.interactionSessionId) !==
					readRequest.interactionSessionId
			) {
				throw contractError();
			}
			return {
				backend: response.backend,
				routeAuthority: response.routeAuthority,
				read,
			};
		},

		async subscribe(readRequest, onInvalidation) {
			const subscriptionId = newSubscriptionId();
			if (!domainId(subscriptionId)) {
				throw contractError("agent_conversation_subscription_id_invalid");
			}
			const channel = channelFactory();
			const queued: unknown[] = [];
			let queueOverflow = false;
			let dispatch: ((message: unknown) => void) | undefined;
			channel.onmessage = (message) => {
				if (dispatch) {
					dispatch(message);
				} else if (queued.length < MAX_QUEUED_EVENTS) {
					queued.push(message);
				} else {
					queueOverflow = true;
				}
			};
			let raw: unknown;
			try {
				raw = await invokeCommand("dure_backend_subscribe", {
					route: options?.routeAuthority
						? { kind: "exact", authority: options.routeAuthority }
						: selectedDureBackendRoute(profileId),
					subscriptionId,
					body: readRequest,
					channel,
				});
			} catch (error) {
				throw dureBackendInvokeFailure(
					error,
					"agent_conversation_transport_failed",
					t("ipc.agentConversation.requestFailed"),
				);
			}
			const response = parseDureBackendEnvelope(raw);
			const initial = response
				? parseAgentTimelineReadV1(response.result.read, readRequest)
				: undefined;
			const initialInteractionId =
				initial?.type === "page"
					? initial.page.binding.interactionSessionId
					: initial?.binding.interactionSessionId;
			if (
				!response ||
				!initial ||
				initialInteractionId !== readRequest.interactionSessionId
			) {
				void invokeCommand("dure_backend_unsubscribe", {
					subscriptionId,
				}).catch(() => {});
				throw contractError();
			}
			let closed = false;
			const close = async () => {
				if (closed) return;
				closed = true;
				await invokeCommand("dure_backend_unsubscribe", { subscriptionId });
			};
			dispatch = (message) => {
				if (closed) return;
				const event = parseSubscriptionEvent(message, {
					subscriptionId,
					backend: response.backend,
					interactionSessionId: readRequest.interactionSessionId,
					timelineEpoch:
						initial.type === "page"
							? initial.page.binding.timelineEpoch
							: initial.binding.timelineEpoch,
				});
				onInvalidation(event ?? { kind: "error", error: contractError() });
			};
			for (const message of queued) dispatch(message);
			if (queueOverflow) {
				onInvalidation({
					kind: "reset_required",
					interactionSessionId: readRequest.interactionSessionId,
				});
			}
			return {
				subscriptionId,
				backend: response.backend,
				routeAuthority: response.routeAuthority,
				initial,
				close,
			};
		},

		async startTurn(turn, routeAuthority) {
			const response = await requestEffect(
				"agent_conversation.start_turn",
				turn as unknown as Record<string, unknown>,
				routeAuthority,
			);
			const receipt = assertMutationReceipt(response.result.receipt, turn);
			const intent = record(receipt.intent);
			if (
				intent?.turnId !== turn.turnId ||
				intent.input !== turn.input ||
				!["prepared", "accepted", "failed", "uncertain"].includes(
					String(receipt.state),
				)
			) {
				throw contractError("agent_conversation_receipt_invalid");
			}
		},

		async steerTurn(turn, routeAuthority) {
			const response = await requestEffect(
				"agent_conversation.steer_turn",
				turn as unknown as Record<string, unknown>,
				routeAuthority,
			);
			const receipt = assertMutationReceipt(response.result.receipt, turn);
			const intent = record(receipt.intent);
			if (
				intent?.turnId !== turn.turnId ||
				intent.input !== turn.input ||
				!["prepared", "accepted", "failed", "uncertain"].includes(
					String(receipt.state),
				)
			) {
				throw contractError("agent_conversation_receipt_invalid");
			}
			if (receipt.state === "failed") {
				throw contractError("agent_conversation_steer_failed");
			}
		},

		async answerPending(answer, routeAuthority) {
			const response = await requestEffect(
				"agent_conversation.answer_pending",
				answer as unknown as Record<string, unknown>,
				routeAuthority,
			);
			const receipt = assertMutationReceipt(response.result.receipt, answer);
			const intent = record(receipt.intent);
			const pending = record(receipt.request);
			const pendingRequest = record(pending?.request);
			if (
				intent?.requestId !== answer.requestId ||
				intent.idempotencyKey !== answer.idempotencyKey ||
				pendingRequest?.requestId !== answer.requestId ||
				!["prepared", "succeeded", "failed", "uncertain"].includes(
					String(receipt.state),
				)
			) {
				throw contractError("agent_conversation_receipt_invalid");
			}
		},

		async interruptTurn(interrupt, routeAuthority) {
			const response = await requestEffect(
				"agent_conversation.interrupt_turn",
				interrupt as unknown as Record<string, unknown>,
				routeAuthority,
			);
			const receipt = assertMutationReceipt(response.result.receipt, interrupt);
			const requestReceipt = record(receipt.request);
			if (
				requestReceipt?.turnId !== interrupt.turnId ||
				requestReceipt.interruptRequestId !== interrupt.interruptRequestId ||
				!nonNegativeInteger(receipt.completedAtMs)
			) {
				throw contractError("agent_conversation_receipt_invalid");
			}
		},
	};
}
