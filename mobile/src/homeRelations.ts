/**
 * Who manages whom among home's rows, through the desktop's one relation owner
 * (`@/lib/agents/relations/agentRelations`). Tauri/DOM 없이 시험된다.
 *
 * The phone records no relation of its own. Each computer names the Agent a
 * row shows and that Agent's display manager (`SessionPresentation.agentId`,
 * `managerAgentId`), and this file hands those facts to the shared forest, so
 * the phone nests agents to any depth with the desktop's own rules: a cycle is
 * broken and counted once, and a manager this phone has no row for is no
 * manager here.
 *
 * # Missing facts never hide a row
 *
 * A row with no Agent id (a plain shell, an older computer, a laptop that is
 * offline) is its own node and a root, keyed by its session. So is an agent
 * whose manager is not listed. Nothing is persisted: the forest is rebuilt from
 * whatever the computers said this time.
 */

import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { NeedsPerson } from "@/lib/agents/needsPerson";
import {
	type AgentRelationEdge,
	type AgentRelationSummary,
	buildAgentRelations,
	summarizeAgentRelations,
} from "@/lib/agents/relations/agentRelations";
import type { UnifiedRow } from "./allSessions";

/** What this file reads of one home row. */
export interface HomeRelationRow {
	readonly row: Pick<UnifiedRow, "sessionId" | "title">;
	readonly agentId?: string;
	readonly managerAgentId?: string;
	readonly displayState?: AgentDisplayState;
	readonly need?: NeedsPerson;
}

export interface HomeRelations {
	/** Titles of the agents above the row's agent, outermost first. */
	path(view: HomeRelationRow): readonly string[];
	/** What the row's agent manages over its subtree; absent when nothing. */
	managed(view: HomeRelationRow): AgentRelationSummary | undefined;
}

/** The forest node a row stands for: its Agent when a computer named one, else the row. */
function nodeOf(view: HomeRelationRow): string {
	return view.agentId ? `agent:${view.agentId}` : `row:${view.row.sessionId}`;
}

/**
 * The forest over these rows, in their listing order. That order is the
 * owner's start order, which only decides where a cycle breaks; a computer
 * reports managers from a forest that has none.
 */
export function homeRelations(rows: readonly HomeRelationRow[]): HomeRelations {
	const nodes: string[] = [];
	const edges: AgentRelationEdge[] = [];
	const titles = new Map<string, string>();
	const needsPerson = new Map<string, NeedsPerson>();
	const displayStates: Record<string, AgentDisplayState | undefined> = {};
	for (const view of rows) {
		const node = nodeOf(view);
		nodes.push(node);
		// The same agent listed twice is one node; its first row names it.
		if (titles.has(node)) continue;
		titles.set(node, view.row.title);
		if (view.need) needsPerson.set(node, view.need);
		displayStates[node] = view.displayState;
		if (view.agentId && view.managerAgentId)
			edges.push({
				child: node,
				manager: `agent:${view.managerAgentId}`,
				source: "computer_reported",
			});
	}
	const relations = buildAgentRelations(nodes, edges);
	const summaries = summarizeAgentRelations(relations, {
		needsPerson,
		displayStates,
	});
	return {
		path: (view) =>
			relations.chain(nodeOf(view)).flatMap((node) => {
				const title = titles.get(node);
				return title === undefined ? [] : [title];
			}),
		managed: (view) => summaries.get(nodeOf(view)),
	};
}
