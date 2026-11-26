import { Channel, invoke } from "@tauri-apps/api/core";
import { t } from "@/lib/i18n";
import {
	type DureBackendIdentity,
	type DureBackendInvoke,
	DureBackendRequestError,
	dureBackendCapabilityMissing,
	dureBackendInvokeFailure,
	parseDureBackendEnvelope,
} from "@/lib/ipc/dureBackend";
import { selectedDureBackendRoute } from "@/lib/ipc/dureBackendRoute";
import { hasOnlyKeys, asRecord as record } from "@/lib/payloadGuards";

/** The backend subscription that reports what every chat-runtime Agent on it
 * is doing: the chat runtime's Host-like tier. */
const AGENT_CONVERSATION_ACTIVITY_CAPABILITY =
	"agent_conversation.activity.v1";
const SUBSCRIBE_OPERATION = "agent_conversation.activity.subscribe";
const TOPIC = "agent_conversation.activity";
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const MAX_QUEUED_EVENTS = 64;

/** One chat Agent's state as its backend reads it from the committed
 * conversation and the runtime projection. */
export interface DureAgentActivityV1 {
	agentId: string;
	interactionSessionId: string;
	lifecycle: "starting" | "running" | "exited";
	activity: "working" | "waiting";
	attention: "none" | "input_required" | "approval_required" | "error";
	/** The open request a person must answer, or the failed turn. */
	attentionId?: string;
	timelineEpoch: string;
	/** The newest finished turn's row (decimal); grows exactly when a turn
	 * finishes. */
	turnCompletedSequence: string;
}

export type DureAgentActivityEventV1 =
	/** Every chat Agent's state: on subscribe, after dropped announcements,
	 * and after the subscription reconnected. */
	| { kind: "snapshot"; agents: DureAgentActivityV1[] }
	| { kind: "changes"; changes: DureAgentActivityV1[]; removed: string[] }
	/** The subscription ended; nothing more arrives on it. */
	| { kind: "error"; error: DureBackendRequestError };

export interface DureAgentActivitySubscriptionV1 {
	backend: DureBackendIdentity;
	close(): Promise<void>;
}

interface ActivityChannel {
	onmessage: (message: unknown) => void;
}

function domainId(value: unknown): value is string {
	return typeof value === "string" && DOMAIN_ID.test(value);
}

function contractError() {
	return new DureBackendRequestError(
		"agent_activity_response_invalid",
		t("ipc.agentConversation.invalidResponse"),
		{ kind: "contract" },
	);
}

export function parseDureAgentActivityV1(
	value: unknown,
): DureAgentActivityV1 | undefined {
	const candidate = record(value);
	if (
		!candidate ||
		!hasOnlyKeys(candidate, [
			"agentId",
			"interactionSessionId",
			"lifecycle",
			"activity",
			"attention",
			"attentionId",
			"timelineEpoch",
			"turnCompletedSequence",
		]) ||
		!domainId(candidate.agentId) ||
		!domainId(candidate.interactionSessionId) ||
		!domainId(candidate.timelineEpoch) ||
		(candidate.lifecycle !== "starting" &&
			candidate.lifecycle !== "running" &&
			candidate.lifecycle !== "exited") ||
		(candidate.activity !== "working" && candidate.activity !== "waiting") ||
		(candidate.attention !== "none" &&
			candidate.attention !== "input_required" &&
			candidate.attention !== "approval_required" &&
			candidate.attention !== "error") ||
		!(
			candidate.attentionId === undefined ||
			(typeof candidate.attentionId === "string" &&
				candidate.attentionId.length > 0 &&
				candidate.attentionId.length <= 512)
		) ||
		typeof candidate.turnCompletedSequence !== "string" ||
		!DECIMAL.test(candidate.turnCompletedSequence)
	) {
		return undefined;
	}
	return {
		agentId: candidate.agentId,
		interactionSessionId: candidate.interactionSessionId,
		lifecycle: candidate.lifecycle,
		activity: candidate.activity,
		attention: candidate.attention,
		...(candidate.attentionId === undefined
			? {}
			: { attentionId: candidate.attentionId }),
		timelineEpoch: candidate.timelineEpoch,
		turnCompletedSequence: candidate.turnCompletedSequence,
	};
}

function parseAgents(value: unknown): DureAgentActivityV1[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const agents = value.map(parseDureAgentActivityV1);
	return agents.every((agent) => agent !== undefined)
		? (agents as DureAgentActivityV1[])
		: undefined;
}

function parseActivityEvent(
	value: unknown,
	expected: { subscriptionId: string; backend: DureBackendIdentity },
): DureAgentActivityEventV1 | undefined {
	const candidate = record(value);
	if (
		candidate?.schemaVersion !== 1 ||
		candidate.subscriptionId !== expected.subscriptionId
	) {
		return undefined;
	}
	if (candidate.kind === "error") {
		const error = record(candidate.error);
		return error &&
			typeof error.code === "string" &&
			typeof error.message === "string"
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
	const event = record(candidate.event);
	if (
		candidate.kind !== "event" ||
		candidate.backendId !== expected.backend.id ||
		event?.schemaVersion !== 1 ||
		event.topic !== TOPIC
	) {
		return undefined;
	}
	if (event.agents !== undefined) {
		const agents = parseAgents(event.agents);
		return agents ? { kind: "snapshot", agents } : undefined;
	}
	const changes = parseAgents(event.changes);
	const removed = event.removed;
	return changes && Array.isArray(removed) && removed.every(domainId)
		? { kind: "changes", changes, removed }
		: undefined;
}

/** Subscribe to the chat runtime tier of one backend profile. The first
 * event is the snapshot the subscription opened with; every later event
 * applies on top of the one before. Resolves to `null` when that backend
 * predates the tier. */
export async function subscribeDureAgentActivity(
	profileId: string,
	onEvent: (event: DureAgentActivityEventV1) => void,
	options?: {
		invokeCommand?: DureBackendInvoke;
		channelFactory?: () => ActivityChannel;
		subscriptionId?: () => string;
	},
): Promise<DureAgentActivitySubscriptionV1 | null> {
	const invokeCommand =
		options?.invokeCommand ??
		((command: string, arguments_: Record<string, unknown>) =>
			invoke(command, arguments_));
	const subscriptionId =
		options?.subscriptionId?.() ?? `agent-activity-${crypto.randomUUID()}`;
	const channel: ActivityChannel =
		options?.channelFactory?.() ?? new Channel<unknown>();
	// Events can arrive before the subscribe call returns its snapshot; they
	// wait for it so they apply on top of it.
	const queued: unknown[] = [];
	let queueOverflow = false;
	let dispatch: ((message: unknown) => void) | undefined;
	channel.onmessage = (message) => {
		if (dispatch) dispatch(message);
		else if (queued.length < MAX_QUEUED_EVENTS) queued.push(message);
		else queueOverflow = true;
	};
	let raw: unknown;
	try {
		raw = await invokeCommand("dure_backend_subscribe", {
			route: selectedDureBackendRoute(profileId),
			subscriptionId,
			operation: SUBSCRIBE_OPERATION,
			body: { schemaVersion: 1 },
			channel,
		});
	} catch (cause) {
		const error = dureBackendInvokeFailure(
			cause,
			"agent_activity_transport_failed",
			t("ipc.agentConversation.requestFailed"),
		);
		if (dureBackendCapabilityMissing(error, AGENT_CONVERSATION_ACTIVITY_CAPABILITY))
			return null;
		throw error;
	}
	const response = parseDureBackendEnvelope(raw);
	const initial = parseAgents(response?.result.agents);
	if (!response || !initial) {
		void invokeCommand("dure_backend_unsubscribe", { subscriptionId }).catch(
			() => {},
		);
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
		onEvent(
			parseActivityEvent(message, {
				subscriptionId,
				backend: response.backend,
			}) ?? { kind: "error", error: contractError() },
		);
	};
	onEvent({ kind: "snapshot", agents: initial });
	for (const message of queued) dispatch(message);
	// Updates were lost before the snapshot applied: the subscription can no
	// longer be trusted, so it ends and is opened again.
	if (queueOverflow) onEvent({ kind: "error", error: contractError() });
	return { backend: response.backend, close };
}
