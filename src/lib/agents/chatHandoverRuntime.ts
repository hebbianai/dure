import { useCallback, useSyncExternalStore } from "react";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import {
	createPendingChatHandover,
	evaluatePendingChatHandover,
	type NativeAgentViewV1,
	type PendingChatHandoverV1,
	rebaselinePendingChatHandover,
} from "@/lib/agents/chatHandover";
import {
	DureAgentRuntimeSourceActiveError,
	type DureAgentRuntimeSourceStopPolicyV1,
} from "@/lib/ipc/dureAgentRuntime";
import { useStore } from "@/store";
import type { Agent } from "@/types";

/** Runs one Terminal → Chat transition with the given stop policy. Panels pass
 * their own route-checked transition; the idle watcher uses the shared one. */
export type ChatHandoverSwitch = (
	sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1,
	expectedSourceRevision?: number,
) => Promise<void>;

export type ChatHandoverRequestResult =
	| { kind: "completed" }
	| { kind: "scheduled" };

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

export function localNativeAgentViewPort(
	agentId: string,
	switchRuntime: ChatHandoverSwitch,
): NativeAgentViewPort {
	return {
		setView: async (view) => setNativeAgentView(agentId, view),
		requestChat: () => requestChatHandover(agentId, switchRuntime),
		applyChatNow: () => applyChatHandoverNow(agentId, switchRuntime),
		cancelChat: async () => {
			cancelChatHandover(agentId);
		},
	};
}

function agentById(agentId: string): Agent | undefined {
	return useStore.getState().agents.find((agent) => agent.id === agentId);
}

function runtimeFor(agent: Agent | undefined) {
	return agent
		? useStore.getState().sessionAgentRuntimeState[agent.sessionId]
		: undefined;
}

function updateAgent(
	agentId: string,
	update: (agent: Agent) => Agent | undefined,
): boolean {
	let changed = false;
	useStore.setState((state) => ({
		agents: state.agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			const next = update(agent);
			if (!next || next === agent) return agent;
			changed = true;
			return next;
		}),
	}));
	return changed;
}

function nextRequestId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`chat-handover-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

function failureCode(error: unknown): string {
	const cause =
		error instanceof DureAgentRuntimeSourceActiveError
			? error.requestError
			: error;
	const candidate =
		cause && typeof cause === "object" && "code" in cause
			? String(cause.code)
			: cause instanceof Error
				? cause.message
				: String(cause);
	return /^[a-z0-9_]+$/.test(candidate) ? candidate : "chat_handover_failed";
}

/** The pane's last observer view, remembered per Agent across remounts and
 * restarts. Moving into Chat starts the next Terminal on the terminal itself. */
export function setNativeAgentView(
	agentId: string,
	view: NativeAgentViewV1,
): void {
	updateAgent(agentId, (agent) =>
		(agent.nativeView ?? "terminal") === view
			? agent
			: { ...agent, nativeView: view },
	);
}

export function cancelChatHandover(
	agentId: string,
	requestId?: string,
): boolean {
	return updateAgent(agentId, (agent) => {
		const intent = agent.pendingChatHandover;
		if (!intent || (requestId !== undefined && intent.requestId !== requestId))
			return agent;
		return { ...agent, pendingChatHandover: undefined };
	});
}

function updateIntentIfCurrent(
	agentId: string,
	requestId: string,
	update: (intent: PendingChatHandoverV1, agent: Agent) => PendingChatHandoverV1,
): boolean {
	return updateAgent(agentId, (agent) => {
		const intent = agent.pendingChatHandover;
		if (intent?.requestId !== requestId) return agent;
		return { ...agent, pendingChatHandover: update(intent, agent) };
	});
}

// --- In-flight presentation ------------------------------------------------

const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function setInFlight(agentId: string, active: boolean): void {
	if (active === inFlight.has(agentId)) return;
	if (active) inFlight.add(agentId);
	else inFlight.delete(agentId);
	for (const listener of listeners) listener();
}

export function chatHandoverInFlight(agentId: string): boolean {
	return inFlight.has(agentId);
}

/** True while a Terminal → Chat transition for this Agent is running, whether
 * the pane started it or the idle watcher did. */
export function useChatHandoverInFlight(agentId: string): boolean {
	const subscribe = useCallback((listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, []);
	return useSyncExternalStore(
		subscribe,
		() => inFlight.has(agentId),
		() => false,
	);
}

async function runExclusive<T>(
	agentId: string,
	run: () => Promise<T>,
): Promise<T> {
	if (inFlight.has(agentId)) throw new Error("chat_handover_in_progress");
	setInFlight(agentId, true);
	try {
		return await run();
	} finally {
		setInFlight(agentId, false);
	}
}

async function sharedChatSwitch(
	agentId: string,
	sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1,
	expectedSourceRevision?: number,
): Promise<void> {
	const agent = agentById(agentId);
	if (!agent) throw new Error("client_agent_runtime_transition_missing");
	const { transitionAgentRuntime } = await import(
		"@/lib/agents/agentRuntimeTransitionAction"
	);
	await transitionAgentRuntime({
		agentId,
		targetInteractionProfile: "structured_protocol",
		sourceStopPolicy,
		expectedSourceRevision,
		credentialAction: {
			targetCredentialId: agentCredentialReferenceId(agent) ?? null,
		},
	});
}

/** Chat is the primary move. An idle Terminal switches now; a busy one keeps
 * working and switches at its next idle turn boundary. Nothing is discarded. */
export async function requestChatHandover(
	agentId: string,
	switchRuntime: ChatHandoverSwitch = (policy, revision) =>
		sharedChatSwitch(agentId, policy, revision),
): Promise<ChatHandoverRequestResult> {
	return runExclusive(agentId, async () => {
		try {
			await switchRuntime("preserve");
		} catch (error) {
			if (!(error instanceof DureAgentRuntimeSourceActiveError)) throw error;
			const agent = agentById(agentId);
			if (!agent) throw error;
			const intent = createPendingChatHandover(
				agent,
				runtimeFor(agent),
				nextRequestId(),
				Date.now(),
			);
			updateAgent(agentId, (current) => ({
				...current,
				pendingChatHandover: intent,
			}));
			return { kind: "scheduled" };
		}
		cancelChatHandover(agentId);
		return { kind: "completed" };
	});
}

/** The explicit secondary choice: stop the current turn and switch now. The
 * caller has confirmed the discard; the backend's refused revision fences it. */
export async function applyChatHandoverNow(
	agentId: string,
	switchRuntime: ChatHandoverSwitch = (policy, revision) =>
		sharedChatSwitch(agentId, policy, revision),
): Promise<void> {
	await runExclusive(agentId, async () => {
		try {
			await switchRuntime("preserve");
		} catch (error) {
			if (!(error instanceof DureAgentRuntimeSourceActiveError)) throw error;
			await switchRuntime("discard", error.expectedSourceRevision);
		}
		cancelChatHandover(agentId);
	});
}

/** Main-window-only service. The intent is durable on the Agent, so a pending
 * move survives reload; the in-flight set suppresses duplicate attempts. */
export function installChatHandoverWatch(
	switchRuntime: (
		agentId: string,
		sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1,
	) => Promise<void> = (agentId, policy) => sharedChatSwitch(agentId, policy),
): () => void {
	let disposed = false;

	const attempt = (agentId: string, intent: PendingChatHandoverV1) => {
		void runExclusive(agentId, () => switchRuntime(agentId, "preserve"))
			.then(() => cancelChatHandover(agentId, intent.requestId))
			.catch((error) => {
				if (disposed) return;
				if (error instanceof Error && error.message === "chat_handover_in_progress")
					return;
				if (error instanceof DureAgentRuntimeSourceActiveError) {
					updateIntentIfCurrent(agentId, intent.requestId, (current, agent) =>
						rebaselinePendingChatHandover(current, agent, runtimeFor(agent)),
					);
					return;
				}
				updateIntentIfCurrent(agentId, intent.requestId, (current) => ({
					...current,
					lastError: failureCode(error),
				}));
			})
			.finally(() => {
				if (!disposed) recompute();
			});
	};

	function recompute(): void {
		if (disposed) return;
		const state = useStore.getState();
		for (const agent of state.agents) {
			const intent = agent.pendingChatHandover;
			if (!intent || inFlight.has(agent.id)) continue;
			const decision = evaluatePendingChatHandover(
				intent,
				agent,
				state.sessionAgentRuntimeState[agent.sessionId],
			);
			if (decision.kind === "done") {
				cancelChatHandover(agent.id, intent.requestId);
				continue;
			}
			if (decision.kind === "ready") attempt(agent.id, intent);
		}
	}

	const unsubscribe = useStore.subscribe((state, previous) => {
		if (
			state.agents !== previous.agents ||
			state.sessionAgentRuntimeState !== previous.sessionAgentRuntimeState
		) {
			recompute();
		}
	});
	recompute();
	return () => {
		disposed = true;
		unsubscribe();
	};
}
