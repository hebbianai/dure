import {
	type AgentRemovalRegistrationIdentity,
	agentRemovalRegistrationIdentity,
	sameAgentRemovalProjection,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import {
	applyCanonicalAgentStopPresentationV1,
	CanonicalAgentStopPreviewNotFoundError,
	executeCanonicalAgentStopV1,
	prepareCanonicalAgentStopV1,
	type PreparedCanonicalAgentStopV1,
	resumeCanonicalAgentStopV1,
} from "@/lib/agents/canonicalAgentStopRuntime";
import { canonicalAgentStopAppliesToAgentV1 } from "@/lib/agents/canonicalAgentStopLifecycle";
import { agentRuntimeTransitionBackendProfileId } from "@/lib/agents/agentRuntimeProfileSwitch";
import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { t } from "@/lib/i18n";
import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeClient,
} from "@/lib/ipc/dureAgentRuntime";
import {
	assertExactDureBackendProjectTarget,
	type DureBackendRouteAuthorityV1,
} from "@/lib/ipc/dureBackendRoute";
import { hmux } from "@/lib/ipc/hmux";
import {
	finalizeManagedAgentRemoval,
	type ManagedAgentStopTarget,
	ManagedSessionAbsentError,
	managedAgentStopReceiptAppliesToAgent,
	type PreparedManagedAgentStopOperation,
	prepareManagedAgentStopOperation,
	prepareManagedAgentStopTarget,
	resolveManagedAgentStopTarget,
	stopPreparedManagedAgentProvider,
} from "@/lib/sessions/managed/managedAgentStop";
import type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";
import {
	bindingForAgent,
	type HmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { TerminalSessionRef } from "@/lib/workspace/layout/terminalSessionRefs";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { Agent, Project, SshHostConfig } from "@/types";

interface BackendRuntimeTarget {
	readonly agent: Agent;
	readonly client: DureAgentRuntimeClient;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
}

type AgentRemovalExecutionTarget =
	| { readonly source: "local" }
	| { readonly source: "ssh"; readonly target: TrustedSshTargetV1 };

interface PreparedStandaloneAgentStopOperation {
	readonly binding: HmuxStandalonePaneBindingV1;
	readonly terminalEpoch: string;
}

export class AgentRemovalTargetMismatchError extends Error {
	constructor() {
		super(t("agents.remove.cleanupUnsafe"));
		this.name = "AgentRemovalTargetMismatchError";
	}
}

type AgentStopAuthority =
	| { readonly kind: "canonical"; readonly target: PreparedCanonicalAgentStopV1 }
	| { readonly kind: "backend"; readonly target: BackendRuntimeTarget }
	| { readonly kind: "managed"; readonly target: ManagedAgentStopTarget }
	| {
			readonly kind: "standalone";
			readonly binding: HmuxStandalonePaneBindingV1;
	  }
	| { readonly kind: "registry" };

export interface AgentRemovalPlan {
	readonly agent: Agent;
	readonly identity: AgentRemovalRegistrationIdentity;
	readonly panelIds: readonly string[];
	readonly sessions: readonly TerminalSessionRef[];
	readonly stopAuthority: AgentStopAuthority;
}

interface StoppedManagedTarget {
	readonly target: ManagedAgentStopTarget;
	readonly receipt: Awaited<
		ReturnType<typeof stopPreparedManagedAgentProvider>
	>;
}

export type StoppedAgentRemoval =
	| {
			readonly kind: "canonical";
			readonly plan: AgentRemovalPlan;
			readonly target: PreparedCanonicalAgentStopV1;
			readonly receipt: Awaited<ReturnType<typeof executeCanonicalAgentStopV1>>;
	  }
	| {
			readonly kind: "managed";
			readonly plan: AgentRemovalPlan;
			readonly stopped: StoppedManagedTarget;
	  }
	| {
			readonly kind: "registry";
			readonly plan: AgentRemovalPlan;
			readonly finalizationIdentity?: AgentRemovalRegistrationIdentity;
	  };

export type AgentRemovalDispatch =
	| {
			readonly kind: "canonical";
			readonly plan: AgentRemovalPlan;
			readonly target: PreparedCanonicalAgentStopV1;
	  }
	| {
			readonly kind: "backend";
			readonly plan: AgentRemovalPlan;
			readonly target: BackendRuntimeTarget;
			readonly finalizationIdentity?: AgentRemovalRegistrationIdentity;
	  }
	| {
			readonly kind: "managed";
			readonly plan: AgentRemovalPlan;
			readonly operation: PreparedManagedAgentStopOperation;
			readonly finalizationIdentity?: AgentRemovalRegistrationIdentity;
	  }
	| {
			readonly kind: "standalone";
			readonly plan: AgentRemovalPlan;
			readonly operation: PreparedStandaloneAgentStopOperation;
			readonly finalizationIdentity?: AgentRemovalRegistrationIdentity;
	  }
	| {
			readonly kind: "registry";
			readonly plan: AgentRemovalPlan;
			readonly finalizationIdentity?: AgentRemovalRegistrationIdentity;
	  };

function agentRemovalSession(agent: Agent): TerminalSessionRef {
	const binding = bindingForAgent(agent, useStore.getState().projects);
	return {
		kind: agent.sessionKind,
		sessionId: agent.sessionId,
		panelId: `agent:${agent.id}`,
		persistent:
			binding?.runtime === "hmux_managed_v1" ||
			binding?.runtime === "hmux_standalone_v1",
	};
}

function managedTargets(agents: readonly Agent[]): ManagedAgentStopTarget[] {
	const projects = useStore.getState().projects;
	return agents
		.filter(
			(agent) =>
				bindingForAgent(agent, projects)?.runtime === "hmux_managed_v1",
		)
		.map((agent) => {
			const target = resolveManagedAgentStopTarget(agent.id);
			if (
				!sameAgentRemovalTarget(
					target.agent,
					agentRemovalRegistrationIdentity(agent),
				)
			) {
				throw new Error(t("agents.remove.worktreeUsersChanged"));
			}
			return target;
		});
}

interface StandaloneAgentTarget {
	readonly agent: Agent;
	readonly binding: HmuxStandalonePaneBindingV1;
}

function standaloneTargets(agents: readonly Agent[]): StandaloneAgentTarget[] {
	const projects = useStore.getState().projects;
	return agents.flatMap((agent) => {
		const binding = bindingForAgent(agent, projects);
		if (binding?.runtime !== "hmux_standalone_v1") return [];
		if (binding.source === "ssh") {
			throw new Error(t("agents.remove.cleanupUnsafe"));
		}
		return [{ agent, binding }];
	});
}

function assertBackendRemovalTarget(
	authority: DureBackendRouteAuthorityV1,
	target: AgentRemovalExecutionTarget,
): void {
	if (target.source === "local") {
		if (authority.target.source !== "local") {
			throw new Error(
				"client_backend_host_mismatch: backend route and frozen local checkout disagree",
			);
		}
		return;
	}
	const remote = authority.target.source === "ssh" && authority.target.remote;
	if (
		!remote ||
		remote.host !== target.target.host ||
		remote.port !== target.target.port ||
		remote.user !== target.target.user
	) {
		throw new Error(
			"client_backend_host_mismatch: backend route and frozen SSH checkout disagree",
		);
	}
}

async function backendRuntimeTargets(
	agents: readonly Agent[],
	executionTarget?: AgentRemovalExecutionTarget,
): Promise<BackendRuntimeTarget[]> {
	const { projects, sshHosts } = useStore.getState();
	const candidates = agents.flatMap((agent) => {
		const project = projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		const profileId =
			agent.interactionProfile?.kind === "structured_protocol"
				? agent.interactionProfile.backendProfileId
				: agentRuntimeTransitionBackendProfileId(agent, project);
		return profileId
			? [
					{
						agent,
						client: createDureAgentRuntimeClient({ profileId }),
						project,
					},
				]
			: [];
	});

	const observed = await Promise.all(
		candidates.map(async (target) => {
			const observation = await target.client.inspect(target.agent.id);
			if (observation.state === "unmanaged") return undefined;
			if (!target.project) {
				throw new Error(
					"client_backend_project_missing: backend-owned Agent has no Project",
				);
			}
			assertExactDureBackendProjectTarget(
				observation.routeAuthority,
				target.project,
				sshHosts,
				(code, message) => {
					throw new Error(`${code}: ${message}`);
				},
			);
			if (executionTarget) {
				assertBackendRemovalTarget(observation.routeAuthority, executionTarget);
			}
			return {
				agent: target.agent,
				client: target.client,
				routeAuthority: observation.routeAuthority,
			};
		}),
	);
	return observed.filter(
		(target): target is BackendRuntimeTarget => target !== undefined,
	);
}

async function canonicalStopTargets(
	agents: readonly Agent[],
	executionTarget?: AgentRemovalExecutionTarget,
): Promise<PreparedCanonicalAgentStopV1[]> {
	const { projects, sshHosts } = useStore.getState();
	const canonicalAgents = agents.filter(
		(
			agent,
		): agent is Agent & {
			readonly canonicalSpawn: NonNullable<Agent["canonicalSpawn"]>;
		} => agent.canonicalSpawn !== undefined,
	);
	return Promise.all(
		canonicalAgents.map(async (agent) => {
			const target = await prepareCanonicalAgentStopV1(agent);
			const project = projects.find(
				(candidate) => candidate.id === agent.projectId,
			);
			if (!project) {
				throw new Error(
					"client_backend_project_missing: canonical Agent has no Project",
				);
			}
			assertExactDureBackendProjectTarget(
				target.routeAuthority,
				project,
				sshHosts,
				(code, message) => {
					throw new Error(`${code}: ${message}`);
				},
			);
			if (executionTarget) {
				assertBackendRemovalTarget(target.routeAuthority, executionTarget);
			}
			return target;
		}),
	);
}

function agentRemovalPlan(
	agent: Agent,
	stopAuthority: AgentStopAuthority,
): AgentRemovalPlan {
	return {
		agent,
		identity: agentRemovalRegistrationIdentity(agent),
		panelIds: [`agent:${agent.id}`],
		sessions: [agentRemovalSession(agent)],
		stopAuthority,
	};
}

function assertExecutionTargetSource(
	source: "local" | "ssh",
	executionTarget?: AgentRemovalExecutionTarget,
): void {
	if (executionTarget && executionTarget.source !== source) {
		throw new AgentRemovalTargetMismatchError();
	}
}

export async function prepareAgentRemovalPlans(
	agents: readonly Agent[],
	executionTarget?: AgentRemovalExecutionTarget,
): Promise<AgentRemovalPlan[]> {
	const canonical = await canonicalStopTargets(agents, executionTarget);
	const canonicalByAgent = new Map(
		canonical.map((target) => [target.agent.id, target] as const),
	);
	const legacyAgents = agents.filter((agent) => !canonicalByAgent.has(agent.id));
	const backend = await backendRuntimeTargets(legacyAgents, executionTarget);
	const backendByAgent = new Map(
		backend.map((target) => [target.agent.id, target] as const),
	);
	const nonBackend = legacyAgents.filter(
		(agent) => !backendByAgent.has(agent.id),
	);
	const managed = await Promise.all(
		managedTargets(nonBackend).map((target) => {
			assertExecutionTargetSource(target.binding.source, executionTarget);
			return prepareManagedAgentStopTarget(
				target,
				executionTarget?.source === "ssh" ? executionTarget.target : undefined,
			);
		}),
	);
	const managedByAgent = new Map(
		managed.map((target) => [target.agent.id, target] as const),
	);
	const standalone = standaloneTargets(nonBackend);
	for (const target of standalone) {
		assertExecutionTargetSource(target.binding.source, executionTarget);
	}
	const standaloneByAgent = new Map(
		standalone.map((target) => [target.agent.id, target] as const),
	);
	return agents.map((agent) => {
		const canonicalTarget = canonicalByAgent.get(agent.id);
		if (canonicalTarget) {
			return agentRemovalPlan(agent, {
				kind: "canonical",
				target: canonicalTarget,
			});
		}
		const backendTarget = backendByAgent.get(agent.id);
		if (backendTarget) {
			return agentRemovalPlan(agent, {
				kind: "backend",
				target: backendTarget,
			});
		}
		const managedTarget = managedByAgent.get(agent.id);
		if (managedTarget) {
			return agentRemovalPlan(agent, {
				kind: "managed",
				target: managedTarget,
			});
		}
		const standaloneTarget = standaloneByAgent.get(agent.id);
		return agentRemovalPlan(
			agent,
			standaloneTarget
				? { kind: "standalone", binding: standaloneTarget.binding }
				: { kind: "registry" },
		);
	});
}

export async function prepareAgentRemovalDispatch(
	plan: AgentRemovalPlan,
): Promise<AgentRemovalDispatch> {
	const current = useStore
		.getState()
		.agents.find((candidate) => candidate.id === plan.agent.id);
	if (current && !sameAgentRemovalTarget(current, plan.identity)) {
		throw new AgentRemovalTargetMismatchError();
	}
	const finalizationIdentity = current
		? agentRemovalRegistrationIdentity(current)
		: undefined;
	const assertProjectionUnchanged = () => {
		const latest = useStore
			.getState()
			.agents.find((candidate) => candidate.id === plan.agent.id);
		const unchanged = finalizationIdentity
			? Boolean(
					latest && sameAgentRemovalProjection(latest, finalizationIdentity),
				)
			: !latest;
		if (!unchanged) {
			throw new AgentRemovalTargetMismatchError();
		}
	};
	const authority = plan.stopAuthority;
	if (authority.kind === "canonical") {
		return {
			kind: "canonical",
			plan,
			target: authority.target,
		};
	}
	if (authority.kind === "backend") {
		return {
			kind: "backend",
			plan,
			target: authority.target,
			finalizationIdentity,
		};
	}
	if (authority.kind === "managed") {
		try {
			const operation = await prepareManagedAgentStopOperation(
				authority.target,
			);
			assertProjectionUnchanged();
			return {
				kind: "managed",
				plan,
				operation,
				finalizationIdentity,
			};
		} catch (error) {
			if (error instanceof ManagedSessionAbsentError) {
				assertProjectionUnchanged();
				return { kind: "registry", plan, finalizationIdentity };
			}
			throw error;
		}
	}
	if (authority.kind === "standalone") {
		const session = await inspectHmuxSessionExact({
			sessionId: authority.binding.sessionId,
			workspaceId: authority.binding.workspaceId,
		});
		assertProjectionUnchanged();
		if (!session) return { kind: "registry", plan, finalizationIdentity };
		if (session.sessionClass !== "standalone") {
			throw new AgentRemovalTargetMismatchError();
		}
		return {
			kind: "standalone",
			plan,
			operation: {
				binding: authority.binding,
				terminalEpoch: session.terminalEpoch,
			},
			finalizationIdentity,
		};
	}
	return { kind: "registry", plan, finalizationIdentity };
}

export async function executeAgentRemovalDispatch(
	dispatch: AgentRemovalDispatch,
	options: { readonly resumeCanonical?: boolean } = {},
): Promise<StoppedAgentRemoval> {
	if (dispatch.kind === "canonical") {
		try {
			const receipt = await (options.resumeCanonical
				? resumeCanonicalAgentStopV1(dispatch.target)
				: executeCanonicalAgentStopV1(dispatch.target));
			return {
				kind: "canonical",
				plan: dispatch.plan,
				target: dispatch.target,
				receipt,
			};
		} catch (error) {
			if (!(error instanceof CanonicalAgentStopPreviewNotFoundError))
				throw error;
			const current = useStore
				.getState()
				.agents.find((agent) => agent.id === dispatch.plan.agent.id);
			if (
				!current ||
				!sameAgentRemovalTarget(current, dispatch.plan.identity)
			) {
				throw new AgentRemovalTargetMismatchError();
			}
			const finalizationIdentity = agentRemovalRegistrationIdentity(current);
			// ponytail: reuse the backend's fenced removal journal when spawn history
			// is missing. It retires runtime ownership while preserving the checkout.
			await createDureAgentRuntimeClient({
				profileId: dispatch.target.provenance.backendProfileId,
			}).remove(current.id, error.routeAuthority);
			return { kind: "registry", plan: dispatch.plan, finalizationIdentity };
		}
	}
	if (dispatch.kind === "backend") {
		await dispatch.target.client.remove(
			dispatch.target.agent.id,
			dispatch.target.routeAuthority,
		);
		return {
			kind: "registry",
			plan: dispatch.plan,
			finalizationIdentity: dispatch.finalizationIdentity,
		};
	}
	if (dispatch.kind === "managed") {
		try {
			const receipt = await stopPreparedManagedAgentProvider(
				dispatch.operation,
			);
			return {
				kind: "managed",
				plan: dispatch.plan,
				stopped: { target: dispatch.operation.target, receipt },
			};
		} catch (error) {
			if (error instanceof ManagedSessionAbsentError) {
				return {
					kind: "registry",
					plan: dispatch.plan,
					finalizationIdentity: dispatch.finalizationIdentity,
				};
			}
			throw error;
		}
	}
	if (dispatch.kind === "standalone") {
		const { binding, terminalEpoch } = dispatch.operation;
		await hmux.terminateExact(
			binding.sessionId,
			binding.workspaceId,
			terminalEpoch,
			"standalone",
		);
	}
	return {
		kind: "registry",
		plan: dispatch.plan,
		finalizationIdentity: dispatch.finalizationIdentity,
	};
}

export async function stoppedAgentRemovalAppliesToAgent(
	removal: StoppedAgentRemoval,
	current: Agent,
	projects: readonly Project[],
	sshHosts: readonly SshHostConfig[],
): Promise<boolean> {
	if (removal.kind === "canonical") {
		return (
			current.id === removal.plan.agent.id &&
			canonicalAgentStopAppliesToAgentV1(
				removal.receipt,
				removal.target.provenance,
				current,
			)
		);
	}
	if (removal.kind === "managed") {
		return await managedAgentStopReceiptAppliesToAgent(
			removal.stopped.target,
			removal.stopped.receipt,
			current,
			projects,
			sshHosts,
		);
	}
	return Boolean(
		removal.finalizationIdentity &&
			sameAgentRemovalProjection(current, removal.finalizationIdentity),
	);
}

export async function finalizeStoppedAgentRemoval(
	removal: StoppedAgentRemoval,
): Promise<void> {
	if (removal.kind === "canonical") {
		await applyCanonicalAgentStopPresentationV1(
			removal.target.provenance,
			removal.receipt,
		);
		return;
	}
	if (removal.kind === "managed") {
		try {
			await finalizeManagedAgentRemoval(
				removal.stopped.target,
				removal.stopped.receipt,
			);
		} catch (error) {
			if (error instanceof PaneCommandError && error.code === "pane_changed") {
				return;
			}
			throw error;
		}
		return;
	}
	const finalizationIdentity = removal.finalizationIdentity;
	if (!finalizationIdentity) return;
	await removeAgentProjectionDurably({
		agents: [
			{
				agentId: removal.plan.agent.id,
				panelIds: removal.plan.panelIds,
				sessionIds: removal.plan.sessions.map((ref) => ref.sessionId),
				applies: (current) =>
					sameAgentRemovalProjection(current, finalizationIdentity),
			},
		],
	});
}
