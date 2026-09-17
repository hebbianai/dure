import { useMemo } from "react";
import { openGitHubIssueTargetKeys } from "@/lib/github/githubIssuePane";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

/** GitHub workspace cluster's only runtime store boundary. */
export function useGitHubWorkspaceState() {
	const projects = useStore((state) => state.projects);
	const agents = useStore((state) => state.agents);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	return { projects, agents, activeSpaceId };
}

/** Which issues are showing in a pane right now — the sidebar marks those
 *  rows the way the spaces tab marks a session that is open. Layouts change
 *  whenever a pane is added or closed, so they are the signal to re-derive;
 *  the walk itself reads the mounted Dockviews. The pane mode marks nothing
 *  and subscribes to nothing. */
export function useGitHubOpenIssueKeys(
	mode: "pane" | "sidebar",
): ReadonlySet<string> {
	const layouts = useStore((state) =>
		mode === "sidebar" ? state.layouts : undefined,
	);
	return useMemo(
		() =>
			layouts === undefined
				? new Set<string>()
				: openGitHubIssueTargetKeys(mountedDockviewEntries()),
		[layouts],
	);
}
