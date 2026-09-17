// The Sessions pane's recent-session list: the store, provider-history and
// removed-session subscriptions it reads, and the projections derived from
// them. The projections are pure lib functions; this hook owns only React
// subscription lifetimes and memoization. What the reader chose — query, view
// options, open groups — stays with the pane.
import { useMemo } from "react";
import { useRecentSessionHistory } from "@/components/sessions/useRecentSessionHistory";
import { recentSessionPaneSpaces } from "@/lib/sessions/recentSessionPanePresence";
import { projectRecentSessionsView } from "@/lib/sessions/recentSessionsViewProjection";
import { isRecentSessionHidden } from "@/lib/sessions/recentSessionVisibility";
import { useRecentSessionVisibilityStore } from "@/lib/sessions/recentSessionVisibilityStore";
import { projectRecentWork } from "@/lib/sessions/recentWork";
import type { SessionsViewOptions } from "@/lib/sessions/sessionsViewOptions";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

/** The most rows the Sessions pane lists at once. */
const SESSIONS_LIST_LIMIT = 50;

export type RecentSessionsList = ReturnType<typeof useRecentSessionsList>;

export function useRecentSessionsList({
	query,
	viewOptions,
}: {
	query: string;
	viewOptions: SessionsViewOptions;
}) {
	const agents = useStore((state) => state.agents);
	const projects = useStore((state) => state.projects);
	const activity = useStore((state) => state.agentActivity);
	const layouts = useStore((state) => state.layouts);
	const sshHosts = useStore((state) => state.sshHosts);
	const history = useRecentSessionHistory(sshHosts);
	const hidden = useRecentSessionVisibilityStore((state) => state.hidden);
	const entries = history.entries;
	const visibleEntries = useMemo(
		() => entries.filter((entry) => !isRecentSessionHidden(entry, hidden)),
		[entries, hidden],
	);
	const hiddenEntries = useMemo(
		() => entries.filter((entry) => isRecentSessionHidden(entry, hidden)),
		[entries, hidden],
	);
	const inventory = useMemo(
		() =>
			projectRecentWork({
				entries: visibleEntries,
				agents,
				projects,
				activity,
				query,
				// Pane filtering belongs to the view projection and must happen
				// before its visible cap, so the whole eligible inventory stays here.
				limit: visibleEntries.length,
			}),
		[activity, agents, projects, query, visibleEntries],
	);
	// Layouts and the Agent list signal that pane membership may have changed;
	// the walk itself prefers the mounted Dockview panes over saved layouts.
	const paneLocations = useMemo(
		() => agentPaneLocations(layouts, mountedDockviewEntries()),
		[agents, layouts],
	);
	const paneSpaceBySessionKey = useMemo(
		() =>
			recentSessionPaneSpaces({
				items: inventory.groups.flatMap((group) => group.items),
				agents,
				projects,
				paneLocations,
			}),
		[agents, inventory, paneLocations, projects],
	);
	const projection = useMemo(
		() =>
			projectRecentSessionsView({
				projection: inventory,
				options: viewOptions,
				openPaneSessionKeys: new Set(paneSpaceBySessionKey.keys()),
				limit: SESSIONS_LIST_LIMIT,
			}),
		[inventory, paneSpaceBySessionKey, viewOptions],
	);
	const hiddenCount = useMemo(
		() =>
			projectRecentWork({
				entries: hiddenEntries,
				agents,
				projects,
				activity,
				limit: hiddenEntries.length,
			}).total,
		[activity, agents, hiddenEntries, projects],
	);
	const loading =
		history.loadState === "idle" || history.loadState === "loading";
	const failed = history.loadState === "error";
	return {
		sshHosts,
		loading,
		failed,
		/** The first load, with nothing to show yet. */
		bootstrapping: loading && entries.length === 0,
		inventoryTotal: inventory.total,
		projection,
		paneSpaceBySessionKey,
		hiddenCount,
		/** Rows, removed rows to restore, a load in flight or a failure to name. */
		hasContent:
			loading ||
			failed ||
			inventory.total > 0 ||
			projection.total > 0 ||
			hiddenCount > 0,
	};
}
