// The client's relation facts, read from its Agents, and the forest they
// build. Every edge today is a Run parent the client recorded when it
// presented the Run (agentRunParent.ts) — the parent Agent, or the parent
// Session's lead — so nothing here reads a backend or persists anything. The forest is rebuilt only when what it reads changes —
// Agent ids and order, Run parents and runtime Sessions — so a title,
// attention or output change never rebuilds it.
import {
	type AgentRunLead,
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

const RUN_LEAD_SOURCE: Readonly<
	Record<AgentRunLead<unknown>["by"], AgentRelationSource>
> = {
	session: "run_parent_session",
	recorded: "run_parent_recorded",
};

/** Every relation fact these Agents record, with its source. A Run parent
 * that names an Agent is that fact as it is; an Agent outside this client's
 * list leaves the worker a root (buildAgentRelations). */
export function agentRelationEdges(
	agents: readonly RunParentedAgent[],
): AgentRelationEdge[] {
	const leadsOf = createAgentRunLeadsResolver(agents);
	const edges: AgentRelationEdge[] = [];
	for (const agent of agents) {
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
	}
	return edges;
}

type RelationProjection = readonly (string | undefined)[];

/** What the forest reads of each Agent, in order. */
function relationProjection(
	agents: readonly RunParentedAgent[],
): RelationProjection {
	const projection: (string | undefined)[] = [];
	for (const agent of agents) {
		const binding = agent.runtimeBinding;
		projection.push(
			agent.id,
			agent.runParent === undefined
				? undefined
				: JSON.stringify(agent.runParent),
			binding === undefined
				? undefined
				: `${binding.workspaceId}\u0000${binding.sessionId}`,
		);
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

/** The relations of these Agents, in their order (the store's order is
 * start order). Equal relation facts keep the previous forest, so memos keyed
 * on it survive unrelated Agent edits. The facts are compared on every call,
 * never the array's identity: a caller may hand in an array it grows. */
export function agentRelationsOf(
	agents: readonly RunParentedAgent[],
): AgentRelations {
	const projection = relationProjection(agents);
	if (sameProjection(cache.projection, projection)) return cache.relations;
	const relations = buildAgentRelations(
		agents.map((agent) => agent.id),
		agentRelationEdges(agents),
	);
	cache = { projection, relations };
	return relations;
}
