// Store wiring for the Work view's list. Who manages whom comes from the
// relation owner, who needs a person and what has a result from the Next up
// order (with the Work view's own window, the local day), and plain shell
// panes from the Spaces rows, which already find them. The list arrangement
// itself is workViewList.
import { useMemo } from "react";
import {
	useAgentManagedSummary,
	useAgentRelations,
} from "@/components/agents/useAgentRelations";
import {
	useAgentRevealSpaceNames,
	useNextUp,
} from "@/components/agents/useNextUp";
import { useLocalDayTick } from "@/components/spaces/useNowTick";
import { type SpaceRow, useSpaces } from "@/components/spaces/useSpaces";
import type { AgentRowFacts } from "@/lib/agents/agentRowModel";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { AgentRelations } from "@/lib/agents/relations/agentRelations";
import type { NeedsPersonReason } from "@/lib/agents/needsPerson";
import { type WorkViewList, workViewList } from "@/lib/work/workViewList";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { useStore } from "@/store";

/** A plain shell pane with a provider found running in it, or that agents
 * were started from. It has no Agent record, so it has no conversation or
 * large window: only its pane, and the agents it started. */
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

function shellEntries(
	rows: readonly SpaceRow[],
	relations: AgentRelations,
): WorkShellEntry[] {
	return rows.flatMap((row) =>
		row.agentId ||
		!row.relationKey ||
		row.hidden ||
		(!row.provider && relations.managedBy(row.relationKey).length === 0)
			? []
			: [
					{
						key: row.relationKey,
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

/** What a plain shell pane's row reports, the way every row does: its
 * provider's state and, when the needs-person rule flags it, why, and what
 * the agents started from it amount to. */
export function useWorkShellRowFacts(shell: WorkShellEntry): AgentRowFacts {
	const managed = useAgentManagedSummary(shell.key);
	return {
		agentId: shell.key,
		title: shell.title,
		...(shell.state ? { state: shell.state } : {}),
		...(shell.needsPerson ? { needsPerson: { reason: shell.needsPerson } } : {}),
		...(shell.projectName ? { projectName: shell.projectName } : {}),
		...(shell.spaceName ? { spaceName: shell.spaceName } : {}),
		...(managed ? { managed } : {}),
	};
}

/** One shell pane's entry, for a view of that entry alone. */
export function useWorkShell(key: string): WorkShellEntry | undefined {
	const spaceRows = useSpaces();
	const relations = useAgentRelations();
	return useMemo(
		() => shellEntries(spaceRows, relations).find((shell) => shell.key === key),
		[spaceRows, relations, key],
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

	const shells = useMemo(
		() => shellEntries(spaceRows, relations),
		[spaceRows, relations],
	);
	const agentIds = useMemo(() => agents.map((agent) => agent.id), [agents]);
	const spaceNames = useAgentRevealSpaceNames(agentIds, "pane");
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
				projects,
				depth,
				grouping,
			}),
		[agents, shells, relations, nextUp, projects, depth, grouping],
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
