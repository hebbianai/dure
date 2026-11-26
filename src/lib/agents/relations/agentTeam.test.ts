import { describe, expect, it } from "vitest";
import {
	type AgentRelationEdge,
	buildAgentRelations,
} from "@/lib/agents/relations/agentRelations";
import { agentTeamMembers } from "@/lib/agents/relations/agentTeam";

function edge(child: string, manager: string): AgentRelationEdge {
	return { child, manager, source: "run_parent_session" };
}

// coordinator ─┬─ lead ── worker ── helper
//              └─ reviewer
// other ── stray
const relations = buildAgentRelations(
	["coordinator", "lead", "reviewer", "worker", "helper", "other", "stray"],
	[
		edge("worker", "lead"),
		edge("reviewer", "coordinator"),
		edge("lead", "coordinator"),
		edge("helper", "worker"),
		edge("stray", "other"),
	],
);

describe("agentTeamMembers", () => {
	it("lists the agents it manages directly, in start order", () => {
		expect(agentTeamMembers(relations, "coordinator", [])).toEqual([
			"lead",
			"reviewer",
		]);
	});

	it("adds anyone further down a person is needed for, in the needs-you order", () => {
		expect(
			agentTeamMembers(relations, "coordinator", ["helper", "stray", "worker"]),
		).toEqual(["lead", "reviewer", "helper", "worker"]);
	});

	it("lists a direct agent once, whether or not a person is needed for it", () => {
		expect(agentTeamMembers(relations, "coordinator", ["reviewer"])).toEqual([
			"lead",
			"reviewer",
		]);
	});

	it("lists nothing for an agent that manages none", () => {
		expect(agentTeamMembers(relations, "helper", ["stray"])).toEqual([]);
	});
});
