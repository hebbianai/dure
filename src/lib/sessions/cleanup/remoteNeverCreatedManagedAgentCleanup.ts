import { isLegacyAgentWriterTarget } from "@/lib/agents/agentWriterPartition";
import { sameManagedCreateSource } from "@/lib/sessions/managed/managedCreateSourceCas";
import {
	isRemoteHmuxPaneBinding,
	type RemoteHmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { Agent, Project, SshHostConfig } from "@/types";

export interface RemoteNeverCreatedManagedAgentCleanupCandidate {
	agent: Agent;
	binding: RemoteHmuxManagedPaneBindingV1;
	project: Project & { kind: "ssh"; sshHostId: string };
	host: SshHostConfig;
}

function remoteNeverCreatedBinding(
	agent: Agent,
): RemoteHmuxManagedPaneBindingV1 | undefined {
	const binding = agent.runtimeBinding;
	return isRemoteHmuxPaneBinding(binding) &&
		"createIdempotencyKey" in binding &&
		agent.started === false &&
		binding.sessionId === agent.sessionId &&
		binding.stopFence === undefined &&
		binding.conversationIdentity === undefined
		? binding
		: undefined;
}

export function planRemoteNeverCreatedManagedAgentCleanup(input: {
	agent: Agent | undefined;
	projects: readonly Project[];
	sshHosts: readonly SshHostConfig[];
}): RemoteNeverCreatedManagedAgentCleanupCandidate | undefined {
	if (!isLegacyAgentWriterTarget(input.agent)) return undefined;
	const binding = remoteNeverCreatedBinding(input.agent);
	if (!binding) return undefined;
	const project = input.projects.find(
		(candidate) => candidate.id === input.agent?.projectId,
	);
	if (
		project?.kind !== "ssh" ||
		!project.sshHostId ||
		project.sshHostId !== binding.hostId
	) {
		return undefined;
	}
	const host = input.sshHosts.find(
		(candidate) => candidate.id === binding.hostId,
	);
	if (!host) return undefined;
	return {
		agent: {
			...input.agent,
			...(input.agent.terminalEnv
				? { terminalEnv: { ...input.agent.terminalEnv } }
				: {}),
			runtimeBinding: { ...binding },
		},
		binding: { ...binding },
		project: { ...project, kind: "ssh", sshHostId: project.sshHostId },
		host: { ...host },
	};
}

export function sameRemoteNeverCreatedManagedAgentCleanupCandidate(
	current: {
		agent: Agent | undefined;
		projects: readonly Project[];
		sshHosts: readonly SshHostConfig[];
	},
	expected: RemoteNeverCreatedManagedAgentCleanupCandidate,
): boolean {
	const candidate = planRemoteNeverCreatedManagedAgentCleanup(current);
	return (
		candidate !== undefined &&
		sameManagedCreateSource(candidate.agent, expected.agent) &&
		candidate.agent.started === expected.agent.started &&
		candidate.project.id === expected.project.id &&
		candidate.project.path === expected.project.path &&
		candidate.project.sshHostId === expected.project.sshHostId &&
		JSON.stringify(candidate.host) === JSON.stringify(expected.host)
	);
}
