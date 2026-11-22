import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { nonEmptyString } from "@/lib/payloadGuards";
import { isAuthoritativeIdleRuntimeState } from "@/lib/sessions/credentials/deferredCredentialSwitch";
import type {
	Agent,
	NativeAgentViewV1,
	PendingChatHandoverV1,
} from "@/types";

export type { NativeAgentViewV1, PendingChatHandoverV1 } from "@/types";

/** The View control's moves for one Agent: show its terminal or its
 * Conversation, or move it into Chat. A pane runs them in its own window
 * (`localNativeAgentViewPort`); the large window sends the same moves to the
 * window that owns the source pane, so both surfaces change one runtime. */
export interface NativeAgentViewPort {
	setView(view: NativeAgentViewV1): Promise<void>;
	requestChat(): Promise<unknown>;
	applyChatNow(): Promise<void>;
	cancelChat(): Promise<void>;
}

export function normalizeNativeAgentView(
	value: unknown,
): NativeAgentViewV1 | undefined {
	return value === "terminal" || value === "conversation" ? value : undefined;
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
