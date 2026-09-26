import type { SpacesFacetSource } from "@/lib/spaces/spacesViewProjection";

/** Desktop-owned row presentation carried by the live catalog, never the
 * phone's durable placement cache. Missing observations stay missing. */
export interface SessionPresentation
	extends Omit<SpacesFacetSource, "desktopId" | "desktopName" | "branch"> {
	readonly pinned?: boolean;
	readonly detail?: string;
	readonly git?: {
		readonly ahead: number;
		readonly behind: number;
		readonly committed: number;
		readonly worktree: number;
	};
}

export function sessionPresentation(
	row: SpacesFacetSource & { readonly detail?: string; readonly pinned?: boolean },
	git?: {
		readonly ahead: number;
		readonly behind: number;
		readonly committed: { readonly files: number };
		readonly worktree: { readonly files: number };
	},
): SessionPresentation {
	return {
		pinned: row.pinned,
		activityAt: row.activityAt,
		displayState: row.displayState,
		projectId: row.projectId,
		projectName: row.projectName,
		cwd: row.cwd,
		kind: row.kind,
		hostId: row.hostId,
		hostLabel: row.hostLabel,
		provider: row.provider,
		detail: row.detail,
		...(git
			? {
					git: {
						ahead: git.ahead,
						behind: git.behind,
						committed: git.committed.files,
						worktree: git.worktree.files,
					},
				}
			: {}),
	};
}
