import type { PendingApproval } from "@/lib/agents/approvalRequest";
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
	/** The approval the agent waits on, while the Host carries what its
	 * provider asks (`pendingApproval`): the wait `displayState: "blocked"`
	 * names, with the attention id an answer quotes. */
	readonly approval?: PendingApproval;
	/** The person muted this agent's notifications on the desktop
	 * (`agentNotificationMute.ts`). The phone sends no local alert for it;
	 * the desktop already sends it no push. Absent means not muted. */
	readonly notificationsMuted?: boolean;
	/** The Agent the row shows. The phone keys who manages whom by it, so it
	 * never rebuilds this desktop's row keys. Absent for a row that is no
	 * Agent. */
	readonly agentId?: string;
	/** Its display manager, from the one relation owner
	 * (`agentRelations.ts`). Absent when no fact names one: the phone then
	 * lists the agent at the top level. */
	readonly managerAgentId?: string;
}

/** The Agent a row shows and who manages it, as the relation owner says. */
export interface SessionAgentRelation {
	readonly agentId: string;
	readonly managerAgentId?: string;
}

export function sessionPresentation(
	row: SpacesFacetSource & {
		readonly detail?: string;
		readonly pinned?: boolean;
		readonly approval?: PendingApproval;
		readonly notificationsMuted?: boolean;
	},
	git?: {
		readonly ahead: number;
		readonly behind: number;
		readonly committed: { readonly files: number };
		readonly worktree: { readonly files: number };
	},
	account?: SessionAccountSummary,
	relation?: SessionAgentRelation,
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
		...(row.approval ? { approval: row.approval } : {}),
		...(row.notificationsMuted ? { notificationsMuted: true } : {}),
		...(relation ? { agentId: relation.agentId } : {}),
		...(relation?.managerAgentId ? { managerAgentId: relation.managerAgentId } : {}),
	};
}
