// Who manages whom — the ONE relation owner. Every surface that says it reads
// the forest this module builds: Next up paths, Spaces' lead nesting and
// worker pane placement today; the Work view, crowded Space cards, a
// coordinator's team line and the phone as they arrive.
//
// Relations are facts, not roles. An agent manages others exactly when it has
// children, and agents nest to any depth. Every fact is kept with its source;
// one of them is the agent's display manager. Missing facts never exclude
// anyone: an agent with no usable fact is a root. The module imports no
// store, i18n or React, so the phone's build can share it.
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { NeedsPersonMap } from "@/lib/agents/needsPerson";

/** Where an edge fact comes from, highest display priority first. */
const AGENT_RELATION_SOURCES = [
	/** The Agent recorded as the Run's parent: the Chat agent that started it
	 * from its tool shell, which has no Session of its own. */
	"run_parent_agent",
	/** The Agent bound to the Run's parent Session now. */
	"run_parent_session",
	/** The Agent that owned that Session when this client first presented
	 * the Run. */
	"run_parent_recorded",
	/** The display manager the agent's computer reported in its catalog
	 * (`SessionPresentation.managerAgentId`). It is the phone's only fact:
	 * the computer already chose among its own. */
	"computer_reported",
] as const;

export type AgentRelationSource = (typeof AGENT_RELATION_SOURCES)[number];

/** One fact that `manager` manages `child`. */
export interface AgentRelationEdge {
	readonly child: string;
	readonly manager: string;
	readonly source: AgentRelationSource;
}

export interface AgentRelations {
	/** The agent's display manager: its highest-priority usable fact, unless
	 * that fact closed a cycle. */
	managerOf(agentId: string): string | undefined;
	/** Every usable fact about who manages the agent, one per manager, display
	 * priority first. A fact dropped to break a cycle stays listed here. */
	managersOf(agentId: string): readonly AgentRelationEdge[];
	/** The agents it manages directly, in start order. */
	managedBy(agentId: string): readonly string[];
	/** The agents with no display manager, in start order. */
	readonly roots: readonly string[];
	/** Its display managers, outermost first; empty for a root. With
	 * `below`, only the managers under that agent when it is one of them, so
	 * a list nested under an agent names the path from there. */
	chain(agentId: string, below?: string): readonly string[];
}

/** What one agent manages, over its whole display subtree. */
export interface AgentRelationSummary {
	/** Every agent below it. */
	readonly count: number;
	/** How many of them a person is needed for. */
	readonly needsPerson: number;
	/** How many of them are working, a person needed for none of those. */
	readonly working: number;
}

export interface AgentRelationSummaryFacts {
	/** The needs-person authority's map (needsPerson.ts). */
	readonly needsPerson: NeedsPersonMap;
	readonly displayStates: Readonly<
		Record<string, AgentDisplayState | undefined>
	>;
}

const NONE: readonly never[] = [];

const PRIORITY: ReadonlyMap<AgentRelationSource, number> = new Map(
	AGENT_RELATION_SOURCES.map((source, rank) => [source, rank]),
);

function rank(edge: AgentRelationEdge): number {
	return PRIORITY.get(edge.source) ?? AGENT_RELATION_SOURCES.length;
}

/** The forest over `nodes`, given in start order. A fact naming the agent
 * itself or an agent outside `nodes` is unusable and ignored; repeated nodes
 * count once. Builds in O(n + edges), with no recursion, so depth is
 * unbounded. */
export function buildAgentRelations(
	nodes: readonly string[],
	edges: readonly AgentRelationEdge[],
): AgentRelations {
	const order = new Map<string, number>();
	for (const id of nodes) if (!order.has(id)) order.set(id, order.size);

	const facts = new Map<string, AgentRelationEdge[]>();
	for (const edge of edges) {
		if (
			edge.child === edge.manager ||
			!order.has(edge.child) ||
			!order.has(edge.manager)
		) {
			continue;
		}
		const known = facts.get(edge.child);
		if (!known) {
			facts.set(edge.child, [edge]);
			continue;
		}
		const same = known.findIndex((fact) => fact.manager === edge.manager);
		if (same === -1) known.push(edge);
		else if (rank(edge) < rank(known[same])) known[same] = edge;
	}
	const manager = new Map<string, string>();
	for (const [child, known] of facts) {
		known.sort((left, right) => rank(left) - rank(right));
		manager.set(child, known[0].manager);
	}
	breakCycles(order, manager);

	const managed = new Map<string, string[]>();
	const roots: string[] = [];
	for (const id of order.keys()) {
		const above = manager.get(id);
		if (above === undefined) {
			roots.push(id);
			continue;
		}
		const siblings = managed.get(above);
		if (siblings) siblings.push(id);
		else managed.set(above, [id]);
	}

	return {
		managerOf: (agentId) => manager.get(agentId),
		managersOf: (agentId) => facts.get(agentId) ?? NONE,
		managedBy: (agentId) => managed.get(agentId) ?? NONE,
		roots,
		chain(agentId, below) {
			const chain: string[] = [];
			for (
				let above = manager.get(agentId);
				above !== undefined;
				above = manager.get(above)
			) {
				if (above === below) return chain.reverse();
				chain.push(above);
			}
			return chain.reverse();
		},
	};
}

/** Each walk climbs from one agent until it reaches a root or an agent an
 * earlier walk settled. Reaching an agent already on its own path is a
 * cycle: the member that started first loses its display manager and
 * becomes a root, whichever member the walk began at. Every agent is climbed
 * once, so a cycle is found, broken and counted once. */
function breakCycles(
	order: ReadonlyMap<string, number>,
	manager: Map<string, string>,
): void {
	const settled = new Set<string>();
	const onPath = new Map<string, number>();
	for (const start of order.keys()) {
		const path: string[] = [];
		onPath.clear();
		let at: string | undefined = start;
		while (at !== undefined && !settled.has(at) && !onPath.has(at)) {
			onPath.set(at, path.length);
			path.push(at);
			at = manager.get(at);
		}
		const cycleStart = at === undefined ? undefined : onPath.get(at);
		if (cycleStart !== undefined) {
			let earliest = path[cycleStart];
			for (const member of path.slice(cycleStart + 1)) {
				if ((order.get(member) ?? 0) < (order.get(earliest) ?? 0)) {
					earliest = member;
				}
			}
			manager.delete(earliest);
		}
		for (const id of path) settled.add(id);
	}
}

/** One post-order pass over the forest: each manager's subtree totals.
 * Agents that manage none are absent. */
export function summarizeAgentRelations(
	relations: AgentRelations,
	facts: AgentRelationSummaryFacts,
): ReadonlyMap<string, AgentRelationSummary> {
	// Breadth-first from the roots, so every agent comes after its manager;
	// walking it backwards visits each subtree before the agent above it.
	const visit = [...relations.roots];
	for (let index = 0; index < visit.length; index += 1) {
		for (const child of relations.managedBy(visit[index])) visit.push(child);
	}
	const totals = new Map<string, AgentRelationSummary>();
	for (let index = visit.length - 1; index >= 0; index -= 1) {
		const id = visit[index];
		const managed = relations.managedBy(id);
		if (managed.length === 0) continue;
		let count = 0;
		let needsPerson = 0;
		let working = 0;
		for (const child of managed) {
			const below = totals.get(child);
			const needed = facts.needsPerson.has(child);
			count += 1 + (below?.count ?? 0);
			needsPerson += (needed ? 1 : 0) + (below?.needsPerson ?? 0);
			working +=
				(!needed && facts.displayStates[child] === "working" ? 1 : 0) +
				(below?.working ?? 0);
		}
		totals.set(id, { count, needsPerson, working });
	}
	return totals;
}
