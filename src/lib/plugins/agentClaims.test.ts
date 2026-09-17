import { describe, expect, it } from "vitest";
import type { IssueTrackerIssueSummaryV1 } from "@/contracts/generated/extensionContracts";
import {
	groupAgentClaims,
	selectAgentClaimPanes,
} from "@/lib/plugins/agentClaims";

function issue(
	id: string,
	branch: string | null,
	status = "in_progress",
): IssueTrackerIssueSummaryV1 {
	return {
		id,
		title: id,
		status,
		priority: 1,
		issue_type: "task",
		assignee: "Jay Hong",
		updated_at: null,
		dependency_count: 0,
		dependent_count: 0,
		agent_binding: branch ? { kind: "scm_branch", branch } : null,
	};
}

describe("groupAgentClaims", () => {
	it("only changes presentation order and never resolves an ambiguous binding by focus", () => {
		const panes = [
			{ id: "one", label: "One", branch: "shared" },
			{ id: "two", label: "Two", branch: "shared" },
			{ id: "three", label: "Three", branch: "third" },
		];
		const issues = [issue("ambiguous", "shared"), issue("linked", "third")];
		const groups = groupAgentClaims(panes, issues, ["in_progress"], "two");
		expect(groups.panes.map((pane) => pane.id)).toEqual(["two", "one", "three"]);
		expect(groups.panes[0].issues).toEqual([]);
		expect(groups.unmatched.map((entry) => entry.id)).toEqual(["ambiguous"]);
		expect(groupAgentClaims(panes, issues, ["in_progress"], "term:shell").panes.map((pane) => pane.id)).toEqual(["one", "two", "three"]);
		expect(panes.map((pane) => pane.id)).toEqual(["one", "two", "three"]);
	});
	it("matches claimed statuses to the unique pane branch", () => {
		const grouped = groupAgentClaims(
			[
				{ id: "one", label: "One", branch: "agent/one" },
				{ id: "two", label: "Two", branch: "agent/two" },
			],
			[
				issue("repo-2", "agent/one"),
				issue("repo-1", "agent/one"),
				issue("repo-3", "agent/two", "closed"),
			],
			["in_progress"],
		);

		expect(
			grouped.panes.map((pane) => [pane.id, pane.issues.map(({ id }) => id)]),
		).toEqual([
			["one", ["repo-1", "repo-2"]],
			["two", []],
		]);
		expect(grouped.unmatched).toEqual([]);
	});

	it("fails closed for missing, stale, or ambiguous pane bindings", () => {
		const grouped = groupAgentClaims(
			[
				{ id: "one", label: "One", branch: "agent/shared" },
				{ id: "two", label: "Two", branch: "agent/shared" },
			],
			[issue("repo-unbound", null), issue("repo-ambiguous", "agent/shared")],
			["in_progress"],
		);

		expect(grouped.panes.every((pane) => pane.issues.length === 0)).toBe(true);
		expect(grouped.unmatched.map(({ id }) => id)).toEqual([
			"repo-ambiguous",
			"repo-unbound",
		]);
	});
});

describe("selectAgentClaimPanes", () => {
	it("projects actual agent panes in space order and excludes unopened or foreign agents", () => {
		const agents = [
			{
				id: "open",
				name: "open",
				displayName: "Open Pane",
				projectId: "repo",
				branch: "agent/open",
			},
			{
				id: "hidden",
				name: "hidden",
				projectId: "repo",
				branch: "agent/hidden",
			},
			{
				id: "unopened",
				name: "unopened",
				projectId: "repo",
				branch: "agent/unopened",
			},
			{
				id: "foreign",
				name: "foreign",
				projectId: "other",
				branch: "agent/foreign",
			},
		];

		expect(
			selectAgentClaimPanes(
				[
					{ key: "term:shell", kind: "term" },
					{ key: "agent:hidden-pane", kind: "agent", agentId: "hidden" },
					{ key: "agent:stale", kind: "agent", agentId: "missing" },
					{ key: "agent:open-pane", kind: "agent", agentId: "open" },
					{ key: "agent:foreign", kind: "agent", agentId: "foreign" },
				],
				agents,
				"repo",
			),
		).toEqual([
			{ id: "agent:hidden-pane", label: "hidden", branch: "agent/hidden" },
			{ id: "agent:open-pane", label: "Open Pane", branch: "agent/open" },
		]);
	});
});
