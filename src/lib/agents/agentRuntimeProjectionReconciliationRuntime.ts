import { observeRuntimeConvergence } from "@/lib/agents/agentRuntimeConvergence";
import {
	hasPositiveAgentRuntimeObservation,
	isExitedHmuxSession,
} from "@/lib/agents/agentRuntimeLiveness";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { agentRuntimeTransitionRoute } from "@/lib/agents/agentRuntimeProfileSwitch";
import {
	type AgentRuntimeProjectionInspectionSourceV1,
	inspectAgentRuntimeProjection,
} from "@/lib/agents/agentRuntimeProjectionInspection";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import { convergeUnmanagedAgentSuccessor } from "@/lib/agents/agentRuntimeUnmanagedSuccessor";
import { subscribeHmuxControlPlaneCensus } from "@/lib/hmux/identity/hmuxControlPlaneCensusFeed";
import {
	HMUX_MANAGED_GENERATION_FIELDS,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxControlPlaneCensus, HmuxSessionSummary } from "@/lib/ipc";
import type { DureAgentRuntimeInspectResultV1 } from "@/lib/ipc/dureAgentRuntime";
import { assertExactDureBackendProjectTarget } from "@/lib/ipc/dureBackendRoute";
import { useStore } from "@/store";
import type { Agent } from "@/types";

type StoreSnapshot = ReturnType<typeof useStore.getState>;
type StableRuntimeProjection = Extract<
	DureAgentRuntimeInspectResultV1,
	{ state: "stable" }
>;

export interface AgentRuntimeProjectionRefreshHintV1 {
	readonly agentId: string;
	/** Replaceable evidence identity. Equal evidence for the same exact source
	 * is handled once; a later source generation receives a new lease. */
	readonly evidence: string;
}

export interface AgentRuntimeProjectionReconciler {
	request(hint: AgentRuntimeProjectionRefreshHintV1): void;
	stop(): void;
}

interface ProjectionSource extends AgentRuntimeProjectionInspectionSourceV1 {
	readonly key: string;
}

interface ActiveReconciliation {
	readonly evidence: string;
	pendingEvidence?: string;
}

interface HandledEvidence {
	readonly sourceKey: string;
	readonly evidence: string;
}

interface AgentRuntimeProjectionReconciliationDependencies {
	subscribeCensus(
		listener: (census: HmuxControlPlaneCensus) => void,
	): () => void;
	snapshot(): StoreSnapshot;
	inspect(
		source: AgentRuntimeProjectionInspectionSourceV1,
	): Promise<DureAgentRuntimeInspectResultV1>;
	project(agentId: string, projection: StableRuntimeProjection): void;
	convergeUnmanaged: typeof convergeUnmanagedAgentSuccessor;
	warn(error: unknown): void;
}

const defaultDependencies: AgentRuntimeProjectionReconciliationDependencies = {
	subscribeCensus: subscribeHmuxControlPlaneCensus,
	snapshot: () => useStore.getState(),
	inspect: inspectAgentRuntimeProjection,
	project: projectAgentRuntimeTransition,
	convergeUnmanaged: convergeUnmanagedAgentSuccessor,
	warn: (error) =>
		console.warn("[agent runtime projection reconciliation]", error),
};

const PASSIVE_RUNTIME_INSPECTION_LIMIT = 8;

function sourceForAgent(
	snapshot: StoreSnapshot,
	agentId: string,
): ProjectionSource | undefined {
	const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
	const binding = agent?.runtimeBinding;
	if (
		!agent ||
		agent.interactionProfile !== undefined ||
		binding?.runtime !== "hmux_managed_v1"
	) {
		return undefined;
	}
	const project = snapshot.projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	const route = agentRuntimeTransitionRoute(agent, project);
	if (!route) return undefined;
	return {
		agentId,
		backendProfileId: route.backendProfileId,
		key: `${route.key}\0${agentRuntimePresentationOwnerKey(agent)}`,
	};
}

function retiredLocalSourceEvidence(
	snapshot: StoreSnapshot,
	agent: Agent,
	sessions: readonly HmuxSessionSummary[],
): string | undefined {
	const binding = agent.runtimeBinding;
	if (
		agent.interactionProfile !== undefined ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local"
	) {
		return undefined;
	}
	if (agent.sessionId !== binding.sessionId) {
		return JSON.stringify(["agent_session_replaced", binding.sessionId]);
	}
	const session = sessions.find(
		(candidate) =>
			candidate.sessionId === binding.sessionId &&
			candidate.workspaceId === binding.workspaceId,
	);
	if (!session) {
		if (
			hasPositiveAgentRuntimeObservation({
				agent,
				agentActivity: snapshot.agentActivity,
				sessionAgentRuntimeState: snapshot.sessionAgentRuntimeState,
			})
		) {
			return undefined;
		}
		return JSON.stringify([
			"session_absent",
			binding.sessionId,
			liveWorkspaceSessionIds(binding, sessions),
		]);
	}
	const generationChanged =
		session.health === "generation_changed" ||
		(binding.stopFence !== undefined &&
			session.terminalEpoch !== binding.stopFence.terminalEpoch) ||
		(binding.stopFence !== undefined &&
			session.stopFence !== undefined &&
			!sameHmuxManagedGeneration(binding.stopFence, session.stopFence));
	if (
		!isExitedHmuxSession(session) &&
		session.lifecycle === "ready" &&
		session.sessionClass !== "standalone" &&
		session.hostProcessAlive !== false &&
		!generationChanged
	) {
		return undefined;
	}
	return JSON.stringify([
		"session_retired",
		session.sessionId,
		session.terminalEpoch,
		session.sessionClass ?? null,
		session.lifecycle,
		session.manifestLifecycle ?? null,
		session.health ?? null,
		session.hostProcessAlive ?? null,
		session.inputAllowed ?? null,
		session.outputSeq,
		session.stopFence
			? HMUX_MANAGED_GENERATION_FIELDS.map(
					(field) => session.stopFence?.[field] ?? null,
				)
			: null,
		liveWorkspaceSessionIds(binding, sessions),
	]);
}

/** Another client (the CLI's runtime wake, a rehost elsewhere) can start the
 * Agent on a new root in the same runtime workspace without notifying this
 * window. A new live session there is fresh evidence to re-read the backend. */
function liveWorkspaceSessionIds(
	binding: { sessionId: string; workspaceId: string },
	sessions: readonly HmuxSessionSummary[],
): string[] {
	return sessions
		.filter(
			(session) =>
				session.workspaceId === binding.workspaceId &&
				session.sessionId !== binding.sessionId &&
				session.sessionClass !== "standalone" &&
				session.lifecycle === "ready" &&
				!isExitedHmuxSession(session),
		)
		.map((session) => session.sessionId)
		.sort();
}

function assertCurrentProjectionTarget(
	snapshot: StoreSnapshot,
	source: ProjectionSource,
	projection: Pick<DureAgentRuntimeInspectResultV1, "routeAuthority">,
): void {
	const agent = snapshot.agents.find(
		(candidate) => candidate.id === source.agentId,
	);
	const project = snapshot.projects.find(
		(candidate) => candidate.id === agent?.projectId,
	);
	if (
		!agent ||
		!project ||
		sourceForAgent(snapshot, agent.id)?.key !== source.key
	) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	assertExactDureBackendProjectTarget(
		projection.routeAuthority,
		project,
		snapshot.sshHosts,
		(code, message) => {
			throw new Error(`${code}: ${message}`);
		},
	);
}

function isCurrentNativeProjection(
	snapshot: StoreSnapshot,
	source: ProjectionSource,
	projection: StableRuntimeProjection,
): boolean {
	if (projection.interactionProfile !== "native_cli") return false;
	const agent = snapshot.agents.find(
		(candidate) => candidate.id === source.agentId,
	);
	const binding = agent?.runtimeBinding;
	return (
		agent?.sessionId === projection.sessionId &&
		binding?.runtime === "hmux_managed_v1" &&
		binding.sessionId === projection.sessionId &&
		binding.workspaceId === projection.workspaceId &&
		(projection.launchIdempotencyKey === null ||
			binding.createIdempotencyKey === projection.launchIdempotencyKey) &&
		sameHmuxManagedGeneration(binding.stopFence, projection.stopFence)
	);
}

/** Reconciles only native sources that Hmux has already proven suspect. Hmux
 * never chooses Chat or Terminal here: its complete census and semantic
 * observer schedule an inspection. An unmanaged backend can adopt an already
 * completed Hmux successor; it cannot launch a replacement. Existing backend
 * state remains authoritative and uses the shared store projector. */
export function installAgentRuntimeProjectionReconciliationRuntime(
	dependencies: AgentRuntimeProjectionReconciliationDependencies = defaultDependencies,
): AgentRuntimeProjectionReconciler {
	let disposed = false;
	const active = new Map<string, ActiveReconciliation>();
	const handledEvidence = new Map<string, HandledEvidence>();

	const isCurrent = (source: ProjectionSource) =>
		!disposed &&
		sourceForAgent(dependencies.snapshot(), source.agentId)?.key === source.key;

	const request = (hint: AgentRuntimeProjectionRefreshHintV1) => {
		if (disposed) return;
		const source = sourceForAgent(dependencies.snapshot(), hint.agentId);
		const handled = handledEvidence.get(hint.agentId);
		if (
			!source ||
			(handled?.sourceKey === source.key && handled.evidence === hint.evidence)
		) {
			return;
		}
		const existing = active.get(source.key);
		if (existing) {
			if (existing.evidence !== hint.evidence) {
				existing.pendingEvidence = hint.evidence;
			}
			return;
		}
		const reconciliation: ActiveReconciliation = {
			evidence: hint.evidence,
		};
		active.set(source.key, reconciliation);
		const recovery = (async () => {
			const observation = await observeRuntimeConvergence(
				{ inspect: () => dependencies.inspect(source) },
				source.agentId,
				{
					maxInspections: PASSIVE_RUNTIME_INSPECTION_LIMIT,
					shouldContinue: () => isCurrent(source),
				},
			);
			if (!observation || !isCurrent(source)) return false;
			if (observation.state === "unmanaged") {
				assertCurrentProjectionTarget(
					dependencies.snapshot(),
					source,
					observation,
				);
				return dependencies.convergeUnmanaged(source, observation, () =>
					isCurrent(source),
				);
			}
			if (observation.state === "stable") {
				const snapshot = dependencies.snapshot();
				assertCurrentProjectionTarget(snapshot, source, observation);
				if (!isCurrentNativeProjection(snapshot, source, observation)) {
					dependencies.project(source.agentId, observation);
				}
			}
			return true;
		})();
		void recovery
			.then((handled) => {
				if (handled) {
					handledEvidence.set(source.agentId, {
						sourceKey: source.key,
						evidence: reconciliation.evidence,
					});
				}
			})
			.catch((error) => {
				if (!disposed && isCurrent(source)) dependencies.warn(error);
			})
			.finally(() => {
				if (active.get(source.key) === reconciliation) {
					active.delete(source.key);
				}
				if (reconciliation.pendingEvidence && isCurrent(source)) {
					request({
						agentId: source.agentId,
						evidence: reconciliation.pendingEvidence,
					});
				}
			});
	};

	const stopCensus = dependencies.subscribeCensus((census) => {
		const snapshot = dependencies.snapshot();
		const agents = snapshot.agents;
		const currentAgentIds = new Set(agents.map((agent) => agent.id));
		for (const agentId of handledEvidence.keys()) {
			if (!currentAgentIds.has(agentId)) handledEvidence.delete(agentId);
		}
		for (const agent of agents) {
			const evidence = retiredLocalSourceEvidence(
				snapshot,
				agent,
				census.sessions,
			);
			if (evidence) request({ agentId: agent.id, evidence });
		}
	});

	return {
		request,
		stop: () => {
			if (disposed) return;
			disposed = true;
			stopCensus();
			active.clear();
			handledEvidence.clear();
		},
	};
}
