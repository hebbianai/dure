import type { AgentRemovalPreview } from "@/lib/agents/agentRemovalPreview";
import {
	agentHostReferenceIds,
	agentReferencesHost,
} from "@/lib/agents/agentHostReferences";
import {
	type AgentRemovalRegistrationIdentity,
	agentRemovalRegistrationIdentity,
	sameAgentRemovalProjection,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import {
	type RemovalObservation,
	sameObservedRemovalAgent,
	samePaneOperationalIdentity,
	sameProjectOperationalIdentity,
	sameSshHostOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import {
	type DurableAgentProjectionTarget,
	type DurableProjectionScopeState,
	removeAgentProjectionDurably,
} from "@/lib/agents/durableAgentRemoval";
import {
	type AgentRemovalDispatch,
	type AgentRemovalPlan,
	AgentRemovalTargetMismatchError,
	executeAgentRemovalDispatch,
	finalizeStoppedAgentRemoval,
	prepareAgentRemovalDispatch,
	prepareAgentRemovalPlans,
	type StoppedAgentRemoval,
	stoppedAgentRemovalAppliesToAgent,
} from "@/lib/agents/agentRemovalRuntime";
import {
	inspectPreparedAgentWorktreeScope,
	type PreparedAgentWorktreeRemoval,
	prepareAgentWorktreeRemoval,
	removePreparedAgentWorktree,
	sameAgentWorktreeScopeCandidates,
} from "@/lib/agents/agentWorktreeRemoval";
import {
	matchesSshHostRemovalScope,
} from "@/lib/agents/sshHostRemovalScope";
import {
	captureSshHostRemovalLayouts,
	planSshHostRemoval,
	type SshHostRemovalPlan,
} from "@/lib/agents/sshHostRemovalPlan";
import { t } from "@/lib/i18n";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import type { GitCheckoutRemovalReceiptV1 } from "@/lib/scm/worktrees/gitCheckoutInstance";
import { planAgentWorktreeRemoval } from "@/lib/scm/worktrees/worktreeRemoval";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { classifyTerminalPaneHost } from "@/lib/terminal/paneHostIdentity";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	useStore,
} from "@/store";
import type { Agent, Project, SshHostConfig } from "@/types";

export type AgentRemovalProgress =
  | {
      kind: "agent";
      agentId: string;
      status: "started" | "completed";
    }
  | {
      kind: "worktree";
      path: string;
      status: "started" | "completed";
    };

export interface RemoveAgentWithResourcesOptions {
  onProgress?: (progress: AgentRemovalProgress) => void;
}

export type { AgentRemovalPreview } from "@/lib/agents/agentRemovalPreview";

export interface PreparedAgentRemoval {
  readonly preview: AgentRemovalPreview;
}

function reportAgentRemovalProgress(
  observer: RemoveAgentWithResourcesOptions["onProgress"],
  progress: AgentRemovalProgress,
): void {
  try {
    observer?.(progress);
  } catch (error) {
    // Progress is presentation-only. A broken observer must never interrupt a
    // destructive lifecycle operation after its stop boundary has begun.
    console.warn("[agent removal progress] observer failed", error);
  }
}

export interface ProjectRemovalPlan {
  projectId: string;
	project?: Project;
	sshHostScope: readonly {
		readonly hostId: string;
		readonly host?: SshHostConfig;
	}[];
  agents: readonly Agent[];
}

export async function removeAgentWithResources(
  agentId: string,
  opts: RemoveAgentWithResourcesOptions = {},
): Promise<void> {
  const operation = await prepareAgentRemoval(agentId, {
    deleteWorktree: false,
  });
  await executeAgentRemoval(operation, opts);
}

type WorktreeRemovalCheckpoint =
	| { readonly phase: "prepared" }
	| { readonly phase: "dispatched" }
	| {
			readonly phase: "complete";
			readonly receipt: GitCheckoutRemovalReceiptV1;
	  };

interface PreparedWorktreeRemovalState {
	readonly removal: PreparedAgentWorktreeRemoval;
	checkpoint: WorktreeRemovalCheckpoint;
}

interface AgentRemovalOperationState {
  readonly plans: readonly AgentRemovalPlan[];
	readonly worktree?: PreparedWorktreeRemovalState;
  readonly stopped: StoppedAgentRemoval[];
	// Runtime and finalization checkpoints advance on receipts. Worktree
	// dispatch is retained separately because a lost response has an ambiguous
	// outcome and must retry the same exact Host authority.
  stopIndex: number;
  finalizeIndex: number;
	stopDispatch?: AgentRemovalDispatch;
	inFlight?: Promise<AgentRemovalExecutionReceipt>;
}

const preparedAgentRemovalState = Symbol("prepared-agent-removal-state");

interface InternalPreparedAgentRemoval extends PreparedAgentRemoval {
  readonly [preparedAgentRemovalState]: AgentRemovalOperationState;
}

export interface PrepareAgentRemovalOptions {
  readonly deleteWorktree: boolean;
	readonly expectedIdentity?: AgentRemovalRegistrationIdentity;
}

export interface AgentRemovalExecutionReceipt {
  readonly agentIds: readonly string[];
  readonly worktreeRemoval?: GitCheckoutRemovalReceiptV1;
}

export type AgentRemovalScopeRetry = "reprepare" | "same_operation";

export class AgentRemovalScopeChangedError extends Error {
	constructor(readonly retry: AgentRemovalScopeRetry) {
		super(t("agents.remove.worktreeUsersChanged"));
		this.name = "AgentRemovalScopeChangedError";
	}
}

export class AgentRemovalWorktreeUnsupportedError extends Error {
	constructor(readonly preview: AgentRemovalPreview) {
		super(t("agents.remove.impactUnverified"));
		this.name = "AgentRemovalWorktreeUnsupportedError";
	}
}

function scopeRetry(state: AgentRemovalOperationState): AgentRemovalScopeRetry {
	return state.stopIndex === 0 &&
		!state.stopDispatch &&
		state.worktree?.checkpoint.phase !== "complete"
		? "reprepare"
		: "same_operation";
}

async function assertPreparedRemovalScope(
	state: AgentRemovalOperationState,
): Promise<void> {
	const latest = useStore.getState();
	const frozenAgents = new Map(
		state.plans.map((plan) => [plan.identity.id, plan.identity] as const),
	);
	const currentPreparedAgents: Agent[] = [];
	const sameObservedTargets = (after: RemovalObservation) =>
		state.plans.every((plan, index) =>
			sameObservedRemovalAgent(
				plan.identity.id,
				latest,
				after,
				Boolean(state.stopped[index]),
			),
		);

	for (const [index, plan] of state.plans.entries()) {
		const current = latest.agents.find(
			(candidate) => candidate.id === plan.identity.id,
		);
		if (!current) continue;
		const stopped = state.stopped[index];
		const stillOwned = stopped
			? await stoppedAgentRemovalAppliesToAgent(
					stopped,
					current,
					latest.projects,
					latest.sshHosts,
				)
			: sameAgentRemovalTarget(current, plan.identity);
		if (!stillOwned) {
			throw new AgentRemovalScopeChangedError(scopeRetry(state));
		}
		currentPreparedAgents.push(current);
	}
	const afterOwnership = useStore.getState();
	if (!sameObservedTargets(afterOwnership)) {
		throw new AgentRemovalScopeChangedError(scopeRetry(state));
	}
	const worktree = state.worktree;
	if (!worktree) return;
	const removal = worktree.removal;
	const currentScope = await inspectPreparedAgentWorktreeScope(
		removal,
    latest.agents,
    latest.projects,
  );
	const afterInspection = useStore.getState();
	if (
		!sameObservedTargets(afterInspection) ||
		!sameAgentWorktreeScopeCandidates(removal, latest, afterInspection)
	) {
		throw new AgentRemovalScopeChangedError(scopeRetry(state));
	}
	const currentAffectedIds = new Set(
		currentScope.affectedAgents.map((agent) => agent.id),
	);
	const currentUnresolvedIds = new Set(
		[...currentScope.unresolvedAgents, ...(currentScope.absentAgents ?? [])].map((agent) => agent.id),
	);
	const retryingDispatchedRemoval = worktree.checkpoint.phase === "dispatched";
	if (
		currentScope.unresolvedAgents.some(
			(agent) => !retryingDispatchedRemoval || !frozenAgents.has(agent.id),
		) ||
		currentScope.affectedAgents.some((agent) => !frozenAgents.has(agent.id)) ||
		currentPreparedAgents.some(
			(agent) =>
				!currentAffectedIds.has(agent.id) &&
				(!retryingDispatchedRemoval || !currentUnresolvedIds.has(agent.id)),
		)
	) {
		throw new AgentRemovalScopeChangedError(scopeRetry(state));
  }
}

export async function prepareAgentRemoval(
  agentId: string,
  options: PrepareAgentRemovalOptions,
): Promise<PreparedAgentRemoval> {
  const state = useStore.getState();
  const target = state.agents.find((candidate) => candidate.id === agentId);
  if (!target) {
    if (options.deleteWorktree) {
      throw new Error(t("agents.remove.worktreeUsersChanged"));
    }
    return {
      preview: { agents: [] },
      [preparedAgentRemovalState]: {
        plans: [],
        stopped: [],
        stopIndex: 0,
        finalizeIndex: 0,
      },
    } as InternalPreparedAgentRemoval;
  }
	if (
		options.expectedIdentity &&
		!sameAgentRemovalTarget(target, options.expectedIdentity)
	) {
		throw new AgentRemovalScopeChangedError("reprepare");
  }
	if (options.deleteWorktree && target.canonicalSpawn) {
		throw new Error(t("agents.remove.impactUnverified"));
	}
	const targetIdentity = agentRemovalRegistrationIdentity(target);
	const removalPlan = options.deleteWorktree
		? planAgentWorktreeRemoval(
        target,
				state.projects.find((project) => project.id === target.projectId),
			)
		: null;
	if (options.deleteWorktree && !removalPlan) {
		throw new Error(t("agents.remove.impactUnverified"));
	}
	const preparedWorktree = removalPlan
		? await prepareAgentWorktreeRemoval(
				removalPlan,
				state.sshHosts,
			)
    : undefined;
	// Proven absence needs no disk mutation or co-user stop. Never turn this
	// observation into permission to delete a checkout recreated at the same path.
	const worktree = preparedWorktree && !("absentPath" in preparedWorktree)
		? preparedWorktree : undefined;
	let orderedAgents = [target];
	if (worktree) {
		const current = useStore.getState();
		const scope = await inspectPreparedAgentWorktreeScope(
			worktree,
			current.agents,
			current.projects,
		);
		const afterInspection = useStore.getState();
		if (
			!sameObservedRemovalAgent(agentId, current, afterInspection) ||
			!sameAgentWorktreeScopeCandidates(worktree, current, afterInspection)
		) {
			throw new AgentRemovalScopeChangedError("reprepare");
		}
		const currentTarget = afterInspection.agents.find(
			(candidate) => candidate.id === agentId,
		);
		if (
			!currentTarget ||
			!scope.affectedAgents.some((candidate) => candidate.id === agentId) ||
			!sameAgentRemovalTarget(currentTarget, targetIdentity) ||
			scope.unresolvedAgents.length > 0
		) {
			throw new AgentRemovalScopeChangedError("reprepare");
		}
		orderedAgents = [
			...scope.affectedAgents.filter((candidate) => candidate.id !== agentId),
			currentTarget,
		];
		if (orderedAgents.some((agent) => agent.canonicalSpawn !== undefined)) {
			throw new AgentRemovalWorktreeUnsupportedError({
				agents: orderedAgents,
				worktree: worktree.plan,
			});
		}
	}
	let plans: readonly AgentRemovalPlan[];
	try {
		plans = await prepareAgentRemovalPlans(
			orderedAgents,
			worktree
				? worktree.transport === "ssh"
					? { source: "ssh", target: worktree.sshTarget }
					: { source: "local" }
				: undefined,
		);
	} catch (error) {
		if (error instanceof AgentRemovalTargetMismatchError) {
			throw new AgentRemovalScopeChangedError("reprepare");
		}
		throw error;
	}
	const operationState: AgentRemovalOperationState = {
      plans,
		...(worktree
			? {
					worktree: {
						removal: worktree,
						checkpoint: { phase: "prepared" } as const,
					},
				}
			: {}),
      stopped: [],
      stopIndex: 0,
      finalizeIndex: 0,
	};
	await assertPreparedRemovalScope(operationState);
	const operation: InternalPreparedAgentRemoval = {
		preview: {
			agents: orderedAgents,
			...(removalPlan ? { worktree: removalPlan } : {}),
			...(preparedWorktree && "absentPath" in preparedWorktree ? { worktreeAlreadyAbsent: true } : {}),
    },
		[preparedAgentRemovalState]: operationState,
  };
  return operation;
}

function preparedRemovalState(
  operation: PreparedAgentRemoval,
): AgentRemovalOperationState {
  const state = (operation as InternalPreparedAgentRemoval)[
    preparedAgentRemovalState
  ];
  if (!state) {
    throw new Error("agent_removal_operation_invalid");
  }
  return state;
}

async function finalizeStoppedAgents(
	state: AgentRemovalOperationState,
	opts: RemoveAgentWithResourcesOptions,
): Promise<void> {
	while (state.finalizeIndex < state.stopped.length) {
		const removal = state.stopped[state.finalizeIndex];
		if (!removal) throw new Error("agent_removal_operation_invalid");
		await finalizeStoppedAgentRemoval(removal);
		state.finalizeIndex += 1;
		reportAgentRemovalProgress(opts.onProgress, {
			kind: "agent",
			agentId: removal.plan.agent.id,
			status: "completed",
		});
	}
}

async function runAgentRemoval(
	state: AgentRemovalOperationState,
  opts: RemoveAgentWithResourcesOptions = {},
): Promise<AgentRemovalExecutionReceipt> {
	try {
    while (state.stopIndex < state.plans.length) {
      const plan = state.plans[state.stopIndex];
      if (!plan) throw new Error("agent_removal_operation_invalid");
      reportAgentRemovalProgress(opts.onProgress, {
        kind: "agent",
        agentId: plan.agent.id,
        status: "started",
      });
			const retryingDispatch = state.stopDispatch !== undefined;
			if (!state.stopDispatch) {
				await assertPreparedRemovalScope(state);
				state.stopDispatch = await prepareAgentRemovalDispatch(plan);
			}
			state.stopped.push(
				await executeAgentRemovalDispatch(state.stopDispatch, {
					resumeCanonical: retryingDispatch,
				}),
			);
      state.stopIndex += 1;
			state.stopDispatch = undefined;
		}
	} catch (error) {
		await finalizeStoppedAgents(state, opts);
		if (error instanceof AgentRemovalTargetMismatchError) {
			throw new AgentRemovalScopeChangedError(scopeRetry(state));
		}
		throw error;
	}
	const worktree = state.worktree;
	if (worktree && worktree.checkpoint.phase !== "complete") {
    reportAgentRemovalProgress(opts.onProgress, {
      kind: "worktree",
			path: worktree.removal.plan.wtPath,
      status: "started",
    });
		try {
			await assertPreparedRemovalScope(state);
			const removal = removePreparedAgentWorktree(worktree.removal);
			worktree.checkpoint = { phase: "dispatched" };
			const receipt = await removal;
			worktree.checkpoint = { phase: "complete", receipt };
      reportAgentRemovalProgress(opts.onProgress, {
        kind: "worktree",
				path: worktree.removal.plan.wtPath,
        status: "completed",
      });
		} catch (error) {
			await finalizeStoppedAgents(state, opts);
			throw error;
		}
  }
	await finalizeStoppedAgents(state, opts);
	const worktreeRemoval =
		state.worktree?.checkpoint.phase === "complete"
			? state.worktree.checkpoint.receipt
			: undefined;
	return {
    agentIds: state.plans.map((plan) => plan.agent.id),
		...(worktreeRemoval ? { worktreeRemoval } : {}),
  };
}

export function executeAgentRemoval(
	operation: PreparedAgentRemoval,
	opts: RemoveAgentWithResourcesOptions = {},
): Promise<AgentRemovalExecutionReceipt> {
	const state = preparedRemovalState(operation);
	if (state.inFlight) return state.inFlight;
	const execution = Promise.resolve()
		.then(() => runAgentRemoval(state, opts))
		.finally(() => {
			if (state.inFlight === execution) state.inFlight = undefined;
		});
	state.inFlight = execution;
	return execution;
}

export function planProjectRemoval(projectId: string): ProjectRemovalPlan {
  const state = useStore.getState();
	const project = state.projects.find(
		(candidate) => candidate.id === projectId,
	);
  const agents = state.agents.filter((agent) => agent.projectId === projectId);
	const sshHostIds = new Set([
		...(project?.sshHostId ? [project.sshHostId] : []),
		...agents.flatMap((agent) => [...agentHostReferenceIds(agent)]),
	]);
  return {
    projectId,
		project,
		sshHostScope: [...sshHostIds].map((hostId) => {
			const host = state.sshHosts.find((candidate) => candidate.id === hostId);
			return { hostId, ...(host ? { host } : {}) };
		}),
    agents,
  };
}

function projectSshHostScopeApplies(
	plan: ProjectRemovalPlan,
	sshHosts: readonly SshHostConfig[],
): boolean {
	return plan.sshHostScope.every((expected) => {
		const current = sshHosts.find((host) => host.id === expected.hostId);
		return expected.host
			? sameSshHostOperationalIdentity(current, expected.host)
			: current === undefined;
	});
}

function projectRemovalScopeApplies(
	plan: ProjectRemovalPlan,
	state: Pick<PersistedAppState, "projects" | "agents" | "sshHosts">,
): boolean {
	if (
		!plan.project ||
		!sameProjectOperationalIdentity(
			state.projects.find((candidate) => candidate.id === plan.projectId),
			plan.project,
		) ||
		!projectSshHostScopeApplies(plan, state.sshHosts)
	) {
		return false;
	}
	const expected = new Map(
		plan.agents.map((agent) => [
			agent.id,
			agentRemovalRegistrationIdentity(agent),
		]),
	);
	const current = state.agents.filter(
		(agent) => agent.projectId === plan.projectId,
  );
	return !(
		current.length !== expected.size ||
		current.some((agent) => {
			const identity = expected.get(agent.id);
			return !identity || !sameAgentRemovalTarget(agent, identity);
		})
	);
}

function assertProjectRemovalScope(plan: ProjectRemovalPlan): void {
	if (!projectRemovalScopeApplies(plan, useStore.getState())) {
		throw new PaneCommandError("pane_changed", "project Agent scope changed");
	}
}

async function assertDurableRemovalScope(
	applies: (state: PersistedAppState) => boolean,
	message: string,
): Promise<void> {
	const matches = await durableAppStorage.read(
		DURABLE_APP_STORE_NAME,
		(current) =>
			Boolean(current && applies(normalizePersistedState(current.state))),
	);
	if (matches) return;
	await recoverCurrentDurableStoreProjection({ forceProjection: true });
	throw new PaneCommandError("pane_changed", message);
}

async function prepareAgentRemovalDispatches(
	plans: readonly AgentRemovalPlan[],
): Promise<AgentRemovalDispatch[]> {
	const dispatches: AgentRemovalDispatch[] = [];
	for (const plan of plans) {
		dispatches.push(await prepareAgentRemovalDispatch(plan));
	}
	return dispatches;
}

async function executeAgentRemovalDispatches(
	dispatches: readonly AgentRemovalDispatch[],
): Promise<StoppedAgentRemoval[]> {
	const stopped: StoppedAgentRemoval[] = [];
	for (const dispatch of dispatches) {
		stopped.push(await executeAgentRemovalDispatch(dispatch));
	}
	return stopped;
}

async function durableAgentTargets(
	removals: readonly StoppedAgentRemoval[],
	authority: Pick<DurableProjectionScopeState, "projects" | "sshHosts">,
): Promise<DurableAgentProjectionTarget[]> {
	const snapshot = useStore.getState();
	const targets = await Promise.all(
		removals.map(async (removal): Promise<DurableAgentProjectionTarget> => {
			const current = snapshot.agents.find(
				(candidate) => candidate.id === removal.plan.agent.id,
			);
			const applies = current
				? await stoppedAgentRemovalAppliesToAgent(
						removal,
						current,
						authority.projects,
						authority.sshHosts,
					)
				: true;
			const identity = current
				? agentRemovalRegistrationIdentity(current)
				: removal.kind === "registry" && removal.finalizationIdentity
					? removal.finalizationIdentity
					: removal.plan.identity;
			return {
				agentId: removal.plan.agent.id,
				panelIds: removal.plan.panelIds,
				sessionIds: removal.plan.sessions.map((session) => session.sessionId),
				applies: applies
					? (agent) => sameAgentRemovalProjection(agent, identity)
					: () => false,
			};
		}),
	);
	return targets;
}

function projectBatchApplies(
	plan: ProjectRemovalPlan,
	targets: readonly DurableAgentProjectionTarget[],
	state: DurableProjectionScopeState,
): boolean {
	if (!projectSshHostScopeApplies(plan, state.sshHosts)) {
		return false;
	}
	const project = state.projects.find(
		(candidate) => candidate.id === plan.projectId,
	);
	const projectIsSuccessor = Boolean(
		project &&
			plan.project &&
			!sameProjectOperationalIdentity(project, plan.project),
	);
	const targetsByAgentId = new Map(
		targets.map((target) => [target.agentId, target] as const),
	);
	return state.agents.every((agent) => {
		if (agent.projectId !== plan.projectId) return true;
		if (projectIsSuccessor) return true;
		const target = targetsByAgentId.get(agent.id);
		return Boolean(target?.applies(agent, state.projects, state.sshHosts));
	});
}

export async function executeProjectRemoval(
	plan: ProjectRemovalPlan,
): Promise<ProjectRemovalPlan> {
	assertProjectRemovalScope(plan);
	const agents = await prepareAgentRemovalPlans(plan.agents);
	const dispatches = await prepareAgentRemovalDispatches(agents);
	assertProjectRemovalScope(plan);
	await assertDurableRemovalScope(
		(state) => projectRemovalScopeApplies(plan, state),
		"durable project removal scope changed",
	);
	const authority = useStore.getState();
	const stopped = await executeAgentRemovalDispatches(dispatches);
	const targets = await durableAgentTargets(stopped, authority);
	const applied = await removeAgentProjectionDurably({
		mode: "batch",
		agents: targets,
		projects: [
			{
				projectId: plan.projectId,
				panelIds: [`git:${plan.projectId}`],
				applies: (project) =>
					Boolean(
						plan.project && sameProjectOperationalIdentity(project, plan.project),
					),
			},
		],
		applies: (state) => projectBatchApplies(plan, targets, state),
	});
	if (!applied) {
		throw new PaneCommandError("pane_changed", "project removal scope changed");
  }
	return plan;
}

/** Immediate non-confirmation entry point. Confirmation UIs must retain and
 * execute the plan captured when consent was armed. */
export function removeProjectWithResources(
	projectId: string,
): Promise<ProjectRemovalPlan> {
	return executeProjectRemoval(planProjectRemoval(projectId));
}

function sshHostPaneScopeApplies(
	plan: SshHostRemovalPlan,
	layouts: readonly { readonly spaceId: string; readonly layout: unknown }[],
): boolean {
	const expected = new Map(
		plan.panes.map(
			(pane) => [`${pane.spaceId}\0${pane.panelId}`, pane] as const,
		),
	);
	let ownedCount = 0;
	for (const { spaceId, layout } of layouts) {
		for (const pane of panelsFromLayout(layout)) {
			const ownership = classifyTerminalPaneHost(pane.params, plan.hostId);
			if (ownership === "unresolved") return false;
			if (ownership !== "owned") continue;
			ownedCount += 1;
			const prepared = expected.get(`${spaceId}\0${pane.id}`);
			if (
				!prepared ||
				!samePaneOperationalIdentity(pane.params, prepared.params)
			) {
				return false;
			}
		}
	}
	return ownedCount === expected.size;
}

function assertSshHostPaneScope(plan: SshHostRemovalPlan): void {
	if (!sshHostPaneScopeApplies(plan, captureSshHostRemovalLayouts())) {
		throw new PaneCommandError("pane_changed", "SSH pane scope changed");
	}
}

function assertSshHostRemovalScope(plan: SshHostRemovalPlan): void {
	if (!matchesSshHostRemovalScope(plan.scope, useStore.getState())) {
		throw new PaneCommandError("pane_changed", "SSH host scope changed");
	}
}

function sshHostBatchApplies(
	plan: SshHostRemovalPlan,
	targets: readonly DurableAgentProjectionTarget[],
	state: DurableProjectionScopeState,
): boolean {
	const host = state.sshHosts.find((candidate) => candidate.id === plan.hostId);
	const hostIsSuccessor = Boolean(
		host &&
			plan.scope.host &&
			!sameSshHostOperationalIdentity(host, plan.scope.host),
	);
	const expectedProjects = new Map(
		plan.scope.projects.map((project) => [project.id, project] as const),
	);
	const currentProjects = new Map(
		state.projects.map((project) => [project.id, project] as const),
	);
	const projectDispositions = new Map<string, "preserved" | "removed">();
	for (const expected of plan.scope.projects) {
		const current = currentProjects.get(expected.id);
		if (!current || sameProjectOperationalIdentity(current, expected)) {
			projectDispositions.set(expected.id, "removed");
			continue;
		}
		if (current.sshHostId === plan.hostId && !hostIsSuccessor) return false;
		projectDispositions.set(expected.id, "preserved");
	}
	for (const project of state.projects) {
		if (project.sshHostId !== plan.hostId) continue;
		if (expectedProjects.has(project.id)) continue;
		if (!hostIsSuccessor) return false;
		projectDispositions.set(project.id, "preserved");
	}
	const targetsByAgentId = new Map(
		targets.map((target) => [target.agentId, target] as const),
	);
	if (!hostIsSuccessor) {
		const expectedPanes = new Map(
			plan.panes.map(
				(pane) => [`${pane.spaceId}\0${pane.panelId}`, pane] as const,
			),
		);
		for (const pane of state.panes) {
			const ownership = classifyTerminalPaneHost(pane.params, plan.hostId);
			if (ownership === "unresolved") return false;
			if (ownership !== "owned") continue;
			const expected = expectedPanes.get(`${pane.spaceId}\0${pane.panelId}`);
			if (!expected || !samePaneOperationalIdentity(pane.params, expected.params)) {
				return false;
			}
		}
	}
	return state.agents.every((agent) => {
		const disposition = projectDispositions.get(agent.projectId);
		const referencesHost = agentReferencesHost(agent, plan.hostId);
		if (disposition === "preserved" && !referencesHost) return true;
		const target = targetsByAgentId.get(agent.id);
		if (disposition !== "removed") {
			if (!referencesHost) return true;
			return Boolean(
				target
					? target.applies(agent, state.projects, state.sshHosts)
					: hostIsSuccessor,
			);
		}
		return Boolean(target?.applies(agent, state.projects, state.sshHosts));
	});
}

export async function executeSshHostRemoval(
	plan: SshHostRemovalPlan,
): Promise<SshHostRemovalPlan> {
	assertSshHostPaneScope(plan);
	assertSshHostRemovalScope(plan);
	const agents = await prepareAgentRemovalPlans(plan.agents);
	const dispatches = await prepareAgentRemovalDispatches(agents);
	assertSshHostPaneScope(plan);
	assertSshHostRemovalScope(plan);
	await assertDurableRemovalScope(
		(state) =>
			matchesSshHostRemovalScope(plan.scope, state) &&
			sshHostPaneScopeApplies(
				plan,
				Object.entries(state.layouts).map(([spaceId, layout]) => ({
					spaceId,
					layout,
				})),
			),
		"durable SSH Host removal scope changed",
	);
	const authority = useStore.getState();
	const stopped = await executeAgentRemovalDispatches(dispatches);
	const targets = await durableAgentTargets(stopped, authority);
	const applied = await removeAgentProjectionDurably({
		mode: "batch",
		agents: targets,
		projects: plan.scope.projects.map((project) => ({
			projectId: project.id,
			panelIds: [`git:${project.id}`],
			applies: (current) => sameProjectOperationalIdentity(current, project),
		})),
		sshHosts: plan.scope.host
			? [
					{
						hostId: plan.hostId,
						applies: (host) =>
							sameSshHostOperationalIdentity(host, plan.scope.host),
					},
				]
			: [],
		panes: plan.panes.map((pane) => ({
				spaceId: pane.spaceId,
				panelId: pane.panelId,
				ownerHostId: plan.hostId,
				sessionIds: pane.sessions.map((session) => session.sessionId),
				applies: (params) =>
					classifyTerminalPaneHost(params, plan.hostId) === "owned" &&
					samePaneOperationalIdentity(params, pane.params),
			})),
		applies: (state) => sshHostBatchApplies(plan, targets, state),
	});
	if (!applied) {
		throw new PaneCommandError(
			"pane_changed",
			"SSH host removal scope changed",
		);
	}
	return plan;
}

/** Immediate non-confirmation entry point. Confirmation UIs must retain and
 * execute the plan captured when consent was armed. */
export function removeSshHostWithResources(
	hostId: string,
): Promise<SshHostRemovalPlan> {
	return executeSshHostRemoval(planSshHostRemoval(hostId));
}
