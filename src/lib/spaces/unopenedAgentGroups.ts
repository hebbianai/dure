// The "Unopened agents" section groups its rows by repository the way the open
// list does, but keeps its own folds: a repository folded among the open panes
// says nothing about the queue of agents not yet opened there, and the section
// as a whole folds too.
import type { RepositorySpaceRow } from "@/lib/spaces/spaceRepositoryGroups";

/** Fold key of the whole section. */
export const UNOPENED_SECTION_FOLD_KEY = "unopened";

/** Fold key of one repository group inside the section — the repository key
 *  under the section's own namespace, so the two lists fold independently. */
export function unopenedFoldKey(repositoryKey: string): string {
	return `${UNOPENED_SECTION_FOLD_KEY} ${repositoryKey}`;
}

export interface UnopenedAgentRowLike {
	readonly agent: {
		readonly id: string;
		readonly projectId: string;
		readonly worktreePath: string;
	};
	readonly projectName: string;
}

/** The repository-group row for an unopened agent: the registered project as
 *  its grouping identity, the label the head row shows, and the worktree as
 *  the quick-add fallback location. The row itself rides along untouched. */
export function unopenedRepositoryRow<Row extends UnopenedAgentRowLike>(
	row: Row,
): Row & RepositorySpaceRow & { readonly key: string; readonly cwd: string } {
	return {
		...row,
		key: row.agent.id,
		projectId: row.agent.projectId,
		projectName: row.projectName,
		cwd: row.agent.worktreePath,
	};
}
