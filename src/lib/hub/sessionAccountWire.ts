/**
 * The account round trip's wire shapes, between the hub and this window.
 *
 * A leaf: the IPC layer names the reply type, and the bridge that builds it
 * reaches the store, so keeping the shapes here keeps that edge acyclic.
 */

/** What the hub emits. Matches `SessionAccountRequest` in `hub/session_account.rs`. */
export interface HubSessionAccountDispatch {
	request_id: string;
	session_id: string;
	/** Absent for a read. The hub only forwards a switch the person confirmed. */
	switch?: {
		action_id: string;
		/** Null is the provider's default account. */
		account_id: string | null;
	};
}

/** One account the phone may pick. Matches `HubSessionAccountChoiceReply` in `hub/commands.rs`. */
export interface SessionAccountChoiceReply {
	readonly accountId: string | null;
	/** Absent for the provider's default account; the phone names it. */
	readonly label?: string;
	readonly current: boolean;
	readonly pending: boolean;
	readonly usage?: {
		readonly usedPercent: number;
		readonly window: "five_hour" | "weekly";
		/** The desktop's compact duration, e.g. `3h 40m`. */
		readonly resetsIn?: string;
	};
}

type HubSessionAccountOutcome =
	| "listed"
	| "switched"
	| "scheduled"
	| "in_progress"
	| "refused";

/** What this computer sends back. Matches `HubSessionAccountReply` in `hub/commands.rs`. */
export interface HubSessionAccountReply {
	outcome: HubSessionAccountOutcome;
	accounts: SessionAccountChoiceReply[];
	detail?: string;
	code?: string;
}
