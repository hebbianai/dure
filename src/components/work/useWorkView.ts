// Store wiring for the Work view's list. Who manages whom comes from the
// relation owner, who needs a person and what has a result from the Next up
// order (with the Work view's own window, the local day), what ended from the
// display state each row's dot shows, and providers in plain shell panes from
// the Spaces rows, which already find them. The list arrangement itself is
// workViewList.
import { useMemo } from "react";
import { useAgentRelations } from "@/components/agents/useAgentRelations";
import {
	useAgentRevealSpaceNames,
	useNextUp,
} from "@/components/agents/useNextUp";
import { useLocalDayTick } from "@/components/spaces/useNowTick";
import { type SpaceRow, useSpaces } from "@/components/spaces/useSpaces";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { NeedsPersonReason } from "@/lib/agents/needsPerson";
import { type WorkViewList, workViewList } from "@/lib/work/workViewList";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { useStore } from "@/store";

/** A provider found running in a plain shell pane. It has no Agent record,
 * so it has no relations, conversation or large window: only its pane. */
export interface WorkShellEntry {
	readonly key: string;
	readonly desktopId: string;
	readonly panelId: string;
	readonly title: string;
	readonly state?: AgentDisplayState;
	readonly needsPerson?: NeedsPersonReason;
	readonly projectId?: string;
	readonly projectName?: string;
	readonly spaceName?: string;
}

export interface WorkView {
	readonly list: WorkViewList;
	readonly shells: ReadonlyMap<string, WorkShellEntry>;
	/** The Space each listed Agent's pane is in; none without a pane. */
	readonly spaceNames: ReadonlyMap<string, string>;
	/** Start of the local day: the window of "Has a result today". */
	readonly dayStart: number;
}

const SHELL_KEY_PREFIX = "pane:";

/** The key of a shell pane's entry. Pane ids are unique per Space only. */
function workShellKey(desktopId: string, panelId: string): string {
	return `${SHELL_KEY_PREFIX}${desktopId}:${panelId}`;
}

/** Whether a Work entry's key names a shell pane rather than an Agent. */
export function isWorkShellKey(key: string): boolean {
	return key.startsWith(SHELL_KEY_PREFIX);
}

function shellEntries(rows: readonly SpaceRow[]): WorkShellEntry[] {
	return rows.flatMap((row) =>
		row.agentId || !row.provider || row.hidden
			? []
			: [
					{
						key: workShellKey(row.desktopId, row.key),
						desktopId: row.desktopId,
						panelId: row.key,
						title: row.title,
						...(row.displayState
							? { state: row.displayState as AgentDisplayState }
							: {}),
						...(row.needsPerson ? { needsPerson: row.needsPerson } : {}),
						...(row.projectId ? { projectId: row.projectId } : {}),
						...(row.projectId && row.projectName
							? { projectName: row.projectName }
							: {}),
						...(row.desktopName ? { spaceName: row.desktopName } : {}),
					},
				],
	);
}

/** One shell pane's entry, for a view of that entry alone. */
export function useWorkShell(key: string): WorkShellEntry | undefined {
	const spaceRows = useSpaces();
	return useMemo(
		() => shellEntries(spaceRows).find((shell) => shell.key === key),
		[spaceRows, key],
	);
}

export function useWorkView(): WorkView {
	const agents = useStore((state) => state.agents);
	const projects = useStore((state) => state.projects);
	const relations = useAgentRelations();
	const dayStart = useLocalDayTick();
	const nextUp = useNextUp(dayStart);
	const spaceRows = useSpaces();
	const depth = useWorkViewStore((state) => state.depth);
	const grouping = useWorkViewStore((state) => state.grouping);
	const displayStates = useAgentAttention((state) => state.displayStates);

	const shells = useMemo(() => shellEntries(spaceRows), [spaceRows]);
	const agentIds = useMemo(() => agents.map((agent) => agent.id), [agents]);
	const spaceNames = useAgentRevealSpaceNames(agentIds, "pane");
	// Keyed on its content, so a dot that changes without ending an agent
	// does not rebuild the list.
	const endedKeys = [
		...agentIds.filter((id) => displayStates[id] === "exited"),
		...shells.flatMap((shell) => (shell.state === "exited" ? [shell.key] : [])),
	].join("\n");
	const ended = useMemo(
		() => (endedKeys ? endedKeys.split("\n") : []),
		[endedKeys],
	);
	const list = useMemo(
		() =>
			workViewList({
				agents: agents.map((agent) => ({
					key: agent.id,
					projectId: agent.projectId,
				})),
				shells,
				relations,
				needsYou: nextUp.needsYou.map((entry) => entry.agentId),
				resultsToday: nextUp.results.map((entry) => entry.agentId),
				ended,
				projects,
				depth,
				grouping,
			}),
		[agents, shells, relations, nextUp, ended, projects, depth, grouping],
	);
	return useMemo(
		() => ({
			list,
			shells: new Map(shells.map((shell) => [shell.key, shell])),
			spaceNames,
			dayStart,
		}),
		[list, shells, spaceNames, dayStart],
	);
}
