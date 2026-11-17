import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { nonEmptyString } from "@/lib/payloadGuards";
import { isAuthoritativeIdleRuntimeState } from "@/lib/sessions/credentials/deferredCredentialSwitch";
import type { Agent } from "@/types";

/** The observer presentation a native Terminal pane shows. Chat is not a view
 * of the terminal: it is the backend-owned runtime the Agent moves into. */
export type NativeAgentViewV1 = "terminal" | "conversation";

export function normalizeNativeAgentView(
	value: unknown,
): NativeAgentViewV1 | undefined {
	return value === "terminal" || value === "conversation" ? value : undefined;
}

/** A native Terminal Agent's request to move into Chat at its next idle turn
 * boundary. The backend remains the only authority on idleness: a preserving
 * transition is refused while the source works, so this only records when the
 * next attempt may run. The baseline is the last runtime observation that was
 * seen busy (or refused the move); only a later idle observation retries. */
export interface PendingChatHandoverV1 {
	schemaVersion: 1;
	requestId: string;
	requestedAtMs: number;
	baselineSessionId: string;
	baselineTerminalEpoch: string | null;
	baselineRuntimeRevision: string | null;
	/** Set after a refusal other than "still busy"; the intent then waits for
	 * the user to retry, discard or cancel rather than looping. */
	lastError?: string;
}

export type PendingChatHandoverDecision =
	| { kind: "done" }
	| { kind: "failed" }
	| { kind: "waiting" }
	| { kind: "ready" };

export function normalizePendingChatHandover(
	value: unknown,
): PendingChatHandoverV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const intent = value as Partial<PendingChatHandoverV1>;
	const nullableString = (candidate: unknown) =>
		candidate === null || nonEmptyString(candidate);
	if (
		intent.schemaVersion !== 1 ||
		!nonEmptyString(intent.requestId) ||
		typeof intent.requestedAtMs !== "number" ||
		!Number.isFinite(intent.requestedAtMs) ||
		intent.requestedAtMs < 0 ||
		!nonEmptyString(intent.baselineSessionId) ||
		!nullableString(intent.baselineTerminalEpoch) ||
		!nullableString(intent.baselineRuntimeRevision) ||
		!(intent.lastError === undefined || nonEmptyString(intent.lastError))
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		requestId: intent.requestId,
		requestedAtMs: intent.requestedAtMs,
		baselineSessionId: intent.baselineSessionId,
		baselineTerminalEpoch: intent.baselineTerminalEpoch ?? null,
		baselineRuntimeRevision: intent.baselineRuntimeRevision ?? null,
		...(intent.lastError === undefined ? {} : { lastError: intent.lastError }),
	};
}

export function createPendingChatHandover(
	agent: Pick<Agent, "sessionId">,
	runtime: HmuxAgentRuntimeState | undefined,
	requestId: string,
	requestedAtMs: number,
): PendingChatHandoverV1 {
	return {
		schemaVersion: 1,
		requestId,
		requestedAtMs,
		baselineSessionId: agent.sessionId,
		baselineTerminalEpoch: runtime?.terminalEpoch ?? null,
		baselineRuntimeRevision: runtime?.revision ?? null,
	};
}

/** A busy refusal moves the baseline to the observation it was refused at, so
 * the same snapshot cannot cause a retry loop. */
export function rebaselinePendingChatHandover(
	intent: PendingChatHandoverV1,
	agent: Pick<Agent, "sessionId">,
	runtime: HmuxAgentRuntimeState | undefined,
): PendingChatHandoverV1 {
	const { lastError: _lastError, ...pending } = intent;
	return {
		...pending,
		baselineSessionId: agent.sessionId,
		baselineTerminalEpoch: runtime?.terminalEpoch ?? null,
		baselineRuntimeRevision: runtime?.revision ?? null,
	};
}

function sameObservation(
	intent: PendingChatHandoverV1,
	agent: Pick<Agent, "sessionId">,
	runtime: HmuxAgentRuntimeState,
): boolean {
	return (
		agent.sessionId === intent.baselineSessionId &&
		runtime.terminalEpoch === intent.baselineTerminalEpoch &&
		runtime.revision === intent.baselineRuntimeRevision
	);
}

/** Selects the next attempt. A preserving transition never discards work, so
 * the cost of a too-early attempt is one more busy refusal and rebaseline. */
export function evaluatePendingChatHandover(
	intent: PendingChatHandoverV1,
	agent: Agent | undefined,
	runtime: HmuxAgentRuntimeState | undefined,
): PendingChatHandoverDecision {
	if (!agent || agent.interactionProfile?.kind === "structured_protocol") {
		return { kind: "done" };
	}
	if (intent.lastError !== undefined) return { kind: "failed" };
	// A queued account switch owns the next idle boundary; Chat follows it.
	if (agent.pendingCredentialSwitch) return { kind: "waiting" };
	// Runtime projection arrives after durable store hydration on reload.
	if (!runtime || sameObservation(intent, agent, runtime)) {
		return { kind: "waiting" };
	}
	if (runtime.lifecycle === "exited") return { kind: "ready" };
	return isAuthoritativeIdleRuntimeState(runtime)
		? { kind: "ready" }
		: { kind: "waiting" };
}
