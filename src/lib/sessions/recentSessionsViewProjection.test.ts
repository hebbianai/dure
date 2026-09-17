import { describe, expect, it } from "vitest";
import {
	foldRecentSessionGroups,
	projectRecentSessionsView,
	recentSessionGroupOpen,
	recentSessionsFoldAvailability,
} from "@/lib/sessions/recentSessionsViewProjection";
import type {
	RecentWorkItem,
	RecentWorkProjection,
} from "@/lib/sessions/recentWork";

function item(
	id: string,
	input: Partial<RecentWorkItem> & Pick<RecentWorkItem, "provider" | "mtime">,
): RecentWorkItem {
	return {
		key: id,
		conversationId: id,
		title: id,
		cwd: `/${id}`,
		workspaceRoot: input.groupIdentity ?? "/repo",
		groupIdentity: input.groupIdentity ?? "repo",
		defaultSelected: true,
		recencyBucket: "recent",
		executionLocation: "local",
		recentTurns: [],
		subagentCount: 0,
		action: { kind: "focus", agentId: input.paneAgentIdCandidate ?? id },
		...input,
	};
}

const alpha = item("Alpha", {
	provider: "claude",
	mtime: 30,
	groupIdentity: "repo-a",
	paneAgentIdCandidate: "agent-alpha",
});
const beta = item("Beta", {
	provider: "codex",
	mtime: 10,
	groupIdentity: "repo-b",
});
const gamma = item("Gamma", {
	provider: "claude",
	mtime: 20,
	groupIdentity: "repo-a",
	paneAgentIdCandidate: "agent-gamma",
});
const projection: RecentWorkProjection = {
	total: 3,
	groups: [
		{ id: "repo-a", name: "Zeta", cwd: "/repo-a", items: [alpha, gamma] },
		{ id: "repo-b", name: "Alpha", cwd: "/repo-b", items: [beta] },
	],
};
const openPaneSessionKeys = new Set([alpha.key]);

describe("projectRecentSessionsView", () => {
	it("filters from exact pane presence before applying the visible limit", () => {
		expect(
			projectRecentSessionsView({
				projection,
				openPaneSessionKeys,
				limit: 1,
				options: {
					groupBy: "none",
					orderBy: "updated",
					paneFilter: "exclude_open",
				},
			}).groups[0]?.items.map((candidate) => candidate.title),
		).toEqual(["Gamma"]);
	});

	it("can show only sessions whose exact Agent pane is present", () => {
		const result = projectRecentSessionsView({
			projection,
			openPaneSessionKeys,
			options: {
				groupBy: "repository",
				orderBy: "updated",
				paneFilter: "open_only",
			},
		});
		expect(result.total).toBe(1);
		expect(result.groups[0]?.items).toEqual([alpha]);
	});

	it("regroups by provider and orders oldest activity first", () => {
		const result = projectRecentSessionsView({
			projection,
			openPaneSessionKeys,
			options: {
				groupBy: "provider",
				orderBy: "oldest",
				paneFilter: "all",
			},
		});
		expect(result.groups.map((group) => group.name)).toEqual([
			"Codex",
			"Claude Code",
		]);
		expect(result.groups[1]?.items.map((candidate) => candidate.title)).toEqual(
			["Gamma", "Alpha"],
		);
	});

	it("orders named repository groups and their rows alphabetically", () => {
		const result = projectRecentSessionsView({
			projection,
			openPaneSessionKeys,
			options: {
				groupBy: "repository",
				orderBy: "name",
				paneFilter: "all",
			},
		});
		expect(result.groups.map((group) => group.name)).toEqual(["Alpha", "Zeta"]);
		expect(result.groups[1]?.items.map((candidate) => candidate.title)).toEqual(
			["Alpha", "Gamma"],
		);
	});
});

describe("recent session group folding", () => {
	const groups = projection.groups;

	it("opens the first group and folds the rest until the reader chooses", () => {
		expect(recentSessionGroupOpen({}, "repo-a", 0)).toBe(true);
		expect(recentSessionGroupOpen({}, "repo-b", 1)).toBe(false);
		expect(recentSessionGroupOpen({ "repo-a": false }, "repo-a", 0)).toBe(false);
		expect(recentSessionGroupOpen({ "repo-b": true }, "repo-b", 1)).toBe(true);
	});

	it("offers only the bulk commands that would change the list", () => {
		expect(recentSessionsFoldAvailability(groups, {}, true)).toEqual({
			canExpandAll: true,
			canCollapseAll: true,
		});
		const collapsed = foldRecentSessionGroups({}, groups, "collapse");
		expect(recentSessionsFoldAvailability(groups, collapsed, true)).toEqual({
			canExpandAll: true,
			canCollapseAll: false,
		});
		const expanded = foldRecentSessionGroups(collapsed, groups, "expand");
		expect(recentSessionsFoldAvailability(groups, expanded, true)).toEqual({
			canExpandAll: false,
			canCollapseAll: true,
		});
	});

	it("stands the bulk commands down while the list cannot fold", () => {
		expect(recentSessionsFoldAvailability(groups, {}, false)).toEqual({
			canExpandAll: false,
			canCollapseAll: false,
		});
	});

	it("keeps the reader's choice for a group the projection is not showing", () => {
		expect(foldRecentSessionGroups({ hidden: true }, groups, "collapse")).toEqual({
			hidden: true,
			"repo-a": false,
			"repo-b": false,
		});
	});
});
