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
	/** Its display manager when that is an Agent, from the one relation owner
	 * (`agentRelations.ts`). Absent when no fact names one: the phone then
	 * lists the agent at the top level. */
	readonly managerAgentId?: string;
	/** Its display manager when that is a plain shell row, by the Hmux
	 * Session the phone keys that row by. At most one of the two is set. */
	readonly managerSessionId?: string;
	/** When the Agent's backend continues it by itself after its usage
	 * limit resets, while recovery waits for that: the backend's own wait
	 * (`agent_recovery.waits`), not a row's words. The phone reads it with
	 * the shared needs-person and row rules, as the desktop does. Absent
	 * while no wait is known. */
	readonly continuesAtMs?: number;
}

/** The Agent a row shows and who manages it, as the relation owner says. */
export type SessionAgentRelation = Pick<
	SessionPresentation,
	"managerAgentId" | "managerSessionId"
> & { readonly agentId: string };

export function sessionPresentation(
	row: SpacesFacetSource & {
		readonly detail?: string;
		readonly pinned?: boolean;
		readonly approval?: PendingApproval;
		readonly notificationsMuted?: boolean;
		readonly continuesAtMs?: number;
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
		...(relation?.managerSessionId
			? { managerSessionId: relation.managerSessionId }
			: {}),
		...(row.continuesAtMs === undefined ? {} : { continuesAtMs: row.continuesAtMs }),
	};
}
