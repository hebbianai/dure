// What the Work view lists, in which sections and order. Every registered
// Agent appears, in every project and on every backend, with or without a
// pane, and so does a provider found running in a plain shell pane. Who
// manages whom comes only from the relation owner (agentRelations.ts), who
// needs a person only from the needs-person order Next up keeps, and what has
// a result only from agentResult; this module arranges what they say. Missing
// facts never exclude an entry: without a manager it is a top-level row in
// its project, without a project it is in the no-project group, and an
// ended tree is folded at the bottom of its group, never left out. The module
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
	/** Entries whose row reads Exited: their session is gone. An entry whose
	 * state is unknown is not among them. */
	readonly ended: readonly string[];
	/** Registered projects, in the order the person keeps them. */
	readonly projects: readonly { readonly id: string; readonly name: string }[];
	readonly depth: WorkDepth;
	readonly grouping: WorkGrouping;
}

/** A folded part of the list: its rows show only while the person has it
 * open. */
export interface WorkListFold {
	/** The identity its open state is kept under. */
	readonly key: string;
	readonly rows: readonly WorkListRow[];
}

/** The fold of today's results, below every group. */
export const RESULTS_TODAY_FOLD_KEY = "results-today";

/** A group's identity in the list: its project, the agents with no
 * registered project, or the one list shown without grouping. */
export function workGroupKey(
	grouping: WorkGrouping,
	projectId: string | undefined,
): string {
	if (grouping === "none") return "all";
	return projectId === undefined ? "no-project" : `project:${projectId}`;
}

/** The key of a group's Ended fold. */
export function endedFoldKey(groupKey: string): string {
	return `ended:${groupKey}`;
}

export interface WorkListRow {
	readonly key: string;
	/** Its display manager when the row sits under it (Expand all). */
	readonly under?: string;
	/** How far below the group's top level the row sits; 0 for a root. */
	readonly level: number;
}

interface WorkListGroup {
	/** The group's identity in the list. */
	readonly key: string;
	/** The project the group's top-level agents belong to; absent for the
	 * group of agents with no registered project, and for the one list
	 * without grouping. */
	readonly projectId?: string;
	readonly projectName?: string;
	readonly rows: readonly WorkListRow[];
	/** Trees in which every agent ended, folded at the bottom of the group.
	 * A tree with anything working, unknown, needing a person or with a
	 * result today stays in `rows`. */
	readonly ended: WorkListFold;
}

export interface WorkViewList {
	/** Everything a person is needed for, at any depth; each row's path names
	 * its managers. */
	readonly needsYou: readonly WorkListRow[];
	readonly groups: readonly WorkListGroup[];
	/** Results since the start of the day, folded. An entry that needs a
	 * person is listed there instead. */
	readonly resultsToday: WorkListFold;
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
	const listed = new Set(project.keys());
	const needsYou = facts.needsYou.filter((key) => listed.has(key));
	const waiting = new Set(needsYou);
	// An entry is done with when it ended and is no news: nothing a person
	// must answer and no result today. A tree folds only when all of it is.
	const ended = new Set(facts.ended);
	const results = new Set(facts.resultsToday);
	const doneWith = (key: string) =>
		ended.has(key) && !waiting.has(key) && !results.has(key);
	const treeDoneWith = (root: string) =>
		doneWith(root) &&
		subtreeRows(facts.relations, root).every((row) => doneWith(row.key));
	const rowsFor = (keys: readonly string[]): WorkListRow[] =>
		keys.flatMap((key) => [
			{ key, level: 0 },
			...(facts.depth === "all" ? subtreeRows(facts.relations, key) : []),
		]);
	const group = (
		identity: Pick<WorkListGroup, "key" | "projectId" | "projectName">,
		keys: readonly string[],
	): WorkListGroup => {
		const open: string[] = [];
		const folded: string[] = [];
		for (const key of keys) (treeDoneWith(key) ? folded : open).push(key);
		return {
			...identity,
			rows: rowsFor(open),
			ended: { key: endedFoldKey(identity.key), rows: rowsFor(folded) },
		};
	};

	const groups: WorkListGroup[] = [];
	if (facts.grouping === "none") {
		if (roots.length > 0) {
			groups.push(group({ key: workGroupKey("none", undefined) }, roots));
		}
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
			if (keys) {
				groups.push(
					group(
						{ key: workGroupKey("project", id), projectId: id, projectName: name },
						keys,
					),
				);
			}
		}
		const unassigned = rootsByGroup.get(undefined);
		if (unassigned) {
			groups.push(group({ key: workGroupKey("project", undefined) }, unassigned));
		}
	}

	return {
		needsYou: needsYou.map((key) => ({ key, level: 0 })),
		groups,
		resultsToday: {
			key: RESULTS_TODAY_FOLD_KEY,
			rows: facts.resultsToday
				.filter((key) => listed.has(key) && !waiting.has(key))
				.map((key) => ({ key, level: 0 })),
		},
	};
}

/** The keys of every fold the list has, empty or not. */
export function workListFoldKeys(list: WorkViewList): readonly string[] {
	return [...list.groups.map((group) => group.ended.key), list.resultsToday.key];
}

/** Every row the list shows, in reading order, for keyboard movement. A
 * fold contributes its rows only while its key is in `openFolds`. */
export function workListOrder(
	list: WorkViewList,
	openFolds: readonly string[],
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
	const addFold = (fold: WorkListFold) => {
		if (openFolds.includes(fold.key)) add(fold.rows);
	};
	add(list.needsYou);
	for (const group of list.groups) {
		add(group.rows);
		addFold(group.ended);
	}
	addFold(list.resultsToday);
	return keys;
}
