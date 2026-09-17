import {
	type AgentRemovalRegistrationIdentity,
	agentRemovalRegistrationIdentity,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import { agentReferencesHost } from "@/lib/agents/agentHostReferences";
import {
	sameProjectOperationalIdentity,
	sameSshHostOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import type { Agent, Project, SshHostConfig } from "@/types";

export interface SshHostRemovalScopeState {
	readonly sshHosts: readonly SshHostConfig[];
	readonly projects: readonly Project[];
	readonly agents: readonly Agent[];
}

export interface SshHostRemovalScopeSnapshot {
	readonly hostId: string;
	readonly host?: SshHostConfig;
	readonly projects: readonly Project[];
	readonly agents: readonly AgentRemovalRegistrationIdentity[];
}

export function captureSshHostRemovalScope(
	hostId: string,
	state: SshHostRemovalScopeState,
): SshHostRemovalScopeSnapshot {
	const projects = state.projects
		.filter((project) => project.sshHostId === hostId)
		.map((project) => ({ ...project }));
	const projectIds = new Set(projects.map((project) => project.id));
	const host = state.sshHosts.find((candidate) => candidate.id === hostId);
	return {
		hostId,
		...(host ? { host: { ...host } } : {}),
		projects,
		agents: state.agents
			.filter(
				(agent) =>
					projectIds.has(agent.projectId) || agentReferencesHost(agent, hostId),
			)
			.map(agentRemovalRegistrationIdentity),
	};
}

/** Exact CAS for the immutable Host scope captured before side effects. */
export function matchesSshHostRemovalScope(
	snapshot: SshHostRemovalScopeSnapshot,
	state: SshHostRemovalScopeState,
): boolean {
	const currentHost = state.sshHosts.find(
		(host) => host.id === snapshot.hostId,
	);
	if (!sameSshHostOperationalIdentity(currentHost, snapshot.host)) return false;

	const projectIds = new Set(snapshot.projects.map((project) => project.id));
	const currentProjects = state.projects.filter(
		(project) =>
			project.sshHostId === snapshot.hostId || projectIds.has(project.id),
	);
	if (
		currentProjects.length !== snapshot.projects.length ||
		currentProjects.some((project) => {
			const expected = snapshot.projects.find(
				(candidate) => candidate.id === project.id,
			);
			return !expected || !sameProjectOperationalIdentity(project, expected);
		})
	) {
		return false;
	}

	const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
	const currentAgents = state.agents.filter(
		(agent) =>
			projectIds.has(agent.projectId) ||
			agentIds.has(agent.id) ||
			agentReferencesHost(agent, snapshot.hostId),
	);
	return (
		currentAgents.length === snapshot.agents.length &&
		currentAgents.every((agent) => {
			const expected = snapshot.agents.find(
				(candidate) => candidate.id === agent.id,
			);
			return expected !== undefined && sameAgentRemovalTarget(agent, expected);
		})
	);
}
