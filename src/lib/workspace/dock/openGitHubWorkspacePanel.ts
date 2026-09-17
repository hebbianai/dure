/** The GitHub work ledger pane — one per Space, rescoped in place when it is
 * already open. One issue as a pane is openGitHubIssuePanel. */

import { track } from "@/lib/ipc/telemetry";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { dockPanelParameters } from "@/lib/workspace/dock/dockPanelParameters";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";

/** Open the full GitHub work ledger, optionally scoped to one local project. */
export function openGitHubWorkspacePanel(
	desktopId: string,
	projectId?: string | null,
	name?: string,
) {
	withDesktopDockview(desktopId, (api) => {
		const params = projectId ? { projectId } : {};
		const title = name ? `GitHub · ${name}` : "GitHub";
		const existing = api.panels.find(
			(panel) => panel.api.component === "github",
		);
		if (!existing) track("github_panel_opened");
		openOrFocusPanel({
			api,
			panelId: existing?.id ?? createPaneId(),
			component: "github",
			title,
			params,
			onExisting: (existing) => {
				existing.api.updateParameters({
					...dockPanelParameters(existing),
					projectId: projectId ?? undefined,
				});
				applyAutomaticPaneTitle(existing.api, title);
			},
		});
	});
}
