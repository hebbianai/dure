import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { Agent, Project } from "@/types";

export interface AgentNameQuery {
	/** Trimmed original query, used verbatim in caller error messages. */
	query: string;
	/** Present only for a `project/name` query. */
	projectName?: string;
	agentName: string;
}

/** Parse an exact agent query of the form `name` or `project/name`. */
export function parseAgentNameQuery(name: string): AgentNameQuery {
	const query = name.trim();
	if (!query) {
		throw new PaneCommandError("invalid_request", "name is required");
	}
	const slash = query.indexOf("/");
	return {
		query,
		projectName: slash > 0 ? query.slice(0, slash) : undefined,
		agentName: slash > 0 ? query.slice(slash + 1) : query,
	};
}

/** True when the agent belongs to a project carrying the queried name. */
export function agentInProjectNamed(
	agent: Agent,
	projectName: string,
	projects: readonly Project[],
): boolean {
	return projects.some(
		(project) => project.id === agent.projectId && project.name === projectName,
	);
}

/** Select the single query match; `label` names the caller's agent surface
 * (for example "Hmux agent" or "legacy agent"). */
export function uniqueAgentMatch(
	matches: readonly Agent[],
	label: string,
	query: string,
): Agent {
	if (matches.length === 0) {
		throw new PaneCommandError(
			"pane_not_found",
			`${label} ${query} was not found`,
		);
	}
	if (matches.length > 1) {
		throw new PaneCommandError(
			"pane_ambiguous",
			`${label} ${query} is ambiguous; use project/name`,
		);
	}
	return matches[0];
}
