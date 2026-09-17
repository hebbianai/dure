import {
	observeRuntimeConvergence,
	runtimeObservationMatchesTarget,
} from "@/lib/agents/agentRuntimeConvergence";
import {
	type AgentRuntimeCredentialAction,
	resolveAgentRuntimeCredentialPreparation,
} from "@/lib/agents/agentRuntimeCredentialSwitch";
import type { AgentRuntimeLaunchPresentation } from "@/lib/agents/agentRuntimeLaunchPresentation";
import {
	type AgentRuntimeLaunchSelectionUpdateV1,
	resolveAgentRuntimeLaunchSelectionUpdate,
} from "@/lib/agents/agentRuntimeLaunchSelection";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import {
	agentRuntimeTransitionRoute,
	assertAgentRuntimeProjectionContext,
	resolveAgentRuntimeProjectionProject,
	withAgentRuntimeProjectionContext,
} from "@/lib/agents/agentRuntimeProfileSwitch";
import {
	inspectSelectedAgentRuntimeProjection,
	inspectStructuredAgentRuntimeProjection,
} from "@/lib/agents/agentRuntimeProjectionRecovery";
import { createAgentRuntimeRepairCredentialPreparation } from "@/lib/agents/agentRuntimeRepairCredentialPreparation";
import {
	type AgentRuntimeRepairExecutionTargetV1,
	agentRuntimeRepairExecutionTarget,
	agentRuntimeReplacementResultMatches,
	type PreparedAgentRuntimeReplacementTargetV1,
	resolveAgentRuntimeReplacementTarget,
} from "@/lib/agents/agentRuntimeReplacementTarget";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import { createStructuredAgentRuntimeProjectionRecovery } from "@/lib/agents/agentRuntimeStructuredProjectionRecovery";
import type { AgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeInspectResultV1,
	type DureAgentRuntimeLaunchSelectionTargetV1,
	type DureAgentRuntimeProjectionContextV1,
	type DureAgentRuntimeProjectionInspectResultV1,
	type DureAgentRuntimeRepairIntentV1,
	DureAgentRuntimeSourceActiveError,
	type DureAgentRuntimeSourceStopPolicyV1,
	type DureAgentRuntimeTransitionIntentV1,
	type DureAgentRuntimeTransitionResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import {
	assertDureBackendRouteAuthority,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import { sameDureBackendRouteAuthority } from "@/lib/ipc/dureBackendRoute";
import { adoptCurrentManagedAgentCheckpoint } from "@/lib/sessions/managed/managedAgentCheckpointBinding";
import { convergeManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostConvergence";
import { hmuxPaneConversationId } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";

export interface AgentRuntimeTransitionRequest {
	agentId: string;
	targetInteractionProfile: "preserve" | "native_cli" | "structured_protocol";
	targetExecutionProfile?: AgentExecutionProfileV1;
	sourceStopPolicy?: DureAgentRuntimeSourceStopPolicyV1;
	expectedSourceRevision?: number;
	expectedConversationId?: string;
	targetLaunchSelection?: DureAgentRuntimeLaunchSelectionTargetV1;
	targetLaunchSelectionUpdate?: AgentRuntimeLaunchSelectionUpdateV1;
	credentialAction?: AgentRuntimeCredentialAction;
	/** Recheck a queued UI request after preparation, immediately before dispatch. */
	beforeTransition?(): void;
}

export interface AgentRuntimeTransitionObserver {
	onSourceProjection?(source: AgentRuntimeLaunchPresentation): void;
}

/** Executes one explicit runtime mutation against the backend-owned revision.
 * Every UI surface calls this action and observes the one atomic store
 * projection written from its backend receipt. */
export async function transitionAgentRuntime(
	{
		agentId,
		targetInteractionProfile,
		targetExecutionProfile,
		sourceStopPolicy = "preserve",
		expectedSourceRevision,
		expectedConversationId,
		targetLaunchSelection,
		targetLaunchSelectionUpdate,
		credentialAction,
		beforeTransition,
	}: AgentRuntimeTransitionRequest,
	observer?: AgentRuntimeTransitionObserver,
): Promise<DureAgentRuntimeTransitionResultV1> {
	const initialAgent = getAgentById(agentId);
	if (!initialAgent) throw new Error("client_agent_runtime_transition_missing");
	// A setting edit names the conversation visible at invocation. Runtime
	// generations may converge, but inspection must not turn the edit into a
	// conversation-selection action before its revision is even submitted.
	const initialConversationId =
		hmuxPaneConversationId(initialAgent.runtimeBinding) ??
		initialAgent.conversationId;
	let conversationId = expectedConversationId ?? initialConversationId;
	const assertConversation = (observed: string | null | undefined) => {
		if (conversationId !== undefined && observed !== conversationId) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
		conversationId ??= observed ?? undefined;
	};
	if (initialConversationId !== undefined)
		assertConversation(initialConversationId);
	// A replacement can outlive the frontend request that created it. Fold any
	// durable successor into the one backend-owned runtime revision before every
	// explicit mutation. Discovery is advisory for a backend-owned runtime, but
	// an unmanaged checkpoint cannot be adopted from an unobserved lineage.
	const rehostConvergence = convergeManagedAgentRehost(
		agentId,
		`agent:${agentId}`,
	);
	await rehostConvergence.catch(() => null);
	const {
		client,
		observation,
		checkpoint,
		assertSelectedAuthority,
		projectionContext,
		sourcePresentation,
	} = await observeAgentRuntimeAction(
		agentId,
		assertConversation,
		rehostConvergence,
	);
	if (sourcePresentation && observer?.onSourceProjection) {
		try {
			observer.onSourceProjection(sourcePresentation);
		} catch {
			// Presentation observers cannot participate in runtime authority.
		}
	}
	const commit = async (result: DureAgentRuntimeTransitionResultV1) => {
		if (assertSelectedAuthority) await assertSelectedAuthority();
		checkpoint();
		assertConversation(result.providerConversationRef);
		projectAgentRuntimeTransition(
			agentId,
			withAgentRuntimeProjectionContext(
				result,
				observation.routeAuthority,
				projectionContext,
			),
		);
		const committedAgent = getAgentById(agentId);
		if (!committedAgent) {
			throw new Error("client_agent_runtime_transition_missing");
		}
		return result;
	};
	let transitionIntent: DureAgentRuntimeTransitionIntentV1 | undefined;
	if (
		observation.state === "repair_required" ||
		observation.state === "transitioning"
	) {
		checkpoint();
		transitionIntent = await client.inspectTransitionIntent(observation);
		checkpoint();
	}
	const repairIntent =
		transitionIntent?.state === "repair_required"
			? transitionIntent
			: undefined;
	const mutationSource = runtimeMutationSource(observation, transitionIntent);
	const observedSourceRevision = mutationSource.selectionRevision;
	if (
		expectedSourceRevision !== undefined &&
		observedSourceRevision !== expectedSourceRevision
	) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	const sourceRevision = expectedSourceRevision ?? observedSourceRevision;
	const resolvedTargetLaunchSelection = targetLaunchSelectionUpdate
		? resolveAgentRuntimeLaunchSelectionUpdate(
				targetLaunchSelectionUpdate,
				mutationSource.launchSelection,
			)
		: targetLaunchSelection;
	const credentialContext = currentCredentialActionContext(agentId);
	const resolvedTargetInteractionProfile =
		targetInteractionProfile === "preserve"
			? mutationSource.interactionProfile
			: targetInteractionProfile;
	// Resume may prove the source account without claiming its launch generation.
	// Prepare that same account for the target; never rewrite the source's proof.
	const targetCredentialAction =
		credentialAction ??
		(targetExecutionProfile === undefined &&
		observation.state === "stable" &&
		observation.executionProfile.kind === "credential_reference" &&
		observation.executionProfile.credential_generation === null
			? { targetCredentialId: observation.executionProfile.reference_id }
			: undefined);
	const targetCredentialPreparation = targetCredentialAction
		? resolveAgentRuntimeCredentialPreparation({
				agentId,
				backendProfileId: observation.backendProfileId,
				routeAuthority: observation.routeAuthority,
				action: targetCredentialAction,
				projectionContext,
				agent: credentialContext.agent,
				accounts: credentialContext.accounts,
				sshHosts: credentialContext.sshHosts,
			})
		: undefined;
	const repairCredentialPreparation = repairIntent
		? createAgentRuntimeRepairCredentialPreparation({
				required: repairIntent,
				projectionContext,
				agent: credentialContext.agent,
				accounts: credentialContext.accounts,
				sshHosts: credentialContext.sshHosts,
			})
		: undefined;
	const credentialPreparation =
		targetCredentialPreparation ?? repairCredentialPreparation;
	const prepareCredential = async () => {
		if (!credentialPreparation) {
			throw new Error("client_agent_runtime_repair_required");
		}
		if (assertSelectedAuthority) await assertSelectedAuthority();
		checkpoint();
		return await credentialPreparation({
			routeAuthority: observation.routeAuthority,
			checkpoint,
			assertRouteAuthority: async () => {
				checkpoint();
				if (assertSelectedAuthority) {
					await assertSelectedAuthority();
				} else {
					await assertDureBackendRouteAuthority(observation.routeAuthority);
				}
				checkpoint();
			},
		});
	};
	const repairExecutionTarget = (preparedProfile?: AgentExecutionProfileV1) =>
		agentRuntimeRepairExecutionTarget(
			targetExecutionProfile,
			preparedProfile ? credentialPreparation : targetCredentialPreparation,
			preparedProfile,
		);
	const repairTarget = (execution?: AgentRuntimeRepairExecutionTargetV1) => ({
		agentId,
		routeAuthority: observation.routeAuthority,
		expectedSourceRevision: sourceRevision,
		interactionProfile: resolvedTargetInteractionProfile,
		...(execution ? { execution } : {}),
		...(resolvedTargetLaunchSelection
			? { launchSelection: resolvedTargetLaunchSelection }
			: {}),
	});
	const replacementTarget = (
		required: DureAgentRuntimeRepairIntentV1,
		preparedProfile?: AgentExecutionProfileV1,
	) =>
		resolveAgentRuntimeReplacementTarget(
			required,
			repairTarget(repairExecutionTarget(preparedProfile)),
		);
	const prepareReplacementTarget = async (
		required: DureAgentRuntimeRepairIntentV1,
	): Promise<PreparedAgentRuntimeReplacementTargetV1> => {
		let plan = replacementTarget(required);
		if (plan?.kind === "prepare_execution_profile") {
			const preparedProfile = await prepareCredential();
			checkpoint();
			plan = resolveAgentRuntimeReplacementTarget(
				required,
				repairTarget(repairExecutionTarget(preparedProfile)),
			);
		}
		if (!plan || plan.kind === "prepare_execution_profile") {
			throw new Error("client_agent_runtime_repair_required");
		}
		return plan;
	};
	let executionProfile = targetExecutionProfile;
	if (!repairIntent && targetCredentialPreparation) {
		executionProfile = await prepareCredential();
	}
	checkpoint();
	const convergenceTarget = {
		interactionProfile: resolvedTargetInteractionProfile,
		...(executionProfile ? { executionProfile } : {}),
		...(resolvedTargetLaunchSelection
			? { launchSelection: resolvedTargetLaunchSelection }
			: {}),
	};
	if (repairIntent) {
		const plan = await prepareReplacementTarget(repairIntent);
		return commit(
			await consumeRuntimeReplacement(
				client,
				repairIntent,
				plan,
				() => {
					beforeTransition?.();
					return client.transition({
						agentId,
						targetInteractionProfile: plan.target.interactionProfile,
						expectedSourceRevision: sourceRevision,
						targetExecutionProfile: plan.target.executionProfile,
						targetLaunchSelection: plan.target.launchSelection,
						routeAuthority: observation.routeAuthority,
					});
				},
				checkpoint,
				assertSelectedAuthority,
			),
		);
	}
	if (assertSelectedAuthority) await assertSelectedAuthority();
	beforeTransition?.();
	try {
		const result = await client.transition({
			agentId,
			targetInteractionProfile: resolvedTargetInteractionProfile,
			expectedSourceRevision: sourceRevision,
			targetExecutionProfile: executionProfile,
			targetLaunchSelection: resolvedTargetLaunchSelection,
			sourceStopPolicy,
			routeAuthority: observation.routeAuthority,
		});
		return commit(result);
	} catch (error) {
		if (error instanceof DureAgentRuntimeSourceActiveError) {
			throw new DureAgentRuntimeSourceActiveError(
				error.requestError,
				sourceRevision,
			);
		}
		const converged = await observeRuntimeConvergence(
			{
				inspect: () => client.inspectExact(agentId, observation.routeAuthority),
			},
			agentId,
			{ maxInspections: EXPLICIT_RUNTIME_INSPECTION_LIMIT },
		).catch(() => undefined);
		if (
			converged?.state === "stable" &&
			converged.backendProfileId === observation.backendProfileId &&
			converged.selectionRevision > sourceRevision &&
			sameDureBackendRouteAuthority(
				converged.routeAuthority,
				observation.routeAuthority,
			) &&
			runtimeObservationMatchesTarget(converged, convergenceTarget)
		) {
			validateAgentRuntimeProjection(agentId, converged);
			return commit(converged);
		}
		throw error;
	}
}

/** Preserves the currently committed interaction surface while changing its
 * credential. Spaces, detached windows, Chat, and Terminal all use this one
 * command instead of writing compatibility fields directly. */
export function switchAgentRuntimeCredential(
	agentId: string,
	targetCredentialId: string | null,
	options?: {
		sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1;
		expectedSourceRevision?: number;
		beforeTransition?(): void;
	},
) {
	return transitionAgentRuntime({
		agentId,
		targetInteractionProfile: "preserve",
		credentialAction: { targetCredentialId },
		...(options ?? {}),
	});
}

type AgentRuntimeInspection = (
	| DureAgentRuntimeInspectResultV1
	| DureAgentRuntimeProjectionInspectResultV1
) & {
	readonly projectionContext?: DureAgentRuntimeProjectionContextV1;
};
type AdmittedAgentRuntimeInspection = Extract<
	AgentRuntimeInspection,
	{ state: "transitioning" }
> & { stage: "admitted" };
type SettledAgentRuntimeInspection = Exclude<
	AgentRuntimeInspection,
	{ state: "transitioning" }
>;
type ActionableAgentRuntimeInspection =
	| Extract<AgentRuntimeInspection, { state: "stable" | "repair_required" }>
	| RestartableClosedAgentRuntimeInspection
	| AdmittedAgentRuntimeInspection;

type ClosedAgentRuntimeInspection = Extract<
	AgentRuntimeInspection,
	{ state: "closed" }
>;
type RestartableClosedAgentRuntimeInspection = ClosedAgentRuntimeInspection & {
	stage: "stopped";
	source: NonNullable<ClosedAgentRuntimeInspection["source"]>;
};

const EXPLICIT_RUNTIME_INSPECTION_LIMIT = 4;

export const recoverStructuredAgentRuntimeProjection =
	createStructuredAgentRuntimeProjectionRecovery({
		inspect: (source, expectedGeneration) =>
			inspectStructuredAgentRuntimeProjection(
				source,
				undefined,
				expectedGeneration,
			),
		isCurrentSource: (source) => {
			const profile = getAgentById(source.agentId)?.interactionProfile;
			return (
				profile?.kind === "structured_protocol" &&
				profile.backendProfileId === source.backendProfileId &&
				profile.interactionSessionId === source.interactionSessionId
			);
		},
		project: (agentId, observation) => {
			projectAgentRuntimeTransition(agentId, observation);
		},
		currentOwnerKey: (agentId) => {
			const agent = getAgentById(agentId);
			return agent ? agentRuntimePresentationOwnerKey(agent) : undefined;
		},
	});

function getAgentById(agentId: string) {
	return useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
}

function getAgentRuntimeRouteKey(agentId: string) {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	if (!agent) return undefined;
	const project = state.projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	return agentRuntimeTransitionRoute(agent, project)?.key;
}

function isRestartableClosedObservation(
	observation: AgentRuntimeInspection,
): observation is RestartableClosedAgentRuntimeInspection {
	return (
		observation.state === "closed" &&
		observation.stage === "stopped" &&
		observation.source !== undefined
	);
}

function runtimeMutationSource(
	observation: ActionableAgentRuntimeInspection,
	transitionIntent: DureAgentRuntimeTransitionIntentV1 | undefined,
) {
	if (observation.state === "stable") {
		return {
			selectionRevision: observation.selectionRevision,
			interactionProfile: observation.interactionProfile,
			launchSelection: observation.launchSelection,
		};
	}
	if (observation.state === "closed") return observation.source;
	if (transitionIntent) {
		return {
			selectionRevision: transitionIntent.sourceSelectionRevision,
			interactionProfile: transitionIntent.sourceInteractionProfile,
			launchSelection: transitionIntent.sourceLaunchSelection,
		};
	}
	throw new Error("client_agent_runtime_transition_unavailable");
}

async function observeAgentRuntimeAction(
	agentId: string,
	assertConversation: (observed: string | null | undefined) => void,
	rehostConvergence: Promise<unknown>,
): Promise<{
	client: ReturnType<typeof createDureAgentRuntimeClient>;
	observation: ActionableAgentRuntimeInspection;
	checkpoint: () => void;
	assertSelectedAuthority?: () => Promise<void>;
	projectionContext?: DureAgentRuntimeProjectionContextV1;
	sourcePresentation?: AgentRuntimeLaunchPresentation;
}> {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const project = state.projects.find(
		(candidate) => candidate.id === agent?.projectId,
	);
	if (!agent) throw new Error("client_agent_runtime_transition_missing");
	const assertCurrentConversation = () => {
		const current = getAgentById(agentId);
		if (!current) throw new Error("client_agent_runtime_transition_missing");
		assertConversation(
			hmuxPaneConversationId(current.runtimeBinding) ?? current.conversationId,
		);
	};
	assertCurrentConversation();
	const route = agentRuntimeTransitionRoute(agent, project);
	const initialRouteKey = route?.key;
	const selectedClient = route
		? createDureAgentRuntimeClient({ profileId: route.backendProfileId })
		: undefined;
	let projectionAuthority: AgentRuntimeInspection["routeAuthority"] | undefined;
	let admittedObservation: AdmittedAgentRuntimeInspection | undefined;
	const inspect = async (): Promise<AgentRuntimeInspection> => {
		let observed: AgentRuntimeInspection;
		if (selectedClient) {
			observed = await selectedClient.inspect(agentId);
		} else if (!projectionAuthority) {
			observed = await inspectSelectedAgentRuntimeProjection(agentId);
			projectionAuthority = observed.routeAuthority;
		} else {
			observed = await inspectSelectedAgentRuntimeProjection(agentId, {
				expectedRouteAuthority: projectionAuthority,
			});
		}
		admittedObservation =
			observed.state === "transitioning" && observed.stage === "admitted"
				? (observed as AdmittedAgentRuntimeInspection)
				: undefined;
		return observed;
	};
	const observeActionableState = async (): Promise<
		SettledAgentRuntimeInspection | AdmittedAgentRuntimeInspection | undefined
	> => {
		admittedObservation = undefined;
		const settled = await observeRuntimeConvergence({ inspect }, agentId, {
			maxInspections: EXPLICIT_RUNTIME_INSPECTION_LIMIT,
		});
		return settled ?? admittedObservation;
	};
	let observation = await observeActionableState();
	if (!observation) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	// A fresh native launch can learn its conversation after registration. Reuse
	// exact checkpoint admission on this explicit action; ordinary reads stay
	// probe-free, and only the backend may publish the newly observed identity.
	if (
		observation.state === "unmanaged" ||
		(observation.state === "stable" &&
			observation.interactionProfile === "native_cli" &&
			observation.providerConversationRef === null &&
			(hmuxPaneConversationId(agent.runtimeBinding) ?? agent.conversationId) !==
				undefined)
	) {
		// Reuse the settled attempt, including its exact failure. This does not
		// query Hmux again or replace an authoritative backend runtime decision.
		if (observation.state === "unmanaged") await rehostConvergence;
		assertCurrentConversation();
		await adoptCurrentManagedAgentCheckpoint(
			agentId,
			observation.routeAuthority,
		);
		observation = await observeActionableState();
		if (!observation) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
	}
	if (
		observation.state !== "stable" &&
		observation.state !== "repair_required" &&
		!isRestartableClosedObservation(observation) &&
		!(observation.state === "transitioning" && observation.stage === "admitted")
	) {
		throw new Error("client_agent_runtime_transition_unavailable");
	}
	const actionableObservation = observation;
	validateAgentRuntimeProjection(agentId, actionableObservation);
	const projectionContext = actionableObservation.projectionContext;
	const routeLessAction =
		initialRouteKey === undefined && projectionContext !== undefined;
	const assertCurrentSelectedAuthority = async () => {
		const selectedAuthority =
			await resolveSelectedDureBackendRouteAuthority(undefined);
		if (
			!sameDureBackendRouteAuthority(
				selectedAuthority,
				actionableObservation.routeAuthority,
			)
		) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
	};
	let sourcePresentation: AgentRuntimeLaunchPresentation | undefined;
	if (actionableObservation.state === "stable") {
		if (routeLessAction) {
			if (getAgentRuntimeRouteKey(agentId) !== initialRouteKey) {
				throw new Error("client_agent_runtime_transition_conflict");
			}
			await assertCurrentSelectedAuthority();
			if (getAgentRuntimeRouteKey(agentId) !== initialRouteKey) {
				throw new Error("client_agent_runtime_transition_conflict");
			}
			validateAgentRuntimeProjection(agentId, actionableObservation);
		}
		assertCurrentConversation();
		assertConversation(actionableObservation.providerConversationRef);
		sourcePresentation = projectAgentRuntimeTransition(
			agentId,
			actionableObservation,
		);
		// A late committed observation can converge, but cannot authorize a new
		// mutation from a source older than the projector's current selection.
		if (
			sourcePresentation.selectionRevision >
			actionableObservation.selectionRevision
		) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
	}
	const routeKey = getAgentRuntimeRouteKey(agentId);
	if (!routeKey && !projectionContext) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	const checkpoint = () => {
		assertCurrentConversation();
		const currentRouteKey = getAgentRuntimeRouteKey(agentId);
		if (routeKey) {
			if (currentRouteKey !== routeKey) {
				throw new Error("client_agent_runtime_transition_conflict");
			}
			return;
		}
		if (currentRouteKey !== undefined) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
		validateAgentRuntimeProjection(agentId, actionableObservation);
	};
	const assertSelectedAuthority = routeLessAction
		? async () => {
				checkpoint();
				await assertCurrentSelectedAuthority();
				checkpoint();
			}
		: undefined;
	return {
		client: createDureAgentRuntimeClient({
			profileId: actionableObservation.backendProfileId,
		}),
		observation: actionableObservation,
		checkpoint,
		...(assertSelectedAuthority ? { assertSelectedAuthority } : {}),
		...(projectionContext ? { projectionContext } : {}),
		...(sourcePresentation ? { sourcePresentation } : {}),
	};
}

async function consumeRuntimeReplacement(
	client: ReturnType<typeof createDureAgentRuntimeClient>,
	required: DureAgentRuntimeRepairIntentV1,
	plan: PreparedAgentRuntimeReplacementTargetV1,
	request: () => Promise<DureAgentRuntimeTransitionResultV1>,
	checkpoint: () => void,
	assertSelectedAuthority?: () => Promise<void>,
): Promise<DureAgentRuntimeTransitionResultV1> {
	if (assertSelectedAuthority) await assertSelectedAuthority();
	checkpoint();
	try {
		const result = await request();
		checkpoint();
		if (!agentRuntimeReplacementResultMatches(required, plan, result)) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
		return result;
	} catch (error) {
		const converged = await observeRuntimeConvergence(
			{
				inspect: () =>
					client.inspectExact(required.agentId, required.routeAuthority),
			},
			required.agentId,
			{ maxInspections: EXPLICIT_RUNTIME_INSPECTION_LIMIT },
		).catch(() => undefined);
		if (
			converged?.state === "stable" &&
			agentRuntimeReplacementResultMatches(required, plan, converged)
		) {
			checkpoint();
			return converged;
		}
		throw error;
	}
}

function currentCredentialActionContext(agentId: string) {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	return {
		agent,
		accounts: state.accounts,
		sshHosts: state.sshHosts,
	};
}

function validateAgentRuntimeProjection(
	agentId: string,
	observation: AgentRuntimeInspection,
) {
	const projectionContext = observation.projectionContext;
	if (!projectionContext) return;
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const project = agent
		? resolveAgentRuntimeProjectionProject(
				agent,
				state.projects,
				projectionContext,
				observation.routeAuthority,
				state.sshHosts,
			)
		: undefined;
	if (!agent || !project) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	assertAgentRuntimeProjectionContext(agent, project, {
		projectionContext,
		routeAuthority: observation.routeAuthority,
		sshHosts: state.sshHosts,
	});
}
