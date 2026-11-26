import { describe, expect, it } from "vitest";
import {
	agentRelationEdges,
	agentRelationsOf,
} from "@/lib/agents/relations/agentRelationFacts";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function agent(
	id: string,
	sessionId: string | undefined,
	runParent?: Agent["runParent"],
): Agent {
	return agentFixture({
		id,
		name: id,
		...(sessionId
			? {
					runtimeBinding: managedBindingFixture({
						sessionId,
						workspaceId: "ws",
					}),
				}
			: {}),
		...(runParent ? { runParent } : {}),
	});
}

const parent = { sessionId: "s-lead", workspaceId: "ws", leadAgentId: "lead" };

describe("agentRelationEdges", () => {
	it("names the Agent bound to the parent Session, then the recorded lead", () => {
		const lead = agent("lead", "s-lead");
		const worker = agent("worker", "s-worker", parent);
		expect(agentRelationEdges([lead, worker])).toEqual([
			{ child: "worker", manager: "lead", source: "run_parent_session" },
		]);
		const successor = agent("successor", "s-lead");
		expect(agentRelationEdges([lead, successor, worker].slice(1))).toEqual([
			{ child: "worker", manager: "successor", source: "run_parent_session" },
		]);
		const rehosted = agent("lead", "s-lead-2");
		expect(agentRelationEdges([rehosted, successor, worker])).toEqual([
			{ child: "worker", manager: "successor", source: "run_parent_session" },
			{ child: "worker", manager: "lead", source: "run_parent_recorded" },
		]);
	});

	it("keeps the recorded lead after a rehost", () => {
		const rehosted = agent("lead", "s-lead-2");
		const worker = agent("worker", "s-worker", parent);
		expect(agentRelationEdges([rehosted, worker])).toEqual([
			{ child: "worker", manager: "lead", source: "run_parent_recorded" },
		]);
		expect(agentRelationsOf([rehosted, worker]).managerOf("worker")).toBe(
			"lead",
		);
	});

	it("gives no edge for a Session several Agents claim, the worker itself, or no parent", () => {
		const worker = agent("worker", "s-worker", parent);
		const twins = [agent("lead", "s-lead"), agent("twin", "s-lead"), worker];
		expect(agentRelationEdges(twins)).toEqual([]);
		const self = agent("worker", "s-lead", {
			...parent,
			leadAgentId: "worker",
		});
		expect(agentRelationEdges([self])).toEqual([]);
		expect(agentRelationEdges([agent("plain", "s-plain")])).toEqual([]);
	});
});

describe("a Chat agent's Runs", () => {
	it("records the parent Agent itself, above any Session fact", () => {
		const coordinator = agent("coordinator", undefined);
		const worker = agent("worker", "s-worker", { agentId: "coordinator" });
		expect(agentRelationEdges([coordinator, worker])).toEqual([
			{ child: "worker", manager: "coordinator", source: "run_parent_agent" },
		]);
		const relations = agentRelationsOf([coordinator, worker]);
		expect(relations.managerOf("worker")).toBe("coordinator");
		expect(relations.managedBy("coordinator")).toEqual(["worker"]);
	});

	it("nests a Chat coordinator's terminal lead's workers below it", () => {
		const agents = [
			agent("coordinator", undefined),
			agent("lead", "s-lead", { agentId: "coordinator" }),
			agent("worker", "s-worker", { sessionId: "s-lead", workspaceId: "ws" }),
		];
		expect(agentRelationsOf(agents).chain("worker")).toEqual([
			"coordinator",
			"lead",
		]);
	});

	it("leaves the worker a root when its parent Agent is unknown or itself", () => {
		const orphan = agent("worker", "s-worker", { agentId: "gone" });
		expect(agentRelationsOf([orphan]).managerOf("worker")).toBeUndefined();
		const self = agent("worker", "s-worker", { agentId: "worker" });
		expect(agentRelationsOf([self]).roots).toEqual(["worker"]);
	});
});

describe("agentRelationsOf", () => {
	it("nests Runs started from Runs to any depth", () => {
		const agents = [
			agent("coordinator", "s-0"),
			agent("lead", "s-1", { sessionId: "s-0", workspaceId: "ws" }),
			agent("worker", "s-2", { sessionId: "s-1", workspaceId: "ws" }),
		];
		const relations = agentRelationsOf(agents);
		expect(relations.chain("worker")).toEqual(["coordinator", "lead"]);
		expect(relations.roots).toEqual(["coordinator"]);
	});

	it("keeps the forest while the Agents' relation facts stay the same", () => {
		const agents = [
			agent("lead", "s-lead"),
			agent("worker", "s-worker", parent),
		];
		const relations = agentRelationsOf(agents);
		expect(agentRelationsOf(agents)).toBe(relations);
		const renamed = agents.map((entry) => ({
			...entry,
			displayName: `${entry.id} renamed`,
			conversationId: "conversation",
		}));
		expect(agentRelationsOf(renamed)).toBe(relations);

		const reparented = [agents[0], { ...agents[1], runParent: undefined }];
		const next = agentRelationsOf(reparented);
		expect(next).not.toBe(relations);
		expect(next.managerOf("worker")).toBeUndefined();

		const rebound = [
			{
				...agents[0],
				runtimeBinding: managedBindingFixture({ sessionId: "s-new" }),
			},
			agents[1],
		];
		expect(agentRelationsOf(rebound).managerOf("worker")).toBe("lead");
		expect(agentRelationsOf([...agents].reverse()).roots).toEqual(["lead"]);
	});
});
