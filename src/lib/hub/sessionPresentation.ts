import type { SpacesFacetSource } from "@/lib/spaces/spacesViewProjection";

/** The catalog's account line. Mirrors `SessionAccountSummary` in the hub
 * protocol; the phone reads this type too, so it stays free of desktop state. */
export interface SessionAccountSummary {
	/** Absent: the provider's default account, which the phone names itself. */
	readonly label?: string;
	/** A switch queued behind the running turn. */
	readonly pending?: { readonly label?: string };
}

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
	/** Present only when the phone may read and switch this session's account. */
	readonly account?: SessionAccountSummary;
}

export function sessionPresentation(
	row: SpacesFacetSource & { readonly detail?: string; readonly pinned?: boolean },
	git?: {
		readonly ahead: number;
		readonly behind: number;
		readonly committed: { readonly files: number };
		readonly worktree: { readonly files: number };
	},
	account?: SessionAccountSummary,
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
		...(account ? { account } : {}),
	};
}
