import { describe, expect, it } from "vitest";
import {
	githubAvatarUrl,
	githubIssueMutationArgs,
	parseDuplicateIssueNumber,
	parseGitHubIssueDetails,
	parseIssueMetadataInput,
} from "./githubIssueDetails";
import type { GitHubWorkItemRow } from "./githubResponses";

const target = {
	kind: "issue",
	number: 42,
	url: "https://github.example/team/repo/issues/42",
	repository: {
		url: "https://github.example/team/repo",
		projectId: "project-1",
	},
} as GitHubWorkItemRow;
const raw = {
	id: "I_issue42",
	number: 42,
	title: "Fix refresh",
	url: target.url,
	state: "OPEN",
	body: "## Details\n\n`refresh()`",
	createdAt: "2026-09-07T00:00:00Z",
	updatedAt: "2026-09-07T01:00:00Z",
	assignees: [{ login: "dev" }],
	labels: [{ name: "bug" }],
	comments: [
		{
			id: "comment-1",
			body: "Reproduced",
			author: null,
			createdAt: "2026-09-07T01:00:00Z",
			url: `${target.url}#issuecomment-1`,
		},
	],
};

describe("GitHub issue details", () => {
	it("parses Markdown and deleted comment authors while retaining the selected repository", () => {
		expect(parseGitHubIssueDetails(JSON.stringify(raw), target)).toMatchObject({
			body: raw.body,
			repository: target.repository,
			assignees: ["dev"],
			labels: ["bug"],
			comments: [{ id: "comment-1", body: "Reproduced", author: "" }],
		});
	});
	it.each([
		{ id: undefined },
		{ number: 43 },
		{ url: "https://github.example/other/repo/issues/42" },
		{ state: "UNKNOWN" },
		{ body: undefined },
		{ comments: null },
		{ comments: [{ id: "broken" }] },
	])("refuses a mismatched or incomplete detail snapshot: %j", (change) => {
		expect(
			parseGitHubIssueDetails(JSON.stringify({ ...raw, ...change }), target),
		).toBeNull();
	});
	it("keeps avatar requests on the selected GitHub host and encodes the login as a single segment", () => {
		expect(githubAvatarUrl("komojini", "https://github.com/team/repo")).toBe(
			"https://github.com/komojini.png?size=40",
		);
		expect(
			githubAvatarUrl("someone/#?", "https://github.example/team/repo"),
		).toBe("https://github.example/someone%2F%23%3F.png?size=40");
		expect(githubAvatarUrl("", target.repository.url)).toBeUndefined();
		expect(githubAvatarUrl("dev", "file:///private/repo")).toBeUndefined();
		expect(githubAvatarUrl("dev", "invalid")).toBeUndefined();
	});
	it("accepts a different positive issue number without accepting URLs, self-reference or shell-like input", () => {
		expect(parseDuplicateIssueNumber(" #123 ", 42)).toBe(123);
		for (const input of [
			"42",
			"#42",
			"0",
			"-1",
			"1.5",
			"1e3",
			"https://github.com/team/repo/issues/123",
			"123; command",
			"9007199254740992",
		]) {
			expect(parseDuplicateIssueNumber(input, 42)).toBeNull();
		}
	});
	it("pins commands to the exact GitHub host and repository and preserves literal comment text", () => {
		const body = "Hello\n`echo secret` $(pwd) --web @file";
		expect(githubIssueMutationArgs(target, { kind: "comment", body })).toEqual([
			"issue",
			"comment",
			"42",
			"--repo",
			"https://github.example/team/repo",
			"--body",
			body,
		]);
	});
	it("applies only the user's label delta, so unrelated labels are not replaced", () => {
		expect(
			githubIssueMutationArgs(target, {
				kind: "labels",
				before: ["bug", "triage"],
				after: ["bug", "ready"],
			}),
		).toEqual([
			"issue",
			"edit",
			"42",
			"--repo",
			target.repository.url,
			"--add-label",
			"ready",
			"--remove-label",
			"triage",
		]);
	});
	it("does not invoke gh for empty comments or unchanged metadata", () => {
		expect(
			githubIssueMutationArgs(target, { kind: "comment", body: " \n" }),
		).toBeNull();
		expect(
			githubIssueMutationArgs(target, {
				kind: "assignees",
				before: ["dev"],
				after: ["dev"],
			}),
		).toBeNull();
		expect(parseIssueMetadataInput(" dev, qa, dev, , ")).toEqual(["dev", "qa"]);
	});
	it("preserves an explicit not-planned close reason instead of marking the issue completed", () => {
		expect(
			githubIssueMutationArgs(target, {
				kind: "state",
				state: "CLOSED",
				reason: "not planned",
			}),
		).toEqual([
			"issue",
			"close",
			"42",
			"--repo",
			target.repository.url,
			"--reason",
			"not planned",
		]);
	});
});
