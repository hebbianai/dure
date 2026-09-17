import { describe, expect, it } from "vitest";
import {
	GITHUB_ISSUE_PANE_COMPONENT,
	githubIssuePaneRow,
	githubIssueTargetKey,
	githubIssueTargetKeyFromPane,
	openGitHubIssueTargetKeys,
	slimGitHubIssueLayout,
} from "@/lib/github/githubIssuePane";
import type { GitHubWorkItemRow } from "@/lib/github/githubResponses";

const row = {
	kind: "issue",
	number: 293,
	title: "Make admission backend-authoritative",
	url: "https://github.com/o/r/issues/293",
	repository: { projectId: "proj-1", nameWithOwner: "o/r" },
	comments: Array.from({ length: 188 }, (_, i) => ({ id: `c${i}`, body: "x".repeat(2000) })),
} as unknown as GitHubWorkItemRow;

describe("current issue target", () => {
	it("keeps the issue's project and number independent of view identity and loaded detail", () => {
		const key = githubIssueTargetKey(row);
		expect(
			githubIssueTargetKeyFromPane({
				component: "githubissue",
				params: { row },
			}),
		).toBe(key);
		expect(githubIssueTargetKey({ ...row, number: row.number + 1 })).not.toBe(
			key,
		);
		expect(
			githubIssueTargetKey({
				...row,
				repository: { ...row.repository, projectId: "other" },
			}),
		).not.toBe(key);
	});
	it.each(["terminal", "github", "diff", "unknown", undefined])(
		"does not interpret an issue-shaped payload in %s content",
		(component) => {
			expect(
				githubIssueTargetKeyFromPane({ component, params: { row } }),
			).toBeUndefined();
		},
	);
	it.each([
		undefined,
		null,
		[],
		{},
		{ ...row, kind: "pr" },
		{ ...row, number: "293" },
		{ ...row, number: 0 },
		{ ...row, number: 1.5 },
		{ ...row, repository: null },
		{ ...row, repository: [] },
		{ ...row, repository: { projectId: "" } },
		{ ...row, repository: { projectId: 12 } },
	])(
		"leaves missing or malformed issue references unknown: %j",
		(candidate) => {
			expect(
				githubIssueTargetKeyFromPane({
					component: "githubissue",
					params: { row: candidate },
				}),
			).toBeUndefined();
		},
	);
});

describe("githubIssuePaneRow", () => {
	it("drops the transcript and keeps the row's identity", () => {
		const slim = githubIssuePaneRow(row) as GitHubWorkItemRow & { comments?: unknown };
		expect(slim.comments).toBeUndefined();
		expect(slim.number).toBe(293);
		expect(slim.repository).toEqual(row.repository);
		// The caller's row is untouched.
		expect((row as { comments?: unknown[] }).comments).toHaveLength(188);
	});
});

describe("slimGitHubIssueLayout", () => {
	const layout = {
		grid: {},
		panels: {
			"github-issue:proj-1:293": {
				id: "github-issue:proj-1:293",
				contentComponent: GITHUB_ISSUE_PANE_COMPONENT,
				params: { row },
			},
			"term:1": { id: "term:1", contentComponent: "terminal", params: { cwd: "~" } },
		},
	};

	it("strips transcripts from issue panes and leaves other panes alone", () => {
		const slim = slimGitHubIssueLayout(layout);
		expect(slim).not.toBe(layout);
		const issue = slim.panels["github-issue:proj-1:293"].params.row as { comments?: unknown };
		expect(issue.comments).toBeUndefined();
		expect(slim.panels["term:1"]).toBe(layout.panels["term:1"]);
		// Five open issues put 1.5 MB into the layout store on 2026-09-09.
		expect(JSON.stringify(slim).length).toBeLessThan(2_000);
	});

	it("returns the same object when there is nothing to strip", () => {
		const clean = slimGitHubIssueLayout(layout);
		expect(slimGitHubIssueLayout(clean)).toBe(clean);
		expect(slimGitHubIssueLayout(undefined)).toBeUndefined();
	});
});
describe("openGitHubIssueTargetKeys", () => {
	const pane = (id: string, component: string, params: unknown) => ({
		id,
		params,
		api: { component, getParameters: () => params },
	});

	it("collects the issue keys of mounted panes across Dockviews and ignores other content", () => {
		const other = { ...row, number: 7 } as GitHubWorkItemRow;
		const keys = openGitHubIssueTargetKeys([
			[
				"space-a",
				{
					panels: [
						pane("issue:1", GITHUB_ISSUE_PANE_COMPONENT, { row }),
						pane("term:1", "terminal", { cwd: "/repo" }),
					],
				},
			],
			[
				"space-b",
				{
					panels: [
						pane("issue:2", GITHUB_ISSUE_PANE_COMPONENT, { row: other }),
					],
				},
			],
		]);
		expect([...keys].sort()).toEqual(
			[githubIssueTargetKey(row), githubIssueTargetKey(other)].sort(),
		);
		expect(openGitHubIssueTargetKeys([]).size).toBe(0);
	});
});
