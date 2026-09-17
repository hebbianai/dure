import {
	type GitHubWorkItemRow,
	parseGitHubRepository,
	parseGitHubWorkItem,
} from "@/lib/github/githubResponses";
import { encodeDureDragPayload } from "@/lib/platform/productDragPayload";
import type { Project } from "@/types";

export const GITHUB_ISSUE_DRAG_TYPE = "github-issue";

/** Carry only a list summary, never local paths or the loaded transcript. */
export function encodeGitHubIssueDrag(row: GitHubWorkItemRow): string {
	return encodeDureDragPayload({
		type: GITHUB_ISSUE_DRAG_TYPE,
		projectId: row.repository.projectId,
		repository: {
			nameWithOwner: row.repository.nameWithOwner,
			url: row.repository.url,
			isInOrganization: row.repository.isInOrganization,
		},
		issue: {
			number: row.number,
			title: row.title,
			url: row.url,
			state: row.state,
			updatedAt: row.updatedAt,
		},
	});
}

/** Resolve local execution authority from registered projects, not drag text. */
export function parseGitHubIssueDrag(
	value: unknown,
	projects: readonly Project[],
): GitHubWorkItemRow | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== GITHUB_ISSUE_DRAG_TYPE) return null;
	const project = projects.find(
		(item) =>
			item.id === candidate.projectId && item.kind === "local" && item.isRepo,
	);
	if (!project || !candidate.repository) return null;
	const repository = parseGitHubRepository(
		JSON.stringify(candidate.repository),
		project,
	);
	if (!repository) return null;
	const row = parseGitHubWorkItem(candidate.issue, "issue", repository);
	if (!row || row.number <= 0 || row.title.length > 1024) return null;
	try {
		const url = new URL(repository.url);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!/^\/[^/]+\/[^/]+$/.test(url.pathname) ||
			url.pathname !== `/${repository.nameWithOwner}` ||
			row.url !== `${url.href}/issues/${row.number}`
		)
			return null;
	} catch {
		return null;
	}
	return row;
}
