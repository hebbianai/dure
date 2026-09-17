import { supportsStructuredChat } from "@/lib/agents/providers";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	AgentRuntimeTransitionProjectionV1,
	DureAgentRuntimeProjectionContextV1,
	DureAgentRuntimeProjectionInspectResultV1,
	DureAgentRuntimeTransitionResultV1,
	NativeRuntimeTransitionProjectionV1,
	StructuredRuntimeTransitionProjectionV1,
} from "@/lib/ipc/dureAgentRuntime";
import {
	type DureBackendRouteAuthorityV1,
	resolveDureBackendSshHost,
	resolveExactDureBackendSshHost,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";
import {
	hmuxManagedBinding,
	remoteHmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import type { Agent, Project, SshHostConfig } from "@/types";

export interface AgentRuntimeProjectionContextOptionsV1 {
	readonly projectionContext: DureAgentRuntimeProjectionContextV1;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	readonly sshHosts: readonly SshHostConfig[];
}

/** Action-local project route parsed from a registered backend projection.
 * It carries only the identity fields runtime projection consumes and is
 * never written into the IDE Project store. */
export interface AgentRuntimeProjectionProjectV1 {
	readonly id: string;
	readonly path: string;
	readonly kind: "local" | "ssh";
	readonly sshHostId?: string;
}

export interface AgentRuntimeTransitionRouteV1 {
	backendProfileId: string;
	/** Changes only when the immutable backend/agent/provider/host route changes.
	 * Runtime and credential snapshots are replaceable facts read through it. */
	key: string;
}

export type AgentRuntimeActionProjectionV1 =
	| DureAgentRuntimeTransitionResultV1
	| (DureAgentRuntimeTransitionResultV1 & {
			readonly projectionContext: DureAgentRuntimeProjectionContextV1;
	  })
	| Extract<DureAgentRuntimeProjectionInspectResultV1, { state: "stable" }>;

export function withAgentRuntimeProjectionContext(
	result: DureAgentRuntimeTransitionResultV1,
	routeAuthority: DureBackendRouteAuthorityV1,
	projectionContext: DureAgentRuntimeProjectionContextV1 | undefined,
): AgentRuntimeActionProjectionV1 {
	if (!sameDureBackendRouteAuthority(result.routeAuthority, routeAuthority)) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	return projectionContext
		? { ...result, routeAuthority, projectionContext }
		: result;
}

export function resolveAgentRuntimeProjectionProject(
	agent: Agent,
	projects: readonly Project[],
	context: DureAgentRuntimeProjectionContextV1,
	routeAuthority: DureBackendRouteAuthorityV1,
	sshHosts: readonly SshHostConfig[] = [],
): AgentRuntimeProjectionProjectV1 | undefined {
	if (context.identity.kind === "checkpoint_bootstrap") {
		return projects.find((candidate) => candidate.id === agent.projectId);
	}
	// IDE membership and registered backend project IDs are separate namespaces.
	// Keep the pane's existing project; the context assertion binds it to the
	// backend repository path and exact local/SSH route before projection.
	const assigned = projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	if (assigned && assigned.id !== context.project.projectId) return assigned;
	const current = projects.find(
		(candidate) => candidate.id === context.project.projectId,
	);
	if (current) return { ...current, path: context.project.rootPath };
	return routeAuthority.target.source === "local"
		? {
				id: context.project.projectId,
				path: context.project.rootPath,
				kind: "local",
			}
		: {
				id: context.project.projectId,
				path: context.project.rootPath,
				kind: "ssh",
				sshHostId: resolveDureBackendSshHost(routeAuthority, sshHosts, () => {
					throw new Error("client_agent_runtime_transition_conflict");
				}).id,
			};
}

/** Authorizes one backend projection against the pane's Agent and exact
 * action-local project route. The control plane owns whether an identity is
 * registered or a checkpoint bootstrap; the frontend only binds that typed
 * provenance to its current local/SSH route. A bootstrap project describes
 * the first adopted pane, while the Agent workspace and selected runtime
 * receipt own this pane's worktree and current runtime workspace. */
export function assertAgentRuntimeProjectionContext(
	agent: Agent,
	project: AgentRuntimeProjectionProjectV1,
	contextOptions: AgentRuntimeProjectionContextOptionsV1,
): void {
	const { projectionContext, routeAuthority, sshHosts } = contextOptions;
	const worktreePath = agent.worktreePath;
	const commonIdentityMatches =
		supportsStructuredChat(agent.provider) &&
		projectionContext.agent.agentId === agent.id &&
		projectionContext.agent.providerId === agent.provider &&
		(agent.projectId === undefined || agent.projectId === project.id);
	const projectIdentityMatches =
		projectionContext.identity.kind === "registered"
			? (projectionContext.project.projectId === project.id ||
					agent.projectId === project.id) &&
				projectionContext.project.rootPath === project.path
			: agent.projectId === project.id &&
				typeof worktreePath === "string" &&
				worktreePath.length > 0 &&
				projectionContext.workspace.rootPath === worktreePath;
	if (!commonIdentityMatches || !projectIdentityMatches) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	if (project.kind === "local") {
		if (routeAuthority.target.source !== "local") {
			throw new Error("client_agent_runtime_transition_conflict");
		}
		return;
	}
	if (!project.sshHostId) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	resolveExactDureBackendSshHost(
		routeAuthority,
		project.sshHostId,
		sshHosts,
		() => {
			throw new Error("client_agent_runtime_transition_conflict");
		},
	);
}

/** Finds the immutable control-plane route without treating a cached
 * credential or runtime snapshot as admission authority. The backend owns all
 * destructive checks; a fenced Stable receipt replaces these local fields. */
export function agentRuntimeTransitionRoute(
	agent: Agent,
	project: AgentRuntimeProjectionProjectV1 | undefined,
): AgentRuntimeTransitionRouteV1 | undefined {
	if (
		!supportsStructuredChat(agent.provider) ||
		!project ||
		project.id !== agent.projectId
	) {
		return undefined;
	}
	const hostId = project.kind === "local" ? "local" : project.sshHostId;
	if (!hostId) return undefined;
	const profile = agent.interactionProfile;
	let backendProfileId: string | undefined;
	if (profile?.kind === "structured_protocol") {
		if (agent.runtimeBinding !== undefined) return undefined;
		backendProfileId = profile.backendProfileId;
	} else {
		const binding = agent.runtimeBinding;
		if (profile !== undefined || binding?.runtime !== "hmux_managed_v1") {
			return undefined;
		}
		if (project.kind === "local" && binding.source === "local") {
			backendProfileId = binding.backendProfileId ?? "local";
		} else if (
			project.kind === "ssh" &&
			binding.source === "ssh" &&
			binding.hostId === hostId
		) {
			backendProfileId = binding.backendProfileId;
		}
	}
	if (!backendProfileId) return undefined;
	return {
		backendProfileId,
		key: [agent.id, agent.provider, project.id, hostId, backendProfileId].join(
			"\u0000",
		),
	};
}

/** Returns the one control-plane profile that owns a valid Chat/runtime
 * transition. Local legacy bindings converge on the built-in `local` profile;
 * SSH never guesses a backend profile from a host id. */
export function agentRuntimeTransitionBackendProfileId(
	agent: Agent,
	project: AgentRuntimeProjectionProjectV1 | undefined,
): string | undefined {
	return agentRuntimeTransitionRoute(agent, project)?.backendProfileId;
}

export function supportsStructuredChatTransition(
	agent: Agent,
	project: AgentRuntimeProjectionProjectV1 | undefined,
): boolean {
	return (
		agent.interactionProfile === undefined &&
		agentRuntimeTransitionBackendProfileId(agent, project) !== undefined
	);
}

export function supportsStructuredRuntimeTransition(
	agent: Agent,
	project: AgentRuntimeProjectionProjectV1 | undefined,
): boolean {
	return (
		agent.interactionProfile?.kind === "structured_protocol" &&
		agentRuntimeTransitionBackendProfileId(agent, project) !== undefined
	);
}
export function projectStructuredChatTransition(
	agent: Agent,
	transition: StructuredRuntimeTransitionProjectionV1,
	backendProfileId: string,
): Agent {
	const existingProfile = agent.interactionProfile;
	const binding = agent.runtimeBinding;
	const nativeBackendProfileId = managedBackendProfileId(agent);
	if (
		agent.id !== transition.agentId ||
		agent.provider !== transition.providerId ||
		(existingProfile !== undefined && binding !== undefined) ||
		(existingProfile === undefined &&
			nativeBackendProfileId !== backendProfileId) ||
		(existingProfile !== undefined &&
			existingProfile.backendProfileId !== backendProfileId)
	) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	return applyStructuredChatProjection(agent, transition, backendProfileId);
}

function applyStructuredChatProjection(
	agent: Agent,
	transition: StructuredRuntimeTransitionProjectionV1,
	backendProfileId: string,
): Agent {
	const credentialId =
		transition.executionProfile.kind === "credential_reference"
			? transition.executionProfile.reference_id
			: undefined;
	return {
		...agent,
		// The backend has stopped this exact native source. Keeping its Hmux
		// binding would make persistence correctly reject the simultaneous Chat
		// profile and route the next app launch back to a dead Terminal.
		runtimeBinding: undefined,
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId,
			interactionSessionId: transition.interactionSessionId,
		},
		executionProfile: transition.executionProfile,
		started: true,
		accountId: credentialId ?? null,
		credentialId,
		conversationId: transition.providerConversationRef ?? undefined,
		conversationIdentity: undefined,
		pendingCredentialSwitch: undefined,
		skipPermissions:
			transition.launchSelection.permissionMode === "skip_permissions",
	};
}

export function projectNativeCliTransition(
	agent: Agent,
	transition: NativeRuntimeTransitionProjectionV1,
	backendProfileId: string,
	project: AgentRuntimeProjectionProjectV1,
): Agent {
	const profile = agent.interactionProfile;
	const nativeBackendProfileId = managedBackendProfileId(agent);
	if (
		agent.id !== transition.agentId ||
		agent.provider !== transition.providerId ||
		project.id !== agent.projectId ||
		(profile !== undefined && agent.runtimeBinding !== undefined) ||
		(profile !== undefined && profile.backendProfileId !== backendProfileId) ||
		(profile === undefined && nativeBackendProfileId !== backendProfileId)
	) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	return applyNativeCliProjection(agent, transition, backendProfileId, project);
}

function applyNativeCliProjection(
	agent: Agent,
	transition: NativeRuntimeTransitionProjectionV1,
	backendProfileId: string,
	project: AgentRuntimeProjectionProjectV1,
): Agent {
	const credentialId =
		transition.executionProfile.kind === "credential_reference"
			? transition.executionProfile.reference_id
			: undefined;
	const existingBinding = agent.runtimeBinding;
	const exactExistingBinding =
		existingBinding?.runtime === "hmux_managed_v1" &&
		existingBinding.sessionId === transition.sessionId &&
		existingBinding.workspaceId === transition.workspaceId &&
		sameHmuxManagedGeneration(existingBinding.stopFence, transition.stopFence)
			? existingBinding
			: undefined;
	const launchIdempotencyKey =
		transition.launchIdempotencyKey ??
		exactExistingBinding?.createIdempotencyKey;
	if (!launchIdempotencyKey) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	const runtimeBinding =
		project.kind === "local"
			? {
					...hmuxManagedBinding(
						transition.sessionId,
						transition.workspaceId,
						credentialId,
						undefined,
						transition.stopFence,
						backendProfileId,
					),
					createIdempotencyKey: launchIdempotencyKey,
				}
			: project.sshHostId
				? remoteHmuxManagedBinding(
						transition.sessionId,
						transition.workspaceId,
						project.sshHostId,
						exactExistingBinding?.source === "ssh" &&
							exactExistingBinding.hostId === project.sshHostId
							? exactExistingBinding.commandBridgeNonce
							: `bridge_${agent.id}`,
						launchIdempotencyKey,
						transition.stopFence,
						credentialId,
						exactExistingBinding?.source === "ssh" &&
							exactExistingBinding.hostId === project.sshHostId &&
							exactExistingBinding.credentialId === credentialId
							? exactExistingBinding.credentialProfileDirectory
							: undefined,
						backendProfileId,
					)
				: undefined;
	if (!runtimeBinding) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	return {
		...agent,
		sessionId: transition.sessionId,
		sessionKind: project.kind === "local" ? "pty" : "ssh",
		runtimeBinding,
		interactionProfile: undefined,
		executionProfile: transition.executionProfile,
		started: true,
		accountId: credentialId ?? null,
		credentialId,
		conversationId: transition.providerConversationRef ?? undefined,
		conversationIdentity: undefined,
		pendingCredentialSwitch: undefined,
		skipPermissions:
			transition.launchSelection.permissionMode === "skip_permissions",
	};
}

function managedBackendProfileId(agent: Agent): string | undefined {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1") return undefined;
	return binding.source === "local"
		? (binding.backendProfileId ?? "local")
		: binding.backendProfileId;
}

export function projectRuntimeTransition(
	agent: Agent,
	transition: AgentRuntimeTransitionProjectionV1,
	backendProfileId: string,
	project: AgentRuntimeProjectionProjectV1 | undefined,
	contextOptions?: AgentRuntimeProjectionContextOptionsV1,
): Agent {
	if (!project) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	if (!contextOptions) {
		if (
			agentRuntimeTransitionBackendProfileId(agent, project) !==
			backendProfileId
		) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
		return transition.interactionProfile === "structured_protocol"
			? projectStructuredChatTransition(agent, transition, backendProfileId)
			: projectNativeCliTransition(
					agent,
					transition,
					backendProfileId,
					project,
				);
	}

	const { projectionContext, routeAuthority } = contextOptions;
	assertAgentRuntimeProjectionContext(agent, project, contextOptions);
	if (
		transition.agentId !== agent.id ||
		transition.providerId !== agent.provider ||
		routeAuthority.profileId !== backendProfileId
	) {
		throw new Error("client_agent_runtime_transition_conflict");
	}

	const existingRoute = agentRuntimeTransitionBackendProfileId(agent, project);
	if (existingRoute !== undefined) {
		if (existingRoute !== backendProfileId) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
	} else if (agent.interactionProfile != null || agent.runtimeBinding != null) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	const projectedAgent = {
		...agent,
		projectId: project.id,
		worktreePath: projectionContext.workspace.rootPath,
	};
	return transition.interactionProfile === "structured_protocol"
		? applyStructuredChatProjection(
				projectedAgent,
				transition,
				backendProfileId,
			)
		: applyNativeCliProjection(
				projectedAgent,
				transition,
				backendProfileId,
				project,
			);
}
