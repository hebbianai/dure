import { describe, expect, it } from "vitest";
import { parseGitHubWorkItemRows } from "./githubResponses";
import {
	dedupeGitHubProjects,
	githubProjectListArgs,
	githubProjectScopeMissing,
	githubStartPrefill,
	githubWorkItemListArgs,
	uniqueGitHubOwnerRepositories,
} from "./githubWorkspace";

const repository = {
	projectId: "project-1",
	projectName: "Dure",
	path: "/work/dure",
	nameWithOwner: "hebbianai/dure",
	owner: "hebbianai",
	url: "https://github.com/hebbianai/dure",
	isInOrganization: true,
};

describe("GitHub workspace commands", () => {
	it("deduplicates Projects by host-owner query surface and canonical URL", () => {
		const secondCheckout = { ...repository, projectId: "project-2" };
		const enterprise = {
			...repository,
			projectId: "project-3",
			url: "https://github.example.test/hebbianai/dure",
		};
		expect(
			uniqueGitHubOwnerRepositories([
				repository,
				secondCheckout,
				enterprise,
			]).map((candidate) => candidate.projectId),
		).toEqual(["project-1", "project-3"]);

		const project = {
			kind: "project" as const,
			number: 7,
			title: "Launch",
			url: "https://github.com/orgs/hebbianai/projects/7",
			closed: false,
			shortDescription: "",
			owner: "hebbianai",
		};
		expect(dedupeGitHubProjects([project, { ...project }])).toEqual([project]);
	});

	it("uses native filters and combines review-requested with search", () => {
		expect(githubWorkItemListArgs("issue", "mine", "retry")).toContain(
			"--assignee",
		);
		expect(githubWorkItemListArgs("pr", "mine", "")).toContain("--author");
		const args = githubWorkItemListArgs("pr", "needsReview", "parser");
		expect(args.slice(-2)).toEqual(["--search", "review-requested:@me parser"]);
	});

	it("asks gh for both open and closed work in the All view", () => {
		const args = githubWorkItemListArgs("issue", "all", "");
		expect(args.slice(-2)).toEqual(["--state", "all"]);
	});

	it("only asks gh for closed projects in the All view", () => {
		expect(githubProjectListArgs("hebbianai", "open")).not.toContain(
			"--closed",
		);
		expect(githubProjectListArgs("hebbianai", "all")).toContain("--closed");
	});

	it("recognizes the isolated Projects permission failure", () => {
		expect(
			githubProjectScopeMissing(
				"authentication token missing required scopes [read:project]",
			),
		).toBe(true);
	});
});

describe("GitHub Start prefill", () => {
	it("pins the local project and gives Quick Dispatch an actionable prompt", () => {
		const [row] =
			parseGitHubWorkItemRows(
				JSON.stringify([
					{
						number: 42,
						title: "Fix flaky refresh",
						url: "https://github.com/hebbianai/dure/issues/42",
						updatedAt: "2026-09-03T01:00:00Z",
					},
				]),
				"issue",
				repository,
			) ?? [];
		expect(githubStartPrefill(row)).toMatchObject({
			projectId: "project-1",
			typedName: "github-issue-42-fix-flaky-refresh",
		});
		expect(githubStartPrefill(row).promptText).toContain(row.url);
	});
});
