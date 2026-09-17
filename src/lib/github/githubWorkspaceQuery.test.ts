import { describe, expect, it, vi } from "vitest";
import { parseGitHubWorkItemRows } from "./githubResponses";
import {
	type GitHubWorkspaceQueries,
	type GitHubWorkspaceRequest,
	loadGitHubWorkspace,
} from "./githubWorkspaceQuery";

const targets = Array.from({ length: 5 }, (_, index) => ({
	id: String(index),
	name: `Repo ${index}`,
	path: `/repo/${index}`,
}));
const repository = (id: string) => ({
	projectId: id,
	projectName: `Repo ${id}`,
	path: `/repo/${id}`,
	nameWithOwner: `team-${id}/repo`,
	owner: `team-${id}`,
	url: `https://github.example/team-${id}/repo`,
	isInOrganization: true,
});
const failure = {
	ok: false,
	error: { kind: "command-failed", detail: "Unavailable" },
} as const;
function ports() {
	return {
		repository: vi
			.fn<GitHubWorkspaceQueries["repository"]>()
			.mockImplementation(async ({ id }) => ({
				ok: true,
				value: repository(id),
			})),
		workItems: vi
			.fn<GitHubWorkspaceQueries["workItems"]>()
			.mockResolvedValue({ ok: true, value: [], limitReached: false }),
		projects: vi
			.fn<GitHubWorkspaceQueries["projects"]>()
			.mockResolvedValue({ ok: true, value: [], limitReached: false }),
	};
}
const request: GitHubWorkspaceRequest = {
	targets,
	view: "issues",
	preset: "mine",
	query: 'label:"needs review"',
};

describe("GitHub workspace requests", () => {
	it.each(["issues", "pullRequests"] as const)(
		"aggregates %s across repositories with partial failures and a truthful cap",
		async (view) => {
			const queries = ports();
			queries.repository.mockImplementation(async ({ id }) =>
				id === "2" ? failure : { ok: true, value: repository(id) },
			);
			queries.workItems.mockImplementation(async (repo, kind) =>
				repo.projectId === "1"
					? failure
					: {
							ok: true,
							value:
								parseGitHubWorkItemRows(
									JSON.stringify([
										{
											number: 42,
											title: repo.projectName,
											url: `${repo.url}/issues/42`,
											updatedAt: `2026-09-0${Number(repo.projectId) + 1}`,
										},
									]),
									kind,
									repo,
								) ?? [],
							limitReached: repo.projectId === "0",
						},
			);
			const result = await loadGitHubWorkspace(
				{ ...request, view },
				queries,
				new AbortController().signal,
			);
			expect(result?.workItems.map((row) => row.repository.projectId)).toEqual([
				"4",
				"3",
				"0",
			]);
			expect(result?.errors).toEqual([
				{ repository: "Repo 2", failure: failure.error },
				{ repository: "team-1/repo", failure: failure.error },
			]);
			expect(result?.limited).toBe(true);
			expect(queries.workItems).toHaveBeenCalledTimes(4);
			expect(queries.workItems).toHaveBeenCalledWith(
				repository("0"),
				view === "issues" ? "issue" : "pr",
				"mine",
				request.query,
			);
			expect(queries.projects).not.toHaveBeenCalled();
		},
	);

	it("queries each host-owner once and deduplicates canonical Projects while preserving failures", async () => {
		const queries = ports();
		queries.repository.mockImplementation(async ({ id }) => ({
			ok: true,
			value: {
				...repository(id),
				owner: id === "4" ? "other" : "team",
				url: `https://${id === "3" ? "enterprise.example" : "github.example"}/team/repo-${id}`,
			},
		}));
		queries.projects.mockImplementation(async (repo) =>
			repo.owner === "other"
				? failure
				: {
						ok: true,
						value: [
							{
								kind: "project",
								number: 1,
								title: "Launch",
								owner: "team",
								url: "https://github.example/orgs/team/projects/1",
								shortDescription: "",
								closed: false,
							},
						],
						limitReached: true,
					},
		);
		const result = await loadGitHubWorkspace(
			{ ...request, view: "projects" },
			queries,
			new AbortController().signal,
		);
		expect(queries.projects).toHaveBeenCalledTimes(3);
		expect(result?.projects).toHaveLength(1);
		expect(result?.errors).toEqual([
			{ repository: "other", failure: failure.error },
		]);
		expect(result?.limited).toBe(true);
		expect(queries.workItems).not.toHaveBeenCalled();
	});

	it.each(["issues", "pullRequests", "projects"] as const)(
		"stops queued %s fan-out and discards an aborted partial snapshot",
		async (view) => {
			const queries = ports();
			const finish: (() => void)[] = [];
			const pending = () =>
				new Promise<{ ok: true; value: []; limitReached: false }>((resolve) => {
					finish.push(() =>
						resolve({ ok: true, value: [], limitReached: false }),
					);
				});
			queries.projects.mockImplementation(pending);
			queries.workItems.mockImplementation(pending);
			const owner = new AbortController();
			const result = loadGitHubWorkspace(
				{ ...request, view },
				queries,
				owner.signal,
			);
			await vi.waitFor(() => expect(finish).toHaveLength(4));
			owner.abort();
			for (const resolve of finish.slice()) resolve();
			await expect(result).resolves.toBeNull();
			expect(finish).toHaveLength(4);
		},
	);
});
