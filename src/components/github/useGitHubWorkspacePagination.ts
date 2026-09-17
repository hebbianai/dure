import { useState } from "react";
import { githubPage, reconcileGitHubPage } from "@/lib/github/githubPagination";

export function useGitHubWorkspacePagination(
	scope: string,
	total: number | null,
) {
	const [stored, setStored] = useState({ scope, page: 1 });
	const selection = reconcileGitHubPage(stored, scope, total);
	// Reconcile before committing rows, without an effect rendering the previous scope's page.
	if (selection !== stored) setStored(selection);
	return {
		page: selection.page,
		pagination: githubPage(total ?? 0, selection.page),
		setPage: (page: number) => setStored({ scope, page }),
	};
}
