import { describe, expect, it } from "vitest";
import type { NeedsPerson } from "@/lib/agents/needsPerson";
import {
	type AgentRelationEdge,
	type AgentRelationSource,
	buildAgentRelations,
	summarizeAgentRelations,
} from "@/lib/agents/relations/agentRelations";

function edge(
	child: string,
	manager: string,
	source: AgentRelationSource = "run_parent_session",
): AgentRelationEdge {
	return { child, manager, source };
}

/** Every node, listed by walking the forest from its roots. */
function walk(relations: ReturnType<typeof buildAgentRelations>): string[] {
	const seen = [...relations.roots];
	for (let index = 0; index < seen.length; index += 1) {
		seen.push(...relations.managedBy(seen[index]));
	}
	return seen;
}

describe("buildAgentRelations", () => {
	it("resolves a chain of any depth, outermost manager first", () => {
		const nodes = ["a", "b", "c", "d", "e", "f"];
		const relations = buildAgentRelations(nodes, [
			edge("f", "e"),
			edge("b", "a"),
			edge("d", "c"),
			edge("c", "b"),
			edge("e", "d"),
		]);
		expect(relations.roots).toEqual(["a"]);
		expect(relations.chain("f")).toEqual(["a", "b", "c", "d", "e"]);
		expect(relations.chain("a")).toEqual([]);
		expect(relations.managerOf("f")).toBe("e");
		expect(relations.managerOf("a")).toBeUndefined();
		expect(relations.managedBy("c")).toEqual(["d"]);
		expect(relations.managedBy("f")).toEqual([]);
	});

	it("lists a wide fan-out in start order whatever order the facts came in", () => {
		const workers = Array.from({ length: 50 }, (_, index) => `w${index}`);
		const relations = buildAgentRelations(
			["lead", ...workers],
			[...workers].reverse().map((worker) => edge(worker, "lead")),
		);
		expect(relations.roots).toEqual(["lead"]);
		expect(relations.managedBy("lead")).toEqual(workers);
	});

	it("breaks a 2-cycle at the member that started first and keeps the dropped fact", () => {
		const relations = buildAgentRelations(
			["a", "b"],
			[edge("b", "a"), edge("a", "b")],
		);
		expect(relations.roots).toEqual(["a"]);
		expect(relations.managerOf("a")).toBeUndefined();
		expect(relations.managerOf("b")).toBe("a");
		expect(relations.managersOf("a")).toEqual([edge("a", "b")]);
		expect(walk(relations)).toEqual(["a", "b"]);
	});

	it("breaks a 3-cycle the same way whichever member a walk starts from", () => {
		const facts = [edge("x", "z"), edge("y", "x"), edge("z", "y")];
		for (const nodes of [
			["y", "x", "z"],
			["y", "z", "x"],
		]) {
			const relations = buildAgentRelations(nodes, facts);
			// y started first, so y loses its display manager.
			expect(relations.roots).toEqual(["y"]);
			expect(relations.chain("x")).toEqual(["y", "z"]);
			expect(walk(relations).sort()).toEqual(["x", "y", "z"]);
			expect(relations.managersOf("y")).toEqual([edge("y", "x")]);
		}
	});

	it("leaves an agent whose only fact is unusable at the top level", () => {
		const relations = buildAgentRelations(
			["self", "orphan", "plain", "plain"],
			[edge("self", "self"), edge("orphan", "gone"), edge("gone", "plain")],
		);
		expect(relations.roots).toEqual(["self", "orphan", "plain"]);
		expect(relations.managersOf("self")).toEqual([]);
		expect(relations.managersOf("orphan")).toEqual([]);
		expect(relations.managedBy("plain")).toEqual([]);
	});

	it("shows the highest-priority fact and keeps every other manager", () => {
		const relations = buildAgentRelations(
			["old-lead", "lead", "worker"],
			[
				edge("worker", "old-lead", "run_parent_recorded"),
				edge("worker", "lead", "run_parent_recorded"),
				edge("worker", "lead", "run_parent_session"),
			],
		);
		expect(relations.managerOf("worker")).toBe("lead");
		expect(relations.managersOf("worker")).toEqual([
			edge("worker", "lead", "run_parent_session"),
			edge("worker", "old-lead", "run_parent_recorded"),
		]);
		expect(relations.managedBy("old-lead")).toEqual([]);
	});

	it("builds a very deep chain without recursion", () => {
		const nodes = Array.from({ length: 20_000 }, (_, index) => `n${index}`);
		const relations = buildAgentRelations(
			nodes,
			nodes.slice(1).map((node, index) => edge(node, nodes[index])),
		);
		expect(relations.roots).toEqual(["n0"]);
		expect(relations.chain("n19999")).toHaveLength(19_999);
		const summary = summarizeAgentRelations(relations, {
			needsPerson: new Map(),
			displayStates: { n19999: "working" },
		});
		expect(summary.get("n0")).toEqual({
			count: 19_999,
			needsPerson: 0,
			working: 1,
		});
		expect(summary.get("n19998")).toEqual({
			count: 1,
			needsPerson: 0,
			working: 1,
		});
	});
});

describe("summarizeAgentRelations", () => {
	const relations = buildAgentRelations(
		["coordinator", "lead", "w1", "w2", "w3", "solo"],
		[
			edge("lead", "coordinator"),
			edge("w1", "lead"),
			edge("w2", "lead"),
			edge("w3", "coordinator"),
		],
	);
	const approval: NeedsPerson = { reason: "approval" };

	it("sums each subtree, a person needed for nobody counted as working too", () => {
		const summary = summarizeAgentRelations(relations, {
			needsPerson: new Map([
				["w1", approval],
				["w2", { reason: "unexpected_exit" }],
			]),
			displayStates: { w1: "working", w3: "working", lead: "working" },
		});
		expect(summary.get("coordinator")).toEqual({
			count: 4,
			needsPerson: 2,
			working: 2,
		});
		expect(summary.get("lead")).toEqual({
			count: 2,
			needsPerson: 2,
			working: 0,
		});
		expect(summary.has("w1")).toBe(false);
		expect(summary.has("solo")).toBe(false);
	});

	it("counts a cycle's members once", () => {
		const cycle = buildAgentRelations(
			["a", "b", "c"],
			[edge("b", "a"), edge("c", "b"), edge("a", "c")],
		);
		const summary = summarizeAgentRelations(cycle, {
			needsPerson: new Map([["c", approval]]),
			displayStates: {},
		});
		expect(summary.get("a")).toEqual({ count: 2, needsPerson: 1, working: 0 });
	});
});
