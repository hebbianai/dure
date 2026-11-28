import { describe, expect, it } from "vitest";
import {
	type AgentRelationEdge,
	buildAgentRelations,
} from "@/lib/agents/relations/agentRelations";
import {
	endedFoldKey,
	RESULTS_TODAY_FOLD_KEY,
	type WorkViewListFacts,
	workGroupKey,
	workListFoldKeys,
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
		ended: [],
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
			{
				key: "project:p-app",
				projectId: "p-app",
				projectName: "app",
				rows: [{ key: "lead", level: 0 }],
				ended: { key: "ended:project:p-app", rows: [] },
			},
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
				key: "all",
				rows: [
					{ key: "a", level: 0 },
					{ key: "b", level: 0 },
					{ key: "c", level: 0 },
				],
				ended: { key: "ended:all", rows: [] },
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
		expect(list.resultsToday.key).toBe(RESULTS_TODAY_FOLD_KEY);
		expect(keys(list.resultsToday.rows)).toEqual(["b"]);
		expect(workListOrder(list, [])).toEqual(["a", "b"]);
		expect(workListOrder(list, [RESULTS_TODAY_FOLD_KEY])).toEqual(["a", "b"]);
	});

	it("folds each group's ended trees at its bottom, and keeps the rest open", () => {
		const list = workViewList(
			facts(
				[
					{ key: "live", projectId: "p-app" },
					{ key: "done", projectId: "p-app" },
					{ key: "unknown", projectId: "p-app" },
					{ key: "api-done", projectId: "p-api" },
					{ key: "loose-done" },
				],
				[],
				{ ended: ["done", "api-done", "loose-done"] },
			),
		);
		expect(
			list.groups.map((group) => [
				group.ended.key,
				keys(group.rows),
				keys(group.ended.rows),
			]),
		).toEqual([
			// An entry whose state is unknown is not ended: it stays open.
			["ended:project:p-app", ["live", "unknown"], ["done"]],
			// A group of ended agents alone still shows, its rows folded.
			["ended:project:p-api", [], ["api-done"]],
			["ended:no-project", [], ["loose-done"]],
		]);
	});

	it("keeps an ended root open while anything it manages is live, needs a person or has a result today", () => {
		const tree = (overrides: Partial<WorkViewListFacts>) =>
			workViewList(
				facts(
					[
						{ key: "lead", projectId: "p-app" },
						{ key: "worker", projectId: "p-app" },
						{ key: "helper", projectId: "p-app" },
					],
					[edge("worker", "lead"), edge("helper", "worker")],
					overrides,
				),
			).groups[0];
		// The grandchild is still working.
		expect(keys(tree({ ended: ["lead", "worker"] }).ended.rows)).toEqual([]);
		// The grandchild ended too: the whole tree folds, its subtree with it.
		expect(
			tree({ ended: ["lead", "worker", "helper"], depth: "all" }).ended.rows,
		).toEqual([
			{ key: "lead", level: 0 },
			{ key: "worker", under: "lead", level: 1 },
			{ key: "helper", under: "worker", level: 2 },
		]);
		const allEnded = { ended: ["lead", "worker", "helper"] };
		expect(keys(tree({ ...allEnded, needsYou: ["helper"] }).rows)).toEqual([
			"lead",
		]);
		expect(keys(tree({ ...allEnded, resultsToday: ["lead"] }).rows)).toEqual([
			"lead",
		]);
	});

	it("moves through an ended fold only while it is open", () => {
		const list = workViewList(
			facts(
				[
					{ key: "app-live", projectId: "p-app" },
					{ key: "app-done", projectId: "p-app" },
					{ key: "api-live", projectId: "p-api" },
					{ key: "api-done", projectId: "p-api" },
				],
				[],
				{ ended: ["app-done", "api-done"] },
			),
		);
		const appFold = endedFoldKey(workGroupKey("project", "p-app"));
		expect(workListFoldKeys(list)).toEqual([
			appFold,
			endedFoldKey(workGroupKey("project", "p-api")),
			RESULTS_TODAY_FOLD_KEY,
		]);
		expect(workListOrder(list, [])).toEqual(["app-live", "api-live"]);
		expect(workListOrder(list, [appFold])).toEqual([
			"app-live",
			"app-done",
			"api-live",
		]);
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
});
