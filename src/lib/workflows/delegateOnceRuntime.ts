import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { t } from "@/lib/i18n";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	createDureOrchestrationTransport,
	type DispatchContextReceiptV1,
	DureOrchestrationError,
	type DureOrchestrationTransport,
	type OpenInteractionReceiptV1,
	type OrchestrationSessionGenerationV1,
} from "@/lib/ipc/dureOrchestration";
import {
	createDureWorkflowTransport,
	DureWorkflowError,
	type DureWorkflowTransport,
} from "@/lib/ipc/dureWorkflow";
import {
	beginDelegateOnceIntent,
	completeDelegateOnceIntent,
	type DelegateOnceIntentStorage,
	type DelegateOnceIntentV1,
	delegateOnceContributionId,
	type ExistingDelegateTargetContextV1,
	type NewDelegateOnceIntent,
	projectDelegateOnceWorker,
	readDelegateOnceIntents,
	recordDelegateOnceBinding,
	recordDelegateOnceRouteAuthority,
	recordExistingDelegateTargetContext,
} from "@/lib/workflows/delegateOnce";
import { openAgentPanel } from "@/lib/workspace/dock";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export interface DelegateOnceRuntimeDependencies {
	storage?: DelegateOnceIntentStorage;
	transport?: DureWorkflowTransport;
	orchestrationTransport?: DureOrchestrationTransport;
	resolveRouteAuthority?: () => Promise<DureBackendRouteAuthorityV1>;
	resolveAgents?: () => readonly Agent[];
	projectExistingTarget?: (
		intent: DelegateOnceIntentV1,
		context: DispatchContextReceiptV1,
		receipt: OpenInteractionReceiptV1,
	) => Agent;
	projectWorker?: (
		intent: DelegateOnceIntentV1,
		receipt: Awaited<ReturnType<DureWorkflowTransport["delegateOnce"]>>,
	) => Agent;
}

function isTerminalOperationFailure(error: unknown): boolean {
	return (
		(error instanceof DureOrchestrationError ||
			error instanceof DureWorkflowError) &&
		error.failure.kind === "operation" &&
		error.failure.disposition === "terminal"
	);
}

function exactExistingTarget(
	intent: DelegateOnceIntentV1,
	agents: readonly Agent[],
): Agent {
	const target = intent.target;
	if (!target)
		throw new Error(t("workflows.delegation.existingAgentTargetMissing"));
	const matches = agents.filter((agent) => agent.id === target.agentId);
	if (matches.length !== 1) {
		throw new Error(t("workflows.delegation.selectedAgentNotSinglePane"));
	}
	const [agent] = matches;
	const binding = agent?.runtimeBinding;
	const projected = agent?.workflowDispatch;
	const expectedDispatch = target.context;
	if (
		!agent ||
		agent.projectId !== target.projectId ||
		agent.provider !== target.providerId ||
		agent.sessionId !== target.sessionId ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		binding.sessionId !== target.sessionId ||
		binding.workspaceId !== target.workspaceId ||
		!binding.stopFence ||
		!sameHmuxManagedGeneration(binding.stopFence, target.stopFence) ||
		(projected !== undefined &&
			(!expectedDispatch ||
				projected.taskId !== expectedDispatch.taskId ||
				projected.dispatchId !== expectedDispatch.dispatchId ||
				projected.generation !== expectedDispatch.generation))
	) {
		throw new Error(
			t("workflows.delegation.selectedAgentSessionGenerationChanged"),
		);
	}
	const sameGenerationOwners = agents.filter((candidate) => {
		const candidateBinding = candidate.runtimeBinding;
		return (
			candidate.id !== agent.id &&
			candidate.sessionId === target.sessionId &&
			candidateBinding?.runtime === "hmux_managed_v1" &&
			candidateBinding.source === "local" &&
			candidateBinding.workspaceId === target.workspaceId &&
			candidateBinding.stopFence !== undefined &&
			sameHmuxManagedGeneration(candidateBinding.stopFence, target.stopFence)
		);
	});
	if (sameGenerationOwners.length > 0) {
		throw new Error(t("workflows.delegation.sessionGenerationMultiplePanes"));
	}
	return agent;
}

function targetSession(
	intent: DelegateOnceIntentV1,
): OrchestrationSessionGenerationV1 {
	const target = intent.target;
	if (!target)
		throw new Error(t("workflows.delegation.existingAgentTargetMissing"));
	return {
		sessionId: target.sessionId,
		workspaceId: target.workspaceId,
		providerId: target.providerId,
		...target.stopFence,
	};
}

function persistedTargetContext(
	context: DispatchContextReceiptV1,
): ExistingDelegateTargetContextV1 {
	return {
		runId: context.target.runId,
		taskId: context.target.taskId,
		dispatchId: context.target.dispatchId,
		generation: context.target.generation,
		endpointRef: context.endpointFence.endpointRef,
		sessionIdentity: context.endpointFence.sessionIdentity,
		endpointGeneration: context.endpointFence.generation,
		workerParticipant: context.participant,
		coordinatorParticipant: context.coordinatorGrant.participant,
	};
}

function samePersistedTargetContext(
	left: ExistingDelegateTargetContextV1,
	right: ExistingDelegateTargetContextV1,
): boolean {
	return (
		left.runId === right.runId &&
		left.taskId === right.taskId &&
		left.dispatchId === right.dispatchId &&
		left.generation === right.generation &&
		left.endpointRef === right.endpointRef &&
		left.sessionIdentity === right.sessionIdentity &&
		left.endpointGeneration === right.endpointGeneration &&
		left.workerParticipant === right.workerParticipant &&
		left.coordinatorParticipant === right.coordinatorParticipant
	);
}

function assignmentIdentity(idempotencyKey: string): {
	idempotencyKey: string;
	interactionId: string;
} {
	const suffix = idempotencyKey.replace(/^delegate-once-/u, "");
	return {
		idempotencyKey: `assignment-open-${suffix}`,
		interactionId: `assignment-${suffix}`,
	};
}

function projectExistingTarget(
	intent: DelegateOnceIntentV1,
	context: DispatchContextReceiptV1,
): Agent {
	let projected: Agent | undefined;
	useStore.setState((state) => {
		const current = exactExistingTarget(intent, state.agents);
		const next: Agent = {
			...current,
			workflowDispatch: {
				schemaVersion: 1,
				taskId: context.target.taskId,
				dispatchId: context.target.dispatchId,
				generation: context.target.generation,
			},
		};
		projected = next;
		return {
			agents: state.agents.map((agent) =>
				agent.id === current.id ? next : agent,
			),
			agentActivity: { ...state.agentActivity, [current.id]: "working" },
		};
	});
	if (!projected) {
		throw new Error(t("workflows.delegation.existingAgentTargetCommitFailed"));
	}
	return projected;
}

async function executeExistingTargetIntent(
	initial: DelegateOnceIntentV1,
	dependencies: DelegateOnceRuntimeDependencies,
): Promise<Agent> {
	const routeAuthority = initial.routeAuthority;
	if (!routeAuthority) {
		throw new Error(t("workflows.delegation.storedRequestInvalidFormat"));
	}
	const orchestration =
		dependencies.orchestrationTransport ?? createDureOrchestrationTransport();
	const resolveAgents =
		dependencies.resolveAgents ?? (() => useStore.getState().agents);
	let intent = initial;
	try {
		exactExistingTarget(intent, resolveAgents());
	} catch (error) {
		completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
		throw error;
	}
	let call: Awaited<
		ReturnType<DureOrchestrationTransport["getExactDispatchContext"]>
	>;
	try {
		call = await orchestration.getExactDispatchContext(
			routeAuthority,
			targetSession(intent),
		);
	} catch (error) {
		if (isTerminalOperationFailure(error)) {
			completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
		}
		throw error;
	}
	if (!intent.target?.context) {
		intent = recordExistingDelegateTargetContext(
			intent,
			persistedTargetContext(call.receipt),
			dependencies.storage,
		);
		try {
			exactExistingTarget(intent, resolveAgents());
		} catch (error) {
			completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
			throw error;
		}
	}
	const persisted = intent.target?.context;
	const observed = persistedTargetContext(call.receipt);
	if (!persisted || !samePersistedTargetContext(persisted, observed)) {
		completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
		throw new Error(
			t("workflows.delegation.selectedAgentDispatchGenerationChanged"),
		);
	}
	const context = call.receipt;

	try {
		exactExistingTarget(intent, resolveAgents());
	} catch (error) {
		completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
		throw error;
	}
	const identity = assignmentIdentity(intent.idempotencyKey);
	let receipt: OpenInteractionReceiptV1;
	try {
		receipt = (
			await orchestration.openExactSessionMessage(routeAuthority, {
				schemaVersion: 1,
				session: targetSession(intent),
				expectedEndpointRef: context.endpointFence.endpointRef,
				...identity,
				title: intent.task.summary,
				descriptionMarkdown: intent.task.instructions,
				openedAtMs: intent.createdAtMs,
			})
		).receipt;
	} catch (error) {
		if (isTerminalOperationFailure(error)) {
			completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
		}
		throw error;
	}

	const agent = dependencies.projectExistingTarget
		? dependencies.projectExistingTarget(intent, context, receipt)
		: projectExistingTarget(intent, context);
	completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
	return agent;
}

async function executeIntent(
	initial: DelegateOnceIntentV1,
	dependencies: DelegateOnceRuntimeDependencies = {},
): Promise<Agent> {
	const transport = dependencies.transport ?? createDureWorkflowTransport();
	let intent = initial;
	if (!intent.routeAuthority) {
		const authority = await (
			dependencies.resolveRouteAuthority ??
			(() => resolveSelectedDureBackendRouteAuthority("local"))
		)();
		intent = recordDelegateOnceRouteAuthority(
			intent,
			authority,
			dependencies.storage,
		);
	}
	const routeAuthority = intent.routeAuthority;
	if (!routeAuthority) {
		throw new Error(t("workflows.delegation.storedRequestInvalidFormat"));
	}
	if (intent.coordinator.bindingGeneration === undefined) {
		try {
			const identity = await transport.ensureCoordinatorBinding(
				routeAuthority,
				{
					schemaVersion: 1,
					agentId: intent.coordinator.agentId,
					sessionId: intent.coordinator.sessionId,
					workspaceId: intent.coordinator.workspaceId,
					displayName: intent.coordinator.displayName,
					worktreePath: intent.coordinator.worktreePath,
					stopFence: intent.coordinator.stopFence,
				},
			);
			intent = recordDelegateOnceBinding(
				intent,
				identity.bindingGeneration,
				dependencies.storage,
			);
		} catch (error) {
			// A lost binding response is an uncertain idempotent effect. Retain the
			// intent and exact route so resume retries the same backend. Only the
			// authority's terminal refusal unlocks a new logical operation.
			if (isTerminalOperationFailure(error)) {
				try {
					completeDelegateOnceIntent(
						intent.idempotencyKey,
						dependencies.storage,
					);
				} catch {
					// Preserve the original storage failure. Startup also fails closed on an
					// unreadable journal.
				}
			}
			throw error;
		}
	}
	const bindingGeneration = intent.coordinator.bindingGeneration;
	if (bindingGeneration === undefined) {
		throw new Error(
			t("workflows.delegation.storedRequestMissingBindingGeneration"),
		);
	}
	if (intent.target) {
		return executeExistingTargetIntent(intent, dependencies);
	}
	let receipt: Awaited<ReturnType<DureWorkflowTransport["delegateOnce"]>>;
	try {
		receipt = await transport.delegateOnce(routeAuthority, {
			schemaVersion: 1,
			contributionId: delegateOnceContributionId(intent),
			coordinator: {
				agentId: intent.coordinator.agentId,
				sessionId: intent.coordinator.sessionId,
				bindingGeneration,
			},
			task: intent.task,
			providerId: intent.providerId,
			runtimeKindId: "runtime.hmux",
			targetReference: "backend-profile:local",
			idempotencyKey: intent.idempotencyKey,
			createdAtMs: intent.createdAtMs,
		});
	} catch (error) {
		if (isTerminalOperationFailure(error)) {
			completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
		}
		throw error;
	}

	if (receipt.status === "start_failed") {
		completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
		throw new DureWorkflowError(
			receipt.startErrorCode ?? "workflow_start_failed",
			t("workflows.delegation.workerStartFailed", {
				taskId: receipt.taskId,
				code: receipt.startErrorCode ?? "unknown",
			}),
			{ kind: "operation", disposition: "terminal" },
		);
	}
	if (receipt.status === "starting") {
		throw new DureWorkflowError(
			"workflow_start_uncertain",
			t("workflows.delegation.workerStartUnsettled"),
			{ kind: "operation", disposition: "retry_same" },
		);
	}

	let worker: Agent;
	if (dependencies.projectWorker) {
		worker = dependencies.projectWorker(intent, receipt);
	} else {
		let projected: Agent | undefined;
		useStore.setState((state) => {
			const current = projectDelegateOnceWorker(intent, receipt, state.agents);
			projected = current.agent;
			if (!current.inserted) {
				// 이전 persist 실패 뒤 메모리에만 남았을 수 있다. 새 배열 참조로
				// durable slice를 다시 확정한 뒤에만 intent를 지운다.
				return { agents: [...state.agents] };
			}
			return {
				agents: [...state.agents, current.agent],
				agentActivity: {
					...state.agentActivity,
					[current.agent.id]: "working",
				},
				stats: {
					...state.stats,
					agentsStarted: state.stats.agentsStarted + 1,
				},
			};
		});
		if (!projected) {
			throw new Error(t("workflows.delegation.workerPaneCommitFailed"));
		}
		worker = projected;
	}

	completeDelegateOnceIntent(intent.idempotencyKey, dependencies.storage);
	if (!dependencies.projectWorker) {
		// 복구가 사용자의 현재 desktop을 바꾸지 않게, 이미 마운트된 대상에만 연다.
		openAgentPanel(intent.desktopId, worker);
	}
	return worker;
}

export async function delegateOnceFromAgent(
	input: NewDelegateOnceIntent,
	dependencies: DelegateOnceRuntimeDependencies = {},
): Promise<Agent> {
	const intent = beginDelegateOnceIntent(input, dependencies.storage);
	return executeIntent(intent, dependencies);
}

export async function resumeInterruptedDelegateOnceIntents(
	dependencies: DelegateOnceRuntimeDependencies = {},
): Promise<void> {
	let intents: DelegateOnceIntentV1[];
	try {
		intents = readDelegateOnceIntents(dependencies.storage);
	} catch (error) {
		console.error("[workflow delegate recovery]", error);
		return;
	}
	for (const intent of intents) {
		try {
			await executeIntent(intent, {
				...dependencies,
				transport: dependencies.transport ?? createDureWorkflowTransport(),
				orchestrationTransport:
					dependencies.orchestrationTransport ??
					createDureOrchestrationTransport(),
			});
		} catch (error) {
			console.error(
				`[workflow delegate recovery] ${intent.idempotencyKey}`,
				error,
			);
		}
	}
}
