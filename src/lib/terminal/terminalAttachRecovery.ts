/** A failed attachment may outlive the Git checkout that originally hosted
 * its provider conversation. Inspection is advisory presentation state: it
 * must never become admission for the ordinary Resume action. */
export type TerminalAttachWorktreeStatus =
	| "present"
	| "missing"
	| "occupied"
	| "unavailable";

export interface TerminalAttachWorktreeRecovery {
	readonly path: string;
	readonly branch: string;
	readonly inspect: () => Promise<TerminalAttachWorktreeStatus>;
	/** Recreate or converge the exact recorded checkout. Never replaces an
	 * occupied path or a checkout owned by a different branch. */
	readonly recreate: () => Promise<unknown>;
}

export interface TerminalAttachRecovery {
	/** Exact source and chosen recovery target, independent of display text. */
	readonly ownerKey: string;
	/** Selects honest presentation and the matching named pane action. */
	readonly intent: "resume" | "start_fresh";
	readonly resume: () => Promise<unknown>;
	readonly context: string;
	/** The owning pane is replacing this runtime. Keep its surface mounted,
	 * but do not offer or automatically start a competing recovery. */
	readonly transitioning?: boolean;
	/** Self-heal once per failure episode. A confirmed missing worktree pauses
	 * self-healing so the user can choose restoration or fallback placement. */
	readonly automatic?: boolean;
	readonly worktree?: TerminalAttachWorktreeRecovery;
}
