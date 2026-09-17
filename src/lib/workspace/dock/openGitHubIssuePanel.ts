import {
	GITHUB_ISSUE_PANE_COMPONENT,
	githubIssuePaneRow,
	githubIssueTargetKey,
	githubIssueTargetKeyFromPane,
} from "@/lib/github/githubIssuePane";
import type { GitHubWorkItemRow } from "@/lib/github/githubResponses";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";

export function openGitHubIssuePanel(
	desktopId: string,
	row: GitHubWorkItemRow,
	position?: PanelPosition,
): void {
	if (row.kind !== "issue") return;
	withDesktopDockview(desktopId, (api) => {
		const target = githubIssueTargetKey(row);
		const existing = api.panels.find(
			(panel) =>
				githubIssueTargetKeyFromPane(dockPanelReference(panel)) === target,
		);
		const reference = position?.referenceGroup;
		const groupId =
			typeof reference === "string"
				? reference
				: (reference as { id?: string } | undefined)?.id;
		const emptyTarget = groupId && api.getGroup(groupId)?.panels.length === 0;
		openOrFocusPanel({
			api,
			panelId: existing?.id ?? createPaneId(),
			component: GITHUB_ISSUE_PANE_COMPONENT,
			title: `#${row.number} ${row.title}`,
			params: { row: githubIssuePaneRow(row) },
			// A boundary insertion supplies an empty group; occupied targets never stack.
			position:
				position?.direction === "within" && !emptyTarget
					? { ...position, direction: "right" }
					: position,
		});
	});
}
