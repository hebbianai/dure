import {
	censusProvesSessionEnded,
	hasPositiveAgentRuntimeObservation,
} from "@/lib/agents/agentRuntimeLiveness";
import type { AgentRuntimeProjectionRefreshHintV1 } from "@/lib/agents/agentRuntimeProjectionReconciliationRuntime";
import {
	hmuxManagedAgentSemanticObserverClient,
	type ManagedAgentRuntimeBinding,
	type ManagedAgentSemanticObserverClient,
	type ManagedAgentSemanticObserverConnection,
} from "@/lib/agents/managedAgentSemanticObserverClient";
import {
	semanticObserverFailureEvidence,
	semanticObserverFailureOutcome,
	semanticObserverRetry,
} from "@/lib/agents/managedAgentSemanticObserverRetry";
import { isHmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import { nextHmuxControlPlaneCensus } from "@/lib/hmux/identity/hmuxControlPlaneCensusRuntime";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { applyProjectedConversationIdentity } from "@/lib/sessions/managed/managedConversationIdentity";
import type { SessionAgentRuntimeObservation } from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";
import { managedLocalRuntimeLiveness } from "@/lib/terminal/hmuxManagedAttachConcurrency";
import { useStore } from "@/store";
import type { Agent, SshHostConfig } from "@/types";

interface SemanticObservationTarget {
	readonly agentId: string;
	readonly key: string;
	readonly binding: ManagedAgentRuntimeBinding;
	readonly sshHosts: readonly SshHostConfig[];
}

interface ActiveSemanticObservation {
	readonly key: string;
	retire(): void;
}

export type ManagedAgentRuntimeProjectionRefresh = (
	hint: AgentRuntimeProjectionRefreshHintV1,
) => void;

/** Calls back once with the sessions of the first complete census requested
 * from now on. Returns a cancel. */
export type ManagedAgentNextCensus = (
	listener: (sessions: readonly HmuxSessionSummary[]) => void,
) => () => void;

/** Whether this window holds a positive observation of the target's Agent:
 * the spawn gap, or a live state it already saw. */
function targetObservedAlive(target: SemanticObservationTarget): boolean {
	const state = useStore.getState();
	const agent = state.agents.find(
		(candidate) => candidate.id === target.agentId,
	);
	return (
		agent !== undefined &&
		hasPositiveAgentRuntimeObservation({
			agent,
			agentActivity: state.agentActivity,
			sessionAgentRuntimeState: state.sessionAgentRuntimeState,
		})
	);
}

/** Calls back whether the Host's answer that the target's session is gone
 * proves it ended. A local answer needs a census taken after it that lacks
 * the session or lists it exited in this generation. A remote answer
 * already comes from that Host's own complete catalog. Returns a cancel. */
function confirmSessionEnded(
	target: SemanticObservationTarget,
	nextCensus: ManagedAgentNextCensus,
	decide: (ended: boolean) => void,
): () => void {
	const { binding } = target;
	const stopFence = binding.stopFence;
	// Without a published generation there is nothing to prove.
	if (!stopFence || binding.source !== "local") {
		decide(stopFence !== undefined && binding.source !== "local");
		return () => undefined;
	}
	return nextCensus((sessions) =>
		decide(censusProvesSessionEnded(sessions, { ...binding, stopFence })),
	);
}

function targetForAgent(
	agent: Agent,
	sshHosts: readonly SshHostConfig[],
	remoteConfigRevision: number,
	hmuxSessionMetadata: ReturnType<
		typeof useStore.getState
	>["hmuxSessionMetadata"],
): SemanticObservationTarget | undefined {
	const binding = agent.runtimeBinding;
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.sessionId !== agent.sessionId ||
		managedLocalRuntimeLiveness(binding, hmuxSessionMetadata) === "exited"
	) {
		return undefined;
	}
	const fence = binding.stopFence;
	return {
		agentId: agent.id,
		binding,
		sshHosts,
		key: JSON.stringify([
			agent.id,
			binding.source,
			binding.hostId,
			binding.sessionId,
			binding.workspaceId,
			fence?.runnerPrincipal ?? null,
			fence?.runnerInstance ?? null,
			fence?.channelEpoch ?? null,
			fence?.hostInstanceId ?? null,
			fence?.terminalEpoch ?? null,
			binding.source === "ssh" ? remoteConfigRevision : null,
		]),
	};
}

function startSemanticObservation(
	target: SemanticObservationTarget,
	client: ManagedAgentSemanticObserverClient,
	isCurrent: () => boolean,
	refreshRuntimeProjection: ManagedAgentRuntimeProjectionRefresh,
	nextCensus: ManagedAgentNextCensus,
): ActiveSemanticObservation {
	let retired = false;
	let failures = 0;
	let connectInFlight = false;
	let disconnectPending = false;
	let terminalFailure = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let cancelConfirmation: (() => void) | undefined;
	let connection: ManagedAgentSemanticObserverConnection | undefined;
	let runtimeObservation: SessionAgentRuntimeObservation | undefined;
	const refresh = (evidence: string) => {
		try {
			refreshRuntimeProjection({ agentId: target.agentId, evidence });
		} catch {
			// A passive refresh listener cannot participate in Hmux observation.
		}
	};

	const current = () => !retired && isCurrent();
	const scheduleReconnect = () => {
		if (
			!current() ||
			terminalFailure ||
			reconnectTimer !== undefined ||
			connectInFlight
		)
			return;
		const retry = semanticObserverRetry(failures);
		if (retry.exhausted) {
			// Not silent: the same failure is still reported, it just stops
			// repeating. An unbounded retry here filled both pane-diagnostics
			// tiers with one code and destroyed the evidence for every other
			// connection failure.
			terminalFailure = true;
			return;
		}
		failures += 1;
		reconnectTimer = globalThis.setTimeout(() => {
			reconnectTimer = undefined;
			void connect();
		}, retry.delayMs);
	};
	const disconnect = () => {
		if (!current()) return;
		runtimeObservation?.dispose();
		runtimeObservation = undefined;
		if (connectInFlight && !connection) {
			disconnectPending = true;
			return;
		}
		const disconnected = connection;
		connection = undefined;
		void disconnected?.close();
		scheduleReconnect();
	};
	const connect = async () => {
		if (!current() || connectInFlight || connection) return;
		connectInFlight = true;
		const attempt = useStore
			.getState()
			.beginSessionAgentRuntimeObservation(target.binding.sessionId);
		runtimeObservation = attempt;
		try {
			const attached = await client.connect({
				binding: target.binding,
				sshHosts: target.sshHosts,
				onRuntimeState: (runtime) => {
					if (
						!current() ||
						runtimeObservation !== attempt ||
						(target.binding.stopFence &&
							runtime.terminalEpoch !== target.binding.stopFence.terminalEpoch)
					) {
						return;
					}
					attempt.publish(runtime);
					if (runtime.lifecycle === "exited") {
						refresh(
							JSON.stringify([
								"semantic_runtime_exited",
								target.key,
								runtime.terminalEpoch,
								runtime.revision,
							]),
						);
					}
				},
				onConversationIdentity: (identity) => {
					if (!current()) return;
					useStore.setState((state) => {
						const agents = applyProjectedConversationIdentity(
							state.agents,
							identity,
						);
						return agents === state.agents ? {} : { agents: [...agents] };
					});
				},
				onDisconnected: () => {
					if (runtimeObservation === attempt) disconnect();
				},
			});
			if (!current()) {
				await attached.close();
				return;
			}
			connection = attached;
			failures = 0;
			if (disconnectPending) {
				disconnectPending = false;
				disconnect();
			}
		} catch (cause) {
			attempt.dispose();
			if (runtimeObservation === attempt) runtimeObservation = undefined;
			disconnectPending = false;
			const failure = semanticObserverFailureEvidence(cause);
			if (failure.retiredSource) {
				refresh(JSON.stringify(["semantic_source_retired", target.key]));
			} else if (failure.retryDirective === "retry_after_resync") {
				refresh(
					JSON.stringify([
						"semantic_attach_resync_requested",
						target.key,
						failure.code ?? null,
					]),
				);
			}
			const outcome = semanticObserverFailureOutcome({
				failure,
				sessionFailure: isHmuxSessionFailureError(cause),
				publishedGeneration: target.binding.stopFence !== undefined,
				observedAlive: targetObservedAlive(target),
			});
			terminalFailure = outcome !== "retry";
			if (outcome === "confirm_exit" && current()) confirmExit();
			if (current() && !terminalFailure) scheduleReconnect();
		} finally {
			connectInFlight = false;
			if (
				current() &&
				!terminalFailure &&
				!connection &&
				reconnectTimer === undefined
			) {
				scheduleReconnect();
			}
		}
	};

	// The Host says the session is gone. Proven, that is the Agent's exit,
	// recorded as the same Host-exit fact a pane records, and observing stops.
	// Unproven, the answer may have raced the session's publication: retry.
	const confirmExit = () => {
		cancelConfirmation?.();
		cancelConfirmation = confirmSessionEnded(target, nextCensus, (ended) => {
			cancelConfirmation = undefined;
			if (!current()) return;
			if (ended && !targetObservedAlive(target)) {
				useStore.getState().setAgentActivity(target.agentId, "exited");
				return;
			}
			terminalFailure = false;
			scheduleReconnect();
		});
	};

	const observation: ActiveSemanticObservation = {
		key: target.key,
		retire: () => {
			if (retired) return;
			retired = true;
			cancelConfirmation?.();
			cancelConfirmation = undefined;
			runtimeObservation?.dispose();
			runtimeObservation = undefined;
			if (reconnectTimer !== undefined) {
				globalThis.clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			const retiredConnection = connection;
			connection = undefined;
			void retiredConnection?.close();
		},
	};
	void Promise.resolve().then(connect);
	return observation;
}

/**
 * Keeps one presentation-free semantic subscription per managed Agent. This
 * lifetime is owned by the main window, not by DockView or a terminal renderer.
 */
export function installManagedAgentSemanticObserverRuntime(
	client: ManagedAgentSemanticObserverClient = hmuxManagedAgentSemanticObserverClient,
	refreshRuntimeProjection: ManagedAgentRuntimeProjectionRefresh = () =>
		undefined,
	nextCensus: ManagedAgentNextCensus = (listener) =>
		nextHmuxControlPlaneCensus((census) => listener(census.sessions)),
): () => void {
	const active = new Map<string, ActiveSemanticObservation>();
	let disposed = false;
	let remoteConfigRevision = 0;

	const reconcile = () => {
		if (disposed) return;
		const state = useStore.getState();
		const targets = new Map(
			state.agents.flatMap((agent) => {
				const target = targetForAgent(
					agent,
					state.sshHosts,
					remoteConfigRevision,
					state.hmuxSessionMetadata,
				);
				return target ? [[agent.id, target] as const] : [];
			}),
		);
		for (const [agentId, observation] of active) {
			const target = targets.get(agentId);
			if (target?.key === observation.key) continue;
			observation.retire();
			active.delete(agentId);
		}
		for (const [agentId, target] of targets) {
			if (active.has(agentId)) continue;
			let observation: ActiveSemanticObservation;
			observation = startSemanticObservation(
				target,
				client,
				() => active.get(agentId) === observation,
				refreshRuntimeProjection,
				nextCensus,
			);
			active.set(agentId, observation);
		}
	};
	const unsubscribe = useStore.subscribe((state, previous) => {
		if (state.sshHosts !== previous.sshHosts) remoteConfigRevision += 1;
		if (
			state.agents !== previous.agents ||
			state.sshHosts !== previous.sshHosts ||
			state.hmuxSessionMetadata !== previous.hmuxSessionMetadata
		) {
			reconcile();
		}
	});
	reconcile();

	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		for (const observation of active.values()) observation.retire();
		active.clear();
	};
}
