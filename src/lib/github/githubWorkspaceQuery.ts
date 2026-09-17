import type { Project } from "@/types";
import type {
	GitHubListResult,
	GitHubQueryFailure,
	GitHubQueryResult,
} from "./githubQuery";
import type {
	GitHubProjectRow,
	GitHubRepository,
	GitHubWorkItemRow,
} from "./githubResponses";
import {
	dedupeGitHubProjects,
	type GitHubWorkspacePreset,
	type GitHubWorkspaceView,
	uniqueGitHubOwnerRepositories,
} from "./githubWorkspace";

export interface GitHubWorkspaceRequest {
	targets: readonly Pick<Project, "id" | "name" | "path">[];
	view: GitHubWorkspaceView;
	preset: GitHubWorkspacePreset;
	query: string;
}

export interface GitHubWorkspaceQueries {
	repository(
		project: GitHubWorkspaceRequest["targets"][number],
	): Promise<GitHubQueryResult<GitHubRepository>>;
	workItems(
		repository: GitHubRepository,
		kind: "issue" | "pr",
		preset: GitHubWorkspacePreset,
		query: string,
	): Promise<GitHubListResult<GitHubWorkItemRow>>;
	projects(
		repository: GitHubRepository,
		preset: GitHubWorkspacePreset,
		query: string,
	): Promise<GitHubListResult<GitHubProjectRow>>;
}

const QUERY_CONCURRENCY = 4;

export interface GitHubWorkspaceError {
	repository?: string;
	failure: GitHubQueryFailure;
}

export interface GitHubWorkspaceSnapshot {
	repositories: GitHubRepository[];
	workItems: GitHubWorkItemRow[];
	projects: GitHubProjectRow[];
	errors: GitHubWorkspaceError[];
	limited: boolean;
}

async function mapBounded<T, R>(
	values: readonly T[],
	worker: (value: T) => Promise<R>,
	signal: AbortSignal,
): Promise<R[] | null> {
	const output = new Array<R>(values.length);
	let cursor = 0;
	const consume = async () => {
		while (!signal.aborted && cursor < values.length) {
			const index = cursor;
			cursor += 1;
			output[index] = await worker(values[index]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(QUERY_CONCURRENCY, values.length) }, consume),
	);
	return signal.aborted ? null : output;
}

/** One request owns both discovery and fan-out. Abort stops queued work, not commands already sent. */
export async function loadGitHubWorkspace(
	{ targets, view, preset, query }: GitHubWorkspaceRequest,
	queries: GitHubWorkspaceQueries,
	signal: AbortSignal,
): Promise<GitHubWorkspaceSnapshot | null> {
	const repositoryResults = await mapBounded(
		targets,
		async (project) => ({
			project,
			result: await queries.repository(project),
		}),
		signal,
	);
	if (!repositoryResults) return null;
	const repositories = repositoryResults.flatMap(({ result }) =>
		result.ok ? [result.value] : [],
	);
	const errors: GitHubWorkspaceError[] = repositoryResults.flatMap(
		({ project, result }) =>
			result.ok ? [] : [{ repository: project.name, failure: result.error }],
	);

	const workItems: GitHubWorkItemRow[] = [];
	let limited = false;
	let projectRows: GitHubProjectRow[] = [];
	if (view === "projects") {
		const ownerResults = await mapBounded(
			uniqueGitHubOwnerRepositories(repositories),
			async (repository) => ({
				repository,
				result: await queries.projects(repository, preset, query),
			}),
			signal,
		);
		if (!ownerResults) return null;
		for (const { repository, result } of ownerResults) {
			if (result.ok) {
				projectRows.push(...result.value);
				limited ||= result.limitReached;
			} else
				errors.push({ repository: repository.owner, failure: result.error });
		}
		projectRows = dedupeGitHubProjects(projectRows);
	} else {
		const itemResults = await mapBounded(
			repositories,
			async (repository) => ({
				repository,
				result: await queries.workItems(
					repository,
					view === "issues" ? "issue" : "pr",
					preset,
					query,
				),
			}),
			signal,
		);
		if (!itemResults) return null;
		for (const { repository, result } of itemResults) {
			if (result.ok) {
				workItems.push(...result.value);
				limited ||= result.limitReached;
			} else {
				errors.push({
					repository: repository.nameWithOwner,
					failure: result.error,
				});
			}
		}
		workItems.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
	}
	return { repositories, workItems, projects: projectRows, errors, limited };
}
