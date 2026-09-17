import { parseAgentCanonicalSpawnV1 } from "@/lib/agents/agentCanonicalSpawn";
import { agentHostReferenceIds } from "@/lib/agents/agentHostReferences";
import {
	agentRemovalRegistrationIdentity,
	sameAgentRemovalProjection,
} from "@/lib/agents/agentRemovalRegistration";
import { parseAgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import { normalizeAgentInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import {
	sameAgentOperationalIdentity,
	samePaneOperationalIdentity,
	sameProjectOperationalIdentity,
	sameSshHostOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import { parseHmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	convergeDurableCas,
	convergeDurableIdEntities,
	DURABLE_FIELD_MISSING,
	type DurableFieldValue,
} from "@/lib/persistence/durableWriteCoordinator";
import type { PersistedAppState } from "@/lib/persistence/persistedAppState";
import {
	isTerminalPaneBindingV1,
	normalizeTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	classifyTerminalPaneHost,
	terminalPaneHostId,
	terminalPaneReferencedHostIds,
} from "@/lib/terminal/paneHostIdentity";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { gitProjectIdFromPane } from "@/lib/scm/gitPaneTarget";
import type { Agent, Project, SshHostConfig } from "@/types";

export interface PaneLayoutConvergenceContext {
	readonly localPaneIdsBySpace: ReadonlyMap<string, ReadonlySet<string>>;
	readonly remotePaneIdsBySpace: ReadonlyMap<string, ReadonlySet<string>>;
}

interface PersistedEntityConvergence<T> {
	readonly entities: T[];
	readonly localSemanticIds: ReadonlySet<string>;
	readonly remoteSemanticIds: ReadonlySet<string>;
}

function keyedEntities<T extends { id: string }>(
	entities: readonly T[],
): Map<string, T> | undefined {
	const keyed = new Map<string, T>();
	for (const entity of entities) {
		if (!entity || typeof entity.id !== "string" || keyed.has(entity.id)) {
			return undefined;
		}
		keyed.set(entity.id, entity);
	}
	return keyed;
}

function orderedEntities<T extends { id: string }>(
	mergedById: ReadonlyMap<string, T>,
	...orders: readonly (readonly T[])[]
): T[] {
	const entities: T[] = [];
	const emittedIds = new Set<string>();
	for (const entity of orders.flat()) {
		const merged = mergedById.get(entity.id);
		if (!merged || emittedIds.has(entity.id)) continue;
		emittedIds.add(entity.id);
		entities.push(merged);
	}
	return entities;
}

/** Exact predecessor deletion wins; a new operational identity wins deletion. */
function convergeRemovalAwareEntities<T extends { id: string }>(
	baseEntities: readonly T[],
	localEntities: T[],
	remoteEntities: T[],
	sameRemovalTarget: (current: T, expected: T) => boolean,
): PersistedEntityConvergence<T> {
	const generic = convergeDurableIdEntities(
		[...baseEntities],
		localEntities,
		remoteEntities,
	);
	const genericEntities = Array.isArray(generic) ? generic : remoteEntities;
	const baseById = keyedEntities(baseEntities);
	const localById = keyedEntities(localEntities);
	const remoteById = keyedEntities(remoteEntities);
	if (!baseById || !localById || !remoteById) {
		return {
			entities: genericEntities,
			localSemanticIds: new Set(),
			remoteSemanticIds: new Set(),
		};
	}

	const mergedById = new Map(
		genericEntities.map((entity) => [entity.id, entity] as const),
	);
	const localSemanticIds = new Set<string>();
	const remoteSemanticIds = new Set<string>();
	for (const id of new Set([
		...baseById.keys(),
		...remoteById.keys(),
		...localById.keys(),
	])) {
		const base = baseById.get(id);
		const local = localById.get(id);
		const remote = remoteById.get(id);
		if (!base) {
			if (local && remote && !sameRemovalTarget(local, remote)) {
				mergedById.set(id, remote);
				remoteSemanticIds.add(id);
			} else {
				if (local) localSemanticIds.add(id);
				if (remote) remoteSemanticIds.add(id);
			}
			continue;
		}
		if (local && remote) {
			const localIsSuccessor = !sameRemovalTarget(local, base);
			const remoteIsSuccessor = !sameRemovalTarget(remote, base);
			if (localIsSuccessor || remoteIsSuccessor) {
				const selected = localIsSuccessor && !remoteIsSuccessor ? local : remote;
				mergedById.set(id, selected);
				(selected === local ? localSemanticIds : remoteSemanticIds).add(id);
			}
			continue;
		}
		const candidate = local ?? remote;
		if (!candidate) continue;
		if (sameRemovalTarget(candidate, base)) mergedById.delete(id);
		else {
			mergedById.set(id, candidate);
			(local ? localSemanticIds : remoteSemanticIds).add(id);
		}
	}

	return {
		entities: orderedEntities(
			mergedById,
			genericEntities,
			remoteEntities,
			localEntities,
		),
		localSemanticIds,
		remoteSemanticIds,
	};
}

function hasExactManagedAgentGeneration(agent: Agent): boolean {
	const canonicalSpawn = parseAgentCanonicalSpawnV1(agent.canonicalSpawn);
	const executionProfile = parseAgentExecutionProfileV1(agent.executionProfile);
	if (!canonicalSpawn || !executionProfile) return false;
	const interactionProfile = normalizeAgentInteractionProfileV1(
		agent.interactionProfile,
	);
	if (interactionProfile) {
		return (
			agent.runtimeBinding === undefined &&
			interactionProfile.backendProfileId === canonicalSpawn.backendProfileId
		);
	}
	if (agent.interactionProfile !== undefined) return false;
	const binding = normalizeTerminalPaneBindingV1(agent.runtimeBinding);
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		!binding.createIdempotencyKey ||
		!binding.backendProfileId ||
		binding.backendProfileId !== canonicalSpawn.backendProfileId ||
		agent.sessionId !== binding.sessionId
	) {
		return false;
	}
	return parseHmuxManagedGenerationV1(binding.stopFence) !== undefined;
}

function isAgentRegistrationSuccessor(
	base: Agent | undefined,
	candidate: Agent | undefined,
): boolean {
	return (
		base !== undefined &&
		candidate !== undefined &&
		!sameAgentRemovalProjection(
			candidate,
			agentRemovalRegistrationIdentity(base),
		)
	);
}

function agentDisplayName(
	agent: Agent | undefined,
): DurableFieldValue<Agent["displayName"]> {
	return agent && Object.getOwnPropertyDescriptor(agent, "displayName") !== undefined
		? agent.displayName
		: DURABLE_FIELD_MISSING;
}

function withConvergedAgentPresentation(
	base: Agent | undefined,
	local: Agent,
	remote: Agent,
	selected: Agent,
): Agent {
	const displayName = convergeDurableCas(
		agentDisplayName(base),
		agentDisplayName(local),
		agentDisplayName(remote),
	);
	const merged = { ...selected };
	if (displayName === DURABLE_FIELD_MISSING) delete merged.displayName;
	else merged.displayName = displayName;
	return merged;
}

interface PersistedAgentConvergence {
	readonly agents: Agent[];
	readonly localSemanticIds: ReadonlySet<string>;
	readonly remoteSemanticIds: ReadonlySet<string>;
}

export function convergePersistedAgents(
	baseAgents: readonly Agent[],
	localAgents: Agent[],
	remoteAgents: Agent[],
): PersistedAgentConvergence {
	const generic = convergeDurableIdEntities(
		[...baseAgents],
		localAgents,
		remoteAgents,
	);
	const genericAgents = Array.isArray(generic) ? generic : remoteAgents;
	const baseById = keyedEntities(baseAgents);
	const localById = keyedEntities(localAgents);
	const remoteById = keyedEntities(remoteAgents);
	if (!baseById || !localById || !remoteById) {
		return {
			agents: genericAgents,
			localSemanticIds: new Set(),
			remoteSemanticIds: new Set(),
		};
	}
	const mergedById = new Map(
		genericAgents.map((agent) => [agent.id, agent] as const),
	);
	const localSemanticIds = new Set<string>();
	const remoteSemanticIds = new Set<string>();
	for (const id of new Set([
		...baseById.keys(),
		...remoteById.keys(),
		...localById.keys(),
	])) {
		const base = baseById.get(id);
		const local = localById.get(id);
		const remote = remoteById.get(id);
		const localHasExactManagedGeneration = local
			? hasExactManagedAgentGeneration(local)
			: false;
		const remoteHasExactManagedGeneration = remote
			? hasExactManagedAgentGeneration(remote)
			: false;
		if (base && local && remote) {
			const localIsSuccessor = isAgentRegistrationSuccessor(base, local);
			const remoteIsSuccessor = isAgentRegistrationSuccessor(base, remote);
			if (
				(localHasExactManagedGeneration && remoteHasExactManagedGeneration) ||
				localIsSuccessor ||
				remoteIsSuccessor
			) {
				const selected =
					localIsSuccessor && !remoteIsSuccessor
						? local
						: remoteIsSuccessor
							? remote
							: convergeDurableCas(base, local, remote);
				if (selected === DURABLE_FIELD_MISSING) continue;
				mergedById.set(
					id,
					withConvergedAgentPresentation(base, local, remote, selected),
				);
				if (selected === local ? localIsSuccessor : remoteIsSuccessor) {
					const semanticIds =
						selected === local ? localSemanticIds : remoteSemanticIds;
					semanticIds.add(id);
				}
			}
			continue;
		}
		if (base && local && !remote) {
			if (isAgentRegistrationSuccessor(base, local)) {
				mergedById.set(id, local);
				localSemanticIds.add(id);
			} else {
				mergedById.delete(id);
			}
			continue;
		}
		if (base && remote && !local) {
			if (isAgentRegistrationSuccessor(base, remote)) {
				mergedById.set(id, remote);
				remoteSemanticIds.add(id);
			} else {
				mergedById.delete(id);
			}
			continue;
		}
		if (!base && local && remote) {
			const sameRegistration = sameAgentOperationalIdentity(local, remote);
			mergedById.set(
				id,
				sameRegistration
					? withConvergedAgentPresentation(undefined, local, remote, remote)
					: remote,
			);
			remoteSemanticIds.add(id);
			if (sameRegistration) {
				localSemanticIds.add(id);
			}
			continue;
		}
		if (!base && local) {
			localSemanticIds.add(id);
			continue;
		}
		if (!base && remote) {
			remoteSemanticIds.add(id);
		}
	}
	return {
		agents: orderedEntities(
			mergedById,
			genericAgents,
			remoteAgents,
			localAgents,
		),
		localSemanticIds,
		remoteSemanticIds,
	};
}

export interface PersistedReferenceConvergence {
	readonly projects: Project[];
	readonly sshHosts: SshHostConfig[];
	readonly panes: PaneLayoutConvergenceContext;
	readonly localProtectedProjectIds: ReadonlySet<string>;
	readonly remoteProtectedProjectIds: ReadonlySet<string>;
}

function paneOperationalOwner(
	params: Readonly<Record<string, unknown>>,
): string | undefined {
	const hostId = terminalPaneHostId(params);
	if (!hostId) return undefined;
	const binding = normalizeTerminalPaneBindingV1(params.binding);
	const sessionId =
		binding?.sessionId ??
		(typeof params.sessionId === "string" ? params.sessionId : undefined);
	return JSON.stringify({
		hostId,
		sessionId,
		runtime: binding?.runtime,
		workspaceId: binding?.workspaceId,
	});
}

function semanticPaneIdsBySpace(
	base: PersistedAppState | undefined,
	source: PersistedAppState,
	resources: {
		semanticAgentIds: ReadonlySet<string>;
		survivingAgentIds: ReadonlySet<string>;
		semanticProjectIds: ReadonlySet<string>;
		survivingProjectIds: ReadonlySet<string>;
		semanticHostIds: ReadonlySet<string>;
		survivingHostIds: ReadonlySet<string>;
		retiredHostIds: ReadonlySet<string>;
	},
): Map<string, ReadonlySet<string>> {
	const paneIdsBySpace = new Map<string, ReadonlySet<string>>();
	for (const [spaceId, layout] of Object.entries(source.layouts)) {
		const paneIds = new Set<string>();
		const basePanes = new Map(
			panelsFromLayout(base?.layouts[spaceId]).map((pane) => [pane.id, pane]),
		);
		for (const pane of panelsFromLayout(layout)) {
			const previous = basePanes.get(pane.id);
			const agentId =
				pane.component === "agent"
					? agentIdFromPaneParameters(pane.params)
					: undefined;
			const previousAgentId =
				previous?.component === "agent"
					? agentIdFromPaneParameters(previous.params)
					: undefined;
			if (agentId !== undefined) {
				if (
					resources.survivingAgentIds.has(agentId) &&
					(resources.semanticAgentIds.has(agentId) ||
						agentId !== previousAgentId)
				) {
					paneIds.add(pane.id);
				}
			} else if (
				previousAgentId !== undefined &&
				!resources.survivingAgentIds.has(previousAgentId)
			) {
				// Retiring the previous Agent cannot retire this pane's new content.
				paneIds.add(pane.id);
			}
			const projectId = gitProjectIdFromPane(pane);
			const previousProjectId = previous
				? gitProjectIdFromPane(previous)
				: undefined;
			if (projectId !== undefined) {
				if (
					resources.survivingProjectIds.has(projectId) &&
					(resources.semanticProjectIds.has(projectId) ||
						projectId !== previousProjectId)
				) {
					paneIds.add(pane.id);
				}
			} else if (
				previousProjectId !== undefined &&
				!resources.survivingProjectIds.has(previousProjectId)
			) {
				paneIds.add(pane.id);
			}
			const referencedHostIds = terminalPaneReferencedHostIds(pane.params);
			const ownerChanged =
				previous !== undefined &&
				paneOperationalOwner(previous.params) !== paneOperationalOwner(pane.params);
			const previousHostId = previous
				? terminalPaneHostId(previous.params)
				: undefined;
			const movedFromRetiredHost =
				ownerChanged &&
				previousHostId !== undefined &&
				resources.retiredHostIds.has(previousHostId) &&
				isTerminalPaneBindingV1(pane.params.binding) &&
				pane.params.binding.source === "local";
			if (
				referencedHostIds.some(
					(hostId) =>
						resources.survivingHostIds.has(hostId) &&
						(resources.semanticHostIds.has(hostId) ||
							!previous ||
							ownerChanged),
				) ||
				(referencedHostIds.length === 0 && movedFromRetiredHost)
			) {
				paneIds.add(pane.id);
			}
		}
		if (paneIds.size > 0) paneIdsBySpace.set(spaceId, paneIds);
	}
	return paneIdsBySpace;
}

export function convergePersistedReferences(
	base: PersistedAppState | undefined,
	local: PersistedAppState,
	remote: PersistedAppState,
	agents: PersistedAgentConvergence,
): PersistedReferenceConvergence {
	const projects = convergeRemovalAwareEntities(
		base?.projects ?? [],
		local.projects,
		remote.projects,
		sameProjectOperationalIdentity,
	);
	const hosts = convergeRemovalAwareEntities(
		base?.sshHosts ?? [],
		local.sshHosts,
		remote.sshHosts,
		sameSshHostOperationalIdentity,
	);
	const projectsById = new Map(
		projects.entities.map((project) => [project.id, project] as const),
	);
	const hostsById = new Map(
		hosts.entities.map((host) => [host.id, host] as const),
	);
	const mergedAgentsById =
		keyedEntities(agents.agents) ?? new Map<string, Agent>();
	const sides = [
		{
			state: local,
			agentIds: agents.localSemanticIds,
			projectIds: new Set(projects.localSemanticIds),
			hostIds: new Set(hosts.localSemanticIds),
			directHostIds: new Set(hosts.localSemanticIds),
			protectedProjectIds: new Set(projects.localSemanticIds),
		},
		{
			state: remote,
			agentIds: agents.remoteSemanticIds,
			projectIds: new Set(projects.remoteSemanticIds),
			hostIds: new Set(hosts.remoteSemanticIds),
			directHostIds: new Set(hosts.remoteSemanticIds),
			protectedProjectIds: new Set(projects.remoteSemanticIds),
		},
	];

	// Semantic authority closes upward only: Agent -> Project -> SSH host.
	// It never revives unchanged descendants of a surviving parent.
	for (const side of sides) {
		const sourceAgentsById = keyedEntities(side.state.agents);
		const sourceProjectsById = keyedEntities(side.state.projects);
		if (!sourceAgentsById || !sourceProjectsById) continue;
		for (const agentId of side.agentIds) {
			const sourceAgent = sourceAgentsById.get(agentId);
			const mergedAgent = mergedAgentsById.get(agentId);
			if (!sourceAgent || sourceAgent.projectId !== mergedAgent?.projectId) {
				continue;
			}
			const candidate = sourceProjectsById.get(sourceAgent.projectId);
			if (!candidate) continue;
			const current = projectsById.get(candidate.id);
			if (!current) {
				projectsById.set(candidate.id, candidate);
				side.protectedProjectIds.add(candidate.id);
			}
			if (
				!current ||
				sameProjectOperationalIdentity(projectsById.get(candidate.id), candidate)
			) {
				side.projectIds.add(candidate.id);
			}
		}
	}

	for (const side of sides) {
		const sourceAgentsById = keyedEntities(side.state.agents);
		const sourceProjectsById = keyedEntities(side.state.projects);
		const sourceHostsById = keyedEntities(side.state.sshHosts);
		if (!sourceAgentsById || !sourceProjectsById || !sourceHostsById) continue;
		for (const agentId of side.agentIds) {
			const sourceAgent = sourceAgentsById.get(agentId);
			const mergedAgent = mergedAgentsById.get(agentId);
			if (
				!sourceAgent ||
				!sameAgentOperationalIdentity(sourceAgent, mergedAgent)
			) {
				continue;
			}
			for (const hostId of agentHostReferenceIds(sourceAgent)) {
				const candidate = sourceHostsById.get(hostId);
				if (!candidate) continue;
				const current = hostsById.get(hostId);
				if (!current) hostsById.set(hostId, candidate);
				if (
					!current ||
					sameSshHostOperationalIdentity(hostsById.get(hostId), candidate)
				) {
					side.hostIds.add(hostId);
				}
			}
		}
		for (const projectId of side.projectIds) {
			const project = projectsById.get(projectId);
			const sourceProject = sourceProjectsById.get(projectId);
			if (
				project?.kind !== "ssh" ||
				!project.sshHostId ||
				!sameProjectOperationalIdentity(project, sourceProject)
			) {
				continue;
			}
			const candidate = sourceHostsById.get(project.sshHostId);
			if (!candidate) continue;
			const current = hostsById.get(project.sshHostId);
			if (!current) hostsById.set(candidate.id, candidate);
			if (
				!current ||
				sameSshHostOperationalIdentity(hostsById.get(candidate.id), candidate)
			) {
				side.hostIds.add(candidate.id);
			}
		}
	}

	// A changed pane may carry a forward binding that this build cannot parse.
	// Its Host hints preserve ancestry only; destructive ownership still comes
	// exclusively from classifyTerminalPaneHost.
	for (const side of sides) {
		const sourceHostsById = keyedEntities(side.state.sshHosts);
		if (!sourceHostsById) continue;
		for (const [spaceId, layout] of Object.entries(side.state.layouts)) {
			const basePanes = new Map(
				panelsFromLayout(base?.layouts[spaceId]).map((pane) => [pane.id, pane]),
			);
			for (const pane of panelsFromLayout(layout)) {
				const previous = basePanes.get(pane.id);
				if (
					previous &&
					samePaneOperationalIdentity(previous.params, pane.params)
				) {
					continue;
				}
				for (const hostId of terminalPaneReferencedHostIds(pane.params)) {
					if (classifyTerminalPaneHost(pane.params, hostId) !== "unresolved") {
						continue;
					}
					const candidate = sourceHostsById.get(hostId);
					if (!candidate) continue;
					const current = hostsById.get(hostId);
					if (!current) hostsById.set(hostId, candidate);
					if (
						!current ||
						sameSshHostOperationalIdentity(hostsById.get(hostId), candidate)
					) {
						side.hostIds.add(hostId);
						side.directHostIds.add(hostId);
					}
				}
			}
		}
	}

	const survivingAgentIds = new Set(agents.agents.map((agent) => agent.id));
	const survivingProjectIds = new Set(projectsById.keys());
	const survivingHostIds = new Set(hostsById.keys());
	const paneIdsBySide = sides.map((side, sideIndex) => {
		const oppositeHosts = keyedEntities(
			sides[sideIndex === 0 ? 1 : 0].state.sshHosts,
		);
		const retiredHostIds = new Set(
			(base?.sshHosts ?? []).flatMap((host) =>
				sameSshHostOperationalIdentity(oppositeHosts?.get(host.id), host)
					? []
					: [host.id],
			),
		);
		return semanticPaneIdsBySpace(base, side.state, {
			semanticAgentIds: side.agentIds,
			survivingAgentIds,
			semanticProjectIds: side.protectedProjectIds,
			survivingProjectIds,
			semanticHostIds: side.directHostIds,
			survivingHostIds,
			retiredHostIds,
		});
	});

	return {
		projects: orderedEntities(
			projectsById,
			projects.entities,
			remote.projects,
			local.projects,
			base?.projects ?? [],
		),
		sshHosts: orderedEntities(
			hostsById,
			hosts.entities,
			remote.sshHosts,
			local.sshHosts,
			base?.sshHosts ?? [],
		),
		panes: {
			localPaneIdsBySpace: paneIdsBySide[0],
			remotePaneIdsBySpace: paneIdsBySide[1],
		},
		localProtectedProjectIds: sides[0].protectedProjectIds,
		remoteProtectedProjectIds: sides[1].protectedProjectIds,
	};
}
