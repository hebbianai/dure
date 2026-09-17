import { observeRuntimeConvergence } from "@/lib/agents/agentRuntimeConvergence";
import type {
	StructuredAgentRuntimeProjectionGenerationV1,
	StructuredAgentRuntimeProjectionSourceV1,
} from "@/lib/agents/agentRuntimeProjectionRecovery";
import { sameAgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	type HmuxManagedGenerationV1,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	DureAgentRuntimeInspectResultV1,
	DureAgentRuntimeTransitionResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";

export interface RecoveredStructuredAgentRuntimeProjection {
	readonly launchSelection: DureAgentRuntimeTransitionResultV1["launchSelection"];
	readonly ownerKey: string;
	readonly selectionRevision: number;
}

export type StructuredAgentRuntimeProjectionRecoveryRequestV1 =
	| {
			readonly kind: "initial_attach";
			readonly signal: AbortSignal;
	  }
	| {
			readonly kind: "observed_generation";
			readonly generation: StructuredAgentRuntimeProjectionGenerationV1;
	  };

type StableStructuredRuntimeObservation = Extract<
	DureAgentRuntimeInspectResultV1,
	{ state: "stable" }
>;

interface ProjectionAuthorityBaseV1 {
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	readonly selectionRevision: number;
	readonly providerId: string;
	readonly executionProfile: StableStructuredRuntimeObservation["executionProfile"];
	readonly providerConversationRef: string | null;
}

type StructuredProjectionAuthorityV1 = ProjectionAuthorityBaseV1 &
	(
		| {
				readonly interactionProfile: "structured_protocol";
				readonly bindingRevision: number;
				readonly runtimeGeneration: string;
				readonly providerEpoch: string;
				readonly timelineEpoch: string;
		  }
		| {
				readonly interactionProfile: "native_cli";
				readonly sessionId: string;
				readonly workspaceId: string;
				readonly launchIdempotencyKey: string | null;
				readonly stopFence: HmuxManagedGenerationV1;
		  }
	);

interface StructuredProjectionRecoveryState {
	readonly source: StructuredAgentRuntimeProjectionSourceV1;
	readonly inFlight: Map<string, StructuredProjectionRecoveryInFlight>;
	lastAccepted?: {
		readonly authority: StructuredProjectionAuthorityV1;
		readonly recovered: RecoveredStructuredAgentRuntimeProjection;
	};
}

interface StructuredProjectionRecoveryInFlight {
	readonly attachSignals: Set<AbortSignal>;
	readonly promise: Promise<
		RecoveredStructuredAgentRuntimeProjection | undefined
	>;
}

interface StructuredAgentRuntimeProjectionRecoveryDependencies {
	inspect(
		source: StructuredAgentRuntimeProjectionSourceV1,
		expectedGeneration?: StructuredAgentRuntimeProjectionGenerationV1,
	): Promise<DureAgentRuntimeInspectResultV1>;
	isCurrentSource(source: StructuredAgentRuntimeProjectionSourceV1): boolean;
	project(
		agentId: string,
		observation: StableStructuredRuntimeObservation,
	): void;
	currentOwnerKey(agentId: string): string | undefined;
}

function sourceKey(source: StructuredAgentRuntimeProjectionSourceV1): string {
	return JSON.stringify([
		source.agentId,
		source.backendProfileId,
		source.interactionSessionId,
	]);
}

function recoveryRequestKey(
	request: StructuredAgentRuntimeProjectionRecoveryRequestV1,
): string {
	if (request.kind === "initial_attach") return "initial_attach";
	const expected = request.generation;
	return JSON.stringify([
		expected.routeAuthority,
		expected.bindingRevision,
		expected.runtimeGeneration,
		expected.providerEpoch,
	]);
}

function hasActiveAttach(attachSignals: ReadonlySet<AbortSignal>): boolean {
	for (const signal of attachSignals) {
		if (!signal.aborted) return true;
	}
	return false;
}

function projectionAuthority(
	observation: StableStructuredRuntimeObservation,
): StructuredProjectionAuthorityV1 | undefined {
	const base = {
		routeAuthority: observation.routeAuthority,
		selectionRevision: observation.selectionRevision,
		providerId: observation.providerId,
		executionProfile: observation.executionProfile,
		providerConversationRef: observation.providerConversationRef,
	};
	if (observation.interactionProfile === "native_cli") {
		return {
			...base,
			interactionProfile: "native_cli",
			sessionId: observation.sessionId,
			workspaceId: observation.workspaceId,
			launchIdempotencyKey: observation.launchIdempotencyKey,
			stopFence: observation.stopFence,
		};
	}
	if (
		!observation.binding ||
		observation.interactionSessionId !==
			observation.binding.interactionSessionId ||
		observation.agentId !== observation.binding.agentId ||
		observation.providerId !== observation.binding.providerId ||
		!sameAgentExecutionProfileV1(
			observation.executionProfile,
			observation.binding.executionProfile,
		) ||
		observation.providerConversationRef !==
			observation.binding.providerConversationRef
	) {
		return undefined;
	}
	return {
		...base,
		interactionProfile: "structured_protocol",
		bindingRevision: observation.binding.bindingRevision,
		runtimeGeneration: observation.binding.runtime.runtimeGeneration,
		providerEpoch: observation.binding.runtime.providerEpoch,
		timelineEpoch: observation.binding.timelineEpoch,
		providerConversationRef: observation.binding.providerConversationRef,
	};
}

function acknowledges(
	candidate: StructuredProjectionAuthorityV1,
	expected: StructuredAgentRuntimeProjectionGenerationV1,
): boolean {
	if (candidate.interactionProfile === "native_cli") return true;
	return (
		candidate.bindingRevision > expected.bindingRevision ||
		(candidate.bindingRevision === expected.bindingRevision &&
			candidate.runtimeGeneration === expected.runtimeGeneration &&
			candidate.providerEpoch === expected.providerEpoch)
	);
}

/** Returns whether `candidate` may replace `committed`, and whether it
 * materially advances the projection. Equal revisions must carry equal
 * binding/runtime fences; conflicting equal revisions are never guessed at. */
function compareProjectionAuthority(
	committed: StructuredProjectionAuthorityV1 | undefined,
	candidate: StructuredProjectionAuthorityV1,
): "advance" | "current" | "stale" {
	if (!committed) return "advance";
	if (
		!sameDureBackendRouteAuthority(
			candidate.routeAuthority,
			committed.routeAuthority,
		)
	) {
		return "advance";
	}
	if (candidate.selectionRevision < committed.selectionRevision) return "stale";
	if (candidate.selectionRevision > committed.selectionRevision)
		return "advance";
	if (
		candidate.interactionProfile !== committed.interactionProfile ||
		candidate.providerId !== committed.providerId ||
		candidate.providerConversationRef !== committed.providerConversationRef ||
		!sameAgentExecutionProfileV1(
			candidate.executionProfile,
			committed.executionProfile,
		)
	) {
		return "stale";
	}
	if (
		candidate.interactionProfile === "native_cli" &&
		committed.interactionProfile === "native_cli"
	) {
		return candidate.sessionId === committed.sessionId &&
			candidate.workspaceId === committed.workspaceId &&
			candidate.launchIdempotencyKey === committed.launchIdempotencyKey &&
			sameHmuxManagedGeneration(candidate.stopFence, committed.stopFence)
			? "current"
			: "stale";
	}
	if (
		candidate.interactionProfile !== "structured_protocol" ||
		committed.interactionProfile !== "structured_protocol" ||
		candidate.bindingRevision < committed.bindingRevision
	) {
		return "stale";
	}
	if (candidate.bindingRevision > committed.bindingRevision) return "advance";
	return candidate.runtimeGeneration === committed.runtimeGeneration &&
		candidate.providerEpoch === committed.providerEpoch &&
		candidate.timelineEpoch === committed.timelineEpoch
		? "current"
		: "stale";
}

/** Coalesces equal initial-attach or generation requests. A transitioning
 * backend is the promise of a newer authoritative snapshot, so recovery waits
 * on that one backend state machine instead of leaving the persisted pane on
 * its retired surface. */
export function createStructuredAgentRuntimeProjectionRecovery(
	dependencies: StructuredAgentRuntimeProjectionRecoveryDependencies,
) {
	const recoveries = new Map<string, StructuredProjectionRecoveryState>();
	const pruneInactiveRecoveries = () => {
		for (const [key, state] of recoveries) {
			if (
				state.inFlight.size === 0 &&
				!dependencies.isCurrentSource(state.source)
			) {
				recoveries.delete(key);
			}
		}
	};
	const acknowledgedSnapshot = (
		state: StructuredProjectionRecoveryState,
		expected: StructuredAgentRuntimeProjectionGenerationV1,
	) => {
		const accepted = state.lastAccepted;
		if (!accepted) return undefined;
		if (accepted.authority.interactionProfile === "native_cli") {
			return accepted.recovered;
		}
		if (
			!dependencies.isCurrentSource(state.source) ||
			!sameDureBackendRouteAuthority(
				accepted.authority.routeAuthority,
				expected.routeAuthority,
			) ||
			!acknowledges(accepted.authority, expected)
		) {
			return undefined;
		}
		const ownerKey = dependencies.currentOwnerKey(state.source.agentId);
		return ownerKey ? { ...accepted.recovered, ownerKey } : undefined;
	};
	const acceptObservation = (
		state: StructuredProjectionRecoveryState,
		observation: DureAgentRuntimeInspectResultV1 | undefined,
		expected?: StructuredAgentRuntimeProjectionGenerationV1,
	): RecoveredStructuredAgentRuntimeProjection | undefined => {
		const { source } = state;
		if (
			observation?.state !== "stable" ||
			observation.agentId !== source.agentId ||
			observation.backendProfileId !== source.backendProfileId ||
			!dependencies.isCurrentSource(source)
		) {
			return undefined;
		}
		const candidate = projectionAuthority(observation);
		if (!candidate || (expected && !acknowledges(candidate, expected))) {
			return undefined;
		}
		const comparison = compareProjectionAuthority(
			state.lastAccepted?.authority,
			candidate,
		);
		if (comparison === "stale") return undefined;
		if (comparison === "advance") {
			dependencies.project(source.agentId, observation);
		}
		const ownerKey = dependencies.currentOwnerKey(source.agentId);
		if (!ownerKey) return undefined;
		const recovered = {
			launchSelection: observation.launchSelection,
			ownerKey,
			selectionRevision: observation.selectionRevision,
		};
		if (comparison === "advance") {
			state.lastAccepted = { authority: candidate, recovered };
		}
		return recovered;
	};
	return function recoverStructuredAgentRuntimeProjection(
		source: StructuredAgentRuntimeProjectionSourceV1,
		request: StructuredAgentRuntimeProjectionRecoveryRequestV1,
	): Promise<RecoveredStructuredAgentRuntimeProjection | undefined> {
		if (request.kind === "initial_attach" && request.signal.aborted) {
			return Promise.resolve(undefined);
		}
		pruneInactiveRecoveries();
		const key = sourceKey(source);
		let state = recoveries.get(key);
		if (!state) {
			state = { source, inFlight: new Map() };
			recoveries.set(key, state);
		}
		if (request.kind === "observed_generation") {
			const accepted = acknowledgedSnapshot(state, request.generation);
			if (accepted) return Promise.resolve(accepted);
		}
		const requestKey = recoveryRequestKey(request);
		let existing = state.inFlight.get(requestKey);
		if (
			existing &&
			request.kind === "initial_attach" &&
			!hasActiveAttach(existing.attachSignals)
		) {
			state.inFlight.delete(requestKey);
			existing = undefined;
		}
		if (existing) {
			if (request.kind === "initial_attach") {
				existing.attachSignals.add(request.signal);
			}
			return existing.promise;
		}

		const attachSignals = new Set(
			request.kind === "initial_attach" ? [request.signal] : [],
		);
		const expectedGeneration =
			request.kind === "observed_generation" ? request.generation : undefined;
		const initialAttach = expectedGeneration
			? state.inFlight.get("initial_attach")
			: undefined;

		const recovery = (async () => {
			if (expectedGeneration && initialAttach) {
				const attached = await initialAttach.promise.catch(() => undefined);
				if (attached) {
					const accepted = acknowledgedSnapshot(state, expectedGeneration);
					if (accepted) return accepted;
				}
			}
			if (!dependencies.isCurrentSource(source)) return undefined;
			const observation =
				request.kind === "initial_attach"
					? await observeRuntimeConvergence(
							{
								inspect: () => dependencies.inspect(source),
							},
							source.agentId,
							{
								shouldContinue: () =>
									dependencies.isCurrentSource(source) &&
									hasActiveAttach(attachSignals),
							},
						)
					: await dependencies.inspect(source, expectedGeneration);
			return acceptObservation(state, observation, expectedGeneration);
		})();
		const inFlight: StructuredProjectionRecoveryInFlight = {
			attachSignals,
			promise: recovery,
		};
		state.inFlight.set(requestKey, inFlight);
		const clear = () => {
			if (state.inFlight.get(requestKey) === inFlight) {
				state.inFlight.delete(requestKey);
			}
			if (
				state.inFlight.size === 0 &&
				!dependencies.isCurrentSource(state.source) &&
				recoveries.get(key) === state
			) {
				recoveries.delete(key);
			}
		};
		void recovery.then(clear, clear);
		return recovery;
	};
}
