// What the Work view lists, in which sections and order. Every registered
// Agent appears, in every project and on every backend, with or without a
// pane, and so does a provider found running in a plain shell pane. Who
// manages whom comes only from the relation owner (agentRelations.ts), who
// needs a person only from the needs-person order Next up keeps, and what has
// a result only from agentResult; this module arranges what they say. Missing
// facts never exclude an entry: without a manager it is a top-level row in
// its project, without a project it is in the no-project group. The module
// imports no store, i18n or React.
import type { AgentRelations } from "@/lib/agents/relations/agentRelations";

/** Top level lists only the agents with no manager, each summing up what it
 * manages on its own row; Expand all lists every agent under its manager. */
export type WorkDepth = "top" | "all";

/** By project groups the list per project; otherwise it is one list. */
export type WorkGrouping = "project" | "none";

interface WorkViewEntry {
	/** The Agent id, or for a provider in a plain shell, its pane's key. */
	readonly key: string;
	readonly projectId?: string;
}

export interface WorkViewListFacts {
	/** Registered Agents in start order, as the store holds them. */
	readonly agents: readonly WorkViewEntry[];
	/** Providers found in plain shell panes. They have no Agent record and so
	 * no relation facts: each is a top-level row. */
	readonly shells: readonly WorkViewEntry[];
	readonly relations: AgentRelations;
	/** Entries a person is needed for, at any depth, in Next up's order
	 * (oldest wait first). */
	readonly needsYou: readonly string[];
	/** Entries with a result in the Work view's window (since the start of the
	 * local day), oldest first. */
	readonly resultsToday: readonly string[];
	/** Registered projects, in the order the person keeps them. */
	readonly projects: readonly { readonly id: string; readonly name: string }[];
	readonly depth: WorkDepth;
	readonly grouping: WorkGrouping;
}

export interface WorkListRow {
	readonly key: string;
	/** Its display manager when the row sits under it (Expand all). */
	readonly under?: string;
	/** How far below the group's top level the row sits; 0 for a root. */
	readonly level: number;
}

interface WorkListGroup {
	/** The project the group's top-level agents belong to; absent for the
	 * group of agents with no registered project, and for the one list
	 * without grouping. */
	readonly projectId?: string;
	readonly projectName?: string;
	readonly rows: readonly WorkListRow[];
}

export interface WorkViewList {
	/** Everything a person is needed for, at any depth; each row's path names
	 * its managers. */
	readonly needsYou: readonly WorkListRow[];
	readonly groups: readonly WorkListGroup[];
	/** Results since the start of the day, shown folded. An entry that needs
	 * a person is listed there instead. */
	readonly resultsToday: readonly WorkListRow[];
}

/** One entry's subtree below its own row, depth first in start order. */
function subtreeRows(
	relations: AgentRelations,
	root: string,
): WorkListRow[] {
	const rows: WorkListRow[] = [];
	const stack: WorkListRow[] = [...relations.managedBy(root)]
		.reverse()
		.map((key) => ({ key, under: root, level: 1 }));
	// The relation owner already broke every cycle, so this is a forest; the
	// guard only keeps a malformed one from looping.
	const seen = new Set<string>([root]);
	while (stack.length > 0) {
		const row = stack.pop() as WorkListRow;
		if (seen.has(row.key)) continue;
		seen.add(row.key);
		rows.push(row);
		const children = relations.managedBy(row.key);
		for (let index = children.length - 1; index >= 0; index -= 1) {
			stack.push({ key: children[index], under: row.key, level: row.level + 1 });
		}
	}
	return rows;
}

export function workViewList(facts: WorkViewListFacts): WorkViewList {
	const project = new Map<string, string | undefined>();
	for (const entry of [...facts.agents, ...facts.shells]) {
		project.set(entry.key, entry.projectId);
	}
	const known = new Set(facts.projects.map((candidate) => candidate.id));
	const groupOf = (key: string): string | undefined => {
		const id = project.get(key);
		return id !== undefined && known.has(id) ? id : undefined;
	};
	// The relation forest is built over the same Agents, in start order.
	const roots = [
		...facts.relations.roots.filter((key) => project.has(key)),
		...facts.shells.map((entry) => entry.key),
	];
	const rowsFor = (keys: readonly string[]): WorkListRow[] =>
		keys.flatMap((key) => [
			{ key, level: 0 },
			...(facts.depth === "all" ? subtreeRows(facts.relations, key) : []),
		]);

	const groups: WorkListGroup[] = [];
	if (facts.grouping === "none") {
		if (roots.length > 0) groups.push({ rows: rowsFor(roots) });
	} else {
		const rootsByGroup = new Map<string | undefined, string[]>();
		for (const key of roots) {
			const id = groupOf(key);
			const keys = rootsByGroup.get(id);
			if (keys) keys.push(key);
			else rootsByGroup.set(id, [key]);
		}
		for (const { id, name } of facts.projects) {
			const keys = rootsByGroup.get(id);
			if (keys) groups.push({ projectId: id, projectName: name, rows: rowsFor(keys) });
		}
		const unassigned = rootsByGroup.get(undefined);
		if (unassigned) groups.push({ rows: rowsFor(unassigned) });
	}

	const listed = new Set(project.keys());
	const needsYou = facts.needsYou.filter((key) => listed.has(key));
	const waiting = new Set(needsYou);
	return {
		needsYou: needsYou.map((key) => ({ key, level: 0 })),
		groups,
		resultsToday: facts.resultsToday
			.filter((key) => listed.has(key) && !waiting.has(key))
			.map((key) => ({ key, level: 0 })),
	};
}

/** Every row the list shows, in reading order, for keyboard movement. A
 * folded section contributes none. */
export function workListOrder(
	list: WorkViewList,
	resultsOpen: boolean,
): readonly string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	const add = (rows: readonly WorkListRow[]) => {
		for (const row of rows) {
			if (seen.has(row.key)) continue;
			seen.add(row.key);
			keys.push(row.key);
		}
	};
	add(list.needsYou);
	for (const group of list.groups) add(group.rows);
	if (resultsOpen) add(list.resultsToday);
	return keys;
}
