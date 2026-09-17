import { useMemo } from "react";
import { useSpaces } from "@/components/spaces/useSpaces";
import type { IssueTrackerIssueSummaryV1 } from "@/contracts/generated/extensionContracts";
import {
	groupAgentClaims,
	selectAgentClaimPanes,
} from "@/lib/plugins/agentClaims";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";

export function useIssueTrackerAgentClaims(
	projectId: string | null,
	claimIssues: IssueTrackerIssueSummaryV1[],
	statuses: string[],
) {
	const spaces = useSpaces();
	const agents = useStore((state) => state.agents);
	const selectedPaneId = useStore((state) => state.focusCtx?.key);
	const navigation = useWindowSidebarStore((state) => state.pluginSelection);
	const panes = useMemo(
		() => selectAgentClaimPanes(spaces, agents, projectId),
		[agents, projectId, spaces],
	);
	const groups = useMemo(
		() => groupAgentClaims(panes, claimIssues, statuses, selectedPaneId),
		[claimIssues, panes, statuses, selectedPaneId],
	);
	return { groups, selectedPaneId, navigation };
}
