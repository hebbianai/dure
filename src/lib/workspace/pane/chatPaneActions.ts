/** Projects a structured chat session into the pane action registry entry the
 * CLI and HTTP surfaces read. The status union is closed on purpose: it is
 * what `dure client pane state` prints, so a new value is a contract change.
 * Actions mirror the composer's gating exactly — interrupt is offered while a
 * turn is active and no interrupt is already in flight — so an agent invoking
 * it gets the same handler the button calls. */

import type {
	ChatPaneStatus,
	PaneActionEntry,
} from "@/lib/workspace/pane/paneActionRegistry";

export interface ChatPaneIdentity {
	readonly paneId: string;
	readonly agentId: string;
	readonly conversationId?: string;
	readonly interactionSessionId: string;
}

export interface ChatPaneSessionFacts {
	readonly phase: "detached" | "connecting" | "ready" | "error";
	/** The controller keeps phase "ready" while it backs off and resubscribes
	 * with a page still on screen; the CLI must not print that as idle. */
	readonly reconnecting: boolean;
	readonly activeTurn: { readonly turnId: string } | undefined;
	readonly interrupting: boolean;
	/** The composer disables its controls while an account or runtime-profile
	 * switch is in flight; the same lock hides the actions here. */
	readonly locked: boolean;
	/** The toolbar account switcher's own disabled predicate (a send, an
	 * answer, an interrupt, or a launch-selection switch in flight); account
	 * moves are hidden while it holds, exactly as the switcher is. */
	readonly accountMovesLocked?: boolean;
	readonly error: string | undefined;
	/** Shared reason token of the newest turn's failure, when it is the turn
	 * the user is looking at; surfaces as `turn_failed:<reason>` so an agent
	 * reading pane state sees what the composer banner says. */
	readonly lastTurnFailure?: string;
	/** Why no `handoff` action is offered for that failure (policy refusal
	 * code); appended to the error so the refusal is readable, not silent. */
	readonly handoffRefusal?: string;
}

export interface ChatPaneHandlers {
	readonly interrupt: () => Promise<void>;
	/** Present only when the usage-limit handoff policy has a target: the
	 * pane-scoped switch to that account (Settings opt-in already checked). */
	readonly handoff?: () => Promise<void>;
	/** Pane-scoped switch to each other same-provider account, keyed by
	 * credential id; exposed as `switch_account:<credentialId>` so an
	 * operating agent can move a pane without a parameterized action bus. */
	readonly switchAccount?: Readonly<Record<string, () => Promise<void>>>;
}

function chatPaneStatus(session: ChatPaneSessionFacts): ChatPaneStatus {
	switch (session.phase) {
		case "error":
			return "error";
		case "detached":
			return "detached";
		case "connecting":
			return "connecting";
		default:
			if (session.reconnecting) return "connecting";
			return session.activeTurn ? "turn_active" : "idle";
	}
}

/** Same identity line the copy-details button assembles for terminal panes. */
function chatPaneContext(identity: ChatPaneIdentity): string {
	return [
		`agent=${identity.agentId}`,
		`pane=${identity.paneId}`,
		`session=${identity.interactionSessionId}`,
		...(identity.conversationId
			? [`conversation=${identity.conversationId}`]
			: []),
	].join(" ");
}

export function chatPaneActionEntry(
	identity: ChatPaneIdentity,
	session: ChatPaneSessionFacts,
	handlers: ChatPaneHandlers,
): PaneActionEntry {
	const status = chatPaneStatus(session);
	const interruptOffered =
		status === "turn_active" && !session.interrupting && !session.locked;
	// Account moves restart the provider; only an idle, unlocked pane offers
	// them — the same gate the toolbar switcher uses.
	const accountMovesOffered =
		status === "idle" && !session.locked && !session.accountMovesLocked;
	const error =
		session.error ??
		(status === "idle" && session.lastTurnFailure
			? `turn_failed:${session.lastTurnFailure}${
					session.handoffRefusal
						? `; handoff_refused:${session.handoffRefusal}`
						: ""
				}`
			: undefined);
	return {
		paneId: identity.paneId,
		status,
		...(error !== undefined ? { error } : {}),
		context: chatPaneContext(identity),
		actions: {
			...(interruptOffered ? { interrupt: handlers.interrupt } : {}),
			...(accountMovesOffered && handlers.handoff
				? { handoff: handlers.handoff }
				: {}),
			...(accountMovesOffered
				? Object.fromEntries(
						Object.entries(handlers.switchAccount ?? {}).map(([id, run]) => [
							`switch_account:${id}`,
							run,
						]),
					)
				: {}),
		},
	};
}
