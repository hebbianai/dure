import type {
	GitHubProjectRow,
	GitHubRepository,
	GitHubWorkItemRow,
} from "./githubResponses";

export type GitHubWorkspaceView = "issues" | "pullRequests" | "projects";
export type GitHubWorkspacePreset = "open" | "mine" | "needsReview" | "all";

export interface GitHubStartPrefill {
	projectId: string;
	promptText: string;
	typedName: string;
}

export function githubProjectsWebUrl(
	repository: GitHubRepository,
	create = false,
): string {
	let origin = "https://github.com";
	try {
		origin = new URL(repository.url).origin;
	} catch {
		// `gh repo view` is trusted to return a URL; retain a safe public fallback.
	}
	const ownerKind = repository.isInOrganization ? "orgs" : "users";
	const suffix = create ? "/new" : "";
	return `${origin}/${ownerKind}/${encodeURIComponent(repository.owner)}/projects${suffix}`;
}

export function uniqueGitHubOwnerRepositories(
	repositories: readonly GitHubRepository[],
): GitHubRepository[] {
	const ownerSurfaces = new Set<string>();
	return repositories.filter((repository) => {
		const surface = githubProjectsWebUrl(repository);
		if (ownerSurfaces.has(surface)) return false;
		ownerSurfaces.add(surface);
		return true;
	});
}

export function dedupeGitHubProjects(
	projects: readonly GitHubProjectRow[],
): GitHubProjectRow[] {
	const urls = new Set<string>();
	return projects.filter((project) => {
		if (urls.has(project.url)) return false;
		urls.add(project.url);
		return true;
	});
}

const WORK_ITEM_FIELDS = {
	issue: "number,title,url,state,stateReason,author,assignees,labels,updatedAt",
	pr: "number,title,url,state,isDraft,author,assignees,labels,updatedAt,headRefName,reviewDecision,reviewRequests,statusCheckRollup,mergeStateStatus",
} as const;

/** Build a bounded, non-interactive list command from the selected UI state. */
export function githubWorkItemListArgs(
	kind: "issue" | "pr",
	preset: GitHubWorkspacePreset,
	query: string,
	limit = 50,
): string[] {
	const args = [
		kind,
		"list",
		"--json",
		WORK_ITEM_FIELDS[kind],
		"--limit",
		String(limit),
	];
	args.push("--state", preset === "all" ? "all" : "open");
	if (preset === "mine") {
		args.push(kind === "pr" ? "--author" : "--assignee", "@me");
	}
	const searchTerms = [
		preset === "needsReview" ? "review-requested:@me" : "",
		query.trim(),
	].filter(Boolean);
	if (searchTerms.length > 0) args.push("--search", searchTerms.join(" "));
	return args;
}

export function githubProjectListArgs(
	owner: string,
	preset: GitHubWorkspacePreset,
	limit = 50,
): string[] {
	const args = [
		"project",
		"list",
		"--owner",
		owner,
		"--limit",
		String(limit),
		"--format",
		"json",
	];
	if (preset === "all") args.push("--closed");
	return args;
}

export function sortGitHubWorkItems(
	rows: readonly GitHubWorkItemRow[],
): GitHubWorkItemRow[] {
	return [...rows].sort((left, right) =>
		right.updatedAt.localeCompare(left.updatedAt),
	);
}

export function filterGitHubProjects(
	rows: readonly GitHubProjectRow[],
	preset: GitHubWorkspacePreset,
	query: string,
): GitHubProjectRow[] {
	const needle = query.trim().toLocaleLowerCase();
	return rows.filter(
		(row) =>
			(preset === "all" || !row.closed) &&
			(!needle ||
				`${row.title}\n${row.shortDescription}\n${row.owner}`
					.toLocaleLowerCase()
					.includes(needle)),
	);
}

function agentSlug(row: GitHubWorkItemRow): string {
	const title = row.title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 28)
		.replace(/-+$/g, "");
	const prefix = row.kind === "pr" ? "github-pr" : "github-issue";
	return `${prefix}-${row.number}${title ? `-${title}` : ""}`;
}

/** Canonical Quick Dispatch prefill for the row-level Start action. */
export function githubStartPrefill(row: GitHubWorkItemRow): GitHubStartPrefill {
	const subject = row.kind === "pr" ? "pull request" : "issue";
	const goal =
		row.kind === "pr"
			? "Review the existing changes, address the remaining work, run focused verification, and prepare the pull request for review."
			: "First check the issue against the current code and verification evidence. If its acceptance criteria are already satisfied, record the completion evidence on the issue and close it instead of making duplicate changes. Otherwise, reproduce the reported behavior, implement the fix, run focused verification, and prepare the change for review.";
	return {
		projectId: row.repository.projectId,
		typedName: agentSlug(row),
		promptText: `Work on GitHub ${subject} #${row.number}: ${row.title}\n\nRepository: ${row.repository.nameWithOwner}\nURL: ${row.url}\n\n${goal}`,
	};
}

export function githubProjectScopeMissing(stderr: string): boolean {
	return /(?:read:project|project scope)/i.test(stderr);
}
