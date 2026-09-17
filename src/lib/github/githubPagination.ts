const GITHUB_PAGE_SIZE = 25;
export const GITHUB_RESULT_LIMIT = 1_000;

export function githubPage(total: number, requested: number) {
	const pageCount = Math.max(1, Math.ceil(total / GITHUB_PAGE_SIZE));
	const page = Math.max(1, Math.min(pageCount, requested));
	return {
		page,
		pageCount,
		start: (page - 1) * GITHUB_PAGE_SIZE,
		end: Math.min(total, page * GITHUB_PAGE_SIZE),
	};
}

interface GitHubPageSelection {
	scope: string;
	page: number;
}

/** A pending refresh retains selection; a new scope resets it; a complete snapshot clamps it. */
export function reconcileGitHubPage(
	current: GitHubPageSelection,
	scope: string,
	total: number | null,
): GitHubPageSelection {
	const requested = current.scope === scope ? current.page : 1;
	const page = total === null ? requested : githubPage(total, requested).page;
	return current.scope === scope && current.page === page
		? current
		: { scope, page };
}

/** Keep the first, last and adjacent pages reachable without a wide footer. */
export function githubPageNumbers(
	current: number,
	total: number,
): (number | "before" | "after")[] {
	if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
	const first = Math.max(2, Math.min(current - 1, total - 4));
	const last = Math.min(total - 1, Math.max(current + 1, 5));
	return [
		1,
		...(first > 2 ? ["before" as const] : []),
		...Array.from({ length: last - first + 1 }, (_, index) => first + index),
		...(last < total - 1 ? ["after" as const] : []),
		total,
	];
}
