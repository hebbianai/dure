// The client's relation facts, read from its Agents and its plain shell
// rows, and the forest they build. Every edge today is a Run parent the
// client recorded when it presented the Run (agentRunParent.ts) — the parent
// Agent, the parent Session's lead, or the shell row that holds that Session
// — so nothing here reads a backend or persists anything. The forest is
// rebuilt only when what it reads changes — Agent ids and order, Run parents,
// runtime Sessions and the shells' Sessions — so a title, attention or
// output change never rebuilds it.
import {
	type AgentRunLead,
	type AgentRunParentSessionV1,
	agentRunParentKey,
	createAgentRunLeadsResolver,
	isAgentRunParentAgent,
	type RunParentedAgent,
} from "@/lib/agents/agentRunParent";
import {
	type AgentRelationEdge,
	type AgentRelationSource,
	type AgentRelations,
	buildAgentRelations,
} from "@/lib/agents/relations/agentRelations";
import {
	type ShellRelationNode,
	shellRelationNodesOf,
} from "@/lib/agents/relations/shellRelationNodes";
import type { AppState } from "@/store";

/** What the forest is built from: the Agents in start order, and the plain
 * shell rows that can be a lead. */
export interface AgentRelationFacts {
	readonly agents: readonly RunParentedAgent[];
	readonly shells: readonly ShellRelationNode[];
}

const RUN_LEAD_SOURCE: Readonly<
	Record<AgentRunLead<unknown>["by"], AgentRelationSource>
> = {
	session: "run_parent_session",
	recorded: "run_parent_recorded",
};

/** The shell row a parent Session names: the one shell holding it, when no
 * Agent is bound to it. An Agent bound to the Session is its lead, and a
 * Session several shells hold names none of them. */
function createShellLeadResolver({
	agents,
	shells,
}: AgentRelationFacts): (parent: AgentRunParentSessionV1) => string | undefined {
	const bound = new Set<string>();
	for (const agent of agents) {
		if (agent.runtimeBinding) bound.add(agentRunParentKey(agent.runtimeBinding));
	}
	const holders = new Map<string, string[]>();
	for (const shell of shells) {
		const key = agentRunParentKey(shell.session);
		if (bound.has(key)) continue;
		const rows = holders.get(key);
		if (rows) rows.push(shell.key);
		else holders.set(key, [shell.key]);
	}
	return (parent) => {
		const rows = holders.get(agentRunParentKey(parent));
		return rows?.length === 1 ? rows[0] : undefined;
	};
}

/** Every relation fact these Agents record, with its source. A Run parent
 * that names an Agent is that fact as it is; an Agent outside this client's
 * list leaves the worker a root (buildAgentRelations). */
export function agentRelationEdges(
	facts: AgentRelationFacts,
): AgentRelationEdge[] {
	const leadsOf = createAgentRunLeadsResolver(facts.agents);
	const shellOf = createShellLeadResolver(facts);
	const edges: AgentRelationEdge[] = [];
	for (const agent of facts.agents) {
		const parent = agent.runParent;
		if (parent && isAgentRunParentAgent(parent)) {
			edges.push({
				child: agent.id,
				manager: parent.agentId,
				source: "run_parent_agent",
			});
		}
		for (const { lead, by } of leadsOf(agent)) {
			edges.push({
				child: agent.id,
				manager: lead.id,
				source: RUN_LEAD_SOURCE[by],
			});
		}
		const shell =
			parent && !isAgentRunParentAgent(parent) ? shellOf(parent) : undefined;
		if (shell !== undefined) {
			edges.push({ child: agent.id, manager: shell, source: "run_parent_shell" });
		}
	}
	return edges;
}

type RelationProjection = readonly (string | undefined)[];

/** What the forest reads of each Agent and shell, in order. */
function relationProjection({
	agents,
	shells,
}: AgentRelationFacts): RelationProjection {
	const projection: (string | undefined)[] = [];
	for (const agent of agents) {
		const binding = agent.runtimeBinding;
		projection.push(
			agent.id,
			agent.runParent === undefined
				? undefined
				: JSON.stringify(agent.runParent),
			binding === undefined ? undefined : agentRunParentKey(binding),
		);
	}
	// The count keeps an Agent's facts from ever reading as a shell's. A shell
	// never has a parent, so its key and Session are all it adds.
	projection.push(String(agents.length));
	for (const shell of shells) {
		projection.push(shell.key, agentRunParentKey(shell.session));
	}
	return projection;
}

function sameProjection(
	left: RelationProjection,
	right: RelationProjection,
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

let cache: {
	projection: RelationProjection;
	relations: AgentRelations;
} = { projection: [], relations: buildAgentRelations([], []) };

/** The relations of these Agents and shells, Agents in their order (the
 * store's order is start order), then the shells. Equal relation facts keep
 * the previous forest, so memos keyed on it survive unrelated edits. The
 * facts are compared on every call, never the arrays' identity: a caller may
 * hand in an array it grows. */
export function agentRelationsOf(facts: AgentRelationFacts): AgentRelations {
	const projection = relationProjection(facts);
	if (sameProjection(cache.projection, projection)) return cache.relations;
	const relations = buildAgentRelations(
		[
			...facts.agents.map((agent) => agent.id),
			...facts.shells.map((shell) => shell.key),
		],
		agentRelationEdges(facts),
	);
	cache = { projection, relations };
	return relations;
}

/** The relation facts the store holds now: its Agents, and the shells of
 * every Space's saved layout. */
export function agentRelationFactsOf(
	state: Pick<AppState, "agents" | "layouts" | "spaces">,
): AgentRelationFacts {
	return { agents: state.agents, shells: shellRelationNodesOf(state) };
}

/** The relations the store's facts make now, for code outside React. */
export function agentRelationsOfState(
	state: Pick<AppState, "agents" | "layouts" | "spaces">,
): AgentRelations {
	return agentRelationsOf(agentRelationFactsOf(state));
}
