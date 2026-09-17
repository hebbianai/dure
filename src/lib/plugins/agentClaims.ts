import type { IssueTrackerIssueSummaryV1 } from "@/contracts/generated/extensionContracts";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import type { Agent } from "@/types";

export interface AgentClaimPane {
	id: string;
	label: string;
	branch: string;
}

interface AgentClaimPaneRow extends AgentClaimPane {
	issues: IssueTrackerIssueSummaryV1[];
}

export interface AgentClaimGroups {
	panes: AgentClaimPaneRow[];
	unmatched: IssueTrackerIssueSummaryV1[];
}

interface AgentClaimSpace {
	key: string;
	kind: string;
	agentId?: string;
}

export function selectAgentClaimPanes(
	spaces: readonly AgentClaimSpace[],
	agents: readonly Pick<
		Agent,
		"id" | "name" | "displayName" | "projectId" | "branch"
	>[],
	projectId: string | null,
): AgentClaimPane[] {
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	return spaces.flatMap((space) => {
		if (space.kind !== "agent" || !space.agentId) return [];
		const agent = agentsById.get(space.agentId);
		if (!agent || agent.projectId !== projectId) return [];
		return [
			{
				id: space.key,
				label: agentDisplayName(agent),
				branch: agent.branch,
			},
		];
	});
}

function compareIssues(
	left: IssueTrackerIssueSummaryV1,
	right: IssueTrackerIssueSummaryV1,
): number {
	// A tracker without priorities sorts after every ranked issue.
	const rank = (priority: number | null) =>
		priority ?? Number.MAX_SAFE_INTEGER;
	return (
		rank(left.priority) - rank(right.priority) || left.id.localeCompare(right.id)
	);
}

export function groupAgentClaims(
	panes: AgentClaimPane[],
	issues: IssueTrackerIssueSummaryV1[],
	claimedStatuses: string[],
	selectedPaneId?: string,
): AgentClaimGroups {
	const statuses = new Set(claimedStatuses);
	const active = issues.filter((issue) => statuses.has(issue.status));
	const branchCounts = new Map<string, number>();
	for (const pane of panes) {
		branchCounts.set(pane.branch, (branchCounts.get(pane.branch) ?? 0) + 1);
	}
	const paneByBranch = new Map(
		panes
			.filter((pane) => branchCounts.get(pane.branch) === 1)
			.map((pane) => [pane.branch, pane.id]),
	);
	const issuesByPane = new Map<string, IssueTrackerIssueSummaryV1[]>();
	const matched = new Set<string>();
	for (const issue of active) {
		const branch =
			issue.agent_binding?.kind === "scm_branch"
				? issue.agent_binding.branch
				: null;
		const paneId = branch ? paneByBranch.get(branch) : undefined;
		if (!paneId) continue;
		const paneIssues = issuesByPane.get(paneId) ?? [];
		paneIssues.push(issue);
		issuesByPane.set(paneId, paneIssues);
		matched.add(issue.id);
	}
	return {
		panes: panes
			.map((pane) => ({
				...pane,
				issues: (issuesByPane.get(pane.id) ?? []).sort(compareIssues),
			}))
			.sort((left, right) =>
				Number(right.id === selectedPaneId) - Number(left.id === selectedPaneId),
			),
		unmatched: active
			.filter((issue) => !matched.has(issue.id))
			.sort(compareIssues),
	};
}
