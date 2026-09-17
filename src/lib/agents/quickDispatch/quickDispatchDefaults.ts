import type { QuickDispatchRemoteTarget } from "./quickDispatchIntent";
import type { FocusContext } from "@/lib/workspace/focusContext";
import type { Agent, Project, SshHostConfig } from "@/types";

/** Match the focused content within its execution host. An SSH context never
 * falls back to a local project or a different server. */
export function resolveQuickDispatchProject(input: {
	focusCtx: FocusContext | null;
	agents: readonly Agent[];
	projects: readonly Project[];
}): Project | null {
	const { focusCtx, agents, projects } = input;
	if (focusCtx?.agentId) {
		const agent = agents.find((candidate) => candidate.id === focusCtx.agentId);
		const project =
			agent && projects.find((candidate) => candidate.id === agent.projectId);
		if (project) return project;
	}
	if (focusCtx?.cwd) {
		const byCwd = projects
			.filter(
				(candidate) =>
					(focusCtx.source === "ssh"
						? Boolean(focusCtx.hostId) &&
							candidate.kind === "ssh" &&
							candidate.sshHostId === focusCtx.hostId
						: candidate.kind === "local") &&
					(focusCtx.cwd === candidate.path ||
						focusCtx.cwd.startsWith(`${candidate.path}/`)),
			)
			.sort((a, b) => b.path.length - a.path.length);
		if (byCwd[0]) return byCwd[0];
	}
	if (focusCtx?.source === "ssh") return null;
	return (
		projects.find((candidate) => candidate.kind === "local") ??
		projects[0] ??
		null
	);
}

/** Keep remote replay on the host and checkout selected before attachment upload. */
export function quickDispatchRemoteTarget(
	project: Project,
	hosts: readonly SshHostConfig[],
): QuickDispatchRemoteTarget | undefined {
	if (project.kind === "local") return undefined;
	const host = hosts.find((candidate) => candidate.id === project.sshHostId);
	if (!host) throw new Error("quick_dispatch_ssh_host_unavailable");
	return {
		hostId: host.id,
		path: project.path,
		host: host.host,
		port: host.port,
		user: host.user,
		registrationGeneration: host.registrationGeneration ?? null,
		sshConfigAlias: host.sshConfigAlias ?? null,
	};
}

export function sameQuickDispatchRemoteTarget(
	left: QuickDispatchRemoteTarget | undefined,
	right: QuickDispatchRemoteTarget | undefined,
): boolean {
	return (
		left === right ||
		Boolean(
			left &&
				right &&
				Object.entries(left).every(
					([key, value]) =>
						value === right[key as keyof QuickDispatchRemoteTarget],
				),
		)
	);
}
