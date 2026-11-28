import { describe, expect, it } from "vitest";
import {
	type AgentRelationEdge,
	buildAgentRelations,
} from "@/lib/agents/relations/agentRelations";
import {
	type WorkViewListFacts,
	workListOrder,
	workViewList,
} from "@/lib/work/workViewList";

const projects = [
	{ id: "p-app", name: "app" },
	{ id: "p-api", name: "api" },
];

function edge(child: string, manager: string): AgentRelationEdge {
	return { child, manager, source: "run_parent_session" };
}

function facts(
	agents: readonly { key: string; projectId?: string }[],
	edges: readonly AgentRelationEdge[] = [],
	overrides: Partial<WorkViewListFacts> = {},
): WorkViewListFacts {
	return {
		agents,
		shells: [],
		relations: buildAgentRelations(
			agents.map((agent) => agent.key),
			edges,
		),
		needsYou: [],
		resultsToday: [],
		projects,
		depth: "top",
		grouping: "project",
		...overrides,
	};
}

const keys = (rows: readonly { key: string }[]) => rows.map((row) => row.key);

describe("workViewList", () => {
	it("lists every agent, whatever its backend, pane or project, in project groups", () => {
		const list = workViewList(
			facts([
				{ key: "local", projectId: "p-app" },
				{ key: "ssh", projectId: "p-api" },
				{ key: "paneless", projectId: "p-app" },
				{ key: "unregistered-project", projectId: "p-gone" },
				{ key: "no-project" },
			]),
		);
		expect(
			list.groups.map((group) => [group.projectName, keys(group.rows)]),
		).toEqual([
			["app", ["local", "paneless"]],
			["api", ["ssh"]],
			[undefined, ["unregistered-project", "no-project"]],
		]);
	});

	it("puts each project's top-level agents first, their subtrees summed up on their own rows", () => {
		const list = workViewList(
			facts(
				[
					{ key: "lead", projectId: "p-app" },
					{ key: "worker", projectId: "p-app" },
					// A worker elsewhere still sits under its manager.
					{ key: "api-worker", projectId: "p-api" },
				],
				[edge("worker", "lead"), edge("api-worker", "lead")],
			),
		);
		expect(list.groups).toEqual([
			{ projectId: "p-app", projectName: "app", rows: [{ key: "lead", level: 0 }] },
		]);
	});

	it("expands every subtree depth first, in start order", () => {
		const list = workViewList(
			facts(
				[
					{ key: "a", projectId: "p-app" },
					{ key: "b", projectId: "p-app" },
					{ key: "c", projectId: "p-app" },
					{ key: "d", projectId: "p-app" },
					{ key: "e", projectId: "p-app" },
				],
				[edge("b", "a"), edge("c", "b"), edge("d", "a"), edge("e", "c")],
				{ depth: "all" },
			),
		);
		expect(list.groups[0].rows).toEqual([
			{ key: "a", level: 0 },
			{ key: "b", under: "a", level: 1 },
			{ key: "c", under: "b", level: 2 },
			{ key: "e", under: "c", level: 3 },
			{ key: "d", under: "a", level: 1 },
		]);
	});

	it("is one list without grouping", () => {
		const list = workViewList(
			facts(
				[
					{ key: "a", projectId: "p-api" },
					{ key: "b", projectId: "p-app" },
					{ key: "c" },
				],
				[],
				{ grouping: "none" },
			),
		);
		expect(list.groups).toEqual([
			{
				rows: [
					{ key: "a", level: 0 },
					{ key: "b", level: 0 },
					{ key: "c", level: 0 },
				],
			},
		]);
	});

	it("lists what needs a person at any depth in the needs-you order, a paneless chat grandchild included", () => {
		// The chat grandchild is flagged by its backend's runtime tier through
		// the needs-person map; the list only follows the order it is given.
		const list = workViewList(
			facts(
				[
					{ key: "coordinator", projectId: "p-app" },
					{ key: "worker", projectId: "p-app" },
					{ key: "chat-grandchild", projectId: "p-app" },
				],
				[edge("worker", "coordinator"), edge("chat-grandchild", "worker")],
				{ needsYou: ["chat-grandchild", "gone"] },
			),
		);
		expect(list.needsYou).toEqual([{ key: "chat-grandchild", level: 0 }]);
		// The folded top level still holds it, under its root.
		expect(keys(list.groups[0].rows)).toEqual(["coordinator"]);
	});

	it("folds today's results apart from what needs a person", () => {
		const list = workViewList(
			facts(
				[
					{ key: "a", projectId: "p-app" },
					{ key: "b", projectId: "p-app" },
				],
				[],
				{ needsYou: ["a"], resultsToday: ["a", "b"] },
			),
		);
		expect(keys(list.resultsToday)).toEqual(["b"]);
		expect(workListOrder(list, false)).toEqual(["a", "b"]);
		expect(workListOrder(list, true)).toEqual(["a", "b"]);
	});

	it("lists a cycle once", () => {
		const list = workViewList(
			facts(
				[
					{ key: "x", projectId: "p-app" },
					{ key: "y", projectId: "p-app" },
					{ key: "z", projectId: "p-app" },
				],
				[edge("x", "z"), edge("y", "x"), edge("z", "y")],
				{ depth: "all" },
			),
		);
		expect(keys(list.groups.flatMap((group) => group.rows)).sort()).toEqual([
			"x",
			"y",
			"z",
		]);
	});

	it("lists providers found in plain shell panes as top-level rows in their project", () => {
		const list = workViewList(
			facts([{ key: "agent", projectId: "p-app" }], [], {
				shells: [
					{ key: "pane:space-1:shell", projectId: "p-app" },
					{ key: "pane:space-2:shell" },
				],
			}),
		);
		expect(
			list.groups.map((group) => [group.projectId, keys(group.rows)]),
		).toEqual([
			["p-app", ["agent", "pane:space-1:shell"]],
			[undefined, ["pane:space-2:shell"]],
		]);
	});

	it("lists the agents started from a plain shell under its row", () => {
		const shell = { key: "pane:space-1:shell", projectId: "p-app" };
		const agents = [
			{ key: "lead", projectId: "p-app" },
			{ key: "worker", projectId: "p-api" },
		];
		const relations = buildAgentRelations(
			[...agents.map((agent) => agent.key), shell.key],
			[edge("lead", shell.key), edge("worker", "lead")],
		);
		const top = workViewList(facts(agents, [], { shells: [shell], relations }));
		expect(top.groups.map((group) => [group.projectId, keys(group.rows)])).toEqual([
			["p-app", [shell.key]],
		]);
		const all = workViewList(
			facts(agents, [], { shells: [shell], relations, depth: "all" }),
		);
		expect(all.groups[0].rows).toEqual([
			{ key: shell.key, level: 0 },
			{ key: "lead", under: shell.key, level: 1 },
			{ key: "worker", under: "lead", level: 2 },
		]);
	});

	it("lists an agent at the top level when this list does not show its manager", () => {
		const relations = buildAgentRelations(
			["worker", "pane:space-1:closed"],
			[edge("worker", "pane:space-1:closed")],
		);
		const list = workViewList(
			facts([{ key: "worker", projectId: "p-app" }], [], { relations }),
		);
		expect(list.groups.map((group) => keys(group.rows))).toEqual([["worker"]]);
	});
});
