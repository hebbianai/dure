import { describe, expect, it } from "vitest";
import {
	type AgentRelationFacts,
	agentRelationEdges,
	agentRelationsOf,
	agentRelationsOfState,
} from "@/lib/agents/relations/agentRelationFacts";
import {
	type ShellRelationNode,
	shellRowKey,
} from "@/lib/agents/relations/shellRelationNodes";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function facts(
	agents: readonly Agent[],
	shells: readonly ShellRelationNode[] = [],
): AgentRelationFacts {
	return { agents, shells };
}

/** A plain shell pane in Space `d1` holding Hmux Session `sessionId`. */
function shell(panelId: string, sessionId: string): ShellRelationNode {
	return {
		key: shellRowKey("d1", panelId),
		desktopId: "d1",
		panelId,
		terminalSessionId: `term-${panelId}`,
		session: { sessionId, workspaceId: "ws" },
	};
}

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
		expect(agentRelationEdges(facts([lead, worker]))).toEqual([
			{ child: "worker", manager: "lead", source: "run_parent_session" },
		]);
		const successor = agent("successor", "s-lead");
		expect(agentRelationEdges(facts([lead, successor, worker].slice(1)))).toEqual([
			{ child: "worker", manager: "successor", source: "run_parent_session" },
		]);
		const rehosted = agent("lead", "s-lead-2");
		expect(agentRelationEdges(facts([rehosted, successor, worker]))).toEqual([
			{ child: "worker", manager: "successor", source: "run_parent_session" },
			{ child: "worker", manager: "lead", source: "run_parent_recorded" },
		]);
	});

	it("keeps the recorded lead after a rehost", () => {
		const rehosted = agent("lead", "s-lead-2");
		const worker = agent("worker", "s-worker", parent);
		expect(agentRelationEdges(facts([rehosted, worker]))).toEqual([
			{ child: "worker", manager: "lead", source: "run_parent_recorded" },
		]);
		expect(agentRelationsOf(facts([rehosted, worker])).managerOf("worker")).toBe(
			"lead",
		);
	});

	it("gives no edge for a Session several Agents claim, the worker itself, or no parent", () => {
		const worker = agent("worker", "s-worker", parent);
		const twins = [agent("lead", "s-lead"), agent("twin", "s-lead"), worker];
		expect(agentRelationEdges(facts(twins))).toEqual([]);
		const self = agent("worker", "s-lead", {
			...parent,
			leadAgentId: "worker",
		});
		expect(agentRelationEdges(facts([self]))).toEqual([]);
		expect(agentRelationEdges(facts([agent("plain", "s-plain")]))).toEqual([]);
	});
});

describe("a Chat agent's Runs", () => {
	it("records the parent Agent itself, above any Session fact", () => {
		const coordinator = agent("coordinator", undefined);
		const worker = agent("worker", "s-worker", { agentId: "coordinator" });
		expect(agentRelationEdges(facts([coordinator, worker]))).toEqual([
			{ child: "worker", manager: "coordinator", source: "run_parent_agent" },
		]);
		const relations = agentRelationsOf(facts([coordinator, worker]));
		expect(relations.managerOf("worker")).toBe("coordinator");
		expect(relations.managedBy("coordinator")).toEqual(["worker"]);
	});

	it("nests a Chat coordinator's terminal lead's workers below it", () => {
		const agents = [
			agent("coordinator", undefined),
			agent("lead", "s-lead", { agentId: "coordinator" }),
			agent("worker", "s-worker", { sessionId: "s-lead", workspaceId: "ws" }),
		];
		expect(agentRelationsOf(facts(agents)).chain("worker")).toEqual([
			"coordinator",
			"lead",
		]);
	});

	it("leaves the worker a root when its parent Agent is unknown or itself", () => {
		const orphan = agent("worker", "s-worker", { agentId: "gone" });
		expect(agentRelationsOf(facts([orphan])).managerOf("worker")).toBeUndefined();
		const self = agent("worker", "s-worker", { agentId: "worker" });
		expect(agentRelationsOf(facts([self])).roots).toEqual(["worker"]);
	});
});

describe("agentRelationsOf", () => {
	it("nests Runs started from Runs to any depth", () => {
		const agents = [
			agent("coordinator", "s-0"),
			agent("lead", "s-1", { sessionId: "s-0", workspaceId: "ws" }),
			agent("worker", "s-2", { sessionId: "s-1", workspaceId: "ws" }),
		];
		const relations = agentRelationsOf(facts(agents));
		expect(relations.chain("worker")).toEqual(["coordinator", "lead"]);
		expect(relations.roots).toEqual(["coordinator"]);
	});

	it("keeps the forest while the Agents' relation facts stay the same", () => {
		const agents = [
			agent("lead", "s-lead"),
			agent("worker", "s-worker", parent),
		];
		const relations = agentRelationsOf(facts(agents));
		expect(agentRelationsOf(facts(agents))).toBe(relations);
		const renamed = agents.map((entry) => ({
			...entry,
			displayName: `${entry.id} renamed`,
			conversationId: "conversation",
		}));
		expect(agentRelationsOf(facts(renamed))).toBe(relations);

		const reparented = [agents[0], { ...agents[1], runParent: undefined }];
		const next = agentRelationsOf(facts(reparented));
		expect(next).not.toBe(relations);
		expect(next.managerOf("worker")).toBeUndefined();

		const rebound = [
			{
				...agents[0],
				runtimeBinding: managedBindingFixture({ sessionId: "s-new" }),
			},
			agents[1],
		];
		expect(agentRelationsOf(facts(rebound)).managerOf("worker")).toBe("lead");
		expect(agentRelationsOf(facts([...agents].reverse())).roots).toEqual(["lead"]);
	});
});

describe("a lead in a plain shell pane", () => {
	// `dure run` in a shell records the shell's own Hmux Session.
	const fromShell = { sessionId: "s-shell", workspaceId: "ws" };

	it("nests the Run under the one shell row holding its parent Session", () => {
		const worker = agent("worker", "s-worker", fromShell);
		const lead = shell("p-shell", "s-shell");
		expect(agentRelationEdges(facts([worker], [lead]))).toEqual([
			{ child: "worker", manager: lead.key, source: "run_parent_shell" },
		]);
		const relations = agentRelationsOf(facts([worker], [lead]));
		expect(relations.managerOf("worker")).toBe(lead.key);
		expect(relations.managedBy(lead.key)).toEqual(["worker"]);
		expect(relations.roots).toEqual([lead.key]);
	});

	it("names no shell when none or several hold the Session", () => {
		const worker = agent("worker", "s-worker", fromShell);
		expect(agentRelationEdges(facts([worker], [shell("p-other", "s-other")]))).toEqual([]);
		const twins = [shell("p-a", "s-shell"), shell("p-b", "s-shell")];
		expect(agentRelationEdges(facts([worker], twins))).toEqual([]);
		expect(agentRelationsOf(facts([worker], twins)).roots).toEqual([
			"worker",
			...twins.map((twin) => twin.key),
		]);
	});

	it("leaves the Session to an Agent bound to it, and a recorded lead outranks the shell", () => {
		const worker = agent("worker", "s-worker", fromShell);
		const terminal = shell("p-shell", "s-shell");
		expect(
			agentRelationEdges(facts([agent("lead", "s-shell"), worker], [terminal])),
		).toEqual([
			{ child: "worker", manager: "lead", source: "run_parent_session" },
		]);
		const recorded = agent("worker", "s-worker", {
			...fromShell,
			leadAgentId: "lead",
		});
		const relations = agentRelationsOf(
			facts([agent("lead", "s-lead-2"), recorded], [terminal]),
		);
		expect(relations.managerOf("worker")).toBe("lead");
		expect(relations.managersOf("worker").map((edge) => edge.source)).toEqual([
			"run_parent_recorded",
			"run_parent_shell",
		]);
	});

	it("nests a shell lead's worker's own workers below it", () => {
		const relations = agentRelationsOf(
			facts(
				[
					agent("lead", "s-lead", fromShell),
					agent("worker", "s-worker", { sessionId: "s-lead", workspaceId: "ws" }),
				],
				[shell("p-shell", "s-shell")],
			),
		);
		expect(relations.chain("worker")).toEqual([
			shellRowKey("d1", "p-shell"),
			"lead",
		]);
	});

	it("keeps the forest while the shells' Sessions stay the same", () => {
		const agents = [agent("worker", "s-worker", fromShell)];
		const relations = agentRelationsOf(facts(agents, [shell("p-shell", "s-shell")]));
		const moved = { ...shell("p-shell", "s-shell"), cwd: "/elsewhere" };
		expect(agentRelationsOf(facts(agents, [moved]))).toBe(relations);
		const closed = agentRelationsOf(facts(agents));
		expect(closed).not.toBe(relations);
		expect(closed.managerOf("worker")).toBeUndefined();
	});

	it("reads the shells from every Space's saved layout", () => {
		const layout = {
			grid: {
				root: {
					type: "branch",
					data: [{ type: "leaf", data: { views: ["p-shell"], id: "g" } }],
				},
			},
			panels: {
				"p-shell": {
					id: "p-shell",
					contentComponent: "terminal",
					params: {
						sessionId: "term-1",
						binding: {
							runtime: "hmux_session_v1",
							sessionId: "s-shell",
							workspaceId: "ws",
						},
					},
				},
			},
		};
		const relations = agentRelationsOfState({
			agents: [agent("worker", "s-worker", fromShell)],
			layouts: { d1: layout },
			spaces: [{ id: "d1", name: "Space" }],
		});
		expect(relations.managerOf("worker")).toBe(shellRowKey("d1", "p-shell"));
	});
});
