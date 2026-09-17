import { describe, expect, it } from "vitest";
import {
	parseGitHubProjectRows,
	parseGitHubRepository,
	parseGitHubWorkItemRows,
} from "./githubResponses";
import { filterGitHubProjects } from "./githubWorkspace";

const repository = {
	projectId: "project-1",
	projectName: "Dure",
	path: "/work/dure",
	nameWithOwner: "hebbianai/dure",
	owner: "hebbianai",
	url: "https://github.com/hebbianai/dure",
	isInOrganization: true,
};

describe("GitHub workspace parsing", () => {
	it("skips incomplete rows without mistaking an invalid envelope for an empty list", () => {
		expect(parseGitHubWorkItemRows("{}", "issue", repository)).toBeNull();
		expect(parseGitHubWorkItemRows("[]", "issue", repository)).toEqual([]);
		const rows = parseGitHubWorkItemRows(
			JSON.stringify([
				null,
				{ number: 1, title: "Incomplete" },
				{ number: 42, title: "Issue", url: `${repository.url}/issues/42` },
			]),
			"issue",
			repository,
		);
		expect(rows).toHaveLength(1);
		expect(rows?.[0]).toMatchObject({
			number: 42,
			state: "OPEN",
			assignees: [],
			labels: [],
			checks: { total: 0 },
		});
		expect(rows?.[0].repository).toBe(repository);
	});
	it("parses the repository identity separately from project-scoped data", () => {
		expect(
			parseGitHubRepository(
				JSON.stringify({
					nameWithOwner: "hebbianai/dure",
					url: "https://github.com/hebbianai/dure",
					owner: { login: "hebbianai" },
					isInOrganization: true,
				}),
				{ id: "project-1", name: "Dure", path: "/work/dure" },
			),
		).toEqual(repository);
	});

	it("parses PR reviewers and summarizes mixed checks", () => {
		const [row] =
			parseGitHubWorkItemRows(
				JSON.stringify([
					{
						number: 42,
						title: "Ship workspace",
						url: "https://github.com/hebbianai/dure/pull/42",
						state: "OPEN",
						isDraft: false,
						author: { login: "jwan" },
						assignees: [{ login: "octo" }],
						reviewRequests: [{ login: "reviewer" }],
						labels: [{ name: "frontend" }],
						updatedAt: "2026-09-03T01:00:00Z",
						headRefName: "feature/workspace",
						reviewDecision: "REVIEW_REQUIRED",
						mergeStateStatus: "BLOCKED",
						statusCheckRollup: [
							{ conclusion: "SUCCESS" },
							{ state: "FAILURE" },
							{ status: "IN_PROGRESS" },
						],
					},
				]),
				"pr",
				repository,
			) ?? [];
		expect(row).toMatchObject({
			number: 42,
			author: "jwan",
			assignees: ["octo"],
			reviewRequests: ["reviewer"],
			labels: ["frontend"],
			checks: { total: 3, passed: 1, failed: 1, pending: 1 },
			mergeStateStatus: "BLOCKED",
		});
	});

	it("accepts project-list envelopes from gh", () => {
		const rows = parseGitHubProjectRows(
			JSON.stringify({
				projects: [
					{
						number: 7,
						title: "Launch",
						url: "https://github.com/orgs/hebbianai/projects/7",
						closed: false,
						shortDescription: "Release work",
						items: { totalCount: 12 },
						owner: { login: "hebbianai" },
					},
				],
			}),
			"hebbianai",
		);
		expect(rows?.[0]).toMatchObject({
			number: 7,
			itemCount: 12,
			owner: "hebbianai",
		});
		expect(filterGitHubProjects(rows ?? [], "open", "release")).toHaveLength(1);
	});
});
