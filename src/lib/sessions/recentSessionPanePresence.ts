import type { RecentSessionDragPayload } from "@/lib/sessions/recentSessionDrag";
import type { RecentWorkItem } from "@/lib/sessions/recentWork";
import type { Agent, Project } from "@/types";

/** Whether this Agent runs the exact provider conversation of a recent
 * session, in the same place: local, or the same SSH host. */
export function recentSessionAgentExecutionMatches(
	agent: Agent,
	project: Project | undefined,
	payload: Pick<
		RecentSessionDragPayload,
		"provider" | "conversationId" | "executionLocation" | "hostId"
	>,
): boolean {
	if (
		agent.provider !== payload.provider ||
		agent.conversationId?.trim() !== payload.conversationId
	) {
		return false;
	}
	const binding = agent.runtimeBinding;
	if (binding) {
		return (
			binding.source === payload.executionLocation &&
			binding.hostId ===
				(payload.executionLocation === "local" ? "local" : payload.hostId)
		);
	}
	return payload.executionLocation === "local"
		? project?.kind === "local"
		: project?.kind === "ssh" && project.sshHostId === payload.hostId;
}

/** Which Space shows each recent session in a pane right now, keyed by the
 * session: the Space of the first pane of an Agent running that exact
 * conversation in the same place. Presentation only — opening a session still
 * resolves its current runtime generation. */
export function recentSessionPaneSpaces(input: {
	items: readonly RecentWorkItem[];
	agents: readonly Agent[];
	projects: readonly Project[];
	paneLocations: readonly {
		readonly agentId: string;
		readonly desktopId: string;
	}[];
}): ReadonlyMap<string, string> {
	const spaceByAgentId = new Map<string, string>();
	for (const pane of input.paneLocations) {
		if (!spaceByAgentId.has(pane.agentId)) {
			spaceByAgentId.set(pane.agentId, pane.desktopId);
		}
	}
	const projectById = new Map(
		input.projects.map((project) => [project.id, project] as const),
	);
	const result = new Map<string, string>();
	for (const item of input.items) {
		const paneAgent = input.agents.find(
			(agent) =>
				spaceByAgentId.has(agent.id) &&
				recentSessionAgentExecutionMatches(
					agent,
					projectById.get(agent.projectId),
					item,
				),
		);
		const spaceId = paneAgent ? spaceByAgentId.get(paneAgent.id) : undefined;
		if (spaceId) result.set(item.key, spaceId);
	}
	return result;
}
